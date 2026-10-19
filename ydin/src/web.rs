//! Web-asiakkaan staattinen tarjoilu (S-7): `/web/*` ilman tunnistusta, `/` ohjaa `/web/`:iin.
//! Reitit liitetään valmiin reitittimen rinnalle, joten `/web/*` ei koskaan päädy sillan fallbackiin.

use axum::{
    extract::{Path as UrlPolku, Request, State},
    http::{header, HeaderName, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/// Tiedostopäätteen Content-Type; tuntematon pääte → `None` (tarjoillaan 404).
pub fn sisaltotyyppi(polku: &Path) -> Option<&'static str> {
    Some(match polku.extension()?.to_str()? {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => return None,
    })
}

/// `/` ja `/web/*`; `None` → `/web/*` vastaa 404 (ei siltaan).
pub fn reitit(hakemisto: Option<PathBuf>) -> Router {
    let hak = Arc::new(hakemisto);
    let web = Router::new()
        .route("/web/", get(indeksi))
        .route("/web/*polku", get(tiedosto))
        .with_state(hak)
        .layer(middleware::from_fn(otsakkeet));
    Router::new()
        .route(
            "/",
            get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/web/")]) }),
        )
        .merge(web)
}

/// Tietoturvaotsakkeet kaikkiin `/web/*`-vastauksiin (myös 404 ja 405).
async fn otsakkeet(req: Request, next: Next) -> Response {
    let mut v = next.run(req).await;
    let h = v.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        HeaderName::from_static("x-lahde"),
        HeaderValue::from_static("ydin"),
    );
    v
}

fn ei_loydy() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "application/json")],
        json!({"virhe": "tuntematon polku"}).to_string(),
    )
        .into_response()
}

async fn indeksi(State(hak): State<Arc<Option<PathBuf>>>) -> Response {
    palvele(&hak, "index.html").await
}

async fn tiedosto(
    State(hak): State<Arc<Option<PathBuf>>>,
    UrlPolku(polku): UrlPolku<String>,
) -> Response {
    palvele(&hak, &polku).await
}

async fn palvele(hak: &Option<PathBuf>, polku: &str) -> Response {
    let Some(juuri) = hak else {
        return ei_loydy();
    };
    if polku.is_empty() || polku.contains("..") || polku.starts_with('/') || polku.contains('\0') {
        return ei_loydy();
    }
    let pyydetty = juuri.join(polku);
    let Some(tyyppi) = sisaltotyyppi(&pyydetty) else {
        return ei_loydy();
    };
    // Kanonisoitu polku pysyy hakemiston sisällä (symlinkki ulos → 404).
    let (Ok(juuri_kan), Ok(kan)) = (
        tokio::fs::canonicalize(juuri).await,
        tokio::fs::canonicalize(&pyydetty).await,
    ) else {
        return ei_loydy();
    };
    if !kan.starts_with(&juuri_kan) {
        return ei_loydy();
    }
    match tokio::fs::metadata(&kan).await {
        Ok(m) if m.is_file() => {}
        _ => return ei_loydy(),
    }
    let Ok(sisalto) = tokio::fs::read(&kan).await else {
        return ei_loydy();
    };
    let nimi = pyydetty.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let valimuisti = if matches!(nimi, "index.html" | "sw.js" | "manifest.webmanifest") {
        "no-cache"
    } else {
        "max-age=300"
    };
    (
        [
            (header::CONTENT_TYPE, tyyppi),
            (header::CACHE_CONTROL, valimuisti),
        ],
        sisalto,
    )
        .into_response()
}
