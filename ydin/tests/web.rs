//! Web-asiakkaan staattinen tarjoilu (T-39, S-7): oikea palvelin satunnaisportissa.

use scopes_ydin::api::{self, Tila};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::web;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/// Väliaikainen kansio (web-hakemisto, ulkopuolinen tiedosto ja tietokanta), poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        let juuri = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("web-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&juuri);
        let web = juuri.join("dist");
        std::fs::create_dir_all(web.join("ali")).unwrap();
        std::fs::write(web.join("index.html"), "<html>kuori</html>").unwrap();
        std::fs::write(web.join("app.js"), "console.log(1)").unwrap();
        std::fs::write(web.join("app.css"), "body{}").unwrap();
        std::fs::write(web.join("sw.js"), "// sw").unwrap();
        std::fs::write(web.join("manifest.webmanifest"), "{}").unwrap();
        std::fs::write(web.join("ali/kuva.png"), "png").unwrap();
        std::fs::write(web.join("ali/outo.xyz"), "x").unwrap();
        std::fs::create_dir_all(web.join("kansio.js")).unwrap();
        std::fs::write(juuri.join("salainen.html"), "salaisuus").unwrap();
        std::os::unix::fs::symlink(juuri.join("salainen.html"), web.join("ulos.html")).unwrap();
        Tmp(juuri)
    }

    fn web(&self) -> PathBuf {
        self.0.join("dist")
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Palvelin {
    _tmp: Tmp,
    osoite: String,
    pelkka_api: String,
    asiakas: reqwest::Client,
}

async fn palvele(app: axum::Router) -> String {
    let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(kuuntelija, app).await.unwrap();
    });
    osoite
}

impl Palvelin {
    async fn kaynnista(web_kaytossa: bool) -> Palvelin {
        let tmp = Tmp::uusi();
        let varasto = Arc::new(Varasto::avaa(&tmp.0.join("ydin.db")).unwrap());
        let (lahetin, _) = tokio::sync::broadcast::channel(64);
        let tila = Arc::new(Tila {
            varasto,
            laite: "koe".to_string(),
            headless: false,
            avain: AVAIN.to_string(),
            vanha: None,
            vanha_avain: None,
            vertaiset: vec![],
            lr_vertainen: None,
            lahetin,
            peili: Default::default(),
        });
        let hakemisto = web_kaytossa.then(|| tmp.web());
        let osoite = palvele(api::router(tila.clone()).merge(web::reitit(hakemisto))).await;
        let pelkka_api = palvele(api::router(tila)).await;
        Palvelin {
            _tmp: tmp,
            osoite,
            pelkka_api,
            asiakas: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        }
    }

    async fn hae(&self, polku: &str) -> reqwest::Response {
        self.asiakas
            .get(format!("{}{polku}", self.osoite))
            .send()
            .await
            .unwrap()
    }

    /// Raakapyyntö ilman URL-normalisointia (esim. `/web/../x`); palauttaa tilarivin ja otsakkeet pienellä.
    async fn raaka(&self, polku: &str) -> (u16, String) {
        let osoite = self.osoite.trim_start_matches("http://");
        let mut s = tokio::net::TcpStream::connect(osoite).await.unwrap();
        let pyynto = format!("GET {polku} HTTP/1.1\r\nHost: {osoite}\r\nConnection: close\r\n\r\n");
        s.write_all(pyynto.as_bytes()).await.unwrap();
        let mut vastaus = String::new();
        s.read_to_string(&mut vastaus).await.unwrap();
        let tila = vastaus.split_whitespace().nth(1).unwrap().parse().unwrap();
        (tila, vastaus.to_lowercase())
    }
}

fn otsikko(v: &reqwest::Response, nimi: &str) -> String {
    v.headers()
        .get(nimi)
        .unwrap_or_else(|| panic!("otsake {nimi} puuttuu"))
        .to_str()
        .unwrap()
        .to_string()
}

fn tarkista_otsakkeet(v: &reqwest::Response) {
    assert_eq!(otsikko(v, "content-security-policy"), CSP);
    assert_eq!(otsikko(v, "x-content-type-options"), "nosniff");
    assert_eq!(otsikko(v, "referrer-policy"), "no-referrer");
    assert_eq!(otsikko(v, "x-lahde"), "ydin");
}

async fn tarkista_404(v: reqwest::Response) {
    assert_eq!(v.status(), 404);
    tarkista_otsakkeet(&v);
    let runko: Value = v.json().await.unwrap();
    assert_eq!(runko, json!({"virhe": "tuntematon polku"}));
}

#[tokio::test]
async fn juuri_ohjaa_webiin() {
    let p = Palvelin::kaynnista(true).await;
    let v = p.hae("/").await;
    assert_eq!(v.status(), 302);
    assert_eq!(otsikko(&v, "location"), "/web/");
}

#[tokio::test]
async fn indeksi_ja_otsakkeet() {
    let p = Palvelin::kaynnista(true).await;
    let v = p.hae("/web/").await;
    assert_eq!(v.status(), 200);
    tarkista_otsakkeet(&v);
    assert_eq!(otsikko(&v, "content-type"), "text/html; charset=utf-8");
    assert_eq!(otsikko(&v, "cache-control"), "no-cache");
    assert_eq!(v.text().await.unwrap(), "<html>kuori</html>");
    // index.html suoraan polulla
    let v = p.hae("/web/index.html").await;
    assert_eq!(v.status(), 200);
    assert_eq!(otsikko(&v, "cache-control"), "no-cache");
}

