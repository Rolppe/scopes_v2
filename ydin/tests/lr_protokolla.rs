//! LR-protokollan sopimustestit (T-31-G, ARK-12): mock-LR-1 vastaa vanhan `/api/lr/*`-reitteihin
//! vanhasta 8787:stä tallennetuilla fixtureilla (`tests/lr_fixture/`), ja testit määrittävät, mitä
//! `lr.rs`:n (T-32) on tuotettava. Punaisia (`todo!()`) T-32:een asti.
//!
//! Mock palvelee vain fixturen kolmea rekisteriä: `tiiviste` rajataan niihin (muuten ydin pyytäisi
//! listat jokaisesta ~200 rekisteristä eikä toinen synkka voisi olla hiljainen).
//! Fixtureissa ei ole rinnakkaisia eikä poistettuja rivejä; rinnakkaisten tallennus (`<id>~<laite>`)
//! on T-32:n omissa testeissä (`tests/lr.rs`).
//! Varaus: id, joka alkaa `_`:lla (esim. rekisterin meta, jota LR-tiiviste tarvitsee), ei ole fixturen
//! rivi; testit ohittavat sellaiset.

use scopes_ydin::api::{self, Tila};
use scopes_ydin::lr;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::vertaiset::Vertainen;
use scopes_ydin::yksikko::Versio;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";
/// Mock-LR-1:n Bearer-avain.
const LR_AVAIN: &str = "koe";

fn aja<F: Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn fixture(nimi: &str) -> Value {
    let polku = format!(
        "{}/tests/lr_fixture/{nimi}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let teksti = std::fs::read_to_string(&polku).unwrap_or_else(|e| panic!("{polku}: {e}"));
    serde_json::from_str(&teksti).unwrap_or_else(|e| panic!("{polku}: {e}"))
}

/// Fixturen kolme rekisteriä: (numero, rekisteripolku) numerojärjestyksessä.
fn polut() -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = fixture("polut")
        .as_object()
        .unwrap()
        .iter()
        .map(|(n, p)| (n.clone(), p.as_str().unwrap().to_string()))
        .collect();
    v.sort();
    assert_eq!(v.len(), 3);
    v
}

// ---- Mock-LR-1 --------------------------------------------------------------------------------------

#[derive(Default)]
struct Laskurit {
    tiiviste: AtomicUsize,
    listat: AtomicUsize,
    hae: AtomicUsize,
    teksti: AtomicUsize,
    laheta: AtomicUsize,
}

struct Mock {
    tiiviste: Value,
    listat: Value,
    hae: BTreeMap<String, Value>,
    teksti: BTreeMap<String, Value>,
    laskurit: Laskurit,
}

type MockTila = Arc<Mock>;

fn luvaton(otsikot: &HeaderMap) -> Option<Response> {
    let odotettu = format!("Bearer {LR_AVAIN}");
    let ok = otsikot
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == odotettu);
    (!ok).then(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"virhe": "avain puuttuu tai väärä"})),
        )
            .into_response()
    })
}

async fn mock_tiiviste(State(m): State<MockTila>, otsikot: HeaderMap) -> Response {
    if let Some(v) = luvaton(&otsikot) {
        return v;
    }
    m.laskurit.tiiviste.fetch_add(1, Ordering::SeqCst);
    Json(m.tiiviste.clone()).into_response()
}

async fn mock_listat(
    State(m): State<MockTila>,
    otsikot: HeaderMap,
    Json(runko): Json<Value>,
) -> Response {
    if let Some(v) = luvaton(&otsikot) {
        return v;
    }
    m.laskurit.listat.fetch_add(1, Ordering::SeqCst);
    let Some(pyydetyt) = runko["rekisterit"].as_array() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"virhe": "rekisterit puuttuu"})),
        )
            .into_response();
    };
    let mut ulos = serde_json::Map::new();
    for p in pyydetyt.iter().filter_map(Value::as_str) {
        if let Some(l) = m.listat.get(p) {
            ulos.insert(p.to_string(), l.clone());
        }
    }
    Json(Value::Object(ulos)).into_response()
}

async fn mock_hae(
    State(m): State<MockTila>,
    otsikot: HeaderMap,
    Json(runko): Json<Value>,
) -> Response {
    if let Some(v) = luvaton(&otsikot) {
        return v;
    }
    m.laskurit.hae.fetch_add(1, Ordering::SeqCst);
    let Some(rekisteri) = runko["rekisteri"].as_str() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"virhe": "rekisteri puuttuu"})),
        )
            .into_response();
    };
    let Some(kaikki) = m.hae.get(rekisteri) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"virhe": "tuntematon rekisteri"})),
        )
            .into_response();
    };
    let idt: BTreeSet<&str> = runko["idt"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let yksikot: Vec<Value> = kaikki["yksikot"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|y| idt.contains(y["id"].as_str().unwrap_or_default()))
        .cloned()
        .collect();
    Json(json!({ "yksikot": yksikot })).into_response()
}

