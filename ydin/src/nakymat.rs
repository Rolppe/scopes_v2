//! Johdetut reitit (S-6, T-35): `GET /api/skoopit`, `/api/skoopit/<nimi>`, `/api/skoopit/<nimi>/viestit`,
//! `/api/agentit` ja `/api/rekisterit*` ytimen yksiköistä (`lahde/istunnot`, `lahde/agy`, `peili`).
//!
//! Näkymä pidetään muistissa ja päivitetään muutoslokista lisäyksittäin (E-20): transkriptista jäsennetään vain
//! uudet peilirivit. Jokainen pyyntö ajaa ensin lokin kiinni, joten vastaus ei odota broadcast-tilaajaa;
//! `kaynnista` pitää näkymän ajan tasalla taustalla.
//!
//! Rekisterikentät (R-1): `seuraava`, `avoimet`, `viat` (yksityiskohta) ja `seuraava`, `avoimia`, `vikoja` (lista)
//! sekä `/api/rekisterit/<p>`:n osat johdetaan ytimen `rekisterit/<p>`-yksiköistä (`lr::teksti`), kun päärekisteri
//! `p` on ytimessä; muuten sillasta. Skooppi→rekisteri-kartta ja kontekstikentät (rekisterit, konteksti, jonossa)
//! tulevat yhä sillasta. Ytimen lähteestä johdetaan istuntokentät.
//! Lähde puuttuu (ei yhtään laitetta `lahde/istunnot`- tai `lahde/agy`-polussa) → koko vastaus sillasta.
//!
//! Sillan `/api/skoopit`- ja `/api/rekisterit`-vastaukset pidetään välimuistissa, jota `kaynnista` päivittää
//! taustalla (`SILTAVALI`); `GET /api/skoopit` hakee siltaa synkronisesti vain tyhjällä välimuistilla.

use crate::api::Tila;
use crate::varasto::Varasto;
use crate::{lahde, lr, peili, silta};
use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

/// Viestejä enintään (viestit.keskustelu: 120 viimeisintä).
const MAARA: usize = 120;
/// Poistettujen viestitunnisteiden muisti per transkripti; vanhempi `since` → nollaus.
const POISTOMUISTI: usize = 1000;
/// Sillan vastauksen enimmäiskoko.
const SILTA_RAJA: usize = 64 << 20;
/// Siltavälimuistin (`/api/skoopit`, `/api/rekisterit`) taustapäivityksen väli.
pub const SILTAVALI: Duration = Duration::from_secs(15);

// ---- vastaus -----------------------------------------------------------------------------------------------------

/// Kumpi vastasi: ydin (johdettu) vai silta (vanha 8787).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lahde {
    Ydin,
    Silta,
}

/// Johdetun reitin vastaus. Sillan ei-JSON-runko kulkee merkkijonona alkuperäisellä sisältötyypillä.
#[derive(Debug)]
pub struct Vastaus {
    pub runko: Value,
    pub lahde: Lahde,
    pub koodi: StatusCode,
    pub tyyppi: Option<HeaderValue>,
}

impl Vastaus {
    fn ydin(runko: Value) -> Vastaus {
        Vastaus {
            runko,
            lahde: Lahde::Ydin,
            koodi: StatusCode::OK,
            tyyppi: None,
        }
    }

    fn virhe(koodi: StatusCode, teksti: &str) -> Vastaus {
        Vastaus {
            runko: json!({"virhe": teksti}),
            lahde: Lahde::Ydin,
            koodi,
            tyyppi: None,
        }
    }
}

impl IntoResponse for Vastaus {
    fn into_response(self) -> Response {
        let lahde = HeaderValue::from_static(match self.lahde {
            Lahde::Ydin => "ydin",
            Lahde::Silta => "silta",
        });
        // Sisältötyyppi on vain sillan ei-JSON-rungolla: runko sellaisenaan.
        let mut r = match (self.runko, self.tyyppi) {
            (Value::String(s), Some(t)) => {
                let mut r = (self.koodi, s).into_response();
                r.headers_mut().insert(header::CONTENT_TYPE, t);
                r
            }
            (runko, _) => (self.koodi, Json(runko)).into_response(),
        };
        r.headers_mut().insert("x-lahde", lahde);
        r
    }
}

/// Prosenttikoodaus polun segmentille (RFC 3986 unreserved säilyy).
fn koodaa(s: &str) -> String {
    let mut ulos = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            ulos.push(b as char);
        } else {
            ulos.push_str(&format!("%{b:02X}"));
        }
    }
    ulos
}

/// GET sillan kautta; runko JSON:ksi, muuten merkkijonona.
async fn silta_hae(tila: &Tila, polku: &str) -> Vastaus {
    let req = match Request::builder()
        .method(Method::GET)
        .uri(polku)
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
    {
        Ok(r) => r,
        Err(_) => return Vastaus::virhe(StatusCode::BAD_REQUEST, "virheellinen polku"),
    };
    let r = silta::valita(tila, req).await;
    let koodi = r.status();
    let tyyppi = r.headers().get(header::CONTENT_TYPE).cloned();
    let tavut = match axum::body::to_bytes(r.into_body(), SILTA_RAJA).await {
        Ok(t) => t,
        Err(_) => {
            return Vastaus {
                runko: json!({"virhe": "silta", "kohde": "8787"}),
                lahde: Lahde::Silta,
                koodi: StatusCode::BAD_GATEWAY,
                tyyppi: None,
            }
        }
    };
    let runko = serde_json::from_slice::<Value>(&tavut)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&tavut).into_owned()));
    let tyyppi = match runko {
        Value::String(_) => tyyppi,
        _ => None,
    };
    Vastaus {
        runko,
        lahde: Lahde::Silta,
        koodi,
        tyyppi,
    }
}

/// Sillan vastaus `since`-muodossa: lista kokonaan nollauksena (silta ei tunne muutoslokia).
fn silta_nollauksena(v: Vastaus, seq: u64) -> Vastaus {
    if !v.koodi.is_success() || v.tyyppi.is_some() {
        return v;
    }
    let kaikki = match v.runko {
        Value::Array(a) => a,
        muu => vec![muu],
    };
    Vastaus {
        runko: json!({"seq": seq, "muuttuneet": kaikki, "poistetut": [], "nollaus": true}),
        ..v
    }
}

// ---- JS-yhteensopivat apurit (viestit.mjs) ------------------------------------------------------------------------

fn tosi(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `x ?? y`: puuttuva tai null ohitetaan.
fn tai<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b.filter(|v| !v.is_null()),
        _ => a,
    }
}

