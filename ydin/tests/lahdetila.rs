//! Lähdetilasta vastaavat lukureitit (T-84, S-5b, S-6): `/api/asetukset`, `/api/skoopit/<n>/asetukset`,
//! `/api/kayttoraja` ja `/api/android`. Yksikkö puuttuu → mock-vanha vastaa (X-Lahde: silta), muuten ydin.

use axum::{extract::State, http::Request, response::IntoResponse, Json, Router};
use scopes_ydin::api::{self, Tila};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::Hlc;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";

/// Mock-vanha (8787): vastaa mihin tahansa polkuun ja metodiin kaiuttamalla pyynnön; kirjaa pyynnöt.
type Pyynnot = Arc<Mutex<Vec<String>>>;

async fn kaiku(State(p): State<Pyynnot>, req: Request<axum::body::Body>) -> impl IntoResponse {
    let metodi = req.method().to_string();
    let pq = req
        .uri()
        .path_and_query()
        .map(|x| x.as_str().to_string())
        .unwrap_or_default();
    p.lock().unwrap().push(format!("{metodi} {pq}"));
    Json(json!({"silta": true, "metodi": metodi, "polku": pq}))
}

async fn mock_vanha(pyynnot: Pyynnot) -> String {
    let app = Router::new().fallback(kaiku).with_state(pyynnot);
    let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(kuuntelija, app).await.unwrap();
    });
    osoite
}

struct Ydin {
    db: PathBuf,
    osoite: String,
    asiakas: reqwest::Client,
    pyynnot: Pyynnot,
}

impl Drop for Ydin {
    fn drop(&mut self) {
        for pääte in ["", "-wal", "-shm"] {
            let mut s = self.db.clone().into_os_string();
            s.push(pääte);
            let _ = std::fs::remove_file(s);
        }
    }
}

impl Ydin {
    async fn kaynnista() -> Ydin {
        let pyynnot: Pyynnot = Default::default();
        let vanha = mock_vanha(pyynnot.clone()).await;
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        let db = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("lahdetila-{}-{n}.db", std::process::id()));
        let varasto = Arc::new(Varasto::avaa(&db).unwrap());
        let (lahetin, _) = tokio::sync::broadcast::channel(64);
        let tila = Arc::new(Tila {
            varasto,
            laite: "koe".to_string(),
            headless: false,
            avain: AVAIN.to_string(),
            vanha: Some(vanha),
            vanha_avain: None,
            vertaiset: vec![],
            lr_vertainen: None,
            adapteri: Default::default(),
            lahetin,
            peili: Default::default(),
        });
        let app = api::router_valilla(tila, Duration::from_millis(100));
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        Ydin {
            db,
            osoite,
            asiakas: reqwest::Client::new(),
            pyynnot,
        }
    }

    fn kutsut(&self) -> usize {
        self.pyynnot.lock().unwrap().len()
    }

    /// (tila, X-Lahde, runko)
    async fn hae(&self, polku: &str) -> (u16, String, Value) {
        let v = self
            .asiakas
            .get(format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        vastaus(v).await
    }

    async fn laheta_pyynto(&self, polku: &str) -> (u16, String, Value) {
        let v = self
            .asiakas
            .post(format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        vastaus(v).await
    }

    /// Lähetys lähdetilaan; palauttaa HLC:n.
    async fn lahde(&self, laji: &str, laite: &str, sisalto: Value) -> Hlc {
        let v = self
            .asiakas
            .post(format!("{}/api/lahde/{laji}", self.osoite))
            .bearer_auth(AVAIN)
            .json(&json!({"laite": laite, "sisalto": sisalto}))
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200, "{laji}");
        let r: Value = v.json().await.unwrap();
        Hlc::parse(r["aika"].as_str().unwrap()).unwrap()
    }
}

async fn vastaus(v: reqwest::Response) -> (u16, String, Value) {
    let tila = v.status().as_u16();
    let lahde = v
        .headers()
        .get("x-lahde")
        .map(|h| h.to_str().unwrap().to_string())
        .unwrap_or_default();
    (tila, lahde, v.json().await.unwrap())
}

fn asetukset() -> Value {
    json!({
        "yhteiset": {"automaattijatko": true, "autopack": false, "agyluvat": true},
        "istunnot": {
            "i1": {"automaattijatko": false, "autopack": true},
            "i2": {"automaattijatko": true, "autopack": true},
            "i3": {"automaattijatko": false, "autopack": false}
        },
        "skoopit": {"yksi": ["i1"], "kaksi": ["i2", "i3"], "nolla": [], "scopes x": ["i1"]}
    })
}

