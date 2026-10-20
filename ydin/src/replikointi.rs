//! Solmujen välinen replikointi (SUUNNITELMA.md §3.3; LR:n E-74-protokolla yleistettynä, lr.mjs:383-410).
//!
//! Palvelinpuoli: `tiiviste` → `listat` → `hae`/`laheta`. Asiakaspuoli (`replikoi`): ensin polkukohtainen
//! tiivistevertailu ja erähaku/-lähetys (300 yksikköä/erä), sitten vertaisen `/api/virta`-tilaus
//! kursorilla; kursori talletetaan jokaisen sovelletun erän jälkeen. `silmukka` toistaa katkon jälkeen
//! 1, 2, 4 … 30 s välein kursorista.

use crate::api::{kirjoita_ja_ilmoita, Tila};
use crate::muutosloki::Tapahtuma;
use crate::peili;
use crate::vertaiset::Vertainen;
use crate::yksikko::{vertaa, Hlc, Versio, Vertailu, Yksikko};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

/// Erän koko: `hae`, `laheta` ja virran soveltaminen.
pub const ERA: usize = 300;
/// `/api/hae`-vastauksen sisältöjen enimmäistavut (raakana; JSON-tavutaulukkona ~3,6 ×). Vähintään yksi
/// yksikkö palautetaan aina; loput tunnukset kentässä `jatko` (T-36 ajo 3: 300 peiliyksikköä = ~764 Mt JSONia).
pub const HAE_TAVUT: usize = 8 * 1024 * 1024;
/// `/api/laheta`-pyynnön sisältöjen enimmäistavut: vastaanottajan runkoraja on axumin oletus 2 Mt JSONina.
pub const LAHETA_TAVUT: usize = 400 * 1024;
/// Sisäiset polut (S-5 "peili-offset", S-9b "peili-karsinta"): ei tiivisteeseen, listaan, lähetykseen
/// eikä virran soveltamiseen.
const SISAINEN: [&str; 2] = ["peili-offset", peili::KARSINTA_POLKU];
/// Vuorokausi millisekunteina (S-9b:n ikkunaraja).
const PAIVA_MS: u64 = 86_400_000;
/// Virran hiljaisuus, jonka jälkeen kerätty erä sovelletaan.
const HILJAISUUS: Duration = Duration::from_millis(100);
/// Uudelleenyrityksen enimmäisväli sekunteina.
const ENIMMAISVIIVE: u64 = 30;

#[derive(Debug)]
pub struct Virhe(pub String);

impl fmt::Display for Virhe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Virhe {}

impl From<rusqlite::Error> for Virhe {
    fn from(e: rusqlite::Error) -> Virhe {
        Virhe(format!("varasto: {e}"))
    }
}

impl From<reqwest::Error> for Virhe {
    fn from(e: reqwest::Error) -> Virhe {
        Virhe(format!("http: {e}"))
    }
}