/// `String(v)`.
fn js_teksti(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_teksti(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `lyhenna(t, 120)`: ensimmäinen rivi, trimmattu, UTF-16-pituus enintään 120.
fn lyhenna(t: &str) -> String {
    let r = t.split('\n').next().unwrap_or("").trim();
    let n = 120;
    if r.encode_utf16().count() <= n {
        return r.to_string();
    }
    let mut ulos = String::new();
    let mut yksikot = 0;
    for c in r.chars() {
        yksikot += c.len_utf16();
        if yksikot > n - 1 {
            break;
        }
        ulos.push(c);
    }
    ulos.push('…');
    ulos
}

/// `cmd.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '')`.
fn poista_cd(cmd: &str) -> &str {
    let alku = cmd.trim_start();
    let Some(loppu) = alku.strip_prefix("cd") else {
        return cmd;
    };
    let ilman = loppu.trim_start();
    if ilman.len() == loppu.len() {
        return cmd;
    }
    let jalkeen = |s: &str| -> Option<usize> {
        let t = s.trim_start();
        t.strip_prefix("&&").map(|r| {
            let r2 = r.trim_start();
            cmd.len() - r2.len()
        })
    };
    let mut ehdokkaat: Vec<usize> = Vec::new();
    for lainaus in ['"', '\''] {
        if let Some(r) = ilman.strip_prefix(lainaus) {
            if let Some(i) = r.find(lainaus) {
                ehdokkaat.push(1 + i + 1);
            }
        }
    }
    let ajo = ilman
        .char_indices()
        .find(|(_, c)| c.is_whitespace())
        .map_or(ilman.len(), |(i, _)| i);
    let mut rajat: Vec<usize> = ilman[..ajo]
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .collect();
    rajat.reverse();
    ehdokkaat.extend(rajat);
    for e in ehdokkaat {
        if let Some(i) = jalkeen(&ilman[e..]) {
            return &cmd[i..];
        }
    }
    cmd
}

fn perusnimi(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// `tyokaluRivi(o)`.
fn tyokalu_rivi(o: &Value) -> String {
    let tyhja = Value::Object(Map::new());
    let s = tai(o.get("input"), None).unwrap_or(&tyhja);
    let nimi = o.get("name").and_then(Value::as_str).unwrap_or("");
    let tiedosto = tai(
        tai(s.get("file_path"), s.get("notebook_path")),
        s.get("path"),
    );
    if nimi == "Bash" && tosi(s.get("command")) {
        if let Some(c) = s.get("command").and_then(Value::as_str) {
            return format!("$ {}", lyhenna(poista_cd(c)));
        }
    }
    if ["Edit", "MultiEdit", "Write", "NotebookEdit"].contains(&nimi) && tosi(tiedosto) {
        return format!(
            "✎ {}",
            lyhenna(&js_teksti(tiedosto.unwrap_or(&Value::Null)))
        );
    }
    if nimi == "Read" && tosi(tiedosto) {
        let t = js_teksti(tiedosto.unwrap_or(&Value::Null));
        return format!("luki {}", lyhenna(perusnimi(&t)));
    }
    if ["Grep", "Glob"].contains(&nimi) && tosi(s.get("pattern")) {
        return format!(
            "haki {}",
            lyhenna(&js_teksti(s.get("pattern").unwrap_or(&Value::Null)))
        );
    }
    let kuvaus = tai(s.get("description"), s.get("subagent_type"));
    if ["Agent", "Task"].contains(&nimi) && tosi(kuvaus) {
        return format!(
            "ali-agentti: {}",
            lyhenna(&js_teksti(kuvaus.unwrap_or(&Value::Null)))
        );
    }
    match tai(o.get("name"), None) {
        Some(n) => lyhenna(&js_teksti(n)),
        None => lyhenna("työkalu"),
    }
}

/// `kysymysViesti(o, aika)`.
fn kysymys_viesti(o: &Value, aika: &Value) -> Map<String, Value> {
    let tyhja = Vec::new();
    let kysymykset: Vec<Value> = o
        .get("input")
        .and_then(|i| i.get("questions"))
        .and_then(Value::as_array)
        .unwrap_or(&tyhja)
        .iter()
        .map(|q| {
            let vaihtoehdot: Vec<Value> = q
                .get("options")
                .and_then(Value::as_array)
                .unwrap_or(&tyhja)
                .iter()
                .map(|v| {
                    json!({
                        "nimi": tai(v.get("label"), None).map_or(String::new(), js_teksti),
                        "kuvaus": if tosi(v.get("description")) { Value::String(js_teksti(&v["description"])) } else { Value::Null },
                    })
                })
                .collect();
            json!({
                "kysymys": tai(q.get("question"), None).map_or(String::new(), js_teksti),
                "otsikko": if tosi(q.get("header")) { Value::String(js_teksti(&q["header"])) } else { Value::Null },
                "monivalinta": q.get("multiSelect") == Some(&Value::Bool(true)),
                "vaihtoehdot": vaihtoehdot,
            })
        })
        .collect();
    let teksti = kysymykset
        .iter()
        .map(|q| {
            let mut osat = vec![q["kysymys"].as_str().unwrap_or("").to_string()];
            if let Some(vs) = q["vaihtoehdot"].as_array() {
                for (i, v) in vs.iter().enumerate() {
                    osat.push(format!("{}. {}", i + 1, v["nimi"].as_str().unwrap_or("")));
                }
            }
            osat.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut m = Map::new();
    m.insert("rooli".into(), json!("kysymys"));
    m.insert("teksti".into(), Value::String(teksti));
    m.insert("aika".into(), aika.clone());
    m.insert("kysymykset".into(), Value::Array(kysymykset));
    m.insert("vastattu".into(), Value::Bool(false));
    m
}

/// Komentokääre `<command-name>x</command-name>…<command-args>y</command-args>` → "x y".
fn komento(teksti: &str) -> Option<String> {
    const NA: &str = "<command-name>";
    const NL: &str = "</command-name>";
    const AA: &str = "<command-args>";
    const AL: &str = "</command-args>";
    let mut haku = 0;
    while let Some(i) = teksti[haku..].find(NA) {
        let alku = haku + i + NA.len();
        haku = alku;
        let nimi_loppu = teksti[alku..].find('<').map_or(teksti.len(), |j| alku + j);
        if !teksti[nimi_loppu..].starts_with(NL) {
            continue;
        }
        let nimi = &teksti[alku..nimi_loppu];
        let mut h2 = nimi_loppu + NL.len();
        while let Some(j) = teksti[h2..].find(AA) {
            let a = h2 + j + AA.len();
            h2 = a;
            let a_loppu = teksti[a..].find('<').map_or(teksti.len(), |k| a + k);
            if teksti[a_loppu..].starts_with(AL) {
                return Some(format!("{nimi} {}", &teksti[a..a_loppu]).trim().to_string());
            }
        }
    }
    None
}

// ---- rekisterin jäsennys (lahteet.mjs) ---------------------------------------------------------------------------

/// JS:n `\s` ja `trim()`: Unicode White_Space ilman U+0085, lisäksi U+FEFF.
fn js_ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JS:n `.` ei osu rivinvaihtoihin.
fn js_rivinvaihto(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_ws)
}

/// `tokeneiksi(merkit)`: `Math.ceil(merkit / 1.8)`, merkit UTF-16-yksikköinä.
fn tokeneiksi(teksti: &str) -> u64 {
    (teksti.encode_utf16().count() as f64 / 1.8).ceil() as u64
}

/// `\**\s*(.+)$` merkkijonon alusta: kaappaus tai None (ahne `\**\s*` antaa periksi, jotta `.+` saa merkin).
fn tahdet_valit_loput(r: &str) -> Option<&str> {
    let tahdet = r.len() - r.trim_start_matches('*').len();
    let valit = r[tahdet..].len() - r[tahdet..].trim_start_matches(js_ws).len();
    let mut alku = tahdet + valit;
    if alku == r.len() {
        // Kaappaus on viimeinen merkki.
        alku = r.char_indices().last()?.0;
    }
    let kaappaus = &r[alku..];
    if kaappaus.chars().any(js_rivinvaihto) {
        return None;
    }
    Some(kaappaus)
}

/// `/^\**SEURAAVA PAKETTI(?: \[([^\]]+)\])?:\**\s*(.+)$/` → (leima, loput).
fn seuraava_osuma(rivi: &str) -> Option<(Option<&str>, &str)> {
    let r = rivi
        .trim_start_matches('*')
        .strip_prefix("SEURAAVA PAKETTI")?;
    let (leima, r) = match r.strip_prefix(" [") {
        Some(x) => {
            let i = x.find(']')?;
            if i == 0 {
                return None;
            }
            (Some(&x[..i]), &x[i + 1..])
        }
        None => (None, r),
    };
    let r = r.strip_prefix(':')?;
    Some((leima, tahdet_valit_loput(r)?))
}

/// `jasennaSeuraava(teksti)`.
fn jasenna_seuraava(teksti: &str) -> Value {
    let mut osat = teksti.split(" — ");
    let id = js_trim(osat.next().unwrap_or(""));
    let mut polut: Vec<Value> = Vec::new();
    let mut aloitus = Value::Null;
    let mut kuvaus: Vec<&str> = Vec::new();
    for osa in osat {
        if let Some(p) = osa.strip_prefix("polut:") {
            polut = p
                .split(',')
                .map(js_trim)
                .filter(|p| !p.is_empty())
                .map(|p| Value::String(p.to_string()))
                .collect();
        } else if let Some(a) = osa.strip_prefix("aloitus:") {
            aloitus = Value::String(js_trim(a).to_string());
        } else if !osa.starts_with("automaattinen:") {
            kuvaus.push(osa);
        }
    }
    let id = if id.to_lowercase() == "ei mitään" {
        Value::Null
    } else {
        Value::String(id.to_string())
    };
    json!({"id": id, "kuvaus": kuvaus.join(" — "), "polut": polut, "aloitus": aloitus, "teksti": teksti})
}

/// `taulukko(rekisteri, otsikko)`: otsikon (myös "## 6. Otsikko") alla oleva ensimmäinen taulukko riveinä.
fn taulukko(teksti: &str, otsikko: &str) -> Vec<Value> {
    let otsikko_osuu = |r: &str| -> bool {
        let Some(r) = r.strip_prefix("##") else {
            return false;
        };
        let loput = r.trim_start_matches(js_ws);
        if loput.len() == r.len() {
            return false;
        }
        let nimi_osuu = |s: &str| -> bool {
            let n = otsikko.chars().count();
            let alku: String = s.chars().take(n).collect();
            alku.to_lowercase() == otsikko.to_lowercase() && s[alku.len()..].chars().all(js_ws)
        };
        let numero = loput.len() - loput.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if numero > 0 {
            if let Some(x) = loput[numero..].strip_prefix('.') {
                if nimi_osuu(x.trim_start_matches(js_ws)) {
                    return true;
                }
            }
        }
        nimi_osuu(loput)
    };
    let rivit: Vec<&str> = teksti.split('\n').collect();
    let Some(alku) = rivit.iter().position(|r| otsikko_osuu(r)) else {
        return Vec::new();
    };
    let solut = |rivi: &str| -> Vec<String> {
        let t = js_trim(rivi);
        let t = t.strip_prefix('|').unwrap_or(t);
        let t = t.strip_suffix('|').unwrap_or(t);
        t.split('|').map(|s| js_trim(s).to_string()).collect()
    };
    let erotin = |s: &str| {
        let s = s.strip_prefix(':').unwrap_or(s);
        let s = s.strip_suffix(':').unwrap_or(s);
        !s.is_empty() && s.chars().all(|c| c == '-')
    };
    let mut tulos = Vec::new();
    let mut avaimet: Option<Vec<String>> = None;
    for rivi in &rivit[alku + 1..] {
        if rivi.starts_with("##") && rivi[2..].starts_with(js_ws) {
            break;
        }
        if !js_trim(rivi).starts_with('|') {
            if avaimet.is_some() {
                break;
            }
            continue;
        }
        let s = solut(rivi);
        let Some(a) = &avaimet else {
            avaimet = Some(s);
            continue;
        };
        if s.iter().all(|x| erotin(x)) {
            continue;
        }
        let mut m = Map::new();
        for (i, k) in a.iter().enumerate() {
            m.insert(
                k.clone(),
                Value::String(s.get(i).cloned().unwrap_or_default()),
            );
        }
        tulos.push(Value::Object(m));
    }
    tulos
}

/// `^#{taso}\s+(.+?)\s*#*\s*$` → otsikko.
fn otsikko_tasolla(rivi: &str, taso: usize) -> Option<String> {
    let c: Vec<char> = rivi.chars().collect();
    if c.len() <= taso || c[..taso].iter().any(|x| *x != '#') {
        return None;
    }
    let valit = c[taso..].iter().take_while(|x| js_ws(**x)).count();
    for w in (1..=valit).rev() {
        let runko = &c[taso + w..];
        if runko.is_empty() {
            continue;
        }
        // Suurin loppu, joka on muotoa \s*#*\s*.
        let mut j = runko.len();
        while j > 0 && js_ws(runko[j - 1]) {
            j -= 1;
        }
        while j > 0 && runko[j - 1] == '#' {
            j -= 1;
        }
        while j > 0 && js_ws(runko[j - 1]) {
            j -= 1;
        }
        let kaappaus = &runko[..j.max(1)];
        if kaappaus.iter().any(|x| js_rivinvaihto(*x)) {
            continue;
        }
        return Some(kaappaus.iter().collect());
    }
    None
}

/// `otsikoittain(teksti, taso, alkuOtsikko)` → [(otsikko, teksti, tokenit)].
fn otsikoittain(teksti: &str, taso: usize, alku: &str) -> Vec<(String, String, u64)> {
    let mut osat: Vec<(String, Vec<&str>)> = Vec::new();
    let mut nykyinen: (String, Vec<&str>) = (alku.to_string(), Vec::new());
    let mut aidattu = false;
    for rivi in teksti.split('\n') {
        let t = rivi.trim_start_matches(js_ws);
        if t.starts_with("```") || t.starts_with("~~~") {
            aidattu = !aidattu;
        }
        match (!aidattu).then(|| otsikko_tasolla(rivi, taso)).flatten() {
            Some(o) => osat.push(std::mem::replace(&mut nykyinen, (o, vec![rivi]))),
            None => nykyinen.1.push(rivi),
        }
    }
    osat.push(nykyinen);
    osat.into_iter()
        .map(|(o, r)| (o, js_trim(&r.join("\n")).to_string()))
        .filter(|(_, t)| !t.is_empty())
        .map(|(o, t)| {
            let n = tokeneiksi(&t);
            (o, t, n)
        })
        .collect()
}

/// Yli `ISO_OSA` tokenin luku pilkotaan `###`-otsikoittain.
const ISO_OSA: u64 = 3000;

/// `osiin(teksti)`: [{otsikko, teksti, tokenit}].
fn osiin(teksti: &str) -> Vec<Value> {
    let osa = |o: String, t: String, n: u64| json!({"otsikko": o, "teksti": t, "tokenit": n});
    let mut ulos = Vec::new();
    for (o, t, n) in otsikoittain(teksti, 2, "Alku") {
        if n <= ISO_OSA {
            ulos.push(osa(o, t, n));
            continue;
        }
        let ala = otsikoittain(&t, 3, &o);
        if ala.len() <= 1 {
            ulos.push(osa(o, t, n));
            continue;
        }
        for (i, (ao, at, an)) in ala.into_iter().enumerate() {
            let otsikko = if i == 0 { ao } else { format!("{o} › {ao}") };
            ulos.push(osa(otsikko, at, an));
        }
    }
    ulos
}

/// `/^(valmis|todennettu|korjattu)$/i.test(r.Tila ?? '')` ei osu.
fn auki(rivi: &Value) -> bool {
    let tila = match rivi.get("Tila") {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_teksti(v),
    };
    !matches!(
        tila.to_lowercase().as_str(),
        "valmis" | "todennettu" | "korjattu"
    )
}

/// Ytimessä olevan rekisterin jäsennetty teksti.
#[derive(Debug)]
pub struct Jasennetty {
    teksti: String,
    /// SEURAAVA PAKETTI -rivit järjestyksessä: (leima, loput).
    seuraavat: Vec<(Option<String>, String)>,
    avoimet: Vec<Value>,
    viat: Vec<Value>,
}

impl Jasennetty {
    fn jasenna(teksti: String) -> Jasennetty {
        let seuraavat = teksti
            .split('\n')
            .filter_map(seuraava_osuma)
            .map(|(l, r)| (l.map(str::to_string), r.to_string()))
            .collect();
        Jasennetty {
            avoimet: taulukko(&teksti, "Avoimet asiat"),
            viat: taulukko(&teksti, "Viat"),
            seuraavat,
            teksti,
        }
    }

    /// `seuraavaRivi(teksti, skooppi)`: leimattu `[skooppi]` voittaa, muuten ensimmäinen leimaton; ei riviä → null.
    fn seuraava(&self, skooppi: &str) -> Value {
        let mut leimaton = None;
        for (l, r) in &self.seuraavat {
            match l {
                Some(l) if l == skooppi => return jasenna_seuraava(r),
                None if leimaton.is_none() => leimaton = Some(r),
                _ => {}
            }
        }
        leimaton.map_or(Value::Null, |r| jasenna_seuraava(r))
    }

    fn kentat_yksityiskohtaan(&self, skooppi: &str, runko: &mut Value) {
        if let Value::Object(o) = runko {
            o.insert("seuraava".into(), self.seuraava(skooppi));
            o.insert("avoimet".into(), Value::Array(self.avoimet.clone()));
            o.insert("viat".into(), Value::Array(self.viat.clone()));
        }
    }

    fn kentat_listaan(&self, skooppi: &str, rivi: &mut Value) {
        if let Value::Object(o) = rivi {
            let id = self.seuraava(skooppi).get("id").cloned();
            o.insert("seuraava".into(), id.unwrap_or(Value::Null));
            o.insert(
                "avoimia".into(),
                json!(self.avoimet.iter().filter(|r| auki(r)).count()),
            );
            o.insert(
                "vikoja".into(),
                json!(self.viat.iter().filter(|r| auki(r)).count()),
            );
        }
    }
}

// ---- keskustelu (viestit.keskustelu lisäyksittäin) ------------------------------------------------------------

#[derive(Clone, Debug)]
struct Viesti {
    id: String,
    arvo: Map<String, Value>,
    muutettu: u64,
}

/// Yhden transkriptin jäsennetty tila.
#[derive(Debug)]
pub struct Keskustelu {
    istunto: String,
    rivit: usize,
    /// Seuraava soveltamaton peilin offset (tavuina).
    peili_offset: u64,
    viestit: VecDeque<Viesti>,
    kysymykset: HashMap<String, String>,
    malli: Value,
    effort: Value,
    poistetut: VecDeque<(String, u64)>,
    poisto_raja: u64,
    alku: u64,
    /// Ikkunoitu solmu (S-9d): numerointi alkaa pohjasta, ei tiedoston alusta.
    ikkunoitu: bool,
    /// S-9d: pohja, josta näkymä on rakennettu; ikkunoitu ilman pohjaa = tiedoston viestejä ei näytetä.
    pohja: Option<peili::Pohja>,
}

impl Keskustelu {
    fn uusi(istunto: &str, seq: u64, ikkunoitu: bool) -> Keskustelu {
        Keskustelu {
            istunto: istunto.to_string(),
            rivit: 0,
            peili_offset: 0,
            viestit: VecDeque::new(),
            kysymykset: HashMap::new(),
            malli: Value::Null,
            effort: Value::Null,
            poistetut: VecDeque::new(),
            poisto_raja: 0,
            alku: seq,
            ikkunoitu,
            pohja: None,
        }
    }

    /// Lukee peilistä offsetin `self.peili_offset` jälkeiset rivit ja soveltaa ne. Ikkunoitu solmu (S-9d):
    /// voimassa oleva pohja, joka eroaa näkymän pohjasta (karsinta, S-9e-haku), rakentaa näkymän
    /// pohjasta uudelleen; ilman pohjaa tiedoston viestejä ei näytetä.
    fn lue_peilista(
        &mut self,
        v: &Varasto,
        tiedosto: &str,
        seq: u64,
    ) -> crate::muutosloki::Result<()> {
        if self.ikkunoitu {
            if let Some(p) = peili::voimassa_pohja(v, tiedosto)? {
                if self.pohja != Some(p) {
                    return self.rakenna_pohjasta(v, tiedosto, p, seq);
                }
            }
            if self.pohja.is_none() {
                return Ok(());
            }
        }
        let (uudet, seuraava) = peili::rivit_alkaen(v, tiedosto, self.peili_offset)?;
        self.peili_offset = seuraava;
        self.sovella(&uudet, seq);
        Ok(())
    }

    /// S-9d: rakentaa näkymän pohjasta `p` uudelleen. Ennallaan olevat viestit säilyttävät muutoshetkensä;
    /// näkymästä poistuneet viestit kirjataan `poistetut`-listaan hetkellä `seq` (`since`-asiakkaat).
    fn rakenna_pohjasta(
        &mut self,
        v: &Varasto,
        tiedosto: &str,
        p: peili::Pohja,
        seq: u64,
    ) -> crate::muutosloki::Result<()> {
        let mut uusi = Keskustelu::uusi(&self.istunto, self.alku, true);
        uusi.pohja = Some(p);
        uusi.rivit = usize::try_from(p.rivi).unwrap_or(usize::MAX);
        let (rivit, seuraava) = peili::rivit_alkaen(v, tiedosto, p.offset)?;
        uusi.peili_offset = seuraava;
        uusi.sovella(&rivit, seq);
        let vanhat: HashMap<&str, &Viesti> =
            self.viestit.iter().map(|x| (x.id.as_str(), x)).collect();
        for x in uusi.viestit.iter_mut() {
            if let Some(o) = vanhat.get(x.id.as_str()) {
                if o.arvo == x.arvo {
                    x.muutettu = o.muutettu;
                }
            }
        }
        let nyt: HashSet<&str> = uusi.viestit.iter().map(|x| x.id.as_str()).collect();
        let mut poistetut = std::mem::take(&mut self.poistetut);
        poistetut.retain(|(id, _)| !nyt.contains(id.as_str()));
        for o in &self.viestit {
            if !nyt.contains(o.id.as_str()) {
                poistetut.push_back((o.id.clone(), seq));
            }
        }
        uusi.poistetut = poistetut;
        uusi.poisto_raja = self.poisto_raja;
        while uusi.poistetut.len() > POISTOMUISTI {
            if let Some((_, s)) = uusi.poistetut.pop_front() {
                uusi.poisto_raja = uusi.poisto_raja.max(s);
            }
        }
        if uusi.malli.is_null() {
            uusi.malli = self.malli.clone();
            uusi.effort = self.effort.clone();
        }
        *self = uusi;
        Ok(())
    }

    /// Soveltaa uudet rivit rivinumerosta `self.rivit + 1` eteenpäin.
    fn sovella(&mut self, uudet: &[String], seq: u64) {
        if uudet.is_empty() {
            return;
        }
        for (i, rivi) in uudet.iter().enumerate() {
            self.rivi(self.rivit + i + 1, rivi, seq);
        }
        self.rivit += uudet.len();
        // Kysymys, jonka perässä on mitä tahansa, ei ole enää auki.
        let n = self.viestit.len();
        for (i, v) in self.viestit.iter_mut().enumerate() {
            if i + 1 < n
                && v.arvo.get("rooli") == Some(&json!("kysymys"))
                && v.arvo.get("vastattu") != Some(&Value::Bool(true))
            {
                v.arvo.insert("vastattu".into(), Value::Bool(true));
                v.muutettu = seq;
            }
        }
        while self.viestit.len() > MAARA {
            if let Some(v) = self.viestit.pop_front() {
                self.poistetut.push_back((v.id, seq));
            }
        }
        while self.poistetut.len() > POISTOMUISTI {
            if let Some((_, s)) = self.poistetut.pop_front() {
                self.poisto_raja = self.poisto_raja.max(s);
            }
        }
    }

    fn lisaa(&mut self, nro: usize, osa: &mut usize, arvo: Map<String, Value>, seq: u64) -> String {
        let id = if *osa == 0 {
            format!("{}:{nro}", self.istunto)
        } else {
            format!("{}:{nro}.{osa}", self.istunto)
        };
        *osa += 1;
        self.viestit.push_back(Viesti {
            id: id.clone(),
            arvo,
            muutettu: seq,
        });
        id
    }

    fn rivi(&mut self, nro: usize, rivi: &str, seq: u64) {
        let Ok(j) = serde_json::from_str::<Value>(rivi) else {
            return;
        };
        let tyyppi = j.get("type").and_then(Value::as_str).unwrap_or("");
        // istunnonAsetukset: viimeinen pääketjun assistant-rivi, jossa malli.
        if tyyppi == "assistant" && !tosi(j.get("isSidechain")) {
            if let Some(m) = j.get("message").and_then(|m| m.get("model")) {
                if tosi(Some(m)) {
                    self.malli = m.clone();
                    self.effort = tai(j.get("perTurnEffort"), j.get("effort"))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
            }
        }
        if tosi(j.get("isSidechain"))
            || tosi(j.get("isMeta"))
            || (tyyppi != "user" && tyyppi != "assistant")
        {
            return;
        }
        let c = j.get("message").and_then(|m| m.get("content"));
        let aika = tai(j.get("timestamp"), None)
            .cloned()
            .unwrap_or(Value::Null);
        let mut osa = 0usize;
        let viesti = |rooli: &str, teksti: String, aika: &Value| {
            let mut m = Map::new();
            m.insert("rooli".into(), Value::String(rooli.into()));
            m.insert("teksti".into(), Value::String(teksti));
            m.insert("aika".into(), aika.clone());
            m
        };
        if tyyppi == "assistant" {
            if let Some(Value::Array(osat)) = c {
                let mut teksti: Vec<String> = Vec::new();
                for o in osat {
                    let ot = o.get("type").and_then(Value::as_str);
                    if ot == Some("text") {
                        teksti.push(match o.get("text") {
                            None | Some(Value::Null) => String::new(),
                            Some(t) => js_teksti(t),
                        });
                    } else if ot == Some("tool_use") {
                        let t = teksti.join("\n").trim().to_string();
                        if !t.is_empty() {
                            self.lisaa(nro, &mut osa, viesti("agentti", t, &aika), seq);
                        }
                        teksti.clear();
                        if o.get("name").and_then(Value::as_str) == Some("AskUserQuestion") {
                            let k = kysymys_viesti(o, &aika);
                            let id = self.lisaa(nro, &mut osa, k, seq);
                            if let Some(tid) = o.get("id").and_then(Value::as_str) {
                                self.kysymykset.insert(tid.to_string(), id);
                            }
                        } else {
                            self.lisaa(
                                nro,
                                &mut osa,
                                viesti("tyokalu", tyokalu_rivi(o), &aika),
                                seq,
                            );
                        }
                    }
                }
                let t = teksti.join("\n").trim().to_string();
                if !t.is_empty() {
                    self.lisaa(nro, &mut osa, viesti("agentti", t, &aika), seq);
                }
                return;
            }
        }
        if tyyppi == "user" {
            if let Some(Value::Array(osat)) = c {
                for o in osat {
                    if o.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let Some(kid) = o
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .and_then(|t| self.kysymykset.get(t))
                        .cloned()
                    else {
                        continue;
                    };
                    if let Some(k) = self.viestit.iter_mut().find(|v| v.id == kid) {
                        if k.arvo.get("vastattu") != Some(&Value::Bool(true)) {
                            k.arvo.insert("vastattu".into(), Value::Bool(true));
                            k.muutettu = seq;
                        }
                    }
                    let teksti = match j.get("toolUseResult").and_then(|t| t.get("answers")) {
                        Some(Value::Object(m)) => m.values().map(js_teksti).collect::<Vec<_>>(),
                        Some(Value::Array(a)) => a.iter().map(js_teksti).collect::<Vec<_>>(),
                        _ => Vec::new(),
                    }
                    .join("\n");
                    let t = teksti.trim();
                    if !t.is_empty() {
                        self.lisaa(nro, &mut osa, viesti("kayttaja", t.to_string(), &aika), seq);
                    }
                }
            }
        }
        let osat: Vec<String> = match c {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(a)) => a
                .iter()
                .filter(|o| o.get("type").and_then(Value::as_str) == Some("text"))
                .map(|o| match o.get("text") {
                    None | Some(Value::Null) => String::new(),
                    Some(t) => js_teksti(t),
                })
                .collect(),
            _ => Vec::new(),
        };
        let mut teksti = osat.join("\n").trim().to_string();
        if teksti.is_empty() {
            return;
        }
        if tyyppi == "user" {
            if let Some(k) = komento(&teksti) {
                teksti = k;
            } else if [
                "<local-command",
                "<command-message",
                "<system-reminder",
                "<task-notification",
            ]
            .iter()
            .any(|a| teksti.starts_with(a))
            {
                return;
            }
        }
        let rooli = if tyyppi == "user" {
            "kayttaja"
        } else {
            "agentti"
        };
        self.lisaa(nro, &mut osa, viesti(rooli, teksti, &aika), seq);
    }

    fn lista(&self) -> Vec<Value> {
        self.viestit
            .iter()
            .map(|v| Value::Object(v.arvo.clone()))
            .collect()
    }

    fn tunnisteella(v: &Viesti) -> Value {
        let mut m = v.arvo.clone();
        m.insert("id".into(), Value::String(v.id.clone()));
        Value::Object(m)
    }
}

// ---- näkymä ------------------------------------------------------------------------------------------------------

/// Skoopin ytimestä johdettu osa: istunnot lähteistä ja muutoksen seq.
#[derive(Clone, Debug, Default)]
pub struct Skooppi {
    istunnot: Vec<Value>,
    agy: Vec<Value>,
    muutettu: u64,
    valittu: Option<(bool, String)>,
    valittu_muutettu: u64,
}

#[derive(Default)]
struct Sisa {
    rakennettu: bool,
    alku: u64,
    seq_viimeisin: u64,
    istunnot: Option<Vec<Value>>,
    agy: Option<Vec<Value>>,
    skoopit: BTreeMap<String, Skooppi>,
    viestit: HashMap<String, Keskustelu>,
    rekisterit_seq: u64,
}

/// Sillan vastaukset, joita `GET /api/skoopit` käyttää (taustapäivitys, `SILTAVALI`).
#[derive(Default)]
struct Siltavalimuisti {
    skoopit: Option<Value>,
    rekisterit: Option<Value>,
    /// Skoopin rivin viimeisin muutos sillan listassa: näkymän seq havaintohetkellä.
    muutettu: HashMap<String, u64>,
    /// `/api/rekisterit`-vastauksen (skooppi→rekisteri-kartta) viimeisin muutos.
    kartta_muutettu: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Siltalaji {
    Skoopit,
    Rekisterit,
}

impl Siltalaji {
    fn polku(self) -> &'static str {
        match self {
            Siltalaji::Skoopit => "/api/skoopit",
            Siltalaji::Rekisterit => "/api/rekisterit",
        }
    }
}

impl Siltavalimuisti {
    fn hae(&self, laji: Siltalaji) -> Option<&Value> {
        match laji {
            Siltalaji::Skoopit => self.skoopit.as_ref(),
            Siltalaji::Rekisterit => self.rekisterit.as_ref(),
        }
    }

    /// Asettaa uuden vastauksen; eroava JSON kirjaa muutoksen näkymän seq:iin `seq`.
    fn aseta(&mut self, laji: Siltalaji, uusi: Value, seq: u64) {
        match laji {
            Siltalaji::Skoopit => {
                if let Some(vanha) = &self.skoopit {
                    if *vanha != uusi {
                        let vanhat: HashMap<&str, &Value> = vanha
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|r| Some((r.get("nimi")?.as_str()?, r)))
                            .collect();
                        for r in uusi.as_array().into_iter().flatten() {
                            let Some(nimi) = r.get("nimi").and_then(Value::as_str) else {
                                continue;
                            };
                            if vanhat.get(nimi) != Some(&r) {
                                self.muutettu.insert(nimi.to_string(), seq);
                            }
                        }
                    }
                }
                self.skoopit = Some(uusi);
            }
            Siltalaji::Rekisterit => {
                if self.rekisterit.as_ref().is_some_and(|v| *v != uusi) {
                    self.kartta_muutettu = Some(seq);
                }
                self.rekisterit = Some(uusi);
            }
        }
    }

    /// Muuttuiko skoopin rivi sillassa `since`-arvon `x` jälkeen. Havainto tehdään näkymän seq:ssä, jonka
    /// asiakas on voinut jo saada ennen muutosta, joten `>=`: rivi palaa, kunnes muutosloki etenee.
    fn muuttui(&self, nimi: &str, x: u64) -> bool {
        self.muutettu.get(nimi).is_some_and(|s| *s >= x)
            || self.kartta_muutettu.is_some_and(|s| s >= x)
    }

    /// Skooppi → päärekisteri: ensimmäinen merkintä, jonka laji on "rekisteri" ja skoopit sisältää skoopin.
    fn kartta(&self) -> HashMap<String, String> {
        let mut k = HashMap::new();
        for e in self.rekisterit.iter().filter_map(Value::as_array).flatten() {
            if e.get("laji").and_then(Value::as_str) != Some("rekisteri") {
                continue;
            }
            let Some(p) = e.get("polku").and_then(Value::as_str) else {
                continue;
            };
            for s in e
                .get("skoopit")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                k.entry(s.to_string()).or_insert_with(|| p.to_string());
            }
        }
        k
    }
}

/// Johdetut näkymät muistissa (rakennetaan varastosta ensimmäisellä käytöllä).
pub struct Nakymat {
    sisa: RwLock<Sisa>,
    /// Ytimen rekisterit jäsennettyinä: polku → Some (ytimessä) tai None (ei ytimessä). Mitätöidään, kun
    /// `rekisterit/<p>` tai `rekisterit-meta/<p>` muuttuu.
    rekisterit: Mutex<HashMap<String, Option<Arc<Jasennetty>>>>,
    silta: Mutex<Siltavalimuisti>,
    /// S-9d/S-9e: ikkunoidun solmun taustahakujen tila tiedostoittain.
    haut: Mutex<HashMap<String, Haku>>,
}

/// Yhden tiedoston taustahaun tila (S-9d pohja, S-9e edeltävät yksiköt).
#[derive(Default)]
struct Haku {
    kaynnissa: bool,
    /// Viimeisimmän S-9e-haun alku (`peili::HAKUVALI`).
    edeltavat: Option<Instant>,
    /// Viimeisin haku epäonnistui (vertainen ei vastaa) → `haettavissa: true`.
    epaonnistui: bool,
}

type Rekisteri = Mutex<Vec<(Weak<Varasto>, Arc<Nakymat>)>>;
static NAKYMAT: Rekisteri = Mutex::new(Vec::new());

/// Solmun (varaston) näkymä; sama varasto → sama näkymä.
pub fn nakyma(tila: &Tila) -> Arc<Nakymat> {
    let mut r = NAKYMAT.lock().unwrap_or_else(|e| e.into_inner());
    r.retain(|(w, _)| w.strong_count() > 0);
    let oma = Arc::downgrade(&tila.varasto);
    if let Some((_, n)) = r.iter().find(|(w, _)| w.ptr_eq(&oma)) {
        return n.clone();
    }
    let n = Arc::new(Nakymat {
        sisa: RwLock::new(Sisa::default()),
        rekisterit: Mutex::new(HashMap::new()),
        silta: Mutex::new(Siltavalimuisti::default()),
        haut: Mutex::new(HashMap::new()),
    });
    r.push((oma, n.clone()));
    n
}

/// Millisekunnit ISO-aikaleimasta (`YYYY-MM-DDTHH:MM:SS(.sss)Z`) tai luvusta.
fn ms(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => iso_ms(s),
        _ => None,
    }
}

fn iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let luku = |a: usize, l: usize| s.get(a..a + l)?.parse::<i64>().ok();
    let (y, mo, d) = (luku(0, 4)?, luku(5, 2)?, luku(8, 2)?);
    let (h, mi, se) = (luku(11, 2)?, luku(14, 2)?, luku(17, 2)?);
    let mut msek = 0;
    if b.get(19) == Some(&b'.') {
        let loppu = s[20..].find(|c: char| !c.is_ascii_digit())? + 20;
        let osa = &s[20..loppu];
        let kolme: String = osa.chars().chain("000".chars()).take(3).collect();
        msek = kolme.parse::<i64>().ok()?;
    }
    // days_from_civil (Howard Hinnant)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let paivat = era * 146097 + doe - 719468;
    Some(((paivat * 24 + h) * 60 + mi) * 60 * 1000 + se * 1000 + msek)
}

