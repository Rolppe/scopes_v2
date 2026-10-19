//! Vertaissolmut (SUUNNITELMA.md §3.3): osoitteet `--vertainen`-lipuista (`Tila.vertaiset`) ja varalle
//! ympäristömuuttujasta `SCOPES2_VERTAISET="url,url"`. Jokaiselle vertaiselle ajetaan oma
//! replikointisilmukka (`replikointi::silmukka`).

use crate::api::Tila;
use crate::replikointi;
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vertainen {
    /// Kursorin avain `kursorit`-taulussa: osoite ilman skeemaa (`host:portti`).
    pub id: String,
    /// `http://host:portti`
    pub osoite: String,
    /// Vertaisen Bearer-avain; siirtymässä sama avaintiedosto molemmilla.
    pub avain: String,
}

impl Vertainen {
    /// Vertainen osoitteesta; skeematon osoite saa `http://`-etuliitteen. Tyhjä osoite → `None`.
    pub fn osoitteesta(osoite: &str, avain: &str) -> Option<Vertainen> {
        let o = osoite.trim().trim_end_matches('/');
        if o.is_empty() {
            return None;
        }
        let osoite = if o.contains("://") {
            o.to_string()
        } else {
            format!("http://{o}")
        };
        let id = osoite
            .split_once("://")
            .map_or(osoite.as_str(), |(_, loppu)| loppu)
            .to_string();
        Some(Vertainen {
            id,
            osoite,
            avain: avain.to_string(),
        })
    }
}

/// Vertaiset `Tila.vertaiset`-listasta; tyhjä lista → `SCOPES2_VERTAISET`. Kaksoiskappaleet poistetaan.
pub fn vertaiset(tila: &Tila) -> Vec<Vertainen> {
    let lahteet: Vec<String> = if tila.vertaiset.is_empty() {
        std::env::var("SCOPES2_VERTAISET")
            .unwrap_or_default()
            .split(',')
            .map(str::to_string)
            .collect()
    } else {
        tila.vertaiset.clone()
    };
    let mut nahdyt = BTreeSet::new();
    lahteet
        .iter()
        .filter_map(|o| Vertainen::osoitteesta(o, &tila.avain))
        .filter(|v| nahdyt.insert(v.id.clone()))
        .collect()
}

/// Käynnistää replikointisilmukan jokaiselle vertaiselle; kahvan keskeytys pysäyttää kaikki.
pub fn kaynnista(tila: Arc<Tila>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let silmukat = vertaiset(&tila)
            .into_iter()
            .map(|v| replikointi::silmukka(tila.clone(), v));
        futures::future::join_all(silmukat).await;
    })
}
