//! Transkriptipeili (S-5a): adapterin lisäämät jsonl-rivit ytimen kopioon offset-tarkistuksella.
//! Yksikkö: polku "peili", id `<tiedosto>:<offset>`, sisältö = rivit JSON-taulukkona (lisäysyhdistäjä).
//! Tiedoston ytimen tuntema offset: polku "peili-offset", id `<tiedosto>`, sisältö `{"offset":n}` (LWW),
//! kirjoitetaan suoraan varastoon eikä sitä ilmoiteta virran broadcast-kanavaan.

use crate::api::{kello_ms, kirjoita_yhdistajalla, Tila};
use crate::muutosloki::Result;
use crate::varasto::Varasto;
use crate::vertaiset::Vertainen;
use crate::yksikko::{yhdistaja_yksikolle, Hlc, Yhdistaja, Yksikko};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OpenFlags};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const POLKU: &str = "peili";
const OFFSET_POLKU: &str = "peili-offset";

/// Sarjoittaa offsetin tarkistuksen ja kirjoituksen, jotta kaksi samanaikaista POST:ia ei kirjoita päällekkäin.
static KIRJOITUS: Mutex<()> = Mutex::new(());

pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new()
        .route("/api/peili", post(laheta))
        .route("/api/peili/koko", get(koko))
        .route("/api/peili/*tiedosto", get(hae_tiedostosta))
        .with_state(tila)
}

fn virhe(koodi: StatusCode, teksti: &str) -> Response {
    (koodi, Json(json!({"virhe": teksti}))).into_response()
}

fn muunnosvirhe(teksti: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, teksti.into())
}

/// Ytimen tiedossa oleva offset tiedostolle; tuntematon tiedosto = 0.
pub fn offset(varasto: &Varasto, tiedosto: &str) -> Result<u64> {
    let Some(y) = varasto.lue(OFFSET_POLKU, tiedosto)? else {
        return Ok(0);
    };
    if y.poistettu {
        return Ok(0);
    }
    let arvo: Value = y
        .sisalto
        .as_deref()
        .map(serde_json::from_slice)
        .transpose()
        .map_err(|e| muunnosvirhe(e.to_string()))?
        .unwrap_or(Value::Null);
    arvo.get("offset")
        .and_then(Value::as_u64)
        .ok_or_else(|| muunnosvirhe(format!("virheellinen offset-yksikkö: {tiedosto}")))
}

/// Kaikki tiedoston peiliyksiköiden rivit offset-järjestyksessä yhdistettynä.
pub fn rivit(varasto: &Varasto, tiedosto: &str) -> Result<Vec<String>> {
    Ok(rivit_alkaen(varasto, tiedosto, 0)?.0)
}

/// Tiedoston rivit yksiköistä, joiden offset >= `offset`, offset-järjestyksessä, ja seuraava offset
/// (viimeisen yksikön loppu; ei yksiköitä = `offset`). Hakee vain tiedoston avainvälin
/// `<tiedosto>:` … `<tiedosto>;` (';' = ':' + 1); väli voi sisältää tiedoston "a:b" yksiköitä
/// tiedostolle "a", joten nimi tarkistetaan vielä haun jälkeen. Väli luetaan otsakkeina, ja sisältö
/// haetaan vain offsetin jälkeisistä yksiköistä (R-3: pitkän transkriptin päivitys ei lataa koko tiedostoa).
pub fn rivit_alkaen(varasto: &Varasto, tiedosto: &str, offset: u64) -> Result<(Vec<String>, u64)> {
    let mut osat: Vec<(u64, Vec<String>)> = Vec::new();
    for y in
        varasto.listaa_vali_otsakkeet(POLKU, &format!("{tiedosto}:"), &format!("{tiedosto};"))?
    {
        if y.poistettu {
            continue;
        }
        let Some((nimi, alku)) = y.id.rsplit_once(':') else {
            continue;
        };
        if nimi != tiedosto {
            continue;
        }
        let Ok(alku) = alku.parse::<u64>() else {
            continue;
        };
        if alku < offset {
            continue;
        }
        let Some(y) = varasto.lue(POLKU, &y.id)?.filter(|y| !y.poistettu) else {
            continue;
        };
        let taulukko: Vec<String> = y
            .sisalto
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|e| muunnosvirhe(e.to_string()))?
            .unwrap_or_default();
        osat.push((alku, taulukko));
    }
    osat.sort_by_key(|(alku, _)| *alku);
    let seuraava = osat.last().map_or(offset, |(alku, r)| {
        alku + r.iter().map(|x| x.len() as u64 + 1).sum::<u64>()
    });
    Ok((osat.into_iter().flat_map(|(_, r)| r).collect(), seuraava))
}

/// T-76: `yksikoiden_rivimaarat` vain, jos lukuyhteyden kanta `<data>/ydin.db` on varaston oma: kanta on
/// olemassa ja sen yksiköt ovat samat kuin varaston otsakkeissa (avainväli, ei poistettuja). Muuten `None`
/// (esim. testivarasto toisella tiedostonimellä); kutsuja lukee silloin rivit varastosta.
pub fn varmistetut_rivimaarat(
    varasto: &Varasto,
    tiedosto: &str,
) -> Result<Option<Vec<(u64, u64)>>> {
    if !varasto.data().is_some_and(|d| d.join("ydin.db").is_file()) {
        return Ok(None);
    }
    let Ok(maarat) = yksikoiden_rivimaarat(varasto, tiedosto) else {
        return Ok(None);
    };
    let mut alut: Vec<u64> = paikalliset_alut(varasto, tiedosto)?;
    alut.sort_unstable();
    Ok(alut
        .iter()
        .copied()
        .eq(maarat.iter().map(|(a, _)| *a))
        .then_some(maarat))
}

/// Tiedoston paikallisten (ei poistettujen) peili-yksiköiden alut otsakkeista (avainväli).
fn paikalliset_alut(varasto: &Varasto, tiedosto: &str) -> Result<Vec<u64>> {
    Ok(varasto
        .listaa_vali_otsakkeet(POLKU, &format!("{tiedosto}:"), &format!("{tiedosto};"))?
        .into_iter()
        .filter(|y| !y.poistettu)
        .filter_map(|y| tiedoston_alku(&y.id, tiedosto))
        .collect())
}

/// Yhden peiliyksikön `<tiedosto>:<alku>` rivit (T-76: näkymä hännästä yksikkö kerrallaan); puuttuva tai
/// poistettu yksikkö = `None`. Sisältö jäsennetään kuten `rivit_alkaen`issa.
pub fn yksikon_rivit(varasto: &Varasto, tiedosto: &str, alku: u64) -> Result<Option<Vec<String>>> {
    let Some(y) = varasto
        .lue(POLKU, &format!("{tiedosto}:{alku}"))?
        .filter(|y| !y.poistettu)
    else {
        return Ok(None);
    };
    let taulukko: Vec<String> = y
        .sisalto
        .as_deref()
        .map(serde_json::from_slice)
        .transpose()
        .map_err(|e| muunnosvirhe(e.to_string()))?
        .unwrap_or_default();
    Ok(Some(taulukko))
}

