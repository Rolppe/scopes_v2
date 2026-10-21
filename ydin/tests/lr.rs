//! T-32: ydin LR-vertaisena lukutilassa. Mock-LR-1 palvelee muistissa olevaa rekisteriä
//! (`yksikko::rekisteri::Varasto`, T-17:n lr.mjs-siirto), jossa on rinnakkainen rivi ja hautakivi.

use scopes_ydin::api::{self, Tila};
use scopes_ydin::lr;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::vertaiset::Vertainen;
use scopes_ydin::yksikko::rekisteri::{self, Meta, Rekisteri, Rivi, Sisar};
use scopes_ydin::yksikko::Versio;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";
const LR_AVAIN: &str = "koe";
const POLKU: &str = "koe/REKISTERI.md";

fn aja<F: Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn versio(pari: &[(&str, u64)]) -> Versio {
    pari.iter().map(|(k, n)| (k.to_string(), *n)).collect()
}

fn rivi(id: &str, jarjestys: &str, sisalto: &str, v: Versio) -> Rivi {
    Rivi {
        id: id.to_string(),
        rekisteri: POLKU.to_string(),
        laji: "kappale".to_string(),
        osio: String::new(),
        jarjestys: jarjestys.to_string(),
        sisalto: sisalto.to_string(),
        versio: v,
        muutettu: Some("2026-10-19T10:00:00.000Z".to_string()),
        muuttaja: Some("lr1".to_string()),
        poistettu: false,
        lahde_sisalto: Some(sisalto.to_string()),
        lahde_versio: None,
        rinnakkaiset: vec![],
    }
}

/// Rekisteri: otsikko, kaksi riviä (järjestysavain eri kuin tunnusjärjestys), riidallinen rivi ja hautakivi.
fn lahtotila() -> rekisteri::Varasto {
    let mut riita = rivi("lr1-2", "3", "Rivi B\n", versio(&[("lr1", 2)]));
    riita.rinnakkaiset.push(Sisar {
        sisalto: "Rivi B (mac)\n".to_string(),
        poistettu: false,
        versio: versio(&[("lr1", 1), ("mac", 1)]),
        muutettu: Some("2026-10-19T10:05:00.000Z".to_string()),
        muuttaja: Some("mac".to_string()),
    });
    let mut kivi = rivi("lr1-4", "4", "poistettu\n", versio(&[("lr1", 4)]));
    kivi.poistettu = true;
    let rivit = [
        rivi("lr1-1", "1", "# Koe\n\n", versio(&[("lr1", 1)])),
        riita,
        rivi("lr1-3", "2", "Rivi A\n", versio(&[("lr1", 3)])),
        kivi,
    ]
    .into_iter()
    .map(|r| (r.id.clone(), r))
    .collect();
    let mut rv = rekisteri::Varasto::default();
    rv.rekisterit.insert(
        POLKU.to_string(),
        Rekisteri {
            meta: Meta {
                rekisteri: POLKU.to_string(),
                versio: versio(&[("lr1", 10)]),
                poistettu: false,
                lahde: None,
            },
            rivit,
            siivotut: BTreeMap::new(),
        },
    );
    rv
}

// ---- Mock-LR-1 --------------------------------------------------------------------------------------

#[derive(Default)]
struct Laskurit {
    listat: AtomicUsize,
    hae: AtomicUsize,
    laheta: AtomicUsize,
}

struct Mock {
    rv: Mutex<rekisteri::Varasto>,
    laskurit: Laskurit,
}

type MockTila = Arc<Mock>;

fn luvaton(otsikot: &HeaderMap) -> Option<Response> {
    let ok = otsikot
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {LR_AVAIN}"));
    (!ok).then(|| StatusCode::UNAUTHORIZED.into_response())
}

