//! Toimintasilta adapterille (T-64, S-10): adapterin ottamat reitit menevät adapterille V2-avaimella,
//! muut sillattavat vanhalle. Vapaat portit (`127.0.0.1:0`), mock-adapteri ja mock-vanha prosessissa.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, HeaderMap, Method as M, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use scopes_ydin::api::{self, Tila};
use scopes_ydin::silta::{self, adapterin_reitti};
use scopes_ydin::varasto::Varasto;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, Notify};
use tokio_stream::wrappers::ReceiverStream;

static LASKURI: AtomicU32 = AtomicU32::new(0);
/// Ytimen oma V2-avain.
const AVAIN: &str = "koeavain-1234";
/// Vanhan palvelun avain: ei saa koskaan päätyä adapterille.
const VANHA_AVAIN: &str = "vanhan-oma-avain";

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
            db: kansio.join(format!("silta-adapteri-{p}-{n}.db")),
            avain: kansio.join(format!("silta-adapteri-{p}-{n}.avain")),
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

/// Mock-palvelun jaettu tila: julkaistut reitit, pyyntöjen lukumäärä ja virran portti.
#[derive(Clone)]
struct MockTila {
    nimi: &'static str,
    reitit: Arc<Mutex<Vec<String>>>,
    pyynnot: Arc<AtomicU32>,
    portti: Arc<Notify>,
    /// Kaikki saadut Authorization-otsikot (myös terveyshaku).
    avaimet: Arc<Mutex<Vec<String>>>,
}

