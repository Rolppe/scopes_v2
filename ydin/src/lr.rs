// lr: runko (T-16-G) ja T-32:n signatuurit (T-31-G; rungot `todo!()` kunnes T-32 toteuttaa ne)

use crate::api::Tila;
use crate::replikointi::Result;
use crate::varasto::Varasto;
use crate::vertaiset::Vertainen;

/// Yhden synkan tulos: kuinka monta rekisteriä ja yksikköä haettiin vertaiselta.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Yhteenveto {
    pub rekisterit: usize,
    pub yksikot: usize,
}

pub fn reitit(_tila: std::sync::Arc<crate::api::Tila>) -> axum::Router {
    axum::Router::new()
}

/// Lukutila: tilaa vertaisen (LR 1) tiivisteen, hakee eroavat rekisterit ja tallettaa yksiköt polulle
/// `rekisterit/<polku>` (T-32).
pub async fn synkkaa(_tila: &Tila, _vertainen: &Vertainen) -> Result<Yhteenveto> {
    todo!("T-32")
}

/// Rekisterin yhteinen nykytila markdownina, identtinen `lr.mjs tulosta`:n kanssa (T-32).
pub fn teksti(_varasto: &Varasto, _polku: &str) -> String {
    todo!("T-32")
}
