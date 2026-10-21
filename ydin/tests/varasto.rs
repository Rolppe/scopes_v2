//! Varasto (S-3): SQLite-skeema, kirjoitus yhdistäjillä, muutosloki, kursorit ja tiiviste.

use rusqlite::Connection;
use scopes_ydin::varasto::Varasto;
use scopes_ydin::yksikko::{Hlc, Yhdistaja, Yksikko};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static LASKURI: AtomicU32 = AtomicU32::new(0);

/// Väliaikainen tietokantatiedosto, joka poistetaan lopuksi.
struct Tmp(PathBuf);

impl Tmp {
    fn uusi() -> Tmp {
        let n = LASKURI.fetch_add(1, Ordering::SeqCst);
        let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("varasto-{}-{n}.db", std::process::id()));
        Tmp(p)
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

fn hlc(ms: u64, laskuri: u16, laite: &str) -> Hlc {
    Hlc {
        ms: 1_800_000_000_000 + ms,
        laskuri,
        laite: laite.to_string(),
    }
}

fn versio(osat: &[(&str, u64)]) -> BTreeMap<String, u64> {
    osat.iter().map(|(k, n)| (k.to_string(), *n)).collect()
}

fn yksikko(polku: &str, id: &str, v: &[(&str, u64)], aika: Hlc, sisalto: &str) -> Yksikko {
    Yksikko {
        polku: polku.to_string(),
        id: id.to_string(),
        versio: versio(v),
        aika,
        sisalto: Some(sisalto.as_bytes().to_vec()),
        poistettu: false,
    }
}

fn sisalto(y: &Yksikko) -> String {
    String::from_utf8(y.sisalto.clone().unwrap()).unwrap()
}

#[test]
fn avaus_ja_migraatio() {
    let tmp = Tmp::uusi();
    {
        let v = Varasto::avaa(&tmp.0).unwrap();
        assert_eq!(v.seq().unwrap(), 0);
        assert_eq!(v.kursori("x").unwrap(), 0);
    }
    let c = Connection::open(&tmp.0).unwrap();
    let tila: String = c
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tila, "wal");
    let skeema: String = c
        .query_row(
            "SELECT arvo FROM meta WHERE avain = 'skeemaversio'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(skeema, "2");
    for taulu in [
        "yksikot",
        "muutosloki",
        "laitteet",
        "liitteet",
        "kursorit",
        "meta",
    ] {
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [taulu],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "taulu {taulu}");
    }
    let indeksi: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'muutosloki_polku'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(indeksi, 1);
    drop(c);
    // Uudelleenavaus ei migroi toistamiseen eikä menetä dataa.
    let v = Varasto::avaa(&tmp.0).unwrap();
    assert_eq!(v.seq().unwrap(), 0);
}

#[test]
fn tuntematon_skeemaversio_hylataan() {
    let tmp = Tmp::uusi();
    drop(Varasto::avaa(&tmp.0).unwrap());
    let c = Connection::open(&tmp.0).unwrap();
    c.execute(
        "UPDATE meta SET arvo = '9' WHERE avain = 'skeemaversio'",
        [],
    )
    .unwrap();
    drop(c);
    assert!(Varasto::avaa(&tmp.0).is_err());
}

#[test]
fn kirjoita_ja_lue() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    let y = yksikko(
        "tila/a",
        "oneplus-1",
        &[("oneplus", 1)],
        hlc(0, 0, "oneplus"),
        "x",
    );
    assert_eq!(v.lue("tila/a", "oneplus-1").unwrap(), None);
    assert_eq!(v.kirjoita(&y, Yhdistaja::Lww).unwrap(), Some(1));
    assert_eq!(v.lue("tila/a", "oneplus-1").unwrap(), Some(y.clone()));
    assert_eq!(v.seq().unwrap(), 1);
    // Sama yksikkö uudelleen: ei muutosta, lokiin ei lisäyksiä.
    assert_eq!(v.kirjoita(&y, Yhdistaja::Lww).unwrap(), None);
    assert_eq!(v.seq().unwrap(), 1);
    // Hautakivi ja tyhjä sisältö säilyvät.
    let kivi = Yksikko {
        sisalto: None,
        poistettu: true,
        aika: hlc(5, 0, "oneplus"),
        ..y.clone()
    };
    assert_eq!(v.kirjoita(&kivi, Yhdistaja::Lww).unwrap(), Some(2));
    assert_eq!(v.lue("tila/a", "oneplus-1").unwrap(), Some(kivi));
}

