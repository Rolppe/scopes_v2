//! HTTP-API (T-19): tunnistus S-6, virta S-1 ja tilavarasto S-4 oikealla palvelimella satunnaisportissa.

use rusqlite::Connection;
use scopes_ydin::api::{self, Tila};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";

/// Väliaikainen tietokantatiedosto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("api-{}-{n}.db", std::process::id())))
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

    fn pyynto(&self, metodi: reqwest::Method, polku: &str) -> reqwest::RequestBuilder {
        self.asiakas
            .request(metodi, format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
    }

    fn get(&self, polku: &str) -> reqwest::RequestBuilder {
        self.pyynto(reqwest::Method::GET, polku)
    }

    fn put(&self, polku: &str, runko: Value) -> reqwest::RequestBuilder {
        self.pyynto(reqwest::Method::PUT, polku).json(&runko)
    }

    /// Kirjoittaa lisäysyksikön (polku "skoopit" → lisäysyhdistäjä) ja ilmoittaa virtaan.
    async fn kirjoita(&self, id: &str, laskuri: u64) -> u64 {
        let y = Yksikko {
            polku: "skoopit".to_string(),
            id: id.to_string(),
            versio: BTreeMap::from([("oneplus".to_string(), laskuri)]),
            aika: Hlc {
                ms: 1_800_000_000_000 + laskuri,
                laskuri: 0,
                laite: "oneplus".to_string(),
            },
            sisalto: None,
            poistettu: false,
        };
        api::kirjoita_ja_ilmoita(&self.tila, &y)
            .await
            .unwrap()
            .unwrap()
    }
}

/// Lukee virtaa, kunnes `valmis` hyväksyy kertyneen tekstin tai aikaraja täyttyy.
async fn lue_kunnes(vastaus: &mut reqwest::Response, valmis: impl Fn(&str) -> bool) -> String {
    let mut puskuri = String::new();
    let raja = tokio::time::Instant::now() + Duration::from_secs(5);
    while !valmis(&puskuri) {
        let pala = tokio::time::timeout_at(raja, vastaus.chunk())
            .await
            .unwrap_or_else(|_| panic!("aikaraja; saatu tähän asti: {puskuri:?}"))
            .unwrap()
            .expect("virta päättyi");
        puskuri.push_str(std::str::from_utf8(&pala).unwrap());
    }
    puskuri
}

fn ilman_ka(s: &str) -> String {
    s.replace(": ka\n\n", "")
}

#[tokio::test]
async fn ilman_avainta_401() {
    let p = Palvelin::kaynnista().await;
    for polku in ["/api/virta", "/api/tila/x", "/api/tila", "/api/tuntematon"] {
        let v = p
            .asiakas
            .get(format!("{}{polku}", p.osoite))
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 401, "{polku}");
        let runko: Value = v.json().await.unwrap();
        assert_eq!(runko, json!({"virhe": "avain puuttuu tai väärä"}));
    }
    for otsikko in ["Bearer vaara", "Bearer ", "Basic koeavain-1234", AVAIN] {
        let v = p
            .asiakas
            .get(format!("{}/api/tila/x", p.osoite))
            .header("Authorization", otsikko)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 401, "{otsikko}");
    }
    // Oikealla avaimella tuntematon avain on 404, ei 401.
    assert_eq!(p.get("/api/tila/x").send().await.unwrap().status(), 404);
}

#[tokio::test]
async fn terveys_ilman_avainta() {
    let p = Palvelin::kaynnista().await;
    let hae = |p: &Palvelin| p.asiakas.get(format!("{}/api/terveys", p.osoite)).send();
    let v = hae(&p).await.unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(
        v.json::<Value>().await.unwrap(),
        json!({"ok": true, "v2": true, "seq": 0})
    );
    p.kirjoita("a", 1).await;
    let v = hae(&p).await.unwrap().json::<Value>().await.unwrap();
    assert_eq!(v["seq"], 1);
}

