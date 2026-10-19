//! Tilavarasto `GET/PUT /api/tila/*` (S-4). Väliaikainen: kaikki avaimet LWW varaston kautta
//! (polku "tila", id = avain); `kuittaus/*` suurin-voittaa ja headless-suodatin tulevat T-27:ssä.

use crate::api::{kello_ms, kirjoita_yhdistajalla, Tila};
use crate::muutosloki::Result;
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
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const POLKU: &str = "tila";

/// Sarjoittaa lue-laske-kirjoita-jakson, jotta kaksi samanaikaista PUT:ia ei saa samaa HLC:tä.
static KIRJOITUS: Mutex<()> = Mutex::new(());

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

fn kirjoita(t: &Tila, avain: &str, arvo: &Value) -> Result<Hlc> {
    let _vuoro = KIRJOITUS.lock().unwrap_or_else(|e| e.into_inner());
    let nykyinen = t.varasto.lue(POLKU, avain)?;
    let aika = Hlc::nyt(&t.laite, nykyinen.as_ref().map(|y| &y.aika), kello_ms());
    let mut versio = nykyinen.map(|y| y.versio).unwrap_or_default();
    *versio.entry(t.laite.clone()).or_insert(0) += 1;
    let y = Yksikko {
        polku: POLKU.to_string(),
        id: avain.to_string(),
        versio,
        aika: aika.clone(),
        sisalto: Some(serde_json::to_vec(arvo).unwrap_or_default()),
        poistettu: false,
    };
    kirjoita_yhdistajalla(t, &y, Yhdistaja::Lww)?;
    Ok(aika)
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