impl From<serde_json::Error> for Virhe {
    fn from(e: serde_json::Error) -> Virhe {
        Virhe(format!("json: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, Virhe>;

/// `listat`-vastauksen rivi: tunnus, versio ja HLC tekstinä.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ListaRivi {
    pub id: String,
    pub versio: Versio,
    pub aika: String,
}

#[derive(Deserialize)]
struct Tiivisteet {
    seq: u64,
    tiivisteet: BTreeMap<String, String>,
    /// S-9b: vertaisen ikkunoidut polut (puuttuu = täysi solmu tai vanha vastaus).
    #[serde(default)]
    ikkunoidut: Vec<String>,
}

#[derive(Deserialize)]
struct Lista {
    yksikot: Vec<ListaRivi>,
}

#[derive(Deserialize)]
struct Yksikot {
    yksikot: Vec<Yksikko>,
    /// Tavubudjetin vuoksi palauttamatta jääneet tunnukset (puuttuu = kaikki palautettiin).
    #[serde(default)]
    jatko: Vec<String>,
}

/// `/api/hae`-vastaus ja `/api/laheta`-runko sarjoitetaan suoraan: `json!` rakentaisi ensin
/// `Value`-puun, jossa jokainen sisällön tavu on oma solmunsa (~24 tavua/tavu; T-36 ajo 3: VmHWM 630 MiB).
#[derive(Serialize)]
struct YksikotUlos<'a> {
    yksikot: &'a [Yksikko],
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    jatko: &'a [String],
}

#[derive(Deserialize)]
struct PolkuKysely {
    polku: Option<String>,
}

#[derive(Deserialize)]
struct HaePyynto {
    polku: String,
    idt: Vec<String>,
}

#[derive(Deserialize)]
struct LahetaPyynto {
    yksikot: Vec<Yksikko>,
}

// ---- Palvelinpuoli -----------------------------------------------------------------------------------

/// Onko polku sisäinen (ei replikoida)?
fn on_sisainen(polku: &str) -> bool {
    SISAINEN.contains(&polku)
}

/// S-9b: solmun ikkunoidut polut; täysi solmu = tyhjä.
pub fn ikkunoidut(tila: &Tila) -> Vec<String> {
    if tila.peili.ikkuna_vrk.is_some() {
        vec![peili::POLKU.to_string()]
    } else {
        Vec::new()
    }
}

/// S-9b korjaus 1: ikkunoitu solmu ei ole ikkunoidun polkunsa lähde (ei listaa, ei hae).
fn ei_lahde(tila: &Tila, polku: &str) -> bool {
    tila.peili.ikkuna_vrk.is_some() && polku == peili::POLKU
}

pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new()
        .route("/api/tiiviste", get(tiiviste))
        .route("/api/listat", get(listat))
        .route("/api/hae", post(hae))
        .route("/api/laheta", post(laheta))
        .with_state(tila)
}

fn virhe(koodi: StatusCode, teksti: &str) -> Response {
    (koodi, Json(json!({"virhe": teksti}))).into_response()
}

fn sisainen(e: impl fmt::Display) -> Response {
    virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
}

/// Solmun `seq` ennen luentaa ja jokaisen replikoitavan polun tiiviste.
pub fn tiivisteet(tila: &Tila) -> crate::muutosloki::Result<(u64, BTreeMap<String, String>)> {
    let seq = tila.varasto.seq()?;
    let polut: BTreeSet<String> = tila
        .varasto
        .polut()?
        .into_iter()
        .filter(|p| !on_sisainen(p))
        .collect();
    let mut kartta = BTreeMap::new();
    for p in polut {
        // Headless-solmun UI-avaimet eivät kuulu tiivisteeseen; polku ilman näkyviä yksiköitä jää pois.
        // Ikkunoidun solmun peili jää pois (S-9b, `tila::tiiviste`).
        if let Some(h) = crate::tila::tiiviste(tila, &p)? {
            kartta.insert(p, h);
        }
    }
    Ok((seq, kartta))
}

/// `?polku=p` → yhden polun tiiviste; ilman polkua → `{"seq":…,"tiivisteet":{polku:tiiviste}}`.
async fn tiiviste(State(t): State<Arc<Tila>>, Query(k): Query<PolkuKysely>) -> Response {
    match k.polku {
        Some(p) => match crate::tila::tiiviste(&t, &p) {
            Ok(h) => Json(json!({"polku": p, "tiiviste": h.unwrap_or_default()})).into_response(),
            Err(e) => sisainen(e),
        },
        None => match tiivisteet(&t) {
            // Täysi solmu ei lähetä "ikkunoidut"-kenttää (S-9b).
            Ok((seq, kartta)) => match ikkunoidut(&t) {
                ik if ik.is_empty() => {
                    Json(json!({"seq": seq, "tiivisteet": kartta})).into_response()
                }
                ik => Json(json!({"seq": seq, "tiivisteet": kartta, "ikkunoidut": ik}))
                    .into_response(),
            },
            Err(e) => sisainen(e),
        },
    }
}

async fn listat(State(t): State<Arc<Tila>>, Query(k): Query<PolkuKysely>) -> Response {
    let Some(p) = k.polku else {
        return virhe(StatusCode::BAD_REQUEST, "polku puuttuu");
    };
    if ei_lahde(&t, &p) {
        return Json(json!({"polku": p, "yksikot": []})).into_response();
    }
    // Vain otsakkeet: koko polun sisältö (peili: gigatavuja) ei mahdu muistiin.
    match t.varasto.listaa_otsakkeet(&p) {
        Ok(ys) => {
            let rivit: Vec<ListaRivi> = ys
                .into_iter()
                .filter(|y| crate::tila::nakyy(&t, y))
                .map(|y| ListaRivi {
                    id: y.id,
                    versio: y.versio,
                    aika: y.aika.to_string(),
                })
                .collect();
            Json(json!({"polku": p, "yksikot": rivit})).into_response()
        }
        Err(e) => sisainen(e),
    }
}

async fn hae(State(t): State<Arc<Tila>>, Json(p): Json<HaePyynto>) -> Response {
    if p.idt.len() > ERA {
        return virhe(StatusCode::BAD_REQUEST, "enintään 300 tunnusta");
    }
    let mut ys = Vec::new();
    let mut tavut = 0usize;
    if ei_lahde(&t, &p.polku) {
        return Json(YksikotUlos {
            yksikot: &ys,
            jatko: &[],
        })
        .into_response();
    }
    for (i, id) in p.idt.iter().enumerate() {
        match t.varasto.lue(&p.polku, id) {
            Ok(Some(y)) if crate::tila::nakyy(&t, &y) => {
                let koko = y.sisalto.as_ref().map_or(0, Vec::len);
                if !ys.is_empty() && tavut + koko > HAE_TAVUT {
                    return Json(YksikotUlos {
                        yksikot: &ys,
                        jatko: &p.idt[i..],
                    })
                    .into_response();
                }
                tavut += koko;
                ys.push(y);
            }
            Ok(Some(_)) => {}
            Ok(None) => {}
            Err(e) => return sisainen(e),
        }
    }
    Json(YksikotUlos {
        yksikot: &ys,
        jatko: &[],
    })
    .into_response()
}

async fn laheta(State(t): State<Arc<Tila>>, Json(p): Json<LahetaPyynto>) -> Response {
    if p.yksikot.len() > ERA {
        return virhe(StatusCode::BAD_REQUEST, "enintään 300 yksikköä");
    }
    let mut hyvaksytty = 0u64;
    for y in p.yksikot.iter().filter(|y| !on_sisainen(&y.polku)) {
        match kirjoita_ja_ilmoita(&t, y).await {
            Ok(Some(_)) => hyvaksytty += 1,
            Ok(None) => {}
            Err(e) => return sisainen(e),
        }
    }
    match t.varasto.seq() {
        Ok(seq) => Json(json!({"seq": seq, "hyvaksytty": hyvaksytty})).into_response(),
        Err(e) => sisainen(e),
    }
}

// ---- Asiakaspuoli ------------------------------------------------------------------------------------

fn osoite(v: &Vertainen, polku: &str) -> String {
    format!("{}{polku}", v.osoite.trim_end_matches('/'))
}

async fn json_vastaus<T: DeserializeOwned>(
    v: &Vertainen,
    rb: reqwest::RequestBuilder,
) -> Result<T> {
    let vastaus = rb.bearer_auth(&v.avain).send().await?.error_for_status()?;
    Ok(vastaus.json().await?)
}

/// Hakee polun yksiköt erissä vertaiselta ja kirjoittaa ne paikallisesti.
async fn hae_erissa(
    tila: &Tila,
    v: &Vertainen,
    http: &reqwest::Client,
    polku: &str,
    idt: &[String],
) -> Result<()> {
    for pala in idt.chunks(ERA) {
        let mut pyydetyt = pala.to_vec();
        loop {
            let vastaus: Yksikot = json_vastaus(
                v,
                http.post(osoite(v, "/api/hae"))
                    .json(&json!({"polku": polku, "idt": &pyydetyt})),
            )
            .await?;
            for y in vastaus.yksikot.iter().filter(|y| y.polku == polku) {
                kirjoita_ja_ilmoita(tila, y).await?;
            }
            // Jatko on aina lyhyempi kuin pyyntö (vähintään yksi palautetaan); muuten vertainen ei etene.
            if vastaus.jatko.is_empty() || vastaus.jatko.len() >= pyydetyt.len() {
                break;
            }
            pyydetyt = vastaus.jatko;
        }
    }
    Ok(())
}

async fn laheta_era(v: &Vertainen, http: &reqwest::Client, pala: &[Yksikko]) -> Result<()> {
    let _: serde_json::Value = json_vastaus(
        v,
        http.post(osoite(v, "/api/laheta")).json(&YksikotUlos {
            yksikot: pala,
            jatko: &[],
        }),
    )
    .await?;
    Ok(())
}

/// (haetaanko, lähetetäänkö) paikallisen ja vertaisen version perusteella.
fn suunta(oma: &Yksikko, rivi: &ListaRivi) -> (bool, bool) {
    if oma.versio == rivi.versio && oma.aika.to_string() == rivi.aika {
        return (false, false);
    }
    match vertaa(&oma.versio, &rivi.versio) {
        Vertailu::Uudempi => (false, true),
        Vertailu::Vanhempi => (true, false),
        Vertailu::Sama | Vertailu::Rinnakkainen => (true, true),
    }
}

/// Yhden tasaa-kierroksen tulos.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tasaus {
    /// Vertaisen `seq` ennen tiivisteiden laskentaa.
    pub seq: u64,
    /// Vertaisen tiivistevastauksen "ikkunoidut"-polut (S-9b).
    pub ikkunoidut: BTreeSet<String>,
    /// Vertaiselta pyydettyjen peili-yksiköiden määrä.
    pub peili_haettu: usize,
}

