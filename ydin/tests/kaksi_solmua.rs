//! Kahden solmun integraatiotesti (T-22): kaksi oikeaa `scopes-solmu`-prosessia käyttöjärjestelmän
//! antamissa vapaissa porteissa (`vapaat_portit`; ei tuotantoportteja eikä kiinteitä koeportteja
//! 18797/18798, joita vieras solmu voi pitää: T-50 ajo 2), 1 000 yksikköä kirjoitettuna puoliksi kummallekin ja konvergenssin mittaus.
//! Toinen tapaus pysäyttää B:n 2 s (SIGSTOP) kesken erän ja tarkistaa saman lopputilan.
//!
//! Testit ottavat yhteisen lukon, joten ne eivät kilpaile porteista, vaikka ajettaisiin rinnakkain.
//! `Solmu`-vartija tappaa prosessin myös paniikissa.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const YKSIKOITA: usize = 1000;
const RAJA_MS: u128 = 10_000;
static LUKKO: Mutex<()> = Mutex::const_new(());

/// Väliaikainen hakemisto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi(nimi: &str) -> Tmp {
        let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("kaksi-solmua-{}-{nimi}", std::process::id()));
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

/// Kaksi eri vapaata paikallista porttia (molemmat varataan yhtä aikaa ja vapautetaan yhdessä).
fn vapaat_portit() -> (u16, u16) {
    let a = std::net::TcpListener::bind("127.0.0.1:0").expect("vapaan portin varaus");
    let b = std::net::TcpListener::bind("127.0.0.1:0").expect("vapaan portin varaus");
    (
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    )
}

