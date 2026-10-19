use clap::{Parser, Subcommand};
use scopes_ydin::api::{self, Tila};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::{lr, nakymat, vertaiset, web};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser, Debug)]
#[command(name = "scopes-solmu")]
struct Args {
    /// Portti, jossa 127.0.0.1 kuuntelee
    #[arg(long, default_value_t = 8797)]
    portti: u16,
    /// Datahakemisto
    #[arg(long, global = true, default_value = "~/.local/share/scopes2-ydin")]
    data: PathBuf,
    /// Avaintiedosto
    #[arg(long, default_value = "~/.config/scopes2/avain")]
    avain: PathBuf,
    #[arg(long)]
    headless: bool,
    /// Vanhan palvelun osoite
    #[arg(long)]
    vanha: Option<String>,
    #[arg(long, default_value = "~/.config/scopes/avain")]
    vanha_avain: PathBuf,
    /// Vertainen (toistettava)
    #[arg(long)]
    vertainen: Vec<String>,
    #[arg(long)]
    lr_vertainen: Option<String>,
    /// Web-asiakkaan hakemisto (tarjoillaan polusta /web/)
    #[arg(long)]
    web: Option<PathBuf>,
    #[command(subcommand)]
    komento: Option<Komento>,
}

#[derive(Subcommand, Debug)]
enum Komento {
    /// LR-työkalut
    Lr {
        #[command(subcommand)]
        lr: LrKomento,
    },
}

#[derive(Subcommand, Debug)]
enum LrKomento {
    /// Tulostaa `lr.mjs vie`:n tiedostot ilman gitiä: `<polku>\n<teksti>\n\0` per rekisteri
    Vie {
        /// Vain kuivaa ajoa tuetaan (ydin ei kirjoita gitiin)
        #[arg(long)]
        kuiva: bool,
        #[arg(long)]
        etuliite: String,
    },
}

/// Laajentaa alun `~/` HOME-hakemistoksi.
fn kotiin(p: PathBuf) -> PathBuf {
    match (p.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(loppu), Some(koti)) => PathBuf::from(koti).join(loppu),
        _ => p,
    }
}

/// Laite-id HLC:lle: SCOPES_LAITE, muuten koneen nimi, muuten "solmu".
fn laite_id() -> String {
    let nimi = std::env::var("SCOPES_LAITE")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .unwrap_or_default();
    let nimi: String = nimi.trim().chars().filter(|c| !c.is_whitespace()).collect();
    if nimi.is_empty() {
        "solmu".to_string()
    } else {
        nimi
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let data = kotiin(args.data);
    std::fs::create_dir_all(&data).expect("datahakemiston luonti epäonnistui");
    let varasto = Varasto::avaa(&data.join("ydin.db")).expect("varaston avaus epäonnistui");
    if let Some(Komento::Lr {
        lr: LrKomento::Vie { kuiva, etuliite },
    }) = args.komento
    {
        if !kuiva {
            eprintln!("lr vie: vain --kuiva tuetaan");
            std::process::exit(2);
        }
        let mut ulos = std::io::stdout().lock();
        for (polku, teksti) in lr::vie_kuiva(&varasto, &etuliite) {
            write!(ulos, "{polku}\n{teksti}\n\0").expect("stdout-kirjoitus epäonnistui");
        }
        ulos.flush().expect("stdout-kirjoitus epäonnistui");
        return;
    }
    let avain = api::lataa_avain(&kotiin(args.avain)).expect("avaimen luku tai luonti epäonnistui");
    let (lahetin, _) = tokio::sync::broadcast::channel(1024);
    let tila = Arc::new(Tila {
        varasto: Arc::new(varasto),
        laite: laite_id(),
        headless: args.headless,
        avain,
        vanha: args.vanha,
        vanha_avain: Some(kotiin(args.vanha_avain)),
        vertaiset: args.vertainen,
        lr_vertainen: args.lr_vertainen,
        lahetin,
    });
    let osoite = format!("127.0.0.1:{}", args.portti);
    let kuuntelija = tokio::net::TcpListener::bind(&osoite)
        .await
        .expect("portin sidonta epäonnistui");
    eprintln!("scopes-solmu kuuntelee {osoite}");
    let _replikointi = vertaiset::kaynnista(tila.clone());
    let _nakymat = nakymat::kaynnista(tila.clone());
    let _lr = lr::kaynnista(tila.clone());
    axum::serve(
        kuuntelija,
        api::router(tila).merge(web::reitit(args.web.map(kotiin))),
    )
    .await
    .expect("palvelin kaatui");
}
