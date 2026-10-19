//! Tilavarasto `GET/PUT /api/tila/*` (S-4, SUUNNITELMA.md §3.1): yksiköt polussa "tila", id = avain.
//! LWW HLC:llä (tasapeli laite-id:llä, `yksikko::yhdista`), `kuittaus/*` suurin-voittaa ja headless-solmun
//! UI-avainten suodatin (`on_ui_avain`, `nakyy`, `sovella`), jota replikointi ja `api::kirjoita_ja_ilmoita`
//! käyttävät.

use crate::api::{kello_ms, kirjoita_yhdistajalla, Tila};
use crate::muutosloki::{versio_tekstina, Result};
use crate::yksikko::{Hlc, Yhdistaja, Yksikko};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Tilayksiköiden polku varastossa.
pub const POLKU: &str = "tila";

const KUITTAUS: &str = "kuittaus/";

/// Sarjoittaa lue-laske-kirjoita-jakson, jotta kaksi samanaikaista kirjoitusta ei saa samaa HLC:tä
/// eikä kuittauksen vertailu ehdi muuttua kesken.
static KIRJOITUS: Mutex<()> = Mutex::new(());

/// UI-tilan avain, jota headless-solmu ei lähetä eikä sovella (S-4). `kuittaus/*` ja `asetukset/*` eivät ole.
pub fn on_ui_avain(avain: &str) -> bool {
    matches!(
        avain,
        "valittu-skooppi" | "agy-valinta" | "piilotukset" | "suodatin"
    ) || ["luonnos/", "vierityskohta/", "purku-valinta/"]
        .iter()
        .any(|e| avain.starts_with(e))
}

/// Saako yksikön lähettää ja soveltaa? Epätosi vain headless-solmussa polun "tila" UI-avaimille.
pub fn nakyy(tila: &Tila, y: &Yksikko) -> bool {
    !(tila.headless && y.polku == POLKU && on_ui_avain(&y.id))
}

/// Polun tiiviste headless-suodatus huomioiden. Headless-solmun "tila"-polulle lasketaan vain
/// näkyvistä yksiköistä (kuten `Varasto::tiiviste`); `None` = polulla ei ole yhtään näkyvää yksikköä.
pub fn tiiviste(tila: &Tila, polku: &str) -> Result<Option<String>> {
    if !(tila.headless && polku == POLKU) {
        return tila.varasto.tiiviste(polku).map(Some);
    }
    let mut sha = Sha256::new();
    let mut ainakin_yksi = false;
    for y in tila
        .varasto
        .listaa(polku)?
        .iter()
        .filter(|y| nakyy(tila, y))
    {
        ainakin_yksi = true;
        sha.update(format!("{}\t{}\n", y.id, versio_tekstina(&y.versio)?).as_bytes());
    }
    Ok(ainakin_yksi.then(|| {
        sha.finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    }))
}

fn kokonaisluku(y: &Yksikko) -> Option<i128> {
    let arvo: Value = serde_json::from_slice(y.sisalto.as_deref()?).ok()?;
    let n = arvo.as_number()?;
    n.as_i64()
        .map(i128::from)
        .or_else(|| n.as_u64().map(i128::from))
}

/// Yhdistää tilayksikön varastoon lukitta (kutsuja pitää `KIRJOITUS`-lukon): LWW, ja `kuittaus/*`
/// suurin-voittaa. Suurempi kuittaus, jonka HLC on nykyistä vanhempi, talletetaan uudella HLC:llä
/// (nykyisen jälkeen, versiovektorit yhdistettyinä), jotta se voittaa kaikissa solmuissa.
fn kirjoita_lukittuna(tila: &Tila, y: &Yksikko) -> Result<Option<u64>> {
    if y.id.starts_with(KUITTAUS) && !y.poistettu {
        let nykyinen = tila.varasto.lue(&y.polku, &y.id)?.filter(|n| !n.poistettu);
        if let (Some(n), Some(uusi)) = (nykyinen, kokonaisluku(y)) {
            if let Some(vanha) = kokonaisluku(&n) {
                if uusi < vanha {
                    return Ok(None);
                }
                if uusi > vanha && y.aika <= n.aika {
                    let mut versio = n.versio.clone();
                    for (laite, laskuri) in &y.versio {
                        let e = versio.entry(laite.clone()).or_insert(0);
                        *e = (*e).max(*laskuri);
                    }
                    *versio.entry(tila.laite.clone()).or_insert(0) += 1;
                    let nostettu = Yksikko {
                        versio,
                        aika: Hlc::nyt(&tila.laite, Some(&n.aika), kello_ms()),
                        ..y.clone()
                    };
                    return kirjoita_yhdistajalla(tila, &nostettu, Yhdistaja::Lww);
                }
            }
        }
    }
    kirjoita_yhdistajalla(tila, y, Yhdistaja::Lww)
}

