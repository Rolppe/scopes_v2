//! LR-vertainen lukutilassa (T-32, ARK-12): ydin tilaa LR 1:n (vanhan 8787:n `/api/lr/*`) tiivisteet,
//! hakee eroavien rekisterien listat ja yksiköt ja tallettaa ne omaan varastoonsa. Lukutila: ydin ei
//! koskaan kutsu `/api/lr/laheta`, ja sen omat `POST /api/lr/*` -reitit vastaavat 405.
//!
//! Varastomalli rekisterille `<p>`:
//! - `rekisterit/<p>`, id = rivin tunnus: rivin nykytila (`sisalto` = rivin teksti, `versio`, `poistettu`),
//!   yhdistäjä `Lr`. Rinnakkaiset versiot (K4) ovat sisaryksiköitä `<id>~<laite>` samalla polulla.
//! - `rekisterit-meta/<p>`, id `meta` (rekisterin `_meta.json`) ja `siivotut` (`_siivotut.json`), `Lww`.
//! - `rekisterit-meta/<p>`, id = rivin tunnus: rivin muut kentät (laji, osio, järjestysavain, muutettu,
//!   muuttaja, gitin puoli, rinnakkaisten järjestys) JSONina, `Lww`. `poissa: true` = LR ei enää listaa
//!   riviä (siivottu hautakivi).
//!
//! Rekisterin nykytila kootaan näistä `yksikko::rekisteri::Rekisteri`ksi, joten teksti, tiiviste ja
//! ristiriidat lasketaan samoilla funktioilla kuin T-17:n lr.mjs-siirrossa.

use crate::api::{kello_ms, kirjoita_ja_ilmoita, kirjoita_yhdistajalla, Tila};
use crate::replikointi::{Result, Virhe};
use crate::varasto::Varasto;
use crate::vertaiset::Vertainen;
use crate::yksikko::rekisteri::{self, Meta, Rekisteri, Rivi, Sisar};
use crate::yksikko::{Hlc, Versio, Yhdistaja, Yksikko};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

/// Rivien polun etuliite varastossa.
const RIVIT: &str = "rekisterit/";
/// Metan, siivottujen ja rivien lisäkenttien polun etuliite varastossa.
const META: &str = "rekisterit-meta/";
/// `hae`-pyynnön erän koko.
const ERA: usize = 300;
/// Synkkaväli, jos vertainen ei kerro `valiMin`-arvoa.
const OLETUSVALI_MIN: u64 = 10;
/// `listat`-pyynnön rekisterimäärä kerralla.
const LISTAERA: usize = 100;

/// Yhden synkan tulos.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Yhteenveto {
    /// Vertaisen tiivisteessä olleet rekisterit.
    pub tarkistettu: usize,
    /// Rekisterit, joiden tiiviste erosi omasta (listat haettiin).
    pub rekisterit: usize,
    /// `hae`-kutsut (erät).
    pub haettu: usize,
    /// Vertaiselta haetut rivit.
    pub yksikot: usize,
    /// Haetuista riveistä ne, joilla on rinnakkaisia (K4).
    pub ristiriidat: usize,
    /// Vertaisen ilmoittama synkkaväli minuutteina (0 = ei ilmoitettu).
    pub vali_min: u64,
}

fn virhe(s: impl Into<String>) -> Virhe {
    Virhe(s.into())
}

// ---- Varastosta rekisteriksi ------------------------------------------------------------------------

/// Rivin lisäkentät (`rekisterit-meta/<p>`, id = rivin tunnus).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lisat {
    laji: String,
    osio: String,
    jarjestys: String,
    muutettu: Option<String>,
    muuttaja: Option<String>,
    lahde_sisalto: Option<String>,
    lahde_versio: Option<Versio>,
    /// Rinnakkaisten sisaryksiköt LR:n järjestyksessä.
    #[serde(default)]
    rinnakkaiset: Vec<SisarViite>,
    #[serde(default)]
    poissa: bool,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, Deserialize)]