/// Lähteen sisältö: kaikkien laitteiden taulukot yhteen; None, jos lähteellä ei ole laitteita.
fn lue_lahde(
    v: &Varasto,
    laji: &str,
    avain: &str,
) -> crate::muutosloki::Result<Option<Vec<Value>>> {
    let laitteet = lahde::lue(v, laji)?;
    if laitteet.is_empty() {
        return Ok(None);
    }
    let mut nahdyt = std::collections::HashSet::new();
    let mut ulos = Vec::new();
    for (_, _, sisalto) in laitteet {
        if let Value::Array(a) = sisalto {
            for i in a {
                let tunnus = i.get(avain).map(Value::to_string);
                if let Some(t) = &tunnus {
                    if !nahdyt.insert(t.clone()) {
                        continue;
                    }
                }
                ulos.push(i);
            }
        }
    }
    Ok(Some(ulos))
}

fn skooppi_nimi(i: &Value) -> Option<&str> {
    i.get("skooppi").and_then(Value::as_str)
}

/// Uusin pakkaamaton istunto (avoinna): (agy?, tunnus).
fn valitse(s: &Skooppi) -> Option<(bool, String)> {
    avoimet(s).first().map(|(agy, i)| {
        let id = if *agy {
            i.get("id").or_else(|| i.get("ruutu"))
        } else {
            i.get("istunto")
        };
        (*agy, id.map(js_teksti).unwrap_or_default())
    })
}

