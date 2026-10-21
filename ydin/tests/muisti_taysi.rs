//! Täyden solmun huippumuisti (T-76, S-9 "Täysi solmu … huippumuisti", T-57 (6)).
//!
//! `taysi_solmu_muisti_ja_viestit`: pienemmän mittakaavan regressio oikealla `scopes-solmu`-prosessilla.
//! Synteettinen peili (~200 Mt, elävä 40 Mt:n transkripti ja 5 muuta elävää istuntoa) kirjoitetaan kantaan
//! ennen käynnistystä; kuorma = käynnistys, `/api/tiiviste`, `/api/listat`, `/api/hae` elävän transkriptin
//! yksiköille (myös yli `HAE_TAVUT`:n yksikkö) ja 12 `/api/skoopit/<nimi>/viestit`-pyyntöä. A:n
//! `MUISTI`-rivien (`SCOPES2_MUISTILOKI=1`) huippu < 128 MiB, ja viestit-vastaukset ovat tavulleen samat kuin
//! ennen T-76:n muutosta (`VERTAILU`, tallennettu muuttamattomalla koodilla).
//!
//! `luo_koepeili` (`#[ignore]`): `tools/muisti-koe.sh` luo sillä täyden mittakaavan peilin hakemistoon
//! `MUISTI_KOE_DATA` (≥ 2,5 Gt, ≥ 14 000 yksikköä, elävä ≥ 150 Mt:n transkripti ja 5 muuta elävää).

use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yhdistaja, Yksikko};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const AVAIN: &str = "koeavain-muisti-taysi";
const MIB: u64 = 1024 * 1024;
const PAIVA_MS: u64 = 86_400_000;
/// Pienen kokeen raja (brief T-76 kohta 5).
const RAJA: u64 = 128 * MIB;
/// Vertailun kiinteä perusaika (2026-09-01T00:00:00Z): sama korpus joka ajolla.
const PERUSAIKA_MS: u64 = 1_788_220_800_000;

/// Viestit-vastausten sha256 ja pituus ennen T-76:n muutosta (koodi cf76c427 + muistiloki, ei korjauksia).
const VERTAILU: &[(&str, &str, usize)] = &[
    (
        "/api/skoopit/koe-iso/viestit",
        "8149564fc103e305e417ac847a628366f39ce576e7ea0021269d3891398aef94",
        11609,
    ),
    (
        "/api/skoopit/koe-iso/viestit?since=0",
        "0fcb6785f4bd4357b28f3418c058a7ea3b8a955329ecd6c120b89f0cfd092d0b",
        14462,
    ),
    (
        "/api/skoopit/koe-elava-0/viestit",
        "fcaa4a72f35a4ea805205c7a4e6619344eb34cf32899e16a170f75e694227a69",
        8201,
    ),
    (
        "/api/skoopit/koe-elava-0/viestit?since=0",
        "0ce9bdf106caaa06147a17942fc100d700d28619d802bc9a9412408197fb170f",
        10368,
    ),
    (
        "/api/skoopit/koe-elava-1/viestit",
        "e6ad28d5e6072a6c86b05af4ec26d10c67cf03872241eb01490d2791ea5ffd65",
        11612,
    ),
    (
        "/api/skoopit/koe-elava-1/viestit?since=0",
        "8cb3811274fac68cd7d0045348e7c2426fdba3043360a03f66dec12f621b2700",
        14813,
    ),
    (
        "/api/skoopit/koe-elava-2/viestit",
        "e68fd4660f4279fb79e5472cc917c92065c71a65eb540bd07d723794ace2e863",
        11618,
    ),
    (
        "/api/skoopit/koe-elava-2/viestit?since=0",
        "311c7fd06d118b376c592e55d342a229702588d1ad08e6403c20ad33df9787c5",
        14821,
    ),
    (
        "/api/skoopit/koe-elava-3/viestit",
        "8b8217c8e1ac53fc55a05a83ba38bca5d2c179f9ae4cb419e862e3d3ee103cd2",
        11618,
    ),
    (
        "/api/skoopit/koe-elava-3/viestit?since=0",
        "c369dc98a896117063b0452ca7eb4cff8bc7c9e3c85859769b4ecb23f6b08e5b",
        14821,
    ),
    (
        "/api/skoopit/koe-elava-4/viestit",
        "36b9f59eb08b872c706d54ac5583f01d4238266c90b2b834fa3c8bf8b618dfa8",
        11618,
    ),
    (
        "/api/skoopit/koe-elava-4/viestit?since=0",
        "ed01f14c611d81faaa2212a114fbace746a74d63cdf24e7150fd96efde33bde8",
        14821,
    ),
];