/// S-9b korjaus 2: ikkunoidun solmun vetohaun alaraja max(nyt − n vrk, karsintaraja); täysi = `None`.
fn vetoraja(tila: &Tila) -> Result<Option<u64>> {
    let Some(n) = tila.peili.ikkuna_vrk else {
        return Ok(None);
    };
    let ikkuna = crate::api::kello_ms().saturating_sub(u64::from(n) * PAIVA_MS);
    Ok(Some(ikkuna.max(peili::karsintaraja(&tila.varasto)?)))
}

/// Ikkunoidun solmun peili-polku (S-9b): haetaan vain vertaisen otsakkeet, joiden aika ≥ `alaraja` ja
/// joiden id puuttuu paikallisesti; ei lähetetä mitään. Palauttaa haettujen määrän.
async fn veda_ikkunaan(
    tila: &Tila,
    v: &Vertainen,
    http: &reqwest::Client,
    p: &str,
    alaraja: u64,
) -> Result<usize> {
    let l: Lista =
        json_vastaus(v, http.get(osoite(v, "/api/listat")).query(&[("polku", p)])).await?;
    let omat: BTreeSet<String> = tila
        .varasto
        .listaa_otsakkeet(p)?
        .into_iter()
        .map(|y| y.id)
        .collect();
    let haettavat: Vec<String> = l
        .yksikot
        .into_iter()
        .filter(|r| Hlc::parse(&r.aika).is_some_and(|h| h.ms >= alaraja))
        .filter(|r| !omat.contains(&r.id))
        .map(|r| r.id)
        .collect();
    hae_erissa(tila, v, http, p, &haettavat).await?;
    Ok(haettavat.len())
}