/// Rivien tiiviste kuten adapterissa: rivit rivinvaihtoineen.
fn tiiviste(rivit: &[String]) -> String {
    let mut sha = Sha256::new();
    for r in rivit {
        sha.update(r.as_bytes());
        sha.update(b"\n");
    }
    sha.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Tulos: Ok(uusi offset) tai Err(ytimen offset) kun offset ei täsmää.
fn kirjoita(
    t: &Tila,
    tiedosto: &str,
    alku: u64,
    rivit: &[String],
) -> Result<std::result::Result<u64, u64>> {
    let _vuoro = KIRJOITUS.lock().unwrap_or_else(|e| e.into_inner());
    let tunnettu = offset(&t.varasto, tiedosto)?;
    if alku != tunnettu {
        return Ok(Err(tunnettu));
    }
    if rivit.is_empty() {
        return Ok(Ok(alku));
    }
    let tavut: u64 = rivit.iter().map(|r| r.len() as u64 + 1).sum();
    let uusi = alku + tavut;
    let nyt = kello_ms();

    let peili = Yksikko {
        polku: POLKU.to_string(),
        id: format!("{tiedosto}:{alku}"),
        versio: BTreeMap::from([(t.laite.clone(), 1)]),
        aika: Hlc::nyt(&t.laite, None, nyt),
        sisalto: Some(serde_json::to_vec(rivit).unwrap_or_default()),
        poistettu: false,
    };
    // Peiliyksikkö ensin: katkon jälkeen sama POST on idempotentti (lisäys ei korvaa olemassa olevaa).
    kirjoita_yhdistajalla(t, &peili, Yhdistaja::Lisays)?;

    let edellinen = t.varasto.lue(OFFSET_POLKU, tiedosto)?;
    let mut versio = edellinen
        .as_ref()
        .map(|y| y.versio.clone())
        .unwrap_or_default();
    *versio.entry(t.laite.clone()).or_insert(0) += 1;
    let tallennus = Yksikko {
        polku: OFFSET_POLKU.to_string(),
        id: tiedosto.to_string(),
        versio,
        aika: Hlc::nyt(&t.laite, edellinen.as_ref().map(|y| &y.aika), nyt),
        sisalto: Some(serde_json::to_vec(&json!({"offset": uusi})).unwrap_or_default()),
        poistettu: false,
    };
    // Sisäinen yksikkö: suoraan varastoon, ei broadcast-ilmoitusta.
    t.varasto.kirjoita(&tallennus, Yhdistaja::Lww)?;
    Ok(Ok(uusi))
}

async fn laheta(State(t): State<Arc<Tila>>, runko: Bytes) -> Response {
    let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(&runko) else {
        return virhe(StatusCode::BAD_REQUEST, "runko ei ole JSON-olio");
    };
    let Some(tiedosto) = o
        .get("tiedosto")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return virhe(StatusCode::BAD_REQUEST, "tiedosto puuttuu");
    };
    let Some(alku) = o.get("offset").and_then(Value::as_u64) else {
        return virhe(StatusCode::BAD_REQUEST, "offset puuttuu");
    };
    let Some(Ok(rivit)) = o
        .get("rivit")
        .map(|r| serde_json::from_value::<Vec<String>>(r.clone()))
    else {
        return virhe(StatusCode::BAD_REQUEST, "rivit ei ole merkkijonotaulukko");
    };
    let Some(sha) = o.get("sha256").and_then(Value::as_str) else {
        return virhe(StatusCode::BAD_REQUEST, "sha256 puuttuu");
    };
    if !sha.eq_ignore_ascii_case(&tiiviste(&rivit)) {
        return virhe(StatusCode::BAD_REQUEST, "sha256 ei täsmää");
    }
    match kirjoita(&t, tiedosto, alku, &rivit) {
        Ok(Ok(uusi)) => Json(json!({"offset": uusi})).into_response(),
        Ok(Err(tunnettu)) => {
            (StatusCode::CONFLICT, Json(json!({"offset": tunnettu}))).into_response()
        }
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// `GET /api/peili/<tiedosto>/offset` (S-5a), `GET /api/peili/<tiedosto>/rivi?offset=<tavu>` (S-9d) ja
/// `GET /api/peili/<tiedosto>/raaka?rivi=&maara=` (S-9f).
async fn hae_tiedostosta(
    State(t): State<Arc<Tila>>,
    Path(polku): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Some(tiedosto) = polku.strip_suffix("/rivi").filter(|s| !s.is_empty()) {
        let Some(alku) = q.get("offset").and_then(|s| s.parse::<u64>().ok()) else {
            return virhe(StatusCode::BAD_REQUEST, "offset puuttuu");
        };
        let tiedosto = tiedosto.to_string();
        let tulos = tokio::task::spawn_blocking(move || rivi(&t.varasto, &tiedosto, alku)).await;
        return match tulos {
            Ok(Ok(Some(n))) => Json(json!({"offset": alku, "rivi": n})).into_response(),
            Ok(Ok(None)) => virhe(StatusCode::NOT_FOUND, "offset ei ole yksikön alku"),
            Ok(Err(e)) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        };
    }
    if let Some(tiedosto) = polku.strip_suffix("/raaka").filter(|s| !s.is_empty()) {
        return raaka_reitti(t, tiedosto.to_string(), &q).await;
    }
    let Some(tiedosto) = polku.strip_suffix("/offset").filter(|s| !s.is_empty()) else {
        return virhe(StatusCode::NOT_FOUND, "tuntematon polku");
    };
    match offset(&t.varasto, tiedosto) {
        Ok(n) => Json(json!({"offset": n})).into_response(),
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ---- Aikaikkuna (S-9, ARK-17) ------------------------------------------------------------------------

const PAIVA_MS: u64 = 86_400_000;
/// Megatavu katon yksikkönä (Mt = 2^20 tavua).
const MT: u64 = 1_048_576;
/// S-9e: taustahaulla haetut yksiköt pysyvät karsinnan ulkopuolella näin kauan.
pub const HAKUSUOJA: Duration = Duration::from_secs(600);
/// Karsintojen vähimmäisväli (S-9c).
pub const KARSINTAVALI: Duration = Duration::from_secs(60);

/// Laitekohtainen peiliasetus ja karsinnan suojamuisti (`Tila.peili`). Oletus = täysi solmu.
pub struct PeiliIkkuna {
    /// `None` = täysi solmu (ei ikkunaa, ei karsintaa).
    pub ikkuna_vrk: Option<u32>,
    /// Katto megatavuina; käytössä vain ikkunan kanssa.
    pub katto_mt: u32,
    /// S-9e: viimeksi pyynnöstä haetut yksiköt (id -> hetki); karsinta ohittaa alle `HAKUSUOJA` vanhat.
    pub haetut: Mutex<HashMap<String, Instant>>,
    /// S-9d (T-75): tiedostot, joilta puuttuu voimassa oleva pohja, ja vertainen, jolta niiden yksiköt tulivat
    /// (`None` = ensimmäinen täysi vertainen). Jono tyhjennetään `hae_pohjakierros`ssa.
    pohjaa_vailla: Mutex<VecDeque<(String, Option<Vertainen>)>>,
    /// S-9d (T-75): herättää näkymien pohjatyöntekijän, kun `pohjaa_vailla` sai tiedoston.
    pub pohja_herate: tokio::sync::Notify,
}

impl Default for PeiliIkkuna {
    fn default() -> Self {
        PeiliIkkuna::uusi(None, 38)
    }
}

impl PeiliIkkuna {
    pub fn uusi(ikkuna_vrk: Option<u32>, katto_mt: u32) -> PeiliIkkuna {
        PeiliIkkuna {
            ikkuna_vrk,
            katto_mt,
            haetut: Mutex::new(HashMap::new()),
            pohjaa_vailla: Mutex::new(VecDeque::new()),
            pohja_herate: tokio::sync::Notify::new(),
        }
    }

    /// S-9d (T-75): lisää tiedoston pohjan hakujonoon (ei kaksoiskappaleita; vertaisvihje säilyy, jos uudella ei ole)
    /// ja herättää työntekijän.
    fn merkitse_pohjaa_vailla(&self, tiedosto: &str, vertainen: Option<&Vertainen>) {
        {
            let mut j = self.pohjaa_vailla.lock().unwrap_or_else(|e| e.into_inner());
            match j.iter_mut().find(|(t, _)| t == tiedosto) {
                Some((_, vihje)) => {
                    if vertainen.is_some() {
                        *vihje = vertainen.cloned();
                    }
                }
                None => j.push_back((tiedosto.to_string(), vertainen.cloned())),
            }
        }
        self.pohja_herate.notify_one();
    }

    /// Ottaa jonon alusta enintään `POHJAKIERROS` tiedostoa; loput jäävät seuraavalle kierrokselle.
    fn ota_pohjaera(&self) -> VecDeque<(String, Option<Vertainen>)> {
        let mut j = self.pohjaa_vailla.lock().unwrap_or_else(|e| e.into_inner());
        let n = j.len().min(POHJAKIERROS);
        j.drain(..n).collect()
    }

    /// Palauttaa käsittelemättömät jonon alkuun ja epäonnistuneen loppuun (seuraava kierros yrittää uudelleen).
    fn palauta_pohjaera(
        &self,
        kasittelematta: VecDeque<(String, Option<Vertainen>)>,
        epaonnistunut: (String, Option<Vertainen>),
    ) {
        let mut j = self.pohjaa_vailla.lock().unwrap_or_else(|e| e.into_inner());
        for e in kasittelematta.into_iter().rev() {
            if !j.iter().any(|(t, _)| *t == e.0) {
                j.push_front(e);
            }
        }
        if !j.iter().any(|(t, _)| *t == epaonnistunut.0) {
            j.push_back(epaonnistunut);
        }
    }

    /// Merkitsee yksikön (id `<tiedosto>:<offset>`) juuri haetuksi: karsinta ohittaa sen 10 min (S-9e).
    pub fn merkitse_haetuksi(&self, id: &str) {
        let mut h = self.haetut.lock().unwrap_or_else(|e| e.into_inner());
        h.retain(|_, t| t.elapsed() < HAKUSUOJA);
        h.insert(id.to_string(), Instant::now());
    }

    fn suojattu(&self, id: &str) -> bool {
        let h = self.haetut.lock().unwrap_or_else(|e| e.into_inner());
        h.get(id).is_some_and(|t| t.elapsed() < HAKUSUOJA)
    }
}

/// Karsinnan tulos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Karsinta {
    pub poistetut: usize,
    pub tavut_ennen: u64,
    pub tavut_jalkeen: u64,
}

fn teksti_lohko(l: &Value) -> bool {
    l.get("type").and_then(Value::as_str) == Some("text")
}

fn tynkarivi(tyyppi: Option<&Value>) -> String {
    let tyyppi = tyyppi
        .filter(|t| t.is_string())
        .cloned()
        .unwrap_or(Value::Null);
    json!({"type": tyyppi, "karsittu": true}).to_string()
}

/// Työkalun `input`-avaimet, jotka näkymän `tyokalu_rivi` lukee (`nakymat.rs`); muut pudotetaan (S-9a T-74).
const TYOKALUN_AVAIMET: [&str; 7] = [
    "command",
    "file_path",
    "notebook_path",
    "path",
    "pattern",
    "description",
    "subagent_type",
];

/// Merkkijonon ensimmäinen rivi, enintään 2 000 merkkiä (UTF-8-rajalla).
fn ensimmainen_rivi(s: &str) -> String {
    s.split('\n')
        .next()
        .unwrap_or("")
        .chars()
        .take(2000)
        .collect()
}

/// `tool_use`-lohko → `{type, id, name, input'}` (S-9a T-74): AskUserQuestionilla `input'` = `{questions}`
/// kokonaan, muilla vain `TYOKALUN_AVAIMET`, merkkijonoista ensimmäinen rivi.
fn riisu_tyokalu(l: &Value) -> Value {
    let mut ulos = serde_json::Map::new();
    for avain in ["type", "id", "name"] {
        if let Some(v) = l.get(avain) {
            ulos.insert(avain.to_string(), v.clone());
        }
    }
    let mut syote = serde_json::Map::new();
    if let Some(Value::Object(i)) = l.get("input") {
        if l.get("name").and_then(Value::as_str) == Some("AskUserQuestion") {
            if let Some(q) = i.get("questions") {
                syote.insert("questions".to_string(), q.clone());
            }
        } else {
            for avain in TYOKALUN_AVAIMET {
                match i.get(avain) {
                    Some(Value::String(s)) => {
                        syote.insert(avain.to_string(), Value::String(ensimmainen_rivi(s)));
                    }
                    Some(v) => {
                        syote.insert(avain.to_string(), v.clone());
                    }
                    None => {}
                }
            }
        }
    }
    ulos.insert("input".to_string(), Value::Object(syote));
    Value::Object(ulos)
}

/// `tool_result`-lohko → `{type, tool_use_id}`.
fn riisu_tulos(l: &Value) -> Value {
    let mut ulos = serde_json::Map::new();
    for avain in ["type", "tool_use_id"] {
        if let Some(v) = l.get(avain) {
            ulos.insert(avain.to_string(), v.clone());
        }
    }
    Value::Object(ulos)
}

fn riisu_rivi(rivi: &str) -> String {
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(rivi) else {
        return tynkarivi(None);
    };
    let tyyppi = o.get("type");
    if !matches!(tyyppi.and_then(Value::as_str), Some("user" | "assistant")) {
        return tynkarivi(tyyppi);
    }
    let viesti = o.get("message");
    let sisalto = match viesti.and_then(|m| m.get("content")) {
        Some(Value::String(s)) if !s.is_empty() => Some(Value::String(s.clone())),
        Some(Value::Array(a)) => {
            let lohkot: Vec<Value> = a
                .iter()
                .filter_map(|l| {
                    if teksti_lohko(l) {
                        return Some(l.clone());
                    }
                    match l.get("type").and_then(Value::as_str) {
                        Some("tool_use") => Some(riisu_tyokalu(l)),
                        Some("tool_result") => Some(riisu_tulos(l)),
                        _ => None,
                    }
                })
                .collect();
            (!lohkot.is_empty()).then_some(Value::Array(lohkot))
        }
        _ => None,
    };
    // Lohkoton rivi, jolla on model tai effort, säilyy content []:lla (näkymä päivittää niistä mallin ja effortin).
    let mallitieto = viesti.and_then(|m| m.get("model")).is_some()
        || o.contains_key("effort")
        || o.contains_key("perTurnEffort");
    let Some(sisalto) = sisalto.or_else(|| mallitieto.then(|| Value::Array(Vec::new()))) else {
        return tynkarivi(tyyppi);
    };
    let mut ulos = serde_json::Map::new();
    for avain in [
        "type",
        "timestamp",
        "uuid",
        "isSidechain",
        "isMeta",
        "perTurnEffort",
        "effort",
    ] {
        if let Some(v) = o.get(avain) {
            ulos.insert(avain.to_string(), v.clone());
        }
    }
    if let Some(vastaukset) = o.get("toolUseResult").and_then(|t| t.get("answers")) {
        ulos.insert(
            "toolUseResult".to_string(),
            json!({ "answers": vastaukset }),
        );
    }
    let mut viesti_ulos = serde_json::Map::new();
    for avain in ["role", "model"] {
        if let Some(v) = viesti.and_then(|m| m.get(avain)) {
            viesti_ulos.insert(avain.to_string(), v.clone());
        }
    }
    viesti_ulos.insert("content".to_string(), sisalto);
    ulos.insert("message".to_string(), Value::Object(viesti_ulos));
    Value::Object(ulos).to_string()
}

/// S-9a (T-74): riisuu transkriptirivit näkymän tarpeeseen. Rivi, jonka type on "user" tai "assistant", säilyttää
/// avaimet type, timestamp, uuid, isSidechain, isMeta, perTurnEffort, effort, toolUseResult.answers sekä
/// message.role, message.model ja message.content. Content: merkkijono sellaisenaan; taulukosta text-lohko
/// sellaisenaan, tool_use → {type, id, name, input} (AskUserQuestionilla input = {questions}, muilla vain
/// command, file_path, notebook_path, path, pattern, description ja subagent_type, merkkijonosta ensimmäinen rivi
/// enintään 2 000 merkkiä), tool_result → {type, tool_use_id}; muut lohkot pois. Rivi, josta ei jää yhtään lohkoa
/// tai merkkijonoa mutta jolla on message.model, effort tai perTurnEffort, säilyy content []:lla; muu rivi tai
/// lohkoton rivi ilman niitä on tyngän `{"type":<alkuperäinen|null>,"karsittu":true}`. Pituus on sama kuin syötteen.
pub fn riisu(rivit: &[String]) -> Vec<String> {
    rivit.iter().map(|r| riisu_rivi(r)).collect()
}

/// Sisältöaika (T-73, arkkitehtuuri 5368d699): suurin rivin `timestamp` (RFC 3339 → ms UTC) taulukon
/// riisumattomista riveistä; ei yhtään jäsentyvää → `hlc_ms`. `sisalto` on peili-yksikön sisältö
/// (JSON-merkkijonotaulukko); rivistä jäsennetään vain `timestamp`, virheellinen rivi ohitetaan.
pub fn sisaltoaika(sisalto: &[u8], hlc_ms: u64) -> u64 {
    #[derive(Deserialize)]
    struct Aikaleima {
        timestamp: Option<String>,
    }
    let Ok(rivit) = serde_json::from_slice::<Vec<String>>(sisalto) else {
        return hlc_ms;
    };
    rivit
        .iter()
        .filter_map(|r| serde_json::from_str::<Aikaleima>(r).ok())
        .filter_map(|a| rfc3339_ms(&a.timestamp?))
        .max()
        .unwrap_or(hlc_ms)
}

/// Yksikön sisältöaika riisumattomasta sisällöstä; ei sisältöä → HLC-aika.
pub fn yksikon_sisaltoaika(y: &Yksikko) -> u64 {
    y.sisalto
        .as_deref()
        .map_or(y.aika.ms, |s| sisaltoaika(s, y.aika.ms))
}

/// RFC 3339 -aikaleima (`YYYY-MM-DDTHH:MM:SS(.fff…)` + `Z` tai `±HH:MM`) millisekunteina Unix-ajasta;
/// ennen epookkia tai virheellinen = `None`. Murto-osan kolme ensimmäistä numeroa ovat millisekunnit.
fn rfc3339_ms(t: &str) -> Option<u64> {
    let b = t.as_bytes();
    let luku = |a: usize, n: usize| -> Option<i64> {
        let osa = b.get(a..a + n)?;
        if !osa.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(osa).ok()?.parse().ok()
    };
    let erotin = |i: usize, merkit: &[u8]| b.get(i).is_some_and(|c| merkit.contains(c));
    if !(erotin(4, b"-")
        && erotin(7, b"-")
        && erotin(10, b"Tt")
        && erotin(13, b":")
        && erotin(16, b":"))
    {
        return None;
    }
    let (vuosi, kk, pv) = (luku(0, 4)?, luku(5, 2)?, luku(8, 2)?);
    let (tunti, min, sek) = (luku(11, 2)?, luku(14, 2)?, luku(17, 2)?);
    let karkaus = vuosi % 4 == 0 && (vuosi % 100 != 0 || vuosi % 400 == 0);
    let kuukauden_paivat = match kk {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if karkaus => 29,
        2 => 28,
        _ => return None,
    };
    if pv < 1 || pv > kuukauden_paivat || tunti > 23 || min > 59 || sek > 60 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if erotin(i, b".") {
        let alku = i + 1;
        let mut loppu = alku;
        while b.get(loppu).is_some_and(u8::is_ascii_digit) {
            loppu += 1;
        }
        if loppu == alku {
            return None;
        }
        for (k, c) in b[alku..loppu].iter().take(3).enumerate() {
            ms += i64::from(c - b'0') * [100, 10, 1][k];
        }
        i = loppu;
    }
    let siirtyma_min = if erotin(i, b"Zz") && i + 1 == b.len() {
        0
    } else if erotin(i, b"+-") && b.len() == i + 6 && erotin(i + 3, b":") {
        let (th, tm) = (luku(i + 1, 2)?, luku(i + 4, 2)?);
        if th > 23 || tm > 59 {
            return None;
        }
        let m = th * 60 + tm;
        if b[i] == b'-' {
            -m
        } else {
            m
        }
    } else {
        return None;
    };
    // Päivät epookista (proleptinen gregoriaaninen kalenteri).
    let y = if kk <= 2 { vuosi - 1 } else { vuosi };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if kk > 2 { kk - 3 } else { kk + 9 }) + 2) / 5 + pv - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let paivat = era * 146_097 + doe - 719_468;
    let sekunnit = paivat * 86_400 + tunti * 3600 + min * 60 + sek - siirtyma_min * 60;
    u64::try_from(sekunnit * 1000 + ms).ok()
}

/// S-9a: ikkunoidun solmun vastaanotto. `None` = hylätään (yksikön sisältöaika on ikkunaa vanhempi),
/// muuten yksikkö riisuttuna sisällöltään (id, versio ja aika säilyvät). `sisaltoaika_ms` on laskettu
/// riisumattomista riveistä ennen tätä kutsua (`yksikon_sisaltoaika`; T-73).
pub fn ikkunoi(tila: &Tila, y: &Yksikko, sisaltoaika_ms: u64, nyt_ms: u64) -> Option<Yksikko> {
    let n = tila.peili.ikkuna_vrk?;
    let raja = nyt_ms.saturating_sub(u64::from(n) * PAIVA_MS);
    if sisaltoaika_ms < raja {
        return None;
    }
    Some(riisuttu(y))
}

/// Kirjoittaa riisutun peili-yksikön annetulla (riisumattomista riveistä lasketulla) sisältöajalla ja
/// ilmoittaa muutoksen virtaan kuten `api::kirjoita_yhdistajalla` (T-73).
pub fn kirjoita_riisuttuna(tila: &Tila, y: &Yksikko, sisaltoaika: u64) -> Result<Option<u64>> {
    let seq = tila
        .varasto
        .kirjoita_sisaltoajalla(y, yhdistaja_yksikolle(y), Some(sisaltoaika))?;
    if let Some(n) = seq {
        if let Some(t) = tila
            .varasto
            .loki(n.saturating_sub(1), 1)?
            .into_iter()
            .next()
        {
            // Ei vastaanottajia on sallittu tila.
            let _ = tila.lahetin.send(t);
        }
    }
    Ok(seq)
}

/// S-9a:n riisunta yksikölle ikkunarajasta riippumatta (id, versio ja aika säilyvät).
fn riisuttu(y: &Yksikko) -> Yksikko {
    let mut uusi = y.clone();
    if let Some(sisalto) = &y.sisalto {
        // Tunnistamaton sisältö (ei merkkijonotaulukkoa) tallennetaan sellaisenaan.
        if let Ok(rivit) = serde_json::from_slice::<Vec<String>>(sisalto) {
            uusi.sisalto = Some(serde_json::to_vec(&riisu(&rivit)).unwrap_or_default());
        }
    }
    uusi
}

/// S-9b/S-9c: karsintarajan sisäinen polku (id "raja", `{"ms":n}`); ei replikoida eikä virtaan.
pub const KARSINTA_POLKU: &str = "peili-karsinta";
pub(crate) const KARSINTA_ID: &str = "raja";

/// S-9b: viimeksi katon takia karsitun UTC-vuorokauden loppu (ms); ei karsittu = 0.
pub fn karsintaraja(varasto: &Varasto) -> Result<u64> {
    let Some(y) = varasto.lue(KARSINTA_POLKU, KARSINTA_ID)? else {
        return Ok(0);
    };
    if y.poistettu {
        return Ok(0);
    }
    let arvo: Value = y
        .sisalto
        .as_deref()
        .map(serde_json::from_slice)
        .transpose()
        .map_err(|e| muunnosvirhe(e.to_string()))?
        .unwrap_or(Value::Null);
    arvo.get("ms")
        .and_then(Value::as_u64)
        .ok_or_else(|| muunnosvirhe("virheellinen karsintaraja".to_string()))
}

/// Nostaa karsintarajan (kasvaa vain). Sisäinen yksikkö: suoraan varastoon, ei broadcast-ilmoitusta.
fn nosta_karsintaraja(tila: &Tila, ms: u64) -> Result<()> {
    if ms <= karsintaraja(&tila.varasto)? {
        return Ok(());
    }
    let edellinen = tila.varasto.lue(KARSINTA_POLKU, KARSINTA_ID)?;
    let mut versio = edellinen
        .as_ref()
        .map(|y| y.versio.clone())
        .unwrap_or_default();
    *versio.entry(tila.laite.clone()).or_insert(0) += 1;
    let raja = Yksikko {
        polku: KARSINTA_POLKU.to_string(),
        id: KARSINTA_ID.to_string(),
        versio,
        aika: Hlc::nyt(&tila.laite, edellinen.as_ref().map(|y| &y.aika), kello_ms()),
        sisalto: Some(serde_json::to_vec(&json!({"ms": ms})).unwrap_or_default()),
        poistettu: false,
    };
    tila.varasto.kirjoita(&raja, Yhdistaja::Lww)?;
    Ok(())
}

/// S-9c: poistaa paikallisesti ikkunan ulkopuoliset peili-yksiköt ja pitää sisältötavut katon alla
/// (vanhin UTC-vuorokausi kerrallaan). Täysi solmu ei koskaan poista mitään. Ei muutoslokia, ei tapahtumaa.
/// Katon takia karsittu vuorokausi nostaa karsintarajan sen loppuun (S-9b korjaus 2).
pub fn karsi(tila: &Tila) -> Result<Karsinta> {
    let Some(n) = tila.peili.ikkuna_vrk else {
        return Ok(Karsinta {
            poistetut: 0,
            tavut_ennen: 0,
            tavut_jalkeen: 0,
        });
    };
    let katto = u64::from(tila.peili.katto_mt) * MT;
    let raja = kello_ms().saturating_sub(u64::from(n) * PAIVA_MS);
    // (sisältöaika, id, tavut) vanhimmasta (T-73: sisältöaika, ei HLC); jäsentymättömät ajat ohitetaan.
    let mut yksikot: Vec<(u64, String, u64)> = tila
        .varasto
        .sisalto_koot(POLKU)?
        .into_iter()
        .filter_map(|(id, sisaltoaika, tavut)| Some((sisaltoaika?, id, tavut)))
        .collect();
    yksikot.sort();
    let ennen: u64 = yksikot.iter().map(|(_, _, t)| t).sum();
    let mut jalkeen = ennen;
    let mut poistetut = 0;
    // T-75: tiedostot, joiden paikallisia yksiköitä poistettiin (vanhin yksikkö voi olla muuttunut).
    let mut muuttuneet: BTreeSet<String> = BTreeSet::new();
    let mut poista = |id: &str, tavut: u64, jalkeen: &mut u64| -> Result<()> {
        if tila.varasto.poista_paikallisesti(POLKU, id)? {
            poistetut += 1;
            *jalkeen -= tavut;
            if let Some((tiedosto, _)) = id.rsplit_once(':') {
                muuttuneet.insert(tiedosto.to_string());
            }
        }
        Ok(())
    };
    // Ikkunan ulkopuoliset.
    let mut jaljella = Vec::new();
    for (ms, id, tavut) in yksikot {
        if ms < raja && !tila.peili.suojattu(&id) {
            poista(&id, tavut, &mut jalkeen)?;
        } else {
            jaljella.push((ms, id, tavut));
        }
    }
    // Katto: vanhin UTC-vuorokausi kerrallaan.
    let vuorokaudet: BTreeSet<u64> = jaljella.iter().map(|(ms, _, _)| ms / PAIVA_MS).collect();
    let mut uusi_raja = None;
    for vrk in vuorokaudet {
        if jalkeen <= katto {
            break;
        }
        for (_, id, tavut) in jaljella.iter().filter(|(ms, _, _)| ms / PAIVA_MS == vrk) {
            if !tila.peili.suojattu(id) {
                poista(id, *tavut, &mut jalkeen)?;
            }
        }
        uusi_raja = Some((vrk + 1) * PAIVA_MS);
    }
    if let Some(ms) = uusi_raja {
        nosta_karsintaraja(tila, ms)?;
    }
    // S-9d (T-75): vanhin yksikkö muuttui → pohja haetaan heti (ensimmäinen täysi vertainen).
    for tiedosto in &muuttuneet {
        if tarvitsee_pohjan(&tila.varasto, tiedosto).unwrap_or(false) {
            tila.peili.merkitse_pohjaa_vailla(tiedosto, None);
        }
    }
    Ok(Karsinta {
        poistetut,
        tavut_ennen: ennen,
        tavut_jalkeen: jalkeen,
    })
}

/// S-9: `GET /api/peili/koko` -> sisältötavut, yksiköt, vanhin sisältöaika (ms | null) ja asetukset.
async fn koko(State(t): State<Arc<Tila>>) -> Response {
    let tulos = tokio::task::spawn_blocking(move || {
        let koot = t.varasto.sisalto_koot(POLKU)?;
        let tavut: u64 = koot.iter().map(|(_, _, k)| k).sum();
        let vanhin = koot.iter().filter_map(|(_, a, _)| *a).min();
        Ok::<_, rusqlite::Error>(json!({
            "tavut": tavut,
            "yksikot": koot.len(),
            "vanhin": vanhin,
            "ikkuna_vrk": t.peili.ikkuna_vrk,
            "katto_mt": t.peili.katto_mt,
        }))
    })
    .await;
    match tulos {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ---- Rivipohja ja pyynnöstä haku (S-9d, S-9e) ----------------------------------------------------------

/// S-9d: tiedoston vanhimman paikallisen yksikön pohja (id `<tiedosto>`, `{"offset","rivi"}`). Sisäinen
/// polku kuten "peili-offset": ei replikoida eikä broadcast-ilmoitusta.
pub const POHJA_POLKU: &str = "peili-pohja";
/// S-9d (T-75): pohjia haetaan enintään näin monelle tiedostolle kierroksella, loput seuraavalla.
pub const POHJAKIERROS: usize = 50;
/// S-9d/S-9e: yhden vertaispyynnön aikaraja.
pub const PYYNNON_AIKARAJA: Duration = Duration::from_secs(10);
/// S-9e: yhden taustahaun sisältötavut enintään (8 Mt).
pub const HAKU_TAVUT: u64 = 8 * MT;
/// S-9e: taustahakujen vähimmäisväli tiedostoa kohden.
pub const HAKUVALI: Duration = Duration::from_secs(60);
/// `/api/hae`-pyynnön tunnukset enintään (`replikointi::ERA`).
const HAE_ERA: usize = 300;

/// Tiedoston rivinumeroinnin pohja: `rivi` riviä edeltää tavua `offset` (S-9d).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pohja {
    pub offset: u64,
    pub rivi: u64,
}

/// Yksikön alku, jos tunnus `<nimi>:<offset>` kuuluu tiedostolle `tiedosto`.
fn tiedoston_alku(id: &str, tiedosto: &str) -> Option<u64> {
    let (nimi, alku) = id.rsplit_once(':')?;
    if nimi != tiedosto {
        return None;
    }
    alku.parse().ok()
}

/// S-9d: rivien määrä tiedoston yksiköissä, joiden offset < `alku`; `None`, jos `alku` ei ole yksikön alku.
/// SQL (`json_array_length`) omalla lukuyhteydellä samaan kantaan (`<data>/ydin.db` kuten `liite.rs`):
/// rivejä ei ladata muistiin, vain tunnus ja rivimäärä yksikköä kohden.
pub fn rivi(varasto: &Varasto, tiedosto: &str, alku: u64) -> Result<Option<u64>> {
    let data = varasto
        .data()
        .ok_or_else(|| muunnosvirhe("varaston hakemisto puuttuu".to_string()))?;
    let c = Connection::open_with_flags(
        data.join("ydin.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    c.busy_timeout(Duration::from_secs(5))?;
    let mut kysely = c.prepare(
        "SELECT id, COALESCE(json_array_length(CAST(sisalto AS TEXT)), 0) FROM yksikot \
         WHERE polku = ?1 AND id >= ?2 AND id < ?3 AND poistettu = 0",
    )?;
    let mut rivit = kysely.query(params![
        POLKU,
        format!("{tiedosto}:"),
        format!("{tiedosto};")
    ])?;
    let mut loytyi = false;
    let mut summa = 0u64;
    while let Some(r) = rivit.next()? {
        let id: String = r.get(0)?;
        let n: i64 = r.get(1)?;
        match tiedoston_alku(&id, tiedosto) {
            Some(a) if a == alku => loytyi = true,
            Some(a) if a < alku => summa += n.max(0) as u64,
            _ => {}
        }
    }
    Ok(loytyi.then_some(summa))
}

/// Tiedoston vanhimman paikallisen (ei poistetun) peili-yksikön offset; otsakkeet avainväliltä.
pub fn vanhin_offset(varasto: &Varasto, tiedosto: &str) -> Result<Option<u64>> {
    Ok(varasto
        .listaa_vali_otsakkeet(POLKU, &format!("{tiedosto}:"), &format!("{tiedosto};"))?
        .into_iter()
        .filter(|y| !y.poistettu)
        .filter_map(|y| tiedoston_alku(&y.id, tiedosto))
        .min())
}

/// Tallennettu pohja (voi olla vanhentunut, ks. `voimassa_pohja`).
pub fn pohja(varasto: &Varasto, tiedosto: &str) -> Result<Option<Pohja>> {
    let Some(y) = varasto.lue(POHJA_POLKU, tiedosto)?.filter(|y| !y.poistettu) else {
        return Ok(None);
    };
    let arvo: Value = y
        .sisalto
        .as_deref()
        .map(serde_json::from_slice)
        .transpose()
        .map_err(|e| muunnosvirhe(e.to_string()))?
        .unwrap_or(Value::Null);
    Ok(
        match (
            arvo.get("offset").and_then(Value::as_u64),
            arvo.get("rivi").and_then(Value::as_u64),
        ) {
            (Some(offset), Some(rivi)) => Some(Pohja { offset, rivi }),
            _ => None,
        },
    )
}

/// Pohja, joka vastaa tiedoston vanhinta paikallista yksikköä: offset 0 → `{0,0}` ilman hakua; muuten
/// tallennettu pohja, jos sen offset on vanhimman yksikön alku. `None` = numerointi ei ole tiedossa.
pub fn voimassa_pohja(varasto: &Varasto, tiedosto: &str) -> Result<Option<Pohja>> {
    match vanhin_offset(varasto, tiedosto)? {
        None => Ok(None),
        Some(0) => Ok(Some(Pohja { offset: 0, rivi: 0 })),
        Some(o) => Ok(pohja(varasto, tiedosto)?.filter(|p| p.offset == o)),
    }
}

/// Tarvitaanko vertaiselta uusi pohja (vanhin paikallinen yksikkö > 0 eikä tallennettu pohja vastaa sitä)?
pub fn tarvitsee_pohjan(varasto: &Varasto, tiedosto: &str) -> Result<bool> {
    Ok(
        matches!(vanhin_offset(varasto, tiedosto)?, Some(o) if o > 0)
            && voimassa_pohja(varasto, tiedosto)?.is_none(),
    )
}

/// Tallentaa pohjan sisäiseen polkuun (suoraan varastoon, ei broadcast-ilmoitusta); sama arvo → ei kirjoitusta.
fn tallenna_pohja(tila: &Tila, tiedosto: &str, p: Pohja) -> Result<()> {
    let edellinen = tila.varasto.lue(POHJA_POLKU, tiedosto)?;
    if pohja(&tila.varasto, tiedosto)? == Some(p) {
        return Ok(());
    }
    let mut versio = edellinen
        .as_ref()
        .map(|y| y.versio.clone())
        .unwrap_or_default();
    *versio.entry(tila.laite.clone()).or_insert(0) += 1;
    let y = Yksikko {
        polku: POHJA_POLKU.to_string(),
        id: tiedosto.to_string(),
        versio,
        aika: Hlc::nyt(&tila.laite, edellinen.as_ref().map(|y| &y.aika), kello_ms()),
        sisalto: Some(
            serde_json::to_vec(&json!({"offset": p.offset, "rivi": p.rivi})).unwrap_or_default(),
        ),
        poistettu: false,
    };
    tila.varasto.kirjoita(&y, Yhdistaja::Lww)?;
    Ok(())
}

type Haku<T> = std::result::Result<T, String>;

fn asiakas() -> Haku<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(PYYNNON_AIKARAJA)
        .build()
        .map_err(|e| e.to_string())
}

/// Polun prosenttikoodaus; '/' ja RFC 3986 unreserved säilyvät (tiedostonimessä on hakemisto).
fn koodaa_polku(s: &str) -> String {
    let mut ulos = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            ulos.push(b as char);
        } else {
            ulos.push_str(&format!("%{b:02X}"));
        }
    }
    ulos
}

fn osoite(v: &Vertainen, polku: &str) -> String {
    format!("{}{polku}", v.osoite.trim_end_matches('/'))
}

async fn json_vastaus<T: DeserializeOwned>(v: &Vertainen, rb: reqwest::RequestBuilder) -> Haku<T> {
    let vastaus = rb
        .bearer_auth(&v.avain)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("{}: {e}", v.id))?;
    vastaus.json().await.map_err(|e| format!("{}: {e}", v.id))
}

