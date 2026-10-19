//! Yksikkömalli, HLC-aikaleima ja yhdistäjät (SUUNNITELMA.md §3.2).
//!
//! Semantiikka on siirretty `scopes/localregister/lr.mjs`:stä; jokaisen funktion kohdalla on vastaava
//! lr.mjs-rivi. Rekisterien rivitason tuonti (pilkonta, järjestysavaimet, uudelleentuonti, vastaanotto,
//! siivous ja vienti) on moduulin alaosassa `rekisteri`-alimoduulissa samoilla funktionimillä.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// Versiovektori `{laite: laskuri}` (lr.mjs:146-147, MUOTO §3).
pub type Versio = BTreeMap<String, u64>;

// ---- HLC ---------------------------------------------------------------------------------------------

/// Hybridi looginen kello. Järjestys: millisekunnit, laskuri, laite (tasapeli ratkeaa laite-id:llä).
/// Tekstimuoto `2026-10-19T07:40:00.000Z-0003-oneplus`: ISO-aika UTC:nä, laskuri neljänä
/// heksanumerona (u16 mahtuu kiinteään leveyteen, joten tekstijärjestys = aikajärjestys) ja laite.
/// Uusi kenttä ytimessä; lr.mjs käyttää `muutettu`-kentässä ISO-aikaa (lr.mjs:151).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Hlc {
    pub ms: u64,
    pub laskuri: u16,
    pub laite: String,
}

const PAIVA_MS: u64 = 86_400_000;

// Päivien määrä 1970-01-01:stä (H. Hinnantin days_from_civil).
fn paivat_alusta(v: i64, k: i64, p: i64) -> i64 {
    let v = if k <= 2 { v - 1 } else { v };
    let aikakausi = v.div_euclid(400);
    let vuosi = v - aikakausi * 400;
    let kp = (k + 9) % 12;
    let vp = (153 * kp + 2) / 5 + p - 1;
    let ap = vuosi * 365 + vuosi / 4 - vuosi / 100 + vp;
    aikakausi * 146_097 + ap - 719_468
}

// Päivämäärä päivien määrästä (H. Hinnantin civil_from_days); z ≥ 0.
fn paivamaara(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let aikakausi = z.div_euclid(146_097);
    let ap = z - aikakausi * 146_097;
    let vuosi = (ap - ap / 1460 + ap / 36_524 - ap / 146_096) / 365;
    let vp = ap - (365 * vuosi + vuosi / 4 - vuosi / 100);
    let kp = (5 * vp + 2) / 153;
    let p = vp - (153 * kp + 2) / 5 + 1;
    let k = if kp < 10 { kp + 3 } else { kp - 9 };
    let v = vuosi + aikakausi * 400;
    (if k <= 2 { v + 1 } else { v }, k, p)
}

fn numero(s: Option<&str>) -> Option<u64> {
    let s = s?;
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

impl Hlc {
    /// Seuraava aikaleima: kello, jos se on edellistä edellä; muuten edellisen ms ja laskuri + 1
    /// (laskurin ylivuoto siirtää millisekuntia). Korvaa lr.mjs:n `muutettu: nyt` -seinäkellon (lr.mjs:151).
    pub fn nyt(laite: &str, edellinen: Option<&Hlc>, kello_ms: u64) -> Hlc {
        match edellinen {
            Some(e) if e.ms >= kello_ms => {
                if e.laskuri == u16::MAX {
                    Hlc {
                        ms: e.ms + 1,
                        laskuri: 0,
                        laite: laite.to_string(),
                    }
                } else {
                    Hlc {
                        ms: e.ms,
                        laskuri: e.laskuri + 1,
                        laite: laite.to_string(),
                    }
                }
            }
            _ => Hlc {
                ms: kello_ms,
                laskuri: 0,
                laite: laite.to_string(),
            },
        }
    }

    /// Tekstimuodon jäsennys; hyväksyy vain muodon, jonka `to_string` tuottaa (edestakaisin sama).
    pub fn parse(s: &str) -> Option<Hlc> {
        if s.get(24..25)? != "-" || s.get(29..30)? != "-" {
            return None;
        }
        let laite = s.get(30..)?;
        let v = numero(s.get(0..4))? as i64;
        let k = numero(s.get(5..7))? as i64;
        let p = numero(s.get(8..10))? as i64;
        let t = numero(s.get(11..13))?;
        let m = numero(s.get(14..16))?;
        let sek = numero(s.get(17..19))?;
        let milli = numero(s.get(20..23))?;
        if laite.is_empty() || v < 1970 || !(1..=12).contains(&k) || !(1..=31).contains(&p) {
            return None;
        }
        let laskuri = u16::from_str_radix(s.get(25..29)?, 16).ok()?;
        let paivat = u64::try_from(paivat_alusta(v, k, p)).ok()?;
        let ms = paivat * PAIVA_MS + ((t * 60 + m) * 60 + sek) * 1000 + milli;
        let hlc = Hlc {
            ms,
            laskuri,
            laite: laite.to_string(),
        };
        (hlc.to_string() == s).then_some(hlc)
    }
}

/// `to_string` (Contract) tulee tästä: `2026-10-19T07:40:00.000Z-0003-oneplus`.
impl fmt::Display for Hlc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (v, k, p) = paivamaara((self.ms / PAIVA_MS) as i64);
        let paivassa = self.ms % PAIVA_MS;
        write!(
            f,
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z-{:04x}-{}",
            v,
            k,
            p,
            paivassa / 3_600_000,
            paivassa / 60_000 % 60,
            paivassa / 1000 % 60,
            paivassa % 1000,
            self.laskuri,
            self.laite
        )
    }
}

// ---- Yksikkö ja yhdistäjät -------------------------------------------------------------------------