/// `avoinna`: pakkaamattomat, uusin (alkoi) ensin; Claude-istunnot ennen agy:tä tasatilanteessa.
fn avoimet(s: &Skooppi) -> Vec<(bool, &Value)> {
    let mut l: Vec<(bool, &Value)> = s
        .istunnot
        .iter()
        .map(|i| (false, i))
        .chain(s.agy.iter().map(|i| (true, i)))
        .filter(|(_, i)| !tosi(i.get("pakattu")))
        .collect();
    l.sort_by_key(|(_, i)| std::cmp::Reverse(i.get("alkoi").and_then(ms).unwrap_or(0)));
    l
}

impl Nakymat {
    /// Viimeisin näkymään sovellettu muutoslokin seq.
    pub fn seq(&self) -> u64 {
        self.sisa
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .seq_viimeisin
    }

    /// Ajaa näkymän muutoslokin tasalle.
    pub fn paivita(&self, tila: &Tila) -> crate::muutosloki::Result<()> {
        let v = &tila.varasto;
        let ikkunoitu = tila.peili.ikkuna_vrk.is_some();
        let mut s = self.sisa.write().unwrap_or_else(|e| e.into_inner());
        if !s.rakennettu {
            let seq = v.seq()?;
            s.alku = seq;
            s.seq_viimeisin = seq;
            s.paivita_lahteet(v, seq, ikkunoitu)?;
            s.rakennettu = true;
        }
        loop {
            let era = v.loki(s.seq_viimeisin, 500)?;
            let Some(viimeinen) = era.last().map(|t| t.seq) else {
                return Ok(());
            };
            let mut lahteet = false;
            let mut tiedostot: Vec<String> = Vec::new();
            let mut rekisterit: Vec<&str> = Vec::new();
            for t in &era {
                if t.polku == "lahde/istunnot" || t.polku == "lahde/agy" {
                    lahteet = true;
                } else if t.polku == "peili" {
                    if let Some((tiedosto, _)) = t.id.rsplit_once(':') {
                        if !tiedostot.iter().any(|x| x == tiedosto) {
                            tiedostot.push(tiedosto.to_string());
                        }
                    }
                } else if t.polku == peili::POHJA_POLKU {
                    // S-9d: uusi pohja → istunnon näkymä pohjasta uudelleen (`lue_peilista`).
                    if !tiedostot.contains(&t.id) {
                        tiedostot.push(t.id.clone());
                    }
                } else if t.polku == "rekisterit" || t.polku.starts_with("rekisterit/") {
                    s.rekisterit_seq = viimeinen;
                }
                if let Some(p) = t
                    .polku
                    .strip_prefix("rekisterit/")
                    .or_else(|| t.polku.strip_prefix("rekisterit-meta/"))
                {
                    rekisterit.push(p);
                }
            }
            if !rekisterit.is_empty() {
                let mut r = self.rekisterit.lock().unwrap_or_else(|e| e.into_inner());
                for p in rekisterit {
                    r.remove(p);
                }
            }
            if lahteet {
                s.paivita_lahteet(v, viimeinen, ikkunoitu)?;
            }
            for tiedosto in tiedostot {
                if let Some(k) = s.viestit.get_mut(&tiedosto) {
                    k.lue_peilista(v, &tiedosto, viimeinen)?;
                }
            }
            s.seq_viimeisin = viimeinen;
        }
    }