/// Käynnissä oleva `scopes-solmu`-prosessi; Drop tappaa sen (SIGKILL toimii myös pysäytetylle).
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

    fn pid(&self) -> u32 {
        self.lapsi.id()
    }

    fn signaali(&self, nimi: &str) {
        let tila = Command::new("kill")
            .arg(format!("-{nimi}"))
            .arg(self.pid().to_string())
            .status()
            .expect("kill-komento");
        assert!(tila.success(), "kill -{nimi} {} epäonnistui", self.pid());
    }

    /// Solmun kursori vertaiselle (`host:portti`) suoraan sen tietokannasta; 0, jos riviä ei ole.
    fn kursori(&self, vertainen: &str) -> u64 {
        let c = rusqlite::Connection::open_with_flags(
            self.data.join("ydin.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("tietokannan avaus");
        c.busy_timeout(Duration::from_secs(5)).unwrap();
        c.query_row(
            "SELECT seq FROM kursorit WHERE vertainen = ?1",
            [vertainen],
            |r| r.get::<_, i64>(0),
        )
        .map(|s| s as u64)
        .unwrap_or(0)
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

/// `PUT /api/tila/koe/<n>`
async fn kirjoita(http: &reqwest::Client, avain: &str, portti: u16, n: usize) {
    let v = http
        .put(osoite(portti, &format!("/api/tila/koe/{n}")))
        .bearer_auth(avain)
        .json(&json!({"arvo": n}))
        .send()
        .await
        .expect("PUT");
    assert!(v.status().is_success(), "PUT koe/{n} -> {}", v.status());
}

async fn hae_json(http: &reqwest::Client, avain: &str, portti: u16, polku: &str) -> Option<Value> {
    let v = http
        .get(osoite(portti, polku))
        .bearer_auth(avain)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !v.status().is_success() {
        return None;
    }
    v.json().await.ok()
}

/// (`/api/tiiviste?polku=tila`, kaikkien polkujen tiivistekartta, tilayksiköiden määrä).
async fn tilannekuva(
    http: &reqwest::Client,
    avain: &str,
    portti: u16,
) -> Option<(String, Value, usize)> {
    let t = hae_json(http, avain, portti, "/api/tiiviste?polku=tila").await?;
    let kaikki = hae_json(http, avain, portti, "/api/tiiviste").await?;
    let lista = hae_json(http, avain, portti, "/api/tila").await?;
    Some((
        t["tiiviste"].as_str()?.to_string(),
        kaikki["tiivisteet"].clone(),
        lista["tilat"].as_array()?.len(),
    ))
}

/// Odottaa, kunnes molemmilla on kaikki yksiköt ja tiivisteet täsmäävät kaikille poluille.
/// Palauttaa kuluneen ajan alusta tai paniikki, jos `raja` ylittyy.
async fn odota_konvergenssia(
    http: &reqwest::Client,
    avain: &str,
    portit: (u16, u16),
    alku: Instant,
    raja: Duration,
) -> Duration {
    loop {
        let a = tilannekuva(http, avain, portit.0).await;
        let b = tilannekuva(http, avain, portit.1).await;
        if let (Some(a), Some(b)) = (&a, &b) {
            if a == b && a.2 == YKSIKOITA {
                return alku.elapsed();
            }
        }
        assert!(
            alku.elapsed() < raja,
            "ei konvergoitu {} s:ssa: A={:?} B={:?}",
            raja.as_secs(),
            a.map(|x| (x.0, x.2)),
            b.map(|x| (x.0, x.2)),
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

struct Kokoonpano {
    http: reqwest::Client,
    avain: String,
    portti_a: u16,
    portti_b: u16,
    _a: Solmu,
    b: Solmu,
    _tmp: Tmp,
}

impl Kokoonpano {
    fn portit(&self) -> (u16, u16) {
        (self.portti_a, self.portti_b)
    }
}

/// A ja B (vapaissa porteissa, `--vertainen` toisensa). Sama avaintiedosto. A tilaa myös B:n, koska replikointi
/// vetää vain vertaiselta: ilman sitä B:n myöhemmin kirjoittamat yksiköt eivät kulkisi A:lle.
async fn kaynnista_parit(nimi: &str) -> Kokoonpano {
    let tmp = Tmp::uusi(nimi);
    let avaintiedosto = tmp.0.join("avain");
    std::fs::write(&avaintiedosto, "koeavain-kaksi-solmua\n").unwrap();
    let (portti_a, portti_b) = vapaat_portit();
    assert_ne!(portti_a, portti_b);
    let mut a = Solmu::kaynnista(portti_a, &tmp.0.join("a"), &avaintiedosto, &[portti_b]);
    let mut b = Solmu::kaynnista(portti_b, &tmp.0.join("b"), &avaintiedosto, &[portti_a]);
    let http = reqwest::Client::new();
    odota_valmiiksi(&http, &mut a).await;
    odota_valmiiksi(&http, &mut b).await;
    Kokoonpano {
        http,
        avain: "koeavain-kaksi-solmua".to_string(),
        portti_a,
        portti_b,
        _a: a,
        b,
        _tmp: tmp,
    }
}

/// Kirjoittaa yksiköt `alku..loppu` solmulle.
async fn kirjoita_valilla(k: &Kokoonpano, portti: u16, alku: usize, loppu: usize) {
    for n in alku..loppu {
        kirjoita(&k.http, &k.avain, portti, n).await;
    }
}

#[tokio::test]
async fn konvergenssi_1000() {
    let _vuoro = LUKKO.lock().await;
    let k = kaynnista_parit("konvergenssi").await;
    let alku = Instant::now();
    let puoli = YKSIKOITA / 2;
    tokio::join!(
        kirjoita_valilla(&k, k.portti_a, 0, puoli),
        kirjoita_valilla(&k, k.portti_b, puoli, YKSIKOITA),
    );
    let kulunut =
        odota_konvergenssia(&k.http, &k.avain, k.portit(), alku, Duration::from_secs(30)).await;
    println!("KONVERGENSSI: {}", kulunut.as_millis());
    assert!(
        kulunut.as_millis() <= RAJA_MS,
        "konvergenssi {} ms > {RAJA_MS} ms",
        kulunut.as_millis()
    );
}

#[tokio::test]
async fn katko_kesken_eran() {
    let _vuoro = LUKKO.lock().await;
    let k = kaynnista_parit("katko").await;
    let puoli = YKSIKOITA / 2;
    let alku = Instant::now();
    // Ohjain: kun B on ehtinyt vastaanottaa osan A:n yksiköistä, B pysäytetään 2 s kesken erän.
    let ohjain = async {
        let raja = Instant::now() + Duration::from_secs(20);
        loop {
            let b = tilannekuva(&k.http, &k.avain, k.portti_b).await;
            if b.is_some_and(|x| x.2 >= 100) || Instant::now() > raja {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let kursori_ennen = k.b.kursori(&format!("127.0.0.1:{}", k.portti_a));
        k.b.signaali("STOP");
        tokio::time::sleep(Duration::from_secs(2)).await;
        k.b.signaali("CONT");
        (kursori_ennen, Instant::now())
    };
    // A:lle kirjoitetaan koko ajan; B:n kirjoitus odottaa pysäytyksen yli (pyyntö jää jonoon).
    let (_, _, (kursori_ennen, jatko)) = tokio::join!(
        kirjoita_valilla(&k, k.portti_a, 0, puoli),
        kirjoita_valilla(&k, k.portti_b, puoli, YKSIKOITA),
        ohjain,
    );
    let kulunut =
        odota_konvergenssia(&k.http, &k.avain, k.portit(), alku, Duration::from_secs(40)).await;
    let jatkosta = jatko.elapsed();
    println!(
        "KATKO-KONVERGENSSI: {} (SIGCONT:sta {})",
        kulunut.as_millis(),
        jatkosta.as_millis()
    );
    let kursori_jalkeen = k.b.kursori(&format!("127.0.0.1:{}", k.portti_a));
    assert!(
        kursori_jalkeen >= kursori_ennen,
        "kursori B→A pieneni: {kursori_ennen} → {kursori_jalkeen}"
    );
    assert!(
        jatkosta.as_millis() <= RAJA_MS,
        "konvergenssi SIGCONT:n jälkeen {} ms > {RAJA_MS} ms",
        jatkosta.as_millis()
    );
}

/// Regressio (T-50 ajo 2): vieras prosessi vastaa samasta portista terveyskyselyyn, mutta oma
/// solmu ei saa porttia ja päättyy. Valmiuden odotus ei saa hyväksyä vierasta vastausta.
#[tokio::test]
#[should_panic(expected = "päättyi ennen valmistumista")]
async fn varattu_portti_ei_mene_valmiista() {
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
    let tmp = Tmp::uusi("varattu");
    let avaintiedosto = tmp.0.join("avain");
    std::fs::write(&avaintiedosto, "koeavain-kaksi-solmua\n").unwrap();
    let mut solmu = Solmu::kaynnista(portti, &tmp.0.join("a"), &avaintiedosto, &[]);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    odota_valmiiksi(&http, &mut solmu).await;
}