struct SisarViite {
    id: String,
    muutettu: Option<String>,
    muuttaja: Option<String>,
}

fn json_sisalto<T: serde::de::DeserializeOwned>(y: &Yksikko) -> Option<T> {
    serde_json::from_slice(y.sisalto.as_deref()?).ok()
}

fn teksti_sisalto(y: &Yksikko) -> String {
    String::from_utf8_lossy(y.sisalto.as_deref().unwrap_or_default()).into_owned()
}

/// Kokoaa rekisterin `polku` metayksiköistä ja riviyksiköistä; ilman metaa `None`.
fn kokoa(polku: &str, metat: &[Yksikko], rivit: &[Yksikko]) -> Option<Rekisteri> {
    let mut meta: Option<Meta> = None;
    let mut siivotut = BTreeMap::new();
    let mut lisat: BTreeMap<&str, Lisat> = BTreeMap::new();
    for y in metat.iter().filter(|y| !y.poistettu) {
        match y.id.as_str() {
            "meta" => meta = json_sisalto(y),
            "siivotut" => siivotut = json_sisalto(y).unwrap_or_default(),
            id => {
                if let Some(l) = json_sisalto::<Lisat>(y) {
                    lisat.insert(id, l);
                }
            }
        }
    }
    let meta = meta?;
    let yksikot: BTreeMap<&str, &Yksikko> = rivit.iter().map(|y| (y.id.as_str(), y)).collect();
    let mut kootut = BTreeMap::new();
    for (id, l) in lisat {
        if l.poissa || siivotut.contains_key(id) {
            continue;
        }
        let Some(y) = yksikot.get(id) else { continue };
        let rinnakkaiset = l
            .rinnakkaiset
            .iter()
            .filter_map(|s| {
                let sy = yksikot.get(s.id.as_str())?;
                Some(Sisar {
                    sisalto: teksti_sisalto(sy),
                    poistettu: sy.poistettu,
                    versio: sy.versio.clone(),
                    muutettu: s.muutettu.clone(),
                    muuttaja: s.muuttaja.clone(),
                })
            })
            .collect();
        kootut.insert(
            id.to_string(),
            Rivi {
                id: id.to_string(),
                rekisteri: polku.to_string(),
                laji: l.laji,
                osio: l.osio,
                jarjestys: l.jarjestys,
                sisalto: teksti_sisalto(y),
                versio: y.versio.clone(),
                muutettu: l.muutettu,
                muuttaja: l.muuttaja,
                poistettu: y.poistettu,
                lahde_sisalto: l.lahde_sisalto,
                lahde_versio: l.lahde_versio,
                rinnakkaiset,
            },
        );
    }
    Some(Rekisteri {
        meta,
        rivit: kootut,
        siivotut,
    })
}

/// Yksi rekisteri varastosta.
fn lue_rekisteri(varasto: &Varasto, polku: &str) -> Result<Option<Rekisteri>> {
    let metat = varasto.listaa(&format!("{META}{polku}"))?;
    if metat.is_empty() {
        return Ok(None);
    }
    let rivit = varasto.listaa(&format!("{RIVIT}{polku}"))?;
    Ok(kokoa(polku, &metat, &rivit))
}

fn ryhmittele(ys: Vec<Yksikko>, etuliite: &str) -> BTreeMap<String, Vec<Yksikko>> {
    let mut ulos: BTreeMap<String, Vec<Yksikko>> = BTreeMap::new();
    for y in ys {
        if let Some(p) = y.polku.strip_prefix(etuliite) {
            ulos.entry(p.to_string()).or_default().push(y);
        }
    }
    ulos
}

