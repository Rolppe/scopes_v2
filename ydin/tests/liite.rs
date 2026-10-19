//! Liitteet ytimen reitillä (T-50, S-8b): oikeat `scopes-solmu`-prosessit käyttöjärjestelmän
//! antamissa vapaissa porteissa (`vapaa_portti`), eivät tuotantoportteissa eivätkä kiinteissä
//! koeporteissa 18797/18798, joita muut portit (shared/gate.sh, adapteri/gate.sh, tila_kaksi_solmua)
//! käyttävät: vieras solmu kiinteässä portissa vastasi terveyskyselyyn ja työnnön PUT sai 401 → 503
//! (T-50 ajo 2). Testit ottavat yhteisen lukon. `Solmu`-vartija tappaa
//! prosessin myös paniikissa (SIGCONT ei tarvita, SIGKILL toimii pysäytetylle).

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const AVAIN: &str = "koeavain-liite";
static LUKKO: Mutex<()> = Mutex::const_new(());

struct Tmp(PathBuf);

impl Tmp {
    fn uusi(nimi: &str) -> Tmp {
        let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("liite-{}-{nimi}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }

    fn avain(&self) -> PathBuf {
        let p = self.0.join("avain");
        std::fs::write(&p, format!("{AVAIN}\n")).unwrap();
        p
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Vapaa paikallinen portti (sidotaan porttiin 0 ja vapautetaan). Kiinteät koeportit 18797/18798
/// ovat muiden porttien käytössä, joten ne eivät kelpaa.
fn vapaa_portti() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("vapaan portin varaus")
        .local_addr()
        .unwrap()
        .port()
}

struct Solmu {
    lapsi: Child,
    data: PathBuf,
    portti: u16,
    /// Solmun stderr; rivi "kuuntelee" todistaa, että juuri tämä prosessi sai portin.
    loki: PathBuf,
}

impl Solmu {
    fn kaynnista(portti: u16, data: &Path, avain: &Path, vertaiset: &[u16]) -> Solmu {
        let loki = data.with_extension("loki");
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
            .stderr(Stdio::from(
                std::fs::File::create(&loki).expect("solmun lokitiedosto"),
            ));
        for v in vertaiset {
            komento
                .arg("--vertainen")
                .arg(format!("http://127.0.0.1:{v}"));
        }
        let lapsi = komento.spawn().expect("scopes-solmun käynnistys");
        Solmu {
            lapsi,
            data: data.to_path_buf(),
            portti,
            loki,
        }
    }

    fn signaali(&self, nimi: &str) {
        let tila = Command::new("kill")
            .arg(format!("-{nimi}"))
            .arg(self.lapsi.id().to_string())
            .status()
            .expect("kill-komento");
        assert!(tila.success(), "kill -{nimi} epäonnistui");
    }

    /// Datahakemisto kanonisena (vastauksen polun vertailuun).
    fn data(&self) -> PathBuf {
        self.data.canonicalize().unwrap()
    }
}

impl Drop for Solmu {
    fn drop(&mut self) {
        let _ = self.lapsi.kill();
        let _ = self.lapsi.wait();
    }
}

fn osoite(portti: u16, polku: &str) -> String {
    format!("http://127.0.0.1:{portti}{polku}")
}

/// Odottaa, että juuri tämä käynnistetty solmu vastaa terveyskyselyyn. Terveyttä kysytään vasta,
/// kun oma prosessi on ilmoittanut sitoneensa portin; jos se päättyy (esim. portti varattu),
/// toisen prosessin vastausta samasta portista ei hyväksytä.
async fn odota_valmiiksi(http: &reqwest::Client, solmu: &mut Solmu) {
    let portti = solmu.portti;
    let raja = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(tila) = solmu.lapsi.try_wait().expect("try_wait") {
            panic!("solmu {portti} päättyi ennen valmistumista: {tila}");
        }
        let sidottu = std::fs::read_to_string(&solmu.loki)
            .is_ok_and(|t| t.contains(&format!("kuuntelee 127.0.0.1:{portti}")));
        if sidottu {
            if let Ok(v) = http.get(osoite(portti, "/api/terveys")).send().await {
                if v.status().is_success() {
                    return;
                }
            }
        }
        assert!(
            Instant::now() < raja,
            "solmu {portti} ei käynnistynyt 20 s:ssa"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn sha(tavut: &[u8]) -> String {
    Sha256::digest(tavut)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Yksi solmu ilman vertaisia.
async fn yksi(nimi: &str) -> (Tmp, Solmu, reqwest::Client) {
    let tmp = Tmp::uusi(nimi);
    let mut solmu = Solmu::kaynnista(vapaa_portti(), &tmp.0.join("a"), &tmp.avain(), &[]);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .unwrap();
    odota_valmiiksi(&http, &mut solmu).await;
    (tmp, solmu, http)
}

async fn laheta(
    http: &reqwest::Client,
    portti: u16,
    skooppi: &str,
    nimi: &str,
    tavut: Vec<u8>,
) -> reqwest::Response {
    http.post(osoite(portti, &format!("/api/skoopit/{skooppi}/liite")))
        .query(&[("nimi", nimi)])
        .bearer_auth(AVAIN)
        .body(tavut)
        .send()
        .await
        .expect("POST liite")
}

#[tokio::test]
async fn a_yksi_solmu_ilman_vertaisia() {
    let _vuoro = LUKKO.lock().await;
    let (_tmp, a, http) = yksi("a").await;
    let tavut = b"liitteen sisalto \x00\x01\x02".to_vec();
    let h = sha(&tavut);
    let v = laheta(&http, a.portti, "koe", "kuva.png", tavut.clone()).await;
    assert_eq!(v.status(), 200);
    let j: Value = v.json().await.unwrap();
    let odotettu = a.data().join("liitteet").join(&h).join("kuva.png");
    assert_eq!(j["polku"], odotettu.to_string_lossy().as_ref());
    assert_eq!(j["koko"], tavut.len());
    assert_eq!(j["sha256"], h.as_str());
    assert_eq!(j["solmu"], format!("koe-{}", a.portti).as_str());
    assert_eq!(std::fs::read(&odotettu).unwrap(), tavut);
    assert_eq!(sha(&std::fs::read(&odotettu).unwrap()), h);
    // yksikkö liitteet/<sha>
    let y: Value = http
        .get(osoite(a.portti, "/api/tiiviste?polku=liitteet"))
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!y["tiiviste"].as_str().unwrap_or("").is_empty(), "{y}");
    let c = rusqlite::Connection::open_with_flags(
        a.data().join("ydin.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (sisalto, poistettu): (Vec<u8>, i64) = c
        .query_row(
            "SELECT sisalto, poistettu FROM yksikot WHERE polku = 'liitteet' AND id = ?1",
            [&h],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("yksikkö liitteet/<sha>");
    assert_eq!(poistettu, 0);
    let s: Value = serde_json::from_slice(&sisalto).unwrap();
    assert_eq!(
        s,
        json!({"nimi":"kuva.png","koko":tavut.len(),"tyyppi":"image/png","skooppi":"koe"})
    );
    let koko: i64 = c
        .query_row("SELECT koko FROM liitteet WHERE sha256 = ?1", [&h], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(koko as usize, tavut.len());
    // toinen lähetys samoista tavuista: sama polku
    let v2 = laheta(&http, a.portti, "koe", "kuva.png", tavut).await;
    assert_eq!(v2.status(), 200);
    let j2: Value = v2.json().await.unwrap();
    assert_eq!(j2["polku"], j["polku"]);
}

#[tokio::test]
async fn b_liian_suuri_413() {
    let _vuoro = LUKKO.lock().await;
    let (_tmp, a, http) = yksi("b").await;
    let v = laheta(
        &http,
        a.portti,
        "koe",
        "iso.bin",
        vec![7u8; 25 * 1024 * 1024 + 1],
    )
    .await;
    assert_eq!(v.status(), 413);
    let j: Value = v.json().await.unwrap();
    assert_eq!(j, json!({"virhe": "liian suuri"}));
    // raja itse menee läpi
    let v = laheta(
        &http,
        a.portti,
        "koe",
        "raja.bin",
        vec![7u8; 25 * 1024 * 1024],
    )
    .await;
    assert_eq!(v.status(), 200);
}

#[tokio::test]
async fn c_nimi_ei_karkaa_hakemistosta() {
    let _vuoro = LUKKO.lock().await;
    let (_tmp, a, http) = yksi("c").await;
    let tavut = b"salaisuus".to_vec();
    let h = sha(&tavut);
    let v = laheta(&http, a.portti, "koe", "../../x", tavut.clone()).await;
    assert_eq!(v.status(), 200);
    let j: Value = v.json().await.unwrap();
    let polku = PathBuf::from(j["polku"].as_str().unwrap());
    let kansio = a.data().join("liitteet").join(&h);
    assert_eq!(polku.parent().unwrap(), kansio);
    assert_eq!(std::fs::read(&polku).unwrap(), tavut);
    assert!(!a.data().join("x").exists());
    assert!(!a.data().parent().unwrap().join("x").exists());
    // tyhjä, "." ja ".." → "liite"
    for nimi in ["", ".", ".."] {
        let v = laheta(&http, a.portti, "koe", nimi, b"y".to_vec()).await;
        let j: Value = v.json().await.unwrap();
        assert!(
            j["polku"].as_str().unwrap().ends_with("/liite"),
            "{nimi}: {j}"
        );
    }
}

#[tokio::test]
async fn d_put_vaaralla_tiivisteella_422() {
    let _vuoro = LUKKO.lock().await;
    let (_tmp, a, http) = yksi("d").await;
    let vaara = sha(b"jotain muuta");
    let v = http
        .put(osoite(a.portti, &format!("/api/liitteet/{vaara}")))
        .query(&[("nimi", "a.txt")])
        .bearer_auth(AVAIN)
        .body("tavut")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 422);
    let j: Value = v.json().await.unwrap();
    assert_eq!(j, json!({"virhe": "tiiviste"}));
    assert!(!a.data().join("liitteet").join(&vaara).exists());
    // oikea tiiviste: 200 ja idempotentti
    let oikea = sha(b"tavut");
    let mut polut = vec![];
    for _ in 0..2 {
        let v = http
            .put(osoite(a.portti, &format!("/api/liitteet/{oikea}")))
            .query(&[("nimi", "a.txt")])
            .bearer_auth(AVAIN)
            .body("tavut")
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200);
        let j: Value = v.json().await.unwrap();
        assert_eq!(j["sha256"], oikea.as_str());
        polut.push(j["polku"].as_str().unwrap().to_string());
    }
    assert_eq!(polut[0], polut[1]);
    assert_eq!(std::fs::read(&polut[0]).unwrap(), b"tavut");
}

#[tokio::test]
async fn e_get_liite() {
    let _vuoro = LUKKO.lock().await;
    let (_tmp, a, http) = yksi("e").await;
    let tavut = b"hello liite".to_vec();
    let h = sha(&tavut);
    laheta(&http, a.portti, "koe", "viesti.txt", tavut.clone()).await;
    let v = http
        .get(osoite(a.portti, &format!("/api/liite/{h}")))
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.headers()["content-type"].to_str().unwrap(), "text/plain");
    assert_eq!(v.bytes().await.unwrap().to_vec(), tavut);
    let v = http
        .get(osoite(a.portti, &format!("/api/liite/{}", sha(b"ei ole"))))
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 404);
    let j: Value = v.json().await.unwrap();
    assert_eq!(j, json!({"virhe": "tuntematon liite"}));
}

#[tokio::test]
async fn f_kaksi_solmua_tyonto_ja_vertaisvika() {
    let _vuoro = LUKKO.lock().await;
    let tmp = Tmp::uusi("f");
    let avain = tmp.avain();
    let (porttia, porttib) = (vapaa_portti(), vapaa_portti());
    assert_ne!(porttia, porttib);
    let mut a = Solmu::kaynnista(porttia, &tmp.0.join("a"), &avain, &[porttib]);
    let mut b = Solmu::kaynnista(porttib, &tmp.0.join("b"), &avain, &[]);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(100))
        .build()
        .unwrap();
    odota_valmiiksi(&http, &mut a).await;
    odota_valmiiksi(&http, &mut b).await;

    let tavut = b"A:lta B:lle".to_vec();
    let h = sha(&tavut);
    let v = laheta(&http, porttia, "koe", "siirto.txt", tavut.clone()).await;
    assert_eq!(v.status(), 200);
    let j: Value = v.json().await.unwrap();
    let b_polku = b.data().join("liitteet").join(&h).join("siirto.txt");
    assert_eq!(j["polku"], b_polku.to_string_lossy().as_ref());
    assert_eq!(j["solmu"], format!("koe-{porttib}").as_str());
    assert_eq!(j["sha256"], h.as_str());
    assert_eq!(sha(&std::fs::read(&b_polku).unwrap()), h);
    // A:lla on paikallinen kopio myös
    assert!(a
        .data()
        .join("liitteet")
        .join(&h)
        .join("siirto.txt")
        .exists());

    // B pysäytetty: A vastaa 503 ja paikallinen tiedosto jää
    b.signaali("STOP");
    let tavut2 = b"B on jumissa".to_vec();
    let h2 = sha(&tavut2);
    let alku = Instant::now();
    let v = laheta(&http, porttia, "koe", "jumi.txt", tavut2.clone()).await;
    let kulunut = alku.elapsed();
    b.signaali("CONT");
    assert_eq!(v.status(), 503);
    let j: Value = v.json().await.unwrap();
    assert_eq!(
        j,
        json!({"virhe": "vertainen", "kohde": format!("http://127.0.0.1:{porttib}/api/liitteet/{h2}")})
    );
    assert!(kulunut >= Duration::from_secs(55), "{kulunut:?}");
    let paikallinen = a.data().join("liitteet").join(&h2).join("jumi.txt");
    assert_eq!(std::fs::read(&paikallinen).unwrap(), tavut2);
}

#[tokio::test]
async fn g_ilman_avainta_401() {
    let _vuoro = LUKKO.lock().await;
    let (_tmp, a, http) = yksi("g").await;
    let v = http
        .post(osoite(a.portti, "/api/skoopit/koe/liite"))
        .query(&[("nimi", "x.txt")])
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 401);
    let v = http
        .put(osoite(a.portti, &format!("/api/liitteet/{}", sha(b"x"))))
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 401);
    let v = http
        .get(osoite(a.portti, &format!("/api/liite/{}", sha(b"x"))))
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 401);
}

/// Regressio (T-50 ajo 2): vieras prosessi vastaa samasta portista terveyskyselyyn, mutta oma
/// solmu ei saa porttia ja päättyy. Valmiuden odotus ei saa hyväksyä vierasta vastausta.
#[tokio::test]
#[should_panic(expected = "päättyi ennen valmistumista")]
async fn h_varattu_portti_ei_mene_valmiista() {
    use std::io::{Read, Write};
    let _vuoro = LUKKO.lock().await;
    let vieras = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let portti = vieras.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for yhteys in vieras.incoming().flatten() {
            let mut yhteys = yhteys;
            let mut puskuri = [0u8; 1024];
            let _ = yhteys.read(&mut puskuri);
            let _ = yhteys
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        }
    });
    let tmp = Tmp::uusi("h");
    let mut solmu = Solmu::kaynnista(portti, &tmp.0.join("a"), &tmp.avain(), &[]);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    odota_valmiiksi(&http, &mut solmu).await;
}