/// Kaikki muut polut: kaiuttaa kohteen, metodin, polun, Authorization-otsikon ja rungon.
async fn kaiku(State(t): State<MockTila>, m: M, uri: Uri, h: HeaderMap, runko: Bytes) -> Response {
    t.pyynnot.fetch_add(1, Ordering::SeqCst);
    t.avaimet.lock().unwrap().push(
        h.get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string(),
    );
    if uri.path() == "/api/chat/virta" {
        let portti = t.portti.clone();
        let (lahetin, vastaanotin) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
        tokio::spawn(async move {
            let _ = lahetin.send(Ok(Bytes::from("{\"n\":1}\n"))).await;
            // Toinen rivi vasta, kun testi on nähnyt ensimmäisen: puskurointi aiheuttaisi umpikujan.
            portti.notified().await;
            let _ = lahetin.send(Ok(Bytes::from("{\"n\":2}\n"))).await;
        });
        return (
            [
                (header::CONTENT_TYPE, "application/x-ndjson"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            Body::from_stream(ReceiverStream::new(vastaanotin)),
        )
            .into_response();
    }
    let auth = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    Json(json!({
        "kohde": t.nimi,
        "metodi": m.as_str(),
        "polku": uri.path(),
        "auth": auth,
        "runko": String::from_utf8_lossy(&runko),
    }))
    .into_response()
}

async fn mock_terveys(State(t): State<MockTila>, h: HeaderMap) -> Response {
    t.avaimet.lock().unwrap().push(
        h.get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string(),
    );
    let reitit = t.reitit.lock().unwrap().clone();
    Json(json!({"ok": true, "reitit": reitit})).into_response()
}

struct Mock {
    osoite: String,
    tila: MockTila,
    sammuta: Option<oneshot::Sender<()>>,
    palvelin: Option<tokio::task::JoinHandle<()>>,
}

impl Mock {
    /// Käynnistää mockin satunnaisporttiin; `reitit` julkaistaan `GET /api/terveys`-vastauksessa.
    async fn kaynnista(nimi: &'static str, reitit: &[&str]) -> Mock {
        let tila = MockTila {
            nimi,
            reitit: Arc::new(Mutex::new(reitit.iter().map(|s| s.to_string()).collect())),
            pyynnot: Arc::new(AtomicU32::new(0)),
            portti: Arc::new(Notify::new()),
            avaimet: Arc::new(Mutex::new(vec![])),
        };
        let app = Router::new()
            .route("/api/terveys", get(mock_terveys))
            .fallback(kaiku)
            .with_state(tila.clone());
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        let (sammuta, pysayta) = oneshot::channel::<()>();
        let palvelin = tokio::spawn(async move {
            axum::serve(kuuntelija, app)
                .with_graceful_shutdown(async move {
                    let _ = pysayta.await;
                })
                .await
                .unwrap();
        });
        Mock {
            osoite,
            tila,
            sammuta: Some(sammuta),
            palvelin: Some(palvelin),
        }
    }

    fn pyyntoja(&self) -> u32 {
        self.tila.pyynnot.load(Ordering::SeqCst)
    }

    /// Sammuttaa mockin: kuuntelija ja pysyvät yhteydet sulkeutuvat.
    async fn sammuta(&mut self) {
        if let Some(s) = self.sammuta.take() {
            let _ = s.send(());
        }
        if let Some(p) = self.palvelin.take() {
            tokio::time::timeout(Duration::from_secs(5), p)
                .await
                .expect("mock ei sammunut")
                .unwrap();
        }
    }
}

/// Satunnaisportti, jossa ei kuuntele kukaan.
async fn kuollut_osoite() -> String {
    let k = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let osoite = format!("http://{}", k.local_addr().unwrap());
    drop(k);
    osoite
}

struct Ydin {
    _tmp: Tmp,
    osoite: String,
    tila: Arc<Tila>,
    asiakas: reqwest::Client,
}

impl Ydin {
    async fn kaynnista(vanha: Option<String>, adapteri: Option<String>) -> Ydin {
        let tmp = Tmp::uusi();
        std::fs::write(&tmp.avain, format!("{VANHA_AVAIN}\n")).unwrap();
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
            adapteri: silta::Adapteri {
                url: adapteri,
                ..Default::default()
            },
            lahetin,
            peili: Default::default(),
        });
        let app = api::router_valilla(tila.clone(), Duration::from_millis(100));
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        Ydin {
            _tmp: tmp,
            osoite,
            tila,
            asiakas: reqwest::Client::new(),
        }
    }

    fn pyynto(&self, metodi: reqwest::Method, polku: &str) -> reqwest::RequestBuilder {
        self.asiakas
            .request(metodi, format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
    }

    /// Odottaa, että taustahaku on saanut adapterin reittilistan.
    async fn odota_lista(&self) {
        for _ in 0..200 {
            if self.tila.adapteri.reitit.read().unwrap().is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("adapterin reittilistaa ei haettu 10 sekunnissa");
    }
}

fn kuviot(l: &[&str]) -> Vec<String> {
    l.iter().map(|s| s.to_string()).collect()
}

/// (a) Ilman `--adapteri` `sillattava_lista`-polut menevät vanhalle kuten ennen.
#[tokio::test]
async fn ilman_lippua_kaikki_vanhalle() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let adapteri =
        Mock::kaynnista("adapteri", &["POST /api/skoopit/*/viesti", "GET /api/**"]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), None).await;
    let polut = [
        (reqwest::Method::POST, "/api/skoopit/a/viesti"),
        (reqwest::Method::POST, "/api/skoopit/a/stop"),
        (reqwest::Method::POST, "/api/uusi"),
        (
            reqwest::Method::POST,
            "/api/skoopit/a/asetukset/automaattijatko/paalle",
        ),
        (reqwest::Method::GET, "/api/skoopit/a/asetukset"),
        (reqwest::Method::GET, "/api/purkajat"),
        (reqwest::Method::GET, "/api/kayttoraja"),
        (reqwest::Method::GET, "/api/viat"),
        (reqwest::Method::POST, "/api/chat/keskustelut"),
        (reqwest::Method::GET, "/api/diagnostiikka"),
    ];
    for (m, p) in polut {
        let v = ydin.pyynto(m.clone(), p).body("x").send().await.unwrap();
        assert_eq!(v.status(), 200, "{m} {p}");
        assert_eq!(v.headers()["x-lahde"], "silta", "{m} {p}");
        let j: Value = v.json().await.unwrap();
        assert_eq!(j["kohde"], "vanha", "{m} {p}");
        assert_eq!(j["polku"], p);
        assert_eq!(j["auth"], format!("Bearer {VANHA_AVAIN}"), "{m} {p}");
    }
    assert_eq!(adapteri.pyyntoja(), 0);
    assert!(ydin.tila.adapteri.reitit.read().unwrap().is_none());
}