    /// Rekisteri `p` ytimestä: None, jos polulla `rekisterit/<p>` ei ole yhtään ei-poistettua yksikköä.
    /// Jäsennys tehdään lukon alla, joten samanaikainen mitätöinti ei jätä vanhaa tulosta voimaan.
    pub fn rekisteri(&self, v: &Varasto, p: &str) -> Option<Arc<Jasennetty>> {
        let mut r = self.rekisterit.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(x) = r.get(p) {
            return x.clone();
        }
        let ytimessa = v
            .listaa(&format!("rekisterit/{p}"))
            .ok()?
            .iter()
            .any(|y| !y.poistettu);
        let x = ytimessa.then(|| Arc::new(Jasennetty::jasenna(lr::teksti(v, p))));
        r.insert(p.to_string(), x.clone());
        x
    }

    fn silta_lue<T>(&self, f: impl FnOnce(&Siltavalimuisti) -> T) -> T {
        f(&self.silta.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn silta_aseta(&self, laji: Siltalaji, uusi: Value, seq: u64) {
        self.silta
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .aseta(laji, uusi, seq);
    }
}

/// Sillan JSON-vastaus; virhe tai ei-JSON → sillan vastaus sellaisenaan.
async fn silta_json(tila: &Tila, laji: Siltalaji) -> Result<Value, Vastaus> {
    let v = silta_hae(tila, laji.polku()).await;
    if v.koodi.is_success() && v.tyyppi.is_none() && v.runko.is_array() {
        Ok(v.runko)
    } else {
        Err(v)
    }
}

/// Välimuistista; tyhjä välimuisti → synkroninen siltahaku, joka täyttää sen.
async fn valimuistista(tila: &Tila, n: &Nakymat, laji: Siltalaji) -> Result<Value, Vastaus> {
    if let Some(v) = n.silta_lue(|m| m.hae(laji).cloned()) {
        return Ok(v);
    }
    let v = silta_json(tila, laji).await?;
    n.silta_aseta(laji, v.clone(), n.seq());
    Ok(v)
}

/// Päivittää siltavälimuistin; virhe → vanha jää voimaan, virhe lokiin.
async fn paivita_silta(tila: &Tila, n: &Nakymat) {
    for laji in [Siltalaji::Skoopit, Siltalaji::Rekisterit] {
        match silta_json(tila, laji).await {
            Ok(v) => {
                if let Err(e) = n.paivita(tila) {
                    eprintln!("nakymat: {e}");
                }
                n.silta_aseta(laji, v, n.seq());
            }
            Err(v) => eprintln!(
                "nakymat: siltahaku {} epäonnistui ({}): {}",
                laji.polku(),
                v.koodi,
                v.runko
            ),
        }
    }
}

impl Sisa {
    fn paivita_lahteet(
        &mut self,
        v: &Varasto,
        seq: u64,
        ikkunoitu: bool,
    ) -> crate::muutosloki::Result<()> {
        self.istunnot = lue_lahde(v, "istunnot", "istunto")?;
        self.agy = lue_lahde(v, "agy", "id")?;
        let mut uudet: BTreeMap<String, Skooppi> = BTreeMap::new();
        for i in self.istunnot.iter().flatten() {
            if let Some(n) = skooppi_nimi(i) {
                uudet
                    .entry(n.to_string())
                    .or_default()
                    .istunnot
                    .push(i.clone());
            }
        }
        for i in self.agy.iter().flatten() {
            if let Some(n) = skooppi_nimi(i) {
                uudet.entry(n.to_string()).or_default().agy.push(i.clone());
            }
        }
        let nimet: Vec<String> = self
            .skoopit
            .keys()
            .chain(uudet.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        for nimi in nimet {
            let mut uusi = uudet.remove(&nimi).unwrap_or_default();
            let vanha = self.skoopit.get(&nimi);
            let sama = vanha.is_some_and(|o| o.istunnot == uusi.istunnot && o.agy == uusi.agy);
            uusi.muutettu = if sama {
                vanha.map_or(seq, |o| o.muutettu)
            } else {
                seq
            };
            uusi.valittu = valitse(&uusi);
            uusi.valittu_muutettu = match vanha {
                Some(o) if o.valittu == uusi.valittu => o.valittu_muutettu,
                _ => seq,
            };
            self.skoopit.insert(nimi, uusi);
        }
        // Seurataan elävien istuntojen transkripteja; muut pois muistista.
        let mut seurattavat: HashMap<String, String> = HashMap::new();
        for i in self.istunnot.iter().flatten() {
            if let (Some(t), Some(id)) = (
                i.get("transkripti").and_then(Value::as_str),
                i.get("istunto").and_then(Value::as_str),
            ) {
                seurattavat.insert(t.to_string(), id.to_string());
            }
        }
        self.viestit.retain(|t, _| seurattavat.contains_key(t));
        for (t, id) in seurattavat {
            if let std::collections::hash_map::Entry::Vacant(e) = self.viestit.entry(t) {
                let mut k = Keskustelu::uusi(&id, seq, ikkunoitu);
                k.lue_peilista(v, e.key(), seq)?;
                e.insert(k);
            }
        }
        Ok(())
    }

    fn lahteet_ytimessa(&self) -> bool {
        self.istunnot.is_some() && self.agy.is_some()
    }

    /// `since` → nollaus, jos näkymä ei tunne muutoksia sen jälkeen.
    fn nollaus(&self, v: &Varasto, since: u64) -> crate::muutosloki::Result<bool> {
        if since > self.seq_viimeisin || since < self.alku {
            return Ok(true);
        }
        Ok(v.loki(0, 1)?.first().is_some_and(|e| since + 1 < e.seq))
    }

    fn skooppi(&self, nimi: &str) -> Skooppi {
        self.skoopit.get(nimi).cloned().unwrap_or_default()
    }
}

/// `skooppiTila`.
fn skooppi_tila(kaikki: &[&Value]) -> &'static str {
    let auki: Vec<&&Value> = kaikki.iter().filter(|i| !tosi(i.get("pakattu"))).collect();
    if auki.iter().any(|i| tosi(i.get("kysely"))) {
        return "kysely";
    }
    if auki.iter().any(|i| {
        matches!(
            i.get("tila").and_then(Value::as_str),
            Some("busy") | Some("shell")
        )
    }) {
        return "kasittely";
    }
    if auki.is_empty() {
        "pakattu"
    } else {
        "odottaa"
    }
}

/// Listarivin istuntokentät ytimestä sillan rekisterikenttien päälle.
fn listarivi(mut rivi: Value, s: &Skooppi) -> Value {
    let kaikki: Vec<&Value> = s.istunnot.iter().chain(s.agy.iter()).collect();
    let Value::Object(o) = &mut rivi else {
        return rivi;
    };
    o.insert("istuntoja".into(), json!(kaikki.len()));
    let tokenit: Vec<i64> = kaikki
        .iter()
        .map(|i| {
            i.get("konteksti")
                .and_then(|k| k.get("tokenit"))
                .and_then(Value::as_i64)
                .unwrap_or(0)
        })
        .collect();
    o.insert(
        "suurinKonteksti".into(),
        tokenit.iter().max().map_or(Value::Null, |m| json!(m)),
    );
    let mut aika = o.get("aika").and_then(Value::as_str).map(str::to_string);
    for i in &kaikki {
        if let Some(p) = i.get("pysahdys").and_then(Value::as_str) {
            if iso_ms(p).is_some() && aika.as_deref().is_none_or(|a| p > a) {
                aika = Some(p.to_string());
            }
        }
    }
    o.insert("aika".into(), aika.map_or(Value::Null, Value::String));
    o.insert("tila".into(), json!(skooppi_tila(&kaikki)));
    rivi
}

/// Skoopin näkymän istunnot: Claude-istunnot lähteestä 8787:n muodossa, agy sellaisenaan.
fn istuntolista(s: &Skooppi, silta: Option<&Value>) -> Vec<Value> {
    let sillan = |id: &str| -> Option<&Value> {
        silta?
            .as_array()?
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some(id))
    };
    let mut ulos: Vec<Value> = s
        .istunnot
        .iter()
        .map(|i| {
            let id = i.get("istunto").and_then(Value::as_str).unwrap_or("");
            let vanha = sillan(id);
            let kentta = |k: &str| i.get(k).cloned().unwrap_or(Value::Null);
            let taydenna = |k: &str| {
                i.get(k)
                    .or_else(|| vanha.and_then(|v| v.get(k)))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            json!({
                "id": id,
                "nimi": taydenna("nimi"),
                "tila": kentta("tila"),
                "kysely": kentta("kysely"),
                "skooppi": kentta("skooppi"),
                "konteksti": kentta("konteksti"),
                "pysahdys": kentta("pysahdys"),
                "pakattu": kentta("pakattu"),
                "hereilla": kentta("hereilla"),
                "alkoi": i.get("alkoi").and_then(ms).map_or(Value::Null, |m| json!(m)),
                "pid": taydenna("pid"),
                "vanhempi": taydenna("vanhempi"),
                "ruutu": kentta("ruutu"),
                "polku": taydenna("polku"),
            })
        })
        .collect();
    ulos.extend(s.agy.iter().cloned());
    ulos
}

// ---- johdetut vastaukset -----------------------------------------------------------------------------------------

/// Ajaa näkymän tasalle; virhe → 500.
fn tasalle(tila: &Tila) -> Result<Arc<Nakymat>, Vastaus> {
    let n = nakyma(tila);
    n.paivita(tila)
        .map_err(|e| Vastaus::virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(n)
}

/// `GET /api/skoopit[?since=]`.
pub async fn skoopit(tila: &Tila, since: Option<u64>) -> Vastaus {
    let n = match tasalle(tila) {
        Ok(n) => n,
        Err(v) => return v,
    };
    let (ytimessa, seq) = {
        let s = n.sisa.read().unwrap_or_else(|e| e.into_inner());
        (s.lahteet_ytimessa(), s.seq_viimeisin)
    };
    let rivit = match valimuistista(tila, &n, Siltalaji::Skoopit).await {
        Ok(v) => v,
        Err(v) if ytimessa => return v,
        Err(v) => {
            return match since {
                Some(_) => silta_nollauksena(v, seq),
                None => v,
            }
        }
    };
    if !ytimessa {
        let v = Vastaus {
            runko: rivit,
            lahde: Lahde::Silta,
            koodi: StatusCode::OK,
            tyyppi: None,
        };
        return match since {
            Some(_) => silta_nollauksena(v, seq),
            None => v,
        };
    }
    let Value::Array(rivit) = rivit else {
        return Vastaus::virhe(StatusCode::BAD_GATEWAY, "silta");
    };
    // Kartta on vain rekisterikentille: puuttuva tai virheellinen /api/rekisterit → kentät sillasta.
    let _ = valimuistista(tila, &n, Siltalaji::Rekisterit).await;
    let kartta = n.silta_lue(Siltavalimuisti::kartta);
    let s = n.sisa.read().unwrap_or_else(|e| e.into_inner());
    let nollaus = match since {
        Some(x) => match s.nollaus(&tila.varasto, x) {
            Ok(b) => b,
            Err(e) => return Vastaus::virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        },
        None => false,
    };
    let mut ulos = Vec::with_capacity(rivit.len());
    for rivi in rivit {
        let nimi = rivi
            .get("nimi")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let sk = s.skooppi(&nimi);
        if let Some(x) = since {
            if !nollaus
                && sk.muutettu <= x
                && s.rekisterit_seq <= x
                && !n.silta_lue(|m| m.muuttui(&nimi, x))
            {
                continue;
            }
        }
        let mut rivi = listarivi(rivi, &sk);
        if let Some(r) = kartta
            .get(&nimi)
            .and_then(|p| n.rekisteri(&tila.varasto, p))
        {
            r.kentat_listaan(&nimi, &mut rivi);
        }
        ulos.push(rivi);
    }
    Vastaus::ydin(match since {
        None => Value::Array(ulos),
        Some(_) => since_runko(s.seq_viimeisin, ulos, Vec::new(), nollaus),
    })
}

fn since_runko(seq: u64, muuttuneet: Vec<Value>, poistetut: Vec<String>, nollaus: bool) -> Value {
    let mut r = json!({"seq": seq, "muuttuneet": muuttuneet, "poistetut": poistetut});
    if nollaus {
        r["nollaus"] = Value::Bool(true);
    }
    r
}

/// `GET /api/skoopit/<nimi>[?since=]`.
pub async fn skooppi(tila: &Tila, nimi: &str, since: Option<u64>) -> Vastaus {
    let n = match tasalle(tila) {
        Ok(n) => n,
        Err(v) => return v,
    };
    let (ytimessa, seq) = {
        let s = n.sisa.read().unwrap_or_else(|e| e.into_inner());
        (s.lahteet_ytimessa(), s.seq_viimeisin)
    };
    let silta = silta_hae(tila, &format!("/api/skoopit/{}", koodaa(nimi))).await;
    if !ytimessa {
        return match since {
            Some(_) => silta_nollauksena(silta, seq),
            None => silta,
        };
    }
    if !silta.koodi.is_success() || !silta.runko.is_object() {
        return silta;
    }
    let mut runko = silta.runko;
    let s = n.sisa.read().unwrap_or_else(|e| e.into_inner());
    let sk = s.skooppi(nimi);
    let istunnot = istuntolista(&sk, runko.get("istunnot"));
    runko["istunnot"] = Value::Array(istunnot);
    // Päärekisteri = sillan rekisterit[0]; ytimessä → rekisterikentät ytimestä.
    let paa = runko
        .get("rekisterit")
        .and_then(|r| r.get(0))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(r) = paa.and_then(|p| n.rekisteri(&tila.varasto, &p)) {
        r.kentat_yksityiskohtaan(nimi, &mut runko);
    }
    match since {
        None => Vastaus::ydin(runko),
        Some(x) => {
            let nollaus = match s.nollaus(&tila.varasto, x) {
                Ok(b) => b,
                Err(e) => return Vastaus::virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            };
            let muuttui = nollaus || sk.muutettu > x || s.rekisterit_seq > x;
            let lista = if muuttui { vec![runko] } else { Vec::new() };
            Vastaus::ydin(since_runko(s.seq_viimeisin, lista, Vec::new(), nollaus))
        }
    }
}

/// `GET /api/skoopit/<nimi>/viestit[?since=]`. Ikkunoitu solmu lisää kentän `haettavissa` ja käynnistää
/// tarvittaessa taustahaun (S-9d pohja, S-9e edeltävät yksiköt) vastauksen koostamisen jälkeen.
pub async fn viestit(tila: &Arc<Tila>, nimi: &str, since: Option<u64>) -> Vastaus {
    let n = match tasalle(tila) {
        Ok(n) => n,
        Err(v) => return v,
    };
    let polku = format!("/api/skoopit/{}/viestit", koodaa(nimi));
    // Sillasta, jos lähde puuttuu tai uusin avoin istunto on agy (agy-viestit eivät ole ytimessä).
    let (sillasta, seq) = {
        let s = n.sisa.read().unwrap_or_else(|e| e.into_inner());
        let sk = s.skooppi(nimi);
        let sillasta = !s.lahteet_ytimessa() || matches!(sk.valittu, Some((true, _)));
        (sillasta, s.seq_viimeisin)
    };
    if sillasta {
        let v = silta_hae(tila, &polku).await;
        return match since {
            Some(_) => silta_nollauksena(v, seq),
            None => v,
        };
    }
    let s = n.sisa.read().unwrap_or_else(|e| e.into_inner());
    let sk = s.skooppi(nimi);
    let avoinna = avoimet(&sk);
    let Some((_, i)) = avoinna.first() else {
        let runko = json!({
            "nimi": nimi, "auki": false,
            "pakattu": !sk.istunnot.is_empty() || !sk.agy.is_empty(),
            "istunto": null, "voiLahettaa": false, "viestit": [],
        });
        return match since {
            None => Vastaus::ydin(runko),
            Some(x) => {
                let nollaus = sk.valittu_muutettu > x
                    || match s.nollaus(&tila.varasto, x) {
                        Ok(b) => b,
                        Err(e) => {
                            return Vastaus::virhe(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                &e.to_string(),
                            )
                        }
                    };
                Vastaus::ydin(since_runko(
                    s.seq_viimeisin,
                    Vec::new(),
                    Vec::new(),
                    nollaus,
                ))
            }
        };
    };
    let tiedosto = i.get("transkripti").and_then(Value::as_str).unwrap_or("");
    let k = s.viestit.get(tiedosto);
    // S-9d/S-9e: vain ikkunoitu solmu; täyden solmun vastaus ennallaan (ei `haettavissa`-kenttää).
    let haku = match (tila.peili.ikkuna_vrk.is_some(), k) {
        (true, Some(k)) => Some((
            tiedosto.to_string(),
            peili::tarvitsee_pohjan(&tila.varasto, tiedosto).unwrap_or(false),
            k.pohja.is_some_and(|p| p.rivi > 0) && k.viestit.len() < MAARA,
        )),
        _ => None,
    };
    let haettavissa = haku.as_ref().map(|(t, _, _)| n.haettavissa(t));
    let ruudullisia = avoinna.iter().filter(|(_, x)| tosi(x.get("ruutu"))).count();
    let kentta = |x: &str| i.get(x).cloned().unwrap_or(Value::Null);
    let mut runko = json!({
        "nimi": nimi,
        "auki": true,
        "istunto": {
            "id": kentta("istunto"),
            "nimi": kentta("nimi"),
            "tila": kentta("tila"),
            "konteksti": kentta("konteksti"),
            "tyyppi": "claude",
            "malli": k.map_or(Value::Null, |k| k.malli.clone()),
            "effort": k.map_or(Value::Null, |k| k.effort.clone()),
        },
        "voiLahettaa": tosi(i.get("ruutu")) && ruudullisia == 1,
        "viestit": k.map_or_else(Vec::new, Keskustelu::lista),
    });
    if let Some(h) = haettavissa {
        runko["haettavissa"] = Value::Bool(h);
    }
    let vastaus = 'v: {
        let Some(x) = since else {
            break 'v Vastaus::ydin(runko);
        };
        let mut nollaus = match s.nollaus(&tila.varasto, x) {
            Ok(b) => b,
            Err(e) => return Vastaus::virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        };
        nollaus =
            nollaus || sk.valittu_muutettu > x || k.is_none_or(|k| x < k.alku || x < k.poisto_raja);
        let Some(k) = k else {
            break 'v Vastaus::ydin(since_runko(s.seq_viimeisin, Vec::new(), Vec::new(), true));
        };
        let muuttuneet: Vec<Value> = k
            .viestit
            .iter()
            .filter(|v| nollaus || v.muutettu > x)
            .map(Keskustelu::tunnisteella)
            .collect();
        let poistetut: Vec<String> = if nollaus {
            Vec::new()
        } else {
            k.poistetut
                .iter()
                .filter(|(_, s)| *s > x)
                .map(|(id, _)| id.clone())
                .collect()
        };
        let mut r = since_runko(s.seq_viimeisin, muuttuneet, poistetut, nollaus);
        if let Some(h) = haettavissa {
            r["haettavissa"] = Value::Bool(h);
        }
        Vastaus::ydin(r)
    };
    drop(s);
    if let Some((tiedosto, pohja, edeltavat)) = haku {
        kaynnista_haku(&n, tila, tiedosto, pohja, edeltavat);
    }
    vastaus
}

impl Nakymat {
    /// S-9e: epäonnistuiko tiedoston viimeisin taustahaku?
    fn haettavissa(&self, tiedosto: &str) -> bool {
        self.haut
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(tiedosto)
            .is_some_and(|h| h.epaonnistui)
    }

    /// S-9e: täyttääkö istunnon näkymä haun ehdon (pohja.rivi > 0 ja alle `MAARA` viestiä)?
    fn vajaa(&self, tiedosto: &str) -> bool {
        self.sisa
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .viestit
            .get(tiedosto)
            .is_some_and(|k| k.pohja.is_some_and(|p| p.rivi > 0) && k.viestit.len() < MAARA)
    }
}

/// Käynnistää tiedoston taustahaun, ellei edellinen ole kesken: pohja (S-9d), jos tarvitaan, ja sen jälkeen
/// edeltävät yksiköt (S-9e, enintään kerran `HAKUVALI`ssa), jos näkymä on yhä vajaa.
fn kaynnista_haku(
    n: &Arc<Nakymat>,
    tila: &Arc<Tila>,
    tiedosto: String,
    pohja: bool,
    edeltavat: bool,
) {
    if !pohja && !edeltavat {
        return;
    }
    {
        let mut h = n.haut.lock().unwrap_or_else(|e| e.into_inner());
        let e = h.entry(tiedosto.clone()).or_default();
        if e.kaynnissa || (!pohja && e.edeltavat.is_some_and(|t| t.elapsed() < peili::HAKUVALI)) {
            return;
        }
        e.kaynnissa = true;
    }
    let (n, tila) = (n.clone(), tila.clone());
    tokio::spawn(async move {
        let tulos = aja_haku(&n, &tila, &tiedosto, pohja).await;
        if let Err(e) = &tulos {
            eprintln!("nakymat: haku {tiedosto}: {e}");
        }
        let mut h = n.haut.lock().unwrap_or_else(|e| e.into_inner());
        let e = h.entry(tiedosto).or_default();
        e.kaynnissa = false;
        e.epaonnistui = tulos.is_err();
    });
}

async fn aja_haku(n: &Nakymat, tila: &Tila, tiedosto: &str, pohja: bool) -> Result<(), String> {
    if pohja {
        peili::hae_pohja(tila, tiedosto).await?;
        n.paivita(tila).map_err(|e| e.to_string())?;
    }
    if !n.vajaa(tiedosto) {
        return Ok(());
    }
    {
        let mut h = n.haut.lock().unwrap_or_else(|e| e.into_inner());
        let e = h.entry(tiedosto.to_string()).or_default();
        if e.edeltavat.is_some_and(|t| t.elapsed() < peili::HAKUVALI) {
            return Ok(());
        }
        e.edeltavat = Some(Instant::now());
    }
    peili::hae_edeltavat(tila, tiedosto).await?;
    n.paivita(tila).map_err(|e| e.to_string())?;
    Ok(())
}

/// `GET /api/rekisterit/<p>`: ytimessä `{polku, osat}` (lahteet.mjs `rekisterinOsat`), muuten silta.
pub async fn rekisterin_osat(
    tila: &Tila,
    polku: &str,
    sillan_polku: &str,
    since: Option<u64>,
) -> Vastaus {
    let n = match tasalle(tila) {
        Ok(n) => n,
        Err(v) => return v,
    };
    let Some(r) = n.rekisteri(&tila.varasto, polku) else {
        return sillasta(tila, sillan_polku, since).await;
    };
    let v = Vastaus::ydin(json!({"polku": polku, "osat": osiin(&r.teksti)}));
    match since {
        None => v,
        Some(_) => silta_nollauksena(v, n.seq()),
    }
}

/// Reitti, jonka lähde ei ole ytimessä (agentit, rekisterilista): silta, `since` nollauksena.
pub async fn sillasta(tila: &Tila, polku: &str, since: Option<u64>) -> Vastaus {
    let v = silta_hae(tila, polku).await;
    match since {
        None => v,
        Some(_) => {
            let seq = match tasalle(tila) {
                Ok(n) => {
                    n.sisa
                        .read()
                        .unwrap_or_else(|e| e.into_inner())
                        .seq_viimeisin
                }
                Err(e) => return e,
            };
            silta_nollauksena(v, seq)
        }
    }
}

// ---- reitit ------------------------------------------------------------------------------------------------------

fn lue_since(q: &HashMap<String, String>) -> Result<Option<u64>, Vastaus> {
    match q.get("since") {
        None => Ok(None),
        Some(s) => s
            .parse::<u64>()
            .map(Some)
            .map_err(|_| Vastaus::virhe(StatusCode::BAD_REQUEST, "since ei ole luku")),
    }
}

/// Polku ja kysely ilman `since`-parametria sillalle.
fn ilman_since(uri: &axum::http::Uri) -> String {
    let kysely: Vec<&str> = uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty() && *p != "since" && !p.starts_with("since="))
        .collect();
    if kysely.is_empty() {
        uri.path().to_string()
    } else {
        format!("{}?{}", uri.path(), kysely.join("&"))
    }
}

async fn r_skoopit(
    State(t): State<Arc<Tila>>,
    Query(q): Query<HashMap<String, String>>,
) -> Vastaus {
    match lue_since(&q) {
        Ok(since) => skoopit(&t, since).await,
        Err(v) => v,
    }
}

async fn r_skooppi(
    State(t): State<Arc<Tila>>,
    Path(nimi): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Vastaus {
    match lue_since(&q) {
        Ok(since) => skooppi(&t, &nimi, since).await,
        Err(v) => v,
    }
}

async fn r_viestit(
    State(t): State<Arc<Tila>>,
    Path(nimi): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Vastaus {
    match lue_since(&q) {
        Ok(since) => viestit(&t, &nimi, since).await,
        Err(v) => v,
    }
}

async fn r_sillasta(
    State(t): State<Arc<Tila>>,
    uri: axum::http::Uri,
    Query(q): Query<HashMap<String, String>>,
) -> Vastaus {
    match lue_since(&q) {
        Ok(since) => sillasta(&t, &ilman_since(&uri), since).await,
        Err(v) => v,
    }
}

async fn r_rekisteri(
    State(t): State<Arc<Tila>>,
    Path(polku): Path<String>,
    uri: axum::http::Uri,
    Query(q): Query<HashMap<String, String>>,
) -> Vastaus {
    match lue_since(&q) {
        Ok(since) => {
            rekisterin_osat(&t, polku.trim_start_matches('/'), &ilman_since(&uri), since).await
        }
        Err(v) => v,
    }
}

pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new()
        .route("/api/skoopit", get(r_skoopit))
        .route("/api/skoopit/:nimi", get(r_skooppi))
        .route("/api/skoopit/:nimi/viestit", get(r_viestit))
        .route("/api/agentit", get(r_sillasta))
        .route("/api/rekisterit", get(r_sillasta))
        .route("/api/rekisterit/*polku", get(r_rekisteri))
        .with_state(tila)
}

/// Tilaa muutosten broadcastin ja pitää näkymän ajan tasalla (peili → rivit, lahde → skoopit, rekisterit → kentät)
/// sekä päivittää siltavälimuistin `SILTAVALI`n välein.
pub fn kaynnista(tila: Arc<Tila>) -> tokio::task::JoinHandle<()> {
    kaynnista_valilla(tila, SILTAVALI)
}

/// `kaynnista` annetulla siltavälimuistin päivitysvälillä (testit).
pub fn kaynnista_valilla(tila: Arc<Tila>, vali: Duration) -> tokio::task::JoinHandle<()> {
    let mut rx = tila.lahetin.subscribe();
    tokio::spawn(async move {
        let n = nakyma(&tila);
        if let Err(e) = n.paivita(&tila) {
            eprintln!("nakymat: {e}");
        }
        let seuraa = async {
            // Lagged: loki luetaan seq:stä, joten väliin jääneet tapahtumat eivät katoa.
            while let Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) =
                rx.recv().await
            {
                if let Err(e) = n.paivita(&tila) {
                    eprintln!("nakymat: {e}");
                }
            }
        };
        let silta = async {
            if tila.vanha.is_none() {
                return std::future::pending::<()>().await;
            }
            let mut ajastin = tokio::time::interval(vali);
            ajastin.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ajastin.tick().await;
                paivita_silta(&tila, &n).await;
            }
        };
        // S-9d (T-75): pohja heti. Käynnistyksessä, tasauksen, virran erän ja karsinnan jälkeen merkityt tiedostot
        // saavat pohjan (enintään `POHJAKIERROS` kierroksella); tallennettu pohja rakentaa näkymän uudelleen
        // ilman näkymäpyyntöä. Virhe: lokiin, ei uusintasilmukkaa; seuraava herätys yrittää uudelleen.
        let pohjat = async {
            if tila.peili.ikkuna_vrk.is_none() {
                return std::future::pending::<()>().await;
            }
            if let Err(e) = peili::merkitse_kaikki_pohjaa_vailla(&tila) {
                eprintln!("nakymat: pohjien merkintä: {e}");
            }
            loop {
                let kierros = peili::hae_pohjakierros(&tila).await;
                if let Some(e) = &kierros.virhe {
                    eprintln!("nakymat: pohjan haku: {e}");
                }
                if kierros.tallennettu > 0 {
                    if let Err(e) = n.paivita(&tila) {
                        eprintln!("nakymat: {e}");
                    }
                }
                tila.peili.pohja_herate.notified().await;
            }
        };
        tokio::select! {
            _ = seuraa => {}
            _ = silta => {}
            _ = pohjat => {}
        }
    })
}
