//! C-rajapinta (S-8a): ydin Apple-äpin omassa prosessissa. Otsake: `include/scopes_solmu.h`.
//!
//! - Yksi solmu per prosessi; solmulla on oma tokio-runtime omassa säikeessään.
//! - Avainta ei kirjoiteta avaintiedostoon eikä lokiteta. Vanhan palvelun avain (`vanha_avain`) annetaan
//!   arvona; `Tila` tukee vain polkua, joten `solmu::kaynnista` kirjoittaa arvon tiedostoon
//!   `<data>/vanha-avain` (0600) ja antaa `Tilalle` sen polun (`Avainlahde::Arvo`).
//! - Panic ei ylitä C-rajaa: `catch_unwind` -> -99 ja `{"virhe":"panic"}`.

use crate::solmu::{self, Asetukset, Avainlahde};
use serde::Deserialize;
use std::ffi::{c_char, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

const VERSIO: &str = env!("CARGO_PKG_VERSION");
/// Kohteliaan pysäytyksen yläraja; runtimen sulku on lisäksi alle sekunti, yhteensä alle 5 s.
const PYSAYTYS_RAJA: Duration = Duration::from_secs(4);

const VIRHE_JSON: i32 = -1;
const VIRHE_JO_KAYNNISSA: i32 = -4;
const VIRHE_ULOS: i32 = -5;
const VIRHE_PANIC: i32 = -99;

struct Ajossa {
    pysayta: tokio::sync::oneshot::Sender<()>,
    saie: std::thread::JoinHandle<()>,
}

static SOLMU: Mutex<Option<Ajossa>> = Mutex::new(None);

fn lukitse() -> MutexGuard<'static, Option<Ajossa>> {
    SOLMU.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Deserialize)]
struct AsetuksetJson {
    data: String,
    avain: String,
    #[serde(default)]
    portti: u16,
    #[serde(default)]
    vertaiset: Vec<String>,
    #[serde(default)]
    vanha: Option<String>,
    #[serde(default)]
    vanha_avain: Option<String>,
    #[serde(default)]
    headless: bool,
    #[serde(default)]
    laite: Option<String>,
    /// S-9: puuttuva avain tai null = täysi solmu.
    #[serde(default)]
    peili_ikkuna_vrk: Option<u32>,
    /// S-9: puuttuva avain tai null = 38.
    #[serde(default)]
    peili_katto_mt: Option<u32>,
}

fn onnistui_json(portti: u16) -> String {
    format!("{{\"portti\":{portti},\"versio\":\"{VERSIO}\"}}")
}

fn virhe_json(teksti: &str) -> String {
    serde_json::json!({ "virhe": teksti }).to_string()
}

/// Kirjoittaa NUL-päätteisen tekstin, jos se mahtuu. Palauttaa onnistuiko.
///
/// # Safety
/// `ulos` on null tai osoittaa vähintään `koko` tavun kirjoitettavaan alueeseen.
unsafe fn kirjoita_ulos(ulos: *mut c_char, koko: usize, teksti: &str) -> bool {
    if ulos.is_null() || teksti.len() + 1 > koko {
        return false;
    }
    std::ptr::copy_nonoverlapping(teksti.as_ptr().cast::<c_char>(), ulos, teksti.len());
    *ulos.add(teksti.len()) = 0;
    true
}

unsafe fn virhe(ulos: *mut c_char, koko: usize, koodi: i32, teksti: &str) -> i32 {
    kirjoita_ulos(ulos, koko, &virhe_json(teksti));
    koodi
}