#[test]
fn lww_korvaa_uudemmalla() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    let vanha = yksikko("asetukset/x", "a-1", &[("a", 1)], hlc(10, 0, "a"), "vanha");
    let uusi = yksikko("asetukset/x", "a-1", &[("a", 2)], hlc(20, 0, "a"), "uusi");
    assert_eq!(v.kirjoita(&vanha, Yhdistaja::Lww).unwrap(), Some(1));
    assert_eq!(v.kirjoita(&uusi, Yhdistaja::Lww).unwrap(), Some(2));
    assert_eq!(
        sisalto(&v.lue("asetukset/x", "a-1").unwrap().unwrap()),
        "uusi"
    );
    // Vanhempi ei korvaa.
    assert_eq!(v.kirjoita(&vanha, Yhdistaja::Lww).unwrap(), None);
    assert_eq!(
        sisalto(&v.lue("asetukset/x", "a-1").unwrap().unwrap()),
        "uusi"
    );
    // Saman ajan tasapeli ratkeaa suuremmalla laite-id:llä.
    let b = yksikko(
        "asetukset/x",
        "a-1",
        &[("b", 1)],
        hlc(20, 0, "b"),
        "b voittaa",
    );
    assert_eq!(v.kirjoita(&b, Yhdistaja::Lww).unwrap(), Some(3));
    assert_eq!(
        sisalto(&v.lue("asetukset/x", "a-1").unwrap().unwrap()),
        "b voittaa"
    );
    assert_eq!(v.seq().unwrap(), 3);
}

#[test]
fn lisays_ei_korvaa() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    let eka = yksikko("viestit/k", "a-1", &[("a", 1)], hlc(10, 0, "a"), "eka");
    let toinen = yksikko("viestit/k", "a-1", &[("a", 2)], hlc(99, 0, "a"), "toinen");
    assert_eq!(v.kirjoita(&eka, Yhdistaja::Lisays).unwrap(), Some(1));
    assert_eq!(v.kirjoita(&toinen, Yhdistaja::Lisays).unwrap(), None);
    assert_eq!(sisalto(&v.lue("viestit/k", "a-1").unwrap().unwrap()), "eka");
    // Uusi tunnus lisätään.
    let uusi = yksikko("viestit/k", "a-2", &[("a", 2)], hlc(11, 0, "a"), "uusi");
    assert_eq!(v.kirjoita(&uusi, Yhdistaja::Lisays).unwrap(), Some(2));
    assert_eq!(v.listaa("viestit/k").unwrap().len(), 2);
}