/// Yksi tasaa-kierros vertaista vastaan (vaiheet 1–2 ilman virtaa).
pub async fn tasaa_kerran(tila: &Tila, v: &Vertainen) -> Result<Tasaus> {
    let http = asiakas()?;
    tasaa(tila, v, &http).await
}

/// Vaiheet 1–2: tiivisteet, eroavista poluista listat, puuttuvat/vanhemmat haetaan ja omat uudemmat
/// lähetetään erissä. Vertaisen ikkunoituja polkuja ei verrata, haeta eikä lähetetä; ikkunoitu solmu
/// vain vetää peilin ikkunaansa (S-9b).
async fn tasaa(tila: &Tila, v: &Vertainen, http: &reqwest::Client) -> Result<Tasaus> {
    let eta: Tiivisteet = json_vastaus(v, http.get(osoite(v, "/api/tiiviste"))).await?;
    let (_, omat) = tiivisteet(tila)?;
    let polut: BTreeSet<&String> = eta.tiivisteet.keys().chain(omat.keys()).collect();
    let eta_ikkunoidut: BTreeSet<String> = eta.ikkunoidut.iter().cloned().collect();
    let mut peili_haettu = 0usize;
    // (polku, id): sisältö luetaan vasta lähetyserässä, jotta muistissa on enintään ERA yksikköä.
    let mut lahetettavat: Vec<(String, String)> = Vec::new();
    for p in polut {
        if eta_ikkunoidut.contains(p) || eta.tiivisteet.get(p) == omat.get(p) {
            continue;
        }
        if p == peili::POLKU {
            if let Some(alaraja) = vetoraja(tila)? {
                if eta.tiivisteet.contains_key(p) {
                    peili_haettu += veda_ikkunaan(tila, v, http, p, alaraja).await?;
                }
                continue;
            }
        }
        let eta_rivit = if eta.tiivisteet.contains_key(p) {
            let l: Lista = json_vastaus(
                v,
                http.get(osoite(v, "/api/listat"))
                    .query(&[("polku", p.as_str())]),
            )
            .await?;
            l.yksikot
        } else {
            Vec::new()
        };
        // Headless-solmu ei lähetä UI-avaimiaan.
        let omat_yksikot: Vec<Yksikko> = tila
            .varasto
            .listaa_otsakkeet(p)?
            .into_iter()
            .filter(|y| crate::tila::nakyy(tila, y))
            .collect();
        let eta_kartta: HashMap<&str, &ListaRivi> =
            eta_rivit.iter().map(|r| (r.id.as_str(), r)).collect();
        let oma_kartta: HashMap<&str, &Yksikko> =
            omat_yksikot.iter().map(|y| (y.id.as_str(), y)).collect();
        let haettavat: Vec<String> = eta_rivit
            .iter()
            .filter(|r| oma_kartta.get(r.id.as_str()).is_none_or(|y| suunta(y, r).0))
            .map(|r| r.id.clone())
            .collect();
        lahetettavat.extend(
            omat_yksikot
                .iter()
                .filter(|y| eta_kartta.get(y.id.as_str()).is_none_or(|r| suunta(y, r).1))
                .map(|y| (y.polku.clone(), y.id.clone())),
        );
        if p == peili::POLKU {
            peili_haettu += haettavat.len();
        }
        hae_erissa(tila, v, http, p, &haettavat).await?;
    }
    // Erä: enintään ERA yksikköä ja LAHETA_TAVUT sisältöä (vähintään yksi yksikkö).
    let mut pala: Vec<Yksikko> = Vec::new();
    let mut tavut = 0usize;
    for (polku, id) in &lahetettavat {
        let Some(y) = tila.varasto.lue(polku, id)? else {
            continue;
        };
        let koko = y.sisalto.as_ref().map_or(0, Vec::len);
        if !pala.is_empty() && (pala.len() == ERA || tavut + koko > LAHETA_TAVUT) {
            laheta_era(v, http, &pala).await?;
            pala.clear();
            tavut = 0;
        }
        tavut += koko;
        pala.push(y);
    }
    if !pala.is_empty() {
        laheta_era(v, http, &pala).await?;
    }
    Ok(Tasaus {
        seq: eta.seq,
        ikkunoidut: eta_ikkunoidut,
        peili_haettu,
    })
}