/// S-9d/S-9e: ensimmäinen tavoitettava vertainen, jonka tiivistevastauksessa ei ole "ikkunoidut"-kenttää
/// (S-9b korjaus 1: ikkunoitu solmu ei ole peilin lähde).
async fn taysi_vertainen(tila: &Tila, http: &reqwest::Client) -> Haku<Vertainen> {
    for v in crate::vertaiset::vertaiset(tila) {
        match json_vastaus::<Value>(&v, http.get(osoite(&v, "/api/tiiviste"))).await {
            Ok(t) if t.get("ikkunoidut").is_none() => return Ok(v),
            Ok(_) => {}
            Err(e) => eprintln!("peili: vertainen {e}"),
        }
    }
    Err("ei tavoitettavaa täyttä vertaista".to_string())
}

async fn vertaisen_rivi(
    http: &reqwest::Client,
    v: &Vertainen,
    tiedosto: &str,
    alku: u64,
) -> Haku<u64> {
    let polku = format!("/api/peili/{}/rivi", koodaa_polku(tiedosto));
    let r: Value = json_vastaus(
        v,
        http.get(osoite(v, &polku))
            .query(&[("offset", alku.to_string())]),
    )
    .await?;
    r.get("rivi")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{}: virheellinen rivivastaus", v.id))
}