// ---- synteettinen korpus ----------------------------------------------------------------------------------------

/// Myöhäisen vastauksen kysymystunnus (`Laji::MyohainenVastaus`).
const MYOHAINEN: u64 = 1_000_000;

/// Elävän tiedoston erityispiirre (näkymän rakennuksen reunat).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Laji {
    /// Tavallinen: vuoro (käyttäjä, agentti + työkalu, tulos) ja täyte; joka 25. vuoro kysymys + vastaus.
    Tavallinen,
    /// Harva: alle 120 viestiä koko tiedostossa (näkymä tarvitsee koko tiedoston).
    Harva,
    /// Myöhäinen vastaus: kysymys enintään 60 vuoroa ennen loppua, vastaus 5 vuoroa ennen loppua.
    MyohainenVastaus,
    /// Mallittomat: viimeisten (enintään) 80 vuoron agenttiriveillä ei ole mallia (malli on kauempana).
    Mallittomat,
}

struct Tiedosto {
    nimi: String,
    istunto: String,
    skooppi: Option<String>,
    tavut: u64,
    yksikko_tavut: u64,
    /// Yksi yli `HAE_TAVUT`:n yksikkö tiedoston puolivälissä (tavuina; 0 = ei).
    iso_yksikko: u64,
    laji: Laji,
    alku_ms: u64,
}

pub struct Mitat {
    yhteensa: u64,
    yksikot: u64,
    iso: u64,
    iso_yksikko: u64,
    muut_elavat: u64,
}

/// Rivi JSONina; `n` = rivin järjestysnumero tiedostossa, `ts` = aikaleima.
fn rivi_kayttaja(n: u64, ts: &str, teksti: String) -> String {
    json!({"type": "user", "uuid": format!("u-{n}"), "timestamp": ts, "isSidechain": false,
        "message": {"role": "user", "content": teksti}})
    .to_string()
}

fn rivi_agentti(n: u64, ts: &str, malli: bool, sivu: bool) -> String {
    let mut m = json!({"role": "assistant", "content": [
        {"type": "text", "text": format!("Vastaus {n}: tehdään näin.")},
        {"type": "tool_use", "id": format!("tu-{n}"), "name": "Bash",
            "input": {"command": format!("cd /tmp && ls -la /tmp/koe-{n}"), "description": "listaa"}},
        {"type": "text", "text": format!("Jälkiteksti {n}.")}
    ]});
    if malli {
        m["model"] = json!(format!("claude-koe-{}", n % 3));
    }
    json!({"type": "assistant", "uuid": format!("a-{n}"), "timestamp": ts, "isSidechain": sivu,
        "effort": if n.is_multiple_of(2) { "high" } else { "medium" }, "message": m})
    .to_string()
}

fn rivi_tulos(n: u64, ts: &str, koko: usize) -> String {
    json!({"type": "user", "uuid": format!("r-{n}"), "timestamp": ts, "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": format!("tu-{n}"), "content": "t".repeat(koko)}]}})
    .to_string()
}

