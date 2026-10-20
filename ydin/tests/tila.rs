//! Tilavarasto (T-27, S-4): LWW kahdella laitteella, kuittaus suurin-voittaa, etuliitehaku ja headless-suodatin.

use scopes_ydin::api::{self, Tila};
use scopes_ydin::tila::{nakyy, on_ui_avain, sovella};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-1234";

/// Väliaikainen tietokantatiedosto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("tila-{}-{n}.db", std::process::id())))
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        for pääte in ["", "-wal", "-shm"] {
            let mut s = self.0.clone().into_os_string();
            s.push(pääte);
            let _ = std::fs::remove_file(s);
        }
    }
}

struct Solmu {
    _tmp: Tmp,
    tila: Arc<Tila>,
    osoite: String,
    asiakas: reqwest::Client,
}

impl Solmu {
    async fn kaynnista(laite: &str, headless: bool) -> Solmu {
        let tmp = Tmp::uusi();
        let varasto = Arc::new(Varasto::avaa(&tmp.0).unwrap());
        let (lahetin, _) = tokio::sync::broadcast::channel(64);
        let tila = Arc::new(Tila {
            varasto,
            laite: laite.to_string(),
            headless,
            avain: AVAIN.to_string(),
            vanha: None,
            vanha_avain: None,
            vertaiset: vec![],
            lr_vertainen: None,
            lahetin,
            peili: Default::default(),
        });
        let app = api::router_valilla(tila.clone(), Duration::from_millis(100));
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        Solmu {
            _tmp: tmp,
            tila,
            osoite,
            asiakas: reqwest::Client::new(),
        }
    }

    async fn put(&self, avain: &str, arvo: Value) -> Value {
        let v = self
            .asiakas
            .put(format!("{}/api/tila/{avain}", self.osoite))
            .bearer_auth(AVAIN)
            .json(&json!({ "arvo": arvo }))
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200);
        v.json().await.unwrap()
    }

    async fn get(&self, polku: &str) -> reqwest::Response {
        self.asiakas
            .get(format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap()
    }

    /// Avaimen arvo ja HLC, tai None (404).
    async fn arvo(&self, avain: &str) -> Option<(Value, Hlc)> {
        let v = self.get(&format!("/api/tila/{avain}")).await;
        if v.status() == 404 {
            return None;
        }
        let j: Value = v.json().await.unwrap();
        Some((
            j["arvo"].clone(),
            Hlc::parse(j["aika"].as_str().unwrap()).unwrap(),
        ))
    }

    /// Vertaisen yksikkö saapuu replikoinnin kautta (`kirjoita_ja_ilmoita`).
    async fn saapuu(&self, y: &Yksikko) -> Option<u64> {
        api::kirjoita_ja_ilmoita(&self.tila, y).await.unwrap()
    }
}

fn yksikko(avain: &str, arvo: Value, laite: &str, ms: u64, laskuri: u16) -> Yksikko {
    Yksikko {
        polku: "tila".to_string(),
        id: avain.to_string(),
        versio: BTreeMap::from([(laite.to_string(), ms)]),
        aika: Hlc {
            ms,
            laskuri,
            laite: laite.to_string(),
        },
        sisalto: Some(serde_json::to_vec(&arvo).unwrap()),
        poistettu: false,
    }
}

/// Kaukainen tulevaisuus, jotta paikallinen kello ei ohita testin aikaleimoja.
const TULEVA: u64 = 4_000_000_000_000;

#[tokio::test]
async fn lww_myohempi_voittaa_kummassakin_jarjestyksessa() {
    let a = Solmu::kaynnista("a", false).await;
    let b = Solmu::kaynnista("b", false).await;
    let vanha = yksikko("valittu-skooppi", json!("vanha"), "a", TULEVA, 0);
    let uusi = yksikko("valittu-skooppi", json!("uusi"), "b", TULEVA + 5, 0);
    assert!(a.saapuu(&vanha).await.is_some());
    assert!(a.saapuu(&uusi).await.is_some());
    // Vanhempi myöhemmin: ei muutosta.
    assert!(a.saapuu(&vanha).await.is_none());
    assert_eq!(a.arvo("valittu-skooppi").await.unwrap().0, json!("uusi"));

    assert!(b.saapuu(&uusi).await.is_some());
    assert!(b.saapuu(&vanha).await.is_none());
    assert_eq!(b.arvo("valittu-skooppi").await.unwrap().0, json!("uusi"));
}

