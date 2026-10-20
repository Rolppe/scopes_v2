//! T-61 (S-5, S-9b): sisäiset polut ("peili-offset", "peili-karsinta", "peili-pohja") eivät näy
//! `/api/virta`:ssa since-toistossa eivätkä elävässä virrassa; muiden polkujen tapahtumat ennallaan.
//! Palvelin satunnaisessa portissa (`127.0.0.1:0`).

use scopes_ydin::api::{self, kello_ms, Tila};
use scopes_ydin::peili::{self, PeiliIkkuna};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yhdistaja, Yksikko};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-virta-sisainen";
const PAIVA_MS: u64 = 86_400_000;
const T: &str = "istunto-a.jsonl";
/// Virrassa ei saa näkyä mikään näistä.
const SISAISET: [&str; 3] = ["peili-offset", peili::KARSINTA_POLKU, peili::POHJA_POLKU];

struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("virta-sisainen-{}-{n}.db", std::process::id())))
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
    osoite: String,
}

impl Solmu {
    async fn kaynnista(ikkuna_vrk: Option<u32>, katto_mt: u32) -> Solmu {
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
            peili: PeiliIkkuna::uusi(ikkuna_vrk, katto_mt),
        });
        let app = api::router_valilla(tila.clone(), Duration::from_millis(100));
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        Solmu {
            _tmp: tmp,
            tila,
            osoite,
        }
    }

    async fn avaa_virta(&self, polku: &str) -> reqwest::Response {
        let v = reqwest::Client::new()
            .get(format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200);
        v
    }

    /// Kirjoittaa tavallisen yksikön broadcastin kanssa: herättää virran ja merkitsee luvun lopun.
    async fn kirjoita_tavallinen(&self, id: &str, laskuri: u64) -> u64 {
        let y = Yksikko {
            polku: "skoopit".to_string(),
            id: id.to_string(),
            versio: BTreeMap::from([("koe".to_string(), laskuri)]),
            aika: Hlc::nyt("koe", None, kello_ms()),
            sisalto: None,
            poistettu: false,
        };
        api::kirjoita_ja_ilmoita(&self.tila, &y)
            .await
            .unwrap()
            .unwrap()
    }

    /// Sisäinen yksikkö suoraan varastoon (kuten peili.rs kirjoittaa ne): lokiin, ei broadcastia.
    fn kirjoita_sisainen(&self, polku: &str, id: &str, sisalto: Value) {
        let y = Yksikko {
            polku: polku.to_string(),
            id: id.to_string(),
            versio: BTreeMap::from([("koe".to_string(), 1)]),
            aika: Hlc::nyt("koe", None, kello_ms()),
            sisalto: Some(serde_json::to_vec(&sisalto).unwrap()),
            poistettu: false,
        };
        self.tila.varasto.kirjoita(&y, Yhdistaja::Lww).unwrap();
    }

    fn kirjoita_peili(&self, alku: u64, rivit: &[String], ms: u64) {
        let y = Yksikko {
            polku: peili::POLKU.to_string(),
            id: format!("{T}:{alku}"),
            versio: BTreeMap::from([("koe".to_string(), 1)]),
            aika: Hlc::nyt("koe", None, ms),
            sisalto: Some(serde_json::to_vec(rivit).unwrap()),
            poistettu: false,
        };
        self.tila.varasto.kirjoita(&y, Yhdistaja::Lisays).unwrap();
    }

    /// Lokin (seq, polku, id) -kolmikot.
    fn loki(&self) -> Vec<(u64, String, String)> {
        self.tila
            .varasto
            .loki(0, 10_000)
            .unwrap()
            .into_iter()
            .map(|t| (t.seq, t.polku, t.id))
            .collect()
    }
}

