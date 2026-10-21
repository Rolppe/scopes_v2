//! Peilin sisältöaika (T-73, S-9 "Sisältöaika"): laskenta, ikkunoidun solmun hylkäys ja vetohaku,
//! skeeman siirtymä 1 → 2, `/api/listat`-kenttä (ja vanhan vastauksen HLC-varapolku) sekä katon ja
//! iän karsinta sisältöajasta.

use axum::{
    body::Body,
    extract::Request,
    http::header,
    middleware::{self, Next},
    response::Response,
};
use rusqlite::{params, Connection};
use scopes_ydin::api::{self, kello_ms, Tila};
use scopes_ydin::peili::{self, PeiliIkkuna};
use scopes_ydin::replikointi::{self, ListaRivi};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::vertaiset::Vertainen;
use scopes_ydin::yksikko::{Hlc, Yhdistaja, Yksikko};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-sisaltoaika";
const PAIVA_MS: u64 = 86_400_000;
const T: &str = "istunto-a.jsonl";

struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("peili-sisaltoaika-{}-{n}.db", std::process::id())))
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
    async fn kaynnista(laite: &str, ikkuna_vrk: Option<u32>, katto_mt: u32, vanha: bool) -> Solmu {
        let tmp = Tmp::uusi();
        let varasto = Arc::new(Varasto::avaa(&tmp.0).unwrap());
        let (lahetin, _) = tokio::sync::broadcast::channel(64);
        let tila = Arc::new(Tila {
            varasto,
            laite: laite.to_string(),
            headless: false,
            avain: AVAIN.to_string(),
            vanha: None,
            vanha_avain: None,
            vertaiset: vec![],
            lr_vertainen: None,
            lahetin,
            peili: PeiliIkkuna::uusi(ikkuna_vrk, katto_mt),
        });
        let mut app = api::router_valilla(tila.clone(), Duration::from_millis(100));
        if vanha {
            // Vanha vertainen: `/api/listat`-vastauksessa ei ole kenttää `sisaltoaika`.
            app = app.layer(middleware::from_fn(poista_sisaltoaika));
        }
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("127.0.0.1:{}", kuuntelija.local_addr().unwrap().port());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        Solmu {
            _tmp: tmp,
            tila,
            osoite,
        }
    }

    fn vertainen(&self) -> Vertainen {
        Vertainen::osoitteesta(&self.osoite, AVAIN).unwrap()
    }

    async fn get(&self, polku: &str) -> Value {
        let v = reqwest::Client::new()
            .get(format!("http://{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status().as_u16(), 200);
        v.json().await.unwrap()
    }
}

async fn poista_sisaltoaika(req: Request, next: Next) -> Response {
    let polku = req.uri().path().to_string();
    let vastaus = next.run(req).await;
    if polku != "/api/listat" {
        return vastaus;
    }
    let (mut osat, runko) = vastaus.into_parts();
    let tavut = axum::body::to_bytes(runko, usize::MAX).await.unwrap();
    let mut v: Value = serde_json::from_slice(&tavut).unwrap();
    for r in v["yksikot"].as_array_mut().unwrap() {
        r.as_object_mut().unwrap().remove("sisaltoaika");
    }
    osat.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(osat, Body::from(v.to_string()))
}

/// RFC 3339 -aikaleima (UTC, millisekunnit) Unix-ajasta.
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

/// Käyttäjärivi, jonka `timestamp` on `ms` ja jonka koko on noin `lisa` tavua.
fn rivi(ms: u64, lisa: usize) -> String {
    json!({"type": "user", "timestamp": iso(ms), "uuid": format!("u{ms}"),
        "message": {"role": "user", "content": "x".repeat(lisa)}})
    .to_string()
}

fn sisalto(rivit: &[String]) -> Vec<u8> {
    serde_json::to_vec(rivit).unwrap()
}

/// Peiliyksikkö, jonka HLC-aika on `hlc_ms` ja jonka rivit ovat `rivit`.
fn yksikko(id: &str, hlc_ms: u64, rivit: &[String]) -> Yksikko {
    Yksikko {
        polku: "peili".to_string(),
        id: id.to_string(),
        versio: BTreeMap::from([("koe".to_string(), 1)]),
        aika: Hlc::nyt("koe", None, hlc_ms),
        sisalto: Some(sisalto(rivit)),
        poistettu: false,
    }
}

fn ajalla(id: &str, hlc_ms: u64, sisaltoaika_ms: u64) -> Yksikko {
    yksikko(id, hlc_ms, &[rivi(sisaltoaika_ms, 100)])
}

fn varastosta(s: &Solmu) -> BTreeMap<String, Option<u64>> {
    s.tila
        .varasto
        .listaa_otsakkeet_sisaltoajalla("peili")
        .unwrap()
        .into_iter()
        .map(|(y, sa)| (y.id, sa))
        .collect()
}

// ---- (a) laskenta -------------------------------------------------------------------------------------

#[test]
fn laskenta_uusin_timestamp_voittaa() {
    let rivit = vec![
        r#"{"type":"user","timestamp":"2026-10-20T10:00:00Z"}"#.to_string(),
        r#"{"type":"assistant","timestamp":"2026-10-20T10:00:05.250Z"}"#.to_string(),
        r#"{"type":"user","timestamp":"2026-10-20T09:59:00Z"}"#.to_string(),
    ];
    // 2026-10-20T10:00:05.250Z
    let odotettu = 1_792_490_405_250;
    assert_eq!(iso(odotettu), "2026-10-20T10:00:05.250Z");
    assert_eq!(peili::sisaltoaika(&sisalto(&rivit), 7), odotettu);
}

#[test]
fn laskenta_aikavyohyke_ja_murto_osa() {
    let aika = |t: &str| {
        peili::sisaltoaika(
            &sisalto(&[format!("{{\"timestamp\":\"{t}\"}}")]),
            1, // HLC-varapolun arvo
        )
    };
    let utc = 1_792_490_400_000; // 2026-10-20T10:00:00Z
    assert_eq!(aika("2026-10-20T10:00:00Z"), utc);
    assert_eq!(aika("2026-10-20T10:00:00.5Z"), utc + 500);
    assert_eq!(aika("2026-10-20T10:00:00.123456Z"), utc + 123);
    assert_eq!(aika("2026-10-20T13:00:00+03:00"), utc);
    assert_eq!(aika("2026-10-20T04:30:00-05:30"), utc);
    // Karkausvuosi ja epookki.
    assert_eq!(aika("1970-01-01T00:00:00Z"), 0);
    assert_eq!(aika("2024-02-29T00:00:00Z"), 1_709_164_800_000);
    // Virheelliset aikaleimat jäävät huomiotta (varapolku).
    for huono in [
        "2026-10-20",
        "2026-10-20 10:00:00Z",
        "2026-10-20T10:00:00",
        "2026-13-20T10:00:00Z",
        "2026-02-30T10:00:00Z",
        "2026-10-20T25:00:00Z",
        "2026-10-20T10:00:00+0300",
        "2026-10-20T10:00:00.Z",
        "1969-12-31T23:59:59Z",
        "ei aikaa",
    ] {
        assert_eq!(aika(huono), 1, "{huono}");
    }
}

#[test]
fn laskenta_ilman_aikaleimaa_hlc_ja_virheellinen_rivi_ohitetaan() {
    let hlc = 1_700_000_000_000;
    // Ei aikaleimaa yhdessäkään rivissä, ei JSON:ia, ei oliota, timestamp ei merkkijono.
    let ilman = vec![
        r#"{"type":"user"}"#.to_string(),
        "ei json".to_string(),
        "[1,2]".to_string(),
        r#"{"timestamp":42}"#.to_string(),
    ];
    assert_eq!(peili::sisaltoaika(&sisalto(&ilman), hlc), hlc);
    assert_eq!(peili::sisaltoaika(b"[]", hlc), hlc);
    assert_eq!(peili::sisaltoaika(b"ei taulukko", hlc), hlc);
    // Virheellinen rivi ohitetaan, muut lasketaan.
    let sekaisin = vec![
        "ei json".to_string(),
        r#"{"timestamp":"2026-10-20T10:00:00Z"}"#.to_string(),
        r#"{"timestamp":"huono"}"#.to_string(),
    ];
    assert_eq!(
        peili::sisaltoaika(&sisalto(&sekaisin), hlc),
        1_792_490_400_000
    );
}

#[tokio::test]
async fn riisunta_ei_pudota_sisaltoaikaa() {
    // Viimeinen (uusin) rivi on työkalurivi, jonka aikaleima riisunta pudottaa; sisältöaika tulee silti siitä.
    let s = Solmu::kaynnista("koe", Some(7), 38, false).await;
    let nyt = kello_ms();
    let uusin = nyt - 3_600_000;
    let rivit = vec![
        rivi(nyt - 2 * PAIVA_MS, 50),
        json!({"type": "assistant", "timestamp": iso(uusin),
            "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]}})
        .to_string(),
    ];
    let y = yksikko(&format!("{T}:0"), nyt - 5 * PAIVA_MS, &rivit);
    assert!(api::kirjoita_ja_ilmoita(&s.tila, &y)
        .await
        .unwrap()
        .is_some());
    assert_eq!(
        varastosta(&s),
        BTreeMap::from([(y.id.clone(), Some(uusin))])
    );
    let talletettu = s.tila.varasto.lue("peili", &y.id).unwrap().unwrap();
    let talletetut: Vec<String> = serde_json::from_slice(&talletettu.sisalto.unwrap()).unwrap();
    assert_eq!(talletetut, peili::riisu(&rivit));
}

// ---- (b) ikkunoitu solmu hylkää ja ottaa sisältöajan mukaan ---------------------------------------------

#[tokio::test]
async fn ikkunoitu_hylkaa_vanhan_sisaltoajan_ja_ottaa_tuoreen() {
    let s = Solmu::kaynnista("koe", Some(7), 38, false).await;
    let nyt = kello_ms();
    // HLC tänään, sisältö 10 vrk sitten: hylätään.
    let vanha = ajalla(&format!("{T}:0"), nyt, nyt - 10 * PAIVA_MS);
    assert_eq!(
        api::kirjoita_ja_ilmoita(&s.tila, &vanha).await.unwrap(),
        None
    );
    assert!(s.tila.varasto.lue("peili", &vanha.id).unwrap().is_none());
    assert_eq!(s.tila.varasto.seq().unwrap(), 0);
    // HLC 10 vrk sitten, sisältö tänään: otetaan.
    let tuore = ajalla(&format!("{T}:100"), nyt - 10 * PAIVA_MS, nyt - 1000);
    assert!(api::kirjoita_ja_ilmoita(&s.tila, &tuore)
        .await
        .unwrap()
        .is_some());
    let talletettu = s.tila.varasto.lue("peili", &tuore.id).unwrap().unwrap();
    assert_eq!(talletettu.aika, tuore.aika, "HLC-aika säilyy");
    assert_eq!(
        varastosta(&s),
        BTreeMap::from([(tuore.id.clone(), Some(nyt - 1000))])
    );
    // Aikaleimaton yksikkö: HLC-aika ratkaisee (ikkunan sisällä otetaan, ulkopuolella hylätään).
    let ilman_sisalla = yksikko(&format!("{T}:200"), nyt - 1000, &["{}".to_string()]);
    let ilman_ulkona = yksikko(&format!("{T}:300"), nyt - 9 * PAIVA_MS, &["{}".to_string()]);
    assert!(api::kirjoita_ja_ilmoita(&s.tila, &ilman_sisalla)
        .await
        .unwrap()
        .is_some());
    assert_eq!(
        api::kirjoita_ja_ilmoita(&s.tila, &ilman_ulkona)
            .await
            .unwrap(),
        None
    );
}

// ---- (c) siirtymä 1 → 2 -------------------------------------------------------------------------------

const SKEEMA_1: &str = "
CREATE TABLE yksikot  (polku TEXT NOT NULL, id TEXT NOT NULL, versio TEXT NOT NULL, aika TEXT NOT NULL, sisalto BLOB, poistettu INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (polku, id));
CREATE TABLE muutosloki (seq INTEGER PRIMARY KEY AUTOINCREMENT, polku TEXT NOT NULL, id TEXT NOT NULL, versio TEXT NOT NULL, aika TEXT NOT NULL);
CREATE TABLE laitteet (laite TEXT PRIMARY KEY, nimi TEXT, alusta TEXT, rooli TEXT, julkinen_avain TEXT, wg_avain TEXT, mallit TEXT, nahty TEXT);
CREATE TABLE liitteet (sha256 TEXT PRIMARY KEY, koko INTEGER NOT NULL, tyyppi TEXT, polku TEXT);
CREATE TABLE kursorit (vertainen TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE INDEX muutosloki_polku ON muutosloki(polku, seq);
CREATE TABLE meta (avain TEXT PRIMARY KEY, arvo TEXT);
INSERT INTO meta (avain, arvo) VALUES ('skeemaversio', '1');
";

fn lisaa_vanha(c: &Connection, polku: &str, id: &str, hlc_ms: u64, sisalto: Option<&[u8]>) {
    let aika = Hlc::nyt("koe", None, hlc_ms).to_string();
    c.execute(
        "INSERT INTO yksikot (polku, id, versio, aika, sisalto) VALUES (?1, ?2, '{\"koe\":1}', ?3, ?4)",
        params![polku, id, aika, sisalto],
    )
    .unwrap();
}

fn sarakkeet(c: &Connection) -> Vec<String> {
    let mut k = c
        .prepare("SELECT name FROM pragma_table_info('yksikot')")
        .unwrap();
    k.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn siirtyma_taytta_peili_yksikot_ja_poistaa_karsintarajan() {
    let tmp = Tmp::uusi();
    let hlc = 1_700_000_000_000u64;
    let sisalto_a = sisalto(&[rivi(1_792_000_000_000, 10), rivi(1_792_000_500_000, 10)]);
    let sisalto_b = sisalto(&["{}".to_string(), "ei json".to_string()]);
    {
        let c = Connection::open(&tmp.0).unwrap();
        c.pragma_update(None, "journal_mode", "WAL").unwrap();
        c.execute_batch(SKEEMA_1).unwrap();
        lisaa_vanha(&c, "peili", "a.jsonl:0", hlc, Some(&sisalto_a));
        lisaa_vanha(&c, "peili", "a.jsonl:100", hlc + 1, Some(&sisalto_b));
        lisaa_vanha(&c, "peili", "b.jsonl:0", hlc + 2, None);
        lisaa_vanha(&c, "peili-karsinta", "raja", hlc, Some(br#"{"ms":123}"#));
        lisaa_vanha(&c, "rekisterit/x", "r1", hlc, Some(b"r"));
        assert!(!sarakkeet(&c).contains(&"sisaltoaika".to_string()));
    }

    let alku = Instant::now();
    let v = Varasto::avaa(&tmp.0).unwrap();
    let kesto = alku.elapsed();
    eprintln!(
        "SIIRTYMA_KESTO_MS (testi c, 3 yksikköä): {}",
        kesto.as_millis()
    );

    let c = Connection::open(&tmp.0).unwrap();
    assert!(sarakkeet(&c).contains(&"sisaltoaika".to_string()));
    let versio: String = c
        .query_row(
            "SELECT arvo FROM meta WHERE avain = 'skeemaversio'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(versio, "2");
    let sa = |id: &str| -> Option<i64> {
        c.query_row(
            "SELECT sisaltoaika FROM yksikot WHERE polku = 'peili' AND id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    };
    // Uusin timestamp; aikaleimaton → HLC; hautakivi → HLC.
    assert_eq!(sa("a.jsonl:0"), Some(1_792_000_500_000));
    assert_eq!(sa("a.jsonl:100"), Some(hlc as i64 + 1));
    assert_eq!(sa("b.jsonl:0"), Some(hlc as i64 + 2));
    // Muiden polkujen sarake jää NULL:iksi.
    let muu: Option<i64> = c
        .query_row(
            "SELECT sisaltoaika FROM yksikot WHERE polku = 'rekisterit/x'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(muu, None);
    // Karsintaraja poissa, sisältö ennallaan.
    assert_eq!(peili::karsintaraja(&v).unwrap(), 0);
    assert!(v.lue("peili-karsinta", "raja").unwrap().is_none());
    assert_eq!(
        v.lue("peili", "a.jsonl:0").unwrap().unwrap().sisalto,
        Some(sisalto_a)
    );
    assert_eq!(
        v.listaa_otsakkeet_sisaltoajalla("peili")
            .unwrap()
            .into_iter()
            .map(|(y, sa)| (y.id, sa))
            .collect::<Vec<_>>(),
        vec![
            ("a.jsonl:0".to_string(), Some(1_792_000_500_000)),
            ("a.jsonl:100".to_string(), Some(hlc + 1)),
            ("b.jsonl:0".to_string(), Some(hlc + 2)),
        ]
    );
    drop(v);
    // Uudelleenavaus ei siirrä toistamiseen.
    let v = Varasto::avaa(&tmp.0).unwrap();
    assert_eq!(v.listaa("peili").unwrap().len(), 3);
}

#[test]
fn siirtyma_kasittelee_yli_era_yksikoita() {
    let tmp = Tmp::uusi();
    let n = 1_234u64;
    {
        let mut c = Connection::open(&tmp.0).unwrap();
        c.execute_batch(SKEEMA_1).unwrap();
        let tx = c.transaction().unwrap();
        for i in 0..n {
            let s = sisalto(&[rivi(1_700_000_000_000 + i, 5)]);
            lisaa_vanha(
                &tx,
                "peili",
                &format!("f.jsonl:{i:06}"),
                1_600_000_000_000,
                Some(&s),
            );
        }
        tx.commit().unwrap();
    }
    let alku = Instant::now();
    let v = Varasto::avaa(&tmp.0).unwrap();
    eprintln!(
        "SIIRTYMA_KESTO_MS (erätesti, {n} yksikköä): {}",
        alku.elapsed().as_millis()
    );
    let kaikki = v.listaa_otsakkeet_sisaltoajalla("peili").unwrap();
    assert_eq!(kaikki.len() as u64, n);
    for (i, (y, sa)) in kaikki.iter().enumerate() {
        assert_eq!(*sa, Some(1_700_000_000_000 + i as u64), "{}", y.id);
    }
}

#[test]
fn keskeytynyt_siirtyma_jatkuu() {
    // Sarake on jo lisätty ja osa täytetty, mutta versio on vielä 1.
    let tmp = Tmp::uusi();
    {
        let c = Connection::open(&tmp.0).unwrap();
        c.execute_batch(SKEEMA_1).unwrap();
        c.execute_batch("ALTER TABLE yksikot ADD COLUMN sisaltoaika INTEGER")
            .unwrap();
        let s = sisalto(&[rivi(1_700_000_000_000, 5)]);
        lisaa_vanha(&c, "peili", "f:0", 1, Some(&s));
        lisaa_vanha(&c, "peili", "f:10", 1, Some(&s));
        c.execute("UPDATE yksikot SET sisaltoaika = 77 WHERE id = 'f:0'", [])
            .unwrap();
    }
    let v = Varasto::avaa(&tmp.0).unwrap();
    let kaikki: Vec<Option<u64>> = v
        .listaa_otsakkeet_sisaltoajalla("peili")
        .unwrap()
        .into_iter()
        .map(|(_, sa)| sa)
        .collect();
    assert_eq!(kaikki, vec![Some(77), Some(1_700_000_000_000)]);
}

// ---- (d) /api/listat ----------------------------------------------------------------------------------

#[tokio::test]
async fn listat_palauttaa_sisaltoajan_vain_peilille() {
    let a = Solmu::kaynnista("a", None, 38, false).await;
    let nyt = kello_ms();
    let u = ajalla(&format!("{T}:0"), nyt, nyt - 10 * PAIVA_MS);
    a.tila.varasto.kirjoita(&u, Yhdistaja::Lisays).unwrap();
    let ilman = yksikko(&format!("{T}:50"), nyt - 1000, &["{}".to_string()]);
    a.tila.varasto.kirjoita(&ilman, Yhdistaja::Lisays).unwrap();
    let muu = Yksikko {
        polku: "rekisterit/r1".to_string(),
        id: "r01".to_string(),
        sisalto: Some(b"r".to_vec()),
        ..yksikko("r01", nyt, &[])
    };
    a.tila.varasto.kirjoita(&muu, Yhdistaja::Lww).unwrap();

    let l = a.get("/api/listat?polku=peili").await;
    let rivit = l["yksikot"].as_array().unwrap();
    assert_eq!(rivit.len(), 2);
    assert_eq!(rivit[0]["id"], u.id);
    assert_eq!(rivit[0]["sisaltoaika"], nyt - 10 * PAIVA_MS);
    assert_eq!(rivit[0]["aika"], u.aika.to_string());
    // Aikaleimaton yksikkö: sisältöaika = HLC-aika.
    assert_eq!(rivit[1]["sisaltoaika"], ilman.aika.ms);
    // Muut polut ennallaan.
    let l = a.get("/api/listat?polku=rekisterit/r1").await;
    assert!(l["yksikot"][0].get("sisaltoaika").is_none(), "{l}");
    // Vanha vastaus ilman kenttää jäsentyy.
    let vanha: ListaRivi =
        serde_json::from_value(json!({"id": "x", "versio": {"a": 1}, "aika": "x"})).unwrap();
    assert_eq!(vanha.sisaltoaika, None);
    let uusi: ListaRivi = serde_json::from_value(
        json!({"id": "x", "versio": {"a": 1}, "aika": "x", "sisaltoaika": 5}),
    )
    .unwrap();
    assert_eq!(uusi.sisaltoaika, Some(5));
}

/// A: täysi solmu, jossa neljä yksikköä; B: ikkunoitu 7 vrk. `vanha` = A:n `/api/listat` ilman kenttää.
async fn vedon_tulos(vanha: bool) -> (usize, BTreeSet<String>) {
    let a = Solmu::kaynnista("a", None, 38, vanha).await;
    let b = Solmu::kaynnista("b", Some(7), 38, false).await;
    let nyt = kello_ms();
    let yksikot = [
        // (id, HLC-aika, sisältöaika)
        ("tp.jsonl:0", nyt - 1000, nyt - 1000),
        ("to.jsonl:0", nyt - 1000, nyt - 10 * PAIVA_MS),
        ("ot.jsonl:0", nyt - 10 * PAIVA_MS, nyt - 1000),
        ("oo.jsonl:0", nyt - 10 * PAIVA_MS, nyt - 10 * PAIVA_MS),
    ];
    for (id, hlc, sisalto) in yksikot {
        a.tila
            .varasto
            .kirjoita(&ajalla(id, hlc, sisalto), Yhdistaja::Lisays)
            .unwrap();
    }
    let t = replikointi::tasaa_kerran(&b.tila, &a.vertainen())
        .await
        .unwrap();
    let tallessa = b
        .tila
        .varasto
        .listaa_otsakkeet("peili")
        .unwrap()
        .into_iter()
        .map(|y| y.id)
        .collect();
    (t.peili_haettu, tallessa)
}

#[tokio::test]
async fn veto_kayttaa_sisaltoaikaa_ja_vanha_vertainen_hlc_aikaa() {
    // Kenttä mukana: haetaan sisältöajaltaan ikkunassa olevat (tp, ot).
    let (haettu, tallessa) = vedon_tulos(false).await;
    assert_eq!(haettu, 2);
    assert_eq!(
        tallessa,
        BTreeSet::from(["tp.jsonl:0".to_string(), "ot.jsonl:0".to_string()])
    );
    // Kenttä puuttuu (vanha vertainen): vetoraja HLC-ajasta eli tp ja to pyydetään; to hylätään
    // vastaanotossa sisältöaikansa vuoksi.
    let (haettu, tallessa) = vedon_tulos(true).await;
    assert_eq!(haettu, 2);
    assert_eq!(tallessa, BTreeSet::from(["tp.jsonl:0".to_string()]));
}

// ---- (e) karsinta sisältöajasta -------------------------------------------------------------------------

#[tokio::test]
async fn katto_karsii_vanhimman_sisaltovuorokauden_vaikka_hlc_on_sama() {
    // T-57:n tilanne: kaikkien HLC-aika on tuontihetki. Ikkuna 30 vrk, katto 1 Mt; 10 yksikköä
    // (noin 300 kt), joiden sisältö on i vuorokautta vanha.
    let s = Solmu::kaynnista("koe", Some(30), 1, false).await;
    let nyt = kello_ms();
    for i in 0..10u64 {
        let sisalto_ms = nyt - i * PAIVA_MS - 1000;
        let y = yksikko(
            &format!("{T}:{}", i * 1000),
            nyt,
            &[rivi(sisalto_ms, 300_000)],
        );
        s.tila.varasto.kirjoita(&y, Yhdistaja::Lisays).unwrap();
    }
    let kaikki = varastosta(&s);
    let vanhin_ennen = *kaikki.values().flatten().min().unwrap();
    assert_eq!(vanhin_ennen, nyt - 9 * PAIVA_MS - 1000);
    let koko = s.get("/api/peili/koko").await;
    assert_eq!(koko["vanhin"], vanhin_ennen);

    let k = peili::karsi(&s.tila).unwrap();
    assert!(k.tavut_ennen > 3_000_000, "{k:?}");
    assert!(k.tavut_jalkeen <= 1_048_576, "{k:?}");
    assert_eq!(k.poistetut, 7, "{k:?}");
    let jaljella: Vec<u64> = (0..10u64)
        .filter(|i| {
            s.tila
                .varasto
                .lue("peili", &format!("{T}:{}", i * 1000))
                .unwrap()
                .is_some()
        })
        .collect();
    assert_eq!(jaljella, vec![0, 1, 2]);
    // Karsintaraja on sisältövuorokauden loppu: vanhimman jääneen (i = 2) sisältöaika on sen yläpuolella.
    let raja = peili::karsintaraja(&s.tila.varasto).unwrap();
    assert_eq!(raja % PAIVA_MS, 0);
    assert!(raja > nyt - 3 * PAIVA_MS - 1000 - PAIVA_MS && raja <= nyt - 2 * PAIVA_MS - 1000);
    let koko = s.get("/api/peili/koko").await;
    assert_eq!(koko["yksikot"], 3);
    assert_eq!(koko["vanhin"], nyt - 2 * PAIVA_MS - 1000);
}

#[tokio::test]
async fn ika_karsitaan_sisaltoajasta() {
    let s = Solmu::kaynnista("koe", Some(7), 38, false).await;
    let nyt = kello_ms();
    // HLC tänään, sisältö 9 vrk sitten: ulos. HLC 9 vrk sitten, sisältö tänään: jää.
    let vanha_sisalto = ajalla(&format!("{T}:0"), nyt, nyt - 9 * PAIVA_MS);
    let tuore_sisalto = ajalla(&format!("{T}:10"), nyt - 9 * PAIVA_MS, nyt - 1000);
    for y in [&vanha_sisalto, &tuore_sisalto] {
        s.tila.varasto.kirjoita(y, Yhdistaja::Lisays).unwrap();
    }
    let k = peili::karsi(&s.tila).unwrap();
    assert_eq!(k.poistetut, 1, "{k:?}");
    assert!(s
        .tila
        .varasto
        .lue("peili", &vanha_sisalto.id)
        .unwrap()
        .is_none());
    assert!(s
        .tila
        .varasto
        .lue("peili", &tuore_sisalto.id)
        .unwrap()
        .is_some());
}