/// Soveltaa kerätyn erän: jo samassa versiossa olevat ohitetaan, muut haetaan polkuittain erissä.
/// Täysi solmu ohittaa `ohitettavat`-polut (vertaisen ikkunoidut, S-9b korjaus 1).
/// Kursori asetetaan erän viimeiseen `seq`:iin vasta, kun kaikki on kirjoitettu.
async fn sovella(
    tila: &Tila,
    v: &Vertainen,
    http: &reqwest::Client,
    era: &mut Vec<Tapahtuma>,
    ohitettavat: &BTreeSet<String>,
) -> Result<Option<u64>> {
    let Some(viimeinen) = era.last().map(|t| t.seq) else {
        return Ok(None);
    };
    let taysi = tila.peili.ikkuna_vrk.is_none();
    let mut ryhmat: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for t in era.drain(..) {
        if on_sisainen(&t.polku) || (taysi && ohitettavat.contains(&t.polku)) {
            continue;
        }
        if let Some(y) = tila.varasto.lue(&t.polku, &t.id)? {
            if y.versio == t.versio && y.aika.to_string() == t.aika {
                continue;
            }
        }
        ryhmat.entry(t.polku).or_default().insert(t.id);
    }
    for (polku, idt) in ryhmat {
        let idt: Vec<String> = idt.into_iter().collect();
        hae_erissa(tila, v, http, &polku, &idt).await?;
    }
    tila.varasto.aseta_kursori(&v.id, viimeinen)?;
    Ok(Some(viimeinen))
}

