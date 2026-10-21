//! Transkriptipeilin aikaikkuna (T-54, S-9): `riisu`, S-9a-suodatin, S-9c-karsinta, `/api/peili/koko` ja FFI-asetukset.

use scopes_ydin::api::{self, kello_ms, Tila};
use scopes_ydin::peili::{self, PeiliIkkuna};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::{c_char, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

// Ytimen rlib linkitetään mukaan, jotta FFI-symbolit löytyvät.
use scopes_ydin as _;

extern "C" {
    fn scopes_solmu_kaynnista(
        asetukset_json: *const c_char,
        ulos: *mut c_char,
        ulos_koko: usize,
    ) -> i32;
    fn scopes_solmu_pysayta() -> i32;
}

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-ikkuna";
const PAIVA_MS: u64 = 86_400_000;
const T: &str = "istunto-a.jsonl";

struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("peili-ikkuna-{}-{n}.db", std::process::id())))
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        for pääte in ["", "-wal", "-shm"] {
            let mut s = self.0.clone().into_os_string();
            s.push(pääte);
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
            adapteri: Default::default(),
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

    async fn koko(&self) -> Value {
        let v = reqwest::Client::new()
            .get(format!("{}/api/peili/koko", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status().as_u16(), 200);
        v.json().await.unwrap()
    }
}

/// Peiliyksikkö `<tiedosto>:<alku>`, jonka HLC-aika on `ms` (rivien `timestamp` asettaa kutsuja).
fn yksikko(tiedosto: &str, alku: u64, rivit: &[String], ms: u64) -> Yksikko {
    Yksikko {
        polku: "peili".to_string(),
        id: format!("{tiedosto}:{alku}"),
        versio: BTreeMap::from([("koe".to_string(), 1)]),
        aika: Hlc::nyt("koe", None, ms),
        sisalto: Some(serde_json::to_vec(rivit).unwrap()),
        poistettu: false,
    }
}

fn rivit_jsonl() -> Vec<String> {
    vec![
        r#"{"type":"user","timestamp":"2026-10-20T10:00:00Z","uuid":"u1","cwd":"/x","message":{"role":"user","content":"hei"}}"#.to_string(),
        r#"{"type":"assistant","timestamp":"2026-10-20T10:00:01Z","uuid":"a1","requestId":"r","message":{"role":"assistant","model":"m-1","id":"msg","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"moi"},{"type":"tool_use","id":"t","name":"Bash","input":{}}]}}"#.to_string(),
        r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ulos"}]}}"#.to_string(),
        r#"{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{}}]}}"#.to_string(),
        r#"{"type":"summary","summary":"x"}"#.to_string(),
        "ei json".to_string(),
    ]
}

/// `rivit_jsonl` rivien aikaleimat asetettuna hetkeen `ms` (sisältöaika = aiottu ikä, T-73).
fn rivit_ajalla(ms: u64) -> Vec<String> {
    rivit_jsonl()
        .into_iter()
        .map(|r| {
            r.replace("2026-10-20T10:00:00Z", &iso(ms))
                .replace("2026-10-20T10:00:01Z", &iso(ms))
        })
        .collect()
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

#[test]
fn riisu_sailyttaa_tekstin_ja_tyngaa_muun() {
    let syote = rivit_jsonl();
    let ulos = peili::riisu(&syote);
    assert_eq!(ulos.len(), syote.len());
    let v: Vec<Value> = ulos
        .iter()
        .map(|r| serde_json::from_str(r).unwrap())
        .collect();
    // Merkkijonosisältö sellaisenaan; vain sallitut avaimet.
    assert_eq!(
        v[0],
        json!({"type":"user","timestamp":"2026-10-20T10:00:00Z","uuid":"u1",
               "message":{"role":"user","content":"hei"}})
    );
    // Taulukosta text- ja tool_use-lohkot (S-9a T-74); model säilyy, id, requestId ja thinking pois.
    assert_eq!(
        v[1],
        json!({"type":"assistant","timestamp":"2026-10-20T10:00:01Z","uuid":"a1",
               "message":{"role":"assistant","model":"m-1","content":[{"type":"text","text":"moi"},
                   {"type":"tool_use","id":"t","name":"Bash","input":{}}]}})
    );
    // tool_result ilman sisältöä ja tool_use säilyvät; muu type ja ei-JSON -> tynkä.
    assert_eq!(
        v[2],
        json!({"type":"user","uuid":"u2",
               "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t"}]}})
    );
    assert_eq!(
        v[3],
        json!({"type":"assistant","uuid":"a2",
               "message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{}}]}})
    );
    assert_eq!(v[4], json!({"type":"summary","karsittu":true}));
    assert_eq!(v[5], json!({"type":null,"karsittu":true}));
    assert!(!ulos.concat().contains("thinking"));
}

#[tokio::test]
async fn ikkunoitu_hylkaa_vanhan_ja_riisuu_tuoreen() {
    let s = Solmu::kaynnista(Some(7), 38).await;
    let mut rx = s.tila.lahetin.subscribe();
    let nyt = kello_ms();
    let rivit = rivit_ajalla(nyt - 8 * PAIVA_MS);

    let vanha = yksikko(T, 0, &rivit, nyt - 8 * PAIVA_MS);
    assert_eq!(
        api::kirjoita_ja_ilmoita(&s.tila, &vanha).await.unwrap(),
        None
    );
    assert!(s.tila.varasto.lue("peili", &vanha.id).unwrap().is_none());
    assert_eq!(s.tila.varasto.seq().unwrap(), 0);
    assert!(rx.try_recv().is_err(), "hylätty yksikkö tuotti tapahtuman");

    let rivit = rivit_ajalla(nyt - 6 * PAIVA_MS);
    let tuore = yksikko(T, 100, &rivit, nyt - 6 * PAIVA_MS);
    assert!(api::kirjoita_ja_ilmoita(&s.tila, &tuore)
        .await
        .unwrap()
        .is_some());
    let talletettu = s.tila.varasto.lue("peili", &tuore.id).unwrap().unwrap();
    let talletetut: Vec<String> = serde_json::from_slice(&talletettu.sisalto.unwrap()).unwrap();
    assert_eq!(talletetut, peili::riisu(&rivit));
    assert_eq!(talletetut.len(), rivit.len());
    assert_eq!(talletettu.id, tuore.id);
    assert_eq!(talletettu.versio, tuore.versio);
    assert_eq!(talletettu.aika, tuore.aika);
    assert_eq!(rx.try_recv().unwrap().polku, "peili");
}

#[tokio::test]
async fn taysi_solmu_tallettaa_muuttamatta() {
    let s = Solmu::kaynnista(None, 38).await;
    let y = yksikko(
        T,
        0,
        &rivit_ajalla(kello_ms() - 8 * PAIVA_MS),
        kello_ms() - 8 * PAIVA_MS,
    );
    assert!(api::kirjoita_ja_ilmoita(&s.tila, &y)
        .await
        .unwrap()
        .is_some());
    assert_eq!(s.tila.varasto.lue("peili", &y.id).unwrap().unwrap(), y);
    // Täysi solmu ei koskaan karsi.
    let k = peili::karsi(&s.tila).unwrap();
    assert_eq!(k.poistetut, 0);
    assert!(s.tila.varasto.lue("peili", &y.id).unwrap().is_some());
}

#[tokio::test]
async fn katto_poistaa_vanhimmat_vuorokaudet() {
    // Ikkuna 30 vrk, katto 1 Mt (1 048 576 tavua); 10 vuorokauden yksiköt, noin 300 kt kukin.
    let s = Solmu::kaynnista(Some(30), 1).await;
    let nyt = kello_ms();
    let isku = vec!["x".repeat(300_000)];
    for i in 0..10u64 {
        let y = yksikko(T, i * 1000, &isku, nyt - i * PAIVA_MS - 1000);
        s.tila
            .varasto
            .kirjoita(&y, scopes_ydin::yksikko::Yhdistaja::Lisays)
            .unwrap();
    }
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
    // Tuoreimmat (i = 0, 1, 2) jäljellä, vanhimmat pois.
    assert_eq!(jaljella, vec![0, 1, 2]);
    let koko = s.koko().await;
    assert_eq!(koko["yksikot"], 3);
    assert_eq!(koko["tavut"], k.tavut_jalkeen);
    assert_eq!(koko["katto_mt"], 1);
    assert_eq!(koko["ikkuna_vrk"], 30);
}

#[tokio::test]
async fn karsinta_poistaa_ikkunan_ulkopuoliset_ja_kunnioittaa_hakusuojaa() {
    let s = Solmu::kaynnista(Some(7), 38).await;
    let nyt = kello_ms();
    let r = vec!["{}".to_string()];
    for (i, ika) in [(0u64, 9u64), (10, 8), (20, 2)] {
        let y = yksikko(T, i, &r, nyt - ika * PAIVA_MS);
        s.tila
            .varasto
            .kirjoita(&y, scopes_ydin::yksikko::Yhdistaja::Lisays)
            .unwrap();
    }
    s.tila.peili.merkitse_haetuksi(&format!("{T}:10"));
    let k = peili::karsi(&s.tila).unwrap();
    assert_eq!(k.poistetut, 1);
    assert!(s
        .tila
        .varasto
        .lue("peili", &format!("{T}:0"))
        .unwrap()
        .is_none());
    // Alle 10 min sitten haettu jää, vaikka on ikkunan ulkopuolella.
    assert!(s
        .tila
        .varasto
        .lue("peili", &format!("{T}:10"))
        .unwrap()
        .is_some());
    assert!(s
        .tila
        .varasto
        .lue("peili", &format!("{T}:20"))
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn karsinta_ei_kirjoita_lokia_eika_virtaa() {
    let s = Solmu::kaynnista(Some(7), 38).await;
    let nyt = kello_ms();
    let y = yksikko(T, 0, &["{}".to_string()], nyt - 9 * PAIVA_MS);
    s.tila
        .varasto
        .kirjoita(&y, scopes_ydin::yksikko::Yhdistaja::Lisays)
        .unwrap();
    let seq = s.tila.varasto.seq().unwrap();
    let loki = s.tila.varasto.loki(0, 100).unwrap().len();
    let mut rx = s.tila.lahetin.subscribe();
    let k = peili::karsi(&s.tila).unwrap();
    assert_eq!(k.poistetut, 1);
    assert_eq!(s.tila.varasto.seq().unwrap(), seq);
    assert_eq!(s.tila.varasto.loki(0, 100).unwrap().len(), loki);
    assert!(rx.try_recv().is_err(), "karsinta tuotti tapahtuman");
    // Fyysinen poisto: ei hautakiveä.
    assert!(s.tila.varasto.lue("peili", &y.id).unwrap().is_none());
    assert!(s.tila.varasto.listaa_otsakkeet("peili").unwrap().is_empty());
}

#[tokio::test]
async fn koko_reitti_molemmilla_solmutyypeilla() {
    let nyt = kello_ms();
    for (ikkuna, odotettu) in [(None, Value::Null), (Some(7), json!(7))] {
        let s = Solmu::kaynnista(ikkuna, 38).await;
        let tyhja = s.koko().await;
        assert_eq!(
            tyhja,
            json!({"tavut":0,"yksikot":0,"vanhin":null,"ikkuna_vrk":odotettu,"katto_mt":38})
        );
        let a = yksikko(T, 0, &["{\"a\":1}".to_string()], nyt - 2 * PAIVA_MS);
        let b = yksikko(T, 8, &["{\"b\":2}".to_string()], nyt - 1000);
        s.tila
            .varasto
            .kirjoita(&a, scopes_ydin::yksikko::Yhdistaja::Lisays)
            .unwrap();
        s.tila
            .varasto
            .kirjoita(&b, scopes_ydin::yksikko::Yhdistaja::Lisays)
            .unwrap();
        let koko = s.koko().await;
        let odotettu_tavut = a.sisalto.as_ref().unwrap().len() + b.sisalto.as_ref().unwrap().len();
        assert_eq!(koko["tavut"], odotettu_tavut);
        assert_eq!(koko["yksikot"], 2);
        // T-73: vanhin = pienin sisältöaika ms (rivit ilman aikaleimaa → HLC-aika).
        assert_eq!(koko["vanhin"], a.aika.ms);
        assert_eq!(koko["ikkuna_vrk"], odotettu);
        // Ilman avainta 401 (suojattu reitti).
        let ilman = reqwest::get(format!("{}/api/peili/koko", s.osoite))
            .await
            .unwrap();
        assert_eq!(ilman.status().as_u16(), 401);
    }
}

fn kaynnista_ffi(json: &Value) -> i32 {
    let c = CString::new(json.to_string()).unwrap();
    let mut ulos = vec![0 as c_char; 128];
    let koodi = unsafe { scopes_solmu_kaynnista(c.as_ptr(), ulos.as_mut_ptr(), ulos.len()) };
    if koodi < 0 {
        let teksti = unsafe { CStr::from_ptr(ulos.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        panic!("käynnistys epäonnistui {koodi}: {teksti}");
    }
    koodi
}

async fn ffi_koko(portti: i32) -> Value {
    reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap()
        .get(format!("http://127.0.0.1:{portti}/api/peili/koko"))
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[test]
fn ffi_json_ilman_uusia_avaimia_on_taysi_solmu() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let data = |n: &str| {
        let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("peili-ikkuna-ffi-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        p.to_str().unwrap().to_string()
    };
    // Vanha JSON: ei peili-avaimia.
    let portti = kaynnista_ffi(&json!({
        "data": data("a"), "avain": AVAIN, "portti": 0, "vertaiset": [], "vanha": null,
        "vanha_avain": "v", "headless": false, "laite": "ffi-koe"
    }));
    let koko = rt.block_on(ffi_koko(portti));
    assert_eq!(koko["ikkuna_vrk"], Value::Null, "{koko}");
    assert_eq!(koko["katto_mt"], 38, "{koko}");
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 0);

    // Uudet avaimet voimassa.
    let portti = kaynnista_ffi(&json!({
        "data": data("b"), "avain": AVAIN, "portti": 0, "laite": "ffi-koe",
        "peili_ikkuna_vrk": 7, "peili_katto_mt": 5
    }));
    let koko = rt.block_on(ffi_koko(portti));
    assert_eq!(koko["ikkuna_vrk"], 7, "{koko}");
    assert_eq!(koko["katto_mt"], 5, "{koko}");
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 0);

    // Eksplisiittinen null = täysi solmu.
    let portti = kaynnista_ffi(&json!({
        "data": data("c"), "avain": AVAIN, "portti": 0, "peili_ikkuna_vrk": null
    }));
    assert_eq!(rt.block_on(ffi_koko(portti))["ikkuna_vrk"], Value::Null);
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 0);
}