#[tokio::test]
async fn virran_muoto() {
    let p = Palvelin::kaynnista().await;
    let mut v = p.get("/api/virta?since=0").send().await.unwrap();
    assert_eq!(v.status(), 200);
    let otsikot = v.headers();
    assert!(otsikot["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    assert_eq!(otsikot["cache-control"], "no-cache");
    assert_eq!(otsikot["x-accel-buffering"], "no");
    p.kirjoita("oneplus-7", 7).await;
    let odotettu = format!(
        "id: 1\nevent: muutos\ndata: {{\"seq\":1,\"polku\":\"skoopit\",\"id\":\"oneplus-7\",\"versio\":{{\"oneplus\":7}},\"aika\":\"{}\"}}\n\n",
        Hlc {
            ms: 1_800_000_000_007,
            laskuri: 0,
            laite: "oneplus".to_string()
        }
    );
    let teksti = lue_kunnes(&mut v, |s| s.contains("event: muutos\n")).await;
    assert_eq!(ilman_ka(&teksti), odotettu);
}

#[tokio::test]
async fn ilman_since_vain_uudet() {
    let p = Palvelin::kaynnista().await;
    p.kirjoita("vanha", 1).await;
    let mut v = p.get("/api/virta").send().await.unwrap();
    p.kirjoita("uusi", 2).await;
    let teksti = lue_kunnes(&mut v, |s| s.contains("event: muutos\n")).await;
    assert!(teksti.contains("id: 2\n"), "{teksti}");
    assert!(teksti.contains("\"id\":\"uusi\""), "{teksti}");
    assert!(!teksti.contains("vanha"), "{teksti}");
}

#[tokio::test]
async fn last_event_id_jatkaa_ja_voittaa() {
    let p = Palvelin::kaynnista().await;
    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        p.kirjoita(id, i as u64 + 1).await;
    }
    // Pelkkä since.
    let mut v = p.get("/api/virta?since=1").send().await.unwrap();
    let t = lue_kunnes(&mut v, |s| s.contains("id: 3\n")).await;
    assert!(t.contains("id: 2\n") && !t.contains("id: 1\n"), "{t}");
    // Otsikko voittaa: since=0 tuottaisi kaiken, otsikko 2 vain seq 3.
    let mut v = p
        .get("/api/virta?since=0")
        .header("Last-Event-ID", "2")
        .send()
        .await
        .unwrap();
    let t = lue_kunnes(&mut v, |s| s.contains("id: 3\n")).await;
    assert!(!t.contains("id: 1\n") && !t.contains("id: 2\n"), "{t}");
    // Jatko elävänä: uusi kirjoitus tulee heti paikkauksen jälkeen.
    p.kirjoita("d", 4).await;
    let t = lue_kunnes(&mut v, |s| s.contains("id: 4\n")).await;
    assert!(t.contains("\"id\":\"d\""), "{t}");
}

#[tokio::test]
async fn nollaus_kun_since_lokin_alun_takana() {
    let p = Palvelin::kaynnista().await;
    for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
        p.kirjoita(id, i as u64 + 1).await;
    }
    // Lokin alku karsitaan: jäljellä seq 3 ja 4.
    let c = Connection::open(&p._tmp.0).unwrap();
    c.execute("DELETE FROM muutosloki WHERE seq < 3", [])
        .unwrap();
    drop(c);
    let mut v = p.get("/api/virta?since=0").send().await.unwrap();
    let t = lue_kunnes(&mut v, |s| s.contains("event: nollaus\n")).await;
    assert_eq!(ilman_ka(&t), "event: nollaus\ndata: {\"seq\":4}\n\n");
    // since=2 on vielä jatkuva (seuraava on 3); since edellä lokia on nollaus.
    let mut v = p.get("/api/virta?since=2").send().await.unwrap();
    let t = lue_kunnes(&mut v, |s| s.contains("id: 4\n")).await;
    assert!(t.starts_with("id: 3\n") && !t.contains("nollaus"), "{t}");
    let mut v = p.get("/api/virta?since=99").send().await.unwrap();
    let t = lue_kunnes(&mut v, |s| s.contains("event: nollaus\n")).await;
    assert_eq!(ilman_ka(&t), "event: nollaus\ndata: {\"seq\":4}\n\n");
    // Nollauksen jälkeen virta jatkuu uusista.
    p.kirjoita("e", 5).await;
    let t = lue_kunnes(&mut v, |s| s.contains("id: 5\n")).await;
    assert!(!t.contains("id: 4\n"), "{t}");
}

