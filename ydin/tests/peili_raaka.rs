//! Raakarivit pyynnöstä (T-60, S-9f): täysi solmu A lukee rivit riisumatta, ikkunoitu solmu B välittää
//! pyynnön A:lle tallentamatta. Solmut ovat prosessin sisällä omissa säikeissään vapaissa porteissa
//! (`127.0.0.1:0`, P-6).

use scopes_ydin::api::{self, Tila};
use scopes_ydin::peili::PeiliIkkuna;
use scopes_ydin::replikointi;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::vertaiset::Vertainen;
use scopes_ydin::yksikko::{Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-peili-raaka";
const PAIVA_MS: u64 = 86_400_000;
const IKKUNA: u32 = 7;
const TIEDOSTO: &str = "-home-koe/11111111-2222-4333-8444-555555555555.jsonl";

// ---- solmut ------------------------------------------------------------------------------------------------------

/// Väliaikainen datahakemisto (`<hakemisto>/ydin.db` kuten solmulla), poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("peili-raaka-{}-{n}", std::process::id()));
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

struct Palvelin {
    portti: u16,
    seis: Option<oneshot::Sender<()>>,
    saie: Option<std::thread::JoinHandle<()>>,
}

/// Palvelin omassa säikeessään ja ajonaikaisympäristössään: sammutus katkaisee myös taustatehtävät.
fn kaynnista(tila: Arc<Tila>) -> Palvelin {
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
            let reititin = api::router_valilla(tila, Duration::from_millis(500));
            tokio::select! {
                _ = async { axum::serve(kuuntelija, reititin).await } => {}
                _ = seis_rx => {}
            }
        });
        rt.shutdown_timeout(Duration::from_secs(2));
    });
    Palvelin {
        portti: portti_rx.recv().unwrap(),
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

// ---- data --------------------------------------------------------------------------------------------------------

/// Rivi `k` (1-pohjainen): joka kolmas on ei-viestirivi (riisunta tekisi siitä tyngän), muut käyttäjän
/// viestejä; kaikissa on riisunnassa karsiutuva `extra`-kenttä.
fn rivi(k: usize) -> String {
    if k.is_multiple_of(3) {
        json!({"type": "progress", "data": format!("edistys {k}")}).to_string()
    } else {
        json!({"type": "user", "timestamp": "2026-10-20T00:00:00.000Z", "extra": k,
            "message": {"role": "user", "content": format!("viesti {k}")}})
        .to_string()
    }
}

/// Kirjoittaa solmuun tiedoston yksiköt annetuilla HLC-ajoilla ja riveillä (offsetit kuten adapterilla).
fn tayta_rivit(a: &Tila, yksikot: &[(u64, Vec<String>)]) {
    let mut offset = 0u64;
    for (ms, rivit) in yksikot {
        let y = Yksikko {
            polku: "peili".to_string(),
            id: format!("{TIEDOSTO}:{offset}"),
            versio: BTreeMap::from([("a".to_string(), 1)]),
            aika: Hlc {
                ms: *ms,
                laskuri: 0,
                laite: "a".to_string(),
            },
            sisalto: Some(serde_json::to_vec(rivit).unwrap()),
            poistettu: false,
        };
        api::kirjoita_yhdistajalla(a, &y, scopes_ydin::yksikko::yhdistaja_polulle("peili"))
            .unwrap();
        offset += rivit.iter().map(|r| r.len() as u64 + 1).sum::<u64>();
    }
}

/// Yksiköt riveittäin `rivi(k)`: annetut (aika, rivejä); palauttaa kaikki rivit järjestyksessä.
fn tayta(a: &Tila, yksikot: &[(u64, usize)]) -> Vec<String> {
    let mut k = 1usize;
    let mut kaikki = Vec::new();
    let mut ulos = Vec::new();
    for (ms, n) in yksikot {
        let rivit: Vec<String> = (k..k + n).map(rivi).collect();
        k += n;
        kaikki.extend(rivit.clone());
        ulos.push((*ms, rivit));
    }
    tayta_rivit(a, &ulos);
    kaikki
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

fn raaka_url(p: &Palvelin, kysely: &str) -> String {
    p.url(&format!("/api/peili/{TIEDOSTO}/raaka{kysely}"))
}

fn nyt() -> u64 {
    api::kello_ms()
}

fn tekstit(r: &Value) -> Vec<String> {
    r["rivit"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

// ---- testit ------------------------------------------------------------------------------------------------------

/// (a) täysi solmu: rivit yksikkörajan yli oikeassa järjestyksessä, lopun yli lyhyempi lista, virheet.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn taysi_solmu_palauttaa_alkuperaiset_rivit() {
    let a = solmu("a", None, &[]);
    let pa = kaynnista(a.tila.clone());
    // Kolme yksikköä: rivit 1-3, 4-7, 8-12.
    let kaikki = tayta(&a.tila, &[(nyt(), 3), (nyt(), 4), (nyt(), 5)]);
    assert_eq!(kaikki.len(), 12);

    // Rajan yli: rivit 3-5 (yksiköt 1 ja 2), 6-9 (yksiköt 2 ja 3).
    let (koodi, r) = get(&raaka_url(&pa, "?rivi=3&maara=3")).await;
    assert_eq!(koodi, 200, "{r}");
    assert_eq!(r["rivi"], 3);
    assert_eq!(tekstit(&r), kaikki[2..5]);
    assert_eq!(r["seuraava"], 6);
    let (_, r) = get(&raaka_url(&pa, "?rivi=6&maara=4")).await;
    assert_eq!(tekstit(&r), kaikki[5..9]);
    assert_eq!(r["seuraava"], 10);
    // Rivit ovat riisumattomia (extra-kenttä ja ei-viestirivin data säilyvät).
    assert!(tekstit(&r)[1].contains("\"extra\""));
    assert!(tekstit(&r)[0].contains("edistys 6"));

    // Tiedoston lopun yli: lyhyempi lista ja seuraava null; täsmälleen loppuun: sama.
    let (_, r) = get(&raaka_url(&pa, "?rivi=10&maara=10")).await;
    assert_eq!(tekstit(&r), kaikki[9..12]);
    assert_eq!(r["seuraava"], Value::Null);
    let (_, r) = get(&raaka_url(&pa, "?rivi=10&maara=3")).await;
    assert_eq!(tekstit(&r), kaikki[9..12]);
    assert_eq!(r["seuraava"], Value::Null);
    // Koko tiedosto oletusmäärällä (50) ja alku.
    let (_, r) = get(&raaka_url(&pa, "?rivi=1")).await;
    assert_eq!(tekstit(&r), kaikki);
    assert_eq!(r["seuraava"], Value::Null);
    let (_, r) = get(&raaka_url(&pa, "?rivi=1&maara=1")).await;
    assert_eq!(tekstit(&r), kaikki[..1]);
    assert_eq!(r["seuraava"], 2);
    // Rivi tiedoston lopun jälkeen: tyhjä lista.
    let (koodi, r) = get(&raaka_url(&pa, "?rivi=13&maara=5")).await;
    assert_eq!(koodi, 200);
    assert!(tekstit(&r).is_empty());
    assert_eq!(r["seuraava"], Value::Null);

    // Tuntematon tiedosto 404; maara 0 ja 201 sekä puuttuva rivi 400; maara 200 sallittu.
    let (koodi, _) = get(&pa.url("/api/peili/tuntematon.jsonl/raaka?rivi=1&maara=3")).await;
    assert_eq!(koodi, 404);
    for kysely in [
        "?rivi=1&maara=0",
        "?rivi=1&maara=201",
        "?maara=3",
        "?rivi=0",
    ] {
        let (koodi, _) = get(&raaka_url(&pa, kysely)).await;
        assert_eq!(koodi, 400, "{kysely}");
    }
    let (koodi, _) = get(&raaka_url(&pa, "?rivi=1&maara=200")).await;
    assert_eq!(koodi, 200);
    // S-9d ennallaan.
    let (koodi, r) = get(&pa.url(&format!("/api/peili/{TIEDOSTO}/rivi?offset=0"))).await;
    assert_eq!(koodi, 200);
    assert_eq!(r, json!({"offset": 0, "rivi": 0}));
}

/// (b) 8 Mt:n raja: rivi > 8 Mt palautetaan yksin, `seuraava` osoittaa seuraavaan.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kahdeksan_megan_raja_katkaisee_vastauksen() {
    let a = solmu("a", None, &[]);
    let pa = kaynnista(a.tila.clone());
    let iso = format!("{{\"type\":\"user\",\"x\":\"{}\"}}", "x".repeat(8_500_000));
    let pieni = |k: usize| rivi(k);
    // Yksikkö 1: pieni, iso; yksikkö 2: pieni, pieni.
    tayta_rivit(
        &a.tila,
        &[
            (nyt(), vec![pieni(1), iso.clone()]),
            (nyt(), vec![pieni(3), pieni(4)]),
        ],
    );

    // Iso ei mahdu pienen perään: vain ensimmäinen, seuraava osoittaa isoon.
    let (koodi, r) = get(&raaka_url(&pa, "?rivi=1&maara=4")).await;
    assert_eq!(koodi, 200);
    assert_eq!(tekstit(&r), vec![pieni(1)]);
    assert_eq!(r["seuraava"], 2);
    // Iso yksin (vähintään yksi rivi), seuraava osoittaa seuraavaan.
    let (_, r) = get(&raaka_url(&pa, "?rivi=2&maara=4")).await;
    assert_eq!(tekstit(&r), vec![iso.clone()]);
    assert_eq!(r["seuraava"], 3);
    // Jatko: loput rivit.
    let (_, r) = get(&raaka_url(&pa, "?rivi=3&maara=4")).await;
    assert_eq!(tekstit(&r), vec![pieni(3), pieni(4)]);
    assert_eq!(r["seuraava"], Value::Null);
    // maara päättää ennen rajaa: ei ylimääräistä katkaisua.
    let (_, r) = get(&raaka_url(&pa, "?rivi=2&maara=1")).await;
    assert_eq!(tekstit(&r), vec![iso]);
    assert_eq!(r["seuraava"], 3);
}

fn b_peili(b: &Tila) -> Vec<(String, Option<Vec<u8>>)> {
    let mut ids: Vec<String> = b
        .varasto
        .listaa_otsakkeet("peili")
        .unwrap()
        .into_iter()
        .map(|y| y.id)
        .collect();
    ids.sort();
    ids.into_iter()
        .map(|id| {
            let s = b.varasto.lue("peili", &id).unwrap().unwrap().sisalto;
            (id, s)
        })
        .collect()
}

/// (c) A täysi, B ikkunoitu: B:n `/raaka` = A:n `/raaka`; B:n koko ja peili-yksiköt samat ennen ja jälkeen.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ikkunoitu_valittaa_taydelle_tallentamatta() {
    let a = solmu("a", None, &[]);
    let pa = kaynnista(a.tila.clone());
    let vanha = nyt() - 10 * PAIVA_MS;
    let uusi = nyt() - 3_600_000;
    let kaikki = tayta(&a.tila, &[(vanha, 6), (vanha, 6), (uusi, 6), (uusi, 6)]);
    let b = solmu("b", Some(IKKUNA), &[&pa]);
    replikointi::tasaa_kerran(&b.tila, &pa.vertainen())
        .await
        .unwrap();
    let pb = kaynnista(b.tila.clone());

    let peili_ennen = b_peili(&b.tila);
    assert_eq!(peili_ennen.len(), 2, "B:ssä vain ikkunan yksiköt");
    let (koodi, koko_ennen) = get(&pb.url("/api/peili/koko")).await;
    assert_eq!(koodi, 200);

    for kysely in [
        "?rivi=1&maara=5",
        "?rivi=5&maara=4",
        "?rivi=11&maara=10",
        "?rivi=20&maara=10",
        "?rivi=22&maara=10",
    ] {
        let (ka, ra) = get(&raaka_url(&pa, kysely)).await;
        let (kb, rb) = get(&raaka_url(&pb, kysely)).await;
        assert_eq!((kb, &rb), (ka, &ra), "{kysely}");
    }
    // Ikkunan ulkopuolinen rivi on A:n alkuperäinen, ei B:n riisuttu.
    let (_, rb) = get(&raaka_url(&pb, "?rivi=1&maara=5")).await;
    assert_eq!(tekstit(&rb), kaikki[..5]);
    // Virhevastaukset ja 404 menevät sellaisenaan.
    let (kb, _) = get(&raaka_url(&pb, "?rivi=1&maara=201")).await;
    assert_eq!(kb, 400);
    let (kb, _) = get(&pb.url("/api/peili/tuntematon.jsonl/raaka?rivi=1")).await;
    assert_eq!(kb, 404);

    let (_, koko_jalkeen) = get(&pb.url("/api/peili/koko")).await;
    assert_eq!(koko_jalkeen, koko_ennen);
    assert_eq!(
        b_peili(&b.tila),
        peili_ennen,
        "välitys ei kirjoita varastoon"
    );
    assert_eq!(
        b.tila.varasto.listaa_otsakkeet("peili").unwrap().len(),
        2,
        "B:ssä ei tallennettu yksiköitä"
    );
}

/// (d) A pysäytetty → B vastaa 503 `{"haettavissa":true}`; ei vertaisia → sama.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn vertainen_poissa_antaa_503() {
    let a = solmu("a", None, &[]);
    let pa = kaynnista(a.tila.clone());
    tayta(&a.tila, &[(nyt(), 6)]);
    let b = solmu("b", Some(IKKUNA), &[&pa]);
    let pb = kaynnista(b.tila.clone());
    let (koodi, r) = get(&raaka_url(&pb, "?rivi=1&maara=3")).await;
    assert_eq!(koodi, 200, "{r}");
    assert_eq!(tekstit(&r).len(), 3);

    drop(pa);
    let (koodi, r) = get(&raaka_url(&pb, "?rivi=1&maara=3")).await;
    assert_eq!(koodi, 503);
    assert_eq!(r, json!({"haettavissa": true}));

    let c = solmu("c", Some(IKKUNA), &[]);
    let pc = kaynnista(c.tila.clone());
    let (koodi, r) = get(&raaka_url(&pc, "?rivi=1")).await;
    assert_eq!(koodi, 503);
    assert_eq!(r, json!({"haettavissa": true}));
}
