//! S-9d pohja heti (T-75, ARK-17-KORJAUS, T-57 (5)): kaksi oikeaa `scopes-solmu`-prosessia, A täysi ja B
//! `--peili-ikkuna-vrk 7 --vertainen A`. Portit käyttöjärjestelmältä (`127.0.0.1:0`, P-6). B:ltä ei pyydetä
//! yhtään näkymää ennen kuin pohja on todistettu tallennetuksi B:n omasta kannasta (kirjoitusta ei tee
//! näkymäpyyntö): tasauksen, karsinnan ja uudelleenkäynnistyksen jälkeen B näyttää viestit, vaikka A on
//! pysäytetty (SIGSTOP).

use rusqlite::{Connection, OpenFlags};
use scopes_ydin::yksikko::{Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

static LUKKO: Mutex<()> = Mutex::const_new(());
const AVAIN: &str = "koeavain-peili-pohja-heti";
const PAIVA_MS: u64 = 86_400_000;
const IKKUNA_VRK: u64 = 7;
/// Karsinta ajetaan enintään kerran 60 s:ssa (S-9c): odotukselle väljä raja.
const KARSINTA_ODOTUS: Duration = Duration::from_secs(150);
const AIKARAJA: Duration = Duration::from_secs(60);
const TIEDOSTOT: [&str; 3] = [
    "-home-koe/aaaaaaaa-0000-4000-8000-000000000001.jsonl",
    "-home-koe/aaaaaaaa-0000-4000-8000-000000000002.jsonl",
    "-home-koe/aaaaaaaa-0000-4000-8000-000000000003.jsonl",
];

// ---- apuvälineet -------------------------------------------------------------------------------------------------

/// Väliaikainen hakemisto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi(nimi: &str) -> Tmp {
        let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("peili-pohja-heti-{}-{nimi}", std::process::id()));
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

/// Käynnissä oleva `scopes-solmu`-prosessi; Drop tappaa sen (SIGKILL tappaa myös pysäytetyn).
struct Solmu {
    lapsi: Child,
    portti: u16,
    loki: PathBuf,
}