#[tokio::test]
async fn virheellinen_since_400() {
    let p = Palvelin::kaynnista().await;
    let v = p.get("/api/virta?since=x").send().await.unwrap();
    assert_eq!(v.status(), 400);
}

#[tokio::test]
async fn keep_alive_valilla() {
    let p = Palvelin::kaynnista().await;
    let mut v = p.get("/api/virta").send().await.unwrap();
    let t = lue_kunnes(&mut v, |s| s.matches(": ka\n\n").count() >= 2).await;
    assert!(t.starts_with(": ka\n\n"), "{t:?}");
}

#[tokio::test]
async fn tila_put_get_404_etuliite() {
    let p = Palvelin::kaynnista().await;
    let v = p.get("/api/tila/valittu-skooppi").send().await.unwrap();
    assert_eq!(v.status(), 404);

    let mut virta = p.get("/api/virta").send().await.unwrap();

    let v = p
        .put("/api/tila/valittu-skooppi", json!({"arvo": "scopes macos"}))
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    let aika1 = v.json::<Value>().await.unwrap()["aika"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        Hlc::parse(&aika1).is_some() && aika1.ends_with("-koe"),
        "{aika1}"
    );

    let v = p.get("/api/tila/valittu-skooppi").send().await.unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(
        v.json::<Value>().await.unwrap(),
        json!({"avain": "valittu-skooppi", "arvo": "scopes macos", "aika": aika1, "laite": "koe"})
    );

    // Toinen PUT korvaa (LWW), aika kasvaa, arvo voi olla mitä tahansa JSONia.
    let v = p
        .put(
            "/api/tila/valittu-skooppi",
            json!({"arvo": {"a": [1, null]}}),
        )
        .send()
        .await
        .unwrap();
    let aika2 = v.json::<Value>().await.unwrap()["aika"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(Hlc::parse(&aika2).unwrap() > Hlc::parse(&aika1).unwrap());
    let v = p.get("/api/tila/valittu-skooppi").send().await.unwrap();
    assert_eq!(
        v.json::<Value>().await.unwrap()["arvo"],
        json!({"a": [1, null]})
    );

    // Avain, jossa kenoviiva ja välilyönti (prosenttikoodattuna).
    let v = p
        .put("/api/tila/luonnos/scopes%20macos", json!({"arvo": "moi"}))
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    p.put("/api/tila/luonnos/chat", json!({"arvo": ""}))
        .send()
        .await
        .unwrap();
    let v = p
        .get("/api/tila/luonnos/scopes%20macos")
        .send()
        .await
        .unwrap();
    assert_eq!(
        v.json::<Value>().await.unwrap()["avain"],
        "luonnos/scopes macos"
    );

    let v = p.get("/api/tila?etuliite=luonnos/").send().await.unwrap();
    assert_eq!(v.status(), 200);
    let runko = v.json::<Value>().await.unwrap();
    let avaimet: Vec<&str> = runko["tilat"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["avain"].as_str().unwrap())
        .collect();
    assert_eq!(avaimet, ["luonnos/chat", "luonnos/scopes macos"]);
    let kaikki = p.get("/api/tila").send().await.unwrap();
    let kaikki = kaikki.json::<Value>().await.unwrap();
    assert_eq!(kaikki["tilat"].as_array().unwrap().len(), 3);

    // Virheelliset rungot.
    for runko in [json!({}), json!([1])] {
        let v = p.put("/api/tila/x", runko).send().await.unwrap();
        assert_eq!(v.status(), 400);
    }
    let v = p
        .pyynto(reqwest::Method::PUT, "/api/tila/x")
        .body("ei json")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 400);

    // Jokainen kirjoitus näkyy virrassa polulla "tila", id = avain.
    let t = lue_kunnes(&mut virta, |s| s.contains("id: 4\n")).await;
    assert!(
        t.contains("\"polku\":\"tila\",\"id\":\"valittu-skooppi\""),
        "{t}"
    );
    assert!(t.contains("\"id\":\"luonnos/scopes macos\""), "{t}");
}