/// Yksi SSE-viesti: (tapahtuman nimi, data).
fn jasenna(viesti: &str) -> (String, String) {
    let mut nimi = String::new();
    let mut data = String::new();
    for rivi in viesti.lines() {
        let rivi = rivi.trim_end_matches('\r');
        if let Some(arvo) = rivi.strip_prefix("event:") {
            nimi = arvo.strip_prefix(' ').unwrap_or(arvo).to_string();
        } else if let Some(arvo) = rivi.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(arvo.strip_prefix(' ').unwrap_or(arvo));
        }
    }
    (nimi, data)
}

fn asiakas() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()?)
}

async fn istunto(tila: &Tila, v: &Vertainen, yhdistetty: &mut bool) -> Result<u64> {
    let http = asiakas()?;
    // Täysi tasaus kattaa kaiken vertaisen `seq`:iin asti; vertaisen pienempi `seq` = vaihtunut varasto.
    let tasaus = tasaa(tila, v, &http).await?;
    if tila.peili.ikkuna_vrk.is_some() {
        eprintln!("PEILI_HAETTU: {}", tasaus.peili_haettu);
    }
    let ohitettavat = tasaus.ikkunoidut;
    let mut kursori = tasaus.seq;
    tila.varasto.aseta_kursori(&v.id, kursori)?;
    let vastaus = http
        .get(osoite(v, "/api/virta"))
        .query(&[("since", kursori)])
        .bearer_auth(&v.avain)
        .send()
        .await?
        .error_for_status()?;
    *yhdistetty = true;
    let mut virta = vastaus.bytes_stream();
    let mut puskuri: Vec<u8> = Vec::new();
    let mut era: Vec<Tapahtuma> = Vec::new();
    loop {
        let seuraava = if era.is_empty() {
            Some(virta.next().await)
        } else {
            tokio::time::timeout(HILJAISUUS, virta.next()).await.ok()
        };
        let pala = match seuraava {
            // Hiljaisuus: kerätty erä sovelletaan.
            None => {
                if let Some(n) = sovella(tila, v, &http, &mut era, &ohitettavat).await? {
                    kursori = n;
                }
                continue;
            }
            Some(None) => {
                if let Some(n) = sovella(tila, v, &http, &mut era, &ohitettavat).await? {
                    kursori = n;
                }
                return Ok(kursori);
            }
            Some(Some(Err(e))) => return Err(e.into()),
            Some(Some(Ok(pala))) => pala,
        };
        puskuri.extend_from_slice(&pala);
        while let Some(i) = puskuri.windows(2).position(|w| w == b"\n\n") {
            let viesti: Vec<u8> = puskuri.drain(..i + 2).collect();
            let (nimi, data) = jasenna(&String::from_utf8_lossy(&viesti));
            match nimi.as_str() {
                "muutos" => {
                    era.push(serde_json::from_str(&data)?);
                    if era.len() >= ERA {
                        if let Some(n) = sovella(tila, v, &http, &mut era, &ohitettavat).await? {
                            kursori = n;
                        }
                    }
                }
                // Vertaisen loki on kursoria jäljessä: uusi istunto tasaa täydellä vertailulla.
                "nollaus" => return Err(Virhe(format!("nollaus: {data}"))),
                _ => {}
            }
        }
    }
}

/// Yksi replikointi-istunto: 1) tiivisteet ja erähaku, 2) omat uudemmat erissä vertaiselle, 3) virran
/// tilaus `since=<kursori>`; kursori talletetaan jokaisen erän jälkeen. Palauttaa kursorin, kun vertainen
/// sulkee virran; katko palauttaa virheen (`silmukka` yrittää uudelleen).
pub async fn replikoi(tila: Arc<Tila>, vertainen: &Vertainen) -> Result<u64> {
    let mut yhdistetty = false;
    istunto(&tila, vertainen, &mut yhdistetty).await
}

/// Toistaa `replikoi`-istuntoa: katkon jälkeen odotus 1, 2, 4 … 30 s; onnistunut virtayhteys nollaa välin.
pub async fn silmukka(tila: Arc<Tila>, vertainen: Vertainen) {
    let mut viive = 1u64;
    loop {
        let mut yhdistetty = false;
        if let Err(e) = istunto(&tila, &vertainen, &mut yhdistetty).await {
            eprintln!("replikointi {}: {e}", vertainen.id);
        }
        if yhdistetty {
            viive = 1;
        }
        tokio::time::sleep(Duration::from_secs(viive)).await;
        viive = (viive * 2).min(ENIMMAISVIIVE);
    }
}