/// Kaikki varaston rekisterit (polku → rekisteri).
fn lue_kaikki(varasto: &Varasto) -> Result<rekisteri::Varasto> {
    let metat = ryhmittele(varasto.listaa_etuliite(META)?, META);
    let mut rivit = ryhmittele(varasto.listaa_etuliite(RIVIT)?, RIVIT);
    let mut rv = rekisteri::Varasto::default();
    for (p, m) in metat {
        let r = rivit.remove(&p).unwrap_or_default();
        if let Some(rek) = kokoa(&p, &m, &r) {
            rv.rekisterit.insert(p, rek);
        }
    }
    Ok(rv)
}

fn yhden(polku: &str, rek: Rekisteri) -> rekisteri::Varasto {
    let mut rv = rekisteri::Varasto::default();
    rv.rekisterit.insert(polku.to_string(), rek);
    rv
}

/// Teksti; `None` = rekisteriä ei ole.
fn teksti_tai_ei(varasto: &Varasto, polku: &str) -> Result<Option<String>> {
    Ok(lue_rekisteri(varasto, polku)?.map(|rek| yhden(polku, rek).tulosta(polku, false)))
}

/// Rekisterin yhteinen nykytila tekstinä, identtinen `lr.mjs tulosta(juuri, polku)`:n kanssa: poistamattomien
/// rivien `sisalto` järjestysavaimen (tasapelissä tunnuksen) mukaan. Tuntematon rekisteri tai lukuvirhe
/// → tyhjä teksti (reitti erottaa nämä 404:ksi).
pub fn teksti(varasto: &Varasto, polku: &str) -> String {
    teksti_tai_ei(varasto, polku)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// `lr.mjs vie`:n tiedostosisältö ilman gitiä (`--kuiva`): etuliitteen rekisterit, jotka eivät ole poistettuja ja
/// joilla on gitin lähde (lr.mjs:521-523), polun mukaan lajiteltuina ja yhteisenä nykytilana (`tulosta`). Vienti
/// ohittaa lisäksi avoimen riidan, lukon ja työpuun muutokset; ne ovat gitin puolen tilaa, ei tekstiä.
pub fn vie_kuiva(varasto: &Varasto, etuliite: &str) -> Vec<(String, String)> {
    let Ok(rv) = lue_kaikki(varasto) else {
        return Vec::new();
    };
    rv.rekisterit
        .iter()
        .filter(|(p, rek)| {
            p.starts_with(etuliite) && !rek.meta.poistettu && rek.meta.lahde.is_some()
        })
        .map(|(p, _)| (p.clone(), rv.tulosta(p, false)))
        .collect()
}

/// Rekisterin tiiviste, sama kaava kuin `lr.mjs rekisterinTiiviste` (lr.mjs:379-384):
/// `sha256(["_meta:" + vektori(meta.versio), ...lajitellut(id + ":" + vektori(versio) + ("|" + vektori(r.versio))*)].join("\n"))`,
/// missä `vektori` = `laite=n` pilkuin avainjärjestyksessä ja rivit sisältävät hautakivet (siivotut eivät).
pub fn tiiviste(varasto: &Varasto, polku: &str) -> Result<String> {
    let rek = lue_rekisteri(varasto, polku)?
        .ok_or_else(|| virhe(format!("tuntematon rekisteri: {polku}")))?;
    yhden(polku, rek)
        .rekisterin_tiiviste(polku)
        .map_err(|e| virhe(e.0))
}

// ---- Kirjoitus ----------------------------------------------------------------------------------------

/// Kirjoittaa `Lww`-yksikön, ellei sama sisältö ole jo voimassa; aika on edellistä uudempi.
fn talleta_lww(
    tila: &Tila,
    polku: &str,
    id: &str,
    versio: &Versio,
    sisalto: Vec<u8>,
    poistettu: bool,
) -> Result<()> {
    let nykyinen = tila.varasto.lue(polku, id)?;
    if let Some(n) = &nykyinen {
        if n.sisalto.as_deref() == Some(sisalto.as_slice())
            && n.poistettu == poistettu
            && &n.versio == versio
        {
            return Ok(());
        }
    }
    let y = Yksikko {
        polku: polku.to_string(),
        id: id.to_string(),
        versio: versio.clone(),
        aika: Hlc::nyt(&tila.laite, nykyinen.as_ref().map(|n| &n.aika), kello_ms()),
        sisalto: Some(sisalto),
        poistettu,
    };
    kirjoita_yhdistajalla(tila, &y, Yhdistaja::Lww)?;
    Ok(())
}

fn talleta_lisat(tila: &Tila, polku: &str, id: &str, versio: &Versio, l: &Lisat) -> Result<()> {
    talleta_lww(
        tila,
        &format!("{META}{polku}"),
        id,
        versio,
        serde_json::to_vec(l)?,
        false,
    )
}

/// LR:n `muutettu` (ISO-aika) HLC:ksi: suoraan HLC-muodosta, ISO-ajasta laskurilla 0 ja muuttajalla, tai nyt.
fn aika(tila: &Tila, muutettu: Option<&str>, muuttaja: Option<&str>) -> Hlc {
    muutettu
        .and_then(|m| {
            Hlc::parse(m).or_else(|| Hlc::parse(&format!("{m}-0000-{}", muuttaja.unwrap_or("lr"))))
        })
        .unwrap_or_else(|| Hlc::nyt(&tila.laite, None, kello_ms()))
}

/// LR:n tunnusmuoto `^[a-z0-9]+-\d+$` (lr.mjs:473).
fn kelpo_tunnus(id: &str) -> bool {
    id.split_once('-').is_some_and(|(a, b)| {
        !a.is_empty()
            && !b.is_empty()
            && a.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && b.bytes().all(|c| c.is_ascii_digit())
    })
}

/// Tallettaa vertaiselta haetun rivin: sisaryksiköt, lisäkentät ja rivin (`Lr`).
async fn talleta_rivi(tila: &Tila, polku: &str, r: &Rivi, vanhat: Option<&Lisat>) -> Result<()> {
    let rivipolku = format!("{RIVIT}{polku}");
    let mut viitteet = Vec::new();
    let mut kaytetyt = BTreeSet::new();
    for s in &r.rinnakkaiset {
        let laite = s.muuttaja.as_deref().unwrap_or("tuntematon");
        let mut sid = format!("{}~{laite}", r.id);
        let mut n = 2;
        while !kaytetyt.insert(sid.clone()) {
            sid = format!("{}~{laite}~{n}", r.id);
            n += 1;
        }
        talleta_lww(
            tila,
            &rivipolku,
            &sid,
            &s.versio,
            s.sisalto.clone().into_bytes(),
            s.poistettu,
        )?;
        viitteet.push(SisarViite {
            id: sid,
            muutettu: s.muutettu.clone(),
            muuttaja: s.muuttaja.clone(),
        });
    }
    // Ratkaistut rinnakkaiset: sisaryksikkö hautakiveksi.
    for vanha in vanhat
        .map(|l| l.rinnakkaiset.as_slice())
        .unwrap_or_default()
    {
        if kaytetyt.contains(&vanha.id) {
            continue;
        }
        if let Some(y) = tila.varasto.lue(&rivipolku, &vanha.id)? {
            if !y.poistettu {
                talleta_lww(tila, &rivipolku, &vanha.id, &y.versio, Vec::new(), true)?;
            }
        }
    }
    let lisat = Lisat {
        laji: r.laji.clone(),
        osio: r.osio.clone(),
        jarjestys: r.jarjestys.clone(),
        muutettu: r.muutettu.clone(),
        muuttaja: r.muuttaja.clone(),
        lahde_sisalto: r.lahde_sisalto.clone(),
        lahde_versio: r.lahde_versio.clone(),
        rinnakkaiset: viitteet,
        poissa: false,
    };
    talleta_lisat(tila, polku, &r.id, &r.versio, &lisat)?;
    let y = Yksikko {
        polku: rivipolku,
        id: r.id.clone(),
        versio: r.versio.clone(),
        aika: aika(tila, r.muutettu.as_deref(), r.muuttaja.as_deref()),
        sisalto: Some(r.sisalto.clone().into_bytes()),
        poistettu: r.poistettu,
    };
    kirjoita_ja_ilmoita(tila, &y).await?;
    Ok(())
}

// ---- Synkka --------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TiivisteVastaus {
    rekisterit: BTreeMap<String, String>,
    vali_min: Option<u64>,
}

