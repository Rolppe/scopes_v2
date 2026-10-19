//! Lukusilta vanhaan Node-palveluun (S-6): ydin välittää siltalistan reitit `--vanha`-osoitteeseen
//! vanhalla avaimella. Otsikot ja runko säilyvät, virrat (NDJSON/SSE) välitetään puskuroimatta.

use crate::api::Tila;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::json;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Pyyntöotsikot, jotka välitetään vanhalle.
const PYYNTO_OTSIKOT: [HeaderName; 2] = [header::CONTENT_TYPE, header::ACCEPT];
/// Vastausotsikot, jotka välitetään takaisin.
const VASTAUS_OTSIKOT: [HeaderName; 4] = [
    header::CONTENT_TYPE,
    header::CONTENT_LENGTH,
    header::CACHE_CONTROL,
    header::CONTENT_DISPOSITION,
];

/// Reititin, jonka fallback välittää siltalistan pyynnöt vanhalle.
pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new().fallback(kasittele).with_state(tila)
}

/// Polku vastaa etuliitettä: täsmälleen tai alipolkuna (`/api/chat` ja `/api/chat/virta`).
fn etuliite(polku: &str, alku: &str) -> bool {
    polku == alku
        || polku
            .strip_prefix(alku)
            .is_some_and(|loppu| loppu.starts_with('/'))
}

/// Pilkkoo `/api/skoopit/<nimi>/<loppu>` osiin; `nimi` on yksi ei-tyhjä segmentti.
fn skoopin_polku(polku: &str) -> Option<(&str, Option<&str>)> {
    let loppu = polku.strip_prefix("/api/skoopit/")?;
    match loppu.split_once('/') {
        Some((nimi, rest)) if !nimi.is_empty() && !rest.is_empty() && !rest.contains('/') => {
            Some((nimi, Some(rest)))
        }
        None if !loppu.is_empty() => Some((loppu, None)),
        _ => None,
    }
}

/// S-6:n siltalista: metodi + polku.
pub fn sillattava(metodi: &Method, polku: &str) -> bool {
    let get = metodi == Method::GET;
    let post = metodi == Method::POST;
    if !get && !post {
        return false;
    }
    if post && polku == "/api/uusi" {
        return true;
    }
    if let Some((_, Some(verbi))) = skoopin_polku(polku) {
        if post {
            return matches!(
                verbi,
                "viesti"
                    | "stream"
                    | "liite"
                    | "stop"
                    | "malli"
                    | "kysymys-pois"
                    | "pura"
                    | "pakkaa"
                    | "automaattisiirto"
                    | "herata"
                    | "herata-pois"
                    | "arkistoi"
            );
        }
        return verbi == "asetukset";
    }
    if get && matches!(polku, "/api/purkajat" | "/api/kayttoraja" | "/api/viat") {
        return true;
    }
    if polku == "/api/diagnostiikka" {
        return true;
    }
    [
        "/api/asetukset",
        "/api/android",
        "/api/palvelin",
        "/api/chat",
        "/api/kordinaattori",
    ]
    .iter()
    .any(|alku| etuliite(polku, alku))
}

/// Johdetut reitit, jotka vastaavat tässä vaiheessa sillasta fallbackina (väliaikainen, GET).
fn valiaikainen(metodi: &Method, polku: &str) -> bool {
    if metodi != Method::GET {
        return false;
    }
    if polku == "/api/skoopit" || polku == "/api/agentit" || etuliite(polku, "/api/rekisterit") {
        return true;
    }
    match skoopin_polku(polku) {
        Some((_, None)) => true,
        Some((_, Some(verbi))) => verbi == "viestit",
        None => false,
    }
}

fn virhe_vastaus(status: StatusCode, runko: serde_json::Value) -> Response {
    (status, Json(runko)).into_response()
}

fn silta_alas() -> Response {
    virhe_vastaus(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"virhe": "silta", "kohde": "8787"}),
    )
}

async fn kasittele(State(tila): State<Arc<Tila>>, req: Request<Body>) -> Response {
    let polku = req.uri().path();
    if !sillattava(req.method(), polku) && !valiaikainen(req.method(), polku) {
        return virhe_vastaus(StatusCode::NOT_FOUND, json!({"virhe": "tuntematon polku"}));
    }
    valita(&tila, req).await
}

fn asiakas() -> &'static reqwest::Client {
    static ASIAKAS: OnceLock<reqwest::Client> = OnceLock::new();
    ASIAKAS.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest-asiakas")
    })
}

/// Välittää pyynnön vanhalle ja palauttaa sen vastauksen virtana.
pub async fn valita(tila: &Tila, req: Request<Body>) -> Response {
    let Some(kohde) = tila.vanha.as_deref() else {
        return silta_alas();
    };
    let (osat, runko) = req.into_parts();
    let pq = osat
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or_else(|| osat.uri.path());
    let url = format!("{}{pq}", kohde.trim_end_matches('/'));

    let mut pyynto = asiakas().request(osat.method.clone(), url);
    for nimi in PYYNTO_OTSIKOT {
        if let Some(arvo) = osat.headers.get(&nimi) {
            pyynto = pyynto.header(nimi, arvo.clone());
        }
    }
    if let Some(arvo) = osat.headers.get("last-event-id") {
        pyynto = pyynto.header("last-event-id", arvo.clone());
    }
    // Avain luetaan joka pyynnöllä (vaihto ilman uudelleenkäynnistystä); sisältöä ei lokiteta.
    if let Some(polku) = tila.vanha_avain.as_deref() {
        let Ok(avain) = std::fs::read_to_string(polku) else {
            return silta_alas();
        };
        pyynto = pyynto.header(header::AUTHORIZATION, format!("Bearer {}", avain.trim()));
    }
    if osat.method != Method::GET && osat.method != Method::HEAD {
        pyynto = pyynto.body(reqwest::Body::wrap_stream(runko.into_data_stream()));
    }

    let vastaus = match pyynto.send().await {
        Ok(v) => v,
        Err(_) => return silta_alas(),
    };
    let mut ulos = Response::builder().status(vastaus.status());
    for nimi in VASTAUS_OTSIKOT {
        if let Some(arvo) = vastaus.headers().get(&nimi) {
            ulos = ulos.header(nimi, arvo.clone());
        }
    }
    ulos = ulos.header("x-lahde", HeaderValue::from_static("silta"));
    ulos.body(Body::from_stream(vastaus.bytes_stream()))
        .unwrap_or_else(|_| silta_alas())
}