async fn mock_tiiviste(State(m): State<MockTila>, otsikot: HeaderMap) -> Response {
    if let Some(v) = luvaton(&otsikot) {
        return v;
    }
    let t = m.rv.lock().unwrap().tiivisteet();
    Json(json!({"laite": "lr1", "juuri": t.juuri, "rekisterit": t.rekisterit, "valiMin": 10}))
        .into_response()
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
    let rv = m.rv.lock().unwrap();
    let mut ulos = serde_json::Map::new();
    for p in runko["rekisterit"].as_array().unwrap().iter() {
        let p = p.as_str().unwrap();
        let l = rv.lista(p).unwrap();
        let yksikot: Vec<Value> = l
            .yksikot
            .iter()
            .map(|(id, v, r)| json!({"id": id, "versio": v, "rinnakkaiset": r}))
            .collect();
        ulos.insert(
            p.to_string(),
            json!({"meta": l.meta, "yksikot": yksikot, "siivotut": l.siivotut}),
        );
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
    let idt: Vec<&str> = runko["idt"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let rivit =
        m.rv.lock()
            .unwrap()
            .hae(runko["rekisteri"].as_str().unwrap(), &idt)
            .unwrap();
    Json(json!({ "yksikot": rivit })).into_response()
}

async fn mock_laheta(State(m): State<MockTila>) -> Response {
    m.laskurit.laheta.fetch_add(1, Ordering::SeqCst);
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

struct MockPalvelin {
    mock: MockTila,
    osoite: String,
}

impl MockPalvelin {
    async fn kaynnista() -> MockPalvelin {
        let mock = Arc::new(Mock {
            rv: Mutex::new(lahtotila()),
            laskurit: Laskurit::default(),
        });
        let app = Router::new()
            .route("/api/lr/tiiviste", get(mock_tiiviste))
            .route("/api/lr/listat", post(mock_listat))
            .route("/api/lr/hae", post(mock_hae))
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

    fn teksti(&self) -> String {
        self.mock.rv.lock().unwrap().tulosta(POLKU, false)
    }

    fn tiiviste(&self) -> String {
        self.mock
            .rv
            .lock()
            .unwrap()
            .rekisterin_tiiviste(POLKU)
            .unwrap()
    }
}

// ---- Ydin ---------------------------------------------------------------------------------------------

struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("lr-{}-{n}.db", std::process::id())))
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
            adapteri: Default::default(),
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
            tila,
            osoite,
        }
    }

    async fn synkkaa(&self, mock: &MockPalvelin) -> lr::Yhteenveto {
        lr::synkkaa(&self.tila, &mock.vertainen())
            .await
            .unwrap_or_else(|e| panic!("synkkaa: {e}"))
    }

    async fn ristiriidat(&self) -> Vec<Value> {
        let v = reqwest::Client::new()
            .get(format!("{}/api/lr/ristiriidat", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200);
        let runko: Value = v.json().await.unwrap();
        runko["ristiriidat"].as_array().unwrap().clone()
    }
}

// ---- Testit --------------------------------------------------------------------------------------------

#[test]
fn rinnakkaiset_sailyvat() {
    aja(async {
        let mock = MockPalvelin::kaynnista().await;
        let ydin = Ydin::kaynnista().await;
        let yv = ydin.synkkaa(&mock).await;
        assert_eq!(
            (yv.rekisterit, yv.yksikot, yv.ristiriidat),
            (1, 4, 1),
            "{yv:?}"
        );

        let riidat = ydin.ristiriidat().await;
        assert_eq!(riidat.len(), 1, "{riidat:?}");
        assert_eq!(riidat[0]["id"], "lr1-2");
        assert_eq!(riidat[0]["rekisteri"], POLKU);
        let r = &riidat[0]["rinnakkaiset"][0];
        assert_eq!(r["sisalto"], "Rivi B (mac)\n");
        assert_eq!(r["versio"], json!({"lr1": 1, "mac": 1}));
        assert_eq!(r["muuttaja"], "mac");
        // Rinnakkainen on sisaryksikkö `<id>~<laite>`.
        let sisar = ydin
            .tila
            .varasto
            .lue(&format!("rekisterit/{POLKU}"), "lr1-2~mac")
            .unwrap()
            .expect("sisaryksikkö");
        assert_eq!(sisar.sisalto.as_deref(), Some(&b"Rivi B (mac)\n"[..]));

        // Teksti järjestysavaimilla ilman hautakiveä; tiiviste rinnakkaisineen sama kuin LR:llä.
        assert_eq!(
            lr::teksti(&ydin.tila.varasto, POLKU),
            "# Koe\n\nRivi A\nRivi B\n"
        );
        assert_eq!(lr::teksti(&ydin.tila.varasto, POLKU), mock.teksti());
        assert_eq!(
            lr::tiiviste(&ydin.tila.varasto, POLKU).unwrap(),
            mock.tiiviste()
        );

        // Ratkaisu LR:ssä (uudempi kuin rinnakkainen): riita poistuu myös ytimestä.
        {
            let mut rv = mock.mock.rv.lock().unwrap();
            let rek = rv.rekisterit.get_mut(POLKU).unwrap();
            let r = rek.rivit.get_mut("lr1-2").unwrap();
            r.sisalto = "Rivi B ratkaistu\n".to_string();
            r.versio = versio(&[("lr1", 5), ("mac", 1)]);
            r.rinnakkaiset.clear();
        }
        let yv = ydin.synkkaa(&mock).await;
        assert_eq!((yv.yksikot, yv.ristiriidat), (1, 0), "{yv:?}");
        assert!(ydin.ristiriidat().await.is_empty());
        assert_eq!(lr::teksti(&ydin.tila.varasto, POLKU), mock.teksti());
        assert_eq!(
            lr::tiiviste(&ydin.tila.varasto, POLKU).unwrap(),
            mock.tiiviste()
        );
    });
}