fn rivi_kysymys(q: u64, ts: &str, malli: bool) -> String {
    let mut r = json!({"type": "assistant", "uuid": format!("k-{q}"), "timestamp": ts,
        "message": {"role": "assistant", "content": [
            {"type": "text", "text": format!("Kysyn {q}.")},
            {"type": "tool_use", "id": format!("q-{q}"), "name": "AskUserQuestion", "input": {"questions": [
                {"question": format!("Valitaanko {q}?"), "header": "Valinta",
                 "options": [{"label": "Kyllä", "description": "k"}, {"label": "Ei", "description": "e"}],
                 "multiSelect": false}]}}]}});
    if malli {
        r["message"]["model"] = json!("claude-koe-k");
    }
    r.to_string()
}

fn rivi_vastaus(q: u64, ts: &str) -> String {
    json!({"type": "user", "uuid": format!("v-{q}"), "timestamp": ts,
        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("q-{q}"),
            "content": "Käyttäjä vastasi"}]},
        "toolUseResult": {"answers": {format!("Valitaanko {q}?"): if q == MYOHAINEN { "Myöhään" } else { "Kyllä" }}}})
    .to_string()
}

fn rivi_tayte(ts: &str, koko: usize) -> String {
    json!({"type": "progress", "timestamp": ts, "data": "z".repeat(koko)}).to_string()
}

/// RFC 3339 -aikaleima (UTC, millisekunnit) Unix-ajasta.
fn iso(ms: u64) -> String {
    let (p, ms_paivassa) = ((ms / 86_400_000) as i64, ms % 86_400_000);
    let z = p + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let pv = doy - (153 * mp + 2) / 5 + 1;
    let kk = if mp < 10 { mp + 3 } else { mp - 9 };
    let vuosi = yoe + era * 400 + i64::from(kk <= 2);
    format!(
        "{vuosi:04}-{kk:02}-{pv:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms_paivassa / 3_600_000,
        ms_paivassa / 60_000 % 60,
        ms_paivassa / 1000 % 60,
        ms_paivassa % 1000
    )
}

