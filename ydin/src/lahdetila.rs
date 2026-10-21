//! Lukureitit adapterin lähdetilasta (T-84, S-5b, S-6, ARK-16, ARK-19): `GET /api/asetukset`,
//! `GET /api/skoopit/<nimi>/asetukset`, `GET /api/kayttoraja` ja `GET /api/android`.
//! Ydin vastaa itse lajeista `asetukset`, `kayttoraja` ja `android` (uusin HLC voittaa laitteiden kesken).
//! Ydin ei kirjoita tilatiedostoja eikä aja adb:tä. Jos lähdeyksikköä ei ole, vastaus tulee sillasta
//! (`nakymat::sillasta`, X-Lahde: silta), joten käyttöönotto ei vaadi järjestystä adapterin kanssa.

use crate::api::Tila;
use crate::lahde;
use crate::nakymat;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new()
        .route("/api/asetukset", get(r_asetukset))
        .route("/api/skoopit/:nimi/asetukset", get(r_skoopin_asetukset))
        .route("/api/kayttoraja", get(r_kayttoraja))
        .route("/api/android", get(r_android))
        .with_state(tila)
}

/// Ytimen oma vastaus: `X-Lahde: ydin`.
fn ydin(koodi: StatusCode, runko: Value) -> Response {
    let mut r = (koodi, Json(runko)).into_response();
    r.headers_mut()
        .insert("x-lahde", HeaderValue::from_static("ydin"));
    r
}

fn virhe(koodi: StatusCode, teksti: &str) -> Response {
    ydin(koodi, json!({"virhe": teksti}))
}

/// Pyyntö sillalle muuttumattomana (polku ja kysely).
async fn sillalle(t: &Tila, uri: &Uri) -> Response {
    let pq = uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or_else(|| uri.path());
    nakymat::sillasta(t, pq, None).await.into_response()
}

/// Lajin uusimman laitteen sisältö (uusin HLC voittaa); `None`, jos yksikköä ei ole.
fn uusin(t: &Tila, laji: &str) -> Result<Option<Value>, String> {
    lahde::lue(&t.varasto, laji)
        .map(|l| l.into_iter().max_by(|a, b| a.1.cmp(&b.1)).map(|x| x.2))
        .map_err(|e| e.to_string())
}

fn sisainen(teksti: &str) -> Response {
    virhe(StatusCode::INTERNAL_SERVER_ERROR, teksti)
}

/// Epätyhjä kyselyparametri (JS: `searchParams.get(..)` tyhjänä on epätosi).
fn param<'a>(q: &'a HashMap<String, String>, avain: &str) -> Option<&'a str> {
    q.get(avain).map(String::as_str).filter(|s| !s.is_empty())
}

async fn r_asetukset(State(t): State<Arc<Tila>>, uri: Uri) -> Response {
    let sisalto = match uusin(&t, "asetukset") {
        Ok(s) => s,
        Err(e) => return sisainen(&e),
    };
    match sisalto.as_ref().and_then(|s| s.get("yhteiset")) {
        Some(y) => ydin(StatusCode::OK, y.clone()),
        None => sillalle(&t, &uri).await,
    }
}

/// `{istunto, istuntoja, ...istunnot[istunto]}` kuten vanha `{...v, ...lueIstunto(..)}`.
fn istunnon_asetukset(sisalto: &Value, istunto: &str, istuntoja: usize) -> Value {
    let mut o = Map::new();
    o.insert("istunto".into(), json!(istunto));
    o.insert("istuntoja".into(), json!(istuntoja));
    if let Some(Value::Object(i)) = sisalto.get("istunnot").and_then(|x| x.get(istunto)) {
        for (k, v) in i {
            o.insert(k.clone(), v.clone());
        }
    }
    Value::Object(o)
}