#[tokio::test]
async fn tyypit_ja_valimuisti() {
    let p = Palvelin::kaynnista(true).await;
    let v = p.hae("/web/app.js").await;
    assert_eq!(v.status(), 200);
    tarkista_otsakkeet(&v);
    assert_eq!(
        otsikko(&v, "content-type"),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(otsikko(&v, "cache-control"), "max-age=300");
    let v = p.hae("/web/app.css").await;
    assert_eq!(otsikko(&v, "content-type"), "text/css; charset=utf-8");
    assert_eq!(otsikko(&v, "cache-control"), "max-age=300");
    let v = p.hae("/web/sw.js").await;
    assert_eq!(otsikko(&v, "cache-control"), "no-cache");
    let v = p.hae("/web/manifest.webmanifest").await;
    assert_eq!(otsikko(&v, "content-type"), "application/manifest+json");
    assert_eq!(otsikko(&v, "cache-control"), "no-cache");
    let v = p.hae("/web/ali/kuva.png").await;
    assert_eq!(v.status(), 200);
    assert_eq!(otsikko(&v, "content-type"), "image/png");
    assert_eq!(otsikko(&v, "cache-control"), "max-age=300");
}

#[test]
fn sisaltotyypit() {
    use std::path::Path;
    let t = |s: &str| web::sisaltotyyppi(Path::new(s));
    assert_eq!(t("a.html"), Some("text/html; charset=utf-8"));
    assert_eq!(t("a.json"), Some("application/json"));
    assert_eq!(t("a.map"), Some("application/json"));
    assert_eq!(t("a.svg"), Some("image/svg+xml"));
    assert_eq!(t("a.xyz"), None);
    assert_eq!(t("ilman"), None);
}

#[tokio::test]
async fn kielletyt_polut_404() {
    let p = Palvelin::kaynnista(true).await;
    for polku in [
        "/web/ulos.html",
        "/web/ali/outo.xyz",
        "/web/puuttuu.js",
        "/web/kansio.js",
        "/web//app.js",
        "/web/ali",
    ] {
        let v = p.hae(polku).await;
        assert_eq!(v.status(), 404, "{polku}");
        tarkista_404(v).await;
    }
    // reqwest normalisoisi nämä (myös %2e%2e), joten ne lähetetään raakoina.
    for polku in [
        "/web/../Cargo.toml",
        "/web/ali/../../salainen.html",
        "/web/%2e%2e/x",
        "/web/%2E%2E/salainen.html",
    ] {
        let (tila, vastaus) = p.raaka(polku).await;
        assert_eq!(tila, 404, "{polku}");
        assert!(vastaus.contains("x-lahde: ydin"), "{polku}: {vastaus}");
        assert!(vastaus.contains("content-security-policy:"), "{polku}");
        assert!(!vastaus.contains("salaisuus"), "{polku}");
    }
}

#[tokio::test]
async fn muut_metodit_405_ja_head() {
    let p = Palvelin::kaynnista(true).await;
    for (metodi, polku) in [
        (reqwest::Method::POST, "/web/"),
        (reqwest::Method::PUT, "/web/app.js"),
        (reqwest::Method::DELETE, "/web/app.js"),
    ] {
        let v = p
            .asiakas
            .request(metodi, format!("{}{polku}", p.osoite))
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 405, "{polku}");
    }
    let v = p
        .asiakas
        .head(format!("{}/web/app.js", p.osoite))
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(
        otsikko(&v, "content-type"),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(v.text().await.unwrap(), "");
    let v = p
        .asiakas
        .head(format!("{}/web/", p.osoite))
        .send()
        .await
        .unwrap();
    assert_eq!(v.status(), 200);
    assert_eq!(v.text().await.unwrap(), "");
}

#[tokio::test]
async fn ilman_web_lippua_404() {
    let p = Palvelin::kaynnista(false).await;
    for polku in ["/web/", "/web/app.js"] {
        tarkista_404(p.hae(polku).await).await;
    }
}

#[tokio::test]
async fn api_pysyy_ennallaan() {
    let p = Palvelin::kaynnista(true).await;
    let v = p.hae("/api/skoopit").await;
    assert_eq!(v.status(), 401);
    assert!(v.headers().get("x-lahde").is_none());
    for polku in ["/api/x", "/api/kayttoraja"] {
        let pyynto = |osoite: &str| {
            p.asiakas
                .get(format!("{osoite}{polku}"))
                .bearer_auth(AVAIN)
                .send()
        };
        let a = pyynto(&p.osoite).await.unwrap();
        let b = pyynto(&p.pelkka_api).await.unwrap();
        assert_eq!(a.status(), b.status(), "{polku}");
        assert!(a.headers().get("content-security-policy").is_none());
        assert_eq!(a.text().await.unwrap(), b.text().await.unwrap(), "{polku}");
    }
}
