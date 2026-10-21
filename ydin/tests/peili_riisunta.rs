//! S-9a näkymän tarpeeseen (T-74, ARK-17-KORJAUS, T-57 (4)): `riisu` säilyttää työkalurivin, kysymyksen ja
//! vastauksen tiedot sekä liput, joten ikkunoidun solmun `/api/skoopit/<nimi>/viestit` = täyden solmun.

use scopes_ydin::api::{self, kello_ms, Tila};
use scopes_ydin::peili::{self, PeiliIkkuna};
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yksikko};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

static LASKURI: AtomicU32 = AtomicU32::new(0);
const AVAIN: &str = "koeavain-riisunta";
const ISTUNTO: &str = "11111111-2222-4333-8444-555555555555";
const TIEDOSTO: &str = "-home-koe/11111111-2222-4333-8444-555555555555.jsonl";
const VIESTIT: &str = "/api/skoopit/koe/viestit";

// ---- solmut ------------------------------------------------------------------------------------------------------

struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        Tmp(PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("peili-riisunta-{}-{n}.db", std::process::id())))
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
}

impl Solmu {
    async fn kaynnista(ikkuna_vrk: Option<u32>) -> Solmu {
        let tmp = Tmp::uusi();
        let varasto = Arc::new(Varasto::avaa(&tmp.0).unwrap());
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
            peili: PeiliIkkuna::uusi(ikkuna_vrk, 38),
        });
        let app = api::router_valilla(tila.clone(), Duration::from_millis(100));
        let kuuntelija = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let osoite = format!("http://{}", kuuntelija.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(kuuntelija, app).await.unwrap();
        });
        let s = Solmu {
            _tmp: tmp,
            tila,
            osoite,
        };
        // Yksi avoin istunto skoopissa `koe`, transkripti `TIEDOSTO`.
        let istunto = json!({
            "istunto": ISTUNTO, "skooppi": "koe", "tila": "idle", "kysely": false,
            "pakattu": false, "hereilla": true, "transkripti": TIEDOSTO,
            "alkoi": "2026-10-20T10:00:00.000Z", "ruutu": "%1",
        });
        let v = reqwest::Client::new()
            .post(format!("{}/api/lahde/istunnot", s.osoite))
            .bearer_auth(AVAIN)
            .json(&json!({"laite": "palvelin", "sisalto": [istunto]}))
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200);
        let v = reqwest::Client::new()
            .post(format!("{}/api/lahde/agy", s.osoite))
            .bearer_auth(AVAIN)
            .json(&json!({"laite": "palvelin", "sisalto": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(v.status(), 200);
        s
    }

    /// Kirjoittaa rivit yksiköinä `<TIEDOSTO>:<offset>` (offset = alkuperäisten rivien tavut + rivinvaihdot)
    /// `api::kirjoita_ja_ilmoita`n kautta: täysi solmu tallettaa sellaisenaan, ikkunoitu riisuu.
    async fn kirjoita(&self, yksikot: &[Vec<String>]) {
        let mut offset = 0u64;
        for rivit in yksikot {
            let y = Yksikko {
                polku: "peili".to_string(),
                id: format!("{TIEDOSTO}:{offset}"),
                versio: BTreeMap::from([("koe".to_string(), 1)]),
                aika: Hlc::nyt("koe", None, kello_ms()),
                sisalto: Some(serde_json::to_vec(rivit).unwrap()),
                poistettu: false,
            };
            assert!(api::kirjoita_ja_ilmoita(&self.tila, &y)
                .await
                .unwrap()
                .is_some());
            offset += rivit.iter().map(|r| r.len() as u64 + 1).sum::<u64>();
        }
    }

    async fn hae(&self, polku: &str) -> Value {
        let v = reqwest::Client::new()
            .get(format!("{}{polku}", self.osoite))
            .bearer_auth(AVAIN)
            .send()
            .await
            .unwrap();
        assert_eq!(v.status().as_u16(), 200);
        v.json().await.unwrap()
    }

    /// Viesti-lista kentittäin (id, rooli, teksti, aika, kysymykset, vastattu) sekä istunnon malli ja effort.
    async fn nakyma(&self) -> (Vec<Value>, Value, Value) {
        let r = self.hae(&format!("{VIESTIT}?since=0")).await;
        let viestit = r["muuttuneet"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                json!({
                    "id": v["id"], "rooli": v["rooli"], "teksti": v["teksti"], "aika": v["aika"],
                    "kysymykset": v["kysymykset"], "vastattu": v["vastattu"],
                })
            })
            .collect();
        let kokonainen = self.hae(VIESTIT).await;
        (
            viestit,
            kokonainen["istunto"]["malli"].clone(),
            kokonainen["istunto"]["effort"].clone(),
        )
    }
}