/// (b) Adapterin julkaisema viesti menee adapterille V2-avaimella, stop vanhalle.
/// (g) Vanhan avainta ei lähetetä adapterille.
#[tokio::test]
async fn viesti_adapterille_stop_vanhalle() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let adapteri = Mock::kaynnista("adapteri", &["POST /api/skoopit/*/viesti"]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
    ydin.odota_lista().await;

    let v = ydin
        .pyynto(reqwest::Method::POST, "/api/skoopit/a/viesti")
        .body("hei")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "adapteri");
    let j: Value = v.json().await.unwrap();
    assert_eq!(j["kohde"], "adapteri");
    assert_eq!(j["runko"], "hei");
    assert_eq!(j["auth"], format!("Bearer {AVAIN}"));
    assert!(!j["auth"].as_str().unwrap().contains(VANHA_AVAIN));

    let v = ydin
        .pyynto(reqwest::Method::POST, "/api/skoopit/a/stop")
        .send()
        .await
        .unwrap();
    assert_eq!(v.headers()["x-lahde"], "silta");
    let j: Value = v.json().await.unwrap();
    assert_eq!(j["kohde"], "vanha");
    assert_eq!(j["auth"], format!("Bearer {VANHA_AVAIN}"));

    // (g) Mikään adapterin saama pyyntö (myös terveyshaku) ei kanna vanhan avainta.
    let avaimet = adapteri.tila.avaimet.lock().unwrap().clone();
    assert!(avaimet.len() >= 2, "terveyshaku ja viesti: {avaimet:?}");
    for a in avaimet {
        assert_eq!(a, format!("Bearer {AVAIN}"));
    }
}

/// (c) Siltalistan ulkopuolinen kuvio ei mene adapterille.
#[tokio::test]
async fn silta_listan_ulkopuolinen_kuvio_ei_mene_adapterille() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let adapteri = Mock::kaynnista(
        "adapteri",
        &[
            "GET /api/skoopit",
            "GET /api/skoopit/*/viestit",
            "GET /api/rekisterit/**",
        ],
    )
    .await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
    ydin.odota_lista().await;
    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/skoopit")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "silta");
    let j: Value = v.json().await.unwrap();
    assert_eq!(j["kohde"], "vanha");
    assert_eq!(adapteri.pyyntoja(), 0);
}

/// (d) Adapteri alhaalla ennen ensimmäistä hakua: lista tuntematon, pyyntö menee vanhalle.
#[tokio::test]
async fn adapteri_alhaalla_ennen_hakua_vanhalle() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(kuollut_osoite().await)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(ydin.tila.adapteri.reitit.read().unwrap().is_none());
    let v = ydin
        .pyynto(reqwest::Method::POST, "/api/skoopit/a/viesti")
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "silta");
    let j: Value = v.json().await.unwrap();
    assert_eq!(j["kohde"], "vanha");
    assert_eq!(vanha.pyyntoja(), 1);
}

/// (e) Lista tunnettu ja adapteri sammutettu: 503 `adapteri`, vanha ei saa pyyntöä.
#[tokio::test]
async fn adapteri_sammutettu_antaa_503_eika_uusintaa_vanhalle() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let mut adapteri = Mock::kaynnista("adapteri", &["POST /api/skoopit/*/viesti"]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
    ydin.odota_lista().await;
    adapteri.sammuta().await;
    let v = ydin
        .pyynto(reqwest::Method::POST, "/api/skoopit/a/viesti")
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 503);
    let j: Value = v.json().await.unwrap();
    assert_eq!(j, json!({"virhe": "adapteri", "kohde": adapteri.osoite}));
    assert_eq!(vanha.pyyntoja(), 0, "vanha sai pyynnön adapterin sijaan");
    // Lista säilyy: muut sillattavat menevät yhä vanhalle.
    let v = ydin
        .pyynto(reqwest::Method::POST, "/api/skoopit/a/stop")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "silta");
}

