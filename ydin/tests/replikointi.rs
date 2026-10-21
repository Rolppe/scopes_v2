//! Replikointi (T-21): kaksi varastoa prosessin sisällä ja kaksi axum-palvelinta satunnaisissa porteissa.
//! Jokainen palvelin ajetaan omassa säikeessään omalla tokio-ajonaikaisympäristöllään, jotta sammutus
//! katkaisee myös avoimet virta- ja hakuyhteydet (todellinen katko).

use axum::{extract::Request, middleware::Next, response::Response};
use scopes_ydin::api::{self, Tila};
use scopes_ydin::replikointi;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::vertaiset::Vertainen;
use scopes_ydin::yksikko::{yhdistaja_polulle, yhdistaja_yksikolle, Hlc, Yksikko};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Notify};

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-replikointi";
const AIKARAJA: Duration = Duration::from_secs(90);

/// Väliaikainen tietokantatiedosto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("replikointi-{}-{n}.db", std::process::id())))
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

struct Solmu {
    _tmp: Tmp,
    tila: Arc<Tila>,
}

fn solmu(laite: &str) -> Solmu {
    let tmp = Tmp::uusi();
    let varasto = Arc::new(Varasto::avaa(&tmp.0).unwrap());
    let (lahetin, _) = tokio::sync::broadcast::channel(64);
    let tila = Arc::new(Tila {
        varasto,
        laite: laite.to_string(),
        headless: true,
        avain: AVAIN.to_string(),
        vanha: None,
        vanha_avain: None,
        vertaiset: vec![],
        lr_vertainen: None,
        adapteri: Default::default(),
        lahetin,
        peili: Default::default(),
    });
    Solmu { _tmp: tmp, tila }
}

/// Palvelin omassa säikeessään. `katko_haussa = Some(n)`: n:s `/api/hae` jää roikkumaan ja palvelin
/// sammuu kesken pyynnön.
struct Palvelin {
    portti: u16,
    seis: Option<oneshot::Sender<()>>,
    saie: Option<std::thread::JoinHandle<()>>,
}