#[test]
fn lr_uudempi_korvaa_ja_rinnakkaiset_talteen() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    let p = "rekisterit/a/REKISTERI.md";
    let perus = yksikko(p, "a-000001", &[("a", 1)], hlc(1, 0, "a"), "perus");
    let uudempi = yksikko(p, "a-000001", &[("a", 2)], hlc(2, 0, "a"), "uudempi");
    assert_eq!(v.kirjoita(&perus, Yhdistaja::Lr).unwrap(), Some(1));
    assert_eq!(v.kirjoita(&uudempi, Yhdistaja::Lr).unwrap(), Some(2));
    // Vanhempi ja sama ohitetaan.
    assert_eq!(v.kirjoita(&perus, Yhdistaja::Lr).unwrap(), None);
    assert_eq!(v.kirjoita(&uudempi, Yhdistaja::Lr).unwrap(), None);
    // Rinnakkainen toiselta laitteelta: molemmat talteen, saapuva tunnuksella id~laite.
    let rinnakkainen = yksikko(p, "a-000001", &[("a", 1), ("b", 1)], hlc(3, 0, "b"), "b:n");
    assert_eq!(v.kirjoita(&rinnakkainen, Yhdistaja::Lr).unwrap(), Some(3));
    let oma = v.lue(p, "a-000001").unwrap().unwrap();
    assert_eq!(sisalto(&oma), "uudempi");
    let sisar = v.lue(p, "a-000001~b").unwrap().unwrap();
    assert_eq!(sisalto(&sisar), "b:n");
    assert_eq!(sisar.id, "a-000001~b");
    assert_eq!(sisar.versio, versio(&[("a", 1), ("b", 1)]));
    assert_eq!(v.listaa(p).unwrap().len(), 2);
    let loki = v.loki(2, 10).unwrap();
    assert_eq!(loki.len(), 1);
    assert_eq!(loki[0].seq, 3);
    assert_eq!(loki[0].id, "a-000001~b");
    // Sama rinnakkainen uudelleen: ei muutosta.
    assert_eq!(v.kirjoita(&rinnakkainen, Yhdistaja::Lr).unwrap(), None);
    assert_eq!(v.seq().unwrap(), 3);
}

#[test]
fn listaa_etuliite_valitsee_vain_etuliitteen() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    for (polku, id) in [
        ("rekisterit/a", "a-2"),
        ("rekisterit/a", "a-1"),
        ("rekisterit/b/c", "a-1"),
        ("lahde/x", "a-1"),
        ("tila/rekisterit/x", "a-1"),
        ("Rekisterit/iso", "a-1"),
    ] {
        let y = yksikko(polku, id, &[("a", 1)], hlc(1, 0, "a"), "s");
        assert!(v.kirjoita(&y, Yhdistaja::Lww).unwrap().is_some());
    }
    let r = v.listaa_etuliite("rekisterit/").unwrap();
    let avaimet: Vec<(&str, &str)> = r
        .iter()
        .map(|y| (y.polku.as_str(), y.id.as_str()))
        .collect();
    assert_eq!(
        avaimet,
        [
            ("rekisterit/a", "a-1"),
            ("rekisterit/a", "a-2"),
            ("rekisterit/b/c", "a-1")
        ]
    );
    assert_eq!(v.listaa_etuliite("lahde/").unwrap().len(), 1);
    // LIKE-jokerimerkit eivät ole jokereita.
    assert!(v.listaa_etuliite("rekisterit_").unwrap().is_empty());
    assert!(v.listaa_etuliite("%").unwrap().is_empty());
    assert_eq!(v.listaa_etuliite("").unwrap().len(), 6);
    assert_eq!(v.listaa("rekisterit/a").unwrap().len(), 2);
    assert!(v.listaa("rekisterit").unwrap().is_empty());
}