async fn mock_teksti(
    State(m): State<MockTila>,
    otsikot: HeaderMap,
    Path(polku): Path<String>,
) -> Response {
    if let Some(v) = luvaton(&otsikot) {
        return v;
    }
    m.laskurit.teksti.fetch_add(1, Ordering::SeqCst);
    match m.teksti.get(&polku) {
        Some(t) => Json(t.clone()).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"virhe": "tuntematon rekisteri"})),
        )
            .into_response(),
    }
}

/// Lukutila ei saa lähettää: laskee kutsun ja vastaa 500.
async fn mock_laheta(State(m): State<MockTila>) -> Response {
    m.laskurit.laheta.fetch_add(1, Ordering::SeqCst);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"virhe": "laheta kielletty (lukutila)"})),
    )
        .into_response()
}

/// `tiivisteet()`-juuri (lr.mjs:380): sha256 riveistä `<polku>:<tiiviste>` polkujärjestyksessä.
fn juuri(rekisterit: &serde_json::Map<String, Value>) -> String {
    let mut avaimet: Vec<&String> = rekisterit.keys().collect();
    avaimet.sort();
    let teksti = avaimet
        .iter()
        .map(|p| format!("{p}:{}", rekisterit[*p].as_str().unwrap()))
        .collect::<Vec<_>>()
        .join("\n");
    Sha256::digest(teksti.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct MockPalvelin {
    mock: MockTila,
    osoite: String,
}

impl MockPalvelin {
    async fn kaynnista() -> MockPalvelin {
        let polut = polut();
        let mut tiiviste = fixture("tiiviste");
        let kaikki = tiiviste["rekisterit"].as_object().unwrap().clone();
        let mut rajattu = serde_json::Map::new();
        for (_, p) in &polut {
            rajattu.insert(p.clone(), kaikki[p].clone());
        }
        tiiviste["juuri"] = Value::String(juuri(&rajattu));
        tiiviste["rekisterit"] = Value::Object(rajattu);
        let mut hae = BTreeMap::new();
        let mut teksti = BTreeMap::new();
        for (n, p) in &polut {
            hae.insert(p.clone(), fixture(&format!("hae-{n}")));
            teksti.insert(p.clone(), fixture(&format!("teksti-{n}")));
        }
        let mock = Arc::new(Mock {
            tiiviste,
            listat: fixture("listat"),
            hae,
            teksti,
            laskurit: Laskurit::default(),
        });
        let app = Router::new()
            .route("/api/lr/tiiviste", get(mock_tiiviste))
            .route("/api/lr/listat", post(mock_listat))
            .route("/api/lr/hae", post(mock_hae))
            .route("/api/lr/teksti/*polku", get(mock_teksti))
            .route("/api/lr/laheta", post(mock_laheta))
            .with_state(mock.clone());
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        MockPalvelin { mock, osoite }
    }

    fn vertainen(&self) -> Vertainen {
        Vertainen::osoitteesta(&self.osoite, LR_AVAIN).unwrap()
    }

    fn listat_ja_hae(&self) -> (usize, usize) {
        let l = &self.mock.laskurit;
        (
            l.listat.load(Ordering::SeqCst),
            l.hae.load(Ordering::SeqCst),
        )
    }

    fn laheta(&self) -> usize {
        self.mock.laskurit.laheta.load(Ordering::SeqCst)
    }
}

// ---- Ydin ---------------------------------------------------------------------------------------------

/// Väliaikainen tietokantatiedosto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("lr-protokolla-{}-{n}.db", std::process::id())))
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        for pääte in ["", "-wal", "-shm"] {
            let mut s = self.0.clone().into_os_string();
            s.push(pääte);
            let _ = std::fs::remove_file(s);
        }
    }
}

struct Ydin {
    _tmp: Tmp,
    tila: Arc<Tila>,
    osoite: String,
}

impl Ydin {
    /// Tyhjä varasto ja ytimen HTTP-palvelin satunnaisportissa.
    async fn kaynnista() -> Ydin {
        let tmp = Tmp::uusi();
        let varasto = Arc::new(Varasto::avaa(&tmp.0).unwrap());
        let (lahetin, _) = tokio::sync::broadcast::channel(64);
        let tila = Arc::new(Tila {
            varasto,
            laite: "koe".to_string(),
            headless: false,
            avain: AVAIN.to_string(),
            vanha: None,
            vanha_avain: None,
            vertaiset: vec![],
            lr_vertainen: None,
            lahetin,
        });
        let app = api::router_valilla(tila.clone(), Duration::from_millis(100));
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        Ydin {
            _tmp: tmp,
            tila,
            osoite,
        }
    }

    async fn synkkaa(&self, mock: &MockPalvelin) -> lr::Yhteenveto {
        lr::synkkaa(&self.tila, &mock.vertainen())
            .await
            .unwrap_or_else(|e| panic!("synkkaa: {e}"))
    }
}