const REITIT: [&str; 7] = [
    "/api/asetukset",
    "/api/skoopit/yksi/asetukset",
    "/api/skoopit/kaksi/asetukset?istunto=i3",
    "/api/kayttoraja",
    "/api/kayttoraja?tyyppi=agy&agentti=agy-x&skooppi=s&ryhma=3p",
    "/api/android",
    "/api/skoopit/nimi%20x/asetukset?istunto=",
];

#[tokio::test]
async fn ilman_lahdeyksikkoa_kaikki_sillasta() {
    let y = Ydin::kaynnista().await;
    for (i, polku) in REITIT.iter().enumerate() {
        let (tila, lahde, runko) = y.hae(polku).await;
        assert_eq!((tila, lahde.as_str()), (200, "silta"), "{polku}");
        // Polku ja kysely muuttumattomina.
        assert_eq!(
            runko,
            json!({"silta": true, "metodi": "GET", "polku": polku}),
            "{polku}"
        );
        assert_eq!(y.kutsut(), i + 1);
    }
    // Vain osa lajeista lähetetty: muut reitit pysyvät sillalla.
    y.lahde("asetukset", "a", asetukset()).await;
    assert_eq!(y.hae("/api/asetukset").await.1, "ydin");
    assert_eq!(y.hae("/api/android").await.1, "silta");
    assert_eq!(y.hae("/api/kayttoraja").await.1, "silta");
}

#[tokio::test]
async fn siemennetty_lahdetila_vastaa_ytimesta() {
    let y = Ydin::kaynnista().await;
    let android = json!({"yhteys": "ok", "akku": 80, "uusi_kentta": [1, {"x": null}]});
    y.lahde("asetukset", "a", asetukset()).await;
    y.lahde(
        "kayttoraja",
        "a",
        json!({"claude": {"osuus": 0.4}, "agy": {"osuus": 0.1}}),
    )
    .await;
    y.lahde("android", "a", android.clone()).await;

    let (tila, lahde, runko) = y.hae("/api/asetukset").await;
    assert_eq!((tila, lahde.as_str()), (200, "ydin"));
    assert_eq!(runko, asetukset()["yhteiset"]);
    let (tila, lahde, runko) = y.hae("/api/skoopit/yksi/asetukset").await;
    assert_eq!((tila, lahde.as_str()), (200, "ydin"));
    assert_eq!(runko["istunto"], "i1");
    let (tila, lahde, runko) = y.hae("/api/kayttoraja").await;
    assert_eq!((tila, lahde.as_str()), (200, "ydin"));
    assert_eq!(runko, json!({"osuus": 0.4}));
    let (tila, lahde, runko) = y.hae("/api/android").await;
    assert_eq!((tila, lahde.as_str()), (200, "ydin"));
    assert_eq!(runko, android);
    assert_eq!(y.kutsut(), 0, "mock-vanha sai pyynnön");
}

