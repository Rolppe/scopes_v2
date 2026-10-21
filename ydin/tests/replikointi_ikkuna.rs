//! Ikkunoidun peilin replikointi (T-55, S-9b): täysi solmu A ja ikkunoitu solmu B prosessin sisällä,
//! axum-palvelimet satunnaisissa porteissa (`127.0.0.1:0`). Palvelimen eteen kytketty laskuri mittaa
//! `/api/hae`-pyyntöjen peili-tunnukset ja `/api/laheta`-runkojen peili-yksiköt.

use axum::{body::Body, extract::Request, middleware::Next, response::Response};
use scopes_ydin::api::{self, Tila};
use scopes_ydin::peili::{self, PeiliIkkuna};
use scopes_ydin::replikointi;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::vertaiset::Vertainen;
use scopes_ydin::yksikko::{yhdistaja_polulle, Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-replikointi-ikkuna";
const AIKARAJA: Duration = Duration::from_secs(90);
const PAIVA_MS: u64 = 86_400_000;
/// A:n synteettinen peili: 30 vrk, 6 yksikköä vuorokaudessa (~60 kt raakana, ~41 kt riisuttuna).
const VRK: u64 = 30;
const PAIVASSA: u64 = 6;
const IKKUNA: u32 = 7;

/// Väliaikainen tietokantatiedosto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("replikointi-ikkuna-{}-{n}.db", std::process::id())))
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        for paate in ["", "-wal", "-shm"] {
            let mut s = self.0.clone().into_os_string();
            s.push(paate);
            let _ = std::fs::remove_file(s);
        }
    }
}

fn tila_tiedostoon(tiedosto: &Path, laite: &str, ikkuna: Option<u32>, katto: u32) -> Arc<Tila> {
    let varasto = Arc::new(Varasto::avaa(tiedosto).unwrap());
    let (lahetin, _) = tokio::sync::broadcast::channel(1024);
    Arc::new(Tila {
        varasto,
        laite: laite.to_string(),
        headless: false,
        avain: AVAIN.to_string(),
        vanha: None,
        vanha_avain: None,
        vertaiset: vec![],
        lr_vertainen: None,
        adapteri: Default::default(),
        lahetin,
        peili: PeiliIkkuna::uusi(ikkuna, katto),
    })
}

struct Solmu {
    tila: Arc<Tila>,
    _tmp: Tmp,
}

fn solmu(laite: &str, ikkuna: Option<u32>, katto: u32) -> Solmu {
    let tmp = Tmp::uusi();
    Solmu {
        tila: tila_tiedostoon(&tmp.0, laite, ikkuna, katto),
        _tmp: tmp,
    }
}

/// Palvelimen kautta kulkeneet peili-tunnukset (`/api/hae`) ja peili-yksiköt (`/api/laheta`).
#[derive(Default)]
struct Laskurit {
    hae_peili: AtomicUsize,
    laheta_peili: AtomicUsize,
}

impl Laskurit {
    fn nollaa(&self) {
        self.hae_peili.store(0, Ordering::SeqCst);
        self.laheta_peili.store(0, Ordering::SeqCst);
    }
    fn hae(&self) -> usize {
        self.hae_peili.load(Ordering::SeqCst)
    }
    fn laheta(&self) -> usize {
        self.laheta_peili.load(Ordering::SeqCst)
    }
}

struct Palvelin {
    portti: u16,
    laskurit: Arc<Laskurit>,
    seis: Option<oneshot::Sender<()>>,
    saie: Option<std::thread::JoinHandle<()>>,
}

async fn laske(l: Arc<Laskurit>, req: Request, next: Next) -> Response {
    let polku = req.uri().path().to_string();
    if polku != "/api/hae" && polku != "/api/laheta" {
        return next.run(req).await;
    }
    let (osat, runko) = req.into_parts();
    let tavut = axum::body::to_bytes(runko, usize::MAX).await.unwrap();
    if let Ok(v) = serde_json::from_slice::<Value>(&tavut) {
        if polku == "/api/hae" && v["polku"] == "peili" {
            let n = v["idt"].as_array().map_or(0, Vec::len);
            l.hae_peili.fetch_add(n, Ordering::SeqCst);
        }
        if polku == "/api/laheta" {
            let n = v["yksikot"]
                .as_array()
                .map_or(0, |a| a.iter().filter(|y| y["polku"] == "peili").count());
            l.laheta_peili.fetch_add(n, Ordering::SeqCst);
        }
    }
    next.run(Request::from_parts(osat, Body::from(tavut))).await
}

