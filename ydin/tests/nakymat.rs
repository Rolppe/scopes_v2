//! Johdetut reitit (T-35): lähde- ja peilisyötteet varastoon → vastaukset vastaavat vanhan 8787:n fixtureita,
//! `since`-ero, nollaus ja X-Lahde; lähde puuttuu → mock-silta vastaa.
//! R-1: rekisterikentät ja `/api/rekisterit/<p>` ytimen `rekisterit/<p>`-yksiköistä (odotetut arvot
//! `rekisterit-ydin-odotettu.json`, tuotettu lahteet.mjs:llä synteettisistä `rekisteri-*.md`-teksteistä) ja
//! siltavälimuisti (`/api/skoopit` ei kutsu siltaa pyyntöä kohden).

use axum::{
    extract::Path,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use scopes_ydin::api::{self, Tila};
use scopes_ydin::lr;
use scopes_ydin::nakymat;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::rekisteri::{self, Laite, Rivi};
use scopes_ydin::yksikko::{Hlc, Yhdistaja, Yksikko};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";
const MACOS: &str = "scopes macos";
const ISTUNTO: &str = "28f5f18b-5ca1-41d3-9ebd-680e09cfd7bd";
const TIEDOSTO: &str = "-home-user-palvelin/28f5f18b-5ca1-41d3-9ebd-680e09cfd7bd.jsonl";

fn fixture(nimi: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixture")
        .join(nimi);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn fixture_json(nimi: &str) -> Value {
    serde_json::from_str(&fixture(nimi)).unwrap()
}

/// Rekursiivinen vertailu. Sallitut erot: avaimet `jonossa` ja `agy` missä tahansa sekä annetut polut.
fn erot(polku: &str, a: &Value, b: &Value, sallitut: &[&str], ulos: &mut Vec<String>) {
    if sallitut.contains(&polku) {
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let avaimet: std::collections::BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            for k in avaimet {
                if k == "jonossa" || k == "agy" {
                    continue;
                }
                let p = format!("{polku}/{k}");
                match (x.get(k), y.get(k)) {
                    (Some(u), Some(v)) => erot(&p, u, v, sallitut, ulos),
                    _ if sallitut.contains(&p.as_str()) => {}
                    (u, v) => ulos.push(format!("{p}: {u:?} != {v:?}")),
                }
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                ulos.push(format!("{polku}: pituus {} != {}", x.len(), y.len()));
                return;
            }
            for (i, (u, v)) in x.iter().zip(y).enumerate() {
                erot(&format!("{polku}/{i}"), u, v, sallitut, ulos);
            }
        }
        (Value::Number(x), Value::Number(y)) if x.as_f64() == y.as_f64() => {}
        _ if a == b => {}
        _ => ulos.push(format!("{polku}: {a} != {b}")),
    }
}

fn vastaa_fixturea(saatu: &Value, odotettu: &Value, sallitut: &[&str]) {
    let mut e = Vec::new();
    erot("", saatu, odotettu, sallitut, &mut e);
    assert!(e.is_empty(), "eroja {}:\n{}", e.len(), e.join("\n"));
}

// ---- mock-silta (vanha 8787) --------------------------------------------------------------------------------------

/// Sillan skooppilista: rekisterikentät fixturesta, istuntokentät sotkettu (ydin johtaa ne lähteestä).
fn sillan_lista() -> Value {
    let mut l = fixture_json("skoopit.json");
    for s in l.as_array_mut().unwrap() {
        if s["istuntoja"].as_u64() != Some(0) || s["tila"] != "pakattu" {
            s["istuntoja"] = json!(0);
            s["suurinKonteksti"] = Value::Null;
            s["tila"] = json!("pakattu");
            s["aika"] = json!("2026-01-01T00:00:00.000Z");
        }
    }
    l
}

async fn mock_skooppi(Path(nimi): Path<String>) -> Response {
    match nimi.as_str() {
        MACOS => {
            let mut s = fixture_json("skooppi-scopes macos.json");
            let i = &s["istunnot"][0];
            // Vain kentät, joita lähteessä ei ole; muut sotkettu.
            let sotkettu = json!([{
                "id": i["id"], "nimi": i["nimi"], "pid": i["pid"], "vanhempi": i["vanhempi"], "polku": i["polku"],
                "tila": "busy", "konteksti": null, "alkoi": 1,
            }]);
            s["istunnot"] = sotkettu;
            Json(s).into_response()
        }
        "test" => Json(fixture_json("skooppi-test.json")).into_response(),
        muu if sillan_lista()
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["nimi"] == muu) =>
        {
            Json(json!({"nimi": muu, "istunnot": [], "jonossa": []})).into_response()
        }
        _ => (
            StatusCode::NOT_FOUND,
            Json(json!({"virhe": "tuntematon skooppi"})),
        )
            .into_response(),
    }
}