// ---- data --------------------------------------------------------------------------------------------------------

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

fn ts(i: u64) -> String {
    iso(kello_ms() - 3_600_000 + i * 1000)
}

fn assistant(i: u64, lohkot: Value) -> Value {
    json!({"type": "assistant", "timestamp": ts(i), "uuid": format!("a{i}"), "requestId": "r",
        "cwd": "/koe", "message": {"role": "assistant", "model": "m-1", "id": "msg", "content": lohkot}})
}

fn kayttaja(i: u64, sisalto: Value) -> Value {
    json!({"type": "user", "timestamp": ts(i), "uuid": format!("u{i}"), "cwd": "/koe",
        "message": {"role": "user", "content": sisalto}})
}

fn tyokalu(id: &str, nimi: &str, syote: Value) -> Value {
    json!({"type": "tool_use", "id": id, "name": nimi, "input": syote})
}

/// Korpus: kaikki lajit, liput, effort-kentät, .osa-vuorottelu, monirivinen ja yli 2 000 merkin komento.
fn korpus() -> Vec<String> {
    let isoke = "x".repeat(3000);
    let pitka_cd = format!("cd /{} && {}", "a".repeat(1790), "y".repeat(3000));
    let mut r: Vec<Value> = vec![
        kayttaja(1, json!("aloita työ")),
        // text–tool_use–text–tool_use–text: .osa-tunnisteet.
        {
            let mut a = assistant(
                2,
                json!([
                    {"type": "thinking", "thinking": "hmm"},
                    {"type": "text", "text": "ensin"},
                    tyokalu("t1", "Bash", json!({"command": "cd /a/b && git status\ntoinen rivi", "timeout": 5})),
                    {"type": "text", "text": "sitten"},
                    tyokalu("t2", "Edit", json!({"file_path": "/a/b/c.rs", "old_string": "x", "new_string": "y"})),
                    {"type": "text", "text": "lopuksi"},
                ]),
            );
            a["perTurnEffort"] = json!("high");
            a
        },
        kayttaja(
            3,
            json!([{"type": "tool_result", "tool_use_id": "t1", "content": isoke.clone()},
                   {"type": "tool_result", "tool_use_id": "t2", "content": "ok"}]),
        ),
        assistant(
            4,
            json!([tyokalu(
                "t3",
                "Bash",
                json!({"command": "cd \"/x y\" && ls -la"})
            )]),
        ),
        assistant(
            5,
            json!([tyokalu(
                "t4",
                "Bash",
                json!({"command": format!("cd /repo && {isoke}")})
            )]),
        ),
        assistant(
            6,
            json!([tyokalu(
                "t5",
                "Bash",
                json!({"command": format!("{}\nloppu", "z".repeat(2500))})
            )]),
        ),
        // Rajatapaus: cd-etuliite 1 800 merkkiä (alle 1 880) ja yli 2 000 merkin komento.
        assistant(
            7,
            json!([tyokalu("t6", "Bash", json!({"command": pitka_cd}))]),
        ),
        assistant(
            8,
            json!([tyokalu(
                "t7",
                "Read",
                json!({"file_path": "/a/b/lukuun.rs", "offset": 3})
            )]),
        ),
        assistant(
            9,
            json!([tyokalu(
                "t8",
                "Grep",
                json!({"pattern": "foo.*bar", "path": "/src"})
            )]),
        ),
        assistant(
            10,
            json!([tyokalu("t9", "Glob", json!({"pattern": "**/*.rs"}))]),
        ),
        assistant(
            11,
            json!([tyokalu(
                "t10",
                "Agent",
                json!({"description": "tutki", "subagent_type": "Explore", "prompt": isoke.clone()})
            )]),
        ),
        assistant(
            12,
            json!([tyokalu("t11", "Tuntematon", json!({"outo": "arvo"}))]),
        ),
        assistant(
            13,
            json!([tyokalu(
                "t12",
                "NotebookEdit",
                json!({"notebook_path": "/n/kirja.ipynb", "new_source": "x"})
            )]),
        ),
        // AskUserQuestion ja vastaus ylätason toolUseResult.answers-kentässä.
        assistant(
            14,
            json!([
                {"type": "text", "text": "kysyn"},
                tyokalu("q1", "AskUserQuestion", json!({"questions": [
                    {"question": "Kumpi?", "header": "Valinta", "multiSelect": false,
                     "options": [{"label": "A", "description": "ensimmäinen"}, {"label": "B"}]},
                    {"question": "Monta?", "multiSelect": true, "options": [{"label": "X"}, {"label": "Y"}]},
                ]})),
            ]),
        ),
        {
            let mut u = kayttaja(
                15,
                json!([{"type": "tool_result", "tool_use_id": "q1", "content": "User has answered"}]),
            );
            u["toolUseResult"] = json!({"questions": [], "answers": {"Kumpi?": "A", "Monta?": "X, Y"}, "iso": isoke});
            u
        },
        // Ali-agentin rivit (isSidechain) ja metarivi: näkymä ohittaa.
        {
            let mut a = assistant(
                16,
                json!([{"type": "text", "text": "ali-agentin teksti"},
                                              tyokalu("s1", "Bash", json!({"command": "ali"}))]),
            );
            a["isSidechain"] = json!(true);
            a["message"]["model"] = json!("sivu-malli");
            a["perTurnEffort"] = json!("low");
            a
        },
        {
            let mut u = kayttaja(17, json!("metateksti"));
            u["isMeta"] = json!(true);
            u
        },
        kayttaja(
            18,
            json!([{"type": "text", "text": "kysymys"}, {"type": "image", "source": {"data": "xx"}}]),
        ),
        {
            let mut a = assistant(19, json!([{"type": "text", "text": "viimeinen"}]));
            a["message"]["model"] = json!("m-2");
            a["effort"] = json!("xhigh");
            a
        },
        json!({"type": "progress", "data": "edistys"}),
        kayttaja(20, json!("<system-reminder>ohitetaan</system-reminder>")),
        kayttaja(21, json!("/komento arg")),
    ];
    r.push(json!({"type": "summary", "summary": "x"}));
    let mut ulos: Vec<String> = r.iter().map(Value::to_string).collect();
    ulos.push("ei json".to_string());
    ulos
}

