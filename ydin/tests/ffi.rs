//! C-rajapinta (T-46, S-8a): `scopes_solmu_kaynnista` ja `scopes_solmu_pysayta` extern-määrittelyn kautta
//! samassa prosessissa. Yksi solmu per prosessi, joten testit ajetaan lukon alla peräkkäin.

use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

// Ytimen rlib linkitetään mukaan, jotta extern-symbolit löytyvät.
use scopes_ydin as _;

extern "C" {
    fn scopes_solmu_kaynnista(
        asetukset_json: *const c_char,
        ulos: *mut c_char,
        ulos_koko: usize,
    ) -> i32;
    fn scopes_solmu_pysayta() -> i32;
}

static LUKKO: Mutex<()> = Mutex::new(());
static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "ffi-koeavain-1234";

fn lukitse() -> std::sync::MutexGuard<'static, ()> {
    LUKKO.lock().unwrap_or_else(|e| e.into_inner())
}

fn data_hakemisto() -> PathBuf {
    let n = LASKURI.fetch_add(1, Ordering::SeqCst);
    let p =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("ffi-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    p
}

fn asetukset(data: &Path) -> CString {
    CString::new(
        serde_json::json!({
            "data": data.to_str().unwrap(),
            "avain": AVAIN,
            "portti": 0,
            "vertaiset": [],
            "vanha": null,
            "vanha_avain": "vanha-koeavain",
            "headless": false,
            "laite": "ffi-koe",
        })
        .to_string(),
    )
    .unwrap()
}

/// Kutsuu `scopes_solmu_kaynnista` ja palauttaa (koodi, ulos-teksti).
fn kaynnista(json: &CString, koko: usize) -> (i32, String) {
    let mut ulos = vec![0x7f as c_char; koko];
    let koodi = unsafe { scopes_solmu_kaynnista(json.as_ptr(), ulos.as_mut_ptr(), koko) };
    let teksti = if ulos.contains(&0) {
        unsafe { CStr::from_ptr(ulos.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    } else {
        String::new()
    };
    (koodi, teksti)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
}

async fn hae(portti: i32, polku: &str, avain: Option<&str>) -> Result<u16, reqwest::Error> {
    let asiakas = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();
    let mut pyynto = asiakas.get(format!("http://127.0.0.1:{portti}{polku}"));
    if let Some(a) = avain {
        pyynto = pyynto.bearer_auth(a);
    }
    Ok(pyynto.send().await?.status().as_u16())
}

#[test]
fn kaynnistys_api_ja_pysaytys() {
    let _l = lukitse();
    let rt = runtime();
    let data = data_hakemisto();
    let json = asetukset(&data);

    let (portti, ulos) = kaynnista(&json, 128);
    assert!(portti > 0, "portti {portti}, ulos {ulos}");
    let v: serde_json::Value = serde_json::from_str(&ulos).unwrap();
    assert_eq!(v["portti"], portti);
    assert_eq!(v["versio"], env!("CARGO_PKG_VERSION"));

    assert_eq!(rt.block_on(hae(portti, "/api/terveys", None)).unwrap(), 200);
    assert_eq!(
        rt.block_on(hae(portti, "/api/tila", Some(AVAIN))).unwrap(),
        200
    );
    assert_eq!(
        rt.block_on(hae(portti, "/api/tila", Some("vaara")))
            .unwrap(),
        401
    );
    assert_eq!(rt.block_on(hae(portti, "/api/tila", None)).unwrap(), 401);

    // Vanha avain annetaan arvona: tiedosto <data>/vanha-avain, oikeudet 0600, avainta ei muualla.
    let vanha = data.join("vanha-avain");
    assert_eq!(std::fs::read_to_string(&vanha).unwrap(), "vanha-koeavain");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&vanha).unwrap().permissions().mode() & 0o777,
        0o600
    );

    // Toinen käynnistys -> -4, ensimmäinen solmu jää käyntiin.
    let (koodi, ulos) = kaynnista(&json, 128);
    assert_eq!(koodi, -4, "{ulos}");
    assert!(ulos.contains("virhe"), "{ulos}");
    assert_eq!(rt.block_on(hae(portti, "/api/terveys", None)).unwrap(), 200);

    assert_eq!(unsafe { scopes_solmu_pysayta() }, 0);
    assert!(
        rt.block_on(hae(portti, "/api/terveys", None)).is_err(),
        "portti vastaa pysäytyksen jälkeen"
    );
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 1);

    // Uudelleenkäynnistys pysäytyksen jälkeen onnistuu.
    let (portti2, ulos) = kaynnista(&json, 128);
    assert!(portti2 > 0, "portti {portti2}, ulos {ulos}");
    assert_eq!(
        rt.block_on(hae(portti2, "/api/terveys", None)).unwrap(),
        200
    );
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 0);
    assert!(rt.block_on(hae(portti2, "/api/terveys", None)).is_err());
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn virheelliset_syotteet() {
    let _l = lukitse();
    let rt = runtime();
    let data = data_hakemisto();

    // Virheellinen JSON -> -1; virheteksti ei toista syötteen arvoja.
    let rikki = CString::new(r#"{"data": 5, "avain": "salainen-arvo"#).unwrap();
    let (koodi, ulos) = kaynnista(&rikki, 128);
    assert_eq!(koodi, -1, "{ulos}");
    assert!(ulos.starts_with("{\"virhe\""), "{ulos}");
    let vaara_tyyppi = CString::new(r#"{"data":"x","avain":12345678}"#).unwrap();
    let (koodi, ulos) = kaynnista(&vaara_tyyppi, 128);
    assert_eq!(koodi, -1);
    assert!(!ulos.contains("12345678"), "{ulos}");

    // Liian pieni ulos -> -5 eikä solmua käynnistetä.
    let json = asetukset(&data);
    let (koodi, _) = kaynnista(&json, 8);
    assert_eq!(koodi, -5);
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 1);

    // Data-hakemisto ei luotavissa (polun varrella tiedosto) -> -2.
    std::fs::create_dir_all(&data).unwrap();
    let tiedosto = data.join("tiedosto");
    std::fs::write(&tiedosto, b"x").unwrap();
    let huono = CString::new(
        serde_json::json!({"data": tiedosto.join("ali").to_str().unwrap(), "avain": AVAIN})
            .to_string(),
    )
    .unwrap();
    let (koodi, ulos) = kaynnista(&huono, 128);
    assert_eq!(koodi, -2, "{ulos}");
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 1);

    // Portti varattu -> -3.
    let varattu = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let vp = varattu.local_addr().unwrap().port();
    let portilla = CString::new(
        serde_json::json!({"data": data.join("p").to_str().unwrap(), "avain": AVAIN, "portti": vp})
            .to_string(),
    )
    .unwrap();
    let (koodi, ulos) = kaynnista(&portilla, 128);
    assert_eq!(koodi, -3, "{ulos}");
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 1);
    drop(varattu);

    // Epäonnistuneet yritykset eivät jätä solmua: oikea käynnistys onnistuu.
    let (portti, ulos) = kaynnista(&json, 128);
    assert!(portti > 0, "{ulos}");
    assert_eq!(rt.block_on(hae(portti, "/api/terveys", None)).unwrap(), 200);
    assert_eq!(unsafe { scopes_solmu_pysayta() }, 0);
    let _ = std::fs::remove_dir_all(&data);
}