/// (f) NDJSON-virta adapterilta tulee puskuroimatta.
#[tokio::test]
async fn ndjson_virta_adapterilta_puskuroimatta() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let adapteri = Mock::kaynnista("adapteri", &["POST /api/chat/**"]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
    ydin.odota_lista().await;
    let mut v = ydin
        .pyynto(reqwest::Method::POST, "/api/chat/virta")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "adapteri");
    assert_eq!(v.headers()["content-type"], "application/x-ndjson");
    assert_eq!(v.headers()["cache-control"], "no-cache");
    let eka = tokio::time::timeout(Duration::from_secs(5), v.chunk())
        .await
        .expect("ensimmäinen rivi ei saapunut: virtaa puskuroidaan")
        .unwrap()
        .unwrap();
    assert_eq!(&eka[..], b"{\"n\":1}\n");
    adapteri.tila.portti.notify_one();
    let toka = tokio::time::timeout(Duration::from_secs(5), v.chunk())
        .await
        .expect("toinen rivi ei saapunut")
        .unwrap()
        .unwrap();
    assert_eq!(&toka[..], b"{\"n\":2}\n");
    assert_eq!(vanha.pyyntoja(), 0);
}

/// (h) Kuvioyksiköt: `*` ja `/**`.
#[test]
fn kuvioyksikot() {
    let k = kuviot(&["POST /api/skoopit/*/viesti"]);
    assert!(adapterin_reitti(&k, &M::POST, "/api/skoopit/a/viesti"));
    assert!(
        !adapterin_reitti(&k, &M::GET, "/api/skoopit/a/viesti"),
        "metodi"
    );
    assert!(
        !adapterin_reitti(&k, &M::POST, "/api/skoopit//viesti"),
        "tyhjä osa"
    );
    assert!(
        !adapterin_reitti(&k, &M::POST, "/api/skoopit/a/b/viesti"),
        "yksi osa"
    );
    assert!(
        !adapterin_reitti(&k, &M::POST, "/api/skoopit/a/viesti/x"),
        "ei etuliite"
    );
    assert!(!adapterin_reitti(&k, &M::POST, "/api/skoopit/a/stop"));

    let k = kuviot(&["POST /api/chat/**"]);
    assert!(adapterin_reitti(&k, &M::POST, "/api/chat"), "polku itse");
    assert!(adapterin_reitti(&k, &M::POST, "/api/chat/virta"));
    assert!(adapterin_reitti(&k, &M::POST, "/api/chat/a/b/c"));
    assert!(!adapterin_reitti(&k, &M::POST, "/api/chatti"));
    assert!(!adapterin_reitti(&k, &M::GET, "/api/chat"));

    let k = kuviot(&["POST /api/skoopit/*/asetukset/*/*"]);
    assert!(adapterin_reitti(
        &k,
        &M::POST,
        "/api/skoopit/n/asetukset/x/paalle"
    ));
    assert!(!adapterin_reitti(
        &k,
        &M::POST,
        "/api/skoopit/n/asetukset/x"
    ));
    assert!(!adapterin_reitti(
        &k,
        &M::POST,
        "/api/skoopit/n/asetukset/x/y/z"
    ));

    let k = kuviot(&["GET /api/agentit", "huono", "", "POST"]);
    assert!(adapterin_reitti(&k, &M::GET, "/api/agentit"));
    assert!(!adapterin_reitti(&k, &M::GET, "/api/agentit/x"));
    assert!(!adapterin_reitti(&[], &M::GET, "/api/agentit"));
}

