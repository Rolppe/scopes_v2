//! Ikkunoitu peili kahdella oikealla `scopes-solmu`-prosessilla (T-55, S-9b): A täysi, B
//! `--peili-ikkuna-vrk 7 --peili-katto-mt 1 --vertainen A`. Portit käyttöjärjestelmältä (`127.0.0.1:0`,
//! P-6; ei kiinteitä 18797/18798). A saa 30 vrk synteettistä peiliä `/api/laheta`:lla; B:n peili pysyy
//! katon alla ja ikkunassa, uusi yksikkö kulkee virran kautta, ja uudelleen käynnistetty B hakee 0
//! peili-yksikköä (B:n stderr-rivi `PEILI_HAETTU: <n>`).

use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

static LUKKO: Mutex<()> = Mutex::const_new(());
const AVAIN: &str = "koeavain-kaksi-solmua-ikkuna";
const PAIVA_MS: u64 = 86_400_000;
const VRK: u64 = 30;
const PAIVASSA: u64 = 6;
const IKKUNA_VRK: u64 = 7;
const KATTO: u64 = 1_048_576;
/// Karsinta ajetaan enintään kerran 60 s:ssa (S-9c): odotukselle väljä raja.
const KARSINTA_ODOTUS: Duration = Duration::from_secs(150);

/// Väliaikainen hakemisto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi(nimi: &str) -> Tmp {
        let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("kaksi-solmua-ikkuna-{}-{nimi}", std::process::id()));
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

/// Vapaa paikallinen portti (sidotaan porttiin 0 ja vapautetaan), kuten `tests/liite.rs` (P-6).
fn vapaa_portti() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("vapaan portin varaus")
        .local_addr()
        .unwrap()
        .port()
}

/// Käynnissä oleva `scopes-solmu`-prosessi; Drop tappaa sen.
struct Solmu {
    lapsi: Child,
    portti: u16,
    /// Solmun stderr; rivi "kuuntelee" todistaa, että juuri tämä prosessi sai portin.
    loki: PathBuf,
}

impl Solmu {
    fn kaynnista(portti: u16, data: &Path, avain: &Path, lisat: &[String], loki: &str) -> Solmu {
        let loki = data.with_extension(loki);
        let mut komento = Command::new(env!("CARGO_BIN_EXE_scopes-solmu"));
        komento
            .arg("--portti")
            .arg(portti.to_string())
            .arg("--data")
            .arg(data)
            .arg("--avain")
            .arg(avain)
            .args(lisat)
            .env("SCOPES_LAITE", format!("koe-{portti}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(
                std::fs::File::create(&loki).expect("solmun lokitiedosto"),
            ));
        let lapsi = komento.spawn().expect("scopes-solmun käynnistys");
        Solmu {
            lapsi,
            portti,
            loki,
        }
    }

    fn loki(&self) -> String {
        std::fs::read_to_string(&self.loki).unwrap_or_default()
    }

    /// Ensimmäisen `PEILI_HAETTU: <n>` -rivin n.
    fn peili_haettu(&self) -> Option<usize> {
        self.loki()
            .lines()
            .find_map(|r| r.strip_prefix("PEILI_HAETTU: "))
            .map(|n| n.trim().parse().expect("PEILI_HAETTU-luku"))
    }

