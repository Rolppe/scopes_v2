//! Kahden solmun tilatesti (T-28): kaksi oikeaa `scopes-solmu`-prosessia (portit 18797 ja 18798,
//! eivät tuotantoportteja). Ensimmäinen mittaa tila-avaimen kulun A:lta B:lle (raja 1 000 ms),
//! toinen varmistaa, ettei headless-solmu lähetä UI-avaimia mutta lähettää `kuittaus/*`-avaimet.
//!
//! Replikointi vetää: kummallekin annetaan toinen `--vertainen`-arvoksi. Testit ottavat yhteisen
//! lukon, joten ne eivät kilpaile porteista. `Solmu`-vartija tappaa prosessin myös paniikissa.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const PORTTI_A: u16 = 18797;
const PORTTI_B: u16 = 18798;
const RAJA_MS: u128 = 1_000;
const AVAIN: &str = "koeavain-tila-kaksi-solmua";
static LUKKO: Mutex<()> = Mutex::const_new(());

/// Väliaikainen hakemisto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi(nimi: &str) -> Tmp {
        let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("tila-kaksi-solmua-{}-{nimi}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Käynnissä oleva `scopes-solmu`-prosessi; Drop tappaa sen.
struct Solmu(Child);

impl Solmu {
    fn kaynnista(
        portti: u16,
        data: &Path,
        avain: &Path,
        vertaiset: &[u16],
        headless: bool,
    ) -> Solmu {
        let mut komento = Command::new(env!("CARGO_BIN_EXE_scopes-solmu"));
        komento
            .arg("--portti")
            .arg(portti.to_string())
            .arg("--data")
            .arg(data)
            .arg("--avain")
            .arg(avain)
            .env("SCOPES_LAITE", format!("koe-{portti}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if headless {
            komento.arg("--headless");
        }
        for v in vertaiset {
            komento
                .arg("--vertainen")
                .arg(format!("http://127.0.0.1:{v}"));
        }
        Solmu(komento.spawn().expect("scopes-solmun käynnistys"))
    }
}

impl Drop for Solmu {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Kokoonpano {
    http: reqwest::Client,
    _a: Solmu,
    _b: Solmu,
    _tmp: Tmp,
}

fn osoite(portti: u16, polku: &str) -> String {
    format!("http://127.0.0.1:{portti}{polku}")
}

async fn odota_valmiiksi(http: &reqwest::Client, portti: u16) {
    let raja = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(v) = http.get(osoite(portti, "/api/terveys")).send().await {
            if v.status().is_success() {
                return;
            }
        }
        assert!(
            Instant::now() < raja,
            "solmu {portti} ei käynnistynyt 20 s:ssa"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A (18797) ja B (18798), jotka tilaavat toisensa. `b_headless` käynnistää B:n `--headless`-tilassa.
async fn kaynnista_parit(nimi: &str, b_headless: bool) -> Kokoonpano {
    let tmp = Tmp::uusi(nimi);
    let avaintiedosto = tmp.0.join("avain");
    std::fs::write(&avaintiedosto, format!("{AVAIN}\n")).unwrap();
    let a = Solmu::kaynnista(
        PORTTI_A,
        &tmp.0.join("a"),
        &avaintiedosto,
        &[PORTTI_B],
        false,
    );
    let b = Solmu::kaynnista(
        PORTTI_B,
        &tmp.0.join("b"),
        &avaintiedosto,
        &[PORTTI_A],
        b_headless,
    );
    let http = reqwest::Client::new();
    odota_valmiiksi(&http, PORTTI_A).await;
    odota_valmiiksi(&http, PORTTI_B).await;
    Kokoonpano {
        http,
        _a: a,
        _b: b,
        _tmp: tmp,
    }
}

/// `PUT /api/tila/<avain>` arvolla `{"arvo": arvo}`.
async fn aseta(k: &Kokoonpano, portti: u16, avain: &str, arvo: Value) {
    let v = k
        .http
        .put(osoite(portti, &format!("/api/tila/{avain}")))
        .bearer_auth(AVAIN)
        .json(&json!({ "arvo": arvo }))
        .send()
        .await
        .expect("PUT");
    assert!(v.status().is_success(), "PUT {avain} -> {}", v.status());
}

/// `GET /api/tila/<avain>`: `Some(arvo)`, jos avain on, `None` jos 404.
async fn hae(k: &Kokoonpano, portti: u16, avain: &str) -> Option<Value> {
    let v = k
        .http
        .get(osoite(portti, &format!("/api/tila/{avain}")))
        .bearer_auth(AVAIN)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("GET");
    if v.status() == reqwest::StatusCode::NOT_FOUND {
        return None;
    }
    assert!(v.status().is_success(), "GET {avain} -> {}", v.status());
    let runko: Value = v.json().await.expect("GET-vastauksen JSON");
    Some(runko["arvo"].clone())
}

/// Pollaa solmun GET:ää 50 ms välein, kunnes avain on `odotettu`, tai `raja` ylittyy. Palauttaa
/// kuluneen ajan `alku`sta.
async fn odota_arvoa(
    k: &Kokoonpano,
    portti: u16,
    avain: &str,
    odotettu: &Value,
    alku: Instant,
    raja: Duration,
) -> Duration {
    loop {
        if hae(k, portti, avain).await.as_ref() == Some(odotettu) {
            return alku.elapsed();
        }
        assert!(
            alku.elapsed() < raja,
            "{avain} ei näkynyt solmulla {portti} {} ms:ssa",
            raja.as_millis()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn tilaviive() {
    let _vuoro = LUKKO.lock().await;
    let k = kaynnista_parit("viive", false).await;
    let arvo = json!("hei");
    let alku = Instant::now();
    aseta(&k, PORTTI_A, "luonnos/koe", arvo.clone()).await;
    let kulunut = odota_arvoa(
        &k,
        PORTTI_B,
        "luonnos/koe",
        &arvo,
        alku,
        Duration::from_secs(10),
    )
    .await;
    println!("TILAVIIVE: {}", kulunut.as_millis());
    assert!(
        kulunut.as_millis() < RAJA_MS,
        "tilaviive {} ms >= {RAJA_MS} ms",
        kulunut.as_millis()
    );
}

#[tokio::test]
async fn headless_ei_laheta() {
    let _vuoro = LUKKO.lock().await;
    let k = kaynnista_parit("headless", true).await;
    let alku = Instant::now();
    aseta(&k, PORTTI_B, "luonnos/koe", json!("hei")).await;
    aseta(&k, PORTTI_B, "kuittaus/koe", json!(7)).await;
    // Kuittaus kulkee headless-solmulta A:lle alle sekunnissa: replikointi on siis käynnissä.
    let kulunut = odota_arvoa(
        &k,
        PORTTI_A,
        "kuittaus/koe",
        &json!(7),
        alku,
        Duration::from_secs(10),
    )
    .await;
    println!("HEADLESS-KUITTAUS: {}", kulunut.as_millis());
    assert!(
        kulunut.as_millis() < RAJA_MS,
        "kuittaus {} ms >= {RAJA_MS} ms",
        kulunut.as_millis()
    );
    // UI-avain ei ole kulkenut 3 s:ssa luonnoksen kirjoituksesta.
    let kolme_s = Duration::from_secs(3);
    if let Some(jaljella) = kolme_s.checked_sub(alku.elapsed()) {
        tokio::time::sleep(jaljella).await;
    }
    assert_eq!(
        hae(&k, PORTTI_A, "luonnos/koe").await,
        None,
        "headless-solmun UI-avain luonnos/koe näkyy A:lla"
    );
    // B:llä oma avain on tallessa.
    assert_eq!(hae(&k, PORTTI_B, "luonnos/koe").await, Some(json!("hei")));
}
