//! Lukusilta vanhaan Node-palveluun (S-6): ydin välittää siltalistan reitit `--vanha`-osoitteeseen
//! vanhalla avaimella. Otsikot ja runko säilyvät, virrat (NDJSON/SSE) välitetään puskuroimatta.
//!
//! S-10 (T-64): `--adapteri <url>` -tilassa ydin kysyy adapterilta (`GET /api/terveys` → `reitit`),
//! mitkä reitit se on ottanut, ja välittää ne adapterille V2-avaimella. Muut sillattavat menevät
//! vanhalle kuten ennen. Ilman lippua käytös on ennallaan.

use crate::api::Tila;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::json;
use std::sync::{Arc, OnceLock, RwLock, Weak};
use std::time::Duration;

/// Adapterin tila (S-10): osoite (`--adapteri`) ja sen julkaisemat reittikuviot.
/// Oletus = ei adapteria.
#[derive(Default)]
pub struct Adapteri {
    /// Adapterin osoite; `None` = kaikki sillattavat vanhalle.
    pub url: Option<String>,
    /// Julkaistut kuviot; `None` = ei vielä yhtään onnistunutta hakua.
    pub reitit: RwLock<Option<Vec<String>>>,
}

/// Reittilistan hakuväli, kun lista on tunnettu.
const HAKUVALI: Duration = Duration::from_secs(60);
/// Hakuväli, kun lista on vielä tuntematon (adapteri käynnistyy ytimen jälkeen).
const HAKUVALI_TUNTEMATON: Duration = Duration::from_secs(5);
/// Yhden terveyshaun aikaraja.
const HAKU_AIKARAJA: Duration = Duration::from_secs(5);

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
    if tila.adapteri.url.is_some() {
        kaynnista_haku(&tila);
    }
    Router::new().fallback(kasittele).with_state(tila)
}

/// Käynnistää reittilistan taustahaun. Tehtävä päättyy, kun `Tila` on pudotettu.
fn kaynnista_haku(tila: &Arc<Tila>) {
    let Ok(kahva) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let tila: Weak<Tila> = Arc::downgrade(tila);
    kahva.spawn(async move {
        loop {
            let Some(t) = tila.upgrade() else {
                return;
            };
            let Some(url) = t.adapteri.url.clone() else {
                return;
            };
            let avain = t.avain.clone();
            drop(t);
            let uusi = hae_reitit(&url, &avain).await;
            let Some(t) = tila.upgrade() else {
                return;
            };
            let tunnettu = {
                let mut lista = t.adapteri.reitit.write().unwrap_or_else(|e| e.into_inner());
                // Epäonnistunut haku säilyttää edellisen listan.
                if uusi.is_some() {
                    *lista = uusi;
                }
                lista.is_some()
            };
            drop(t);
            tokio::time::sleep(if tunnettu {
                HAKUVALI
            } else {
                HAKUVALI_TUNTEMATON
            })
            .await;
        }
    });
}

/// `GET <url>/api/terveys` → `reitit`; `None`, jos haku tai tulkinta epäonnistuu.
async fn hae_reitit(url: &str, avain: &str) -> Option<Vec<String>> {
    let vastaus = asiakas()
        .get(format!("{}/api/terveys", url.trim_end_matches('/')))
        .bearer_auth(avain)
        .timeout(HAKU_AIKARAJA)
        .send()
        .await
        .ok()?;
    if !vastaus.status().is_success() {
        return None;
    }
    let j: serde_json::Value = vastaus.json().await.ok()?;
    let taulu = j.get("reitit")?.as_array()?;
    Some(
        taulu
            .iter()
            .filter_map(|k| k.as_str().map(str::to_string))
            .collect(),
    )
}

/// Täsmääkö yksi kuvio (`<METODI> <polku>`) pyyntöön? `*` = yksi ei-tyhjä polun osa,
/// loppu `/**` = etuliite (myös polku itse).
fn kuvio_tasmaa(kuvio: &str, metodi: &Method, polku: &str) -> bool {
    let Some((km, kp)) = kuvio.trim().split_once(' ') else {
        return false;
    };
    if !km.trim().eq_ignore_ascii_case(metodi.as_str()) {
        return false;
    }
    let kp = kp.trim();
    let (kosat, etuliite): (Vec<&str>, bool) = match kp.strip_suffix("/**") {
        Some(alku) => (alku.split('/').collect(), true),
        None => (kp.split('/').collect(), false),
    };
    let osat: Vec<&str> = polku.split('/').collect();
    if etuliite {
        if osat.len() < kosat.len() {
            return false;
        }
    } else if osat.len() != kosat.len() {
        return false;
    }
    kosat
        .iter()
        .zip(osat.iter())
        .all(|(k, o)| if *k == "*" { !o.is_empty() } else { k == o })
}