#[tokio::test]
async fn lww_sama_ms_suurempi_laite_id_voittaa() {
    let n = Solmu::kaynnista("c", false).await;
    let x = yksikko("suodatin", json!("a-arvo"), "a", TULEVA, 3);
    let y = yksikko("suodatin", json!("b-arvo"), "b", TULEVA, 3);
    for jarjestys in [[&x, &y], [&y, &x]] {
        let n = Solmu::kaynnista("c", false).await;
        for yks in jarjestys {
            n.saapuu(yks).await;
        }
        let (arvo, aika) = n.arvo("suodatin").await.unwrap();
        assert_eq!(arvo, json!("b-arvo"));
        assert_eq!(aika.laite, "b");
    }
    // Sama ms, suurempi laskuri voittaa ennen laite-id:tä.
    let z = yksikko("suodatin", json!("a-laskuri"), "a", TULEVA, 4);
    n.saapuu(&y).await;
    n.saapuu(&z).await;
    assert_eq!(n.arvo("suodatin").await.unwrap().0, json!("a-laskuri"));
}

#[tokio::test]
async fn paikallinen_put_kasvattaa_aikaa_ja_voittaa_vertaisen() {
    let n = Solmu::kaynnista("koe", false).await;
    assert!(n.arvo("agy-valinta").await.is_none());
    let t1 = n.put("agy-valinta", json!(1)).await;
    let t2 = n.put("agy-valinta", json!(2)).await;
    let a1 = Hlc::parse(t1["aika"].as_str().unwrap()).unwrap();
    let a2 = Hlc::parse(t2["aika"].as_str().unwrap()).unwrap();
    assert!(a2 > a1 && a2.laite == "koe");
    // Vertaisen tulevaisuuden kirjoitus voittaa, ja seuraava paikallinen PUT ohittaa sen (Hlc::nyt).
    n.saapuu(&yksikko("agy-valinta", json!("vieras"), "z", TULEVA, 0))
        .await;
    assert_eq!(n.arvo("agy-valinta").await.unwrap().0, json!("vieras"));
    let t3 = n.put("agy-valinta", json!(3)).await;
    let a3 = Hlc::parse(t3["aika"].as_str().unwrap()).unwrap();
    assert!(a3.ms >= TULEVA && a3 > Hlc::parse(&format!("{}", a2)).unwrap());
    let (arvo, aika) = n.arvo("agy-valinta").await.unwrap();
    assert_eq!(arvo, json!(3));
    assert_eq!(aika, a3);
}

#[tokio::test]
async fn kuittaus_suurin_voittaa() {
    let n = Solmu::kaynnista("koe", false).await;
    n.put("kuittaus/scopes macos", json!(5)).await;
    let (_, aika5) = n.arvo("kuittaus/scopes%20macos").await.unwrap();

    // Pienempi paikallinen PUT ei korvaa; vastaus on voimassa olevan yksikön aika.
    let t = n.put("kuittaus/scopes macos", json!(3)).await;
    assert_eq!(t["aika"], json!(aika5.to_string()));
    let (arvo, aika) = n.arvo("kuittaus/scopes%20macos").await.unwrap();
    assert_eq!((arvo, aika), (json!(5), aika5.clone()));

    // Suurempi korvaa.
    n.put("kuittaus/scopes macos", json!(9)).await;
    assert_eq!(n.arvo("kuittaus/scopes%20macos").await.unwrap().0, json!(9));

    // Vertaiselta pienempi arvo uudemmalla HLC:llä ei korvaa.
    let pienempi = yksikko("kuittaus/scopes macos", json!(2), "b", TULEVA, 0);
    assert!(n.saapuu(&pienempi).await.is_none());
    assert_eq!(n.arvo("kuittaus/scopes%20macos").await.unwrap().0, json!(9));

    // Vertaiselta suurempi arvo vanhemmalla HLC:llä voittaa; talletettu HLC on nykyisen jälkeen.
    let (_, ennen) = n.arvo("kuittaus/scopes%20macos").await.unwrap();
    let suurempi = yksikko("kuittaus/scopes macos", json!(40), "b", 1_000, 0);
    assert!(n.saapuu(&suurempi).await.is_some());
    let (arvo, jalkeen) = n.arvo("kuittaus/scopes%20macos").await.unwrap();
    assert_eq!(arvo, json!(40));
    assert!(jalkeen > ennen);

    // Uusi kuittaus, jota ei ollut: tallentuu sellaisenaan.
    let uusi = yksikko("kuittaus/toinen", json!(1), "b", 1_000, 0);
    assert!(n.saapuu(&uusi).await.is_some());
    assert_eq!(
        n.arvo("kuittaus/toinen").await.unwrap().1,
        uusi.aika.clone()
    );
}

