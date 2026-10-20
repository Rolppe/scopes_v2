//! Rivipohja ja pyynnöstä haku (T-56, S-9d, S-9e): täysi solmu A, ikkunoitu solmu B (7 vrk) ja
//! tarvittaessa ikkunoitu C prosessin sisällä, kukin omassa säikeessään vapaassa portissa (`127.0.0.1:0`).
//! Palvelimen eteen kytketty laskuri mittaa peilin lähdepyynnöt (`/rivi`, `/api/listat`, `/api/hae`).

use axum::{extract::Request, middleware::Next, response::Response};
use scopes_ydin::api::{self, Tila};
use scopes_ydin::peili::{self, PeiliIkkuna, Pohja};
use scopes_ydin::replikointi;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::vertaiset::Vertainen;
use scopes_ydin::yksikko::{yhdistaja_polulle, Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-peili-pohja";
const AIKARAJA: Duration = Duration::from_secs(30);
const PAIVA_MS: u64 = 86_400_000;
const IKKUNA: u32 = 7;
const SKOOPPI: &str = "koe";
const ISTUNTO: &str = "11111111-2222-4333-8444-555555555555";
const TIEDOSTO: &str = "-home-koe/11111111-2222-4333-8444-555555555555.jsonl";
const VIESTIT: &str = "/api/skoopit/koe/viestit";

// ---- solmut ------------------------------------------------------------------------------------------------------

/// Väliaikainen datahakemisto (`<hakemisto>/ydin.db` kuten solmulla), poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("peili-pohja-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Tmp(d)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Solmu {
    tila: Arc<Tila>,
    _tmp: Tmp,
}

fn solmu(laite: &str, ikkuna: Option<u32>, vertaiset: &[&Palvelin]) -> Solmu {
    let tmp = Tmp::uusi();
    let varasto = Arc::new(Varasto::avaa(&tmp.0.join("ydin.db")).unwrap());
    let (lahetin, _) = tokio::sync::broadcast::channel(1024);
    Solmu {
        tila: Arc::new(Tila {
            varasto,
            laite: laite.to_string(),
            headless: false,
            avain: AVAIN.to_string(),
            vanha: None,
            vanha_avain: None,
            vertaiset: vertaiset
                .iter()
                .map(|p| format!("127.0.0.1:{}", p.portti))
                .collect(),
            lr_vertainen: None,
            lahetin,
            peili: PeiliIkkuna::uusi(ikkuna, 38),
        }),
        _tmp: tmp,
    }
}

/// Palvelimen kautta kulkeneet pyynnöt: `/api/tiiviste` ja peilin lähdepyynnöt (rivi, listat, hae).
#[derive(Default)]
struct Laskurit {
    tiiviste: AtomicUsize,
    lahde: AtomicUsize,
}

struct Palvelin {
    portti: u16,
    laskurit: Arc<Laskurit>,
    seis: Option<oneshot::Sender<()>>,
    saie: Option<std::thread::JoinHandle<()>>,
}

async fn laske(l: Arc<Laskurit>, req: Request, next: Next) -> Response {
    let polku = req.uri().path();
    if polku == "/api/tiiviste" {
        l.tiiviste.fetch_add(1, Ordering::SeqCst);
    }
    if polku == "/api/listat"
        || polku == "/api/hae"
        || (polku.starts_with("/api/peili/") && polku.ends_with("/rivi"))
    {
        l.lahde.fetch_add(1, Ordering::SeqCst);
    }
    next.run(req).await
}