/// Palvelin omassa säikeessään vapaassa portissa (sammutus katkaisee myös avoimet virrat).
fn kaynnista(tila: Arc<Tila>) -> Palvelin {
    let laskurit = Arc::new(Laskurit::default());
    let l = laskurit.clone();
    let (portti_tx, portti_rx) = std::sync::mpsc::channel();
    let (seis_tx, seis_rx) = oneshot::channel::<()>();
    let saie = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let kuuntelija = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("portin sidonta");
            portti_tx
                .send(kuuntelija.local_addr().unwrap().port())
                .unwrap();
            let reititin = api::router_valilla(tila, Duration::from_millis(500)).layer(
                axum::middleware::from_fn(move |req: Request, next: Next| {
                    laske(l.clone(), req, next)
                }),
            );
            tokio::select! {
                _ = async { axum::serve(kuuntelija, reititin).await } => {}
                _ = seis_rx => {}
            }
        });
        rt.shutdown_timeout(Duration::from_secs(2));
    });
    Palvelin {
        portti: portti_rx.recv().unwrap(),
        laskurit,
        seis: Some(seis_tx),
        saie: Some(saie),
    }
}

impl Palvelin {
    fn vertainen(&self) -> Vertainen {
        Vertainen::osoitteesta(&format!("127.0.0.1:{}", self.portti), AVAIN).unwrap()
    }
    fn url(&self, polku: &str) -> String {
        format!("http://127.0.0.1:{}{polku}", self.portti)
    }
}

impl Drop for Palvelin {
    fn drop(&mut self) {
        if let Some(s) = self.seis.take() {
            let _ = s.send(());
        }
        if let Some(s) = self.saie.take() {
            let _ = s.join();
        }
    }
}

fn nyt_ms() -> u64 {
    api::kello_ms()
}