/// Lukee virtaa, kunnes `muutos`-tapahtuma polulta "skoopit" ja id:llä `loppu` on tullut; palauttaa
/// kaikkien `muutos`-tapahtumien (seq, polku, id).
async fn lue_loppuun(v: &mut reqwest::Response, loppu: &str) -> Vec<(u64, String, String)> {
    let mut puskuri = String::new();
    let raja = tokio::time::Instant::now() + Duration::from_secs(10);
    let merkki = format!("\"id\":\"{loppu}\"");
    while !puskuri.contains(&merkki) || !puskuri.ends_with("\n\n") {
        let pala = tokio::time::timeout_at(raja, v.chunk())
            .await
            .unwrap_or_else(|_| panic!("aikaraja; saatu tähän asti: {puskuri:?}"))
            .unwrap()
            .expect("virta päättyi");
        puskuri.push_str(std::str::from_utf8(&pala).unwrap());
    }
    puskuri
        .lines()
        .filter_map(|r| r.strip_prefix("data: "))
        .filter_map(|d| serde_json::from_str::<Value>(d).ok())
        .filter(|d| d.get("polku").is_some())
        .map(|d| {
            (
                d["seq"].as_u64().unwrap(),
                d["polku"].as_str().unwrap().to_string(),
                d["id"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn ei_sisaisia(tapahtumat: &[(u64, String, String)]) {
    for (seq, polku, id) in tapahtumat {
        assert!(
            !SISAISET.contains(&polku.as_str()),
            "sisäinen tapahtuma virrassa: seq {seq} {polku}/{id}"
        );
    }
}

fn lokissa(loki: &[(u64, String, String)], polku: &str) -> bool {
    loki.iter().any(|(_, p, _)| p == polku)
}

/// Ikkunoitu solmu, katto 1 Mt: kaksi ~600 kt:n peili-yksikköä eri vuorokausilta; karsinta poistaa
/// vanhemman ja nostaa karsintarajan (lokiin "peili-karsinta").
fn karsittava(s: &Solmu, alku: u64) {
    let nyt = kello_ms();
    let isku = vec!["x".repeat(600_000)];
    s.kirjoita_peili(alku, &isku, nyt - 1000);
    s.kirjoita_peili(alku + 1, &isku, nyt - 2 * PAIVA_MS - 1000);
    let k = peili::karsi(&s.tila).unwrap();
    assert_eq!(k.poistetut, 1, "{k:?}");
}

#[tokio::test]
async fn since_toisto_ohittaa_karsinnan_ja_offsetin() {
    let s = Solmu::kaynnista(Some(30), 1).await;
    s.kirjoita_sisainen("peili-offset", T, json!({"offset": 10}));
    karsittava(&s, 0);
    let loki = s.loki();
    assert!(lokissa(&loki, peili::KARSINTA_POLKU), "{loki:?}");
    assert!(lokissa(&loki, "peili-offset"), "{loki:?}");
    s.kirjoita_tavallinen("loppu", 1).await;

    let mut v = s.avaa_virta("/api/virta?since=0").await;
    let tapahtumat = lue_loppuun(&mut v, "loppu").await;
    ei_sisaisia(&tapahtumat);
    assert!(
        tapahtumat.iter().any(|(_, p, _)| p == peili::POLKU),
        "peili-tapahtumat puuttuvat: {tapahtumat:?}"
    );
}

#[tokio::test]
async fn elava_virta_ohittaa_uuden_karsinnan() {
    let s = Solmu::kaynnista(Some(30), 1).await;
    s.kirjoita_tavallinen("alku", 1).await;
    let mut v = s.avaa_virta("/api/virta").await;
    let ennen = s.tila.varasto.seq().unwrap();
    karsittava(&s, 0);
    let uudet: Vec<_> = s
        .loki()
        .into_iter()
        .filter(|(q, _, _)| *q > ennen)
        .collect();
    assert!(lokissa(&uudet, peili::KARSINTA_POLKU), "{uudet:?}");
    s.kirjoita_tavallinen("loppu", 2).await;

    let tapahtumat = lue_loppuun(&mut v, "loppu").await;
    ei_sisaisia(&tapahtumat);
    assert!(
        tapahtumat.iter().any(|(_, p, _)| p == peili::POLKU),
        "peili-tapahtumat puuttuvat: {tapahtumat:?}"
    );
}

#[tokio::test]
async fn taysi_solmu_muut_tapahtumat_ennallaan() {
    let s = Solmu::kaynnista(None, 38).await;
    let nyt = kello_ms();
    s.kirjoita_tavallinen("a", 1).await;
    s.kirjoita_peili(0, &["{}".to_string()], nyt - 9 * PAIVA_MS);
    s.kirjoita_sisainen("peili-offset", T, json!({"offset": 2}));
    s.kirjoita_peili(2, &["{}".to_string()], nyt);
    s.kirjoita_tavallinen("b", 2).await;
    // Täysi solmu ei karsi eikä kirjoita karsintarajaa.
    assert_eq!(peili::karsi(&s.tila).unwrap().poistetut, 0);
    s.kirjoita_tavallinen("loppu", 3).await;

    let odotettu: Vec<_> = s
        .loki()
        .into_iter()
        .filter(|(_, p, _)| !SISAISET.contains(&p.as_str()))
        .collect();
    let mut v = s.avaa_virta("/api/virta?since=0").await;
    let tapahtumat = lue_loppuun(&mut v, "loppu").await;
    assert_eq!(tapahtumat, odotettu);
    let polut: Vec<&str> = tapahtumat.iter().map(|(_, p, _)| p.as_str()).collect();
    assert_eq!(polut, ["skoopit", "peili", "peili", "skoopit", "skoopit"]);
}

#[tokio::test]
async fn pohja_ei_nay_virrassa() {
    let s = Solmu::kaynnista(Some(30), 38).await;
    s.kirjoita_sisainen(peili::POHJA_POLKU, T, json!({"offset": 100, "rivi": 4}));
    assert!(lokissa(&s.loki(), peili::POHJA_POLKU));
    s.kirjoita_tavallinen("loppu", 1).await;

    let mut v = s.avaa_virta("/api/virta?since=0").await;
    let tapahtumat = lue_loppuun(&mut v, "loppu").await;
    ei_sisaisia(&tapahtumat);
    assert_eq!(tapahtumat.len(), 1, "{tapahtumat:?}");

    // Elävä virta: uusi pohja ei tuota tapahtumaa.
    s.kirjoita_sisainen(peili::POHJA_POLKU, T, json!({"offset": 200, "rivi": 9}));
    s.kirjoita_tavallinen("loppu2", 2).await;
    let tapahtumat = lue_loppuun(&mut v, "loppu2").await;
    ei_sisaisia(&tapahtumat);
}