/// Palvelin omassa säikeessään ja ajonaikaisympäristössään: sammutus katkaisee myös taustatehtävät.
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
    fn lahde(&self) -> usize {
        self.laskurit.lahde.load(Ordering::SeqCst)
    }
    fn tiiviste(&self) -> usize {
        self.laskurit.tiiviste.load(Ordering::SeqCst)
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

// ---- data --------------------------------------------------------------------------------------------------------

/// Rivi `k` (1-pohjainen): joka kolmas on ei-viestirivi, muut käyttäjän viestejä "viesti k".
fn rivi(k: usize) -> String {
    if k.is_multiple_of(3) {
        json!({"type": "progress", "data": format!("edistys {k}")}).to_string()
    } else {
        json!({"type": "user", "timestamp": "2026-10-20T00:00:00.000Z",
            "message": {"role": "user", "content": format!("viesti {k}")}})
        .to_string()
    }
}

/// Kirjoittaa A:han tiedoston yksiköt annetuilla HLC-ajoilla ja rivimäärillä; palauttaa (offset, rivejä).
fn tayta(a: &Tila, yksikot: &[(u64, usize)]) -> Vec<(u64, usize)> {
    let mut ulos = Vec::new();
    let mut offset = 0u64;
    let mut k = 1usize;
    for (ms, n) in yksikot {
        let rivit: Vec<String> = (k..k + n).map(rivi).collect();
        k += n;
        let y = Yksikko {
            polku: "peili".to_string(),
            id: format!("{TIEDOSTO}:{offset}"),
            versio: BTreeMap::from([("a".to_string(), 1)]),
            aika: Hlc {
                ms: *ms,
                laskuri: 0,
                laite: "a".to_string(),
            },
            sisalto: Some(serde_json::to_vec(&rivit).unwrap()),
            poistettu: false,
        };
        api::kirjoita_yhdistajalla(a, &y, yhdistaja_polulle("peili")).unwrap();
        ulos.push((offset, *n));
        offset += rivit.iter().map(|r| r.len() as u64 + 1).sum::<u64>();
    }
    ulos
}

async fn get(url: &str) -> (u16, Value) {
    let v = reqwest::Client::new()
        .get(url)
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap();
    let koodi = v.status().as_u16();
    (koodi, v.json().await.unwrap_or(Value::Null))
}

async fn post(url: &str, runko: Value) {
    let v = reqwest::Client::new()
        .post(url)
        .bearer_auth(AVAIN)
        .json(&runko)
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200, "{url}");
}

/// A:n lähde: yksi avoin istunto skoopissa `koe`, transkripti `TIEDOSTO`.
async fn lahde(a: &Palvelin) {
    let istunto = json!({
        "istunto": ISTUNTO, "skooppi": SKOOPPI, "tila": "idle", "kysely": false,
        "pakattu": false, "hereilla": true, "transkripti": TIEDOSTO,
        "alkoi": "2026-10-20T10:00:00.000Z", "ruutu": "%1",
    });
    post(
        &a.url("/api/lahde/istunnot"),
        json!({"laite": "palvelin", "sisalto": [istunto]}),
    )
    .await;
    post(
        &a.url("/api/lahde/agy"),
        json!({"laite": "palvelin", "sisalto": []}),
    )
    .await;
}