async fn vertaa(rivit: Vec<Vec<String>>) -> (Vec<Value>, Value, Value) {
    let taysi = Solmu::kaynnista(None).await;
    let ikkunoitu = Solmu::kaynnista(Some(7)).await;
    taysi.kirjoita(&rivit).await;
    ikkunoitu.kirjoita(&rivit).await;
    let t = taysi.nakyma().await;
    let i = ikkunoitu.nakyma().await;
    assert_eq!(i.0.len(), t.0.len(), "viestimäärä");
    for (a, b) in t.0.iter().zip(&i.0) {
        assert_eq!(a, b, "viesti {}", a["id"]);
    }
    assert_eq!(i.1, t.1, "malli");
    assert_eq!(i.2, t.2, "effort");
    t
}

// ---- testit ------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ikkunoitu_nakyma_vastaa_taytta() {
    let (viestit, malli, effort) = vertaa(vec![korpus()]).await;
    let rooli = |r: &str| viestit.iter().filter(|v| v["rooli"] == r).count();
    // Kaikki lajit mukana, jotta vertailu ei ole tyhjän vertailua.
    assert!(rooli("tyokalu") >= 12, "työkalurivejä {}", rooli("tyokalu"));
    assert_eq!(rooli("kysymys"), 1);
    assert!(rooli("agentti") >= 5);
    assert!(rooli("kayttaja") >= 3);
    let teksti = |s: &str| viestit.iter().any(|v| v["teksti"] == s);
    assert!(teksti("$ git status"), "cd poistettu Bash-rivistä");
    assert!(teksti("$ ls -la"));
    assert!(teksti("✎ /a/b/c.rs"));
    assert!(teksti("luki lukuun.rs"));
    assert!(teksti("haki foo.*bar"));
    assert!(teksti("ali-agentti: tutki"));
    assert!(teksti("A\nX, Y"), "vastaus toolUseResult.answers-kentästä");
    assert!(!teksti("ali-agentin teksti") && !teksti("metateksti"));
    let kysymys = viestit.iter().find(|v| v["rooli"] == "kysymys").unwrap();
    assert_eq!(kysymys["vastattu"], true);
    assert_eq!(kysymys["kysymykset"].as_array().unwrap().len(), 2);
    // .osa-tunnisteet: rivin 2 viestit ensin / Bash / sitten / Edit / lopuksi.
    let id = |s: &str| viestit.iter().any(|v| v["id"] == format!("{ISTUNTO}:{s}"));
    assert!(id("2") && id("2.1") && id("2.2") && id("2.3") && id("2.4"));
    // Sivuketjun malli ja effort eivät vaikuta; pääketjun viimeinen assistant-rivi.
    assert_eq!(malli, "m-2");
    assert_eq!(effort, "xhigh");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maara_raja_leikkaa_molemmissa_samasta_kohdasta() {
    // 100 riviä: teksti + Bash-työkalu (2 viestiä/rivi) = 200 viestiä, kolmessa yksikössä.
    let rivit: Vec<String> = (0..100u64)
        .map(|i| {
            assistant(
                i,
                json!([{"type": "text", "text": format!("teksti {i}")},
                       tyokalu(&format!("t{i}"), "Bash", json!({"command": format!("cd /x && echo {i}")}))]),
            )
            .to_string()
        })
        .collect();
    let yksikot = vec![
        rivit[..30].to_vec(),
        rivit[30..65].to_vec(),
        rivit[65..].to_vec(),
    ];
    let (viestit, _, _) = vertaa(yksikot).await;
    assert_eq!(viestit.len(), 120);
    // Ensimmäinen näkyvä viesti on rivin 40 teksti (200 − 120 = 80 viestiä pudotettu = 40 riviä).
    assert_eq!(viestit[0]["id"], format!("{ISTUNTO}:41"));
    assert_eq!(viestit[1]["id"], format!("{ISTUNTO}:41.1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn todellinen_fixture_vastaa_taytta() {
    let teksti = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixture/peili-scopes macos.jsonl"
    ))
    .unwrap();
    let rivit: Vec<String> = teksti.lines().map(str::to_string).collect();
    // Fixturen aikaleimat ovat vanhoja: päivitä ne ikkunan sisään.
    let rivit: Vec<String> = rivit
        .into_iter()
        .map(|r| match serde_json::from_str::<Value>(&r) {
            Ok(Value::Object(mut o)) if o.contains_key("timestamp") => {
                o.insert("timestamp".into(), json!(ts(1)));
                Value::Object(o).to_string()
            }
            _ => r,
        })
        .collect();
    let (viestit, _, _) = vertaa(vec![rivit]).await;
    assert!(!viestit.is_empty());
}