#[derive(Deserialize)]
struct ListaRivi {
    id: String,
    versio: Versio,
    #[serde(default)]
    rinnakkaiset: Vec<Versio>,
}

#[derive(Deserialize)]
struct ListaVastaus {
    meta: Meta,
    #[serde(default)]
    yksikot: Vec<ListaRivi>,
    #[serde(default)]
    siivotut: BTreeMap<String, Versio>,
}

#[derive(Deserialize)]
struct HaeVastaus {
    #[serde(default)]
    yksikot: Vec<Rivi>,
}

struct Yhteys<'a> {
    asiakas: reqwest::Client,
    vertainen: &'a Vertainen,
}

impl Yhteys<'_> {
    async fn tarkista(vastaus: reqwest::Response) -> Result<reqwest::Response> {
        let tila = vastaus.status();
        if tila.is_success() {
            return Ok(vastaus);
        }
        let url = vastaus.url().path().to_string();
        let runko = vastaus.text().await.unwrap_or_default();
        Err(virhe(format!("lr-vertainen {url}: {tila} {runko}")))
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, polku: &str) -> Result<T> {
        let v = self
            .asiakas
            .get(format!("{}{polku}", self.vertainen.osoite))
            .bearer_auth(self.vertainen.avain.trim())
            .send()
            .await?;
        Ok(Self::tarkista(v).await?.json().await?)
    }

    /// Vain `listat` ja `hae`: lukutila ei koskaan kutsu `/api/lr/laheta`.
    async fn post<T: serde::de::DeserializeOwned>(&self, polku: &str, runko: &Value) -> Result<T> {
        debug_assert!(polku == "/api/lr/listat" || polku == "/api/lr/hae");
        let v = self
            .asiakas
            .post(format!("{}{polku}", self.vertainen.osoite))
            .bearer_auth(self.vertainen.avain.trim())
            .json(runko)
            .send()
            .await?;
        Ok(Self::tarkista(v).await?.json().await?)
    }
}