#[test]
fn loki_since_ja_raja() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    assert!(v.loki(0, 10).unwrap().is_empty());
    for n in 1..=5u64 {
        let y = yksikko(
            "tila/x",
            &format!("a-{n}"),
            &[("a", n)],
            hlc(n, 0, "a"),
            "s",
        );
        assert_eq!(v.kirjoita(&y, Yhdistaja::Lww).unwrap(), Some(n));
    }
    assert_eq!(v.seq().unwrap(), 5);
    let kaikki = v.loki(0, 100).unwrap();
    assert_eq!(kaikki.len(), 5);
    assert_eq!(
        kaikki.iter().map(|t| t.seq).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(kaikki[2].polku, "tila/x");
    assert_eq!(kaikki[2].id, "a-3");
    assert_eq!(kaikki[2].versio, versio(&[("a", 3)]));
    assert_eq!(kaikki[2].aika, hlc(3, 0, "a").to_string());
    let loppu = v.loki(3, 100).unwrap();
    assert_eq!(loppu.iter().map(|t| t.seq).collect::<Vec<_>>(), [4, 5]);
    let raja = v.loki(1, 2).unwrap();
    assert_eq!(raja.iter().map(|t| t.seq).collect::<Vec<_>>(), [2, 3]);
    assert!(v.loki(5, 10).unwrap().is_empty());
    // Ei muutosta -> ei lokiriviä.
    let sama = yksikko("tila/x", "a-5", &[("a", 5)], hlc(5, 0, "a"), "s");
    assert_eq!(v.kirjoita(&sama, Yhdistaja::Lww).unwrap(), None);
    assert_eq!(v.seq().unwrap(), 5);
}

#[test]
fn kursorit() {
    let tmp = Tmp::uusi();
    {
        let v = Varasto::avaa(&tmp.0).unwrap();
        assert_eq!(v.kursori("linux").unwrap(), 0);
        v.aseta_kursori("linux", 7).unwrap();
        v.aseta_kursori("mac", 3).unwrap();
        assert_eq!(v.kursori("linux").unwrap(), 7);
        v.aseta_kursori("linux", 9).unwrap();
        assert_eq!(v.kursori("linux").unwrap(), 9);
        assert_eq!(v.kursori("mac").unwrap(), 3);
    }
    // Kursorit säilyvät uudelleenavauksessa.
    let v = Varasto::avaa(&tmp.0).unwrap();
    assert_eq!(v.kursori("linux").unwrap(), 9);
}

#[test]
fn tiiviste_muuttuu_kirjoituksesta() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    let tyhja = v.tiiviste("tila/x").unwrap();
    assert_eq!(tyhja.len(), 64);
    assert_eq!(v.tiiviste("tila/x").unwrap(), tyhja);
    let a = yksikko("tila/x", "a-1", &[("a", 1)], hlc(1, 0, "a"), "s");
    v.kirjoita(&a, Yhdistaja::Lww).unwrap();
    let yksi = v.tiiviste("tila/x").unwrap();
    assert_ne!(yksi, tyhja);
    // Toisen polun kirjoitus ei muuta tätä tiivistettä.
    let muu = yksikko("tila/y", "a-1", &[("a", 1)], hlc(1, 0, "a"), "s");
    v.kirjoita(&muu, Yhdistaja::Lww).unwrap();
    assert_eq!(v.tiiviste("tila/x").unwrap(), yksi);
    // Uusi versio muuttaa.
    let a2 = yksikko("tila/x", "a-1", &[("a", 2)], hlc(2, 0, "a"), "s2");
    v.kirjoita(&a2, Yhdistaja::Lww).unwrap();
    let kaksi = v.tiiviste("tila/x").unwrap();
    assert_ne!(kaksi, yksi);
    // Uusi tunnus muuttaa.
    let b = yksikko("tila/x", "a-2", &[("a", 3)], hlc(3, 0, "a"), "b");
    v.kirjoita(&b, Yhdistaja::Lww).unwrap();
    assert_ne!(v.tiiviste("tila/x").unwrap(), kaksi);
    // Sama sisältö samalla tavalla kirjoitettuna toiseen varastoon antaa saman tiivisteen.
    let tmp2 = Tmp::uusi();
    let w = Varasto::avaa(&tmp2.0).unwrap();
    w.kirjoita(&b, Yhdistaja::Lww).unwrap();
    w.kirjoita(&a2, Yhdistaja::Lww).unwrap();
    assert_eq!(w.tiiviste("tila/x").unwrap(), v.tiiviste("tila/x").unwrap());
}

