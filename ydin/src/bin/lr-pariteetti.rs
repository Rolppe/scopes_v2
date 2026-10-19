//! Apubinääri T-20:lle: `lr-pariteetti tuo <polku> <teksti1> <teksti2>`.
//!
//! Tuo rekisterin tekstistä 1 (`tuo_rekisteri`) ja uudelleentuo tekstillä 2 (`uudelleentuo`) tyhjään
//! varastoon laitteella `pariteetti` ja kiinteällä ajanhetkellä, ja tulostaa tiivisteen.
//! Tiivisteen kaava on sama kuin `scopes2/ydin/pariteetti.mjs`:n alussa (dokumentoitu siellä).

use scopes_ydin::yksikko::rekisteri::{Laite, Varasto};
use sha2::{Digest, Sha256};
use std::process::ExitCode;

const NYT: &str = "2026-10-19T00:00:00.000Z";
const LAITE: &str = "pariteetti";
const COMMIT: &str = "pariteetti";

fn sha(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn aja(polku: &str, teksti1: &str, teksti2: &str) -> Result<String, String> {
    let t1 = std::fs::read_to_string(teksti1).map_err(|e| format!("{teksti1}: {e}"))?;
    let t2 = std::fs::read_to_string(teksti2).map_err(|e| format!("{teksti2}: {e}"))?;
    let mut varasto = Varasto::default();
    let mut laite = Laite::uusi(LAITE);
    varasto
        .tuo_rekisteri(&mut laite, polku, &t1, COMMIT, NYT)
        .map_err(|e| e.to_string())?;
    varasto
        .uudelleentuo(&mut laite, polku, &t2, COMMIT, NYT)
        .map_err(|e| e.to_string())?;
    // rivi = id TAB versio TAB poistettu TAB sha256(sisalto); lajiteltu, liitetty "\n"
    let mut rivit: Vec<String> = varasto
        .lue_yksikot(polku)
        .iter()
        .map(|y| {
            let versio = y
                .versio
                .iter()
                .map(|(k, n)| format!("{k}={n}"))
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{}\t{}\t{}\t{}",
                y.id,
                versio,
                u8::from(y.poistettu),
                sha(&y.sisalto)
            )
        })
        .collect();
    rivit.sort();
    let yksikot = sha(&rivit.join("\n"));
    let rekisteri = varasto
        .rekisterin_tiiviste(polku)
        .map_err(|e| e.to_string())?;
    Ok(format!("{yksikot} {rekisteri}"))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let tulos = match args.as_slice() {
        [komento, polku, t1, t2] if komento == "tuo" => aja(polku, t1, t2),
        _ => Err("käyttö: lr-pariteetti tuo <polku> <teksti1> <teksti2>".to_string()),
    };
    match tulos {
        Ok(tiiviste) => {
            println!("{tiiviste}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("VIRHE: {e}");
            ExitCode::from(1)
        }
    }
}