/// Mock-sillan tila: `/api/skoopit`-kutsujen määrä, vastauksen viive ja muutettava lista.
struct Mock {
    skoopit_kutsut: AtomicUsize,
    viive: Duration,
    lista: Mutex<Value>,
}

impl Mock {
    fn uusi(viive: Duration) -> Arc<Mock> {
        Arc::new(Mock {
            skoopit_kutsut: AtomicUsize::new(0),
            viive,
            lista: Mutex::new(sillan_lista()),
        })
    }

    fn kutsut(&self) -> usize {
        self.skoopit_kutsut.load(Ordering::SeqCst)
    }
}

async fn mock_vanha(mock: Arc<Mock>) -> String {
    let app =
        Router::new()
            .route(
                "/api/skoopit",
                get(move || {
                    let m = mock.clone();
                    async move {
                        m.skoopit_kutsut.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(m.viive).await;
                        let lista = m.lista.lock().unwrap().clone();
                        Json(lista)
                    }
                }),
            )
            .route("/api/skoopit/:nimi", get(mock_skooppi))
            .route(
                "/api/skoopit/:nimi/viestit",
                get(|Path(nimi): Path<String>| async move {
                    Json(json!({"silta": true, "nimi": nimi}))
                }),
            )
            .route(
                "/api/agentit",
                get(|| async { Json(fixture_json("agentit.json")) }),
            )
            .route(
                "/api/rekisterit",
                get(|| async { Json(fixture_json("rekisterit.json")) }),
            )
            .route(
                "/api/rekisterit/*polku",
                get(|| async { ([(header::CONTENT_TYPE, "text/markdown")], "# rekisteri\n") }),
            );
    let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(kuuntelija, app).await.unwrap();
    });
    osoite
}

// ---- ydin --------------------------------------------------------------------------------------------------------

struct Ydin {
    db: PathBuf,
    tila: Arc<Tila>,
    osoite: String,
    asiakas: reqwest::Client,
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
        Ydin::kaynnista_mockilla(Mock::uusi(Duration::ZERO)).await
    }

    async fn kaynnista_mockilla(mock: Arc<Mock>) -> Ydin {
        let vanha = mock_vanha(mock).await;
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        let db = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("nakymat-{}-{n}.db", std::process::id()));
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
        let app = api::router_valilla(tila.clone(), Duration::from_millis(100));
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        Ydin {
            db,
            tila,
            osoite,
            asiakas: reqwest::Client::new(),
        }
    }

    async fn hae(&self, polku: &str) -> (StatusCode, String, Value) {
        let v = self
            .asiakas
            .get(format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        let tila = StatusCode::from_u16(v.status().as_u16()).unwrap();
        let lahde = v
            .headers()
            .get("x-lahde")
            .map(|h| h.to_str().unwrap().to_string())
            .unwrap_or_default();
        let teksti = v.text().await.unwrap();
        let runko = serde_json::from_str(&teksti).unwrap_or(Value::String(teksti));
        (tila, lahde, runko)
    }

    async fn post(&self, polku: &str, runko: Value) -> Value {
        let v = self
            .asiakas
            .post(format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
            .json(&runko)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200, "{polku}");
        v.json().await.unwrap()
    }

    async fn lahde(&self, laji: &str, runko: Value) {
        self.post(&format!("/api/lahde/{laji}"), runko).await;
    }

    /// Lisää rivit peiliin; palauttaa uuden offsetin.
    async fn peili(&self, tiedosto: &str, offset: u64, rivit: &[String]) -> u64 {
        let mut sha = Sha256::new();
        for r in rivit {
            sha.update(r.as_bytes());
            sha.update(b"\n");
        }
        let sha: String = sha.finalize().iter().map(|b| format!("{b:02x}")).collect();
        let v = self
            .post(
                "/api/peili",
                json!({"tiedosto": tiedosto, "offset": offset, "rivit": rivit, "sha256": sha}),
            )
            .await;
        v["offset"].as_u64().unwrap()
    }

    /// Fixture-syötteet varastoon: lahde/istunnot, lahde/agy ja synteettinen transkripti.
    async fn syota(&self) -> u64 {
        self.lahde("istunnot", fixture_json("lahde-istunnot.json"))
            .await;
        self.lahde("agy", fixture_json("lahde-agy.json")).await;
        self.peili(TIEDOSTO, 0, &transkripti()).await
    }

    async fn seq(&self) -> u64 {
        let (_, _, t) = self.hae("/api/terveys").await;
        t["seq"].as_u64().unwrap()
    }
}

