use axum::{routing::get, Json, Router};
use clap::Parser;
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "scopes-solmu")]
struct Args {
    /// Portti, jossa 127.0.0.1 kuuntelee
    #[arg(long, default_value_t = 8797)]
    portti: u16,
    /// Datahakemisto
    #[arg(long, default_value = "~/.local/share/scopes2-ydin")]
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
}

async fn terveys() -> Json<Value> {
    Json(json!({"ok": true, "v2": true, "seq": 0}))
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let app: Router = Router::new().route("/api/terveys", get(terveys));
    let osoite = format!("127.0.0.1:{}", args.portti);
    let kuuntelija = tokio::net::TcpListener::bind(&osoite)
        .await
        .expect("portin sidonta epäonnistui");
    axum::serve(kuuntelija, app).await.expect("palvelin kaatui");
}