async fn r_skoopin_asetukset(
    State(t): State<Arc<Tila>>,
    Path(nimi): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    uri: Uri,
) -> Response {
    let sisalto = match uusin(&t, "asetukset") {
        Ok(Some(s)) => s,
        Ok(None) => return sillalle(&t, &uri).await,
        Err(e) => return sisainen(&e),
    };
    let (Some(Value::Object(skoopit)), Some(Value::Object(yhteiset))) =
        (sisalto.get("skoopit"), sisalto.get("yhteiset"))
    else {
        return sillalle(&t, &uri).await;
    };
    let Some(lista) = skoopit.get(&nimi) else {
        return virhe(StatusCode::NOT_FOUND, "tuntematon skooppi");
    };
    let avoimet: Vec<&str> = lista
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if let Some(haluttu) = param(&q, "istunto") {
        if !avoimet.contains(&haluttu) {
            return virhe(StatusCode::NOT_FOUND, "istuntoa ei löydy tästä skoopista");
        }
        return ydin(
            StatusCode::OK,
            istunnon_asetukset(&sisalto, haluttu, avoimet.len()),
        );
    }
    if let [yksi] = avoimet.as_slice() {
        return ydin(StatusCode::OK, istunnon_asetukset(&sisalto, yksi, 1));
    }
    // Ei yksiselitteistä istuntoa: yhteiset arvot; agyluvat on globaali, ei keskustelukohtainen.
    let mut o = Map::new();
    o.insert("istunto".into(), Value::Null);
    o.insert("istuntoja".into(), json!(avoimet.len()));
    for (k, v) in yhteiset {
        if k != "agyluvat" {
            o.insert(k.clone(), v.clone());
        }
    }
    ydin(StatusCode::OK, Value::Object(o))
}

/// Onko skoopilla alkio uusimmassa `lahde/agy`-listassa?
fn agy_skooppi(t: &Tila, skooppi: &str) -> Result<bool, String> {
    Ok(match uusin(t, "agy")? {
        Some(Value::Array(a)) => a
            .iter()
            .any(|i| i.get("skooppi").and_then(Value::as_str) == Some(skooppi)),
        _ => false,
    })
}

async fn r_kayttoraja(
    State(t): State<Arc<Tila>>,
    Query(q): Query<HashMap<String, String>>,
    uri: Uri,
) -> Response {
    let sisalto = match uusin(&t, "kayttoraja") {
        Ok(Some(s @ Value::Object(_))) => s,
        Ok(_) => return sillalle(&t, &uri).await,
        Err(e) => return sisainen(&e),
    };
    let tyyppi = param(&q, "tyyppi");
    let agentti = param(&q, "agentti");
    let skooppi = param(&q, "skooppi");
    if param(&q, "ryhma").is_some_and(|r| r != "gemini") {
        return virhe(StatusCode::NOT_FOUND, "ryhmä ei peilissä");
    }
    let mut on_agy = matches!(tyyppi, Some("agy" | "gemini"))
        || agentti.is_some_and(|a| {
            a == "android/gemini"
                || a.starts_with("agy")
                || a.starts_with("antigravity")
                || a.contains("gemini")
        });
    if !on_agy {
        if let Some(s) = skooppi {
            if tyyppi != Some("claude") && !agentti.is_some_and(|a| a.starts_with("claude")) {
                on_agy = match agy_skooppi(&t, s) {
                    Ok(b) => b,
                    Err(e) => return sisainen(&e),
                };
            }
        }
    }
    match sisalto.get(if on_agy { "agy" } else { "claude" }) {
        Some(arvo) if !arvo.is_null() => ydin(StatusCode::OK, arvo.clone()),
        _ => ydin(
            StatusCode::BAD_GATEWAY,
            json!({"virhe": "kayttoraja", "kohde": "adapteri"}),
        ),
    }
}

async fn r_android(State(t): State<Arc<Tila>>, uri: Uri) -> Response {
    match uusin(&t, "android") {
        Ok(Some(s)) => ydin(StatusCode::OK, s),
        Ok(None) => sillalle(&t, &uri).await,
        Err(e) => sisainen(&e),
    }
}