unsafe fn kaynnista_sisa(json: *const c_char, ulos: *mut c_char, koko: usize) -> i32 {
    // Onnistumisvastauksen pisin muoto (portti 65535) + NUL; tarkistus ennen kuin mitään käynnistetään.
    if ulos.is_null() || koko < onnistui_json(u16::MAX).len() + 1 {
        return virhe(ulos, koko, VIRHE_ULOS, "ulos liian pieni");
    }
    if json.is_null() {
        return virhe(ulos, koko, VIRHE_JSON, "asetukset puuttuvat");
    }
    // Virheteksti ei toista syötteen arvoja: avain voisi päätyä lokiin.
    let j: AsetuksetJson = match serde_json::from_slice(CStr::from_ptr(json).to_bytes()) {
        Ok(j) => j,
        Err(e) => {
            let teksti = format!(
                "virheellinen asetus-JSON (rivi {}, sarake {})",
                e.line(),
                e.column()
            );
            return virhe(ulos, koko, VIRHE_JSON, &teksti);
        }
    };
    if j.data.is_empty() || j.avain.is_empty() {
        return virhe(ulos, koko, VIRHE_JSON, "data ja avain vaaditaan");
    }
    let a = Asetukset {
        data: PathBuf::from(j.data),
        avain: j.avain,
        portti: j.portti,
        vertaiset: j.vertaiset,
        vanha: j.vanha,
        vanha_avain: Avainlahde::Arvo(j.vanha_avain.unwrap_or_default()),
        headless: j.headless,
        laite: j
            .laite
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| "solmu".to_string()),
        lr_vertainen: None,
        web: None,
        peili_ikkuna_vrk: j.peili_ikkuna_vrk,
        peili_katto_mt: j.peili_katto_mt.unwrap_or(38),
    };

    let mut lukko = lukitse();
    if lukko.is_some() {
        return virhe(ulos, koko, VIRHE_JO_KAYNNISSA, "solmu on jo käynnissä");
    }
    let (tulos_tx, tulos_rx) = mpsc::channel::<Result<u16, (i32, String)>>();
    let (pysayta_tx, pysayta_rx) = tokio::sync::oneshot::channel::<()>();
    let saie = std::thread::Builder::new()
        .name("scopes-solmu".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = tulos_tx.send(Err((VIRHE_PANIC, format!("runtime: {e}"))));
                    return;
                }
            };
            rt.block_on(async move {
                match solmu::kaynnista(a).await {
                    Err(v) => {
                        let _ = tulos_tx.send(Err((v.koodi, v.teksti)));
                    }
                    Ok(k) => {
                        let _ = tulos_tx.send(Ok(k.portti));
                        let _ = pysayta_rx.await;
                        k.sammuta(PYSAYTYS_RAJA).await;
                    }
                }
            });
            rt.shutdown_timeout(Duration::from_millis(500));
        });
    let saie = match saie {
        Ok(s) => s,
        Err(e) => {
            return virhe(ulos, koko, VIRHE_PANIC, &format!("säie: {e}"));
        }
    };
    match tulos_rx.recv() {
        Ok(Ok(portti)) => {
            *lukko = Some(Ajossa {
                pysayta: pysayta_tx,
                saie,
            });
            kirjoita_ulos(ulos, koko, &onnistui_json(portti));
            i32::from(portti)
        }
        Ok(Err((koodi, teksti))) => {
            let _ = saie.join();
            virhe(ulos, koko, koodi, &teksti)
        }
        Err(_) => {
            let _ = saie.join();
            virhe(ulos, koko, VIRHE_PANIC, "panic")
        }
    }
}

/// Käynnistää solmun ja palaa, kun portti kuuntelee.
///
/// Palauttaa kuunnellun portin (>= 1) ja kirjoittaa `ulos`-puskuriin
/// `{"portti":<n>,"versio":"<crate-versio>"}` NUL-päätteisenä. Virheessä palauttaa negatiivisen koodin
/// (-1 JSON, -2 data-hakemisto, -3 portti, -4 jo käynnissä, -5 ulos liian pieni, -99 panic) ja kirjoittaa
/// `{"virhe":"<teksti>"}`, jos se mahtuu.
///
/// # Safety
/// `asetukset_json` on NUL-päätteinen merkkijono ja `ulos` osoittaa vähintään `ulos_koko` tavun
/// kirjoitettavaan alueeseen (tai on null, jolloin palautuu -5).
#[no_mangle]
pub unsafe extern "C" fn scopes_solmu_kaynnista(
    asetukset_json: *const c_char,
    ulos: *mut c_char,
    ulos_koko: usize,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        kaynnista_sisa(asetukset_json, ulos, ulos_koko)
    }))
    .unwrap_or_else(|_| {
        kirjoita_ulos(ulos, ulos_koko, &virhe_json("panic"));
        VIRHE_PANIC
    })
}

/// Pysäyttää solmun: kuuntelija ja taustatehtävät suljetaan (enintään 5 s). Palauttaa 0, tai 1 jos solmu
/// ei ole käynnissä.
#[no_mangle]
pub extern "C" fn scopes_solmu_pysayta() -> i32 {
    catch_unwind(|| {
        let mut lukko = lukitse();
        match lukko.take() {
            None => 1,
            Some(a) => {
                let _ = a.pysayta.send(());
                let _ = a.saie.join();
                0
            }
        }
    })
    .unwrap_or(VIRHE_PANIC)
}