#[tokio::test]
async fn skoopin_asetukset_haarat() {
    let y = Ydin::kaynnista().await;
    y.lahde("asetukset", "a", asetukset()).await;
    let hae = |p: &'static str| {
        let y = &y;
        async move {
            let (tila, lahde, runko) = y.hae(p).await;
            assert_eq!(lahde, "ydin", "{p}");
            (tila, runko)
        }
    };
    // tuntematon skooppi
    assert_eq!(
        hae("/api/skoopit/ei-ole/asetukset").await,
        (404, json!({"virhe": "tuntematon skooppi"}))
    );
    // yksi avoin istunto valitaan itsestään
    assert_eq!(
        hae("/api/skoopit/yksi/asetukset").await,
        (
            200,
            json!({"istunto": "i1", "istuntoja": 1, "automaattijatko": false, "autopack": true})
        )
    );
    // prosenttikoodattu nimi
    assert_eq!(
        hae("/api/skoopit/scopes%20x/asetukset").await.1["istunto"],
        "i1"
    );
    // useita istuntoja, ei ?istunto: yhteiset ilman agyluvat
    let yhteiset =
        json!({"istunto": null, "istuntoja": 2, "automaattijatko": true, "autopack": false});
    assert_eq!(
        hae("/api/skoopit/kaksi/asetukset").await,
        (200, yhteiset.clone())
    );
    // tyhjä ?istunto= on sama kuin puuttuva
    assert_eq!(
        hae("/api/skoopit/kaksi/asetukset?istunto=").await,
        (200, yhteiset)
    );
    // ei istuntoja
    assert_eq!(
        hae("/api/skoopit/nolla/asetukset").await,
        (
            200,
            json!({"istunto": null, "istuntoja": 0, "automaattijatko": true, "autopack": false})
        )
    );
    // ?istunto annettu ja kuuluu skooppiin
    assert_eq!(
        hae("/api/skoopit/kaksi/asetukset?istunto=i3").await,
        (
            200,
            json!({"istunto": "i3", "istuntoja": 2, "automaattijatko": false, "autopack": false})
        )
    );
    // ?istunto annettu mutta ei kuulu tähän skooppiin (i2 on toisessa; zzz ei missään)
    let ei_loydy = json!({"virhe": "istuntoa ei löydy tästä skoopista"});
    assert_eq!(
        hae("/api/skoopit/yksi/asetukset?istunto=i2").await,
        (404, ei_loydy.clone())
    );
    assert_eq!(
        hae("/api/skoopit/kaksi/asetukset?istunto=zzz").await,
        (404, ei_loydy.clone())
    );
    // ?istunto yhden istunnon skoopissa: valittu täsmälleen
    assert_eq!(
        hae("/api/skoopit/yksi/asetukset?istunto=i1").await,
        (
            200,
            json!({"istunto": "i1", "istuntoja": 1, "automaattijatko": false, "autopack": true})
        )
    );
    // nolla-skoopissa mikä tahansa ?istunto
    assert_eq!(
        hae("/api/skoopit/nolla/asetukset?istunto=i1").await,
        (404, ei_loydy)
    );
    assert_eq!(y.kutsut(), 0);
}

fn raja(claude: Value, agy: Value) -> Value {
    json!({"claude": claude, "agy": agy})
}

#[tokio::test]
async fn kayttoraja_on_agy_ehdot() {
    let y = Ydin::kaynnista().await;
    y.lahde(
        "kayttoraja",
        "a",
        raja(json!({"k": "claude"}), json!({"k": "agy"})),
    )
    .await;
    let claude = json!({"k": "claude"});
    let agy = json!({"k": "agy"});
    // lahde/agy puuttuu: skooppi ei vielä tee agy:tä
    let (tila, lahde, runko) = y.hae("/api/kayttoraja?skooppi=agyskooppi").await;
    assert_eq!((tila, lahde.as_str(), &runko), (200, "ydin", &claude));
    y.lahde(
        "agy",
        "a",
        json!([{"skooppi": "agyskooppi", "id": 1}, {"skooppi": "toinen"}]),
    )
    .await;
    let tapaukset: [(&str, &Value); 17] = [
        ("", &claude),
        ("?tyyppi=claude", &claude),
        ("?tyyppi=agy", &agy),
        ("?tyyppi=gemini", &agy),
        ("?agentti=android/gemini", &agy),
        ("?agentti=agy-malli", &agy),
        ("?agentti=agy", &agy),
        ("?agentti=antigravity-x", &agy),
        ("?agentti=google-gemini-pro", &agy),
        ("?agentti=claude-opus", &claude),
        // skooppi + lahde/agy
        ("?skooppi=agyskooppi", &agy),
        ("?skooppi=toinen", &agy),
        ("?skooppi=claudeskooppi", &claude),
        ("?skooppi=agyskooppi&tyyppi=claude", &claude),
        ("?skooppi=agyskooppi&agentti=claude-opus", &claude),
        ("?skooppi=agyskooppi&tyyppi=agy", &agy),
        ("?skooppi=agyskooppi&agentti=muu", &agy),
    ];
    for (kysely, odotettu) in tapaukset {
        let (tila, lahde, runko) = y.hae(&format!("/api/kayttoraja{kysely}")).await;
        assert_eq!((tila, lahde.as_str()), (200, "ydin"), "{kysely}");
        assert_eq!(&runko, odotettu, "{kysely}");
    }
    // ryhma: vain gemini peilissä
    let ryhma_virhe = json!({"virhe": "ryhmä ei peilissä"});
    for kysely in [
        "?ryhma=3p",
        "?ryhma=3p&tyyppi=agy",
        "?ryhma=claude&tyyppi=claude",
    ] {
        let (tila, lahde, runko) = y.hae(&format!("/api/kayttoraja{kysely}")).await;
        assert_eq!((tila, lahde.as_str(), &runko), (404, "ydin", &ryhma_virhe));
    }
    assert_eq!(
        y.hae("/api/kayttoraja?ryhma=gemini&tyyppi=agy").await.2,
        agy
    );
    assert_eq!(y.hae("/api/kayttoraja?ryhma=gemini").await.2, claude);
    assert_eq!(y.hae("/api/kayttoraja?ryhma=").await.2, claude);
    assert_eq!(y.kutsut(), 0);
}