/// Tiedoston rivit vuoroittain: kutsuu `f`:ää jokaiselle riville (rivi, aikaleima ms), kunnes `tavut` täyttyy.
fn tiedoston_rivit(t: &Tiedosto, mut f: impl FnMut(String, u64)) {
    // Vuoron täyte: harvassa tiedostossa vuoroja on vain ~30 (≈ 90 viestiä), muissa noin 100 kt:n välein.
    let vuoro_tavut = match t.laji {
        Laji::Harva => (t.tavut / 20).max(4096),
        _ => 100_000,
    };
    let vuoroja = (t.tavut / vuoro_tavut).max(1);
    // Myöhäinen kysymys enintään 60 vuoroa ennen loppua; mallittomat enintään 80 viimeistä vuoroa.
    let (kysymys_kohta, mallittomat) = (60.min(vuoroja - 2), 80.min(vuoroja - 5));
    let mut kirjoitettu = 0u64;
    let mut n = 0u64;
    let mut vuoro = 0u64;
    let mut kysymys = 0u64;
    let mut myohainen: Option<u64> = None;
    let mut rivi = |r: String, n: &mut u64, kirjoitettu: &mut u64| {
        let ms = t.alku_ms + *n * 1000;
        *kirjoitettu += r.len() as u64 + 1;
        *n += 1;
        f(r, ms);
    };
    while kirjoitettu < t.tavut {
        let ts = iso(t.alku_ms + n * 1000);
        let jaljella = vuoroja.saturating_sub(vuoro);
        let malli = !(t.laji == Laji::Mallittomat && jaljella <= mallittomat);
        rivi(
            rivi_kayttaja(
                n,
                &ts,
                format!("Pyyntö {vuoro}: tee seuraava vaihe {}", t.nimi),
            ),
            &mut n,
            &mut kirjoitettu,
        );
        let ts = iso(t.alku_ms + n * 1000);
        rivi(rivi_agentti(n, &ts, malli, false), &mut n, &mut kirjoitettu);
        let tu = n - 1;
        let ts = iso(t.alku_ms + n * 1000);
        rivi(
            json!({"type": "user", "uuid": format!("r-{tu}"), "timestamp": ts, "message": {"role": "user",
                "content": [{"type": "tool_result", "tool_use_id": format!("tu-{tu}"), "content": "ok"}]}})
            .to_string(),
            &mut n,
            &mut kirjoitettu,
        );
        if vuoro % 25 == 7 {
            let ts = iso(t.alku_ms + n * 1000);
            rivi(rivi_kysymys(kysymys, &ts, malli), &mut n, &mut kirjoitettu);
            let ts = iso(t.alku_ms + n * 1000);
            rivi(rivi_vastaus(kysymys, &ts), &mut n, &mut kirjoitettu);
            kysymys += 1;
        }
        if t.laji == Laji::MyohainenVastaus && jaljella == kysymys_kohta {
            let ts = iso(t.alku_ms + n * 1000);
            rivi(
                rivi_kysymys(MYOHAINEN, &ts, malli),
                &mut n,
                &mut kirjoitettu,
            );
            myohainen = Some(MYOHAINEN);
        }
        if jaljella == 5 {
            if let Some(q) = myohainen.take() {
                let ts = iso(t.alku_ms + n * 1000);
                rivi(rivi_vastaus(q, &ts), &mut n, &mut kirjoitettu);
            }
        }
        if vuoro % 40 == 13 {
            let ts = iso(t.alku_ms + n * 1000);
            rivi(rivi_agentti(n, &ts, true, true), &mut n, &mut kirjoitettu);
            let ts = iso(t.alku_ms + n * 1000);
            rivi(
                json!({"type": "user", "timestamp": ts, "isMeta": true,
                    "message": {"role": "user", "content": "meta"}})
                .to_string(),
                &mut n,
                &mut kirjoitettu,
            );
            let ts = iso(t.alku_ms + n * 1000);
            rivi(
                rivi_kayttaja(
                    n,
                    &ts,
                    "<system-reminder>muistutus</system-reminder>".into(),
                ),
                &mut n,
                &mut kirjoitettu,
            );
            let ts = iso(t.alku_ms + n * 1000);
            rivi(
                rivi_kayttaja(
                    n,
                    &ts,
                    "<command-name>/pura</command-name><command-args>scopes koe</command-args>"
                        .into(),
                ),
                &mut n,
                &mut kirjoitettu,
            );
        }
        // Täyte vuoron kokoon: iso työkalutulos ja edistymisrivit (~16 kt).
        let ts = iso(t.alku_ms + n * 1000);
        rivi(rivi_tulos(n, &ts, 12_000), &mut n, &mut kirjoitettu);
        let tavoite = (vuoro + 1) * vuoro_tavut;
        while kirjoitettu < tavoite && kirjoitettu < t.tavut {
            let ts = iso(t.alku_ms + n * 1000);
            let koko = (tavoite - kirjoitettu).clamp(200, 16_000) as usize;
            rivi(rivi_tayte(&ts, koko), &mut n, &mut kirjoitettu);
        }
        vuoro += 1;
    }
}

fn peiliyksikko(tiedosto: &str, alku: u64, rivit: &[String], ms: u64) -> Yksikko {
    Yksikko {
        polku: "peili".to_string(),
        id: format!("{tiedosto}:{alku}"),
        versio: BTreeMap::from([("a".to_string(), 1)]),
        aika: Hlc {
            ms,
            laskuri: 0,
            laite: "a".to_string(),
        },
        sisalto: Some(serde_json::to_vec(rivit).unwrap()),
        poistettu: false,
    }
}

