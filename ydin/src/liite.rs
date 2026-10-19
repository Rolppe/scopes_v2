//! Liitteet ytimen reitillä (S-8b): `POST /api/skoopit/<nimi>/liite`, `PUT /api/liitteet/<sha>` ja
//! `GET /api/liite/<sha>`. Tiedosto talletetaan polkuun `<data>/liitteet/<sha>/<tiedosto>`, kirjataan
//! `liitteet`-tauluun ja `liitteet`-yksikkönä muutoslokiin. POST työntää tavut synkronisesti
//! ensimmäiselle tavoitettavalle vertaiselle, jolloin vastauksen polku on vertaisen (palvelimen) polku.

use crate::api::{kello_ms, kirjoita_yhdistajalla, Tila};
use crate::vertaiset::vertaiset;
use crate::yksikko::{Hlc, Yhdistaja, Yksikko};
use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Liitteen enimmäiskoko tavuina (25 Mt).
pub const RAJA: usize = 25 * 1024 * 1024;
/// Työnnön aikaraja vertaista kohti.
const TYONTO_AIKARAJA: Duration = Duration::from_secs(60);
/// Yksikköpolku.
pub const POLKU: &str = "liitteet";

static LASKURI: AtomicU64 = AtomicU64::new(0);

pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new()
        .route("/api/skoopit/:nimi/liite", post(laheta))
        .route("/api/liitteet/:sha", put(vastaanota))
        .route("/api/liite/:sha", get(hae))
        .with_state(tila)
}

fn virhe(koodi: StatusCode, teksti: &str) -> Response {
    (koodi, Json(json!({"virhe": teksti}))).into_response()
}

/// Tiedostonimi: merkit `[A-Za-z0-9._-]`, muut `_`; tyhjä, `.` ja `..` → `liite`.
pub fn puhdista_nimi(nimi: &str) -> String {
    let s: String = nimi
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(200)
        .collect();
    if s.is_empty() || s == "." || s == ".." {
        "liite".to_string()
    } else {
        s
    }
}

fn paate_tyyppi(nimi: &str) -> Option<&'static str> {
    let (_, p) = nimi.rsplit_once('.')?;
    match p.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "pdf" => Some("application/pdf"),
        "txt" => Some("text/plain"),
        "md" => Some("text/markdown"),
        "json" => Some("application/json"),
        _ => None,
    }
}

/// Content-Type-otsake, jos se ei ole `application/octet-stream`; muuten päätteestä tai `None`.
fn tyyppi(ct: Option<&str>, nimi: &str) -> Option<String> {
    match ct.map(str::trim) {
        Some(t)
            if !t.is_empty()
                && !t
                    .to_ascii_lowercase()
                    .starts_with("application/octet-stream") =>
        {
            Some(t.to_string())
        }
        _ => paate_tyyppi(nimi).map(str::to_string),
    }
}

