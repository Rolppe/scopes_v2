//! Lukusilta (T-23): ydin välittää S-6:n siltalistan reitit mock-vanhalle palvelulle.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use scopes_ydin::api::{self, Tila};
use scopes_ydin::silta;
use scopes_ydin::varasto::Varasto;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tokio_stream::wrappers::ReceiverStream;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";
const MOCK_AVAIN: &str = "mockin-oma-avain";

/// Väliaikaiset tiedostot (tietokanta ja vanhan avain), poistetaan lopuksi.
struct Tmp {
    db: PathBuf,
    avain: PathBuf,
}

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        let kansio = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
        let p = std::process::id();
        Tmp {
            db: kansio.join(format!("silta-{p}-{n}.db")),
            avain: kansio.join(format!("silta-{p}-{n}.avain")),
        }
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        for pääte in ["", "-wal", "-shm"] {
            let mut s = self.db.clone().into_os_string();
            s.push(pääte);
            let _ = std::fs::remove_file(s);
        }
        let _ = std::fs::remove_file(&self.avain);
    }
}

#[derive(Clone)]
struct MockTila {
    portti: Arc<Notify>,
}

fn tarkista_avain(h: &HeaderMap) -> Option<Response> {
    let odotettu = format!("Bearer {MOCK_AVAIN}");
    match h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        Some(a) if a == odotettu => None,
        _ => Some((StatusCode::UNAUTHORIZED, "väärä avain").into_response()),
    }
}

async fn mock_purkajat(h: HeaderMap) -> Response {
    if let Some(v) = tarkista_avain(&h) {
        return v;
    }
    (
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        r#"[{"nimi":"a"}]"#,
    )
        .into_response()
}

async fn mock_viesti(h: HeaderMap, runko: Bytes) -> Response {
    if let Some(v) = tarkista_avain(&h) {
        return v;
    }
    let tyyppi = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    (
        StatusCode::ACCEPTED,
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"x.json\"".to_string(),
            ),
        ],
        json!({"runko": String::from_utf8_lossy(&runko), "tyyppi": tyyppi}).to_string(),
    )
        .into_response()
}

async fn mock_virta(State(t): State<MockTila>, h: HeaderMap) -> Response {
    if let Some(v) = tarkista_avain(&h) {
        return v;
    }
    let (lahetin, vastaanotin) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::spawn(async move {
        let _ = lahetin.send(Ok(Bytes::from("{\"n\":1}\n"))).await;
        // Toinen rivi vasta, kun testi on nähnyt ensimmäisen: puskurointi aiheuttaisi umpikujan.
        t.portti.notified().await;
        let _ = lahetin.send(Ok(Bytes::from("{\"n\":2}\n"))).await;
    });
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(ReceiverStream::new(vastaanotin)),
    )
        .into_response()
}

async fn mock_kaytto(h: HeaderMap) -> Response {
    if let Some(v) = tarkista_avain(&h) {
        return v;
    }
    "kayttoraja".into_response()
}

/// Käynnistää mock-vanhan satunnaisporttiin; palauttaa osoitteen ja virran portin.
async fn mock_vanha() -> (String, Arc<Notify>) {
    let portti = Arc::new(Notify::new());
    let app = Router::new()
        .route("/api/purkajat", get(mock_purkajat))
        .route("/api/skoopit/x/viesti", post(mock_viesti))
        .route("/api/chat/virta", post(mock_virta))
        .route("/api/skoopit", get(mock_kaytto))
        .with_state(MockTila {
            portti: portti.clone(),
        });
    let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(kuuntelija, app).await.unwrap();
    });
    (osoite, portti)
}

struct Ydin {
    _tmp: Tmp,
    osoite: String,
    asiakas: reqwest::Client,
}

impl Ydin {
    async fn kaynnista(vanha: Option<String>) -> Ydin {
        let tmp = Tmp::uusi();
        std::fs::write(&tmp.avain, format!("{MOCK_AVAIN}\n")).unwrap();
        let varasto = Arc::new(Varasto::avaa(&tmp.db).unwrap());
        let (lahetin, _) = tokio::sync::broadcast::channel(64);
        let tila = Arc::new(Tila {
            varasto,
            laite: "koe".to_string(),
            headless: false,
            avain: AVAIN.to_string(),
            vanha_avain: vanha.as_ref().map(|_| tmp.avain.clone()),
            vanha,
            vertaiset: vec![],
            lr_vertainen: None,
            lahetin,
        });
        let app = api::router_valilla(tila, Duration::from_millis(100));
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        Ydin {
            _tmp: tmp,
            osoite,
            asiakas: reqwest::Client::new(),
        }
    }