/// Kirjoittaa tiedoston yksiköt varastoon; palauttaa (yksiköt, sisältötavut).
fn kirjoita_tiedosto(v: &Varasto, t: &Tiedosto) -> (u64, u64) {
    let puolivali = t.tavut / 2;
    let (mut yksikot, mut tavut) = (0u64, 0u64);
    let mut alku = 0u64;
    let mut kohta = 0u64;
    let mut kertyma: Vec<String> = Vec::new();
    let mut kertyma_tavut = 0u64;
    let mut suurin_ms = 0u64;
    let mut iso_tehty = t.iso_yksikko == 0;
    let mut tyhjenna = |kertyma: &mut Vec<String>, alku: &mut u64, kohta: u64, ms: u64| {
        if kertyma.is_empty() {
            return;
        }
        let y = peiliyksikko(&t.nimi, *alku, kertyma, ms);
        tavut += y.sisalto.as_ref().map_or(0, |s| s.len() as u64);
        yksikot += 1;
        v.kirjoita_sisaltoajalla(&y, Yhdistaja::Lww, Some(ms))
            .expect("peiliyksikön kirjoitus");
        kertyma.clear();
        *alku = kohta;
    };
    tiedoston_rivit(t, |r, ms| {
        let koko = r.len() as u64 + 1;
        kertyma.push(r);
        kertyma_tavut += koko;
        kohta += koko;
        suurin_ms = suurin_ms.max(ms);
        let raja = if !iso_tehty && kohta >= puolivali {
            t.iso_yksikko
        } else {
            t.yksikko_tavut
        };
        if kertyma_tavut >= raja {
            if raja == t.iso_yksikko {
                iso_tehty = true;
            }
            tyhjenna(&mut kertyma, &mut alku, kohta, suurin_ms);
            kertyma_tavut = 0;
        }
    });
    tyhjenna(&mut kertyma, &mut alku, kohta, suurin_ms);
    (yksikot, tavut)
}

fn lahdeyksikko(laji: &str, sisalto: &Value, ms: u64) -> Yksikko {
    Yksikko {
        polku: format!("lahde/{laji}"),
        id: "koe".to_string(),
        versio: BTreeMap::from([("a".to_string(), 1)]),
        aika: Hlc {
            ms,
            laskuri: 0,
            laite: "a".to_string(),
        },
        sisalto: Some(serde_json::to_vec(sisalto).unwrap()),
        poistettu: false,
    }
}

/// Luo korpuksen kantaan `data/ydin.db`. Elävät istunnot `lahde/istunnot`-yksikössä; vanhat tiedostot
/// jaetaan `vanha_vrk` vuorokaudelle ennen perusaikaa `nyt_ms`. Palauttaa (yksiköt, tavut, skoopit).
pub fn luo_korpus(data: &Path, m: &Mitat, nyt_ms: u64, vanha_vrk: u64) -> (u64, u64, Vec<String>) {
    std::fs::create_dir_all(data).unwrap();
    let v = Varasto::avaa(&data.join("ydin.db")).expect("varaston avaus");
    let elava_alku = nyt_ms - 2 * PAIVA_MS;
    let mut elavat = vec![Tiedosto {
        nimi: "iso.jsonl".into(),
        istunto: "istunto-iso".into(),
        skooppi: Some("koe-iso".into()),
        tavut: m.iso,
        yksikko_tavut: 256 * 1024,
        iso_yksikko: m.iso_yksikko,
        laji: Laji::Tavallinen,
        alku_ms: elava_alku,
    }];
    let lajit = [
        Laji::Harva,
        Laji::MyohainenVastaus,
        Laji::Mallittomat,
        Laji::Tavallinen,
        Laji::Tavallinen,
    ];
    let elava_tavut = (m.iso / 8).max(1_000_000);
    for i in 0..m.muut_elavat {
        elavat.push(Tiedosto {
            nimi: format!("elava-{i}.jsonl"),
            istunto: format!("istunto-elava-{i}"),
            skooppi: Some(format!("koe-elava-{i}")),
            tavut: elava_tavut,
            yksikko_tavut: 128 * 1024,
            iso_yksikko: 0,
            laji: lajit[(i as usize) % lajit.len()],
            alku_ms: elava_alku + (i + 1) * 3_600_000,
        });
    }
    let (mut yksikot, mut tavut) = (0u64, 0u64);
    let mut skoopit = Vec::new();
    for t in &elavat {
        let (y, b) = kirjoita_tiedosto(&v, t);
        yksikot += y;
        tavut += b;
        skoopit.extend(t.skooppi.clone());
    }
    // Vanhat (ei elävät) tiedostot: loput tavut ja yksiköt; ~9 yksikköä tiedostoa kohden.
    let jaljella_tavut = m.yhteensa.saturating_sub(tavut);
    let jaljella_yksikot = m.yksikot.saturating_sub(yksikot).max(1);
    let yksikko_tavut = (jaljella_tavut / jaljella_yksikot).max(16 * 1024);
    let tiedostoja = (jaljella_yksikot / 9).max(1);
    let tiedosto_tavut = jaljella_tavut / tiedostoja;
    for k in 0..tiedostoja {
        let t = Tiedosto {
            nimi: format!("vanha-{k:05}.jsonl"),
            istunto: format!("istunto-vanha-{k}"),
            skooppi: None,
            tavut: tiedosto_tavut,
            yksikko_tavut,
            iso_yksikko: 0,
            laji: Laji::Tavallinen,
            alku_ms: nyt_ms - (1 + k % vanha_vrk) * PAIVA_MS - (k % 7) * 3_600_000,
        };
        let (y, b) = kirjoita_tiedosto(&v, &t);
        yksikot += y;
        tavut += b;
    }
    let istunnot: Vec<Value> = elavat
        .iter()
        .map(|t| {
            json!({"istunto": t.istunto, "skooppi": t.skooppi, "transkripti": t.nimi,
                "nimi": t.skooppi, "tila": "kaynnissa", "alkoi": iso(t.alku_ms), "ruutu": "%1",
                "konteksti": 42})
        })
        .collect();
    v.kirjoita(
        &lahdeyksikko("istunnot", &Value::Array(istunnot), nyt_ms),
        Yhdistaja::Lww,
    )
    .unwrap();
    v.kirjoita(&lahdeyksikko("agy", &json!([]), nyt_ms), Yhdistaja::Lww)
        .unwrap();
    (yksikot, tavut, skoopit)
}