/// S-9d: varmistaa tiedoston vanhimman paikallisen yksikön pohjan; puuttuva tai vanhentunut haetaan täydeltä
/// vertaiselta ja tallennetaan. `None` = tiedostolla ei ole paikallisia yksiköitä.
pub async fn hae_pohja(tila: &Tila, tiedosto: &str) -> Haku<Option<Pohja>> {
    let v = &tila.varasto;
    let Some(vanhin) = vanhin_offset(v, tiedosto).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if let Some(p) = voimassa_pohja(v, tiedosto).map_err(|e| e.to_string())? {
        return Ok(Some(p));
    }
    let http = asiakas()?;
    let vertainen = taysi_vertainen(tila, &http).await?;
    let rivi = vertaisen_rivi(&http, &vertainen, tiedosto, vanhin).await?;
    let p = Pohja {
        offset: vanhin,
        rivi,
    };
    tallenna_pohja(tila, tiedosto, p).map_err(|e| e.to_string())?;
    Ok(Some(p))
}

/// S-9d (T-75): merkitsee pohjan hakuun yksiköiden tiedostot (tunnus `<tiedosto>:<offset>`). Vain ikkunoitu
/// solmu; `vertainen` = täysi vertainen, jolta yksiköt tulivat (`None` = ensimmäinen täysi vertainen).
pub fn merkitse_pohjaa_vailla<'a>(
    tila: &Tila,
    idt: impl IntoIterator<Item = &'a str>,
    vertainen: Option<&Vertainen>,
) {
    if tila.peili.ikkuna_vrk.is_none() {
        return;
    }
    let tiedostot: BTreeSet<&str> = idt
        .into_iter()
        .filter_map(|id| id.rsplit_once(':').map(|(t, _)| t))
        .collect();
    for t in tiedostot {
        tila.peili.merkitse_pohjaa_vailla(t, vertainen);
    }
}