fn kaynnista(tila: Arc<Tila>, portti: u16, katko_haussa: Option<usize>) -> Palvelin {
    let (portti_tx, portti_rx) = std::sync::mpsc::channel();
    let (seis_tx, seis_rx) = oneshot::channel::<()>();
    let saie = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let mut kuuntelija = None;
            for _ in 0..100 {
                match tokio::net::TcpListener::bind(("127.0.0.1", portti)).await {
                    Ok(k) => {
                        kuuntelija = Some(k);
                        break;
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                }
            }
            let kuuntelija = kuuntelija.expect("portin sidonta epäonnistui");
            portti_tx
                .send(kuuntelija.local_addr().unwrap().port())
                .unwrap();
            let katko = Arc::new(Notify::new());
            let mut reititin = api::router_valilla(tila, Duration::from_millis(500));
            if let Some(n) = katko_haussa {
                let k = katko.clone();
                let haut = Arc::new(AtomicUsize::new(0));
                reititin = reititin.layer(axum::middleware::from_fn(
                    move |req: Request, next: Next| {
                        let k = k.clone();
                        let haut = haut.clone();
                        async move {
                            if req.uri().path() == "/api/hae"
                                && haut.fetch_add(1, Ordering::SeqCst) + 1 == n
                            {
                                k.notify_one();
                                return std::future::pending::<Response>().await;
                            }
                            next.run(req).await
                        }
                    },
                ));
            }
            tokio::select! {
                _ = async { axum::serve(kuuntelija, reititin).await } => {}
                _ = seis_rx => {}
                _ = katko.notified() => {}
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

    /// Odottaa, että palvelin on sammunut itse (katko) ja säie päättynyt.
    async fn odota_sammumista(&mut self) {
        let alku = Instant::now();
        while !self.saie.as_ref().is_none_or(|s| s.is_finished()) {
            assert!(alku.elapsed() < AIKARAJA, "katko ei tapahtunut");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if let Some(s) = self.saie.take() {
            s.join().unwrap();
        }
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

fn yksikko(polku: &str, id: &str, laite: &str, laskuri: u64, ms: u64) -> Yksikko {
    Yksikko {
        polku: polku.to_string(),
        id: id.to_string(),
        versio: BTreeMap::from([(laite.to_string(), laskuri)]),
        aika: Hlc {
            ms,
            laskuri: 0,
            laite: laite.to_string(),
        },
        sisalto: Some(format!("{polku}/{id}@{laite}:{laskuri}").into_bytes()),
        poistettu: false,
    }
}

fn kirjoita(tila: &Tila, y: &Yksikko) {
    api::kirjoita_yhdistajalla(tila, y, yhdistaja_polulle(&y.polku)).unwrap();
}

fn kaikki(tila: &Tila) -> Vec<Yksikko> {
    tila.varasto.listaa_etuliite("").unwrap()
}

async fn odota(kuvaus: &str, ehto: impl Fn() -> bool) {
    let alku = Instant::now();
    while !ehto() {
        assert!(alku.elapsed() < AIKARAJA, "aikaraja ylittyi: {kuvaus}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tyhja_b_saa_a_n_100_yksikkoa() {
    let a = solmu("a");
    let b = solmu("b");
    for i in 0..100 {
        kirjoita(
            &a.tila,
            &yksikko("rekisterit/r1", &format!("a{i:03}"), "a", 1, 1_000 + i),
        );
    }
    let pa = kaynnista(a.tila.clone(), 0, None);
    let _pb = kaynnista(b.tila.clone(), 0, None);
    let va = pa.vertainen();
    let silmukka = tokio::spawn(replikointi::silmukka(b.tila.clone(), va.clone()));

    odota("B saa 100 yksikköä", || kaikki(&b.tila).len() == 100).await;
    assert_eq!(kaikki(&a.tila), kaikki(&b.tila));
    assert_eq!(
        a.tila.varasto.tiiviste("rekisterit/r1").unwrap(),
        b.tila.varasto.tiiviste("rekisterit/r1").unwrap()
    );
    let seq_a = a.tila.varasto.seq().unwrap();
    odota("kursori A:n seq:iin", || {
        b.tila.varasto.kursori(&va.id).unwrap() == seq_a
    })
    .await;
    // A ei saanut mitään takaisin.
    assert_eq!(a.tila.varasto.seq().unwrap(), 100);

    // Elävä muutos kulkee virran kautta ja kursori seuraa.
    kirjoita(&a.tila, &yksikko("tila/t", "x", "a", 1, 5_000));
    odota("virran muutos B:lle", || {
        b.tila.varasto.lue("tila/t", "x").unwrap().is_some()
    })
    .await;
    odota("kursori 101", || {
        b.tila.varasto.kursori(&va.id).unwrap() == 101
    })
    .await;
    silmukka.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn molempien_muutokset_konvergoivat() {
    let a = solmu("a");
    let b = solmu("b");
    for i in 0..50 {
        kirjoita(
            &a.tila,
            &yksikko("rekisterit/r1", &format!("a{i:02}"), "a", 1, 1_000),
        );
        kirjoita(
            &b.tila,
            &yksikko("rekisterit/r1", &format!("b{i:02}"), "b", 1, 1_000),
        );
    }
    // Sama tunnus molemmilla (LWW): myöhempi HLC (B) voittaa.
    kirjoita(&a.tila, &yksikko("tila/t", "x", "a", 1, 2_000));
    kirjoita(&b.tila, &yksikko("tila/t", "x", "b", 1, 3_000));
    kirjoita(&a.tila, &yksikko("tila/vain-a", "y", "a", 1, 2_000));
    kirjoita(&b.tila, &yksikko("lahde/vain-b", "z", "b", 1, 2_000));

    let pa = kaynnista(a.tila.clone(), 0, None);
    let pb = kaynnista(b.tila.clone(), 0, None);
    let sa = tokio::spawn(replikointi::silmukka(a.tila.clone(), pb.vertainen()));
    let sb = tokio::spawn(replikointi::silmukka(b.tila.clone(), pa.vertainen()));

    let sama = || {
        let (ya, yb) = (kaikki(&a.tila), kaikki(&b.tila));
        ya.len() == 103 && ya == yb
    };
    odota("ensisynkka konvergoi", sama).await;
    let x = a.tila.varasto.lue("tila/t", "x").unwrap().unwrap();
    assert_eq!(x.aika.laite, "b");
    assert_eq!(
        replikointi::tiivisteet(&a.tila).unwrap().1,
        replikointi::tiivisteet(&b.tila).unwrap().1
    );

    // Elävät muutokset molemmilla puolilla virtojen kautta.
    kirjoita(&a.tila, &yksikko("tila/t", "x", "a", 2, 9_000));
    kirjoita(&b.tila, &yksikko("rekisterit/r1", "b-uusi", "b", 1, 9_000));
    kirjoita(&a.tila, &yksikko("rekisterit/r2", "a-uusi", "a", 1, 9_000));
    let sama_elava = || {
        let (ya, yb) = (kaikki(&a.tila), kaikki(&b.tila));
        ya.len() == 105 && ya == yb
    };
    odota("elävät muutokset konvergoivat", sama_elava).await;
    let x = b.tila.varasto.lue("tila/t", "x").unwrap().unwrap();
    assert_eq!(x.aika.ms, 9_000);
    sa.abort();
    sb.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn katko_erien_valissa_toipuu_eika_kursori_taannu() {
    let a = solmu("a");
    let b = solmu("b");
    for i in 0..1000 {
        kirjoita(
            &a.tila,
            &yksikko("rekisterit/r1", &format!("a{i:04}"), "a", 1, 1_000),
        );
    }
    // Vaihe 1: ensisynkan toinen erä katkeaa (palvelin sammuu kesken haun).
    let mut pa = kaynnista(a.tila.clone(), 0, Some(2));
    let portti = pa.portti;
    let _pb = kaynnista(b.tila.clone(), 0, None);
    let va = pa.vertainen();

    // Kursorin näytteenotto: arvo ei saa koskaan pienentyä.
    let taantui = Arc::new(AtomicBool::new(false));
    let suurin = Arc::new(AtomicU64::new(0));
    let naytteet = {
        let (tila, id, taantui, suurin) = (
            b.tila.clone(),
            va.id.clone(),
            taantui.clone(),
            suurin.clone(),
        );
        tokio::spawn(async move {
            loop {
                let k = tila.varasto.kursori(&id).unwrap();
                if k < suurin.fetch_max(k, Ordering::SeqCst) {
                    taantui.store(true, Ordering::SeqCst);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
    };

    let silmukka = tokio::spawn(replikointi::silmukka(b.tila.clone(), va.clone()));
    pa.odota_sammumista().await;
    assert_eq!(kaikki(&b.tila).len(), 300, "ensimmäinen erä ennen katkoa");
    assert_eq!(b.tila.varasto.kursori(&va.id).unwrap(), 0);
    drop(pa);

    // Uudelleenkäynnistys samaan porttiin. Tasaus hakee loput 700 (3 hakua); virran toinen erä
    // (5. haku) katkeaa vaiheessa 2.
    let mut pa = kaynnista(a.tila.clone(), portti, Some(5));
    odota("vaihe 1 konvergoi", || kaikki(&b.tila) == kaikki(&a.tila)).await;
    odota("kursori 1000", || {
        b.tila.varasto.kursori(&va.id).unwrap() == 1000
    })
    .await;

    // Vaihe 2: 700 uutta yksikköä virran kautta; toinen virtaerä katkeaa.
    for i in 1000..1700 {
        kirjoita(
            &a.tila,
            &yksikko("rekisterit/r1", &format!("a{i:04}"), "a", 1, 1_000),
        );
    }
    pa.odota_sammumista().await;
    let k_katko = b.tila.varasto.kursori(&va.id).unwrap();
    assert!(
        k_katko > 1000 && k_katko < 1700,
        "katkon hetken kursori {k_katko}: ensimmäinen virtaerä talletettu, loput ei"
    );
    drop(pa);

    let _pa = kaynnista(a.tila.clone(), portti, None);
    odota("vaihe 2 konvergoi", || kaikki(&b.tila) == kaikki(&a.tila)).await;
    odota("kursori 1700", || {
        b.tila.varasto.kursori(&va.id).unwrap() == 1700
    })
    .await;
    assert_eq!(kaikki(&b.tila).len(), 1700);
    assert!(b.tila.varasto.kursori(&va.id).unwrap() >= k_katko);
    silmukka.abort();
    naytteet.abort();
    assert!(!taantui.load(Ordering::SeqCst), "kursori taantui");
}

/// Yksikkö annetulla versiovektorilla ja HLC:n laitteella.
fn versioitu(polku: &str, id: &str, versio: &[(&str, u64)], laite: &str, ms: u64) -> Yksikko {
    Yksikko {
        versio: versio.iter().map(|(l, n)| (l.to_string(), *n)).collect(),
        aika: Hlc {
            ms,
            laskuri: 0,
            laite: laite.to_string(),
        },
        sisalto: Some(format!("{polku}/{id}@{laite}:{ms}").into_bytes()),
        ..yksikko(polku, id, laite, 1, ms)
    }
}

/// R-1: `rekisterit-meta/<p>` yhdistetään Lww:llä, joten uudempi meta korvaa vanhan replikoinnissa
/// (Lisays jättäisi B:lle vanhan). R-2: `rekisterit/<p>`:n sisarusyksikkö `<id>~<laite>` yhdistetään
/// Lww:llä, joten rinnakkaiset sisarversiot konvergoituvat eikä sisaruksen sisaruksia synny.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rekisterit_meta_lww_korvaa_vanhan() {
    let a = solmu("a");
    let b = solmu("b");
    let meta = "rekisterit-meta/r1";
    assert_eq!(
        yhdistaja_polulle(meta),
        scopes_ydin::yksikko::Yhdistaja::Lww
    );
    // Meta: A:lla uudempi versio ja HLC.
    kirjoita(&a.tila, &versioitu(meta, "meta", &[("a", 2)], "a", 2_000));
    kirjoita(&b.tila, &versioitu(meta, "meta", &[("a", 1)], "a", 1_000));
    // Rivin lisäkentät: rinnakkaiset versiot, A:n HLC suurempi → A voittaa molemmilla.
    kirjoita(&a.tila, &versioitu(meta, "x", &[("a", 2)], "a", 2_000));
    kirjoita(&b.tila, &versioitu(meta, "x", &[("b", 1)], "b", 1_500));
    // Rivit ja sisarukset (lr.rs kirjoittaa sisaruksen Lww:llä).
    let r = "rekisterit/r1";
    for s in [&a, &b] {
        kirjoita(&s.tila, &versioitu(r, "x", &[("a", 1)], "a", 1_000));
        api::kirjoita_yhdistajalla(
            &s.tila,
            &versioitu(r, "y~c", &[("c", 1)], "c", 1_000),
            scopes_ydin::yksikko::Yhdistaja::Lww,
        )
        .unwrap();
    }
    api::kirjoita_yhdistajalla(
        &a.tila,
        &versioitu(r, "x~c", &[("a", 1), ("c", 1)], "a", 1_100),
        scopes_ydin::yksikko::Yhdistaja::Lww,
    )
    .unwrap();
    api::kirjoita_yhdistajalla(
        &b.tila,
        &versioitu(r, "x~c", &[("c", 2)], "b", 1_200),
        scopes_ydin::yksikko::Yhdistaja::Lww,
    )
    .unwrap();
    let uusi_meta = a.tila.varasto.lue(meta, "meta").unwrap().unwrap();
    let uusi_x = a.tila.varasto.lue(meta, "x").unwrap().unwrap();

    let pa = kaynnista(a.tila.clone(), 0, None);
    let pb = kaynnista(b.tila.clone(), 0, None);
    let sa = tokio::spawn(replikointi::silmukka(a.tila.clone(), pb.vertainen()));
    let sb = tokio::spawn(replikointi::silmukka(b.tila.clone(), pa.vertainen()));

    odota("B:n meta korvautuu A:n uudemmalla", || {
        b.tila.varasto.lue(meta, "meta").unwrap().as_ref() == Some(&uusi_meta)
            && b.tila.varasto.lue(meta, "x").unwrap().as_ref() == Some(&uusi_x)
    })
    .await;
    assert_eq!(
        a.tila.varasto.lue(meta, "meta").unwrap().as_ref(),
        Some(&uusi_meta)
    );
    assert_eq!(
        a.tila.varasto.lue(meta, "x").unwrap().as_ref(),
        Some(&uusi_x)
    );
    assert_eq!(b.tila.varasto.listaa(meta).unwrap().len(), 2);

    // R-2: sisarusyksikkö yhdistetään Lww:llä → rinnakkaiset `x~c`-versiot konvergoituvat samaan
    // yksikköön (B:n HLC 1_200 voittaa), eikä `x~c~<laite>`-yksiköitä synny.
    let odotettu_x = b.tila.varasto.lue(r, "x~c").unwrap().unwrap();
    assert_eq!(odotettu_x.versio, BTreeMap::from([("c".to_string(), 2)]));
    odota("rinnakkaiset sisarversiot x~c konvergoituvat", || {
        a.tila.varasto.lue(r, "x~c").unwrap().as_ref() == Some(&odotettu_x)
            && b.tila.varasto.lue(r, "x~c").unwrap().as_ref() == Some(&odotettu_x)
    })
    .await;
    // Annetaan replikoinnin käydä vielä läpi, ettei sisaruksen sisaruksia ilmaannu myöhemmin.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    for s in [&a, &b] {
        let idt: Vec<String> = s
            .tila
            .varasto
            .listaa(r)
            .unwrap()
            .into_iter()
            .map(|y| y.id)
            .collect();
        assert!(
            !idt.iter()
                .any(|i| i.starts_with("x~c~") || i.starts_with("y~c~")),
            "sisarukselle ei synny sisaruksia: {idt:?}"
        );
        assert_eq!(
            s.tila.varasto.lue(r, "x~c").unwrap().as_ref(),
            Some(&odotettu_x)
        );
    }
    sa.abort();
    sb.abort();
}

/// R-2: kahden solmun rinnakkaiset rivit tuottavat sisarukset `r-1~a` ja `r-1~b`; sisarus päivittyy
/// molemmilla solmuilla rinnakkain, ja silmukan jälkeen rekisterin polku on sama (lista ja tiiviste).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rekisterin_sisarukset_konvergoituvat_rinnakkaisella_paivityksella() {
    let a = solmu("a");
    let b = solmu("b");
    let r = "rekisterit/r2";
    let kirjoita_y = |s: &Solmu, y: &Yksikko| {
        api::kirjoita_yhdistajalla(&s.tila, y, yhdistaja_yksikolle(y)).unwrap();
    };
    // Rinnakkaiset rivit.
    kirjoita_y(&a, &versioitu(r, "r-1", &[("a", 1)], "a", 1_000));
    kirjoita_y(&b, &versioitu(r, "r-1", &[("b", 1)], "b", 1_100));

    let pa = kaynnista(a.tila.clone(), 0, None);
    let pb = kaynnista(b.tila.clone(), 0, None);
    let sa = tokio::spawn(replikointi::silmukka(a.tila.clone(), pb.vertainen()));
    let sb = tokio::spawn(replikointi::silmukka(b.tila.clone(), pa.vertainen()));

    // Sisarukset r-1~a ja r-1~b molemmilla (Lr tuottaa ne, sisarukset replikoituvat Lww:llä).
    odota("sisarukset r-1~a ja r-1~b molemmilla", || {
        [&a, &b].iter().all(|s| {
            s.tila.varasto.lue(r, "r-1~a").unwrap().is_some()
                && s.tila.varasto.lue(r, "r-1~b").unwrap().is_some()
        })
    })
    .await;
    // Sisarus r-1~a päivittyy molemmilla solmuilla rinnakkain (rinnakkaiset versiot, B:n HLC suurempi).
    kirjoita_y(&a, &versioitu(r, "r-1~a", &[("a", 2)], "a", 3_000));
    kirjoita_y(
        &b,
        &versioitu(r, "r-1~a", &[("a", 1), ("b", 1)], "b", 3_500),
    );
    let voittaja = b.tila.varasto.lue(r, "r-1~a").unwrap().unwrap();
    // Rivi ratkaistaan: A kirjoittaa kummankin ohittavan version, joka replikoituu B:lle uudempana.
    kirjoita_y(&a, &versioitu(r, "r-1", &[("a", 2), ("b", 1)], "a", 4_000));
    let ratkaistu = a.tila.varasto.lue(r, "r-1").unwrap().unwrap();

    odota("rekisterin polku konvergoituu", || {
        [&a, &b].iter().all(|s| {
            s.tila.varasto.lue(r, "r-1~a").unwrap().as_ref() == Some(&voittaja)
                && s.tila.varasto.lue(r, "r-1").unwrap().as_ref() == Some(&ratkaistu)
        })
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let lista_a = a.tila.varasto.listaa(r).unwrap();
    let idt: Vec<&str> = lista_a.iter().map(|y| y.id.as_str()).collect();
    assert_eq!(idt, ["r-1", "r-1~a", "r-1~b"], "ei sisaruksen sisaruksia");
    assert_eq!(lista_a, b.tila.varasto.listaa(r).unwrap());
    assert_eq!(
        a.tila.varasto.tiiviste(r).unwrap(),
        b.tila.varasto.tiiviste(r).unwrap()
    );
    sa.abort();
    sb.abort();
}

/// 3 Mt:n peiliyksikkö (HAE_TAVUT 8 Mt → kaksi mahtuu vastaukseen).
fn iso(id: &str, ms: u64) -> Yksikko {
    Yksikko {
        sisalto: Some(vec![b'x'; 3 * 1024 * 1024]),
        ..yksikko("peili", id, "a", 1, ms)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hae_tavubudjetti_jatko_ja_replikointi_konvergoi() {
    let a = solmu("a");
    let b = solmu("b");
    let idt: Vec<String> = (0..5).map(|i| format!("f:{i}")).collect();
    for (i, id) in idt.iter().enumerate() {
        kirjoita(&a.tila, &iso(id, 1_000 + i as u64));
    }
    const _: () = assert!(2 * 3 * 1024 * 1024 <= replikointi::HAE_TAVUT);
    const _: () = assert!(3 * 3 * 1024 * 1024 > replikointi::HAE_TAVUT);
    let pa = kaynnista(a.tila.clone(), 0, None);
    let _pb = kaynnista(b.tila.clone(), 0, None);

    // Suora haku: kaksi yksikköä ja jatko kolmelle; jatkon haku palauttaa seuraavat.
    let http = reqwest::Client::new();
    let hae = |idt: Vec<String>| {
        let http = http.clone();
        let url = format!("http://127.0.0.1:{}/api/hae", pa.portti);
        async move {
            http.post(url)
                .bearer_auth(AVAIN)
                .json(&serde_json::json!({"polku": "peili", "idt": idt}))
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap()
        }
    };
    let r = hae(idt.clone()).await;
    let saadut: Vec<&str> = r["yksikot"]
        .as_array()
        .unwrap()
        .iter()
        .map(|y| y["id"].as_str().unwrap())
        .collect();
    assert_eq!(saadut, vec!["f:0", "f:1"]);
    assert_eq!(r["jatko"], serde_json::json!(["f:2", "f:3", "f:4"]));
    let r = hae(vec!["f:4".to_string()]).await;
    assert_eq!(r["yksikot"].as_array().unwrap().len(), 1);
    assert!(r.get("jatko").is_none());

    // Replikointi: B hakee kaikki viisi jatkon kautta.
    let silmukka = tokio::spawn(replikointi::silmukka(b.tila.clone(), pa.vertainen()));
    odota("B saa 5 isoa peiliyksikköä", || {
        b.tila.varasto.listaa_otsakkeet("peili").unwrap().len() == 5
    })
    .await;
    assert_eq!(
        a.tila.varasto.tiiviste("peili").unwrap(),
        b.tila.varasto.tiiviste("peili").unwrap()
    );
    assert_eq!(
        a.tila.varasto.listaa("peili").unwrap(),
        b.tila.varasto.listaa("peili").unwrap()
    );
    silmukka.abort();
}