fn sha_heksana(tavut: &[u8]) -> String {
    Sha256::digest(tavut)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Lukee rungon rajaan asti; `Err` = liian suuri tai lukuvirhe.
async fn lue_runko(req: Request) -> Result<(Option<String>, Vec<u8>), Box<Response>> {
    let ct = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let runko: Body = req.into_body();
    match axum::body::to_bytes(runko, RAJA).await {
        Ok(b) => Ok((ct, b.to_vec())),
        Err(_) => Err(Box::new(virhe(
            StatusCode::PAYLOAD_TOO_LARGE,
            "liian suuri",
        ))),
    }
}

struct Talletettu {
    polku: PathBuf,
    koko: usize,
}

/// Tallettaa tiedoston, taulurivin ja yksikön. Kirjoitus väliaikaistiedostoon ja `rename`.
fn talleta(
    tila: &Tila,
    sha: &str,
    nimi: &str,
    tavut: &[u8],
    tyyppi: Option<&str>,
    skooppi: Option<&str>,
) -> Result<Talletettu, String> {
    let data = tila.varasto.data().ok_or_else(|| "data".to_string())?;
    let data = if data.as_os_str().is_empty() {
        std::path::Path::new(".")
    } else {
        data
    };
    let kansio = data.join("liitteet").join(sha);
    std::fs::create_dir_all(&kansio).map_err(|e| e.to_string())?;
    let kansio = kansio.canonicalize().map_err(|e| e.to_string())?;
    let kohde = kansio.join(nimi);
    let vaihe = kansio.join(format!(
        ".{nimi}.tmp-{}-{}",
        std::process::id(),
        LASKURI.fetch_add(1, Ordering::SeqCst)
    ));
    if let Err(e) = std::fs::write(&vaihe, tavut).and_then(|_| std::fs::rename(&vaihe, &kohde)) {
        let _ = std::fs::remove_file(&vaihe);
        return Err(e.to_string());
    }
    let suhteellinen = format!("liitteet/{sha}/{nimi}");
    let c = Connection::open(data.join("ydin.db")).map_err(|e| e.to_string())?;
    c.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT OR IGNORE INTO liitteet (sha256, koko, tyyppi, polku) VALUES (?1, ?2, ?3, ?4)",
        params![sha, tavut.len() as i64, tyyppi, suhteellinen],
    )
    .map_err(|e| e.to_string())?;
    drop(c);
    let sisalto = json!({
        "nimi": nimi,
        "koko": tavut.len(),
        "tyyppi": tyyppi,
        "skooppi": skooppi,
    });
    let mut versio = BTreeMap::new();
    versio.insert(tila.laite.clone(), 1u64);
    let y = Yksikko {
        polku: POLKU.to_string(),
        id: sha.to_string(),
        versio,
        aika: Hlc::nyt(&tila.laite, None, kello_ms()),
        sisalto: Some(serde_json::to_vec(&sisalto).map_err(|e| e.to_string())?),
        poistettu: false,
    };
    kirjoita_yhdistajalla(tila, &y, Yhdistaja::Lisays).map_err(|e| e.to_string())?;
    Ok(Talletettu {
        polku: kohde,
        koko: tavut.len(),
    })
}

fn vastaus(t: &Talletettu, sha: &str, laite: &str) -> Value {
    json!({
        "polku": t.polku.to_string_lossy(),
        "koko": t.koko,
        "sha256": sha,
        "solmu": laite,
    })
}

async fn talleta_taustalla(
    tila: Arc<Tila>,
    sha: String,
    nimi: String,
    tavut: Arc<Vec<u8>>,
    tyyppi: Option<String>,
    skooppi: Option<String>,
) -> Result<Talletettu, Box<Response>> {
    let tulos = tokio::task::spawn_blocking(move || {
        talleta(
            &tila,
            &sha,
            &nimi,
            &tavut,
            tyyppi.as_deref(),
            skooppi.as_deref(),
        )
    })
    .await;
    match tulos {
        Ok(Ok(t)) => Ok(t),
        Ok(Err(e)) if e == "data" => {
            Err(Box::new(virhe(StatusCode::INTERNAL_SERVER_ERROR, "data")))
        }
        Ok(Err(e)) => Err(Box::new(virhe(StatusCode::INTERNAL_SERVER_ERROR, &e))),
        Err(e) => Err(Box::new(virhe(
            StatusCode::INTERNAL_SERVER_ERROR,
            &e.to_string(),
        ))),
    }
}