#[tokio::test]
async fn kuittaus_vaatii_kokonaisluvun() {
    let p = Palvelin::kaynnista().await;
    let v = p
        .put("/api/tila/kuittaus/scopes macos", json!({"arvo": 12}))
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    let v = p
        .get("/api/tila/kuittaus/scopes%20macos")
        .send()
        .await
        .unwrap();
    assert_eq!(v.json::<Value>().await.unwrap()["arvo"], 12);
    for arvo in [json!("12"), json!(1.5), json!(null)] {
        let v = p
            .put("/api/tila/kuittaus/x", json!({ "arvo": arvo }))
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 400);
    }
}

#[test]
fn avain_luodaan_ja_luetaan() {
    use std::os::unix::fs::PermissionsExt;
    let kansio = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "avain-{}-{}",
        std::process::id(),
        LASKURI.fetch_add(1, Ordering::SeqCst)
    ));
    let tiedosto = kansio.join("alikansio/avain");
    let a = api::lataa_avain(&tiedosto).unwrap();
    assert_eq!(a.len(), 64);
    assert!(a
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/'));
    let tila = std::fs::metadata(&tiedosto).unwrap().permissions().mode();
    assert_eq!(tila & 0o777, 0o600);
    // Uudelleenkäynnistys käyttää samaa avainta.
    assert_eq!(api::lataa_avain(&tiedosto).unwrap(), a);
    let _ = std::fs::remove_dir_all(&kansio);
}

/// S-5 / R-1: peili-POST tuottaa virtaan tapahtuman polulle `peili`, ei sisäiselle `peili-offset`-polulle.
#[tokio::test]
async fn peili_virrassa_ilman_peili_offsetia() {
    use sha2::{Digest, Sha256};
    let p = Palvelin::kaynnista().await;
    let mut v = p.get("/api/virta?since=0").send().await.unwrap();
    let rivit = vec![r#"{"type":"user"}"#.to_string(), "toinen rivi".to_string()];
    let mut sha = Sha256::new();
    for r in &rivit {
        sha.update(r.as_bytes());
        sha.update(b"\n");
    }
    let sha: String = sha.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let r = p
        .pyynto(reqwest::Method::POST, "/api/peili")
        .json(&json!({"tiedosto": "koe/t.jsonl", "offset": 0, "rivit": rivit, "sha256": sha}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    // Peilin jälkeinen merkki: kun se on virrassa, kaikki peilin tapahtumat on jo lähetetty.
    let merkki = p.kirjoita("merkki", 1).await;
    let teksti = lue_kunnes(&mut v, |s| s.contains(&format!("id: {merkki}\n"))).await;
    assert!(teksti.contains("\"polku\":\"peili\""), "{teksti}");
    assert!(!teksti.contains("peili-offset"), "{teksti}");
    // Offset-yksikkö on silti varastossa (suodatus koskee vain virtaa).
    let loki = p.tila.varasto.loki(0, 100).unwrap();
    assert!(loki.iter().any(|t| t.polku == "peili-offset"));
}