/// S-9d (T-75), käynnistys: merkitsee pohjan hakuun kaikki tiedostot, joiden vanhin paikallinen offset > 0 eikä
/// voimassa olevaa pohjaa ole. Täysi solmu ei merkitse mitään. Palauttaa merkittyjen määrän.
pub fn merkitse_kaikki_pohjaa_vailla(tila: &Tila) -> Result<usize> {
    if tila.peili.ikkuna_vrk.is_none() {
        return Ok(0);
    }
    let mut vanhimmat: BTreeMap<String, u64> = BTreeMap::new();
    for y in tila.varasto.listaa_otsakkeet(POLKU)? {
        if y.poistettu {
            continue;
        }
        let Some((tiedosto, alku)) = y.id.rsplit_once(':') else {
            continue;
        };
        let Ok(alku) = alku.parse::<u64>() else {
            continue;
        };
        let e = vanhimmat.entry(tiedosto.to_string()).or_insert(alku);
        *e = (*e).min(alku);
    }
    let mut n = 0;
    for (tiedosto, vanhin) in vanhimmat {
        if vanhin > 0 && pohja(&tila.varasto, &tiedosto)?.is_none_or(|p| p.offset != vanhin) {
            tila.peili.merkitse_pohjaa_vailla(&tiedosto, None);
            n += 1;
        }
    }
    Ok(n)
}