/// (i) Asetuskytkin on sillattava ja menee adapterille, kun kuvio on julkaistu.
#[tokio::test]
async fn asetuskytkin_sillattava_ja_adapterille() {
    for polku in [
        "/api/skoopit/n/asetukset/automaattijatko/paalle",
        "/api/skoopit/n/asetukset/automaattijatko/pois",
    ] {
        assert!(silta::sillattava(&M::POST, polku), "{polku}");
    }
    for polku in [
        "/api/skoopit/n/asetukset/x/y/z",
        "/api/skoopit/n/asetukset/x/muu",
        "/api/skoopit/n/asetukset/x",
        "/api/skoopit/n/asetukset/paalle",
        "/api/skoopit/n/viesti/x/paalle",
        "/api/skoopit//asetukset/x/paalle",
    ] {
        assert!(!silta::sillattava(&M::POST, polku), "{polku}");
    }
    assert!(!silta::sillattava(
        &M::GET,
        "/api/skoopit/n/asetukset/x/paalle"
    ));

    let vanha = Mock::kaynnista("vanha", &[]).await;
    let adapteri = Mock::kaynnista("adapteri", &["POST /api/skoopit/*/asetukset/*/*"]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
    ydin.odota_lista().await;
    let v = ydin
        .pyynto(
            reqwest::Method::POST,
            "/api/skoopit/n/asetukset/automaattijatko/paalle",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "adapteri");
    let j: Value = v.json().await.unwrap();
    assert_eq!(
        j["polku"],
        "/api/skoopit/n/asetukset/automaattijatko/paalle"
    );
    // Sillattavan listan ulkopuolinen polku ei mene adapterille, vaikka kuvio täsmäisi.
    let v = ydin
        .pyynto(reqwest::Method::POST, "/api/skoopit/n/asetukset/x/y/z")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 404);
    assert_eq!(vanha.pyyntoja(), 0);
}

/// (j) `GET /api/agentit` menee adapterille vain, kun se julkaisee sen; `GET /api/skoopit` ei koskaan.
#[tokio::test]
async fn agentit_adapterille_vain_julkaistuna() {
    for (julkaisu, odotettu) in [
        (vec!["GET /api/agentit"], "adapteri"),
        (
            vec!["GET /api/skoopit", "POST /api/skoopit/*/viesti"],
            "vanha",
        ),
        (vec!["GET /api/**"], "adapteri"),
        (vec![], "vanha"),
    ] {
        let vanha = Mock::kaynnista("vanha", &[]).await;
        let adapteri = Mock::kaynnista("adapteri", &julkaisu).await;
        let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
        ydin.odota_lista().await;
        let v = ydin
            .pyynto(reqwest::Method::GET, "/api/agentit")
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200, "{julkaisu:?}");
        let j: Value = v.json().await.unwrap();
        assert_eq!(j["kohde"], odotettu, "{julkaisu:?}");
        if odotettu == "adapteri" {
            assert_eq!(j["auth"], format!("Bearer {AVAIN}"));
        }
        // Muut väliaikaiset johdetut GET-reitit eivät koskaan mene adapterille.
        for polku in ["/api/skoopit", "/api/skoopit/a", "/api/skoopit/a/viestit"] {
            let v = ydin
                .pyynto(reqwest::Method::GET, polku)
                .send()
                .await
                .unwrap();
            assert_eq!(v.status(), 200, "{polku}");
            let j: Value = v.json().await.unwrap();
            assert_eq!(j["kohde"], "vanha", "{polku} {julkaisu:?}");
        }
    }
}

/// Tyhjä mutta tunnettu lista ei ota mitään: viesti menee vanhalle.
#[tokio::test]
async fn tyhja_lista_tunnettu_mutta_ei_reitteja() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let adapteri = Mock::kaynnista("adapteri", &[]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
    ydin.odota_lista().await;
    let v = ydin
        .pyynto(reqwest::Method::POST, "/api/skoopit/a/viesti")
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), StatusCode::OK);
    assert_eq!(v.headers()["x-lahde"], "silta");
}

