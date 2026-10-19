//! `GET /api/virta` (S-1): muutoslokin SSE-virta. Broadcast herättää; tapahtumat luetaan
//! varaston lokista `seq`-järjestyksessä, joten virrassa ei ole aukkoja eikä järjestysvirheitä.

use crate::api::{Tila, KEEP_ALIVE};
use crate::muutosloki::Tapahtuma;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::get,
    Json, Router,
};
use futures::stream;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::{self, error::RecvError};

#[derive(Clone)]
struct Asetus {
    tila: Arc<Tila>,
    ka: Duration,
}

pub fn reitit(tila: Arc<Tila>) -> Router {
    reitit_valilla(tila, KEEP_ALIVE)
}

/// Kuten `reitit`, mutta keep-alive-väli annetaan (testit).
pub fn reitit_valilla(tila: Arc<Tila>, ka: Duration) -> Router {
    Router::new()
        .route("/api/virta", get(virta))
        .with_state(Asetus { tila, ka })
}

struct Virta {
    tila: Arc<Tila>,
    rx: broadcast::Receiver<Tapahtuma>,
    viimeinen: u64,
    jono: VecDeque<Tapahtuma>,
    nollaus: Option<u64>,
}

fn virhe(koodi: StatusCode, teksti: &str) -> Response {
    (koodi, Json(json!({"virhe": teksti}))).into_response()
}

async fn virta(
    State(a): State<Asetus>,
    Query(kysely): Query<HashMap<String, String>>,
    otsikot: HeaderMap,
) -> Response {
    // Otsikko voittaa, jos molemmat on annettu; virheellinen otsikko ohitetaan.
    let otsikosta = otsikot
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let since = match (otsikosta, kysely.get("since")) {
        (Some(n), _) => Some(n),
        (None, Some(s)) => match s.parse::<u64>() {
            Ok(n) => Some(n),
            Err(_) => return virhe(StatusCode::BAD_REQUEST, "since ei ole luku"),
        },
        (None, None) => None,
    };
    // Tilaus ennen lokin lukua: väliin osuva kirjoitus herättää virran.
    let rx = a.tila.lahetin.subscribe();
    let v = &a.tila.varasto;
    let nykyinen = match v.seq() {
        Ok(n) => n,
        Err(e) => return virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let (viimeinen, nollaus) = match since {
        None => (nykyinen, None),
        // Asiakas on lokia edellä (varasto vaihtunut): se hakee listat uudelleen.
        Some(s) if s > nykyinen => (nykyinen, Some(nykyinen)),
        Some(s) if s == nykyinen => (s, None),
        Some(s) => match v.loki(0, 1) {
            Ok(rivit) => match rivit.first() {
                Some(eka) if s + 1 < eka.seq => (nykyinen, Some(nykyinen)),
                _ => (s, None),
            },
            Err(e) => return virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        },
    };
    let alku = Virta {
        tila: a.tila.clone(),
        rx,
        viimeinen,
        jono: VecDeque::new(),
        nollaus,
    };
    let virta = stream::unfold(alku, |mut s| async move {
        if let Some(n) = s.nollaus.take() {
            let e = Event::default()
                .event("nollaus")
                .data(format!("{{\"seq\":{n}}}"));
            return Some((Ok::<Event, Infallible>(e), s));
        }
        loop {
            if let Some(t) = s.jono.pop_front() {
                let e = Event::default()
                    .id(t.seq.to_string())
                    .event("muutos")
                    .data(serde_json::to_string(&t).unwrap_or_default());
                return Some((Ok(e), s));
            }
            match s.tila.varasto.loki(s.viimeinen, 200) {
                Ok(erä) if !erä.is_empty() => {
                    s.viimeinen = erä.last().map_or(s.viimeinen, |t| t.seq);
                    // S-5: "peili-offset" on sisäinen yksikkö, ei virtaan
                    s.jono
                        .extend(erä.into_iter().filter(|t| t.polku != "peili-offset"));
                    continue;
                }
                Ok(_) => {}
                Err(_) => return None,
            }
            match s.rx.recv().await {
                Ok(_) | Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return None,
            }
        }
    });
    let sse = Sse::new(virta).keep_alive(KeepAlive::new().interval(a.ka).text("ka"));
    (
        [(
            HeaderName::from_static("x-accel-buffering"),
            HeaderValue::from_static("no"),
        )],
        sse,
    )
        .into_response()
}