/// Yhden pohjakierroksen tulos.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PohjaKierros {
    /// Tallennettujen pohjien määrä (> 0 → näkymät rakennetaan uudelleen).
    pub tallennettu: usize,
    /// Ensimmäinen virhe; kierros pysähtyi siihen eikä yritä uudelleen (seuraava kierros yrittää).
    pub virhe: Option<String>,
}

/// S-9d (T-75): hakee pohjat jonon enintään `POHJAKIERROS` ensimmäiselle tiedostolle, joilta puuttuu voimassa
/// oleva pohja (vanhin paikallinen offset > 0). Vertainen on se täysi vertainen, jolta tiedoston yksiköt tulivat,
/// muuten `taysi_vertainen`. Virhe pysäyttää kierroksen: epäonnistunut tiedosto jää jonon loppuun ja
/// käsittelemättömät alkuun, uusintaa ei yritetä saman kierroksen sisällä.
pub async fn hae_pohjakierros(tila: &Tila) -> PohjaKierros {
    let mut jono = tila.peili.ota_pohjaera();
    let mut tulos = PohjaKierros::default();
    let mut http: Option<reqwest::Client> = None;
    let mut taysi: Option<Vertainen> = None;
    while let Some((tiedosto, vihje)) = jono.pop_front() {
        let vanhin = match vanhin_offset(&tila.varasto, &tiedosto) {
            Ok(Some(o)) if o > 0 => o,
            _ => continue,
        };
        if matches!(voimassa_pohja(&tila.varasto, &tiedosto), Ok(Some(_))) {
            continue;
        }
        let yksi = async {
            let asiakas = match &http {
                Some(h) => h.clone(),
                None => {
                    let h = asiakas()?;
                    http = Some(h.clone());
                    h
                }
            };
            let vertainen = match (&vihje, &taysi) {
                (Some(v), _) | (None, Some(v)) => v.clone(),
                (None, None) => {
                    let v = taysi_vertainen(tila, &asiakas).await?;
                    taysi = Some(v.clone());
                    v
                }
            };
            let rivi = vertaisen_rivi(&asiakas, &vertainen, &tiedosto, vanhin).await?;
            tallenna_pohja(
                tila,
                &tiedosto,
                Pohja {
                    offset: vanhin,
                    rivi,
                },
            )
            .map_err(|e| e.to_string())
        };
        match yksi.await {
            Ok(()) => tulos.tallennettu += 1,
            Err(e) => {
                tulos.virhe = Some(format!("{tiedosto}: {e}"));
                tila.peili.palauta_pohjaera(jono, (tiedosto, vihje));
                return tulos;
            }
        }
    }
    tulos
}

