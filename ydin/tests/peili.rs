//! Transkriptipeili (T-30, S-5a): offset-tarkistus, 409, sha256, yksikkö varastossa ja tapahtuma virrassa.

use scopes_ydin::api::{self, Tila};
use scopes_ydin::muutosloki::Tapahtuma;
use scopes_ydin::peili;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yhdistaja, Yksikko};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";

struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("peili-{}-{n}.db", std::process::id())))
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
            lahetin,
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

    async fn laheta(&self, runko: Value) -> (u16, Value) {
        let v = self
            .asiakas
            .post(format!("{}/api/peili", self.osoite))
            .bearer_auth(AVAIN)
            .json(&runko)
            .send()
            .await
            .unwrap();
        (v.status().as_u16(), v.json().await.unwrap())
    }

    async fn offset(&self, tiedosto: &str) -> (u16, Value) {
        let v = self
            .asiakas
            .get(format!("{}/api/peili/{tiedosto}/offset", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        (v.status().as_u16(), v.json().await.unwrap())
    }
}

fn tiiviste(rivit: &[&str]) -> String {
    let mut sha = Sha256::new();
    for r in rivit {
        sha.update(r.as_bytes());
        sha.update(b"\n");
    }
    sha.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn runko(tiedosto: &str, offset: u64, rivit: &[&str]) -> Value {
    json!({"tiedosto": tiedosto, "offset": offset, "rivit": rivit, "sha256": tiiviste(rivit)})
}

async fn tapahtuma(rx: &mut Receiver<Tapahtuma>) -> Tapahtuma {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("aikaraja")
        .unwrap()
}

const T: &str = "-home-user-koe/abc.jsonl";

#[tokio::test]
async fn uusi_tiedosto_offset_nolla() {
    let p = Palvelin::kaynnista().await;
    let (tila, runko) = p.offset(T).await;
    assert_eq!(tila, 200);
    assert_eq!(runko, json!({"offset": 0}));
    assert_eq!(peili::offset(&p.tila.varasto, T).unwrap(), 0);
}

#[tokio::test]
async fn offset_etenee_ja_get_vastaa() {
    let p = Palvelin::kaynnista().await;
    // "{\"a\":1}" = 7 tavua + rivinvaihto; "ä" on kaksi tavua UTF-8:ssa.
    let (tila, v) = p.laheta(runko(T, 0, &["{\"a\":1}", "{\"ä\":2}"])).await;
    assert_eq!((tila, v), (200, json!({"offset": 8 + 9})));
    let (tila, v) = p.laheta(runko(T, 17, &["{\"b\":3}"])).await;
    assert_eq!((tila, v), (200, json!({"offset": 25})));
    assert_eq!(p.offset(T).await, (200, json!({"offset": 25})));
    assert_eq!(peili::offset(&p.tila.varasto, T).unwrap(), 25);
    // Toinen tiedosto on itsenäinen.
    assert_eq!(p.offset("muu.jsonl").await.1, json!({"offset": 0}));
}

#[tokio::test]
async fn vaara_offset_409_ja_ytimen_offset() {
    let p = Palvelin::kaynnista().await;
    p.laheta(runko(T, 0, &["{\"a\":1}"])).await;
    let (tila, v) = p.laheta(runko(T, 0, &["{\"x\":9}"])).await;
    assert_eq!((tila, v), (409, json!({"offset": 8})));
    let (tila, v) = p.laheta(runko(T, 100, &["{\"x\":9}"])).await;
    assert_eq!((tila, v), (409, json!({"offset": 8})));
    // Hylätty lähetys ei kirjoita mitään.
    assert_eq!(peili::rivit(&p.tila.varasto, T).unwrap(), vec!["{\"a\":1}"]);
    // Toipuminen ytimen offsetista onnistuu.
    let (tila, v) = p.laheta(runko(T, 8, &["{\"x\":9}"])).await;
    assert_eq!((tila, v), (200, json!({"offset": 16})));
}

#[tokio::test]
async fn vaara_sha256_400() {
    let p = Palvelin::kaynnista().await;
    let mut r = runko(T, 0, &["{\"a\":1}"]);
    r["sha256"] = json!("00".repeat(32));
    let (tila, _) = p.laheta(r).await;
    assert_eq!(tila, 400);
    assert_eq!(p.offset(T).await.1, json!({"offset": 0}));
    assert!(peili::rivit(&p.tila.varasto, T).unwrap().is_empty());
}

#[tokio::test]
async fn puutteellinen_runko_400() {
    let p = Palvelin::kaynnista().await;
    for r in [
        json!({"offset": 0, "rivit": [], "sha256": tiiviste(&[])}),
        json!({"tiedosto": T, "rivit": [], "sha256": tiiviste(&[])}),
        json!({"tiedosto": T, "offset": 0, "rivit": [1], "sha256": tiiviste(&[])}),
        json!({"tiedosto": T, "offset": 0, "rivit": []}),
        json!([1, 2]),
    ] {
        assert_eq!(p.laheta(r.clone()).await.0, 400, "{r}");
    }
}

#[tokio::test]
async fn yksikko_varastossa_ja_tapahtuma_virrassa() {
    let p = Palvelin::kaynnista().await;
    let mut rx = p.tila.lahetin.subscribe();
    p.laheta(runko(T, 0, &["{\"a\":1}", "{\"b\":2}"])).await;
    let y = p
        .tila
        .varasto
        .lue("peili", &format!("{T}:0"))
        .unwrap()
        .expect("peiliyksikkö");
    let rivit: Vec<String> = serde_json::from_slice(&y.sisalto.unwrap()).unwrap();
    assert_eq!(rivit, vec!["{\"a\":1}", "{\"b\":2}"]);
    assert!(!y.poistettu);
    let t = tapahtuma(&mut rx).await;
    assert_eq!(
        (t.polku.as_str(), t.id.as_str()),
        ("peili", &*format!("{T}:0"))
    );
    // Sisäinen offset-yksikkö on varastossa mutta ei broadcast-kanavassa.
    let o = p
        .tila
        .varasto
        .lue("peili-offset", T)
        .unwrap()
        .expect("offset-yksikkö");
    assert_eq!(
        serde_json::from_slice::<Value>(&o.sisalto.unwrap()).unwrap(),
        json!({"offset": 16})
    );
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn rivit_palauttaa_kaikki_jarjestyksessa() {
    let p = Palvelin::kaynnista().await;
    // Offsetit 0, 8, 16, ... ylittävät merkkijonojärjestyksen (10 < 9 tekstinä).
    let mut offset = 0;
    let mut odotettu = Vec::new();
    for i in 0..12 {
        let rivi = format!("{{\"i\":{i}}}");
        let (tila, v) = p.laheta(runko(T, offset, &[&rivi])).await;
        assert_eq!(tila, 200);
        offset = v["offset"].as_u64().unwrap();
        odotettu.push(rivi);
    }
    // Toisen tiedoston rivit eivät sekoitu.
    p.laheta(runko("muu.jsonl", 0, &["{\"m\":1}"])).await;
    assert_eq!(peili::rivit(&p.tila.varasto, T).unwrap(), odotettu);
    assert_eq!(
        peili::rivit(&p.tila.varasto, "muu.jsonl").unwrap(),
        vec!["{\"m\":1}"]
    );
    assert!(peili::rivit(&p.tila.varasto, "ei.jsonl")
        .unwrap()
        .is_empty());
}

/// Peiliyksikkö suoraan varastoon (ilman offset-tarkistusta): rivit = [`<tiedosto>/<offset>`].
fn peiliyksikko(v: &Varasto, tiedosto: &str, offset: u64) {
    let rivi = format!("{tiedosto}/{offset}");
    let y = Yksikko {
        polku: "peili".to_string(),
        id: format!("{tiedosto}:{offset}"),
        versio: BTreeMap::from([("koe".to_string(), 1)]),
        aika: Hlc {
            ms: 1_800_000_000_000,
            laskuri: 0,
            laite: "koe".to_string(),
        },
        sisalto: Some(serde_json::to_vec(&[rivi]).unwrap()),
        poistettu: false,
    };
    v.kirjoita(&y, Yhdistaja::Lisays).unwrap();
}

#[test]
fn rivit_vain_tiedoston_yksikot_valihaulla() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    // 3 tiedostoa × 500 yksikköä; offsetit 0..500 ylittävät kymmenpotenssit (9 → 10, 99 → 100).
    // "a" on "ab":n ja "a:b":n etuliite; "a:b":n yksikkö "a:b:0" osuu "a":n avainväliin.
    for t in ["a", "ab", "a:b"] {
        for o in 0..500 {
            peiliyksikko(&v, t, o);
        }
    }
    for t in ["a", "ab", "a:b"] {
        let odotettu: Vec<String> = (0..500).map(|o| format!("{t}/{o}")).collect();
        assert_eq!(peili::rivit(&v, t).unwrap(), odotettu, "{t}");
    }
    // rivit_alkaen: vain offsetista k alkaen; seuraava = viimeisen yksikön loppu.
    let (rivit, seuraava) = peili::rivit_alkaen(&v, "a", 100).unwrap();
    let odotettu: Vec<String> = (100..500).map(|o| format!("a/{o}")).collect();
    assert_eq!(rivit, odotettu);
    assert_eq!(seuraava, 499 + "a/499".len() as u64 + 1);
    let (rivit, seuraava) = peili::rivit_alkaen(&v, "a", 9).unwrap();
    assert_eq!(rivit.first().map(String::as_str), Some("a/9"));
    assert_eq!(rivit.len(), 491);
    assert_eq!(seuraava, 505);
    // Offsetin jälkeen ei uusia: tyhjä ja sama offset.
    assert_eq!(peili::rivit_alkaen(&v, "a", 505).unwrap(), (vec![], 505));
    assert_eq!(peili::rivit_alkaen(&v, "ei", 0).unwrap(), (vec![], 0));
}

/// R-3: offsetia edeltävien yksiköiden sisältöä ei lueta. Rikkinäinen (ei JSON-taulukko) sisältö
/// offsetin alla ei vaikuta; sama sisältö offsetin kohdalla on virhe, joten sisältö luetaan vain sieltä.
#[test]
fn rivit_alkaen_ei_lue_offsetia_edeltavia_sisaltoja() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    for o in [0, 10] {
        let y = Yksikko {
            polku: "peili".to_string(),
            id: format!("r:{o}"),
            versio: BTreeMap::from([("koe".to_string(), 1)]),
            aika: Hlc {
                ms: 1_800_000_000_000,
                laskuri: 0,
                laite: "koe".to_string(),
            },
            sisalto: Some(b"ei json".to_vec()),
            poistettu: false,
        };
        v.kirjoita(&y, Yhdistaja::Lisays).unwrap();
    }
    peiliyksikko(&v, "r", 20);
    let (rivit, seuraava) = peili::rivit_alkaen(&v, "r", 20).unwrap();
    assert_eq!(rivit, vec!["r/20".to_string()]);
    assert_eq!(seuraava, 20 + "r/20".len() as u64 + 1);
    assert!(peili::rivit_alkaen(&v, "r", 10).is_err());
}

#[tokio::test]
async fn ilman_avainta_401() {
    let p = Palvelin::kaynnista().await;
    let v = p
        .asiakas
        .get(format!("{}/api/peili/{T}/offset", p.osoite))
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 401);
}