fn yksikko(polku: &str, id: &str, laite: &str, ms: u64, sisalto: Vec<u8>) -> Yksikko {
    Yksikko {
        polku: polku.to_string(),
        id: id.to_string(),
        versio: BTreeMap::from([(laite.to_string(), 1)]),
        aika: Hlc {
            ms,
            laskuri: 0,
            laite: laite.to_string(),
        },
        sisalto: Some(sisalto),
        poistettu: false,
    }
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

fn kirjoita(tila: &Tila, y: &Yksikko) {
    api::kirjoita_yhdistajalla(tila, y, yhdistaja_polulle(&y.polku)).unwrap();
}

/// Transkriptin rivit: 10 käyttäjäviestiä (4 kt tekstiä + 1 kt riisuttavaa) ja 10 riisuttavaa riviä.
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

/// A:n 30 vrk peili suoraan varastoon menneillä HLC-ajoilla sekä muita polkuja.
fn tayta_a(a: &Tila, nyt: u64) {
    for k in 0..VRK {
        for j in 0..PAIVASSA {
            let ms = nyt - k * PAIVA_MS - 3_600_000 - j * 600_000;
            let tiedosto = format!("istunto-{k:02}.jsonl");
            let id = format!("{tiedosto}:{}", j * 100_000);
            let sisalto = serde_json::to_vec(&rivit(&id, ms)).unwrap();
            kirjoita(a, &yksikko("peili", &id, "a", ms, sisalto));
        }
    }
    for i in 0..20u64 {
        kirjoita(
            a,
            &yksikko(
                "rekisterit/r1",
                &format!("r{i:02}"),
                "a",
                nyt - i * 1000,
                format!("r{i}").into_bytes(),
            ),
        );
    }
    kirjoita(a, &yksikko("tila", "asetukset/x", "a", nyt, b"1".to_vec()));
}

/// A:n peili-tunnukset, joiden aika on ikkunassa `nyt`-hetkellä.
fn ikkunan_idt(a: &Tila, nyt: u64) -> BTreeSet<String> {
    let raja = nyt - u64::from(IKKUNA) * PAIVA_MS;
    a.varasto
        .listaa_otsakkeet("peili")
        .unwrap()
        .into_iter()
        .filter(|y| y.aika.ms >= raja)
        .map(|y| y.id)
        .collect()
}

fn peili_idt(t: &Tila) -> BTreeSet<String> {
    t.varasto
        .listaa_otsakkeet("peili")
        .unwrap()
        .into_iter()
        .map(|y| y.id)
        .collect()
}

fn ilman_peilia(mut k: BTreeMap<String, String>) -> BTreeMap<String, String> {
    k.remove("peili");
    k
}

async fn odota(kuvaus: &str, ehto: impl Fn() -> bool) {
    let alku = Instant::now();
    while !ehto() {
        assert!(alku.elapsed() < AIKARAJA, "aikaraja ylittyi: {kuvaus}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn get_json(http: &reqwest::Client, url: &str) -> Value {
    http.get(url)
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// (a), (b), (c), (e): A täysi, B ikkunoitu 7 vrk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ikkunoitu_vetaa_ikkunan_ja_ei_ole_lahde() {
    let nyt = nyt_ms();
    let a = solmu("a", None, 38);
    let b = solmu("b", Some(IKKUNA), 38);
    tayta_a(&a.tila, nyt);
    let pa = kaynnista(a.tila.clone());
    let pb = kaynnista(b.tila.clone());

    // (a) ensimmäinen tasaus: vain ikkunan yksiköt, riisuttuina; muut polut samat kuin A:lla.
    let t1 = replikointi::tasaa_kerran(&b.tila, &pa.vertainen())
        .await
        .unwrap();
    let ikkuna = ikkunan_idt(&a.tila, nyt);
    assert_eq!(ikkuna.len() as u64, u64::from(IKKUNA) * PAIVASSA);
    assert_eq!(peili_idt(&b.tila), ikkuna);
    assert_eq!(t1.peili_haettu, ikkuna.len());
    assert_eq!(pa.laskurit.hae(), ikkuna.len());
    assert_eq!(pa.laskurit.laheta(), 0, "B ei lähetä peiliä");
    for yb in b.tila.varasto.listaa("peili").unwrap() {
        let ya = a.tila.varasto.lue("peili", &yb.id).unwrap().unwrap();
        let alkup: Vec<String> = serde_json::from_slice(ya.sisalto.as_deref().unwrap()).unwrap();
        let odotettu = serde_json::to_vec(&peili::riisu(&alkup)).unwrap();
        assert_eq!(
            yb.sisalto.as_deref(),
            Some(odotettu.as_slice()),
            "{}",
            yb.id
        );
        assert_eq!((&yb.versio, &yb.aika), (&ya.versio, &ya.aika));
        assert!(yb.sisalto.as_ref().unwrap().len() < ya.sisalto.as_ref().unwrap().len());
    }
    let (_, ta) = replikointi::tiivisteet(&a.tila).unwrap();
    let (_, tb) = replikointi::tiivisteet(&b.tila).unwrap();
    assert!(ta.contains_key("peili"));
    assert!(
        !tb.contains_key("peili"),
        "ikkunoidun tiivisteistä puuttuu peili"
    );
    assert_eq!(ilman_peilia(ta.clone()), tb, "muut polut samat");
    assert_eq!(
        a.tila.varasto.listaa("rekisterit/r1").unwrap(),
        b.tila.varasto.listaa("rekisterit/r1").unwrap()
    );

    // (b) toinen tasaus: 0 peili-yksikköä haettu ja lähetetty.
    pa.laskurit.nollaa();
    let t2 = replikointi::tasaa_kerran(&b.tila, &pa.vertainen())
        .await
        .unwrap();
    assert_eq!(t2.peili_haettu, 0);
    assert_eq!(pa.laskurit.hae(), 0, "toinen tasaa hakee 0 peili-yksikköä");
    assert_eq!(
        pa.laskurit.laheta(),
        0,
        "toinen tasaa lähettää 0 peili-yksikköä"
    );
    assert_eq!(peili_idt(&b.tila), ikkuna);

    // (c) A:n tasaus B:tä vastaan ei lähetä peiliä eikä hae sitä.
    let a_peili_ennen = a.tila.varasto.listaa("peili").unwrap();
    let ta_c = replikointi::tasaa_kerran(&a.tila, &pb.vertainen())
        .await
        .unwrap();
    assert_eq!(
        ta_c.ikkunoidut,
        BTreeSet::from(["peili".to_string()]),
        "B ilmoittaa ikkunoidut"
    );
    assert_eq!(ta_c.peili_haettu, 0);
    assert_eq!(pb.laskurit.laheta(), 0, "A:n /api/laheta: 0 peili-yksikköä");
    assert_eq!(pb.laskurit.hae(), 0, "A ei hae B:n peiliä");
    assert_eq!(a.tila.varasto.listaa("peili").unwrap(), a_peili_ennen);
    assert_eq!(peili_idt(&b.tila), ikkuna);

    // (e) B ei ole peilin lähde: listat tyhjä, hae ei palauta peiliä; tiiviste ilmoittaa ikkunoidut.
    let http = reqwest::Client::new();
    let l = get_json(&http, &pb.url("/api/listat?polku=peili")).await;
    assert_eq!(l["yksikot"], json!([]));
    let l = get_json(&http, &pb.url("/api/listat?polku=rekisterit/r1")).await;
    assert_eq!(l["yksikot"].as_array().unwrap().len(), 20);
    let idt: Vec<String> = ikkuna.iter().take(5).cloned().collect();
    let h: Value = http
        .post(pb.url("/api/hae"))
        .bearer_auth(AVAIN)
        .json(&json!({"polku": "peili", "idt": idt}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(h["yksikot"], json!([]), "{h}");
    let t = get_json(&http, &pb.url("/api/tiiviste")).await;
    assert_eq!(t["ikkunoidut"], json!(["peili"]));
    assert!(t["tiivisteet"].get("peili").is_none());
    let t = get_json(&http, &pb.url("/api/tiiviste?polku=peili")).await;
    assert_eq!(t["tiiviste"], json!(""));
    // Täysi solmu ei lähetä kenttää.
    let t = get_json(&http, &pa.url("/api/tiiviste")).await;
    assert!(t.get("ikkunoidut").is_none(), "{t}");
    assert!(t["tiivisteet"].get("peili").is_some());
}

/// (d) Kaksi täyttä solmua: replikointi kuten ennen (kaikki peili haetaan, tiivisteet samat).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kaksi_taytta_solmua_ennallaan() {
    let nyt = nyt_ms();
    let a = solmu("a", None, 38);
    let c = solmu("c", None, 38);
    tayta_a(&a.tila, nyt);
    kirjoita(
        &c.tila,
        &yksikko("rekisterit/r2", "c1", "c", nyt, b"c1".to_vec()),
    );
    let pa = kaynnista(a.tila.clone());
    let pc = kaynnista(c.tila.clone());

    let t1 = replikointi::tasaa_kerran(&c.tila, &pa.vertainen())
        .await
        .unwrap();
    assert!(t1.ikkunoidut.is_empty());
    assert_eq!(t1.peili_haettu as u64, VRK * PAIVASSA);
    // C lähetti oman yksikkönsä A:lle; A:n tasaus C:tä vastaan ei siirrä mitään.
    let t2 = replikointi::tasaa_kerran(&a.tila, &pc.vertainen())
        .await
        .unwrap();
    assert_eq!(t2.peili_haettu, 0);
    assert_eq!(pc.laskurit.laheta(), 0);
    assert_eq!(
        replikointi::tiivisteet(&a.tila).unwrap().1,
        replikointi::tiivisteet(&c.tila).unwrap().1
    );
    assert_eq!(
        a.tila.varasto.listaa_etuliite("").unwrap(),
        c.tila.varasto.listaa_etuliite("").unwrap()
    );
    pa.laskurit.nollaa();
    let t3 = replikointi::tasaa_kerran(&c.tila, &pa.vertainen())
        .await
        .unwrap();
    assert_eq!(t3.peili_haettu, 0);
    assert_eq!((pa.laskurit.hae(), pa.laskurit.laheta()), (0, 0));
}

/// (f) Uusi täysi solmu C: B:n (ikkunoitu) virran peili-tapahtumaa ei sovelleta; A:lta peili tavulleen.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn taysi_ei_sovella_ikkunoidun_virtaa() {
    let nyt = nyt_ms();
    let a = solmu("a", None, 38);
    let b = solmu("b", Some(IKKUNA), 38);
    let c = solmu("c", None, 38);
    tayta_a(&a.tila, nyt);
    let pa = kaynnista(a.tila.clone());
    let pb = kaynnista(b.tila.clone());
    replikointi::tasaa_kerran(&b.tila, &pa.vertainen())
        .await
        .unwrap();
    assert!(!peili_idt(&b.tila).is_empty());

    let silmukka = tokio::spawn(replikointi::silmukka(c.tila.clone(), pb.vertainen()));
    odota("C saa B:n rekisterit", || {
        c.tila.varasto.listaa("rekisterit/r1").unwrap().len() == 20
    })
    .await;
    assert!(peili_idt(&c.tila).is_empty(), "tasaa ei hae B:n peiliä");
    // Odotetaan, että C on virrassa (kursori asetettu), ja kirjoitetaan B:lle peili ja merkki.
    odota("C:n kursori B:lle", || {
        c.tila.varasto.kursori(&pb.vertainen().id).unwrap_or(0) > 0
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let uusi = yksikko(
        "peili",
        "uusi.jsonl:0",
        "b",
        nyt_ms() - 60_000,
        serde_json::to_vec(&rivit("uusi", nyt_ms() - 60_000)).unwrap(),
    );
    assert!(api::kirjoita_ja_ilmoita(&b.tila, &uusi)
        .await
        .unwrap()
        .is_some());
    let merkki = yksikko("rekisterit/merkki", "m", "b", nyt_ms(), b"m".to_vec());
    api::kirjoita_ja_ilmoita(&b.tila, &merkki).await.unwrap();
    odota("C saa merkin B:n virrasta", || {
        c.tila
            .varasto
            .lue("rekisterit/merkki", "m")
            .unwrap()
            .is_some()
    })
    .await;
    silmukka.abort();
    let _ = silmukka.await;
    assert!(
        peili_idt(&c.tila).is_empty(),
        "C sovelsi B:n peili-tapahtuman"
    );
    assert_eq!(pb.laskurit.hae(), 0, "C ei hakenut B:ltä peiliä");

    // C tasaa A:ta vastaan: peili = A:n peili tavulleen.
    replikointi::tasaa_kerran(&c.tila, &pa.vertainen())
        .await
        .unwrap();
    assert_eq!(
        c.tila.varasto.listaa("peili").unwrap(),
        a.tila.varasto.listaa("peili").unwrap()
    );
    assert_eq!(
        c.tila.varasto.tiiviste("peili").unwrap(),
        a.tila.varasto.tiiviste("peili").unwrap()
    );
}

/// (g) B:n katto karsii ikkunan sisältä: karsintaraja estää uudelleenhaun ja säilyy uudelleenavauksen yli.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn karsintaraja_estaa_uudelleenhaun() {
    let nyt = nyt_ms();
    let a = solmu("a", None, 38);
    tayta_a(&a.tila, nyt);
    let pa = kaynnista(a.tila.clone());
    let tmp_b = Tmp::uusi();
    let b = tila_tiedostoon(&tmp_b.0, "b", Some(IKKUNA), 1);

    let t1 = replikointi::tasaa_kerran(&b, &pa.vertainen())
        .await
        .unwrap();
    assert_eq!(t1.peili_haettu, ikkunan_idt(&a.tila, nyt).len());
    assert_eq!(peili::karsintaraja(&b.varasto).unwrap(), 0);
    let k = peili::karsi(&b).unwrap();
    assert!(k.poistetut > 0, "{k:?}");
    assert!(k.tavut_ennen > 1_048_576, "{k:?}");
    assert!(k.tavut_jalkeen <= 1_048_576, "{k:?}");
    let raja = peili::karsintaraja(&b.varasto).unwrap();
    assert!(
        raja > nyt - u64::from(IKKUNA) * PAIVA_MS,
        "karsinta ikkunan sisältä: raja {raja}"
    );
    assert_eq!(raja % PAIVA_MS, 0, "vuorokauden loppu");
    let jaljella = peili_idt(&b);
    assert!(jaljella.len() < ikkunan_idt(&a.tila, nyt).len());
    for y in b.varasto.listaa_otsakkeet("peili").unwrap() {
        assert!(y.aika.ms >= raja, "{} jäi rajan alle", y.id);
    }
    // Sisäinen polku ei tiivisteeseen.
    let (_, tb) = replikointi::tiivisteet(&b).unwrap();
    assert!(!tb.contains_key("peili-karsinta"));

    // Kaksi peräkkäistä tasausta: 0 peili-yksikköä.
    for kierros in 0..2 {
        pa.laskurit.nollaa();
        let t = replikointi::tasaa_kerran(&b, &pa.vertainen())
            .await
            .unwrap();
        assert_eq!(t.peili_haettu, 0, "kierros {kierros}");
        assert_eq!(pa.laskurit.hae(), 0, "kierros {kierros}");
        assert_eq!(pa.laskurit.laheta(), 0, "kierros {kierros}");
    }
    assert_eq!(peili_idt(&b), jaljella);
    // Raja kasvaa vain: karsinta ilman ylitystä ei laske sitä.
    peili::karsi(&b).unwrap();
    assert_eq!(peili::karsintaraja(&b.varasto).unwrap(), raja);

    // Uudelleenavaus: raja säilyy, tasaus hakee 0.
    drop(b);
    let b = tila_tiedostoon(&tmp_b.0, "b", Some(IKKUNA), 1);
    assert_eq!(peili::karsintaraja(&b.varasto).unwrap(), raja);
    pa.laskurit.nollaa();
    let t = replikointi::tasaa_kerran(&b, &pa.vertainen())
        .await
        .unwrap();
    assert_eq!(t.peili_haettu, 0);
    assert_eq!(pa.laskurit.hae(), 0);
    assert_eq!(peili_idt(&b), jaljella);
}