#[derive(Deserialize)]
struct ListaRivi {
    id: String,
}

#[derive(Deserialize)]
struct Lista {
    yksikot: Vec<ListaRivi>,
}

#[derive(Deserialize)]
struct HaeVastaus {
    yksikot: Vec<Yksikko>,
    #[serde(default)]
    jatko: Vec<String>,
}

/// S-9e: hakee täydeltä vertaiselta tiedoston edeltävät yksiköt (offset < vanhin paikallinen) uusimmasta
/// alkaen, enintään `HAKU_TAVUT`; kirjoitus S-9a:n riisunnalla ikkunarajasta riippumatta, yksiköt 10 min
/// karsinnan suojaan ja pohja päivitetään. Pohja kirjoitetaan ennen yksiköitä, jotta viimeinen kirjoitus
/// herättää näkymän virran kautta. Palauttaa haettujen yksiköiden määrän.
pub async fn hae_edeltavat(tila: &Tila, tiedosto: &str) -> Haku<usize> {
    let Some(vanhin) = vanhin_offset(&tila.varasto, tiedosto).map_err(|e| e.to_string())? else {
        return Ok(0);
    };
    if vanhin == 0 {
        return Ok(0);
    }
    let http = asiakas()?;
    let v = taysi_vertainen(tila, &http).await?;
    let lista: Lista = json_vastaus(
        &v,
        http.get(osoite(&v, "/api/listat"))
            .query(&[("polku", POLKU)]),
    )
    .await?;
    let mut edeltavat: Vec<(u64, String)> = lista
        .yksikot
        .into_iter()
        .filter_map(|r| {
            let a = tiedoston_alku(&r.id, tiedosto)?;
            (a < vanhin).then_some((a, r.id))
        })
        .collect();
    edeltavat.sort_by_key(|a| std::cmp::Reverse(a.0));
    let mut jono: VecDeque<String> = edeltavat.into_iter().map(|(_, id)| id).collect();
    let mut saadut: Vec<Yksikko> = Vec::new();
    let mut tavut = 0u64;
    'haku: while !jono.is_empty() {
        let pyydetyt: Vec<String> = jono.iter().take(HAE_ERA).cloned().collect();
        let vastaus: HaeVastaus = json_vastaus(
            &v,
            http.post(osoite(&v, "/api/hae"))
                .json(&json!({"polku": POLKU, "idt": &pyydetyt})),
        )
        .await?;
        // Vertainen palvelee pyynnön alusta; `jatko` on palvelematon loppu.
        let palvellut = pyydetyt.len().saturating_sub(vastaus.jatko.len());
        for y in vastaus.yksikot {
            if y.polku != POLKU || y.poistettu || tiedoston_alku(&y.id, tiedosto).is_none() {
                continue;
            }
            let koko = y.sisalto.as_ref().map_or(0, |s| s.len() as u64);
            if !saadut.is_empty() && tavut + koko > HAKU_TAVUT {
                break 'haku;
            }
            tavut += koko;
            saadut.push(y);
        }
        if palvellut == 0 {
            break;
        }
        jono.drain(..palvellut.min(jono.len()));
    }
    let Some(alin) = saadut
        .iter()
        .filter_map(|y| tiedoston_alku(&y.id, tiedosto))
        .min()
    else {
        return Ok(0);
    };
    let rivi = vertaisen_rivi(&http, &v, tiedosto, alin).await?;
    tallenna_pohja(tila, tiedosto, Pohja { offset: alin, rivi }).map_err(|e| e.to_string())?;
    for y in &saadut {
        tila.peili.merkitse_haetuksi(&y.id);
    }
    for y in &saadut {
        // Sisältöaika lasketaan vertaiselta saaduista riisumattomista riveistä ennen riisuntaa (T-73).
        kirjoita_riisuttuna(tila, &riisuttu(y), yksikon_sisaltoaika(y))
            .map_err(|e| e.to_string())?;
    }
    Ok(saadut.len())
}

