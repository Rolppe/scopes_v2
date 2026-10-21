//! Lähdetila (T-30, S-5b): LWW-yksiköt `lahde/<laji>` laitteittain ja tapahtumat virtaan.

use scopes_ydin::api::{self, Tila};
use scopes_ydin::lahde;
use scopes_ydin::muutosloki::Tapahtuma;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::Hlc;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";

struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("lahde-{}-{n}.db", std::process::id())))
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

struct Palvelin {
    _tmp: Tmp,
    tila: Arc<Tila>,
    osoite: String,
    asiakas: reqwest::Client,
}

impl Palvelin {
    async fn kaynnista() -> Palvelin {
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
        Palvelin {
            _tmp: tmp,
            tila,
            osoite,
            asiakas: reqwest::Client::new(),
        }
    }

    async fn laheta(&self, laji: &str, runko: Value) -> (u16, Value) {
        let v = self
            .asiakas
            .post(format!("{}/api/lahde/{laji}", self.osoite))
            .bearer_auth(AVAIN)
            .json(&runko)
            .send()
            .await
            .unwrap();
        (v.status().as_u16(), v.json().await.unwrap())
    }

    async fn hae(&self, laji: &str) -> (u16, Value) {
        let v = self
            .asiakas
            .get(format!("{}/api/lahde/{laji}", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        (v.status().as_u16(), v.json().await.unwrap())
    }
}

#[tokio::test]
async fn istunnot_lahetys_ja_luku() {
    let p = Palvelin::kaynnista().await;
    let sisalto = json!([{
        "istunto": "abc", "skooppi": "ios", "tila": "tyossa", "konteksti": 1234,
        "alkoi": "2026-10-19T07:00:00.000Z", "transkripti": "p/abc.jsonl"
    }]);
    let (tila, v) = p
        .laheta("istunnot", json!({"laite": "oneplus", "sisalto": sisalto}))
        .await;
    assert_eq!(tila, 200);
    let aika = v["aika"].as_str().unwrap();
    assert!(Hlc::parse(aika).is_some(), "{aika}");
    let (tila, v) = p.hae("istunnot").await;
    assert_eq!(tila, 200);
    assert_eq!(
        v,
        json!({"laitteet": [{"laite": "oneplus", "aika": aika, "sisalto": sisalto}]})
    );
    let lue = lahde::lue(&p.tila.varasto, "istunnot").unwrap();
    assert_eq!(lue.len(), 1);
    assert_eq!(lue[0].0, "oneplus");
    assert_eq!(lue[0].1.to_string(), aika);
    assert_eq!(lue[0].2, sisalto);
}

#[tokio::test]
async fn tuntemattomat_kentat_kulkevat_lapi() {
    let p = Palvelin::kaynnista().await;
    let sisalto = json!({
        "sisalto": [{
            "istunto": "abc", "alkoi": null,
            "ladatut": {"alku": "2026-10-19T07:00:00.000Z",
                        "kertynyt": [{"laji": "ohje", "otsikko": "CLAUDE.md", "tokenit": 321}]}
        }],
        "uusi_kentta": [1, {"x": null}]
    });
    let (tila, _) = p
        .laheta("istunnot", json!({"laite": "oneplus", "sisalto": sisalto}))
        .await;
    assert_eq!(tila, 200);
    let (_, v) = p.hae("istunnot").await;
    assert_eq!(v["laitteet"][0]["sisalto"], sisalto);
    assert_eq!(
        v["laitteet"][0]["sisalto"]["sisalto"][0]["ladatut"]["kertynyt"][0]["tokenit"],
        321
    );
    assert_eq!(
        lahde::lue(&p.tila.varasto, "istunnot").unwrap()[0].2,
        sisalto
    );
}

#[tokio::test]
async fn sama_laite_uudelleen_korvaa() {
    let p = Palvelin::kaynnista().await;
    let (_, a) = p
        .laheta("agy", json!({"laite": "linux", "sisalto": [1]}))
        .await;
    let (_, b) = p
        .laheta("agy", json!({"laite": "linux", "sisalto": [2, 3]}))
        .await;
    let (a, b) = (a["aika"].as_str().unwrap(), b["aika"].as_str().unwrap());
    assert!(Hlc::parse(b).unwrap() > Hlc::parse(a).unwrap(), "{a} {b}");
    let (_, v) = p.hae("agy").await;
    let laitteet = v["laitteet"].as_array().unwrap();
    assert_eq!(laitteet.len(), 1);
    assert_eq!(laitteet[0]["sisalto"], json!([2, 3]));
    assert_eq!(laitteet[0]["aika"], b);
}

#[tokio::test]
async fn kaksi_laitetta_molemmat() {
    let p = Palvelin::kaynnista().await;
    p.laheta(
        "android",
        json!({"laite": "puhelin", "sisalto": {"akku": 80}}),
    )
    .await;
    p.laheta(
        "android",
        json!({"laite": "tabletti", "sisalto": {"akku": 55}}),
    )
    .await;
    let (_, v) = p.hae("android").await;
    let laitteet = v["laitteet"].as_array().unwrap();
    assert_eq!(laitteet.len(), 2);
    let mut nimet: Vec<&str> = laitteet
        .iter()
        .map(|l| l["laite"].as_str().unwrap())
        .collect();
    nimet.sort_unstable();
    assert_eq!(nimet, ["puhelin", "tabletti"]);
    let akku =
        |n: &str| laitteet.iter().find(|l| l["laite"] == n).unwrap()["sisalto"]["akku"].clone();
    assert_eq!((akku("puhelin"), akku("tabletti")), (json!(80), json!(55)));
    // Lajit eivät sekoitu.
    assert_eq!(p.hae("kayttoraja").await.1, json!({"laitteet": []}));
}

#[tokio::test]
async fn tuntematon_laji_400() {
    let p = Palvelin::kaynnista().await;
    let (tila, _) = p
        .laheta("tuntematon", json!({"laite": "x", "sisalto": 1}))
        .await;
    assert_eq!(tila, 400);
    assert_eq!(p.hae("tuntematon").await.0, 400);
    assert!(p.tila.varasto.listaa_etuliite("lahde/").unwrap().is_empty());
}

#[tokio::test]
async fn puutteellinen_runko_400() {
    let p = Palvelin::kaynnista().await;
    for r in [
        json!({"sisalto": 1}),
        json!({"laite": "", "sisalto": 1}),
        json!({"laite": "x"}),
        json!([1]),
    ] {
        assert_eq!(p.laheta("kayttoraja", r.clone()).await.0, 400, "{r}");
    }
}

#[tokio::test]
async fn tapahtuma_virtaan() {
    let p = Palvelin::kaynnista().await;
    let mut rx = p.tila.lahetin.subscribe();
    p.laheta(
        "kayttoraja",
        json!({"laite": "oneplus", "sisalto": {"osuus": 0.4}}),
    )
    .await;
    let t: Tapahtuma = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("aikaraja")
        .unwrap();
    assert_eq!(
        (t.polku.as_str(), t.id.as_str()),
        ("lahde/kayttoraja", "oneplus")
    );
    assert!(rx.try_recv().is_err());
}