#[tokio::test]
async fn kayttoraja_null_on_502() {
    let y = Ydin::kaynnista().await;
    let virhe = json!({"virhe": "kayttoraja", "kohde": "adapteri"});
    y.lahde("kayttoraja", "a", raja(Value::Null, json!({"k": "agy"})))
        .await;
    let (tila, lahde, runko) = y.hae("/api/kayttoraja").await;
    assert_eq!((tila, lahde.as_str(), &runko), (502, "ydin", &virhe));
    let (tila, _, runko) = y.hae("/api/kayttoraja?tyyppi=agy").await;
    assert_eq!((tila, runko), (200, json!({"k": "agy"})));
    y.lahde("kayttoraja", "a", raja(json!({"k": "claude"}), Value::Null))
        .await;
    let (tila, lahde, runko) = y.hae("/api/kayttoraja?tyyppi=gemini").await;
    assert_eq!((tila, lahde.as_str(), &runko), (502, "ydin", &virhe));
    let (tila, _, runko) = y.hae("/api/kayttoraja").await;
    assert_eq!((tila, runko), (200, json!({"k": "claude"})));
    assert_eq!(y.kutsut(), 0);
}

#[tokio::test]
async fn kaksi_laitetta_uusin_hlc_voittaa() {
    let y = Ydin::kaynnista().await;
    let vali = || tokio::time::sleep(Duration::from_millis(20));
    let mut a = asetukset();
    a["yhteiset"]["autopack"] = json!("laite-a");
    let mut b = asetukset();
    b["yhteiset"]["autopack"] = json!("laite-b");
    let ta = y.lahde("asetukset", "a", a.clone()).await;
    y.lahde("android", "a", json!({"laite": "a"})).await;
    vali().await;
    let tb = y.lahde("asetukset", "b", b.clone()).await;
    y.lahde("android", "b", json!({"laite": "b"})).await;
    assert!(tb > ta);
    // b on uudempi
    assert_eq!(y.hae("/api/asetukset").await.2["autopack"], "laite-b");
    assert_eq!(y.hae("/api/android").await.2, json!({"laite": "b"}));
    assert_eq!(
        y.hae("/api/skoopit/yksi/asetukset").await.2["istunto"],
        "i1"
    );
    // a lähettää uudelleen: nyt a on uusin
    vali().await;
    let ta2 = y.lahde("asetukset", "a", a).await;
    y.lahde("android", "a", json!({"laite": "a2"})).await;
    assert!(ta2 > tb);
    assert_eq!(y.hae("/api/asetukset").await.2["autopack"], "laite-a");
    assert_eq!(y.hae("/api/android").await.2, json!({"laite": "a2"}));
    // kayttoraja: sama sääntö
    y.lahde("kayttoraja", "a", raja(json!({"k": "a"}), json!(1)))
        .await;
    vali().await;
    y.lahde("kayttoraja", "b", raja(json!({"k": "b"}), json!(2)))
        .await;
    assert_eq!(y.hae("/api/kayttoraja").await.2, json!({"k": "b"}));
    assert_eq!(y.kutsut(), 0);
}

#[tokio::test]
async fn kirjoitus_reitit_menevat_edelleen_sillalle() {
    let y = Ydin::kaynnista().await;
    // Lähdetila siemennetty, jotta GET-reitti olisi aktiivinen, jos POST osuisi siihen.
    y.lahde("asetukset", "a", asetukset()).await;
    for polku in [
        "/api/asetukset/x/paalle",
        "/api/skoopit/yksi/asetukset/x/paalle",
        "/api/skoopit/yksi/asetukset/x/pois?istunto=i1",
    ] {
        let (tila, lahde, runko) = y.laheta_pyynto(polku).await;
        assert_eq!((tila, lahde.as_str()), (200, "silta"), "{polku}");
        assert_eq!(
            runko,
            json!({"silta": true, "metodi": "POST", "polku": polku})
        );
    }
    assert_eq!(y.kutsut(), 3);
}