// ---- Raakarivit pyynnöstä (S-9f) -------------------------------------------------------------------------

/// S-9f: `maara` oletus ja yläraja.
const RAAKA_OLETUS: u64 = 50;
const RAAKA_MAX: u64 = 200;

/// S-9f: tiedoston alkuperäiset rivit (riisumatta) ja jatkokohta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Raaka {
    pub rivit: Vec<String>,
    /// Seuraavan palauttamatta jääneen rivin numero (Viesti.id:n rivinro, 1-pohjainen); `None` = tiedoston loppu.
    pub seuraava: Option<u64>,
}

/// Tiedoston yksiköt (alku, rivien määrä) offset-järjestyksessä; SQL (`json_array_length`) kuten `rivi`:
/// rivejä ei ladata. Ei yksiköitä = tuntematon tiedosto. Myös täyden solmun näkymä hännästä (T-76).
pub fn yksikoiden_rivimaarat(varasto: &Varasto, tiedosto: &str) -> Result<Vec<(u64, u64)>> {
    let data = varasto
        .data()
        .ok_or_else(|| muunnosvirhe("varaston hakemisto puuttuu".to_string()))?;
    let c = Connection::open_with_flags(
        data.join("ydin.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    c.busy_timeout(Duration::from_secs(5))?;
    let mut kysely = c.prepare(
        "SELECT id, COALESCE(json_array_length(CAST(sisalto AS TEXT)), 0) FROM yksikot \
         WHERE polku = ?1 AND id >= ?2 AND id < ?3 AND poistettu = 0",
    )?;
    let mut rivit = kysely.query(params![
        POLKU,
        format!("{tiedosto}:"),
        format!("{tiedosto};")
    ])?;
    let mut ulos = Vec::new();
    while let Some(r) = rivit.next()? {
        let id: String = r.get(0)?;
        let n: i64 = r.get(1)?;
        if let Some(a) = tiedoston_alku(&id, tiedosto) {
            ulos.push((a, n.max(0) as u64));
        }
    }
    ulos.sort();
    Ok(ulos)
}

/// S-9f: tiedoston rivit `rivi`…`rivi+maara-1` (1-pohjainen numerointi kuten Viesti.id) riisumatta.
/// Vain rivejä peittävät yksiköt luetaan. Vastaus enintään `HAKU_TAVUT`: rivejä lisätään, kunnes seuraava
/// ylittäisi rajan (vähintään yksi rivi), ja `seuraava` kertoo jatkokohdan. `None` = tuntematon tiedosto.
pub fn raaka(varasto: &Varasto, tiedosto: &str, rivi: u64, maara: u64) -> Result<Option<Raaka>> {
    let yksikot = yksikoiden_rivimaarat(varasto, tiedosto)?;
    if yksikot.is_empty() {
        return Ok(None);
    }
    let kaikki: u64 = yksikot.iter().map(|(_, n)| n).sum();
    let alku = rivi.saturating_sub(1);
    let loppu = alku.saturating_add(maara);
    let mut rivit: Vec<String> = Vec::new();
    let mut tavut = 0u64;
    let mut seuraava = (loppu < kaikki).then(|| loppu + 1);
    let mut c = 0u64;
    'yksikot: for (a, n) in yksikot {
        let (y_alku, y_loppu) = (c, c + n);
        c = y_loppu;
        if y_loppu <= alku {
            continue;
        }
        if y_alku >= loppu {
            break;
        }
        let Some(y) = varasto
            .lue(POLKU, &format!("{tiedosto}:{a}"))?
            .filter(|y| !y.poistettu)
        else {
            continue;
        };
        let taulukko: Vec<String> = y
            .sisalto
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|e| muunnosvirhe(e.to_string()))?
            .unwrap_or_default();
        for (i, r) in taulukko.into_iter().enumerate() {
            let nro = y_alku + i as u64;
            if nro < alku {
                continue;
            }
            if nro >= loppu {
                break 'yksikot;
            }
            if !rivit.is_empty() && tavut + r.len() as u64 > HAKU_TAVUT {
                seuraava = Some(nro + 1);
                break 'yksikot;
            }
            tavut += r.len() as u64;
            rivit.push(r);
        }
    }
    Ok(Some(Raaka { rivit, seuraava }))
}

/// S-9f: ikkunoitu solmu välittää pyynnön täydelle vertaiselle ja palauttaa vastauksen sellaisenaan;
/// ei kirjoita varastoon eikä tuota tapahtumaa.
async fn valita_raaka(t: &Tila, tiedosto: &str, q: &HashMap<String, String>) -> Haku<(u16, Bytes)> {
    let http = asiakas()?;
    let v = taysi_vertainen(t, &http).await?;
    let polku = format!("/api/peili/{}/raaka", koodaa_polku(tiedosto));
    let kysely: Vec<(&str, &str)> = ["rivi", "maara"]
        .into_iter()
        .filter_map(|k| q.get(k).map(|a| (k, a.as_str())))
        .collect();
    let vastaus = http
        .get(osoite(&v, &polku))
        .query(&kysely)
        .bearer_auth(&v.avain)
        .send()
        .await
        .map_err(|e| format!("{}: {e}", v.id))?;
    let koodi = vastaus.status().as_u16();
    let runko = vastaus
        .bytes()
        .await
        .map_err(|e| format!("{}: {e}", v.id))?;
    Ok((koodi, runko))
}

async fn raaka_reitti(t: Arc<Tila>, tiedosto: String, q: &HashMap<String, String>) -> Response {
    if t.peili.ikkuna_vrk.is_some() {
        return match valita_raaka(&t, &tiedosto, q).await {
            Ok((koodi, runko)) => (
                StatusCode::from_u16(koodi).unwrap_or(StatusCode::BAD_GATEWAY),
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                runko,
            )
                .into_response(),
            Err(e) => {
                eprintln!("peili: raakarivit: {e}");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"haettavissa": true})),
                )
                    .into_response()
            }
        };
    }
    let Some(rivi) = q
        .get("rivi")
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n >= 1)
    else {
        return virhe(StatusCode::BAD_REQUEST, "rivi puuttuu tai ei ole >= 1");
    };
    let maara = match q.get("maara") {
        None => RAAKA_OLETUS,
        Some(s) => match s.parse::<u64>() {
            Ok(m) if (1..=RAAKA_MAX).contains(&m) => m,
            _ => return virhe(StatusCode::BAD_REQUEST, "maara ei ole 1...200"),
        },
    };
    let tulos =
        tokio::task::spawn_blocking(move || raaka(&t.varasto, &tiedosto, rivi, maara)).await;
    match tulos {
        Ok(Ok(Some(r))) => {
            Json(json!({"rivi": rivi, "rivit": r.rivit, "seuraava": r.seuraava})).into_response()
        }
        Ok(Ok(None)) => virhe(StatusCode::NOT_FOUND, "tuntematon tiedosto"),
        Ok(Err(e)) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}
