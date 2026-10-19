//! Solmun käynnistys (T-46): varasto, `Tila`, kuuntelija, taustatehtävät ja palvelin yhdessä paikassa.
//! `scopes-solmu`-binääri ja C-rajapinta (`ffi`) käyttävät samaa polkua.

use crate::api::{self, Tila};
use crate::varasto::Varasto;
use crate::{lr, nakymat, vertaiset, web};
use std::fmt;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Virhekoodi: data-hakemisto tai varasto ei aukea.
pub const VIRHE_DATA: i32 = -2;
/// Virhekoodi: porttia ei voi sitoa.
pub const VIRHE_PORTTI: i32 = -3;

/// Vanhan palvelun avaimen lähde.
pub enum Avainlahde {
    /// Binääri: avain luetaan tiedostosta joka pyynnöllä (vaihto ilman uudelleenkäynnistystä).
    Tiedosto(PathBuf),
    /// C-rajapinta: avain annetaan arvona. `Tila` tukee vain polkua, joten arvo kirjoitetaan tiedostoon
    /// `<data>/vanha-avain` (0600) ja `Tila` saa sen polun. Tyhjä arvo = ei vanhan palvelun avainta.
    Arvo(String),
}

/// Solmun asetukset.
pub struct Asetukset {
    pub data: PathBuf,
    pub avain: String,
    pub portti: u16,
    pub vertaiset: Vec<String>,
    pub vanha: Option<String>,
    pub vanha_avain: Avainlahde,
    pub headless: bool,
    pub laite: String,
    pub lr_vertainen: Option<String>,
    pub web: Option<PathBuf>,
}

/// Käynnistysvirhe: `koodi` on C-rajapinnan virhekoodi, `teksti` ei sisällä avaimia.
#[derive(Debug)]
pub struct Virhe {
    pub koodi: i32,
    pub teksti: String,
}

impl fmt::Display for Virhe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.teksti)
    }
}

impl std::error::Error for Virhe {}

/// Käynnissä oleva solmu.
pub struct Kaynnissa {
    pub portti: u16,
    sammuta: oneshot::Sender<()>,
    palvelin: JoinHandle<()>,
    tehtavat: Vec<JoinHandle<()>>,
}

fn kirjoita_vanha_avain(data: &Path, arvo: &str) -> std::io::Result<PathBuf> {
    let polku = data.join("vanha-avain");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&polku)?;
    // Olemassa olevan tiedoston oikeudet kiristetään ennen sisällön kirjoitusta.
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(arvo.as_bytes())?;
    Ok(polku)
}

/// Käynnistää solmun: varasto, `Tila`, sidonta `127.0.0.1:<portti>`, vertaiset, näkymät, LR ja palvelin.
/// Palaa, kun portti kuuntelee.
pub async fn kaynnista(a: Asetukset) -> Result<Kaynnissa, Virhe> {
    let data_virhe = |e: String| Virhe {
        koodi: VIRHE_DATA,
        teksti: format!("datahakemiston käyttö epäonnistui: {e}"),
    };
    std::fs::create_dir_all(&a.data).map_err(|e| data_virhe(e.to_string()))?;
    let varasto = Varasto::avaa(&a.data.join("ydin.db"))
        .map_err(|e| data_virhe(format!("varaston avaus: {e}")))?;
    let vanha_avain = match a.vanha_avain {
        Avainlahde::Tiedosto(p) => Some(p),
        Avainlahde::Arvo(s) if s.is_empty() => None,
        Avainlahde::Arvo(s) => Some(
            kirjoita_vanha_avain(&a.data, &s)
                .map_err(|e| data_virhe(format!("vanha-avain: {e}")))?,
        ),
    };
    let kuuntelija = tokio::net::TcpListener::bind(("127.0.0.1", a.portti))
        .await
        .map_err(|e| Virhe {
            koodi: VIRHE_PORTTI,
            teksti: format!("portin sidonta epäonnistui: {e}"),
        })?;
    let portti = kuuntelija
        .local_addr()
        .map_err(|e| Virhe {
            koodi: VIRHE_PORTTI,
            teksti: format!("portin luku epäonnistui: {e}"),
        })?
        .port();
    let (lahetin, _) = tokio::sync::broadcast::channel(1024);
    let tila = Arc::new(Tila {
        varasto: Arc::new(varasto),
        laite: a.laite,
        headless: a.headless,
        avain: a.avain,
        vanha: a.vanha,
        vanha_avain,
        vertaiset: a.vertaiset,
        lr_vertainen: a.lr_vertainen,
        lahetin,
    });
    let tehtavat = vec![
        vertaiset::kaynnista(tila.clone()),
        nakymat::kaynnista(tila.clone()),
        lr::kaynnista(tila.clone()),
    ];
    let reitit = api::router(tila).merge(web::reitit(a.web));
    let (sammuta, pysayta) = oneshot::channel::<()>();
    let palvelin = tokio::spawn(async move {
        let tulos = axum::serve(kuuntelija, reitit)
            .with_graceful_shutdown(async move {
                let _ = pysayta.await;
            })
            .await;
        if let Err(e) = tulos {
            eprintln!("palvelin kaatui: {e}");
        }
    });
    Ok(Kaynnissa {
        portti,
        sammuta,
        palvelin,
        tehtavat,
    })
}

impl Kaynnissa {
    /// Sulkee kuuntelijan ja taustatehtävät: kohtelias pysäytys `aikaraja`an asti, sitten keskeytys.
    pub async fn sammuta(self, aikaraja: Duration) {
        let _ = self.sammuta.send(());
        let mut palvelin = self.palvelin;
        if tokio::time::timeout(aikaraja, &mut palvelin).await.is_err() {
            palvelin.abort();
            let _ = palvelin.await;
        }
        for t in self.tehtavat {
            t.abort();
            let _ = t.await;
        }
    }
}
