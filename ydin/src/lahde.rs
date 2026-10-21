//! Lähdetila (S-5b): adapterin lähettämä laitekohtainen tila, `POST/GET /api/lahde/<laji>`.
//! Yksikkö: polku `lahde/<laji>`, id = laite, sisältö = JSON sellaisenaan (LWW, `Hlc::nyt`).

use crate::api::{kello_ms, kirjoita_yhdistajalla, Tila};
use crate::muutosloki::Result;
use crate::varasto::Varasto;
use crate::yksikko::{Hlc, Yhdistaja, Yksikko};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const LAJIT: [&str; 5] = ["istunnot", "agy", "android", "kayttoraja", "asetukset"];

/// Sarjoittaa lue-laske-kirjoita-jakson, jotta kaksi samanaikaista POST:ia ei saa samaa HLC:tä.
static KIRJOITUS: Mutex<()> = Mutex::new(());

pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new()
        .route("/api/lahde/:laji", get(hae).post(laheta))
        .with_state(tila)
}

fn virhe(koodi: StatusCode, teksti: &str) -> Response {
    (koodi, Json(json!({"virhe": teksti}))).into_response()
}

fn polku(laji: &str) -> String {
    format!("lahde/{laji}")
}

/// Lajin laitteet (laite, aika, sisältö) laitetunnuksen järjestyksessä; poistetut jätetään pois.
pub fn lue(varasto: &Varasto, laji: &str) -> Result<Vec<(String, Hlc, Value)>> {
    Ok(varasto
        .listaa(&polku(laji))?
        .into_iter()
        .filter(|y| !y.poistettu)
        .map(|y| {
            let arvo = y
                .sisalto
                .as_deref()
                .and_then(|b| serde_json::from_slice::<Value>(b).ok())
                .unwrap_or(Value::Null);
            (y.id, y.aika, arvo)
        })
        .collect())
}

fn kirjoita(t: &Tila, laji: &str, laite: &str, sisalto: &Value) -> Result<Hlc> {
    let _vuoro = KIRJOITUS.lock().unwrap_or_else(|e| e.into_inner());
    let p = polku(laji);
    let nykyinen = t.varasto.lue(&p, laite)?;
    let aika = Hlc::nyt(&t.laite, nykyinen.as_ref().map(|y| &y.aika), kello_ms());
    let mut versio = nykyinen.map(|y| y.versio).unwrap_or_default();
    *versio.entry(t.laite.clone()).or_insert(0) += 1;
    let y = Yksikko {
        polku: p,
        id: laite.to_string(),
        versio,
        aika: aika.clone(),
        sisalto: Some(serde_json::to_vec(sisalto).unwrap_or_default()),
        poistettu: false,
    };
    kirjoita_yhdistajalla(t, &y, Yhdistaja::Lww)?;
    Ok(aika)
}

async fn laheta(State(t): State<Arc<Tila>>, Path(laji): Path<String>, runko: Bytes) -> Response {
    if !LAJIT.contains(&laji.as_str()) {
        return virhe(StatusCode::BAD_REQUEST, "tuntematon laji");
    }
    let Ok(Value::Object(mut o)) = serde_json::from_slice::<Value>(&runko) else {
        return virhe(StatusCode::BAD_REQUEST, "runko ei ole JSON-olio");
    };
    let laite = match o.get("laite").and_then(Value::as_str) {
        Some(l) if !l.is_empty() => l.to_string(),
        _ => return virhe(StatusCode::BAD_REQUEST, "laite puuttuu"),
    };
    let Some(sisalto) = o.remove("sisalto") else {
        return virhe(StatusCode::BAD_REQUEST, "sisalto puuttuu");
    };
    match kirjoita(&t, &laji, &laite, &sisalto) {
        Ok(aika) => Json(json!({"aika": aika.to_string()})).into_response(),
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn hae(State(t): State<Arc<Tila>>, Path(laji): Path<String>) -> Response {
    if !LAJIT.contains(&laji.as_str()) {
        return virhe(StatusCode::BAD_REQUEST, "tuntematon laji");
    }
    match lue(&t.varasto, &laji) {
        Ok(laitteet) => {
            let lista: Vec<Value> = laitteet
                .into_iter()
                .map(|(laite, aika, sisalto)| {
                    json!({"laite": laite, "aika": aika.to_string(), "sisalto": sisalto})
                })
                .collect();
            Json(json!({"laitteet": lista})).into_response()
        }
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}