#[test]
fn listaa_vali_vain_valin_yksikot() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    for (polku, id) in [
        ("peili", "a:0"),
        ("peili", "a:10"),
        ("peili", "a:9"),
        ("peili", "ab:0"),
        ("peili", "a;0"),
        ("peili", "9:0"),
        ("muu", "a:5"),
    ] {
        let y = yksikko(polku, id, &[("a", 1)], hlc(1, 0, "a"), "s");
        v.kirjoita(&y, Yhdistaja::Lww).unwrap();
    }
    let idt = |alku: &str, loppu: &str| -> Vec<String> {
        v.listaa_vali("peili", alku, loppu)
            .unwrap()
            .into_iter()
            .map(|y| y.id)
            .collect()
    };
    // "a" on "ab":n etuliite: väli "a:" … "a;" ei sisällä ab:n eikä toisen polun yksiköitä.
    assert_eq!(idt("a:", "a;"), vec!["a:0", "a:10", "a:9"]);
    assert_eq!(idt("ab:", "ab;"), vec!["ab:0"]);
    assert!(idt("b:", "b;").is_empty());
}

#[test]
fn polut_erilliset() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    assert!(v.polut().unwrap().is_empty());
    for (polku, id) in [
        ("peili", "a:0"),
        ("peili", "a:8"),
        ("tila/x", "1"),
        ("lahde", "i"),
    ] {
        let y = yksikko(polku, id, &[("a", 1)], hlc(1, 0, "a"), "s");
        v.kirjoita(&y, Yhdistaja::Lww).unwrap();
    }
    let polut: Vec<String> = v.polut().unwrap().into_iter().collect();
    assert_eq!(polut, vec!["lahde", "peili", "tila/x"]);
}

#[test]
fn listaa_otsakkeet_ilman_sisaltoa() {
    let tmp = Tmp::uusi();
    let v = Varasto::avaa(&tmp.0).unwrap();
    let a = yksikko("peili", "f:0", &[("a", 1)], hlc(1, 0, "a"), "iso sisältö");
    let mut b = yksikko("peili", "f:12", &[("a", 2)], hlc(2, 0, "a"), "x");
    b.poistettu = true;
    v.kirjoita(&a, Yhdistaja::Lww).unwrap();
    v.kirjoita(&b, Yhdistaja::Lww).unwrap();
    v.kirjoita(
        &yksikko("muu", "f:0", &[("a", 1)], hlc(1, 0, "a"), "m"),
        Yhdistaja::Lww,
    )
    .unwrap();
    let otsakkeet = v.listaa_otsakkeet("peili").unwrap();
    let taydet = v.listaa("peili").unwrap();
    assert_eq!(otsakkeet.len(), 2);
    for (o, t) in otsakkeet.iter().zip(&taydet) {
        assert_eq!(o.sisalto, None);
        assert_eq!(
            (&o.polku, &o.id, &o.versio, &o.aika, o.poistettu),
            (&t.polku, &t.id, &t.versio, &t.aika, t.poistettu)
        );
    }
}

/// R-2: yhdistäjä valitaan yksiköstä — rekisterin sisarusyksikkö (`~` id:ssä) on Lww, muuten polun mukaan.
#[test]
fn yhdistaja_valitaan_yksikosta() {
    use scopes_ydin::yksikko::yhdistaja_yksikolle;
    let y = |polku: &str, id: &str| yksikko(polku, id, &[("a", 1)], hlc(1, 0, "a"), "x");
    assert_eq!(
        yhdistaja_yksikolle(&y("rekisterit/p", "x-1~c")),
        Yhdistaja::Lww
    );
    assert_eq!(
        yhdistaja_yksikolle(&y("rekisterit/p", "x-1")),
        Yhdistaja::Lr
    );
    assert_eq!(
        yhdistaja_yksikolle(&y("rekisterit-meta/p", "x~c")),
        Yhdistaja::Lww
    );
    assert_eq!(yhdistaja_yksikolle(&y("peili", "f:0")), Yhdistaja::Lisays);
}