/// Rivi on ajan tasalla, jos oma versio ja rinnakkaisten versiot ovat samat kuin vertaisen listassa.
fn ajan_tasalla(oma: Option<&Rivi>, l: &ListaRivi) -> bool {
    oma.is_some_and(|o| {
        o.versio == l.versio
            && o.rinnakkaiset.len() == l.rinnakkaiset.len()
            && o.rinnakkaiset
                .iter()
                .zip(&l.rinnakkaiset)
                .all(|(a, b)| &a.versio == b)
    })
}

/// Yhden eroavan rekisterin synkka listasta: meta, siivotut, puuttuvat ja muuttuneet rivit, poistuneet.
async fn synkkaa_rekisteri(
    tila: &Tila,
    yhteys: &Yhteys<'_>,
    polku: &str,
    lista: ListaVastaus,
    yv: &mut Yhteenveto,
) -> Result<()> {
    let metapolku = format!("{META}{polku}");
    let oma = lue_rekisteri(&tila.varasto, polku)?;
    let omat_lisat: BTreeMap<String, Lisat> = tila
        .varasto
        .listaa(&metapolku)?
        .iter()
        .filter(|y| y.id != "meta" && y.id != "siivotut")
        .filter_map(|y| Some((y.id.clone(), json_sisalto::<Lisat>(y)?)))
        .collect();
    let haettavat: Vec<String> = lista
        .yksikot
        .iter()
        .filter(|l| kelpo_tunnus(&l.id))
        .filter(|l| !ajan_tasalla(oma.as_ref().and_then(|r| r.rivit.get(&l.id)), l))
        .map(|l| l.id.clone())
        .collect();
    let mut haetut: Vec<Rivi> = Vec::new();
    for era in haettavat.chunks(ERA) {
        let v: HaeVastaus = yhteys
            .post("/api/lr/hae", &json!({ "rekisteri": polku, "idt": era }))
            .await?;
        yv.haettu += 1;
        haetut.extend(
            v.yksikot
                .into_iter()
                .filter(|r| r.rekisteri == polku && kelpo_tunnus(&r.id)),
        );
    }
    // Kaikki haettu: vasta nyt kirjoitetaan.
    let mut meta = lista.meta;
    meta.rekisteri = polku.to_string();
    talleta_lww(
        tila,
        &metapolku,
        "meta",
        &meta.versio.clone(),
        serde_json::to_vec(&meta)?,
        false,
    )?;
    talleta_lww(
        tila,
        &metapolku,
        "siivotut",
        &Versio::new(),
        serde_json::to_vec(&lista.siivotut)?,
        false,
    )?;
    for r in &haetut {
        talleta_rivi(tila, polku, r, omat_lisat.get(&r.id)).await?;
        yv.yksikot += 1;
        if !r.rinnakkaiset.is_empty() {
            yv.ristiriidat += 1;
        }
    }
    // Rivit, joita vertainen ei enää listaa (siivotut hautakivet): pois tekstistä ja tiivisteestä.
    let listatut: BTreeSet<&str> = lista.yksikot.iter().map(|l| l.id.as_str()).collect();
    for (id, l) in &omat_lisat {
        if !l.poissa && !id.contains('~') && !listatut.contains(id.as_str()) {
            let versio = tila
                .varasto
                .lue(&format!("{RIVIT}{polku}"), id)?
                .map(|y| y.versio)
                .unwrap_or_default();
            let poissa = Lisat {
                poissa: true,
                ..l.clone()
            };
            talleta_lisat(tila, polku, id, &versio, &poissa)?;
        }
    }
    Ok(())
}