    fn pyynto(&self, metodi: reqwest::Method, polku: &str) -> reqwest::RequestBuilder {
        self.asiakas
            .request(metodi, format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
    }
}

#[tokio::test]
async fn get_valittyy_vanhan_avaimella_ja_otsikot_sailyvat() {
    let (vanha, _) = mock_vanha().await;
    let ydin = Ydin::kaynnista(Some(vanha)).await;
    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/purkajat")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "silta");
    assert_eq!(
        v.headers()["content-type"],
        "application/json; charset=utf-8"
    );
    assert_eq!(v.headers()["cache-control"], "no-store");
    assert_eq!(v.text().await.unwrap(), r#"[{"nimi":"a"}]"#);
}

#[tokio::test]
async fn post_runko_ja_tila_menevat_lapi() {
    let (vanha, _) = mock_vanha().await;
    let ydin = Ydin::kaynnista(Some(vanha)).await;
    let v = ydin
        .pyynto(reqwest::Method::POST, "/api/skoopit/x/viesti")
        .header("content-type", "text/x-koe")
        .body("terve maailma")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 202);
    assert_eq!(v.headers()["x-lahde"], "silta");
    assert_eq!(
        v.headers()["content-disposition"],
        "attachment; filename=\"x.json\""
    );
    let j: Value = v.json().await.unwrap();
    assert_eq!(j["runko"], "terve maailma");
    assert_eq!(j["tyyppi"], "text/x-koe");
}

#[tokio::test]
async fn ndjson_virta_valittyy_puskuroimatta() {
    let (vanha, portti) = mock_vanha().await;
    let ydin = Ydin::kaynnista(Some(vanha)).await;
    let mut v = ydin
        .pyynto(reqwest::Method::POST, "/api/chat/virta")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "silta");
    assert_eq!(v.headers()["content-type"], "application/x-ndjson");
    assert_eq!(v.headers()["cache-control"], "no-cache");
    let eka = tokio::time::timeout(Duration::from_secs(5), v.chunk())
        .await
        .expect("ensimmäinen rivi ei saapunut: virtaa puskuroidaan")
        .unwrap()
        .unwrap();
    assert_eq!(&eka[..], b"{\"n\":1}\n");
    portti.notify_one();
    let toka = tokio::time::timeout(Duration::from_secs(5), v.chunk())
        .await
        .expect("toinen rivi ei saapunut")
        .unwrap()
        .unwrap();
    assert_eq!(&toka[..], b"{\"n\":2}\n");
}

#[tokio::test]
async fn ei_sillattava_polku_on_404() {
    let (vanha, _) = mock_vanha().await;
    let ydin = Ydin::kaynnista(Some(vanha)).await;
    for (metodi, polku) in [
        (reqwest::Method::GET, "/api/wg-asetus"),
        (reqwest::Method::POST, "/api/nebius-avain"),
        (reqwest::Method::GET, "/api/tuntematon"),
    ] {
        let v = ydin.pyynto(metodi, polku).send().await.unwrap();
        assert_eq!(v.status(), 404, "{polku}");
        let j: Value = v.json().await.unwrap();
        assert_eq!(j, json!({"virhe": "tuntematon polku"}));
    }
}

#[tokio::test]
async fn johdettu_reitti_vastaa_sillasta_valiaikaisesti() {
    let (vanha, _) = mock_vanha().await;
    let ydin = Ydin::kaynnista(Some(vanha)).await;
    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/skoopit")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "silta");
}

#[tokio::test]
async fn ilman_vanhaa_503_mutta_ei_sillattava_404() {
    let ydin = Ydin::kaynnista(None).await;
    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/purkajat")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 503);
    let j: Value = v.json().await.unwrap();
    assert_eq!(j, json!({"virhe": "silta", "kohde": "8787"}));
    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/wg-asetus")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 404);
}

#[tokio::test]
async fn sammutettu_vanha_on_503() {
    // Varataan portti ja vapautetaan se: kukaan ei kuuntele.
    let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let kuollut = format!("http://{}", kuuntelija.local_addr().unwrap());
    drop(kuuntelija);
    let ydin = Ydin::kaynnista(Some(kuollut)).await;
    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/purkajat")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 503);
    let j: Value = v.json().await.unwrap();
    assert_eq!(j, json!({"virhe": "silta", "kohde": "8787"}));
}

#[test]
fn sillattava_lista() {
    use axum::http::Method as M;
    let kylla = [
        (M::POST, "/api/skoopit/a/viesti"),
        (M::POST, "/api/skoopit/a/stream"),
        (M::POST, "/api/skoopit/a/liite"),
        (M::POST, "/api/skoopit/a/stop"),
        (M::POST, "/api/skoopit/a/malli"),
        (M::POST, "/api/skoopit/a/kysymys-pois"),
        (M::POST, "/api/skoopit/a/pura"),
        (M::POST, "/api/skoopit/a/pakkaa"),
        (M::POST, "/api/skoopit/a/automaattisiirto"),
        (M::POST, "/api/skoopit/a/herata"),
        (M::POST, "/api/skoopit/a/herata-pois"),
        (M::POST, "/api/skoopit/a/arkistoi"),
        (M::POST, "/api/uusi"),
        (M::GET, "/api/asetukset"),
        (M::POST, "/api/asetukset/kytkin"),
        (M::GET, "/api/skoopit/a/asetukset"),
        (M::GET, "/api/purkajat"),
        (M::GET, "/api/kayttoraja"),
        (M::GET, "/api/android/ruutu"),
        (M::POST, "/api/palvelin/x"),
        (M::GET, "/api/chat/keskustelut"),
        (M::POST, "/api/chat/virta"),
        (M::POST, "/api/kordinaattori/virta"),
        (M::GET, "/api/viat"),
        (M::GET, "/api/diagnostiikka"),
        (M::POST, "/api/diagnostiikka"),
    ];
    for (m, p) in kylla {
        assert!(silta::sillattava(&m, p), "{m} {p}");
    }
    let ei = [
        (M::GET, "/api/wg-asetus"),
        (M::POST, "/api/nebius-avain"),
        (M::GET, "/api/lr/x"),
        (M::GET, "/api/skoopit/a/viesti"),
        (M::POST, "/api/purkajat"),
        (M::POST, "/api/viat"),
        (M::GET, "/api/chatti"),
        (M::DELETE, "/api/chat"),
        (M::GET, "/api/skoopit"),
    ];
    for (m, p) in ei {
        assert!(!silta::sillattava(&m, p), "{m} {p}");
    }
}