#[test]
fn riisu_noudattaa_sopimusta() {
    let isoke = "ä".repeat(3000);
    let syote = vec![
        // 0: liput, effort, text + tool_use + thinking; tool_use'n ylimääräiset avaimet pois.
        json!({"type": "assistant", "timestamp": "t", "uuid": "u", "isSidechain": true, "isMeta": false,
               "perTurnEffort": "high", "effort": "low", "requestId": "r", "cwd": "/",
               "message": {"role": "assistant", "model": "m", "id": "x", "usage": {"a": 1}, "content": [
                   {"type": "thinking", "thinking": "hmm"},
                   {"type": "text", "text": "moi"},
                   {"type": "tool_use", "id": "t1", "name": "Bash", "caller": "x",
                    "input": {"command": format!("cd /a && {isoke}\nrivi2"), "timeout": 3, "description": "kuvaus\nrivi2",
                              "run_in_background": true}},
                   {"type": "tool_use", "id": "t2", "name": "Foo", "input": {"outo": 1, "path": 7, "pattern": ["a\nb"]}},
                   {"type": "tool_use", "id": "t3", "name": "Edit", "input": "ei objekti"},
               ]}})
        .to_string(),
        // 1: AskUserQuestion: questions kokonaan, muut avaimet pois.
        json!({"type": "assistant", "message": {"role": "assistant", "content": [
                   {"type": "tool_use", "id": "q", "name": "AskUserQuestion",
                    "input": {"questions": [{"question": "a\nb", "options": [{"label": "A"}]}], "command": "pois"}}]}})
        .to_string(),
        // 2: tool_result ilman sisältöä, ylätason toolUseResult vain answers.
        json!({"type": "user", "uuid": "u2", "toolUseResult": {"answers": {"K": "V"}, "iso": "pois"},
               "message": {"role": "user", "content": [
                   {"type": "tool_result", "tool_use_id": "q", "content": "pitkä"}, {"type": "image", "source": {}}]}})
        .to_string(),
        // 3: toolUseResult ilman answers-kenttää → ei toolUseResult-avainta.
        json!({"type": "user", "toolUseResult": {"stdout": "x"},
               "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "z"}]}})
        .to_string(),
        // 4: pelkkä thinking, tyhjä merkkijono, puuttuva message, muu type, ei JSON -> tynkä.
        json!({"type": "assistant", "isSidechain": true, "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "x"}]}}).to_string(),
        json!({"type": "user", "message": {"role": "user", "content": ""}}).to_string(),
        json!({"type": "user"}).to_string(),
        json!({"type": "system", "message": {"content": "x"}}).to_string(),
        "[1,2]".to_string(),
        "ei json".to_string(),
    ];
    let ulos = peili::riisu(&syote);
    assert_eq!(ulos.len(), syote.len());
    let v: Vec<Value> = ulos
        .iter()
        .map(|r| serde_json::from_str(r).unwrap())
        .collect();

    let rivi = v[0].as_object().unwrap();
    for avain in rivi.keys() {
        assert!(
            [
                "type",
                "timestamp",
                "uuid",
                "isSidechain",
                "isMeta",
                "perTurnEffort",
                "effort",
                "message"
            ]
            .contains(&avain.as_str()),
            "ylätason avain {avain}"
        );
    }
    assert_eq!(rivi["isSidechain"], true);
    assert_eq!(rivi["isMeta"], false);
    assert_eq!(rivi["perTurnEffort"], "high");
    assert_eq!(rivi["effort"], "low");
    let m = v[0]["message"].as_object().unwrap();
    assert_eq!(
        m.keys().map(String::as_str).collect::<Vec<_>>(),
        ["content", "model", "role"]
    );
    let c = m["content"].as_array().unwrap();
    assert_eq!(c.len(), 4, "thinking pois");
    assert_eq!(c[0], json!({"type": "text", "text": "moi"}));
    assert_eq!(c[1]["type"], "tool_use");
    assert_eq!(c[1]["id"], "t1");
    assert_eq!(c[1]["name"], "Bash");
    assert!(c[1].get("caller").is_none());
    let i = c[1]["input"].as_object().unwrap();
    assert_eq!(
        i.keys().map(String::as_str).collect::<Vec<_>>(),
        ["command", "description"]
    );
    let komento = i["command"].as_str().unwrap();
    assert_eq!(
        komento.chars().count(),
        2000,
        "enintään 2 000 merkkiä, UTF-8-rajalla"
    );
    assert!(komento.starts_with("cd /a && äää"));
    assert!(!komento.contains('\n'));
    assert_eq!(i["description"], "kuvaus", "ensimmäinen rivi");
    // Muut arvot sellaisinaan (luku, taulukko).
    assert_eq!(c[2]["input"], json!({"path": 7, "pattern": ["a\nb"]}));
    // Ei-objekti input -> tyhjä objekti (näkymä käsittelee samoin).
    assert_eq!(c[3]["input"], json!({}));

    assert_eq!(
        v[1]["message"]["content"][0]["input"],
        json!({"questions": [{"question": "a\nb", "options": [{"label": "A"}]}]})
    );

    assert_eq!(v[2]["toolUseResult"], json!({"answers": {"K": "V"}}));
    assert_eq!(
        v[2]["message"]["content"],
        json!([{"type": "tool_result", "tool_use_id": "q"}])
    );
    assert!(v[3].get("toolUseResult").is_none());
    assert_eq!(
        v[3]["message"]["content"],
        json!([{"type": "tool_result", "tool_use_id": "z"}])
    );

    assert_eq!(v[4], json!({"type": "assistant", "karsittu": true}));
    assert_eq!(v[5], json!({"type": "user", "karsittu": true}));
    assert_eq!(v[6], json!({"type": "user", "karsittu": true}));
    assert_eq!(v[7], json!({"type": "system", "karsittu": true}));
    assert_eq!(v[8], json!({"type": null, "karsittu": true}));
    assert_eq!(v[9], json!({"type": null, "karsittu": true}));
    assert!(!ulos.concat().contains("thinking"));
}

/// Vanha riisunta (T-54): vain text-lohkot. Vertailukohta kokosuhteelle.
fn vain_teksti(rivi: &str) -> String {
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(rivi) else {
        return json!({"type": null, "karsittu": true}).to_string();
    };
    let tyyppi = o.get("type").cloned().unwrap_or(Value::Null);
    let sisalto = match o.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(s)) if !s.is_empty() => Some(Value::String(s.clone())),
        Some(Value::Array(a)) => {
            let t: Vec<Value> = a
                .iter()
                .filter(|l| l.get("type").and_then(Value::as_str) == Some("text"))
                .cloned()
                .collect();
            (!t.is_empty()).then_some(Value::Array(t))
        }
        _ => None,
    };
    let (true, Some(sisalto)) = (
        matches!(tyyppi.as_str(), Some("user" | "assistant")),
        sisalto,
    ) else {
        return json!({"type": tyyppi, "karsittu": true}).to_string();
    };
    json!({"type": tyyppi, "timestamp": o.get("timestamp"), "uuid": o.get("uuid"),
        "message": {"role": o["message"].get("role"), "model": o["message"].get("model"), "content": sisalto}})
    .to_string()
}

/// Kohta 3: riisutun ja pelkän tekstin koon suhde (K-10: 7 vrk:n tekstihuippu 20,7 Mt / katto 38 Mt).
#[test]
fn kokosuhde_korpuksella() {
    let fixture = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixture/peili-scopes macos.jsonl"
    ))
    .unwrap();
    // Realistinen työkalupainotteinen korpus: 200 kierrosta (teksti + 3 työkalukutsua + tulokset 4 kt kukin).
    let mut tyo: Vec<String> = Vec::new();
    for i in 0..200u64 {
        tyo.push(
            assistant(
                i,
                json!([{"type": "text", "text": format!("Katson tiedostoa {i} ja ajan testit nyt.")},
                       tyokalu(&format!("a{i}"), "Read", json!({"file_path": format!("/repo/src/moduuli{i}.rs")})),
                       tyokalu(&format!("b{i}"), "Bash", json!({"command": format!("cd /repo && cargo test --test koe{i} -- --test-threads=1")})),
                       tyokalu(&format!("c{i}"), "Edit", json!({"file_path": format!("/repo/src/m{i}.rs"),
                           "old_string": "a".repeat(600), "new_string": "b".repeat(600)}))]),
            )
            .to_string(),
        );
        tyo.push(
            kayttaja(
                i,
                json!([{"type": "tool_result", "tool_use_id": format!("a{i}"), "content": "r".repeat(4000)},
                       {"type": "tool_result", "tool_use_id": format!("b{i}"), "content": "o".repeat(4000)},
                       {"type": "tool_result", "tool_use_id": format!("c{i}"), "content": "ok"}]),
            )
            .to_string(),
        );
    }
    for (nimi, rivit) in [
        ("korpus()", korpus()),
        ("fixture", fixture.lines().map(str::to_string).collect()),
        ("tyokorpus", tyo),
    ] {
        let raaka: usize = rivit.iter().map(String::len).sum();
        let uusi: usize = peili::riisu(&rivit).iter().map(String::len).sum();
        let teksti: usize = rivit.iter().map(|r| vain_teksti(r).len()).sum();
        eprintln!(
            "KOKO {nimi}: raaka {raaka} t, riisuttu {uusi} t, vain teksti {teksti} t, riisuttu/teksti {:.2}, riisuttu/raaka {:.3}",
            uusi as f64 / teksti as f64,
            uusi as f64 / raaka as f64
        );
        assert!(uusi <= raaka, "{nimi}: riisunta ei saa kasvattaa");
        assert!(uusi >= teksti, "{nimi}: uusi säilyttää vähintään tekstin");
    }
}