#[tokio::test]
async fn kuittaus_suppenee_kahdella_solmulla() {
    let a = Solmu::kaynnista("a", false).await;
    let b = Solmu::kaynnista("b", false).await;
    a.put("kuittaus/x", json!(5)).await;
    b.put("kuittaus/x", json!(7)).await;
    // Vaihdetaan yksiköt molempiin suuntiin (kuten replikointi).
    let ya = a.tila.varasto.lue("tila", "kuittaus/x").unwrap().unwrap();
    let yb = b.tila.varasto.lue("tila", "kuittaus/x").unwrap().unwrap();
    a.saapuu(&yb).await;
    b.saapuu(&ya).await;
    assert_eq!(a.arvo("kuittaus/x").await.unwrap().0, json!(7));
    assert_eq!(b.arvo("kuittaus/x").await.unwrap().0, json!(7));
    // Toinen kierros: A:n mahdollisesti nostettu yksikkö siirtyy B:lle, jolloin ajat täsmäävät.
    let ya = a.tila.varasto.lue("tila", "kuittaus/x").unwrap().unwrap();
    b.saapuu(&ya).await;
    let yb = b.tila.varasto.lue("tila", "kuittaus/x").unwrap().unwrap();
    a.saapuu(&yb).await;
    assert_eq!(
        a.arvo("kuittaus/x").await.unwrap(),
        b.arvo("kuittaus/x").await.unwrap()
    );
}

#[tokio::test]
async fn etuliitehaku_ja_404() {
    let n = Solmu::kaynnista("koe", false).await;
    assert!(n.arvo("luonnos/a").await.is_none());
    n.put("luonnos/b", json!("2")).await;
    n.put("luonnos/a", json!("1")).await;
    n.put("vierityskohta/a", json!(10)).await;
    n.put("kuittaus/a", json!(4)).await;
    let v = n.get("/api/tila?etuliite=luonnos/").await;
    let j: Value = v.json().await.unwrap();
    let avaimet: Vec<&str> = j["tilat"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["avain"].as_str().unwrap())
        .collect();
    assert_eq!(avaimet, ["luonnos/a", "luonnos/b"]);
    let t = &j["tilat"][0];
    assert_eq!(t["arvo"], json!("1"));
    assert_eq!(t["laite"], json!("koe"));
    assert!(Hlc::parse(t["aika"].as_str().unwrap()).is_some());

    let j: Value = n
        .get("/api/tila?etuliite=kuittaus/")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(j["tilat"].as_array().unwrap().len(), 1);
    let j: Value = n
        .get("/api/tila?etuliite=ei-mitaan")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(j["tilat"], json!([]));
    let j: Value = n.get("/api/tila").await.json().await.unwrap();
    assert_eq!(j["tilat"].as_array().unwrap().len(), 4);
}

#[test]
fn ui_avaimet_tunnistetaan() {
    for avain in [
        "luonnos/scopes macos",
        "valittu-skooppi",
        "vierityskohta/chat",
        "purku-valinta/x",
        "agy-valinta",
        "piilotukset",
        "suodatin",
    ] {
        assert!(on_ui_avain(avain), "{avain}");
    }
    for avain in [
        "kuittaus/x",
        "asetukset/kieli",
        "luonnos",
        "muu",
        "x/luonnos/y",
    ] {
        assert!(!on_ui_avain(avain), "{avain}");
    }
}