/// Lukutilan synkka: `GET <vertainen>/api/lr/tiiviste` → eroaville `POST /api/lr/listat` → per rekisteri
/// `POST /api/lr/hae` puuttuville ja muuttuneille riveille erissä 300 → talletus varastoon. Ei koskaan
/// `POST /api/lr/laheta` (ARK-12: kirjoittava tila vasta vanhan alasajossa). Rekisteri kirjoitetaan vasta,
/// kun sen kaikki erät on haettu: yhteysvirhe ennen ensimmäistä kirjoitusta jättää varaston koskemattomaksi.
pub async fn synkkaa(tila: &Tila, vertainen: &Vertainen) -> Result<Yhteenveto> {
    let yhteys = Yhteys {
        asiakas: reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()?,
        vertainen,
    };
    let tiivisteet: TiivisteVastaus = yhteys.get("/api/lr/tiiviste").await?;
    let omat = lue_kaikki(&tila.varasto)?.tiivisteet().rekisterit;
    let eroavat: Vec<String> = tiivisteet
        .rekisterit
        .iter()
        .filter(|(p, t)| rekisteri::kelpo_polku(p) && omat.get(*p) != Some(*t))
        .map(|(p, _)| p.clone())
        .collect();
    let mut yv = Yhteenveto {
        tarkistettu: tiivisteet.rekisterit.len(),
        vali_min: tiivisteet.vali_min.unwrap_or(0),
        ..Yhteenveto::default()
    };
    for era in eroavat.chunks(LISTAERA) {
        let listat: BTreeMap<String, ListaVastaus> = yhteys
            .post("/api/lr/listat", &json!({ "rekisterit": era }))
            .await?;
        for (polku, lista) in listat {
            if !era.contains(&polku) {
                continue;
            }
            yv.rekisterit += 1;
            synkkaa_rekisteri(tila, &yhteys, &polku, lista, &mut yv).await?;
        }
    }
    Ok(yv)
}