    fn sammuta(mut self) {
        let _ = self.lapsi.kill();
        let _ = self.lapsi.wait();
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

async fn odota_valmiiksi(http: &reqwest::Client, solmu: &mut Solmu) {
    let portti = solmu.portti;
    let raja = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(tila) = solmu.lapsi.try_wait().expect("try_wait") {
            panic!("solmu {portti} päättyi ennen valmistumista: {tila}");
        }
        if solmu
            .loki()
            .contains(&format!("kuuntelee 127.0.0.1:{portti}"))
        {
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

fn nyt_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Rivien `timestamp` on `ms` (sisältöaika = yksikön aiottu ikä, T-73).
fn rivit(siemen: &str, ms: u64) -> Vec<String> {
    let aika = iso(ms);
    let mut r = Vec::new();
    for i in 0..10 {
        r.push(
            json!({"type": "user", "uuid": format!("{siemen}-{i}"), "timestamp": aika,
                "message": {"role": "user", "content": format!("{siemen} {}", "x".repeat(4000))},
                "lisa": "y".repeat(1000)})
            .to_string(),
        );
        r.push(json!({"type": "progress", "data": "z".repeat(1000)}).to_string());
    }
    r
}

/// RFC 3339 -aikaleima (UTC, millisekunnit) Unix-ajasta; rivien `timestamp` vastaa näin aiottua ikää (T-73).
fn iso(ms: u64) -> String {
    let (p, ms_paivassa) = ((ms / 86_400_000) as i64, ms % 86_400_000);
    let z = p + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let pv = doy - (153 * mp + 2) / 5 + 1;
    let kk = if mp < 10 { mp + 3 } else { mp - 9 };
    let vuosi = yoe + era * 400 + i64::from(kk <= 2);
    format!(
        "{vuosi:04}-{kk:02}-{pv:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms_paivassa / 3_600_000,
        ms_paivassa / 60_000 % 60,
        ms_paivassa / 1000 % 60,
        ms_paivassa % 1000
    )
}

fn peiliyksikko(id: &str, ms: u64, rivit: &[String]) -> Yksikko {
    Yksikko {
        polku: "peili".to_string(),
        id: id.to_string(),
        versio: BTreeMap::from([("a".to_string(), 1)]),
        aika: Hlc {
            ms,
            laskuri: 0,
            laite: "a".to_string(),
        },
        sisalto: Some(serde_json::to_vec(rivit).unwrap()),
        poistettu: false,
    }
}

async fn laheta(http: &reqwest::Client, portti: u16, ys: &[Yksikko]) {
    let v = http
        .post(osoite(portti, "/api/laheta"))
        .bearer_auth(AVAIN)
        .json(&json!({ "yksikot": ys }))
        .send()
        .await
        .expect("/api/laheta");
    assert!(v.status().is_success(), "/api/laheta -> {}", v.status());
}

async fn koko(http: &reqwest::Client, portti: u16) -> Option<Value> {
    let v = http
        .get(osoite(portti, "/api/peili/koko"))
        .bearer_auth(AVAIN)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    v.status().is_success().then_some(())?;
    v.json().await.ok()
}

/// Odottaa, kunnes B:n peili on katon alla ja vähintään `vahintaan` yksikköä.
async fn odota_katon_alle(http: &reqwest::Client, b: &Solmu, vahintaan: u64) -> Value {
    let alku = Instant::now();
    loop {
        if let Some(k) = koko(http, b.portti).await {
            let tavut = k["tavut"].as_u64().unwrap_or(u64::MAX);
            let yksikot = k["yksikot"].as_u64().unwrap_or(0);
            if tavut <= KATTO && yksikot >= vahintaan {
                return k;
            }
            assert!(
                alku.elapsed() < KARSINTA_ODOTUS,
                "B ei karsiutunut katon alle: {k}\n{}",
                b.loki()
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
async fn ikkunoitu_b_katon_alla_virta_ja_uudelleenkaynnistys() {
    let _vuoro = LUKKO.lock().await;
    let tmp = Tmp::uusi("peili");
    let avaintiedosto = tmp.0.join("avain");
    std::fs::write(&avaintiedosto, format!("{AVAIN}\n")).unwrap();
    let http = reqwest::Client::new();
    let data_b = tmp.0.join("b");

    // A täysi, ei vertaisia; 30 vrk peiliä /api/laheta:lla.
    let pa = vapaa_portti();
    let mut a = Solmu::kaynnista(pa, &tmp.0.join("a"), &avaintiedosto, &[], "loki");
    odota_valmiiksi(&http, &mut a).await;
    let nyt = nyt_ms();
    let mut kaikki: Vec<Yksikko> = Vec::new();
    for k in 0..VRK {
        for j in 0..PAIVASSA {
            let id = format!("istunto-{k:02}.jsonl:{}", j * 100_000);
            let ms = nyt - k * PAIVA_MS - 3_600_000 - j * 600_000;
            kaikki.push(peiliyksikko(&id, ms, &rivit(&id, ms)));
        }
    }
    for pala in kaikki.chunks(4) {
        laheta(&http, pa, pala).await;
    }
    let a_koko = koko(&http, pa).await.unwrap();
    assert_eq!(a_koko["yksikot"], json!(VRK * PAIVASSA), "{a_koko}");
    let ikkuna_raja = nyt - IKKUNA_VRK * PAIVA_MS;
    let mut ikkuna: BTreeSet<String> = kaikki
        .iter()
        .filter(|y| y.aika.ms >= ikkuna_raja)
        .map(|y| y.id.clone())
        .collect();
    assert_eq!(ikkuna.len() as u64, IKKUNA_VRK * PAIVASSA);

    // B ikkunoitu: hakee ikkunan, karsii katon alle.
    let lisat = [
        "--peili-ikkuna-vrk".to_string(),
        IKKUNA_VRK.to_string(),
        "--peili-katto-mt".to_string(),
        "1".to_string(),
        "--vertainen".to_string(),
        format!("http://127.0.0.1:{pa}"),
    ];
    let mut b = Solmu::kaynnista(vapaa_portti(), &data_b, &avaintiedosto, &lisat, "loki1");
    odota_valmiiksi(&http, &mut b).await;
    let alku = Instant::now();
    while b.peili_haettu().is_none() {
        assert!(alku.elapsed() < Duration::from_secs(60), "{}", b.loki());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let ensin = b.peili_haettu().unwrap();
    println!("PEILI_HAETTU ensimmäinen: {ensin}");
    assert_eq!(ensin, ikkuna.len(), "ensimmäinen tasaa hakee ikkunan");
    let kb = odota_katon_alle(&http, &b, 1).await;
    println!("B koko karsinnan jälkeen: {kb}");
    assert!(b.loki().contains("peilin karsinta:"), "{}", b.loki());
    assert_eq!(kb["ikkuna_vrk"], json!(IKKUNA_VRK));
    let ennen = kb["yksikot"].as_u64().unwrap();

    // Uusi peili-yksikkö A:lle → B:llä virran kautta ≤ 5 s.
    let uusi_ms = nyt_ms();
    let uusi = peiliyksikko(
        "uusi.jsonl:0",
        uusi_ms,
        &[json!({"type": "assistant", "timestamp": iso(uusi_ms),
            "message": {"role": "assistant", "content": "uusi"}})
        .to_string()],
    );
    let lahetetty = Instant::now();
    laheta(&http, pa, std::slice::from_ref(&uusi)).await;
    loop {
        let k = koko(&http, b.portti).await;
        if k.as_ref()
            .is_some_and(|k| k["yksikot"].as_u64() == Some(ennen + 1))
        {
            break;
        }
        assert!(
            lahetetty.elapsed() <= Duration::from_secs(5),
            "uusi yksikkö ei näkynyt B:llä 5 s:ssa: {k:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    println!("VIRTA_MS: {}", lahetetty.elapsed().as_millis());
    ikkuna.insert(uusi.id.clone());
    // Jos uusi yksikkö nosti B:n katon yli, odotetaan seuraava karsinta ennen uudelleenkäynnistystä.
    odota_katon_alle(&http, &b, 1).await;

    // B:n yksiköt ⊆ A:n ikkuna ja riisuttuina (luetaan pysäytetyn B:n kannasta).
    b.sammuta();
    {
        let v = Varasto::avaa(&data_b.join("ydin.db")).unwrap();
        let ys = v.listaa_otsakkeet("peili").unwrap();
        assert!(!ys.is_empty());
        for y in &ys {
            assert!(ikkuna.contains(&y.id), "{} ei ole A:n ikkunassa", y.id);
        }
        let tavut: u64 = ys
            .iter()
            .map(|y| {
                v.lue("peili", &y.id)
                    .unwrap()
                    .unwrap()
                    .sisalto
                    .map_or(0, |s| s.len() as u64)
            })
            .sum();
        assert!(tavut <= KATTO, "{tavut}");
        assert!(v.lue("peili", "uusi.jsonl:0").unwrap().is_some());
    }

    // Uudelleen käynnistetty B hakee 0 peili-yksikköä.
    let mut b = Solmu::kaynnista(vapaa_portti(), &data_b, &avaintiedosto, &lisat, "loki2");
    odota_valmiiksi(&http, &mut b).await;
    let alku = Instant::now();
    while b.peili_haettu().is_none() {
        assert!(alku.elapsed() < Duration::from_secs(60), "{}", b.loki());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let toinen = b.peili_haettu().unwrap();
    println!("PEILI_HAETTU: {toinen}");
    assert_eq!(
        toinen,
        0,
        "uudelleen käynnistetty B haki peiliä\n{}",
        b.loki()
    );
    let kb = koko(&http, b.portti).await.unwrap();
    assert!(kb["tavut"].as_u64().unwrap() <= KATTO, "{kb}");
    // A:n peili ennallaan (B ei lähettänyt mitään).
    let a_koko2 = koko(&http, pa).await.unwrap();
    assert_eq!(a_koko2["yksikot"], json!(VRK * PAIVASSA + 1), "{a_koko2}");
    drop(a);
}