/// Yksi yksikkömalli kaikille lajeille (SUUNNITELMA.md §3.2; LR:n yksikkö lr.mjs:145-155 yleistettynä:
/// `rekisteri` → `polku`, `muutettu` → `aika`, `poistettu` = hautakivi).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Yksikko {
    pub polku: String,
    pub id: String,
    pub versio: BTreeMap<String, u64>,
    pub aika: Hlc,
    pub sisalto: Option<Vec<u8>>,
    pub poistettu: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Yhdistaja {
    Lr,
    Lww,
    Lisays,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vertailu {
    Sama,
    Uudempi,
    Vanhempi,
    Rinnakkainen,
}

/// Versiovektorien vertailu (lr.mjs:135-144): `Uudempi` = a > b, `Rinnakkainen` = kumpikin edellä jossain.
pub fn vertaa(a: &BTreeMap<String, u64>, b: &BTreeMap<String, u64>) -> Vertailu {
    let mut suurempi = false;
    let mut pienempi = false;
    for k in a.keys().chain(b.keys()) {
        let x = a.get(k).copied().unwrap_or(0);
        let y = b.get(k).copied().unwrap_or(0);
        suurempi |= x > y;
        pienempi |= x < y;
    }
    match (suurempi, pienempi) {
        (true, true) => Vertailu::Rinnakkainen,
        (true, false) => Vertailu::Uudempi,
        (false, true) => Vertailu::Vanhempi,
        (false, false) => Vertailu::Sama,
    }
}

#[derive(Debug, PartialEq)]
pub enum Tulos {
    Yksi(Yksikko),
    Rinnakkaiset(Vec<Yksikko>),
}

/// Yhdistää saapuvan yksikön nykyiseen.
/// - `Lr` (lr.mjs:430-447, `vastaanota`): uudempi saapuva korvaa, vanhempi ja sama ohitetaan,
///   rinnakkainen palauttaa molemmat (käyttäjä ratkaisee, K4).
/// - `Lww`: suurempi HLC voittaa; saman ajan tasapeli ratkeaa suuremmalla laite-id:llä.
/// - `Lisays`: olemassa olevaa ei korvata.
pub fn yhdista(nykyinen: Option<&Yksikko>, saapuva: &Yksikko, y: Yhdistaja) -> Tulos {
    let Some(nyk) = nykyinen else {
        return Tulos::Yksi(saapuva.clone());
    };
    match y {
        Yhdistaja::Lr => match vertaa(&saapuva.versio, &nyk.versio) {
            Vertailu::Uudempi => Tulos::Yksi(saapuva.clone()),
            Vertailu::Vanhempi | Vertailu::Sama => Tulos::Yksi(nyk.clone()),
            Vertailu::Rinnakkainen => Tulos::Rinnakkaiset(vec![nyk.clone(), saapuva.clone()]),
        },
        Yhdistaja::Lww => {
            let a = (saapuva.aika.ms, saapuva.aika.laskuri, &saapuva.aika.laite);
            let b = (nyk.aika.ms, nyk.aika.laskuri, &nyk.aika.laite);
            Tulos::Yksi(if a > b { saapuva.clone() } else { nyk.clone() })
        }
        Yhdistaja::Lisays => Tulos::Yksi(nyk.clone()),
    }
}

/// Lajikohtainen yhdistäjä polun ensimmäisestä osasta (SUUNNITELMA.md §3.2).
pub fn yhdistaja_polulle(polku: &str) -> Yhdistaja {
    let laji = polku.split('/').next().unwrap_or("");
    if !polku.contains('/') {
        return Yhdistaja::Lisays;
    }
    match laji {
        "rekisterit" => Yhdistaja::Lr,
        // rekisterit-meta: metan ja rivien lisäkenttien uusin versio korvaa vanhan (R-1).
        "tila" | "asetukset" | "lahde" | "rekisterit-meta" => Yhdistaja::Lww,
        _ => Yhdistaja::Lisays,
    }
}

/// Yksikön yhdistäjä: rekisterin sisarusyksikkö (`rekisterit/<p>`, id sisältää `~`) yhdistetään
/// Lww:llä, jotta rinnakkaiset sisarversiot konvergoituvat samaan `<id>~<laite>`-yksikköön eikä
/// sisaruksen sisaruksia synny (R-2). Muut yksiköt yhdistetään polun mukaan.
pub fn yhdistaja_yksikolle(y: &Yksikko) -> Yhdistaja {
    if y.polku.starts_with("rekisterit/") && y.id.contains('~') {
        return Yhdistaja::Lww;
    }
    yhdistaja_polulle(&y.polku)
}

// ---- Rekisterin rivitason tuonti ---------------------------------------------------------------------

/// LR-rekisterien kaksoiskappale riviyksiköinä (lr.mjs). Varasto on muistissa; tiedostohakemisto
/// (`rekisterit/<polku>/<id>.json`) kuuluu varastokerrokselle.
pub mod rekisteri {
    use super::{vertaa, Hlc, Versio, Vertailu, Yksikko};
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    use std::fmt;

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Virhe(pub String);

    impl fmt::Display for Virhe {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(&self.0)
        }
    }

    impl std::error::Error for Virhe {}

    fn virhe<T>(s: String) -> Result<T, Virhe> {
        Err(Virhe(s))
    }

    // ---- Järjestysavaimet (lr.mjs:26-50, MUOTO §2) ----------------------------------------------------

    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

    fn d_indeksi(c: u8) -> i64 {
        D.iter().position(|&x| x == c).map_or(-1, |i| i as i64)
    }

    /// Avain a < k < b leksikografisesti; a = "" alku, b = None loppu (lr.mjs:31-43).
    pub fn valiin(a: &str, b: Option<&str>) -> Result<String, Virhe> {
        if let Some(b) = b {
            if a >= b {
                return virhe(format!("valiin: {a} >= {b}"));
            }
        }
        let kelpo = |s: &str| s.bytes().all(|c| d_indeksi(c) >= 0);
        if !kelpo(a) || !b.is_none_or(kelpo) {
            return virhe(format!("valiin: virheellinen avain {a} / {b:?}"));
        }
        let ab = a.as_bytes();
        if let Some(b) = b {
            let bb = b.as_bytes();
            let mut n = 0;
            while n < bb.len() && *ab.get(n).unwrap_or(&b'0') == bb[n] {
                n += 1;
            }
            if n > 0 {
                let loppu = valiin(a.get(n..).unwrap_or(""), Some(&b[n..]))?;
                return Ok(format!("{}{}", &b[..n], loppu));
            }
        }
        let da = ab.first().map_or(0, |&c| d_indeksi(c));
        let db = match b {
            Some(b) => b.bytes().next().map_or(-1, d_indeksi),
            None => D.len() as i64,
        };
        if db - da > 1 {
            return Ok((D[((da + db + 1) / 2) as usize] as char).to_string());
        }
        if let Some(b) = b {
            if b.len() > 1 {
                return Ok(b[..1].to_string());
            }
        }
        Ok(format!(
            "{}{}",
            D[da as usize] as char,
            valiin(a.get(1..).unwrap_or(""), None)?
        ))
    }

    /// n tasavälistä avainta tyhjään rekisteriin; kiinteä leveys, perässä olevat nollat pois (lr.mjs:46-51).
    pub fn avaimet(n: usize) -> Vec<String> {
        let lev = 2.max(((n as f64 + 2.0).ln() / 36f64.ln()).ceil() as u32 + 1);
        let tila = 36u128.pow(lev);
        (0..n)
            .map(|i| {
                let mut x = (i as u128 + 1) * tila / (n as u128 + 1);
                let mut s = vec![b'0'; lev as usize];
                for paikka in s.iter_mut().rev() {
                    *paikka = D[(x % 36) as usize];
                    x /= 36;
                }
                String::from_utf8_lossy(&s)
                    .trim_end_matches('0')
                    .to_string()
            })
            .collect()
    }

    // ---- Pilkonta (lr.mjs:53-104, MUOTO §1: yksikkö = rivi) -------------------------------------------

    /// Pilkonnan osa: laji, osio ja raaka teksti perässä olevine tyhjine riveineen.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Osa {
        pub laji: String,
        pub osio: String,
        pub sisalto: String,
    }

    // JavaScriptin \s (lr.mjs:56-58 säännölliset lausekkeet).
    fn js_ws(c: char) -> bool {
        (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
    }

    fn tyhja(r: &str) -> bool {
        r.chars().all(js_ws)
    }

    fn kolme_valia(r: &str) -> &str {
        let mut t = r;
        for _ in 0..3 {
            match t.strip_prefix(' ') {
                Some(x) => t = x,
                None => break,
            }
        }
        t
    }

    // LISTA = /^ {0,3}([-*+]|\d+[.)])\s/
    fn lista(r: &str) -> bool {
        let t = kolme_valia(r);
        let loput = match t.strip_prefix(|c| matches!(c, '-' | '*' | '+')) {
            Some(x) => x,
            None => {
                let numerot = t.len() - t.trim_start_matches(|c: char| c.is_ascii_digit()).len();
                if numerot == 0 {
                    return false;
                }
                match t[numerot..].strip_prefix(|c| matches!(c, '.' | ')')) {
                    Some(x) => x,
                    None => return false,
                }
            }
        };
        loput.chars().next().is_some_and(js_ws)
    }

    // OTSIKKO = /^#{1,6}\s/ (vahvin = 1) ja osio-otsikko /^#{2,6}\s/ (vahvin = 2).
    fn otsikko(r: &str, vahvin: usize) -> bool {
        let n = r.len() - r.trim_start_matches('#').len();
        (vahvin..=6).contains(&n) && r[n..].chars().next().is_some_and(js_ws)
    }

    // AITA = /^ {0,3}(```|~~~)/
    fn aita(r: &str) -> bool {
        let t = kolme_valia(r);
        t.starts_with("```") || t.starts_with("~~~")
    }

    // /^\|\s*:?-{2,}/
    fn erotinrivi(r: &str) -> bool {
        let Some(t) = r.strip_prefix('|') else {
            return false;
        };
        let t = t.trim_start_matches(js_ws);
        let t = t.strip_prefix(':').unwrap_or(t);
        t.starts_with("--")
    }

    fn osiolaji(osio: &str) -> Option<&'static str> {
        match osio {
            "Päätökset" => Some("paatos"),
            "Avoimet asiat" => Some("avoin"),
            "Viat" => Some("vika"),
            "Tarkoitus ja raja" => Some("tarkoitus"),
            _ => None,
        }
    }

    fn alkaa_lohkon(r: &str) -> bool {
        otsikko(r, 1) || aita(r) || r.starts_with('|') || lista(r) || tyhja(r)
    }

    /// Rivitasoinen, häviötön pilkonta: osien `sisalto`-kenttien liitos on täsmälleen teksti (lr.mjs:61-104).
    pub fn pilko(teksti: &str) -> Vec<Osa> {
        let rivit: Vec<&str> = teksti.split_inclusive('\n').collect();
        let mut osat = Vec::new();
        let mut osio = String::new();
        let mut i = 0;
        let lisaa = |osat: &mut Vec<Osa>, laji: &str, osio: &str, alku: usize, loppu: usize| {
            let mut loppu = loppu;
            while loppu < rivit.len() && tyhja(rivit[loppu]) {
                loppu += 1;
            }
            osat.push(Osa {
                laji: laji.to_string(),
                osio: osio.to_string(),
                sisalto: rivit[alku..loppu].concat(),
            });
            loppu
        };
        while i < rivit.len() {
            let r = rivit[i];
            if tyhja(r) {
                i = lisaa(&mut osat, "tyhja", &osio, i, i + 1);
                continue;
            }
            if aita(r) {
                let trimmattu = r.trim_matches(js_ws);
                let merkki: String = trimmattu.chars().take(3).collect();
                let mut j = i + 1;
                while j < rivit.len() && !rivit[j].trim_matches(js_ws).starts_with(&merkki) {
                    j += 1;
                }
                i = lisaa(&mut osat, "koodi", &osio, i, (j + 1).min(rivit.len()));
                continue;
            }
            if otsikko(r, 1) {
                if otsikko(r, 2) {
                    osio = r
                        .trim_start_matches('#')
                        .trim_start_matches(js_ws)
                        .trim_matches(js_ws)
                        .to_string();
                }
                let laji = if r.starts_with("# ") {
                    "otsikko"
                } else {
                    "osio"
                };
                i = lisaa(&mut osat, laji, &osio, i, i + 1);
                continue;
            }
            if r.starts_with("SEURAAVA PAKETTI") {
                i = lisaa(&mut osat, "seuraava", &osio, i, i + 1);
                continue;
            }
            if r.starts_with("Tilanne:") {
                i = lisaa(&mut osat, "tilanne", &osio, i, i + 1);
                continue;
            }
            if r.starts_with('|') {
                if i + 1 < rivit.len() && erotinrivi(rivit[i + 1]) {
                    i = lisaa(&mut osat, "taulukko-otsake", &osio, i, i + 2);
                    continue;
                }
                let laji = osiolaji(&osio).unwrap_or("taulukkorivi");
                i = lisaa(&mut osat, laji, &osio, i, i + 1);
                continue;
            }
            if lista(r) {
                let mut j = i + 1;
                while j < rivit.len()
                    && !tyhja(rivit[j])
                    && (rivit[j].starts_with(js_ws) || !alkaa_lohkon(rivit[j]))
                {
                    j += 1;
                }
                let laji = osiolaji(&osio).unwrap_or("alkio");
                i = lisaa(&mut osat, laji, &osio, i, j);
                continue;
            }
            let mut j = i + 1;
            while j < rivit.len()
                && !alkaa_lohkon(rivit[j])
                && !rivit[j].starts_with("SEURAAVA PAKETTI")
            {
                j += 1;
            }
            let laji = if osio == "Tarkoitus ja raja" {
                "tarkoitus"
            } else {
                "kappale"
            };
            i = lisaa(&mut osat, laji, &osio, i, j);
        }
        osat
    }

    // ---- Yksiköt ja varasto (lr.mjs:106-133) ----------------------------------------------------------

    /// Rinnakkainen versio (ristiriita, K4; lr.mjs:229, 440).
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    pub struct Sisar {
        pub sisalto: String,
        pub poistettu: bool,
        pub versio: Versio,
        pub muutettu: Option<String>,
        pub muuttaja: Option<String>,
    }

    /// Rekisterin riviyksikkö (lr.mjs:145-155): `lahde_sisalto`/`lahde_versio` ovat gitin puoli
    /// (None = ei gitissä).
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Rivi {
        pub id: String,
        pub rekisteri: String,
        pub laji: String,
        pub osio: String,
        pub jarjestys: String,
        pub sisalto: String,
        pub versio: Versio,
        pub muutettu: Option<String>,
        pub muuttaja: Option<String>,
        pub poistettu: bool,
        pub lahde_sisalto: Option<String>,
        pub lahde_versio: Option<Versio>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub rinnakkaiset: Vec<Sisar>,
    }

    impl Rivi {
        /// Riviyksikkö yleisenä yksikkönä (SUUNNITELMA.md §3.2): polku `rekisterit/<rekisteri>`.
        pub fn yksikko(&self, aika: Hlc) -> Yksikko {
            Yksikko {
                polku: format!("rekisterit/{}", self.rekisteri),
                id: self.id.clone(),
                versio: self.versio.clone(),
                aika,
                sisalto: Some(self.sisalto.clone().into_bytes()),
                poistettu: self.poistettu,
            }
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Lahde {
        pub commit: String,
        pub sha256: String,
    }

    /// Rekisterin `_meta.json` (lr.mjs:166-169).
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Meta {
        pub rekisteri: String,
        pub versio: Versio,
        pub poistettu: bool,
        pub lahde: Option<Lahde>,
    }

    #[derive(Clone, Debug, PartialEq)]
    pub struct Rekisteri {
        pub meta: Meta,
        pub rivit: BTreeMap<String, Rivi>,
        pub siivotut: BTreeMap<String, Versio>,
    }

    /// Laitteen nimi ja laskuri (lr.mjs:123-133, `luoLaite`).
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Laite {
        pub nimi: String,
        pub laskuri: u64,
    }

    impl Laite {
        pub fn uusi(nimi: &str) -> Laite {
            Laite {
                nimi: nimi.to_string(),
                laskuri: 0,
            }
        }

        pub fn seuraava(&mut self) -> u64 {
            self.laskuri += 1;
            self.laskuri
        }
    }

    /// Kaikki rekisterit polun mukaan (lr.mjs:368-377 `rekisterit` = avainten järjestys).
    #[derive(Clone, Debug, Default, PartialEq)]
    pub struct Varasto {
        pub rekisterit: BTreeMap<String, Rekisteri>,
    }

    /// Rekisteritiedosto: REKISTERI.md, HISTORIA.md tai ARKISTO.md (lr.mjs:22).
    pub fn rekisteritiedosto(p: &str) -> bool {
        let nimi = p.rsplit('/').next().unwrap_or(p);
        matches!(nimi, "REKISTERI.md" | "HISTORIA.md" | "ARKISTO.md")
    }

    /// Asiakkaan antama rekisteripolku: vain rekisteritiedostot, ei '..'-osia eikä absoluuttista polkua
    /// (lr.mjs:114).
    pub fn kelpo_polku(p: &str) -> bool {
        rekisteritiedosto(p)
            && !p.starts_with('/')
            && !p.split('/').any(|o| o == ".." || o == "." || o.is_empty())
    }

    fn tarkista_polku(p: &str) -> Result<&str, Virhe> {
        if kelpo_polku(p) {
            Ok(p)
        } else {
            virhe(format!("virheellinen rekisteripolku: {p}"))
        }
    }

    // /^[a-z0-9]+-\d+$/ (lr.mjs:425, 457)
    fn kelpo_tunnus(id: &str) -> bool {
        id.split_once('-').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                && b.bytes().all(|c| c.is_ascii_digit())
        })
    }

    fn sha(s: &str) -> String {
        Sha256::digest(s.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    // lr.mjs:116
    fn vektori(v: &Versio) -> String {
        v.iter()
            .map(|(k, n)| format!("{k}={n}"))
            .collect::<Vec<_>>()
            .join(",")
    }

    // lr.mjs:112, `jarjestyksessa`
    fn jarjestyksessa(mut ys: Vec<Rivi>) -> Vec<Rivi> {
        ys.sort_by(|a, b| a.jarjestys.cmp(&b.jarjestys).then(a.id.cmp(&b.id)));
        ys
    }

    // lr.mjs:172-176, `yhdista`
    fn yhdista_versiot(a: &Versio, b: &Versio) -> Versio {
        let mut v = a.clone();
        for (k, n) in b {
            let x = v.entry(k.clone()).or_insert(0);
            *x = (*x).max(*n);
        }
        v
    }

    // lr.mjs:145-155, `uusiYksikko`
    fn uusi_yksikko(laite: &mut Laite, polku: &str, o: &Osa, jarjestys: &str, nyt: &str) -> Rivi {
        let n = laite.seuraava();
        let versio: Versio = [(laite.nimi.clone(), n)].into_iter().collect();
        Rivi {
            id: format!("{}-{:06}", laite.nimi, n),
            rekisteri: polku.to_string(),
            laji: o.laji.clone(),
            osio: o.osio.clone(),
            jarjestys: jarjestys.to_string(),
            sisalto: o.sisalto.clone(),
            versio: versio.clone(),
            muutettu: Some(nyt.to_string()),
            muuttaja: Some(laite.nimi.clone()),
            poistettu: false,
            lahde_sisalto: Some(o.sisalto.clone()),
            lahde_versio: Some(versio),
            rinnakkaiset: Vec::new(),
        }
    }

    // ---- Uudelleentuonnin paritus (lr.mjs:178-199, 252-290) -------------------------------------------

    const KERTAOSA: [&str; 3] = ["otsikko", "tilanne", "seuraava"];

    fn eka_solu(s: &str) -> Option<&str> {
        s.starts_with('|')
            .then(|| s.split('|').nth(1).unwrap_or("").trim_matches(js_ws))
    }

    fn tiivis(s: &str) -> Vec<u16> {
        let pieni = s.to_lowercase();
        let mut ulos = String::new();
        let mut valissa = false;
        for c in pieni.chars() {
            if js_ws(c) {
                valissa = true;
            } else {
                if valissa {
                    ulos.push(' ');
                }
                valissa = false;
                ulos.push(c);
            }
        }
        if valissa {
            ulos.push(' ');
        }
        ulos.trim_matches(js_ws).encode_utf16().collect()
    }

    fn merkkiparit(t: &[u16]) -> (HashMap<(u16, u16), u32>, usize) {
        let mut m = HashMap::new();
        for w in t.windows(2) {
            *m.entry((w[0], w[1])).or_insert(0) += 1;
        }
        (m, t.len().saturating_sub(1))
    }

    // Onko gitin uusi osa saman yksikön muokkaus (lr.mjs:178-199, `samankaltainen`).
    fn samankaltainen(vanha: &Rivi, uusi: &Osa) -> bool {
        let vl = vanha.lahde_sisalto.as_deref().unwrap_or("");
        let (a, b) = (eka_solu(vl), eka_solu(&uusi.sisalto));
        if a.is_some() || b.is_some() {
            return a == b;
        }
        if vanha.laji == uusi.laji && KERTAOSA.contains(&uusi.laji.as_str()) {
            return true;
        }
        let (ta, tb) = (tiivis(vl), tiivis(&uusi.sisalto));
        let (lyh, pit) = if ta.len() <= tb.len() {
            (&ta, &tb)
        } else {
            (&tb, &ta)
        };
        if lyh == pit || (lyh.len() >= 5 && pit.starts_with(lyh)) {
            return true;
        }
        let ((ma, na), (mb, nb)) = (merkkiparit(&ta), merkkiparit(&tb));
        let yht: u32 = ma
            .iter()
            .map(|(g, c)| (*c).min(mb.get(g).copied().unwrap_or(0)))
            .sum();
        (2.0 * yht as f64) / ((na + nb) as f64) >= 0.5
    }

    type Pari = (Option<usize>, Option<usize>);

    // Osumattoman välin vanhat ja uudet paritetaan järjestyksessä vain samankaltaisina (lr.mjs:261-273).
    fn tyhjenna(
        ov: &mut Vec<usize>,
        ou: &mut Vec<usize>,
        parit: &mut Vec<Pari>,
        vanhat: &[Rivi],
        uudet: &[Osa],
    ) {
        let (pp, qq) = (ov.len(), ou.len());
        let lik: Vec<Vec<bool>> = ov
            .iter()
            .map(|&v| {
                ou.iter()
                    .map(|&u| samankaltainen(&vanhat[v], &uudet[u]))
                    .collect()
            })
            .collect();
        let mut s = vec![vec![0u32; qq + 1]; pp + 1];
        for p in (0..pp).rev() {
            for q in (0..qq).rev() {
                let osuma = if lik[p][q] { s[p + 1][q + 1] + 1 } else { 0 };
                s[p][q] = osuma.max(s[p + 1][q]).max(s[p][q + 1]);
            }
        }
        let (mut p, mut q) = (0, 0);
        while p < pp || q < qq {
            if p < pp && q < qq && lik[p][q] && s[p][q] == s[p + 1][q + 1] + 1 {
                parit.push((Some(ov[p]), Some(ou[q])));
                p += 1;
                q += 1;
            } else if q >= qq || (p < pp && s[p + 1][q] >= s[p][q + 1]) {
                parit.push((Some(ov[p]), None));
                p += 1;
            } else {
                parit.push((None, Some(ou[q])));
                q += 1;
            }
        }
        ov.clear();
        ou.clear();
    }

    // LCS gitin edellisen sisällön mukaan; yhteinen alku ja loppu ensin (lr.mjs:243-283).
    fn parita(vanhat: &[Rivi], uudet: &[Osa]) -> Vec<Pari> {
        let (n, m) = (vanhat.len(), uudet.len());
        let sama =
            |i: usize, j: usize| vanhat[i].lahde_sisalto.as_deref() == Some(&uudet[j].sisalto);
        let mut a = 0;
        while a < n && a < m && sama(a, a) {
            a += 1;
        }
        let mut b = 0;
        while b < n - a && b < m - a && sama(n - 1 - b, m - 1 - b) {
            b += 1;
        }
        let (nn, mm) = (n - a - b, m - a - b);
        let mut l = vec![vec![0u32; mm + 1]; nn + 1];
        for i in (0..nn).rev() {
            for j in (0..mm).rev() {
                l[i][j] = if sama(a + i, a + j) {
                    l[i + 1][j + 1] + 1
                } else {
                    l[i + 1][j].max(l[i][j + 1])
                };
            }
        }
        let mut parit: Vec<Pari> = (0..a).map(|k| (Some(k), Some(k))).collect();
        let (mut i, mut j) = (0, 0);
        let (mut ov, mut ou) = (Vec::new(), Vec::new());
        while i < nn || j < mm {
            if i < nn && j < mm && sama(a + i, a + j) {
                tyhjenna(&mut ov, &mut ou, &mut parit, vanhat, uudet);
                parit.push((Some(a + i), Some(a + j)));
                i += 1;
                j += 1;
            } else if j >= mm || (i < nn && l[i + 1][j] >= l[i][j + 1]) {
                ov.push(a + i);
                i += 1;
            } else {
                ou.push(a + j);
                j += 1;
            }
        }
        tyhjenna(&mut ov, &mut ou, &mut parit, vanhat, uudet);
        parit.extend((0..b).map(|k| (Some(n - b + k), Some(m - b + k))));
        parit
    }

    /// Uudelleentuonnin laskurit (lr.mjs:210); `sama = -1` = lähde ennallaan, mitään ei tehty.
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct Uudelleentuonti {
        pub sama: i64,
        pub muuttunut: u64,
        pub uusi: u64,
        pub poistettu: u64,
        pub ristiriita: u64,
        pub viety: u64,
    }

    #[derive(Clone, Copy)]
    enum Muutos<'a> {
        Poisto,
        Sisalto(&'a Osa),
    }

    // Gitin muutos yksikköön (lr.mjs:220-242, `gitMuutos`); palauttaa true, jos muutos oli oma vienti.
    fn git_muutos(
        y: &mut Rivi,
        muutos: Muutos,
        laite: &mut Laite,
        nyt: &str,
        tulos: &mut Uudelleentuonti,
    ) -> bool {
        let viety = y.rinnakkaiset.is_empty()
            && match muutos {
                Muutos::Poisto => y.poistettu,
                Muutos::Sisalto(o) => !y.poistettu && o.sisalto == y.sisalto,
            };
        if viety {
            match muutos {
                Muutos::Poisto => y.lahde_sisalto = None,
                Muutos::Sisalto(o) => {
                    y.laji = o.laji.clone();
                    y.osio = o.osio.clone();
                    y.lahde_sisalto = Some(o.sisalto.clone());
                }
            }
            y.lahde_versio = Some(y.versio.clone());
            return true;
        }
        let lahde_versio = y.lahde_versio.clone().unwrap_or_default();
        let koskematon = vertaa(&y.versio, &lahde_versio) == Vertailu::Sama;
        let palautettu = !koskematon
            && !y.poistettu
            && y.rinnakkaiset.is_empty()
            && y.lahde_sisalto.as_deref() == Some(&y.sisalto);
        let mut versio = if palautettu {
            yhdista_versiot(&y.versio, &lahde_versio)
        } else {
            lahde_versio
        };
        versio.insert(laite.nimi.clone(), laite.seuraava());
        if koskematon || palautettu {
            match muutos {
                Muutos::Poisto => y.poistettu = true,
                Muutos::Sisalto(o) => {
                    y.sisalto = o.sisalto.clone();
                    y.laji = o.laji.clone();
                    y.osio = o.osio.clone();
                }
            }
            y.versio = versio.clone();
            y.muutettu = Some(nyt.to_string());
            y.muuttaja = Some(laite.nimi.clone());
        } else {
            let (sisalto, poistettu) = match muutos {
                Muutos::Poisto => (y.sisalto.clone(), true),
                Muutos::Sisalto(o) => (o.sisalto.clone(), false),
            };
            y.rinnakkaiset.push(Sisar {
                sisalto,
                poistettu,
                versio: versio.clone(),
                muutettu: Some(nyt.to_string()),
                muuttaja: Some(laite.nimi.clone()),
            });
            tulos.ristiriita += 1;
        }
        y.lahde_sisalto = match muutos {
            Muutos::Poisto => None,
            Muutos::Sisalto(o) => Some(o.sisalto.clone()),
        };
        y.lahde_versio = Some(versio);
        false
    }

    /// Vastaanoton tulos (lr.mjs:405).
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct Vastaanotto {
        pub otettu: u64,
        pub ohitettu: u64,
        pub ristiriidat: Vec<String>,
        pub muuttuneet: BTreeSet<String>,
    }

    /// Vertailun toinen taso (lr.mjs:391-399).
    #[derive(Clone, Debug, PartialEq)]
    pub struct Lista {
        pub meta: Meta,
        pub yksikot: Vec<(String, Versio, Vec<Versio>)>,
        pub siivotut: BTreeMap<String, Versio>,
    }

    /// Tiivisteet (lr.mjs:381-389): juuri ja rekisterikohtaiset.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Tiivisteet {
        pub juuri: String,
        pub rekisterit: BTreeMap<String, String>,
    }

    /// Tuonnin yhteenveto (lr.mjs:489-512, `tuoHead`).
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct Tuonti {
        pub commit: String,
        pub uusia_rek: u64,
        pub yksikoita: u64,
        pub sama: i64,
        pub muuttunut: u64,
        pub uusi: u64,
        pub poistettu: u64,
        pub ristiriita: u64,
        pub viety: u64,
        pub muuttumattomia: u64,
        pub poistettuja_rek: u64,
        pub siivottu: u64,
    }

    impl Tuonti {
        /// Komentorivin `tuo`-tuloste (lr.mjs:567-570) ilman juurihakemistoa.
        pub fn rivi(&self) -> String {
            format!(
                "TUOTU: commit {}: uusia rekistereitä {} ({} yksikköä), muuttumattomia {}, muuttuneissa yksiköitä \
                 sama {} / muuttunut {} / uusi {} / poistettu {} / ristiriita {} / viety {}; poistettuja \
                 rekistereitä {}; siivottuja hautakiviä {}",
                self.commit.get(..8).unwrap_or(&self.commit),
                self.uusia_rek,
                self.yksikoita,
                self.muuttumattomia,
                self.sama,
                self.muuttunut,
                self.uusi,
                self.poistettu,
                self.ristiriita,
                self.viety,
                self.poistettuja_rek,
                self.siivottu
            )
        }
    }

    /// Gitin malli viennille (lr.mjs:519-561): HEADin rekisteritiedostot, työpuun muokkaukset ja esteet.
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct Git {
        pub head: BTreeMap<String, String>,
        pub commit: String,
        /// Commit-viestit, uusin viimeisenä.
        pub loki: Vec<String>,
        /// Työpuun tiedostot, jotka eroavat HEADista (`git status --porcelain`).
        pub muokatut: BTreeMap<String, String>,
        /// Juurirepon pakkauslukko (`<tila>/lock`).
        pub juurilukko: bool,
        /// Tiedostokohtaiset pakkauslukot.
        pub tiedostolukot: BTreeSet<String>,
        /// pre-commit-hookin hylkäysviesti.
        pub hylkaa_commit: Option<String>,
        /// Kesken oleva git-toiminto (MERGE_HEAD, rebase-merge, ...).
        pub kesken: Option<String>,
        pub irrotettu: bool,
    }

    impl Git {
        /// Työpuun sisältö (muokattu tai HEAD).
        pub fn lue(&self, polku: &str) -> Option<&String> {
            self.muokatut.get(polku).or_else(|| self.head.get(polku))
        }

        pub fn kirjoita(&mut self, polku: &str, teksti: &str) {
            self.muokatut.insert(polku.to_string(), teksti.to_string());
        }

        /// `git checkout -- polku`
        pub fn palauta(&mut self, polku: &str) {
            self.muokatut.remove(polku);
        }

        /// `git commit -- polku`: muokattu tiedosto HEADiin; palauttaa uuden commitin tunnuksen.
        pub fn committaa(&mut self, polku: &str, viesti: &str) -> Result<String, String> {
            if let Some(h) = &self.hylkaa_commit {
                return Err(h.clone());
            }
            let teksti = self
                .muokatut
                .remove(polku)
                .ok_or_else(|| format!("ei muutoksia: {polku}"))?;
            self.commit = sha(&format!("{}\n{polku}\n{viesti}\n{teksti}", self.commit));
            self.head.insert(polku.to_string(), teksti);
            self.loki.push(viesti.to_string());
            Ok(self.commit.clone())
        }
    }

    /// Viennin tulos (lr.mjs:520).
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct Vienti {
        pub viety: Vec<(String, String)>,
        pub ohitettu: Vec<(String, String)>,
        pub syy: Option<String>,
    }

    impl Varasto {
        fn rekisteri(&self, polku: &str) -> Result<&Rekisteri, Virhe> {
            self.rekisterit
                .get(polku)
                .ok_or_else(|| Virhe(format!("tuntematon rekisteri: {polku}")))
        }

        /// Rekisterien polut järjestyksessä (lr.mjs:368-377).
        pub fn rekisterit(&self) -> Vec<String> {
            self.rekisterit.keys().cloned().collect()
        }

        /// Rekisterin yksiköt tunnuksen järjestyksessä (lr.mjs:330-333).
        pub fn lue_yksikot(&self, polku: &str) -> Vec<Rivi> {
            self.rekisterit
                .get(polku)
                .map(|r| r.rivit.values().cloned().collect())
                .unwrap_or_default()
        }

        /// lr.mjs:345
        pub fn lue_siivotut(&self, polku: &str) -> BTreeMap<String, Versio> {
            self.rekisterit
                .get(polku)
                .map(|r| r.siivotut.clone())
                .unwrap_or_default()
        }

        /// lr.mjs:357
        pub fn lue_meta(&self, polku: &str) -> Option<&Meta> {
            self.rekisterit.get(polku).map(|r| &r.meta)
        }

        /// Tuo yhden rekisterin tekstistä; kieltäytyy, jos rekisteri on jo tuotu (lr.mjs:157-170).
        pub fn tuo_rekisteri(
            &mut self,
            laite: &mut Laite,
            polku: &str,
            teksti: &str,
            commit: &str,
            nyt: &str,
        ) -> Result<usize, Virhe> {
            if self.rekisterit.contains_key(polku) {
                return virhe(format!("jo tuotu: {polku}"));
            }
            let osat = pilko(teksti);
            let jarj = avaimet(osat.len());
            let mut rivit = BTreeMap::new();
            for (o, k) in osat.iter().zip(&jarj) {
                let y = uusi_yksikko(laite, polku, o, k, nyt);
                rivit.insert(y.id.clone(), y);
            }
            let meta = Meta {
                rekisteri: polku.to_string(),
                versio: [(laite.nimi.clone(), laite.seuraava())]
                    .into_iter()
                    .collect(),
                poistettu: false,
                lahde: Some(Lahde {
                    commit: commit.to_string(),
                    sha256: sha(teksti),
                }),
            };
            self.rekisterit.insert(
                polku.to_string(),
                Rekisteri {
                    meta,
                    rivit,
                    siivotut: BTreeMap::new(),
                },
            );
            Ok(osat.len())
        }

        /// Uudelleentuonti (lr.mjs:206-318): muokattu rivi pitää tunnuksensa, gitistä poistunut saa
        /// hautakiven, uusi saa avaimen naapuriensa väliin; muun laitteen muuttama rivi saa gitin muutoksen
        /// rinnakkaiseksi (K4).
        pub fn uudelleentuo(
            &mut self,
            laite: &mut Laite,
            polku: &str,
            teksti: &str,
            commit: &str,
            nyt: &str,
        ) -> Result<Uudelleentuonti, Virhe> {
            let Some(rek) = self.rekisterit.get_mut(polku) else {
                return virhe(format!("ei tuotu: {polku}"));
            };
            let mut tulos = Uudelleentuonti::default();
            let sha_uusi = sha(teksti);
            if rek
                .meta
                .lahde
                .as_ref()
                .is_some_and(|l| l.sha256 == sha_uusi)
                && !rek.meta.poistettu
            {
                tulos.sama = -1;
                return Ok(tulos);
            }
            let mut vanhat = jarjestyksessa(
                rek.rivit
                    .values()
                    .filter(|y| y.lahde_sisalto.is_some())
                    .cloned()
                    .collect(),
            );
            let uudet = pilko(teksti);
            let mut omat: Vec<String> = rek
                .rivit
                .values()
                .filter(|y| y.lahde_sisalto.is_none() && !y.poistettu && y.rinnakkaiset.is_empty())
                .map(|y| y.id.clone())
                .collect();
            let parit = parita(&vanhat, &uudet);
            let mut edellinen = String::new();
            for (k, &(v, u)) in parit.iter().enumerate() {
                match (v, u) {
                    (Some(v), None) => {
                        if git_muutos(&mut vanhat[v], Muutos::Poisto, laite, nyt, &mut tulos) {
                            tulos.viety += 1;
                        } else {
                            tulos.poistettu += 1;
                        }
                    }
                    (Some(v), Some(u)) => {
                        let (y, o) = (&mut vanhat[v], &uudet[u]);
                        if y.lahde_sisalto.as_deref() != Some(&o.sisalto) {
                            if git_muutos(y, Muutos::Sisalto(o), laite, nyt, &mut tulos) {
                                tulos.viety += 1;
                            } else {
                                tulos.muuttunut += 1;
                            }
                        } else {
                            y.laji = o.laji.clone();
                            y.osio = o.osio.clone();
                            tulos.sama += 1;
                        }
                        edellinen = y.jarjestys.clone();
                    }
                    (None, Some(u)) => {
                        let o = &uudet[u];
                        let oma = omat.iter().position(|id| {
                            rek.rivit.get(id).is_some_and(|y| y.sisalto == o.sisalto)
                        });
                        if let Some(oma) = oma.and_then(|i| rek.rivit.get_mut(&omat.remove(i))) {
                            oma.laji = o.laji.clone();
                            oma.osio = o.osio.clone();
                            oma.lahde_sisalto = Some(oma.sisalto.clone());
                            oma.lahde_versio = Some(oma.versio.clone());
                            if oma.jarjestys > edellinen {
                                edellinen = oma.jarjestys.clone();
                            }
                            tulos.viety += 1;
                            continue;
                        }
                        let yla = parit[k + 1..]
                            .iter()
                            .find_map(|&(sv, su)| sv.filter(|_| su.is_some()))
                            .map(|i| vanhat[i].jarjestys.clone());
                        let raja = yla.filter(|y| *y > edellinen);
                        edellinen = valiin(&edellinen, raja.as_deref())?;
                        let y = uusi_yksikko(laite, polku, o, &edellinen, nyt);
                        rek.rivit.insert(y.id.clone(), y);
                        tulos.uusi += 1;
                    }
                    (None, None) => {}
                }
            }
            for y in vanhat {
                rek.rivit.insert(y.id.clone(), y);
            }
            if rek.meta.poistettu {
                rek.meta.versio.insert(laite.nimi.clone(), laite.seuraava());
            }
            rek.meta.poistettu = false;
            rek.meta.lahde = Some(Lahde {
                commit: commit.to_string(),
                sha256: sha_uusi,
            });
            Ok(tulos)
        }

        /// Gitistä poistunut rekisteri saa hautakiven; yksiköt jäävät ennalleen (lr.mjs:320-328).
        pub fn poista_rekisteri(&mut self, laite: &mut Laite, polku: &str) -> Result<bool, Virhe> {
            let Some(rek) = self.rekisterit.get_mut(polku) else {
                return virhe(format!("ei tuotu: {polku}"));
            };
            if rek.meta.poistettu {
                return Ok(false);
            }
            rek.meta.poistettu = true;
            rek.meta.versio.insert(laite.nimi.clone(), laite.seuraava());
            Ok(true)
        }

        /// Hautakivet tiiviiksi `siivotut`-merkinnöiksi (lr.mjs:346-355); vain gitissä olemattomat ja
        /// riidattomat kivet.
        pub fn siivoa(&mut self, polku: &str) -> usize {
            let Some(rek) = self.rekisterit.get_mut(polku) else {
                return 0;
            };
            let kivet: Vec<String> = rek
                .rivit
                .values()
                .filter(|y| y.poistettu && y.rinnakkaiset.is_empty() && y.lahde_sisalto.is_none())
                .map(|y| y.id.clone())
                .collect();
            for id in &kivet {
                if let Some(y) = rek.rivit.remove(id) {
                    rek.siivotut.insert(y.id, y.versio);
                }
            }
            kivet.len()
        }

        /// Rekisteri tekstinä; `lahde` = gitin puoli (lr.mjs:359-366).
        pub fn tulosta(&self, polku: &str, lahde: bool) -> String {
            let ys = jarjestyksessa(self.lue_yksikot(polku));
            if lahde {
                ys.iter()
                    .filter_map(|y| y.lahde_sisalto.as_deref())
                    .collect()
            } else {
                ys.iter()
                    .filter(|y| !y.poistettu)
                    .map(|y| y.sisalto.as_str())
                    .collect()
            }
        }

        /// lr.mjs:379-384
        pub fn rekisterin_tiiviste(&self, polku: &str) -> Result<String, Virhe> {
            let rek = self.rekisteri(polku)?;
            let mut rivit: Vec<String> = rek
                .rivit
                .values()
                .map(|y| {
                    let rinn: String = y
                        .rinnakkaiset
                        .iter()
                        .map(|r| format!("|{}", vektori(&r.versio)))
                        .collect();
                    format!("{}:{}{}", y.id, vektori(&y.versio), rinn)
                })
                .collect();
            rivit.sort();
            let mut kaikki = vec![format!("_meta:{}", vektori(&rek.meta.versio))];
            kaikki.extend(rivit);
            Ok(sha(&kaikki.join("\n")))
        }

        /// lr.mjs:386-389
        pub fn tiivisteet(&self) -> Tiivisteet {
            let rekisterit: BTreeMap<String, String> = self
                .rekisterit
                .keys()
                .filter_map(|p| Some((p.clone(), self.rekisterin_tiiviste(p).ok()?)))
                .collect();
            let juuri = sha(&rekisterit
                .iter()
                .map(|(p, t)| format!("{p}:{t}"))
                .collect::<Vec<_>>()
                .join("\n"));
            Tiivisteet { juuri, rekisterit }
        }

        /// Rekisterin meta ja yksiköiden (id, versio, rinnakkaisten versiot) -lista (lr.mjs:391-399).
        pub fn lista(&self, polku: &str) -> Result<Lista, Virhe> {
            let rek = self.rekisteri(tarkista_polku(polku)?)?;
            Ok(Lista {
                meta: rek.meta.clone(),
                yksikot: rek
                    .rivit
                    .values()
                    .map(|y| {
                        let rinn = y.rinnakkaiset.iter().map(|r| r.versio.clone()).collect();
                        (y.id.clone(), y.versio.clone(), rinn)
                    })
                    .collect(),
                siivotut: rek.siivotut.clone(),
            })
        }

        /// Toisen laitteen lähettämät metat ja yksiköt (lr.mjs:401-449): uudempi korvaa, vanhempi ohitetaan,
        /// rinnakkainen tallentuu riidaksi; uudempi kuin kaikki rinnakkaiset on ratkaisu. Siivottu kivi:
        /// sama tai vanhempi ohitetaan, uudempi herättää, rinnakkainen palauttaa kiven riitana.
        pub fn vastaanota(
            &mut self,
            metat: &[Meta],
            yksikot: &[Rivi],
        ) -> Result<Vastaanotto, Virhe> {
            let mut tulos = Vastaanotto::default();
            for y in yksikot {
                let t = y.sisalto.trim_matches('\n');
                if y.laji != "taulukko-otsake" && t.starts_with('|') && t.contains('\n') {
                    return virhe(format!("rivinvaihto taulukkorivissä: {}", y.id));
                }
            }
            for m in metat {
                let p = tarkista_polku(&m.rekisteri)?;
                match self.rekisterit.get_mut(p) {
                    None => {
                        self.rekisterit.insert(
                            p.to_string(),
                            Rekisteri {
                                meta: Meta {
                                    lahde: None,
                                    ..m.clone()
                                },
                                rivit: BTreeMap::new(),
                                siivotut: BTreeMap::new(),
                            },
                        );
                        tulos.muuttuneet.insert(p.to_string());
                    }
                    Some(oma) => {
                        if vertaa(&m.versio, &oma.meta.versio) == Vertailu::Uudempi {
                            oma.meta.versio = m.versio.clone();
                            oma.meta.poistettu = m.poistettu;
                            tulos.muuttuneet.insert(p.to_string());
                        }
                    }
                }
            }
            for tullut in yksikot {
                let p = tarkista_polku(&tullut.rekisteri)?;
                let Some(rek) = self.rekisterit.get_mut(p) else {
                    return virhe(format!("tuntematon rekisteri: {p}"));
                };
                if !kelpo_tunnus(&tullut.id) {
                    return virhe(format!("virheellinen tunnus: {}", tullut.id));
                }
                let siirto = Rivi {
                    lahde_sisalto: None,
                    lahde_versio: None,
                    ..tullut.clone()
                };
                let sisar = Sisar {
                    sisalto: siirto.sisalto.clone(),
                    poistettu: siirto.poistettu,
                    versio: siirto.versio.clone(),
                    muutettu: siirto.muutettu.clone(),
                    muuttaja: siirto.muuttaja.clone(),
                };
                let olemassa = rek.rivit.contains_key(&siirto.id);
                if let Some(kivi) = rek.siivotut.get(&siirto.id).filter(|_| !olemassa).cloned() {
                    let suhde = vertaa(&siirto.versio, &kivi);
                    if matches!(suhde, Vertailu::Sama | Vertailu::Vanhempi) {
                        tulos.ohitettu += 1;
                        continue;
                    }
                    let uusi = if suhde == Vertailu::Uudempi {
                        siirto
                    } else {
                        Rivi {
                            poistettu: true,
                            versio: kivi,
                            muutettu: None,
                            muuttaja: None,
                            rinnakkaiset: vec![sisar],
                            ..siirto
                        }
                    };
                    rek.siivotut.remove(&uusi.id);
                    if suhde == Vertailu::Rinnakkainen {
                        tulos.ristiriidat.push(uusi.id.clone());
                    }
                    rek.rivit.insert(uusi.id.clone(), uusi);
                    tulos.otettu += 1;
                    tulos.muuttuneet.insert(p.to_string());
                    continue;
                }
                let Some(oma) = rek.rivit.get_mut(&siirto.id) else {
                    rek.rivit.insert(siirto.id.clone(), siirto);
                    tulos.otettu += 1;
                    tulos.muuttuneet.insert(p.to_string());
                    continue;
                };
                let suhde = vertaa(&siirto.versio, &oma.versio);
                if suhde == Vertailu::Uudempi {
                    let jaljella: Vec<Sisar> = oma
                        .rinnakkaiset
                        .iter()
                        .filter(|r| vertaa(&siirto.versio, &r.versio) != Vertailu::Uudempi)
                        .cloned()
                        .collect();
                    if !jaljella.is_empty() {
                        tulos.ristiriidat.push(siirto.id.clone());
                    }
                    *oma = Rivi {
                        lahde_sisalto: oma.lahde_sisalto.take(),
                        lahde_versio: oma.lahde_versio.take(),
                        rinnakkaiset: jaljella,
                        ..siirto
                    };
                    tulos.otettu += 1;
                    tulos.muuttuneet.insert(p.to_string());
                } else if suhde == Vertailu::Rinnakkainen
                    && !oma
                        .rinnakkaiset
                        .iter()
                        .any(|r| vertaa(&r.versio, &siirto.versio) != Vertailu::Vanhempi)
                {
                    oma.rinnakkaiset.push(sisar);
                    tulos.ristiriidat.push(siirto.id.clone());
                    tulos.muuttuneet.insert(p.to_string());
                } else {
                    tulos.ohitettu += 1;
                }
            }
            Ok(tulos)
        }

        /// Riidalliset yksiköt kaikista rekistereistä (lr.mjs:451-453).
        pub fn ristiriidat(&self) -> Vec<Rivi> {
            self.rekisterit
                .values()
                .flat_map(|r| r.rivit.values().filter(|y| !y.rinnakkaiset.is_empty()))
                .cloned()
                .collect()
        }

        /// Yksiköt tunnuksilla (lr.mjs:455-458).
        pub fn hae(&self, polku: &str, idt: &[&str]) -> Result<Vec<Rivi>, Virhe> {
            let rek = self.rekisteri(tarkista_polku(polku)?)?;
            Ok(idt
                .iter()
                .filter(|id| kelpo_tunnus(id))
                .filter_map(|id| rek.rivit.get(*id).cloned())
                .collect())
        }

        /// Gitin HEADin rekisteritiedostot kaksoiskappaleeseen ja lopuksi siivous (lr.mjs:465-489, `tuoHead`).
        pub fn tuo(&mut self, laite: &mut Laite, git: &Git, nyt: &str) -> Result<Tuonti, Virhe> {
            let mut s = Tuonti {
                commit: git.commit.clone(),
                ..Tuonti::default()
            };
            let olemassa: BTreeSet<String> = self.rekisterit.keys().cloned().collect();
            for (p, teksti) in git.head.iter().filter(|(p, _)| rekisteritiedosto(p)) {
                if !olemassa.contains(p) {
                    s.yksikoita += self.tuo_rekisteri(laite, p, teksti, &git.commit, nyt)? as u64;
                    s.uusia_rek += 1;
                    continue;
                }
                let t = self.uudelleentuo(laite, p, teksti, &git.commit, nyt)?;
                if t.sama == -1 {
                    s.muuttumattomia += 1;
                    continue;
                }
                s.sama += t.sama;
                s.muuttunut += t.muuttunut;
                s.uusi += t.uusi;
                s.poistettu += t.poistettu;
                s.ristiriita += t.ristiriita;
                s.viety += t.viety;
            }
            for p in &olemassa {
                if !git.head.contains_key(p) && self.poista_rekisteri(laite, p)? {
                    s.poistettuja_rek += 1;
                }
            }
            for p in self.rekisterit() {
                s.siivottu += self.siivoa(&p) as u64;
            }
            Ok(s)
        }

        /// LR → git (lr.mjs:519-561): ensin tuonti, sitten jokainen etuliitteen rekisteri, jonka teksti
        /// eroaa HEADista, committataan yksinään. Ohitus: avoin riita, pakkauslukko, muokattu työpuu,
        /// epäonnistunut commit. Viennin jälkeen tuonti uudelleen.
        pub fn vie(
            &mut self,
            laite: &mut Laite,
            git: &mut Git,
            etuliite: &str,
            nyt: &str,
        ) -> Result<Vienti, Virhe> {
            let mut tulos = Vienti::default();
            if let Some(k) = &git.kesken {
                tulos.syy = Some(format!("git-toiminto kesken ({k})"));
                return Ok(tulos);
            }
            if git.irrotettu {
                tulos.syy = Some("irrotettu HEAD".to_string());
                return Ok(tulos);
            }
            if git.juurilukko {
                tulos.syy = Some("juurirepon pakkauslukko".to_string());
                return Ok(tulos);
            }
            self.tuo(laite, git, nyt)?;
            for p in self
                .rekisterit()
                .into_iter()
                .filter(|r| r.starts_with(etuliite))
            {
                let Some(rek) = self.rekisterit.get(&p) else {
                    continue;
                };
                if rek.meta.poistettu || rek.meta.lahde.is_none() {
                    continue;
                }
                let Some(head) = git.head.get(&p) else {
                    continue;
                };
                let teksti = self.tulosta(&p, false);
                if &teksti == head {
                    continue;
                }
                if rek.rivit.values().any(|y| !y.rinnakkaiset.is_empty()) {
                    tulos.ohitettu.push((p, "avoin riita (K4)".to_string()));
                    continue;
                }
                let kansio = p.rsplit_once('/').map_or("", |(k, _)| k);
                let rekisteri_md = if kansio.is_empty() {
                    "REKISTERI.md".to_string()
                } else {
                    format!("{kansio}/REKISTERI.md")
                };
                if git.tiedostolukot.contains(&p) || git.tiedostolukot.contains(&rekisteri_md) {
                    tulos.ohitettu.push((p, "pakkauslukko".to_string()));
                    continue;
                }
                if git.muokatut.contains_key(&p) {
                    tulos
                        .ohitettu
                        .push((p, "tiedostoa muokattu työpuussa".to_string()));
                    continue;
                }
                git.kirjoita(&p, &teksti);
                let viesti = format!("chore(lr): vienti {p} äpistä (localregister)");
                match git.committaa(&p, &viesti) {
                    Ok(commit) => tulos.viety.push((p, commit)),
                    Err(e) => {
                        git.palauta(&p);
                        let viimeinen = e.trim().lines().last().unwrap_or("").to_string();
                        tulos
                            .ohitettu
                            .push((p, format!("commit epäonnistui: {viimeinen}")));
                    }
                }
            }
            if !tulos.viety.is_empty() {
                self.tuo(laite, git, nyt)?;
            }
            Ok(tulos)
        }
    }
}