/// Onko pyyntö adapterin julkaisemien kuvioiden mukainen? (S-10; puhdas funktio.)
pub fn adapterin_reitti(kuviot: &[String], metodi: &Method, polku: &str) -> bool {
    kuviot.iter().any(|k| kuvio_tasmaa(k, metodi, polku))
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

/// `POST /api/skoopit/<nimi>/asetukset/<nimi>/<paalle|pois>` (kaksi lisäosaa, vanha iOS).
fn skoopin_asetuskytkin(polku: &str) -> bool {
    let Some(loppu) = polku.strip_prefix("/api/skoopit/") else {
        return false;
    };
    let osat: Vec<&str> = loppu.split('/').collect();
    matches!(osat.as_slice(), [nimi, "asetukset", asetus, tila]
        if !nimi.is_empty() && !asetus.is_empty() && matches!(*tila, "paalle" | "pois"))
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
    if post && skoopin_asetuskytkin(polku) {
        return true;
    }
    if let Some((_, Some(verbi))) = skoopin_polku(polku) {
        if post {
            return matches!(
                verbi,
                "viesti"
                    | "stream"
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

/// Mihin pyyntö välitetään.
#[derive(Clone, Copy)]
enum Kohde<'a> {
    /// Vanha 8787: vanha avain tiedostosta, `x-lahde: silta`.
    Vanha(&'a str),
    /// Adapteri: V2-avain, `x-lahde: adapteri`.
    Adapteri(&'a str),
}

impl Kohde<'_> {
    fn alas(&self) -> Response {
        match self {
            Kohde::Vanha(_) => silta_alas(),
            Kohde::Adapteri(url) => virhe_vastaus(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"virhe": "adapteri", "kohde": url}),
            ),
        }
    }
}

/// Ottaako adapteri tämän pyynnön? `GET /api/agentit` on väliaikainen johdettu reitti, mutta
/// menee adapterille, kun adapteri julkaisee sen. Lista tuntematon = ei.
fn adapterille(tila: &Tila, metodi: &Method, polku: &str) -> bool {
    if tila.adapteri.url.is_none() {
        return false;
    }
    let lista = tila
        .adapteri
        .reitit
        .read()
        .unwrap_or_else(|e| e.into_inner());
    let Some(kuviot) = lista.as_deref() else {
        return false;
    };
    let kelpaa = sillattava(metodi, polku) || (metodi == Method::GET && polku == "/api/agentit");
    kelpaa && adapterin_reitti(kuviot, metodi, polku)
}

/// Välittää pyynnön vanhalle (tai adapterille, kun se on ottanut reitin) ja palauttaa vastauksen virtana.
pub async fn valita(tila: &Tila, req: Request<Body>) -> Response {
    if let Some(url) = tila.adapteri.url.as_deref() {
        if adapterille(tila, req.method(), req.uri().path()) {
            return valita_kohteeseen(tila, Kohde::Adapteri(url), req).await;
        }
    }
    match tila.vanha.as_deref() {
        Some(kohde) => valita_kohteeseen(tila, Kohde::Vanha(kohde), req).await,
        None => silta_alas(),
    }
}

async fn valita_kohteeseen(tila: &Tila, kohde: Kohde<'_>, req: Request<Body>) -> Response {
    let (osoite, lahde) = match kohde {
        Kohde::Vanha(u) => (u, "silta"),
        Kohde::Adapteri(u) => (u, "adapteri"),
    };
    let (osat, runko) = req.into_parts();
    let pq = osat
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or_else(|| osat.uri.path());
    let url = format!("{}{pq}", osoite.trim_end_matches('/'));

    let mut pyynto = asiakas().request(osat.method.clone(), url);
    for nimi in PYYNTO_OTSIKOT {
        if let Some(arvo) = osat.headers.get(&nimi) {
            pyynto = pyynto.header(nimi, arvo.clone());
        }
    }
    if let Some(arvo) = osat.headers.get("last-event-id") {
        pyynto = pyynto.header("last-event-id", arvo.clone());
    }
    match kohde {
        // Avain luetaan joka pyynnöllä (vaihto ilman uudelleenkäynnistystä); sisältöä ei lokiteta.
        Kohde::Vanha(_) => {
            if let Some(polku) = tila.vanha_avain.as_deref() {
                let Ok(avain) = std::fs::read_to_string(polku) else {
                    return kohde.alas();
                };
                pyynto = pyynto.header(header::AUTHORIZATION, format!("Bearer {}", avain.trim()));
            }
        }
        // Adapterille menee vain ytimen oma V2-avain, ei vanhaa.
        Kohde::Adapteri(_) => {
            pyynto = pyynto.header(header::AUTHORIZATION, format!("Bearer {}", tila.avain));
        }
    }
    if osat.method != Method::GET && osat.method != Method::HEAD {
        pyynto = pyynto.body(reqwest::Body::wrap_stream(runko.into_data_stream()));
    }

    let vastaus = match pyynto.send().await {
        Ok(v) => v,
        Err(_) => return kohde.alas(),
    };
    let mut ulos = Response::builder().status(vastaus.status());
    for nimi in VASTAUS_OTSIKOT {
        if let Some(arvo) = vastaus.headers().get(&nimi) {
            ulos = ulos.header(nimi, arvo.clone());
        }
    }
    ulos = ulos.header("x-lahde", HeaderValue::from_static(lahde));
    ulos.body(Body::from_stream(vastaus.bytes_stream()))
        .unwrap_or_else(|_| kohde.alas())
}