fn transkripti() -> Vec<String> {
    fixture("peili-scopes macos.jsonl")
        .lines()
        .map(str::to_string)
        .collect()
}

fn kayttajan_rivi(teksti: &str) -> String {
    json!({"type": "user", "timestamp": "2026-10-19T13:00:00.000Z", "message": {"role": "user", "content": teksti}})
        .to_string()
}

// ---- testit ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn johdetut_vastaavat_8787_fixtureita() {
    let y = Ydin::kaynnista().await;
    y.syota().await;

    let (k, l, r) = y.hae("/api/skoopit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    vastaa_fixturea(&r, &fixture_json("skoopit.json"), &[]);

    let (k, l, r) = y.hae("/api/skoopit/scopes%20macos").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    vastaa_fixturea(&r, &fixture_json("skooppi-scopes macos.json"), &[]);

    let (k, l, r) = y.hae("/api/skoopit/test").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    vastaa_fixturea(&r, &fixture_json("skooppi-test.json"), &[]);

    // Istunnon nimi ei kulje lahde/istunnot-sisällössä (T-29): ytimessä null.
    let (k, l, r) = y.hae("/api/skoopit/scopes%20macos/viestit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    vastaa_fixturea(
        &r,
        &fixture_json("viestit-scopes macos.json"),
        &["/istunto/nimi"],
    );
    assert_eq!(r["istunto"]["nimi"], Value::Null);
    assert_eq!(r["viestit"].as_array().unwrap().len(), 17);

    let (k, l, r) = y.hae("/api/skoopit/test/viestit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    vastaa_fixturea(&r, &fixture_json("viestit-test.json"), &[]);

    // Tuntematon skooppi: sillan 404 sellaisenaan.
    let (k, _, r) = y.hae("/api/skoopit/ei-ole").await;
    assert_eq!(k, StatusCode::NOT_FOUND);
    assert_eq!(r["virhe"], "tuntematon skooppi");
}

#[tokio::test]
async fn lahde_puuttuu_silta_vastaa() {
    let y = Ydin::kaynnista().await;

    let (k, l, r) = y.hae("/api/skoopit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "silta"));
    assert_eq!(r, sillan_lista());

    let (k, l, r) = y.hae("/api/skoopit/test/viestit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "silta"));
    assert_eq!(r, json!({"silta": true, "nimi": "test"}));

    // Vain lahde/istunnot, ei lahde/agy: agy-osa puuttuu → silta.
    y.lahde("istunnot", fixture_json("lahde-istunnot.json"))
        .await;
    let (_, l, _) = y.hae("/api/skoopit").await;
    assert_eq!(l, "silta");
    let (_, l, r) = y.hae("/api/skoopit/scopes%20macos").await;
    assert_eq!(l, "silta");
    assert_eq!(r["istunnot"][0]["tila"], "busy");

    // since sillasta: kaikki nollauksena.
    let (k, l, r) = y.hae("/api/skoopit?since=1").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "silta"));
    assert_eq!(r["nollaus"], true);
    assert_eq!(r["muuttuneet"], sillan_lista());
    assert_eq!(r["poistetut"], json!([]));

    // Lähteettömät reitit (agentit; rekisterit ennen T-33) aina sillasta.
    let (k, l, r) = y.hae("/api/agentit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "silta"));
    vastaa_fixturea(&r, &fixture_json("agentit.json"), &[]);
    let (k, l, r) = y.hae("/api/rekisterit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "silta"));
    vastaa_fixturea(&r, &fixture_json("rekisterit.json"), &[]);
    let v = y
        .asiakas
        .get(format!("{}/api/rekisterit/claude/REKISTERI.md", y.osoite))
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap();
    assert_eq!(v.headers()["x-lahde"], "silta");
    assert_eq!(v.headers()["content-type"], "text/markdown");
    assert_eq!(v.text().await.unwrap(), "# rekisteri\n");

    let (k, _, _) = y.hae("/api/skoopit?since=x").await;
    assert_eq!(k, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn since_skoopit_vain_muuttuneet_ja_nollaus() {
    let y = Ydin::kaynnista().await;
    y.syota().await;
    let (_, _, kaikki) = y.hae("/api/skoopit").await;
    let s = y.seq().await;

    let (k, l, r) = y.hae(&format!("/api/skoopit?since={s}")).await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    assert_eq!(r, json!({"seq": s, "muuttuneet": [], "poistetut": []}));

    // Yksi istunto muuttuu (scopes kordinaattori busy → idle): vain sen skooppi.
    let mut lahde = fixture_json("lahde-istunnot.json");
    for i in lahde["sisalto"].as_array_mut().unwrap() {
        if i["skooppi"] == "scopes kordinaattori" {
            i["tila"] = json!("idle");
        }
    }
    y.lahde("istunnot", lahde).await;
    let (_, _, r) = y.hae(&format!("/api/skoopit?since={s}")).await;
    let muuttuneet = r["muuttuneet"].as_array().unwrap();
    assert_eq!(muuttuneet.len(), 1, "{r}");
    assert_eq!(muuttuneet[0]["nimi"], "scopes kordinaattori");
    assert_eq!(muuttuneet[0]["tila"], "odottaa");
    assert!(r["seq"].as_u64().unwrap() > s);
    assert!(r.get("nollaus").is_none());

    // Skoopin oma näkymä: muuttui vain kordinaattori.
    let (_, _, r) = y
        .hae(&format!("/api/skoopit/scopes%20kordinaattori?since={s}"))
        .await;
    assert_eq!(r["muuttuneet"].as_array().unwrap().len(), 1);
    let (_, _, r) = y.hae(&format!("/api/skoopit/test?since={s}")).await;
    assert_eq!(r["muuttuneet"], json!([]));

    // Peilirivit eivät muuta skooppilistaa.
    let s2 = y.seq().await;
    let offset = transkripti().iter().map(|r| r.len() as u64 + 1).sum();
    y.peili(TIEDOSTO, offset, &[kayttajan_rivi("lisää")]).await;
    let (_, _, r) = y.hae(&format!("/api/skoopit?since={s2}")).await;
    assert_eq!(r["muuttuneet"], json!([]));

    // Tulevaisuuden since ja näkymää vanhempi since → nollaus, kaikki mukana.
    for since in [y.seq().await + 100, 0] {
        let (_, _, r) = y.hae(&format!("/api/skoopit?since={since}")).await;
        assert_eq!(r["nollaus"], true);
        assert_eq!(
            r["muuttuneet"].as_array().unwrap().len(),
            kaikki.as_array().unwrap().len()
        );
    }
}

#[tokio::test]
async fn since_viestit_tunnisteet_lisaykset_ja_poistot() {
    let y = Ydin::kaynnista().await;
    let mut offset = y.syota().await;
    let polku = "/api/skoopit/scopes%20macos/viestit";
    let (_, _, alku) = y.hae(polku).await;
    let s = y.seq().await;
    let (_, l, r) = y.hae(&format!("{polku}?since={s}")).await;
    assert_eq!(l, "ydin");
    assert_eq!(r, json!({"seq": s, "muuttuneet": [], "poistetut": []}));

    // Kaksi uutta riviä: uudet viestit + avoin kysymys muuttuu vastatuksi.
    let n = transkripti().len();
    let uudet = vec![kayttajan_rivi("eka uusi"), kayttajan_rivi("toka uusi")];
    offset = y.peili(TIEDOSTO, offset, &uudet).await;
    let (_, _, r) = y.hae(&format!("{polku}?since={s}")).await;
    let m = r["muuttuneet"].as_array().unwrap();
    let idt: Vec<&str> = m.iter().map(|v| v["id"].as_str().unwrap()).collect();
    let viimeinen = alku["viestit"].as_array().unwrap().len();
    assert_eq!(viimeinen, 17);
    assert_eq!(
        idt,
        vec![
            format!("{ISTUNTO}:{n}"),
            format!("{ISTUNTO}:{}", n + 1),
            format!("{ISTUNTO}:{}", n + 2),
        ]
    );
    assert_eq!(m[0]["rooli"], "kysymys");
    assert_eq!(m[0]["vastattu"], true);
    assert_eq!(m[1]["teksti"], "eka uusi");
    assert_eq!(m[2]["teksti"], "toka uusi");
    assert_eq!(r["poistetut"], json!([]));

    // Saman rivin useat viestit: <istunto>:<rivinro>, <istunto>:<rivinro>.1 … (vakaat nollauksessa).
    let (_, _, r) = y.hae(&format!("{polku}?since=0")).await;
    assert_eq!(r["nollaus"], true);
    let kaikki = r["muuttuneet"].as_array().unwrap();
    assert_eq!(kaikki.len(), 19);
    assert_eq!(kaikki[2]["id"], format!("{ISTUNTO}:6"));
    assert_eq!(kaikki[3]["id"], format!("{ISTUNTO}:6.1"));
    assert_eq!(kaikki[9]["id"], format!("{ISTUNTO}:6.7"));

    // 130 uutta riviä: ikkuna 120 → vanhat tunnisteet poistetuiksi.
    let s2 = y.seq().await;
    let paljon: Vec<String> = (0..130)
        .map(|i| kayttajan_rivi(&format!("viesti {i}")))
        .collect();
    y.peili(TIEDOSTO, offset, &paljon).await;
    let (_, _, r) = y.hae(&format!("{polku}?since={s2}")).await;
    assert_eq!(r["muuttuneet"].as_array().unwrap().len(), 120);
    let poistetut: Vec<&str> = r["poistetut"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(poistetut.len(), 19 + 10);
    assert!(poistetut.contains(&format!("{ISTUNTO}:2").as_str()));
    assert!(poistetut.contains(&format!("{ISTUNTO}:{}", n + 3).as_str()));
    let (_, _, koko) = y.hae(polku).await;
    let viestit = koko["viestit"].as_array().unwrap();
    assert_eq!(viestit.len(), 120);
    assert_eq!(viestit[119]["teksti"], "viesti 129");
}

#[tokio::test]
async fn erat_vastaavat_taytta_lukua_ja_lukevat_vain_uudet() {
    let polku = "/api/skoopit/scopes%20macos/viestit";
    let uudet: Vec<Vec<String>> = (0..3)
        .map(|e| {
            (0..4)
                .map(|i| kayttajan_rivi(&format!("erä {e} rivi {i}")))
                .collect()
        })
        .collect();

    // Täysi luku: näkymä rakennetaan vasta, kun kaikki rivit ovat peilissä.
    let a = Ydin::kaynnista().await;
    let mut offset = a.syota().await;
    for u in &uudet {
        offset = a.peili(TIEDOSTO, offset, u).await;
    }
    let (_, _, taysi) = a.hae(polku).await;

    // Erät: seuranta alkaa ensimmäisellä haulla, sen jälkeen jokainen lähetys on oma eränsä.
    let b = Ydin::kaynnista().await;
    let mut offset = b.syota().await;
    b.hae(polku).await;
    for u in &uudet {
        offset = b.peili(TIEDOSTO, offset, u).await;
        b.hae(polku).await;
    }
    let (_, _, erina) = b.hae(polku).await;
    assert_eq!(erina, taysi);
    assert_eq!(
        taysi["viestit"].as_array().unwrap().last().unwrap()["teksti"],
        "erä 2 rivi 3"
    );

    // Jo sovellettu yksikkö ei lue uudelleen: rikottu sisältö vanhassa yksikössä (offset 0) ei kaada
    // erää, koska rivit_alkaen ohittaa offsetin alle jäävät yksiköt ennen jäsennystä.
    let rikottu = Yksikko {
        polku: "peili".to_string(),
        id: format!("{TIEDOSTO}:0"),
        versio: BTreeMap::from([("koe".to_string(), 99)]),
        aika: Hlc {
            ms: 4_000_000_000_000,
            laskuri: 0,
            laite: "koe".to_string(),
        },
        sisalto: Some(b"ei json".to_vec()),
        poistettu: false,
    };
    assert!(b
        .tila
        .varasto
        .kirjoita(&rikottu, Yhdistaja::Lww)
        .unwrap()
        .is_some());
    let n = nakymat::nakyma(&b.tila);
    n.paivita(&b.tila)
        .expect("erä ei lue jo sovellettua yksikköä");
    assert_eq!(n.seq(), b.tila.varasto.seq().unwrap());
    let (_, _, jalkeen) = b.hae(polku).await;
    assert_eq!(jalkeen["viestit"], taysi["viestit"]);
    // Sama rikottu yksikkö täydessä luvussa on virhe: testi erottaa erä- ja täyden luvun.
    assert!(scopes_ydin::peili::rivit(&b.tila.varasto, TIEDOSTO).is_err());
}

#[tokio::test]
async fn kaynnista_pitaa_nakyman_ajan_tasalla() {
    let y = Ydin::kaynnista().await;
    let n = nakymat::nakyma(&y.tila);
    let kasittelija = nakymat::kaynnista(y.tila.clone());
    y.syota().await;
    let tavoite = y.seq().await;
    let mut odotettu = 0;
    while n.seq() < tavoite && odotettu < 50 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        odotettu += 1;
    }
    assert_eq!(n.seq(), tavoite);
    kasittelija.abort();
}

// ---- R-1: rekisterikentät ytimestä ---------------------------------------------------------------------------------

const NYT: &str = "2026-10-19T00:00:00.000Z";

fn hlc(ms: u64) -> Hlc {
    Hlc {
        ms,
        laskuri: 0,
        laite: "koe".to_string(),
    }
}

/// Rivin lisäkentät `rekisterit-meta/<p>`-yksikön sisältönä (lr.rs `Lisat`).
fn lisat(r: &Rivi) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "laji": r.laji, "osio": r.osio, "jarjestys": r.jarjestys,
        "muutettu": r.muutettu, "muuttaja": r.muuttaja,
        "lahdeSisalto": r.lahde_sisalto, "lahdeVersio": r.lahde_versio,
    }))
    .unwrap()
}

/// Rekisteriteksti varastoon lr.rs:n mallilla: rivit `rekisteri::pilko`n osina (tuo_rekisteri) polkuun
/// `rekisterit/<p>` (Lr), meta ja rivien lisäkentät polkuun `rekisterit-meta/<p>` (Lww).
fn tallenna_rekisteri(tila: &Tila, polku: &str, teksti: &str) -> rekisteri::Rekisteri {
    let mut rv = rekisteri::Varasto::default();
    let mut laite = Laite::uusi("koe");
    rv.tuo_rekisteri(&mut laite, polku, teksti, "c0ffee", NYT)
        .unwrap();
    let rek = rv.rekisterit[polku].clone();
    let meta = Yksikko {
        polku: format!("rekisterit-meta/{polku}"),
        id: "meta".to_string(),
        versio: rek.meta.versio.clone(),
        aika: hlc(1_000),
        sisalto: Some(serde_json::to_vec(&rek.meta).unwrap()),
        poistettu: false,
    };
    api::kirjoita_yhdistajalla(tila, &meta, Yhdistaja::Lww).unwrap();
    for (i, r) in rek.rivit.values().enumerate() {
        let lisa = Yksikko {
            polku: format!("rekisterit-meta/{polku}"),
            id: r.id.clone(),
            versio: r.versio.clone(),
            aika: hlc(1_001 + i as u64),
            sisalto: Some(lisat(r)),
            poistettu: false,
        };
        api::kirjoita_yhdistajalla(tila, &lisa, Yhdistaja::Lww).unwrap();
        api::kirjoita_yhdistajalla(tila, &r.yksikko(hlc(1_001 + i as u64)), Yhdistaja::Lr).unwrap();
    }
    assert_eq!(
        lr::teksti(&tila.varasto, polku),
        teksti,
        "lr::teksti {polku}"
    );
    rek
}

fn odotettu(polku: &str) -> Value {
    fixture_json("rekisterit-ydin-odotettu.json")[polku].clone()
}

/// Ytimen rekisterit: test/REKISTERI.md (skooppi test) ja jaettu scopes/macos/REKISTERI.md (leimatut rivit).
async fn syota_rekisterit(y: &Ydin) -> rekisteri::Rekisteri {
    let r = tallenna_rekisteri(&y.tila, "test/REKISTERI.md", &fixture("rekisteri-test.md"));
    tallenna_rekisteri(
        &y.tila,
        "scopes/macos/REKISTERI.md",
        &fixture("rekisteri-jaettu.md"),
    );
    r
}

#[tokio::test]
async fn rekisterikentat_ytimesta() {
    let y = Ydin::kaynnista().await;
    y.syota().await;
    let rek_test = syota_rekisterit(&y).await;

    // (a) Yksityiskohta: seuraava/avoimet/viat ytimestä, muut kentät kuten ennen.
    let o = odotettu("test/REKISTERI.md");
    let (k, l, r) = y.hae("/api/skoopit/test").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    for kentta in ["seuraava", "avoimet", "viat"] {
        assert_eq!(r[kentta], o[kentta], "{kentta}");
    }
    assert_ne!(r["seuraava"], fixture_json("skooppi-test.json")["seuraava"]);
    vastaa_fixturea(
        &r,
        &fixture_json("skooppi-test.json"),
        &["/seuraava", "/avoimet", "/viat"],
    );
    // Jaettu rekisteri: leimattu [scopes macos] voittaa leimattoman.
    let o_macos = odotettu("scopes/macos/REKISTERI.md");
    let (_, l, r) = y.hae("/api/skoopit/scopes%20macos").await;
    assert_eq!(l, "ydin");
    for kentta in ["seuraava", "avoimet", "viat"] {
        assert_eq!(r[kentta], o_macos[kentta], "{kentta}");
    }
    assert_eq!(r["seuraava"]["id"], "MACOS-SYNTEETTINEN");

    // (a) Lista: test ja scopes macos ytimestä; (b) muut rivit sillan kentin.
    let mut lista = fixture_json("skoopit.json");
    for rivi in lista.as_array_mut().unwrap() {
        let o = match rivi["nimi"].as_str().unwrap() {
            "test" => &o,
            "scopes macos" => &o_macos,
            _ => continue,
        };
        for kentta in ["seuraava", "avoimia", "vikoja"] {
            rivi[kentta] = o["lista"][kentta].clone();
        }
    }
    let (k, l, r) = y.hae("/api/skoopit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    vastaa_fixturea(&r, &lista, &[]);
    let test_rivi = r
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["nimi"] == "test")
        .unwrap();
    assert_eq!(test_rivi["avoimia"], 2);
    assert_eq!(test_rivi["vikoja"], 2);

    // (c) Rekisterin osat ytimestä, tokenit UTF-16-pituudesta.
    let (k, l, r) = y.hae("/api/rekisterit/test/REKISTERI.md").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    assert_eq!(
        r,
        json!({"polku": "test/REKISTERI.md", "osat": o["osat"].clone()})
    );
    let tekstit: Vec<&str> = r["osat"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["teksti"].as_str().unwrap())
        .collect();
    assert!(tekstit.iter().any(|t| t.contains('ä') && t.contains('ö')));
    assert!(tekstit.iter().any(|t| t.chars().any(|c| c as u32 > 0xFFFF)));
    assert!(r["osat"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["otsikko"] == "Pitkä luku › Toinen alaluku"));
    let (_, l, r) = y
        .hae("/api/rekisterit/scopes/macos/REKISTERI.md?since=0")
        .await;
    assert_eq!(l, "ydin");
    assert_eq!(r["nollaus"], true);
    assert_eq!(r["muuttuneet"][0]["osat"], o_macos["osat"]);
    // Puuttuva rekisteri → silta.
    let v = y
        .asiakas
        .get(format!("{}/api/rekisterit/claude/REKISTERI.md", y.osoite))
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap();
    assert_eq!(v.headers()["x-lahde"], "silta");
    assert_eq!(v.text().await.unwrap(), "# rekisteri\n");
    let (_, l, r) = y.hae("/api/rekisterit").await;
    assert_eq!(l, "silta");
    vastaa_fixturea(&r, &fixture_json("rekisterit.json"), &[]);

    // (d) rekisterit/*-kirjoitus: since palauttaa skoopin muuttuneena uusin kentin.
    let s = y.seq().await;
    let (_, _, r) = y.hae(&format!("/api/skoopit?since={s}")).await;
    assert_eq!(r["muuttuneet"], json!([]));
    let rivi = rek_test
        .rivit
        .values()
        .find(|r| r.sisalto.contains("| Ensimmäinen |"))
        .unwrap();
    let mut versio = rivi.versio.clone();
    *versio.entry("koe".to_string()).or_default() += 1;
    let uusi = Rivi {
        sisalto: rivi.sisalto.replace("avoin 19.10.2026", "valmis"),
        versio,
        ..rivi.clone()
    };
    api::kirjoita_ja_ilmoita(&y.tila, &uusi.yksikko(hlc(9_000)))
        .await
        .unwrap()
        .unwrap();
    let (_, l, r) = y.hae(&format!("/api/skoopit?since={s}")).await;
    assert_eq!(l, "ydin");
    let test_rivi = r["muuttuneet"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["nimi"] == "test")
        .cloned()
        .unwrap_or_else(|| panic!("test puuttuu: {r}"));
    assert_eq!(test_rivi["avoimia"], 1);
    let (_, _, r) = y.hae(&format!("/api/skoopit/test?since={s}")).await;
    let m = r["muuttuneet"].as_array().unwrap();
    assert_eq!(m.len(), 1);
    assert_eq!(m[0]["avoimet"][0]["Tila"], "valmis");
}

#[tokio::test]
async fn skoopit_siltavalimuistista_ilman_synkronista_siltaa() {
    let viive = Duration::from_millis(500);
    let vali = Duration::from_millis(1000);
    let mock = Mock::uusi(viive);
    let y = Ydin::kaynnista_mockilla(mock.clone()).await;
    y.syota().await;
    let kasittelija = nakymat::kaynnista_valilla(y.tila.clone(), vali);

    // Lämmitys: ensimmäinen pyyntö (tai taustahaku) täyttää välimuistin.
    let (k, l, _) = y.hae("/api/skoopit").await;
    assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
    assert!(mock.kutsut() >= 1);

    let alku = std::time::Instant::now();
    let c0 = mock.kutsut();
    for i in 0..20 {
        let t = std::time::Instant::now();
        let (k, l, r) = y.hae("/api/skoopit").await;
        let kesto = t.elapsed();
        assert_eq!((k, l.as_str()), (StatusCode::OK, "ydin"));
        assert_eq!(r.as_array().unwrap().len(), 92);
        assert!(kesto < Duration::from_millis(100), "pyyntö {i}: {kesto:?}");
    }
    let kulunut = alku.elapsed();
    let lisaa = mock.kutsut() - c0;
    // Taustapäivitys enintään kerran välissä (+1 kesken ollut), ei pyyntöä kohden.
    let raja = (kulunut.as_millis() / vali.as_millis()) as usize + 2;
    assert!(
        lisaa <= raja,
        "siltakutsuja {lisaa} / {kulunut:?} (raja {raja})"
    );

    // Sillan muutos näkyy viimeistään taustavälin (+ sillan viive) jälkeen, since nostaa vain muuttuneen rivin.
    let s = y.seq().await;
    let (_, _, r) = y.hae(&format!("/api/skoopit?since={s}")).await;
    assert_eq!(r["muuttuneet"], json!([]));
    {
        let mut l = mock.lista.lock().unwrap();
        let rivi = l
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["nimi"] == "claude")
            .unwrap();
        rivi["avoimia"] = json!(999);
    }
    let muutos = std::time::Instant::now();
    loop {
        let (_, _, r) = y.hae("/api/skoopit").await;
        let claude = r
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["nimi"] == "claude")
            .unwrap()
            .clone();
        if claude["avoimia"] == 999 {
            break;
        }
        assert!(
            muutos.elapsed() < vali + viive + Duration::from_millis(1000),
            "muutos ei näkynyt taustavälin jälkeen"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (_, _, r) = y.hae(&format!("/api/skoopit?since={s}")).await;
    let nimet: Vec<&str> = r["muuttuneet"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["nimi"].as_str().unwrap())
        .collect();
    assert_eq!(nimet, vec!["claude"]);
    kasittelija.abort();
}
