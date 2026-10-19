//! HTTP-palvelin (S-6): Bearer-tunnistus, `GET /api/terveys` ja moduulien reittien kokoaminen.

use crate::muutosloki::{Result, Tapahtuma};
use crate::varasto::Varasto;
use crate::yksikko::{yhdistaja_polulle, Yhdistaja, Yksikko};
use crate::{lahde, lr, nakymat, peili, replikointi, silta, tila, virta};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// Solmun jaettu tila reittien käyttöön.
pub struct Tila {
    pub varasto: Arc<Varasto>,
    pub laite: String,
    pub headless: bool,
    pub avain: String,
    pub vanha: Option<String>,
    pub vanha_avain: Option<PathBuf>,
    pub vertaiset: Vec<String>,
    pub lr_vertainen: Option<String>,
    pub lahetin: broadcast::Sender<Tapahtuma>,
}

/// Keep-alive-väli tuotannossa (S-1).
pub const KEEP_ALIVE: Duration = Duration::from_secs(20);

/// Seinäkello millisekunteina Unix-ajasta.
pub fn kello_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Kirjoittaa yksikön annetulla yhdistäjällä ja ilmoittaa muutoksen virtaan (synkroninen runko).
pub fn kirjoita_yhdistajalla(tila: &Tila, y: &Yksikko, yh: Yhdistaja) -> Result<Option<u64>> {
    let seq = tila.varasto.kirjoita(y, yh)?;
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

/// Kirjoittaa yksikön polun yhdistäjällä ja ilmoittaa muutoksen virtaan.
pub async fn kirjoita_ja_ilmoita(tila: &Tila, y: &Yksikko) -> Result<Option<u64>> {
    kirjoita_yhdistajalla(tila, y, yhdistaja_polulle(&y.polku))
}

/// Vakioaikainen vertailu (jäljittelee palvelin.mjs:n `avainKelpaa`): kulku on salaisuuden pituinen.
fn sama_aika(annettu: &[u8], oikea: &[u8]) -> bool {
    let mut ero = annettu.len() ^ oikea.len();
    for (i, o) in oikea.iter().enumerate() {
        ero |= usize::from(annettu.get(i).copied().unwrap_or(0) ^ o);
    }
    ero == 0
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut ulos = String::with_capacity(data.len().div_ceil(3) * 4);
    for pala in data.chunks(3) {
        let a = u32::from(pala[0]);
        let b = u32::from(*pala.get(1).unwrap_or(&0));
        let c = u32::from(*pala.get(2).unwrap_or(&0));
        let n = (a << 16) | (b << 8) | c;
        ulos.push(T[(n >> 18) as usize & 63] as char);
        ulos.push(T[(n >> 12) as usize & 63] as char);
        ulos.push(if pala.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        ulos.push(if pala.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    ulos
}

/// Lukee avaimen tiedostosta; puuttuva tiedosto luodaan (48 satunnaistavua base64:nä, 0600).
pub fn lataa_avain(polku: &Path) -> std::io::Result<String> {
    match std::fs::read_to_string(polku) {
        Ok(s) => {
            let s = s.trim().to_string();
            if s.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "avaintiedosto on tyhjä",
                ));
            }
            Ok(s)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(kansio) = polku.parent() {
                std::fs::create_dir_all(kansio)?;
            }
            let mut tavut = [0u8; 48];
            std::fs::File::open("/dev/urandom")?.read_exact(&mut tavut)?;
            let avain = base64(&tavut);
            let luotu = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(polku);
            match luotu {
                Ok(mut f) => {
                    f.write_all(avain.as_bytes())?;
                    f.write_all(b"\n")?;
                    Ok(avain)
                }
                // Toinen prosessi ehti luoda tiedoston: käytetään sen avainta.
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => lataa_avain(polku),
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

async fn tunnista(State(t): State<Arc<Tila>>, req: Request, next: Next) -> Response {
    let annettu = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty());
    match annettu {
        Some(a) if sama_aika(a.as_bytes(), t.avain.as_bytes()) => next.run(req).await,
        _ => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"virhe": "avain puuttuu tai väärä"})),
        )
            .into_response(),
    }
}

async fn terveys(State(t): State<Arc<Tila>>) -> Response {
    match t.varasto.seq() {
        Ok(seq) => (
            [(header::CONTENT_TYPE, "application/json")],
            // Kenttäjärjestys kuten S-6:ssa.
            format!("{{\"ok\":true,\"v2\":true,\"seq\":{seq}}}"),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"virhe": e.to_string()})),
        )
            .into_response(),
    }
}

/// Koko reititin tuotannon keep-alive-välillä.
pub fn router(tila: Arc<Tila>) -> Router {
    router_valilla(tila, KEEP_ALIVE)
}

/// Kuten `router`, mutta SSE-keep-alive-väli annetaan (testit).
pub fn router_valilla(tila: Arc<Tila>, ka: Duration) -> Router {
    let suojatut = Router::new()
        .merge(virta::reitit_valilla(tila.clone(), ka))
        .merge(tila::reitit(tila.clone()))
        .merge(peili::reitit())
        .merge(lahde::reitit())
        .merge(nakymat::reitit())
        .merge(replikointi::reitit())
        .merge(lr::reitit())
        .fallback_service(silta::reitit())
        .layer(middleware::from_fn_with_state(tila.clone(), tunnista));
    Router::new()
        .route("/api/terveys", get(terveys))
        .with_state(tila)
        .merge(suojatut)
}