/// Ydin, jonka varasto on synkattu mockista kerran.
async fn synkattu() -> (MockPalvelin, Ydin) {
    let mock = MockPalvelin::kaynnista().await;
    let ydin = Ydin::kaynnista().await;
    ydin.synkkaa(&mock).await;
    (mock, ydin)
}

// ---- Testit --------------------------------------------------------------------------------------------

#[test]
fn synkkaa_tuo_kaikki() {
    aja(async {
        let mock = MockPalvelin::kaynnista().await;
        let ydin = Ydin::kaynnista().await;
        assert!(ydin
            .tila
            .varasto
            .listaa_etuliite("rekisterit/")
            .unwrap()
            .is_empty());
        let yhteenveto = ydin.synkkaa(&mock).await;
        let mut yksikoita = 0;
        for (n, polku) in polut() {
            let odotettu = fixture(&format!("hae-{n}"));
            let odotettu = odotettu["yksikot"].as_array().unwrap();
            let varastopolku = format!("rekisterit/{polku}");
            let talletetut: BTreeMap<String, _> = ydin
                .tila
                .varasto
                .listaa(&varastopolku)
                .unwrap()
                .into_iter()
                .filter(|y| !y.id.starts_with('_'))
                .map(|y| (y.id.clone(), y))
                .collect();
            let odotetut_idt: BTreeSet<&str> =
                odotettu.iter().map(|y| y["id"].as_str().unwrap()).collect();
            let talletetut_idt: BTreeSet<&str> = talletetut.keys().map(String::as_str).collect();
            assert_eq!(talletetut_idt, odotetut_idt, "{polku}: yksikköjoukko");
            for o in odotettu {
                let id = o["id"].as_str().unwrap();
                let t = &talletetut[id];
                let versio: Versio = serde_json::from_value(o["versio"].clone()).unwrap();
                assert_eq!(t.versio, versio, "{polku} {id}: versio");
                assert_eq!(
                    t.sisalto.as_deref(),
                    Some(o["sisalto"].as_str().unwrap().as_bytes()),
                    "{polku} {id}: sisalto"
                );
                assert_eq!(
                    t.poistettu,
                    o["poistettu"].as_bool().unwrap(),
                    "{polku} {id}: poistettu"
                );
                // Fixtureissa ei ole rinnakkaisia: sisaryksikköä `<id>~<laite>` ei saa syntyä.
                assert!(o["rinnakkaiset"].as_array().is_none_or(|a| a.is_empty()));
                assert!(
                    !talletetut.keys().any(|k| k.starts_with(&format!("{id}~"))),
                    "{polku} {id}: ylimääräinen rinnakkainen"
                );
            }
            yksikoita += odotettu.len();
        }
        assert!(yksikoita > 0);
        assert!(yhteenveto.rekisterit >= 3, "{yhteenveto:?}");
        assert!(yhteenveto.yksikot >= yksikoita, "{yhteenveto:?}");
    });
}

#[test]
fn teksti_identtinen() {
    aja(async {
        let (_mock, ydin) = synkattu().await;
        for (n, polku) in polut() {
            let odotettu = fixture(&format!("teksti-{n}"));
            let odotettu = odotettu["teksti"].as_str().unwrap();
            assert!(!odotettu.is_empty());
            let saatu = lr::teksti(&ydin.tila.varasto, &polku);
            assert_eq!(
                saatu.as_bytes(),
                odotettu.as_bytes(),
                "{polku}: teksti ei ole tavuidenttinen"
            );
        }
    });
}

#[test]
fn tiiviste_identtinen() {
    aja(async {
        let (_mock, ydin) = synkattu().await;
        let vastaus = reqwest::Client::new()
            .get(format!("{}/api/lr/tiiviste", ydin.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        assert_eq!(vastaus.status(), 200);
        let runko: Value = vastaus.json().await.unwrap();
        let odotettu = fixture("tiiviste");
        for (_, polku) in polut() {
            assert_eq!(
                runko["rekisterit"][&polku], odotettu["rekisterit"][&polku],
                "{polku}: tiiviste"
            );
            assert!(odotettu["rekisterit"][&polku].is_string());
        }
    });
}

#[test]
fn ei_laheta() {
    aja(async {
        let (mock, ydin) = synkattu().await;
        ydin.synkkaa(&mock).await;
        assert_eq!(mock.laheta(), 0, "lukutila kutsui /api/lr/laheta");
    });
}

#[test]
fn toinen_synkka_ei_hae() {
    aja(async {
        let (mock, ydin) = synkattu().await;
        let (listat, hae) = mock.listat_ja_hae();
        assert!(
            listat >= 1 && hae >= 1,
            "ensimmäinen synkka: {listat}/{hae}"
        );
        let toinen = ydin.synkkaa(&mock).await;
        assert_eq!(
            mock.listat_ja_hae(),
            (listat, hae),
            "sama tiiviste: ei listat- eikä hae-kutsuja"
        );
        assert_eq!(toinen.yksikot, 0, "{toinen:?}");
    });
}