// ---- prosessi ---------------------------------------------------------------------------------------------------

struct Tmp(PathBuf);

impl Tmp {
    fn uusi(nimi: &str) -> Tmp {
        let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("muisti-taysi-{}-{nimi}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Solmu {
    lapsi: Child,
    portti: u16,
    loki: PathBuf,
}

impl Solmu {
    fn kaynnista(data: &Path, avain: &Path) -> Solmu {
        let portti = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let loki = data.with_extension("loki");
        let lapsi = Command::new(env!("CARGO_BIN_EXE_scopes-solmu"))
            .arg("--portti")
            .arg(portti.to_string())
            .arg("--data")
            .arg(data)
            .arg("--avain")
            .arg(avain)
            .env("SCOPES_LAITE", "koe-a")
            .env("SCOPES2_MUISTILOKI", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(std::fs::File::create(&loki).unwrap()))
            .spawn()
            .expect("scopes-solmun käynnistys");
        Solmu {
            lapsi,
            portti,
            loki,
        }
    }

    fn loki(&self) -> String {
        std::fs::read_to_string(&self.loki).unwrap_or_default()
    }

    /// Odottaa lokiin rivin, joka alkaa `alku`lla.
    async fn odota(&mut self, alku: &str, aika: Duration) {
        let raja = Instant::now() + aika;
        while !self.loki().lines().any(|r| r.starts_with(alku)) {
            if let Some(t) = self.lapsi.try_wait().unwrap() {
                panic!("solmu päättyi ({t}):\n{}", self.loki());
            }
            assert!(Instant::now() < raja, "ei riviä {alku}:\n{}", self.loki());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// SIGTERM ja odotus; palauttaa lokin.
    fn sammuta(mut self) -> String {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(self.lapsi.id().to_string())
            .status();
        let raja = Instant::now() + Duration::from_secs(20);
        while self.lapsi.try_wait().unwrap().is_none() && Instant::now() < raja {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.lapsi.kill();
        let _ = self.lapsi.wait();
        self.loki()
    }
}

impl Drop for Solmu {
    fn drop(&mut self) {
        let _ = self.lapsi.kill();
        let _ = self.lapsi.wait();
    }
}

/// `MUISTI <vaihe> <tavut>` -rivit (vaihe, tavut).
fn muistirivit(loki: &str) -> Vec<(String, u64)> {
    loki.lines()
        .filter_map(|r| r.strip_prefix("MUISTI "))
        .filter_map(|r| {
            let (vaihe, n) = r.rsplit_once(' ')?;
            Some((vaihe.to_string(), n.trim().parse().ok()?))
        })
        .collect()
}

/// `/api/hae`-vastaus (`replikointi::YksikotUlos`: `jatko` vain, jos ei tyhjä).
#[derive(Serialize, Deserialize)]
struct Haettu {
    yksikot: Vec<Yksikko>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    jatko: Vec<String>,
}

fn sha(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

#[tokio::test]
async fn taysi_solmu_muisti_ja_viestit() {
    let tmp = Tmp::uusi("a");
    let avain = tmp.0.join("avain");
    std::fs::write(&avain, format!("{AVAIN}\n")).unwrap();
    let data = tmp.0.join("a");
    let m = Mitat {
        yhteensa: 200_000_000,
        yksikot: 1_260,
        iso: 40_000_000,
        iso_yksikko: 9 * MIB,
        muut_elavat: 5,
    };
    let alku = Instant::now();
    let (yksikot, tavut, skoopit) = luo_korpus(&data, &m, PERUSAIKA_MS, 14);
    println!(
        "KORPUS: {yksikot} yksikköä, {tavut} t, {} s",
        alku.elapsed().as_secs()
    );
    assert!(
        tavut >= 200_000_000 && yksikot >= 1_200,
        "{tavut} {yksikot}"
    );

    let mut a = Solmu::kaynnista(&data, &avain);
    a.odota("MUISTI nakymat_kaynnistetty", Duration::from_secs(300))
        .await;
    let http = reqwest::Client::new();
    let url = |p: &str| format!("http://127.0.0.1:{}{p}", a.portti);

    // Täysi tasaus vertaisen tavoin elävän transkriptin yksiköille: tiiviste → listat → hae erissä.
    let r = http
        .get(url("/api/tiiviste"))
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success());
    let listat: Value = http
        .get(url("/api/listat?polku=peili"))
        .bearer_auth(AVAIN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let idt: Vec<String> = listat["yksikot"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|y| y["id"].as_str())
        .filter(|id| id.starts_with("iso.jsonl:"))
        .map(str::to_string)
        .collect();
    assert!(idt.len() > 100, "{}", idt.len());
    let mut haetut = 0usize;
    let mut suurin_vastaus = 0usize;
    for pala in idt.chunks(300) {
        let mut pyydetyt = pala.to_vec();
        loop {
            let r = http
                .post(url("/api/hae"))
                .bearer_auth(AVAIN)
                .json(&json!({"polku": "peili", "idt": pyydetyt}))
                .send()
                .await
                .unwrap();
            assert!(r.status().is_success());
            let pituus = r.content_length();
            let runko = r.bytes().await.unwrap();
            // Vastausmuoto ennallaan: serde_jsonin `YksikotUlos`-sarjallistus tavulleen ja Content-Length.
            let v: Haettu = serde_json::from_slice(&runko).unwrap();
            assert_eq!(
                serde_json::to_vec(&v).unwrap(),
                runko.to_vec(),
                "/api/hae-muoto"
            );
            assert_eq!(pituus, Some(runko.len() as u64), "Content-Length");
            suurin_vastaus = suurin_vastaus.max(runko.len());
            haetut += v.yksikot.len();
            if v.jatko.is_empty() {
                break;
            }
            pyydetyt = v.jatko;
        }
    }
    assert_eq!(haetut, idt.len());
    println!("HAE: {haetut} yksikköä, suurin vastaus {suurin_vastaus} t");
    assert!(
        suurin_vastaus > 30_000_000,
        "yli HAE_TAVUT:n yksikkö puuttui"
    );

    // 12 viestit-pyyntöä: jokainen elävä skooppi ilman since:ä ja since=0:lla (nollaus, tunnisteet mukana).
    let mut tulos: Vec<(String, String, usize)> = Vec::new();
    for s in &skoopit {
        for kysely in ["", "?since=0"] {
            let polku = format!("/api/skoopit/{s}/viestit{kysely}");
            let r = http
                .get(url(&polku))
                .bearer_auth(AVAIN)
                .send()
                .await
                .unwrap();
            assert!(r.status().is_success(), "{polku} {}", r.status());
            assert_eq!(
                r.headers().get("x-lahde").and_then(|h| h.to_str().ok()),
                Some("ydin"),
                "{polku}"
            );
            let runko = r.bytes().await.unwrap();
            let v: Value = serde_json::from_slice(&runko).unwrap();
            let n = v
                .get("viestit")
                .or_else(|| v.get("muuttuneet"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            println!("VIESTIT {polku}: {n} viestiä, {} t", runko.len());
            // Korpuksen reunat näkyvät vastauksessa: harva < 120, myöhäinen vastaus, malli kaukaa.
            let tekstit = |t: &str| {
                v["viestit"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|x| x["teksti"] == json!(t)))
            };
            match (s.as_str(), kysely) {
                ("koe-elava-0", "") => assert!(n < 120, "harva: {n}"),
                ("koe-elava-1", "") => assert!(tekstit("Myöhään"), "myöhäinen vastaus puuttuu"),
                ("koe-elava-2", "") => {
                    assert!(v["istunto"]["malli"].is_string(), "{}", v["istunto"])
                }
                _ => {}
            }
            tulos.push((polku, sha(&runko), runko.len()));
        }
    }

    let loki = a.sammuta();
    let rivit = muistirivit(&loki);
    for (vaihe, n) in &rivit {
        println!("MUISTI {vaihe} {n} ({} MiB)", n / MIB);
    }
    let huippu = rivit.iter().map(|(_, n)| *n).max().unwrap_or(0);
    assert!(
        rivit.iter().any(|(v, _)| v == "loppu"),
        "MUISTI loppu puuttuu:\n{loki}"
    );
    println!("HUIPPU: {huippu} t ({} MiB)", huippu / MIB);
    for (polku, h, n) in &tulos {
        println!("    (\"{polku}\", \"{h}\", {n}),");
    }
    assert!(!VERTAILU.is_empty(), "vertailukopio puuttuu");
    let odotettu: Vec<(String, String, usize)> = VERTAILU
        .iter()
        .map(|(p, h, n)| (p.to_string(), h.to_string(), *n))
        .collect();
    assert_eq!(tulos, odotettu, "viestit-vastaukset muuttuivat");
    assert!(
        huippu > 0 && huippu < RAJA,
        "huippumuisti {huippu} t ≥ 128 MiB"
    );
}

/// `tools/muisti-koe.sh`: täyden mittakaavan peili hakemistoon `MUISTI_KOE_DATA` (aikaleimat nykyhetkestä:
/// elävät 2 vrk:n sisällä, vanhat 14 vrk:lle). Tulostaa `SKOOPPI <nimi>` -rivit ja `KORPUS`-rivin.
#[tokio::test]
#[ignore]
async fn luo_koepeili() {
    let Some(data) = std::env::var_os("MUISTI_KOE_DATA") else {
        panic!("MUISTI_KOE_DATA puuttuu");
    };
    let m = Mitat {
        yhteensa: 2_600_000_000,
        yksikot: 14_500,
        iso: 160_000_000,
        iso_yksikko: 12 * MIB,
        muut_elavat: 5,
    };
    let nyt = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let alku = Instant::now();
    let (yksikot, tavut, skoopit) = luo_korpus(Path::new(&data), &m, nyt, 14);
    for s in &skoopit {
        println!("SKOOPPI {s}");
    }
    println!(
        "KORPUS {yksikot} yksikköä {tavut} tavua {} s",
        alku.elapsed().as_secs()
    );
    assert!(tavut >= 2_500_000_000 && yksikot >= 14_000);
}