/// Vertaisen Bearer-avain: `tila.vanha_avain`-tiedoston sisältö, muuten solmun oma avain.
fn lr_avain(tila: &Tila) -> String {
    tila.vanha_avain
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tila.avain.clone())
}

/// Synkkasilmukka `tila.lr_vertainen`-osoitteeseen: synkka heti ja sitten `valiMin` (vastauksesta,
/// oletus 10) minuutin välein; virhe kirjataan ja yritetään seuraavalla kierroksella. Ilman vertaista
/// tehtävä päättyy heti.
pub fn kaynnista(tila: Arc<Tila>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let Some(osoite) = tila.lr_vertainen.clone() else {
            return;
        };
        let mut vali = OLETUSVALI_MIN;
        loop {
            match Vertainen::osoitteesta(&osoite, &lr_avain(&tila)) {
                None => {
                    eprintln!("lr: tyhjä --lr-vertainen");
                    return;
                }
                Some(v) => match synkkaa(&tila, &v).await {
                    Ok(yv) => {
                        if yv.vali_min > 0 {
                            vali = yv.vali_min;
                        }
                        if yv.rekisterit > 0 {
                            eprintln!("lr {}: {yv:?}", v.id);
                        }
                    }
                    Err(e) => eprintln!("lr {}: {e}", v.id),
                },
            }
            tokio::time::sleep(Duration::from_secs(vali * 60)).await;
        }
    })
}

// ---- Reitit ------------------------------------------------------------------------------------------

fn vastaus_virhe(koodi: StatusCode, viesti: &str) -> Response {
    (koodi, Json(json!({ "virhe": viesti }))).into_response()
}

async fn hae_tiiviste(State(t): State<Arc<Tila>>) -> Response {
    match lue_kaikki(&t.varasto) {
        Ok(rv) => {
            let tv = rv.tiivisteet();
            Json(json!({
                "laite": t.laite,
                "juuri": tv.juuri,
                "rekisterit": tv.rekisterit,
                "valiMin": OLETUSVALI_MIN,
            }))
            .into_response()
        }
        Err(e) => vastaus_virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn hae_ristiriidat(State(t): State<Arc<Tila>>) -> Response {
    match lue_kaikki(&t.varasto) {
        Ok(rv) => Json(json!({ "ristiriidat": rv.ristiriidat() })).into_response(),
        Err(e) => vastaus_virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn hae_teksti(State(t): State<Arc<Tila>>, Path(polku): Path<String>) -> Response {
    if !rekisteri::kelpo_polku(&polku) {
        return vastaus_virhe(StatusCode::NOT_FOUND, "tuntematon rekisteri");
    }
    match teksti_tai_ei(&t.varasto, &polku) {
        Ok(Some(teksti)) => Json(json!({ "teksti": teksti })).into_response(),
        Ok(None) => vastaus_virhe(StatusCode::NOT_FOUND, "tuntematon rekisteri"),
        Err(e) => vastaus_virhe(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn lukutila() -> Response {
    vastaus_virhe(StatusCode::METHOD_NOT_ALLOWED, "lukutila")
}

/// `GET /api/lr/tiiviste|ristiriidat|teksti/<polku>` omasta varastosta; LR:n `POST`-reitit (`listat`,
/// `hae`, `laheta`) → 405 `{"virhe":"lukutila"}`, jotta ne eivät valu siltaan.
pub fn reitit(tila: Arc<Tila>) -> Router {
    Router::new()
        .route("/api/lr/tiiviste", get(hae_tiiviste).post(lukutila))
        .route("/api/lr/ristiriidat", get(hae_ristiriidat).post(lukutila))
        .route("/api/lr/teksti/*polku", get(hae_teksti).post(lukutila))
        .route("/api/lr/listat", post(lukutila))
        .route("/api/lr/hae", post(lukutila))
        .route("/api/lr/laheta", post(lukutila))
        .with_state(tila)
}