/// Kirjoittaa tilayksikön (replikoinnin ja `api::kirjoita_ja_ilmoita`-polun sisäänkäynti): headless-solmun
/// UI-avaimet ohitetaan (`Ok(None)`), muuten LWW / kuittaus suurin-voittaa. Palauttaa `seq`:n muutoksesta.
pub fn kirjoita_tilaan(tila: &Tila, y: &Yksikko) -> Result<Option<u64>> {
    if !nakyy(tila, y) {
        return Ok(None);
    }
    let _vuoro = KIRJOITUS.lock().unwrap_or_else(|e| e.into_inner());
    kirjoita_lukittuna(tila, y)
}

/// Soveltaa vertaiselta saapuneen tilayksikön. `false` = ohitettu headlessina; kirjoitusvirhe kirjataan
/// stderriin eikä muuta paluuarvoa.
pub fn sovella(tila: &Tila, y: &Yksikko) -> bool {
    if !nakyy(tila, y) {
        return false;
    }
    if let Err(e) = kirjoita_tilaan(tila, y) {
        eprintln!("tila {}: {e}", y.id);
    }
    true
}

pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new()
        .route("/api/tila", get(listaa))
        .route("/api/tila/*avain", get(hae).put(aseta))
        .with_state(tila)
}

fn virhe(koodi: StatusCode, teksti: &str) -> Response {
    (koodi, Json(json!({"virhe": teksti}))).into_response()
}

fn json_yksikko(y: &Yksikko) -> Value {
    let arvo = y
        .sisalto
        .as_deref()
        .and_then(|b| serde_json::from_slice::<Value>(b).ok())
        .unwrap_or(Value::Null);
    json!({"avain": y.id, "arvo": arvo, "aika": y.aika.to_string(), "laite": y.aika.laite})
}

async fn hae(State(t): State<Arc<Tila>>, Path(avain): Path<String>) -> Response {
    match t.varasto.lue(POLKU, &avain) {
        Ok(Some(y)) if !y.poistettu => Json(json_yksikko(&y)).into_response(),
        Ok(_) => virhe(StatusCode::NOT_FOUND, "avainta ei ole"),
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn listaa(
    State(t): State<Arc<Tila>>,
    Query(kysely): Query<HashMap<String, String>>,
) -> Response {
    let etuliite = kysely.get("etuliite").map_or("", String::as_str);
    match t.varasto.listaa(POLKU) {
        Ok(rivit) => {
            let tilat: Vec<Value> = rivit
                .iter()
                .filter(|y| !y.poistettu && y.id.starts_with(etuliite))
                .map(json_yksikko)
                .collect();
            Json(json!({"tilat": tilat})).into_response()
        }
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// Paikallinen PUT: uusi HLC (`Hlc::nyt`) nykyisen jälkeen. Palauttaa voimaan jääneen yksikön ajan;
/// pienempi kuittaus ei korvaa, jolloin se on nykyisen aika.
fn kirjoita(t: &Tila, avain: &str, arvo: &Value) -> Result<Hlc> {
    let _vuoro = KIRJOITUS.lock().unwrap_or_else(|e| e.into_inner());
    let nykyinen = t.varasto.lue(POLKU, avain)?;
    let aika = Hlc::nyt(&t.laite, nykyinen.as_ref().map(|y| &y.aika), kello_ms());
    let mut versio = nykyinen
        .as_ref()
        .map(|y| y.versio.clone())
        .unwrap_or_default();
    *versio.entry(t.laite.clone()).or_insert(0) += 1;
    let y = Yksikko {
        polku: POLKU.to_string(),
        id: avain.to_string(),
        versio,
        aika: aika.clone(),
        sisalto: Some(serde_json::to_vec(arvo).unwrap_or_default()),
        poistettu: false,
    };
    match kirjoita_lukittuna(t, &y)? {
        None => Ok(nykyinen.map_or(aika, |n| n.aika)),
        Some(_) => Ok(aika),
    }
}

async fn aseta(State(t): State<Arc<Tila>>, Path(avain): Path<String>, runko: Bytes) -> Response {
    let arvo = match serde_json::from_slice::<Value>(&runko) {
        Ok(Value::Object(mut o)) => match o.remove("arvo") {
            Some(a) => a,
            None => return virhe(StatusCode::BAD_REQUEST, "arvo puuttuu"),
        },
        _ => return virhe(StatusCode::BAD_REQUEST, "runko ei ole JSON-olio"),
    };
    if avain.starts_with("kuittaus/") && !(arvo.is_i64() || arvo.is_u64()) {
        return virhe(
            StatusCode::BAD_REQUEST,
            "kuittauksen arvo ei ole kokonaisluku",
        );
    }
    match kirjoita(&t, &avain, &arvo) {
        Ok(aika) => Json(json!({"aika": aika.to_string()})).into_response(),
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}