/// (k) T-91: adapterin ottama `GET /api/agentit` vastaa `x-lahde: adapteri`; runko ennallaan,
/// `since` nollauksena kuten sillalla.
#[tokio::test]
async fn agentit_adapterilta_kantaa_lahteen_adapteri() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let adapteri = Mock::kaynnista("adapteri", &["GET /api/agentit"]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
    ydin.odota_lista().await;

    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/agentit")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "adapteri");
    let j: Value = v.json().await.unwrap();
    assert_eq!(j["kohde"], "adapteri");
    assert_eq!(j["polku"], "/api/agentit");
    assert_eq!(j["auth"], format!("Bearer {AVAIN}"));

    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/agentit?since=0")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "adapteri");
    let j: Value = v.json().await.unwrap();
    assert_eq!(j["nollaus"], true);
    assert_eq!(j["poistetut"], json!([]));
    let muuttuneet = j["muuttuneet"].as_array().unwrap();
    assert_eq!(muuttuneet.len(), 1);
    assert_eq!(muuttuneet[0]["kohde"], "adapteri");
    assert_eq!(muuttuneet[0]["polku"], "/api/agentit");
    assert_eq!(vanha.pyyntoja(), 0);
}

/// (l) T-91: adapteri julkaisee reitin mutta on sammutettu: 503 `adapteri` + `x-lahde: adapteri`,
/// vanha ei saa pyyntöä.
#[tokio::test]
async fn agentit_adapteri_sammutettu_503_lahde_adapteri() {
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let mut adapteri = Mock::kaynnista("adapteri", &["GET /api/agentit"]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
    ydin.odota_lista().await;
    adapteri.sammuta().await;
    for polku in ["/api/agentit", "/api/agentit?since=0"] {
        let v = ydin
            .pyynto(reqwest::Method::GET, polku)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 503, "{polku}");
        assert_eq!(v.headers()["x-lahde"], "adapteri", "{polku}");
        let j: Value = v.json().await.unwrap();
        assert_eq!(
            j,
            json!({"virhe": "adapteri", "kohde": adapteri.osoite}),
            "{polku}"
        );
    }
    assert_eq!(vanha.pyyntoja(), 0, "vanha sai pyynnön adapterin sijaan");
}

/// (m) T-91: ilman `--adapteria` tai kun adapteri ei julkaise reittiä `GET /api/agentit` vastaa
/// `x-lahde: silta` vanhan mockin rungolla.
#[tokio::test]
async fn agentit_ilman_adapteria_lahde_silta() {
    // Ilman adapteria.
    let vanha = Mock::kaynnista("vanha", &[]).await;
    let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), None).await;
    let v = ydin
        .pyynto(reqwest::Method::GET, "/api/agentit")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["x-lahde"], "silta");
    let j: Value = v.json().await.unwrap();
    assert_eq!(j["kohde"], "vanha");

    // Adapteri käynnissä, mutta ei julkaise reittiä.
    for julkaisu in [vec![], vec!["POST /api/skoopit/*/viesti"]] {
        let vanha = Mock::kaynnista("vanha", &[]).await;
        let adapteri = Mock::kaynnista("adapteri", &julkaisu).await;
        let ydin = Ydin::kaynnista(Some(vanha.osoite.clone()), Some(adapteri.osoite.clone())).await;
        ydin.odota_lista().await;
        for polku in ["/api/agentit", "/api/agentit?since=0"] {
            let v = ydin
                .pyynto(reqwest::Method::GET, polku)
                .send()
                .await
                .unwrap();
            assert_eq!(v.status(), 200, "{polku} {julkaisu:?}");
            assert_eq!(v.headers()["x-lahde"], "silta", "{polku} {julkaisu:?}");
            let j: Value = v.json().await.unwrap();
            let j = if polku.contains("since") {
                j["muuttuneet"][0].clone()
            } else {
                j
            };
            assert_eq!(j["kohde"], "vanha", "{polku} {julkaisu:?}");
        }
        assert_eq!(adapteri.pyyntoja(), 0, "{julkaisu:?}");
    }
}