#[tokio::test]
async fn headless_ohittaa_ui_avaimet_mutta_ei_kuittausta() {
    let h = Solmu::kaynnista("palvelin", true).await;
    // Vertaisen UI-avaimet ohitetaan sovellettaessa.
    for avain in [
        "luonnos/x",
        "valittu-skooppi",
        "vierityskohta/x",
        "purku-valinta/x",
        "agy-valinta",
        "piilotukset",
        "suodatin",
    ] {
        let y = yksikko(avain, json!(1), "puhelin", TULEVA, 0);
        assert!(!nakyy(&h.tila, &y), "{avain}");
        assert!(!sovella(&h.tila, &y), "{avain}");
        assert!(h.saapuu(&y).await.is_none(), "{avain}");
        assert!(h.tila.varasto.lue("tila", avain).unwrap().is_none());
    }
    // Kuittaus ja asetukset sovelletaan, ja kuittaus on suurin-voittaa myös headlessinä.
    let k = yksikko("kuittaus/x", json!(6), "puhelin", TULEVA, 0);
    assert!(sovella(&h.tila, &k));
    assert_eq!(h.arvo("kuittaus/x").await.unwrap().0, json!(6));
    let pienempi = yksikko("kuittaus/x", json!(2), "puhelin", TULEVA + 1, 0);
    assert!(sovella(&h.tila, &pienempi));
    assert_eq!(h.arvo("kuittaus/x").await.unwrap().0, json!(6));
    let a = yksikko("asetukset/kieli", json!("fi"), "puhelin", TULEVA, 0);
    assert!(sovella(&h.tila, &a));
    assert_eq!(h.arvo("asetukset/kieli").await.unwrap().0, json!("fi"));
    // Muiden polkujen yksiköitä suodatin ei kosketa.
    let muu = Yksikko {
        polku: "skoopit".to_string(),
        ..yksikko("luonnos/x", json!(1), "puhelin", TULEVA, 0)
    };
    assert!(nakyy(&h.tila, &muu));
}

#[tokio::test]
async fn headless_ei_laheta_ui_avaimia_replikoinnin_kautta() {
    let h = Solmu::kaynnista("palvelin", true).await;
    // Oma API sallii paikallisen PUT:n; replikointipolut eivät paljasta UI-avaimia.
    h.put("luonnos/x", json!("salainen")).await;
    h.put("kuittaus/x", json!(3)).await;
    h.put("asetukset/kieli", json!("fi")).await;
    assert!(h.arvo("luonnos/x").await.is_some());

    let lista: Value = h.get("/api/listat?polku=tila").await.json().await.unwrap();
    let idt: Vec<&str> = lista["yksikot"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(idt, ["asetukset/kieli", "kuittaus/x"]);

    let hae: Value = h
        .asiakas
        .post(format!("{}/api/hae", h.osoite))
        .bearer_auth(AVAIN)
        .json(&json!({"polku": "tila", "idt": ["luonnos/x", "kuittaus/x"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let haetut: Vec<&str> = hae["yksikot"]
        .as_array()
        .unwrap()
        .iter()
        .map(|y| y["id"].as_str().unwrap())
        .collect();
    assert_eq!(haetut, ["kuittaus/x"]);

    // Tiiviste ei muutu UI-avaimen kirjoituksesta.
    let t1: Value = h.get("/api/tiiviste").await.json().await.unwrap();
    h.put("suodatin", json!("uusi")).await;
    h.put("luonnos/y", json!("lisää")).await;
    let t2: Value = h.get("/api/tiiviste").await.json().await.unwrap();
    assert_eq!(t1["tiivisteet"]["tila"], t2["tiivisteet"]["tila"]);
    // Ei-headless-solmu näkee kaiken.
    let e = Solmu::kaynnista("laite", false).await;
    e.put("luonnos/x", json!(1)).await;
    let lista: Value = e.get("/api/listat?polku=tila").await.json().await.unwrap();
    assert_eq!(lista["yksikot"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn headless_pelkat_ui_avaimet_eivat_nay_tiivisteessa() {
    let h = Solmu::kaynnista("palvelin", true).await;
    h.put("luonnos/x", json!("a")).await;
    let t: Value = h.get("/api/tiiviste").await.json().await.unwrap();
    assert!(t["tiivisteet"].get("tila").is_none(), "{t}");
}