async fn laheta(
    State(tila): State<Arc<Tila>>,
    Path(skooppi): Path<String>,
    Query(kysely): Query<HashMap<String, String>>,
    req: Request,
) -> Response {
    let (ct, tavut) = match lue_runko(req).await {
        Ok(x) => x,
        Err(v) => return *v,
    };
    let nimi = puhdista_nimi(kysely.get("nimi").map_or("", String::as_str));
    let sha = sha_heksana(&tavut);
    let tyyppi = tyyppi(ct.as_deref(), &nimi);
    let tavut = Arc::new(tavut);
    let paikallinen = match talleta_taustalla(
        tila.clone(),
        sha.clone(),
        nimi.clone(),
        tavut.clone(),
        tyyppi,
        Some(skooppi),
    )
    .await
    {
        Ok(t) => t,
        Err(v) => return *v,
    };
    let peers = vertaiset(&tila);
    if peers.is_empty() {
        return Json(vastaus(&paikallinen, &sha, &tila.laite)).into_response();
    }
    let http = match reqwest::Client::builder().timeout(TYONTO_AIKARAJA).build() {
        Ok(h) => h,
        Err(e) => return virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let mut viimeisin = String::new();
    for v in peers {
        let url = format!("{}/api/liitteet/{sha}", v.osoite);
        viimeisin = url.clone();
        let r = http
            .put(&url)
            .query(&[("nimi", nimi.as_str())])
            .bearer_auth(&v.avain)
            .body(tavut.as_ref().clone())
            .send()
            .await;
        match r {
            Ok(r) if r.status() == reqwest::StatusCode::OK => {
                if let Ok(j) = r.json::<Value>().await {
                    return Json(j).into_response();
                }
            }
            // Vain tila ja virheteksti; avainta ei lokiteta.
            Ok(r) => eprintln!("liite: työntö {url} -> {}", r.status()),
            Err(e) => eprintln!("liite: työntö {url} epäonnistui: {e}"),
        }
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"virhe": "vertainen", "kohde": viimeisin})),
    )
        .into_response()
}

async fn vastaanota(
    State(tila): State<Arc<Tila>>,
    Path(sha): Path<String>,
    Query(kysely): Query<HashMap<String, String>>,
    req: Request,
) -> Response {
    let (ct, tavut) = match lue_runko(req).await {
        Ok(x) => x,
        Err(v) => return *v,
    };
    let laskettu = sha_heksana(&tavut);
    if !laskettu.eq_ignore_ascii_case(&sha) {
        return virhe(StatusCode::UNPROCESSABLE_ENTITY, "tiiviste");
    }
    let nimi = puhdista_nimi(kysely.get("nimi").map_or("", String::as_str));
    let tyyppi = tyyppi(ct.as_deref(), &nimi);
    match talleta_taustalla(
        tila.clone(),
        laskettu.clone(),
        nimi,
        Arc::new(tavut),
        tyyppi,
        None,
    )
    .await
    {
        Ok(t) => Json(vastaus(&t, &laskettu, &tila.laite)).into_response(),
        Err(v) => *v,
    }
}

/// (polku suhteessa dataan, tyyppi) `liitteet`-taulusta.
fn hae_rivi(data: &std::path::Path, sha: &str) -> Result<Option<(String, Option<String>)>, String> {
    let c = Connection::open(data.join("ydin.db")).map_err(|e| e.to_string())?;
    c.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    c.query_row(
        "SELECT polku, tyyppi FROM liitteet WHERE sha256 = ?1",
        params![sha],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

async fn hae(State(tila): State<Arc<Tila>>, Path(sha): Path<String>) -> Response {
    let Some(data) = tila.varasto.data() else {
        return virhe(StatusCode::INTERNAL_SERVER_ERROR, "data");
    };
    let data = if data.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        data.to_path_buf()
    };
    let sha = sha.to_ascii_lowercase();
    let tulos = tokio::task::spawn_blocking(move || {
        let Some((polku, tyyppi)) = hae_rivi(&data, &sha)? else {
            return Ok(None);
        };
        match std::fs::read(data.join(polku)) {
            Ok(b) => Ok(Some((b, tyyppi))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await;
    match tulos {
        Ok(Ok(Some((tavut, tyyppi)))) => (
            [(
                header::CONTENT_TYPE,
                tyyppi.unwrap_or_else(|| "application/octet-stream".to_string()),
            )],
            tavut,
        )
            .into_response(),
        Ok(Ok(None)) => virhe(StatusCode::NOT_FOUND, "tuntematon liite"),
        Ok(Err(e)) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e),
        Err(e) => virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}