#[test]
fn toinen_synkka_ei_hae() {
    aja(async {
        let mock = MockPalvelin::kaynnista().await;
        let ydin = Ydin::kaynnista().await;
        ydin.synkkaa(&mock).await;
        let ennen = mock.listat_ja_hae();
        assert_eq!(ennen, (1, 1));
        let seq = ydin.tila.varasto.seq().unwrap();
        let toinen = ydin.synkkaa(&mock).await;
        assert_eq!(
            mock.listat_ja_hae(),
            ennen,
            "sama tiiviste: ei listat- eikä hae-kutsuja"
        );
        assert_eq!((toinen.rekisterit, toinen.yksikot), (0, 0), "{toinen:?}");
        assert_eq!(toinen.tarkistettu, 1);
        assert_eq!(
            ydin.tila.varasto.seq().unwrap(),
            seq,
            "toinen synkka kirjoitti"
        );
    });
}

#[test]
fn vertainen_poissa() {
    aja(async {
        // Suljettu portti: varattu ja vapautettu.
        let kuuntelija = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        drop(kuuntelija);
        let poissa = Vertainen::osoitteesta(&osoite, LR_AVAIN).unwrap();

        // Tyhjä varasto pysyy tyhjänä.
        let ydin = Ydin::kaynnista().await;
        assert!(lr::synkkaa(&ydin.tila, &poissa).await.is_err());
        assert_eq!(ydin.tila.varasto.seq().unwrap(), 0);
        assert!(ydin
            .tila
            .varasto
            .listaa_etuliite("rekisterit")
            .unwrap()
            .is_empty());

        // Synkattu varasto ei muutu.
        let mock = MockPalvelin::kaynnista().await;
        ydin.synkkaa(&mock).await;
        let seq = ydin.tila.varasto.seq().unwrap();
        let teksti = lr::teksti(&ydin.tila.varasto, POLKU);
        assert!(lr::synkkaa(&ydin.tila, &poissa).await.is_err());
        assert_eq!(ydin.tila.varasto.seq().unwrap(), seq);
        assert_eq!(lr::teksti(&ydin.tila.varasto, POLKU), teksti);
    });
}

#[test]
fn laheta_405() {
    aja(async {
        let mock = MockPalvelin::kaynnista().await;
        let ydin = Ydin::kaynnista().await;
        ydin.synkkaa(&mock).await;
        assert_eq!(mock.mock.laskurit.laheta.load(Ordering::SeqCst), 0);
        let asiakas = reqwest::Client::new();
        for reitti in ["laheta", "listat", "hae"] {
            let v = asiakas
                .post(format!("{}/api/lr/{reitti}", ydin.osoite))
                .bearer_auth(AVAIN)
                .json(&json!({"metat": [], "yksikot": []}))
                .send()
                .await
                .unwrap();
            assert_eq!(v.status(), 405, "{reitti}");
            let runko: Value = v.json().await.unwrap();
            assert_eq!(runko, json!({"virhe": "lukutila"}), "{reitti}");
        }
        // Teksti-reitti: tunnettu 200, tuntematon 404.
        let v = asiakas
            .get(format!("{}/api/lr/teksti/{POLKU}", ydin.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200);
        let runko: Value = v.json().await.unwrap();
        assert_eq!(runko["teksti"], mock.teksti());
        let v = asiakas
            .get(format!("{}/api/lr/teksti/ei/REKISTERI.md", ydin.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 404);
    });
}