impl Solmu {
    fn kaynnista(portti: u16, data: &Path, avain: &Path, lisat: &[String], loki: &str) -> Solmu {
        let loki = data.with_extension(loki);
        let lapsi = Command::new(env!("CARGO_BIN_EXE_scopes-solmu"))
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
            ))
            .spawn()
            .expect("scopes-solmun käynnistys");
        Solmu {
            lapsi,
            portti,
            loki,
        }
    }

    fn loki(&self) -> String {
        std::fs::read_to_string(&self.loki).unwrap_or_default()
    }

    fn signaali(&self, nimi: &str) {
        let tila = Command::new("kill")
            .arg(format!("-{nimi}"))
            .arg(self.lapsi.id().to_string())
            .status()
            .expect("kill-komento");
        assert!(
            tila.success(),
            "kill -{nimi} {} epäonnistui",
            self.lapsi.id()
        );
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

/// RFC 3339 -aikaleima (UTC, millisekunnit) Unix-ajasta; rivien `timestamp` vastaa aiottua ikää (T-73).
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

/// Yksikkö: `n` käyttäjän riviä, joiden `timestamp` on `ms`.
fn peiliyksikko(tiedosto: &str, offset: u64, ms: u64, alkurivi: usize, n: usize) -> Yksikko {
    let rivit: Vec<String> = (alkurivi..alkurivi + n)
        .map(|k| {
            json!({"type": "user", "uuid": format!("{tiedosto}-{k}"), "timestamp": iso(ms),
                "message": {"role": "user", "content": format!("viesti {k}")}})
            .to_string()
        })
        .collect();
    Yksikko {
        polku: "peili".to_string(),
        id: format!("{tiedosto}:{offset}"),
        versio: BTreeMap::from([("a".to_string(), 1)]),
        aika: Hlc {
            ms,
            laskuri: 0,
            laite: "a".to_string(),
        },
        sisalto: Some(serde_json::to_vec(&rivit).unwrap()),
        poistettu: false,
    }
}

async fn post(http: &reqwest::Client, portti: u16, polku: &str, runko: Value) {
    let v = http
        .post(osoite(portti, polku))
        .bearer_auth(AVAIN)
        .json(&runko)
        .send()
        .await
        .unwrap_or_else(|e| panic!("{polku}: {e}"));
    assert!(v.status().is_success(), "{polku} -> {}", v.status());
}

async fn get(http: &reqwest::Client, portti: u16, polku: &str) -> (u16, Value) {
    let v = http
        .get(osoite(portti, polku))
        .bearer_auth(AVAIN)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .unwrap_or_else(|e| panic!("{polku}: {e}"));
    let koodi = v.status().as_u16();
    (koodi, v.json().await.unwrap_or(Value::Null))
}

/// A:n lähde: yksi avoin istunto kullekin skoopille `koe<i>`, transkripti `TIEDOSTOT[i]`.
async fn lahteet(http: &reqwest::Client, a: u16, tiedostot: &[&str]) {
    let istunnot: Vec<Value> = tiedostot
        .iter()
        .enumerate()
        .map(|(i, t)| {
            json!({
                "istunto": format!("aaaaaaaa-0000-4000-8000-00000000000{}", i + 1),
                "skooppi": format!("koe{}", i + 1), "tila": "idle", "kysely": false,
                "pakattu": false, "hereilla": true, "transkripti": t,
                "alkoi": "2026-10-20T10:00:00.000Z", "ruutu": format!("%{}", i + 1),
            })
        })
        .collect();
    post(
        http,
        a,
        "/api/lahde/istunnot",
        json!({"laite": "palvelin", "sisalto": istunnot}),
    )
    .await;
    post(
        http,
        a,
        "/api/lahde/agy",
        json!({"laite": "palvelin", "sisalto": []}),
    )
    .await;
}

/// Viestit tunnisteineen (`?since=0` = nollaus, kaikki näkyvät): (id, teksti).
async fn viestit(http: &reqwest::Client, portti: u16, skooppi: &str) -> Vec<(String, String)> {
    let (koodi, r) = get(
        http,
        portti,
        &format!("/api/skoopit/{skooppi}/viestit?since=0"),
    )
    .await;
    assert_eq!(koodi, 200, "{r}");
    r["muuttuneet"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            (
                v["id"].as_str().unwrap().to_string(),
                v["teksti"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// B:n kannan sisältö ilman näkymäpyyntöä: (peili-yksiköiden määrä, pohjat tiedosto → (offset, rivi),
/// lähdeyksiköiden määrä). Lukuyhteys kantaan kuten ytimen oma `peili::rivi`; ei kirjoitusta.
/// B:n kannan tila: (peili-yksiköitä, pohjat tiedosto -> (offset, rivi), lähdeyksiköitä).
type Kanta = (usize, BTreeMap<String, (u64, u64)>, usize);

fn kannan_tila(data: &Path) -> Option<Kanta> {
    let c = Connection::open_with_flags(
        data.join("ydin.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    c.busy_timeout(Duration::from_secs(2)).ok()?;
    let mut k = c
        .prepare(
            "SELECT polku, id, CAST(sisalto AS TEXT) FROM yksikot WHERE poistettu = 0 \
             AND polku IN ('peili', 'peili-pohja', 'lahde/istunnot')",
        )
        .ok()?;
    let mut rivit = k.query([]).ok()?;
    let (mut peili, mut lahde) = (0, 0);
    let mut pohjat = BTreeMap::new();
    while let Some(r) = rivit.next().ok()? {
        let polku: String = r.get(0).ok()?;
        let id: String = r.get(1).ok()?;
        let sisalto: Option<String> = r.get(2).ok()?;
        match polku.as_str() {
            "peili" => peili += 1,
            "lahde/istunnot" => lahde += 1,
            _ => {
                let v: Value = serde_json::from_str(&sisalto?).ok()?;
                pohjat.insert(id, (v["offset"].as_u64()?, v["rivi"].as_u64()?));
            }
        }
    }
    Some((peili, pohjat, lahde))
}

/// Odottaa, kunnes B:n kanta täyttää ehdon; ei yhtään HTTP-pyyntöä B:lle.
async fn odota_kannassa(
    b: &Solmu,
    data: &Path,
    raja: Duration,
    kuvaus: &str,
    ehto: impl Fn(usize, &BTreeMap<String, (u64, u64)>, usize) -> bool,
) -> Kanta {
    let alku = Instant::now();
    loop {
        let nyt = kannan_tila(data);
        if let Some((p, pohjat, l)) = &nyt {
            if ehto(*p, pohjat, *l) {
                return nyt.unwrap();
            }
        }
        assert!(
            alku.elapsed() < raja,
            "aikaraja ylittyi: {kuvaus}: {nyt:?}\n{}",
            b.loki()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Ympäristö: A täysi (kolme tiedostoa, kussakin 2 vanhaa yksikköä ikkunan ulkopuolella ja 2 uutta),
/// B ikkunoitu vertaisena A.
struct Ymp {
    _tmp: Tmp,
    http: reqwest::Client,
    avain: PathBuf,
    data_b: PathBuf,
    lisat: Vec<String>,
    a: Solmu,
    b: Solmu,
    /// A:n viestit tiedostoittain (skooppi → viestit), luettu ennen pysäytystä.
    a_viestit: Vec<Vec<(String, String)>>,
}

const RIVEJA: usize = 5;

async fn pystyta(nimi: &str) -> Ymp {
    let tmp = Tmp::uusi(nimi);
    let avain = tmp.0.join("avain");
    std::fs::write(&avain, format!("{AVAIN}\n")).unwrap();
    let http = reqwest::Client::new();
    let data_b = tmp.0.join("b");

    let pa = vapaa_portti();
    let mut a = Solmu::kaynnista(pa, &tmp.0.join("a"), &avain, &[], "loki");
    odota_valmiiksi(&http, &mut a).await;
    let nyt = nyt_ms();
    let vanha = nyt - (IKKUNA_VRK + 3) * PAIVA_MS;
    let uusi = nyt - 3_600_000;
    let mut ys = Vec::new();
    for t in TIEDOSTOT {
        // Kaksi vanhaa yksikköä (offset 0, 1000; rivit 1–10) ja kaksi uutta (2000, 3000; rivit 11–20).
        ys.push(peiliyksikko(t, 0, vanha, 1, RIVEJA));
        ys.push(peiliyksikko(t, 1000, vanha, 1 + RIVEJA, RIVEJA));
        ys.push(peiliyksikko(t, 2000, uusi, 1 + 2 * RIVEJA, RIVEJA));
        ys.push(peiliyksikko(t, 3000, uusi, 1 + 3 * RIVEJA, RIVEJA));
    }
    for pala in ys.chunks(4) {
        post(&http, pa, "/api/laheta", json!({ "yksikot": pala })).await;
    }
    lahteet(&http, pa, &TIEDOSTOT).await;
    let mut a_viestit = Vec::new();
    for i in 1..=TIEDOSTOT.len() {
        let v = viestit(&http, pa, &format!("koe{i}")).await;
        assert_eq!(v.len(), 4 * RIVEJA, "A näyttää koko tiedoston");
        a_viestit.push(v);
    }

    let lisat = vec![
        "--peili-ikkuna-vrk".to_string(),
        IKKUNA_VRK.to_string(),
        "--peili-katto-mt".to_string(),
        "38".to_string(),
        "--vertainen".to_string(),
        format!("http://127.0.0.1:{pa}"),
    ];
    let mut b = Solmu::kaynnista(vapaa_portti(), &data_b, &avain, &lisat, "loki1");
    odota_valmiiksi(&http, &mut b).await;
    Ymp {
        _tmp: tmp,
        http,
        avain,
        data_b,
        lisat,
        a,
        b,
        a_viestit,
    }
}

impl Ymp {
    /// Odottaa B:n kannasta tasauksen (6 uutta yksikköä + lähde) ja jokaiselle tiedostolle pohjan
    /// `{offset 2000, rivi 10}`; B:lle ei ole tehty yhtään HTTP-pyyntöä näkymistä.
    async fn odota_pohjat(&self) {
        let (p, pohjat, _) = odota_kannassa(
            &self.b,
            &self.data_b,
            AIKARAJA,
            "pohjat B:n kannassa",
            |p, pohjat, l| p == 2 * TIEDOSTOT.len() && pohjat.len() == TIEDOSTOT.len() && l >= 1,
        )
        .await;
        assert_eq!(p, 6);
        for t in TIEDOSTOT {
            assert_eq!(pohjat.get(t), Some(&(2000, 2 * RIVEJA as u64)), "{t}");
        }
    }

    /// B:n viestit jokaiselle skoopille: ≥ 1, id:t ja tekstit = A:n vastaavat (rivit 11–20).
    async fn tarkista_viestit(&self, portti: u16) {
        for (i, a) in self.a_viestit.iter().enumerate() {
            let skooppi = format!("koe{}", i + 1);
            let b = viestit(&self.http, portti, &skooppi).await;
            assert!(!b.is_empty(), "{skooppi}: B ei näytä viestejä");
            assert_eq!(b.len(), 2 * RIVEJA, "{skooppi}: ikkunan viestit");
            assert_eq!(b[..], a[a.len() - b.len()..], "{skooppi}: id:t ja tekstit");
            let a_idt: BTreeSet<&String> = a.iter().map(|(id, _)| id).collect();
            assert!(b.iter().all(|(id, _)| a_idt.contains(id)), "{skooppi}");
        }
    }
}

// ---- testit ------------------------------------------------------------------------------------------------------

/// B tasaa, eikä B:ltä pyydetä yhtään näkymää; kun pohjat ovat B:n kannassa, A pysäytetään (SIGSTOP) ja
/// B:n viestit-vastaus näyttää jokaiselle tiedostolle viestit, joiden id:t ovat samat kuin A:lla.
#[tokio::test]
async fn pohja_haetaan_tasauksen_jalkeen_ilman_nakymapyyntoa() {
    let _vuoro = LUKKO.lock().await;
    let ymp = pystyta("tasaus").await;
    ymp.odota_pohjat().await;
    ymp.a.signaali("STOP");
    ymp.tarkista_viestit(ymp.b.portti).await;
}

/// (c) B käynnistetään uudelleen A:n ollessa pysäytettynä: tallennettu pohja riittää, viestit näkyvät.
#[tokio::test]
async fn uudelleenkaynnistys_kayttaa_tallennettua_pohjaa() {
    let _vuoro = LUKKO.lock().await;
    let ymp = pystyta("uudelleen").await;
    ymp.odota_pohjat().await;
    ymp.a.signaali("STOP");
    let Ymp {
        _tmp,
        http,
        avain,
        data_b,
        lisat,
        a,
        b,
        a_viestit,
    } = ymp;
    b.sammuta();
    let mut b = Solmu::kaynnista(vapaa_portti(), &data_b, &avain, &lisat, "loki2");
    odota_valmiiksi(&http, &mut b).await;
    let ymp = Ymp {
        _tmp,
        http,
        avain,
        data_b,
        lisat,
        a,
        b,
        a_viestit,
    };
    ymp.tarkista_viestit(ymp.b.portti).await;
}

/// (b) karsinta poistaa B:ltä tiedoston vanhimman yksikön → uusi pohja haetaan A:lta ilman näkymäpyyntöä
/// (B:n kannassa pohja `{offset 1000, rivi 5}`), ja A:n pysäytyksen jälkeen B:n viestit = A:n loppuosa.
#[tokio::test]
async fn karsinta_hakee_uuden_pohjan_ilman_nakymapyyntoa() {
    let _vuoro = LUKKO.lock().await;
    let tmp = Tmp::uusi("karsinta");
    let avain = tmp.0.join("avain");
    std::fs::write(&avain, format!("{AVAIN}\n")).unwrap();
    let http = reqwest::Client::new();
    let data_b = tmp.0.join("b");
    let tiedosto = TIEDOSTOT[0];

    let pa = vapaa_portti();
    let mut a = Solmu::kaynnista(pa, &tmp.0.join("a"), &avain, &[], "loki");
    odota_valmiiksi(&http, &mut a).await;
    // Vanhin yksikkö on ikkunassa vielä tasauksessa, mutta putoaa siitä 20 s myöhemmin; karsinta ajetaan
    // enintään kerran 60 s:ssa, joten se poistaa sen B:n käynnistyksen jälkeisessä karsinnassa.
    let nyt = nyt_ms();
    let reuna = nyt - IKKUNA_VRK * PAIVA_MS + 20_000;
    let uusi = nyt - 3_600_000;
    post(
        &http,
        pa,
        "/api/laheta",
        json!({"yksikot": [
            peiliyksikko(tiedosto, 0, reuna, 1, RIVEJA),
            peiliyksikko(tiedosto, 1000, uusi, 1 + RIVEJA, RIVEJA),
        ]}),
    )
    .await;
    lahteet(&http, pa, &[tiedosto]).await;
    let a_viestit = viestit(&http, pa, "koe1").await;
    assert_eq!(a_viestit.len(), 2 * RIVEJA);

    let lisat = vec![
        "--peili-ikkuna-vrk".to_string(),
        IKKUNA_VRK.to_string(),
        "--peili-katto-mt".to_string(),
        "38".to_string(),
        "--vertainen".to_string(),
        format!("http://127.0.0.1:{pa}"),
    ];
    let mut b = Solmu::kaynnista(vapaa_portti(), &data_b, &avain, &lisat, "loki1");
    odota_valmiiksi(&http, &mut b).await;
    // Ensin molemmat yksiköt B:ssä (vanhin offset 0: pohja {0, 0} ilman hakua).
    odota_kannassa(&b, &data_b, AIKARAJA, "B tasasi", |p, _, l| {
        p == 2 && l >= 1
    })
    .await;
    // Karsinta poistaa vanhimman; pohja haetaan A:lta ilman yhtään näkymäpyyntöä B:lle.
    let (p, pohjat, _) = odota_kannassa(
        &b,
        &data_b,
        KARSINTA_ODOTUS,
        "uusi pohja",
        |_, pohjat, _| pohjat.contains_key(tiedosto),
    )
    .await;
    assert_eq!(p, 1, "karsinta jätti yhden yksikön");
    assert_eq!(pohjat[tiedosto], (1000, RIVEJA as u64));
    assert!(b.loki().contains("peilin karsinta:"), "{}", b.loki());

    a.signaali("STOP");
    let b_viestit = viestit(&http, b.portti, "koe1").await;
    assert_eq!(b_viestit.len(), RIVEJA, "{}", b.loki());
    assert_eq!(b_viestit[..], a_viestit[RIVEJA..], "id:t ennallaan");
    drop(a);
}