/// Viestit tunnisteineen (`?since=0` = nollaus, kaikki näkyvät): (id, teksti).
async fn viestit(p: &Palvelin) -> Vec<(String, String)> {
    let (koodi, r) = get(&p.url(&format!("{VIESTIT}?since=0"))).await;
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

async fn odota_viestit(
    p: &Palvelin,
    kuvaus: &str,
    ehto: impl Fn(&[(String, String)]) -> bool,
) -> Vec<(String, String)> {
    let alku = Instant::now();
    loop {
        let v = viestit(p).await;
        if ehto(&v) {
            return v;
        }
        assert!(
            alku.elapsed() < AIKARAJA,
            "aikaraja ylittyi: {kuvaus}: {v:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn rivinro(id: &str) -> usize {
    let (_, n) = id.rsplit_once(':').unwrap();
    n.split('.').next().unwrap().parse().unwrap()
}

/// A täysi, B ikkunoitu (vertainen A); B saa A:n lähteen ja ikkunan peilin tasaa-kierroksella.
struct Pari {
    a: Solmu,
    pa: Palvelin,
    b: Solmu,
    pb: Palvelin,
    yksikot: Vec<(u64, usize)>,
}

async fn pari(yksikot: &[(u64, usize)]) -> Pari {
    let a = solmu("a", None, &[]);
    let pa = kaynnista(a.tila.clone());
    let yksikot = tayta(&a.tila, yksikot);
    lahde(&pa).await;
    let b = solmu("b", Some(IKKUNA), &[&pa]);
    replikointi::tasaa_kerran(&b.tila, &pa.vertainen())
        .await
        .unwrap();
    let pb = kaynnista(b.tila.clone());
    Pari {
        a,
        pa,
        b,
        pb,
        yksikot,
    }
}

fn nyt() -> u64 {
    api::kello_ms()
}

// ---- testit ------------------------------------------------------------------------------------------------------

/// (a) rivi-reitti: kolme yksikköä → 0, n1, n1+n2; tuntematon offset ja tiedosto 404.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rivi_reitti_laskee_edeltavat_rivit() {
    let a = solmu("a", None, &[]);
    let pa = kaynnista(a.tila.clone());
    let y = tayta(&a.tila, &[(nyt(), 3), (nyt(), 4), (nyt(), 5)]);
    let polku = |o: u64| format!("/api/peili/{TIEDOSTO}/rivi?offset={o}");
    for ((offset, _), odotettu) in y.iter().zip([0, 3, 7]) {
        let (koodi, r) = get(&pa.url(&polku(*offset))).await;
        assert_eq!(koodi, 200);
        assert_eq!(r, json!({"offset": offset, "rivi": odotettu}));
    }
    let (koodi, _) = get(&pa.url(&polku(y[1].0 + 1))).await;
    assert_eq!(koodi, 404);
    let (koodi, _) = get(&pa.url("/api/peili/tuntematon.jsonl/rivi?offset=0")).await;
    assert_eq!(koodi, 404);
    let (koodi, _) = get(&pa.url(&format!("/api/peili/{TIEDOSTO}/rivi"))).await;
    assert_eq!(koodi, 400);
    // Offset-reitti ennallaan.
    let (koodi, _) = get(&pa.url(&format!("/api/peili/{TIEDOSTO}/offset"))).await;
    assert_eq!(koodi, 200);
}

/// (b) B:ltä puuttuu tiedoston alku → B:n viesti-id:t = A:n viesti-id:t samoille riveille; (f) täyden
/// solmun vastauksessa ei `haettavissa`-kenttää.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ikkunoidun_tunnisteet_vastaavat_taytta() {
    let vanha = nyt() - 10 * PAIVA_MS;
    let uusi = nyt() - 3_600_000;
    // 4 × 30 vanhaa riviä ikkunan ulkopuolella, 3 × 90 riviä (180 viestiä) ikkunassa.
    let p = pari(&[
        (vanha, 30),
        (vanha, 30),
        (vanha, 30),
        (vanha, 30),
        (uusi, 90),
        (uusi, 90),
        (uusi, 90),
    ])
    .await;
    let b_peili: BTreeSet<String> =
        p.b.tila
            .varasto
            .listaa_otsakkeet("peili")
            .unwrap()
            .into_iter()
            .map(|y| y.id)
            .collect();
    assert_eq!(b_peili.len(), 3, "B:ssä vain ikkunan yksiköt");
    let lahde_ennen = p.pa.lahde();

    let a_viestit = viestit(&p.pa).await;
    assert_eq!(a_viestit.len(), 120);
    let b_viestit = odota_viestit(&p.pb, "B:n pohja", |v| !v.is_empty()).await;
    assert_eq!(
        b_viestit, a_viestit,
        "samat id:t ja tekstit samoille riveille"
    );
    assert!(rivinro(&b_viestit[0].0) > 120);
    assert_eq!(
        peili::pohja(&p.b.tila.varasto, TIEDOSTO).unwrap(),
        Some(Pohja {
            offset: p.yksikot[4].0,
            rivi: 120
        })
    );
    // Ikkunoitu solmu: kenttä mukana; 180 viestiä ≥ 120 → ei taustahakua.
    let (_, r) = get(&p.pb.url(VIESTIT)).await;
    assert_eq!(r["haettavissa"], false);
    assert_eq!(
        p.pa.lahde() - lahde_ennen,
        1,
        "vain pohjan rivipyyntö A:lle"
    );

    // (f) täysi solmu: viestit-vastaus ilman `haettavissa`-kenttää (myös since).
    let (_, r) = get(&p.pa.url(VIESTIT)).await;
    assert!(r.get("haettavissa").is_none(), "{r}");
    assert_eq!(r["viestit"].as_array().unwrap().len(), 120);
    let (_, r) = get(&p.pa.url(&format!("{VIESTIT}?since=0"))).await;
    assert!(r.get("haettavissa").is_none(), "{r}");
}

/// (c) alle 120 viestiä ikkunassa ja pohja > 0 → taustahaku täydentää: B:n viestit = A:n viimeiset 120.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn taustahaku_taydentaa_vajaan_nakyman() {
    let vanha = nyt() - 10 * PAIVA_MS;
    let p = pari(&[
        (vanha, 60),
        (vanha, 60),
        (vanha, 60),
        (vanha, 60),
        (nyt() - 3_600_000, 60),
    ])
    .await;
    let a_viestit = viestit(&p.pa).await;
    assert_eq!(a_viestit.len(), 120);
    let b_viestit = odota_viestit(&p.pb, "taustahaku", |v| v.len() == 120).await;
    assert_eq!(b_viestit, a_viestit);
    assert_eq!(
        peili::voimassa_pohja(&p.b.tila.varasto, TIEDOSTO).unwrap(),
        Some(Pohja { offset: 0, rivi: 0 }),
        "edeltävät yksiköt haettu tiedoston alkuun asti"
    );
    // Haetut yksiköt ovat riisuttuja (S-9a) ja 10 min karsinnan suojassa: karsinta ei poista niitä.
    let haettu =
        p.b.tila
            .varasto
            .lue("peili", &format!("{TIEDOSTO}:0"))
            .unwrap()
            .unwrap();
    let rivit: Vec<String> = serde_json::from_slice(haettu.sisalto.as_ref().unwrap()).unwrap();
    assert_eq!(
        rivit[2],
        json!({"type": "progress", "karsittu": true}).to_string()
    );
    assert_eq!(peili::karsi(&p.b.tila).unwrap().poistetut, 0);
    let (_, r) = get(&p.pb.url(VIESTIT)).await;
    assert_eq!(r["haettavissa"], false);
}

