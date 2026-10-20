//! Transkriptipeili (S-5a): adapterin lisäämät jsonl-rivit ytimen kopioon offset-tarkistuksella.
//! Yksikkö: polku "peili", id `<tiedosto>:<offset>`, sisältö = rivit JSON-taulukkona (lisäysyhdistäjä).
//! Tiedoston ytimen tuntema offset: polku "peili-offset", id `<tiedosto>`, sisältö `{"offset":n}` (LWW),
//! kirjoitetaan suoraan varastoon eikä sitä ilmoiteta virran broadcast-kanavaan.

use crate::api::{kello_ms, kirjoita_yhdistajalla, Tila};
use crate::muutosloki::Result;
use crate::varasto::Varasto;
use crate::vertaiset::Vertainen;
use crate::yksikko::{Hlc, Yhdistaja, Yksikko};
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

/// `GET /api/peili/<tiedosto>/offset` (S-5a) ja `GET /api/peili/<tiedosto>/rivi?offset=<tavu>` (S-9d).
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
            let tekstit: Vec<Value> = a.iter().filter(|l| teksti_lohko(l)).cloned().collect();
            (!tekstit.is_empty()).then_some(Value::Array(tekstit))
        }
        _ => None,
    };
    let Some(sisalto) = sisalto else {
        return tynkarivi(tyyppi);
    };
    let mut ulos = serde_json::Map::new();
    for avain in ["type", "timestamp", "uuid"] {
        if let Some(v) = o.get(avain) {
            ulos.insert(avain.to_string(), v.clone());
        }
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

/// S-9a: riisuu transkriptirivit viestiteksteiksi. Rivi, jonka type on "user" tai "assistant", säilyttää
/// avaimet type, timestamp, uuid, message.role, message.model ja message.content (merkkijono sellaisenaan,
/// taulukosta vain text-lohkot); muu rivi tai rivi, josta ei jää tekstiä, on tyngän
/// `{"type":<alkuperäinen|null>,"karsittu":true}`. Pituus on sama kuin syötteen.
pub fn riisu(rivit: &[String]) -> Vec<String> {
    rivit.iter().map(|r| riisu_rivi(r)).collect()
}

/// S-9a: ikkunoidun solmun vastaanotto. `None` = hylätään (yksikkö on ikkunaa vanhempi), muuten
/// yksikkö riisuttuna sisällöltään (id, versio ja aika säilyvät).
pub fn ikkunoi(tila: &Tila, y: &Yksikko, nyt_ms: u64) -> Option<Yksikko> {
    let n = tila.peili.ikkuna_vrk?;
    let raja = nyt_ms.saturating_sub(u64::from(n) * PAIVA_MS);
    if y.aika.ms < raja {
        return None;
    }
    Some(riisuttu(y))
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
const KARSINTA_ID: &str = "raja";

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
    // (vuorokausi, id, tavut) vanhimmasta; jäsentymättömät ajat ohitetaan.
    let mut yksikot: Vec<(u64, String, u64)> = tila
        .varasto
        .sisalto_koot(POLKU)?
        .into_iter()
        .filter_map(|(id, aika, tavut)| Some((Hlc::parse(&aika)?.ms, id, tavut)))
        .collect();
    yksikot.sort();
    let ennen: u64 = yksikot.iter().map(|(_, _, t)| t).sum();
    let mut jalkeen = ennen;
    let mut poistetut = 0;
    let mut poista = |id: &str, tavut: u64, jalkeen: &mut u64| -> Result<()> {
        if tila.varasto.poista_paikallisesti(POLKU, id)? {
            poistetut += 1;
            *jalkeen -= tavut;
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
    Ok(Karsinta {
        poistetut,
        tavut_ennen: ennen,
        tavut_jalkeen: jalkeen,
    })
}

/// S-9: `GET /api/peili/koko` -> sisältötavut, yksiköt, vanhin HLC ja asetukset.
async fn koko(State(t): State<Arc<Tila>>) -> Response {
    let tulos = tokio::task::spawn_blocking(move || {
        let koot = t.varasto.sisalto_koot(POLKU)?;
        let tavut: u64 = koot.iter().map(|(_, _, k)| k).sum();
        let vanhin = koot
            .iter()
            .map(|(_, a, _)| a.as_str())
            .min()
            .map(String::from);
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
        kirjoita_yhdistajalla(tila, &riisuttu(y), Yhdistaja::Lisays).map_err(|e| e.to_string())?;
    }
    Ok(saadut.len())
}