/// S-9a (7b72d610): lohkoton rivi, jolla on model tai effort, säilyy content []:lla; ilman niitä tynkä.
#[test]
fn lohkoton_rivi_mallitiedolla_sailyy() {
    let syote = vec![
        json!({"type": "assistant", "uuid": "a1", "requestId": "r",
               "message": {"role": "assistant", "model": "m-2", "id": "msg",
                           "content": [{"type": "thinking", "thinking": "hmm"}]}})
        .to_string(),
        json!({"type": "assistant", "uuid": "a2",
               "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}]}})
        .to_string(),
        json!({"type": "user", "uuid": "u1", "perTurnEffort": "high",
               "message": {"role": "user", "content": [{"type": "image", "source": {}}]}})
        .to_string(),
    ];
    let ulos: Vec<Value> = peili::riisu(&syote)
        .iter()
        .map(|r| serde_json::from_str(r).unwrap())
        .collect();
    assert_eq!(
        ulos[0],
        json!({"type": "assistant", "uuid": "a1",
               "message": {"role": "assistant", "model": "m-2", "content": []}})
    );
    assert_eq!(ulos[1], json!({"type": "assistant", "karsittu": true}));
    assert_eq!(
        ulos[2],
        json!({"type": "user", "uuid": "u1", "perTurnEffort": "high",
               "message": {"role": "user", "content": []}})
    );
}