/// (d) A pysäytetty → `haettavissa: true`, ikkunan viestit näkyvät.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn vertainen_poissa_haettavissa() {
    let vanha = nyt() - 10 * PAIVA_MS;
    let p = pari(&[(vanha, 60), (vanha, 60), (nyt() - 3_600_000, 60)]).await;
    let a_viestit = viestit(&p.pa).await;
    // Pohja haetaan A:lta ennen pysäytystä (näkymä ei ole vielä pyytänyt mitään).
    let pohja = peili::hae_pohja(&p.b.tila, TIEDOSTO).await.unwrap();
    assert_eq!(
        pohja,
        Some(Pohja {
            offset: p.yksikot[2].0,
            rivi: 120
        })
    );
    let Pari {
        a: _a,
        pa,
        b: _b,
        pb,
        ..
    } = p;
    drop(pa);

    let b_viestit = viestit(&pb).await;
    assert_eq!(b_viestit.len(), 40, "ikkunan 40 viestiä näkyvät");
    assert_eq!(b_viestit[..], a_viestit[a_viestit.len() - 40..]);
    let alku = Instant::now();
    loop {
        let (koodi, r) = get(&pb.url(VIESTIT)).await;
        assert_eq!(koodi, 200);
        assert_eq!(r["viestit"].as_array().unwrap().len(), 40);
        if r["haettavissa"] == true {
            break;
        }
        assert!(alku.elapsed() < AIKARAJA, "haettavissa ei tullut: {r}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (_, r) = get(&pb.url(&format!("{VIESTIT}?since=0"))).await;
    assert_eq!(r["haettavissa"], true);
}

/// (e) karsinta poistaa vanhimman yksikön → pohja päivittyy, id:t eivät muutu, poistuneet `poistetut`-listassa.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn karsinta_paivittaa_pohjan_ja_poistetut() {
    // Vanhin yksikkö on ikkunassa vielä tasaa-hetkellä, mutta putoaa siitä 5 s myöhemmin.
    let reuna = nyt() - u64::from(IKKUNA) * PAIVA_MS + 5_000;
    let p = pari(&[(reuna, 9), (nyt() - 3_600_000, 15), (nyt(), 15)]).await;
    assert_eq!(p.b.tila.varasto.listaa_otsakkeet("peili").unwrap().len(), 3);
    let ennen = odota_viestit(&p.pb, "B:n näkymä", |v| !v.is_empty()).await;
    assert_eq!(ennen, viestit(&p.pa).await, "koko tiedosto: pohja 0");
    let (_, r) = get(&p.pb.url(&format!("{VIESTIT}?since=0"))).await;
    let seq = r["seq"].as_u64().unwrap();

    while nyt() <= reuna + u64::from(IKKUNA) * PAIVA_MS {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(peili::karsi(&p.b.tila).unwrap().poistetut, 1);
    let pohja = peili::hae_pohja(&p.b.tila, TIEDOSTO).await.unwrap();
    let (_, r) = get(&p.pa.url(&format!(
        "/api/peili/{TIEDOSTO}/rivi?offset={}",
        p.yksikot[1].0
    )))
    .await;
    assert_eq!(
        pohja,
        Some(Pohja {
            offset: p.yksikot[1].0,
            rivi: 9
        })
    );
    assert_eq!(r["rivi"], 9);

    let (_, r) = get(&p.pb.url(&format!("{VIESTIT}?since={seq}"))).await;
    let poistetut: BTreeSet<String> = r["poistetut"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let odotetut: BTreeSet<String> = ennen
        .iter()
        .filter(|(id, _)| rivinro(id) <= 9)
        .map(|(id, _)| id.clone())
        .collect();
    assert_eq!(odotetut.len(), 6);
    assert_eq!(poistetut, odotetut, "{r}");
    assert_eq!(
        r["muuttuneet"],
        json!([]),
        "jäljelle jääneet id:t ennallaan"
    );
    assert!(r.get("nollaus").is_none());
}

/// (g) B:n vertaislistassa ensin ikkunoitu C, sitten täysi A → pohja ja taustahaku tulevat A:lta.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ikkunoitu_vertainen_ohitetaan() {
    let vanha = nyt() - 10 * PAIVA_MS;
    let a = solmu("a", None, &[]);
    let pa = kaynnista(a.tila.clone());
    tayta(
        &a.tila,
        &[
            (vanha, 60),
            (vanha, 60),
            (vanha, 60),
            (vanha, 60),
            (nyt() - 3_600_000, 60),
        ],
    );
    lahde(&pa).await;
    let c = solmu("c", Some(IKKUNA), &[&pa]);
    replikointi::tasaa_kerran(&c.tila, &pa.vertainen())
        .await
        .unwrap();
    let pc = kaynnista(c.tila.clone());
    let b = solmu("b", Some(IKKUNA), &[&pc, &pa]);
    replikointi::tasaa_kerran(&b.tila, &pa.vertainen())
        .await
        .unwrap();
    let pb = kaynnista(b.tila.clone());
    let lahde_ennen = pa.lahde();

    let a_viestit = viestit(&pa).await;
    let b_viestit = odota_viestit(&pb, "taustahaku A:lta", |v| v.len() == 120).await;
    assert_eq!(b_viestit, a_viestit);
    assert!(pc.tiiviste() >= 2, "C kysyttiin ensin (pohja ja haku)");
    assert_eq!(pc.lahde(), 0, "ikkunoitu C ei ole peilin lähde");
    assert!(pa.lahde() >= lahde_ennen + 3, "rivi, listat ja hae A:lta");
}
