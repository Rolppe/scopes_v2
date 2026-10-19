//! LR-pariteetti: `scopes/localregister/lr.test.mjs`:n 16 tapausta Rust-ytimen `yksikko::rekisteri`-moduulia
//! vasten. Syötteet ja odotukset ovat korpuksessa `tests/korpus/<nro>-<nimi>.json` (kopioitu lr.test.mjs:stä).
//! Git-repo ja komentorivi (tapaukset 15–16) on mallinnettu `rekisteri::Git`-rakenteella.

use scopes_ydin::yksikko::rekisteri::{
    avaimet, pilko, valiin, Git, Laite, Meta, Rivi, Uudelleentuonti, Varasto, Vastaanotto,
};
use scopes_ydin::yksikko::{vertaa, Versio, Vertailu};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const NYT: &str = "2026-10-19T00:00:00Z";

fn korpus(nimi: &str) -> Value {
    let polku = format!("{}/tests/korpus/{nimi}.json", env!("CARGO_MANIFEST_DIR"));
    let teksti = std::fs::read_to_string(&polku).unwrap_or_else(|e| panic!("{polku}: {e}"));
    serde_json::from_str(&teksti).unwrap_or_else(|e| panic!("{polku}: {e}"))
}

fn s(k: &Value, avain: &str) -> String {
    k[avain]
        .as_str()
        .unwrap_or_else(|| panic!("korpus: {avain}"))
        .to_string()
}

fn n(k: &Value, avain: &str) -> u64 {
    k[avain]
        .as_u64()
        .unwrap_or_else(|| panic!("korpus: {avain}"))
}

fn lista_s(k: &Value) -> Vec<String> {
    k.as_array()
        .unwrap_or_else(|| panic!("korpus: lista"))
        .iter()
        .map(|x| x.as_str().unwrap_or_default().to_string())
        .collect()
}

fn luvut(k: &Value) -> Vec<u64> {
    k.as_array()
        .unwrap_or_else(|| panic!("korpus: luvut"))
        .iter()
        .map(|x| x.as_u64().unwrap_or_default())
        .collect()
}

/// JS:n `teksti.replace(a, b)`-ketju: kukin pari korvaa ensimmäisen osuman.
fn korvaa(teksti: &str, parit: &Value) -> String {
    parit
        .as_array()
        .unwrap_or_else(|| panic!("korpus: korvaukset"))
        .iter()
        .fold(teksti.to_string(), |t, pari| {
            t.replacen(
                pari[0].as_str().unwrap_or_default(),
                pari[1].as_str().unwrap_or_default(),
                1,
            )
        })
}

fn versio(v: &Value) -> Versio {
    v.as_object()
        .unwrap_or_else(|| panic!("korpus: versio"))
        .iter()
        .map(|(k, n)| (k.clone(), n.as_u64().unwrap_or_default()))
        .collect()
}

fn lisatty(v: &Versio, laite: &str, n: u64) -> Versio {
    let mut v = v.clone();
    v.insert(laite.to_string(), n);
    v
}

fn ilman_lahdetta(y: Rivi) -> Rivi {
    Rivi {
        lahde_sisalto: None,
        lahde_versio: None,
        ..y
    }
}

fn uusi_rivi(k: &Value, p: &str, jarjestys: String) -> Rivi {
    Rivi {
        id: s(k, "id"),
        rekisteri: p.to_string(),
        laji: s(k, "laji"),
        osio: s(k, "osio"),
        jarjestys,
        sisalto: s(k, "sisalto"),
        versio: versio(&k["versio"]),
        muutettu: None,
        muuttaja: None,
        poistettu: false,
        lahde_sisalto: None,
        lahde_versio: None,
        rinnakkaiset: Vec::new(),
    }
}

fn rivi(v: &Varasto, p: &str, sisalto: &str) -> Rivi {
    v.lue_yksikot(p)
        .into_iter()
        .find(|y| y.sisalto == sisalto)
        .unwrap_or_else(|| panic!("ei riviä {sisalto:?}"))
}

fn id_lla(v: &Varasto, p: &str, id: &str) -> Rivi {
    v.lue_yksikot(p)
        .into_iter()
        .find(|y| y.id == id)
        .unwrap_or_else(|| panic!("ei tunnusta {id}"))
}

fn jarjestetyt(v: &Varasto, p: &str) -> Vec<Rivi> {
    let mut ys = v.lue_yksikot(p);
    ys.sort_by(|a, b| a.jarjestys.cmp(&b.jarjestys));
    ys
}

/// Äpin koskema rivi: versio ≠ lahdeVersio (lr.test.mjs:200-204).
fn appi_koskee(v: &mut Varasto, p: &str, rivi: &Rivi, sisalto: &str) {
    assert_eq!(rivi.rekisteri, p);
    let appi = ilman_lahdetta(Rivi {
        sisalto: sisalto.to_string(),
        versio: lisatty(&rivi.versio, "iphone", 1),
        muuttaja: Some("iphone".to_string()),
        ..rivi.clone()
    });
    assert_eq!(v.vastaanota(&[], &[appi]).unwrap().otettu, 1);
}

/// Tuotu rekisteri korpuksen `rek`, `polku` ja `laite` -kentistä.
fn tuotu(k: &Value) -> (Varasto, Laite, String, String) {
    let (p, rek) = (s(k, "polku"), s(k, "rek"));
    let mut laite = Laite::uusi(&s(k, "laite"));
    let mut v = Varasto::default();
    v.tuo_rekisteri(&mut laite, &p, &rek, "a", NYT).unwrap();
    (v, laite, p, rek)
}

fn nelja(t: &Uudelleentuonti) -> Vec<u64> {
    vec![t.muuttunut, t.uusi, t.poistettu, t.ristiriita]
}

#[test]
fn pilkonta_on_häviötön_ja_rivitasoinen() {
    let k = korpus("01-pilkonta");
    let rek = s(&k, "rek");
    let osat = pilko(&rek);
    assert_eq!(
        osat.iter().map(|o| o.sisalto.as_str()).collect::<String>(),
        rek
    );
    let lajit: Vec<String> = osat.iter().map(|o| o.laji.clone()).collect();
    assert_eq!(lajit, lista_s(&k["lajit"]));
    assert_eq!(osat[4].sisalto, s(&k, "osa4"));
}

#[test]
fn alkuun_tyhjät_rivit_ja_rivinvaihdoton_loppu_säilyvät() {
    let k = korpus("02-tyhjat-rivit");
    for t in lista_s(&k["tekstit"]) {
        assert_eq!(
            pilko(&t)
                .iter()
                .map(|o| o.sisalto.as_str())
                .collect::<String>(),
            t
        );
    }
}

#[test]
fn järjestysavaimet_tasaväli_ja_väliin_lisäys() {
    let k = korpus("03-jarjestysavaimet");
    let a = avaimet(n(&k, "n") as usize);
    let mut lajiteltu = a.clone();
    lajiteltu.sort();
    assert_eq!(lajiteltu, a);
    assert_eq!(a.iter().collect::<BTreeSet<_>>().len(), n(&k, "n") as usize);
    assert!(a.iter().all(|x| !x.ends_with('0')));
    let mut lista = lista_s(&k["alku"]);
    for i in 0..n(&k, "lisayksia") as usize {
        let j = (i * n(&k, "kerroin") as usize) % (lista.len() + 1);
        let ala = if j > 0 {
            lista[j - 1].clone()
        } else {
            String::new()
        };
        let yla = lista.get(j).cloned();
        let uusi = valiin(&ala, yla.as_deref()).unwrap();
        lista.insert(j, uusi);
    }
    let mut lajiteltu = lista.clone();
    lajiteltu.sort();
    assert_eq!(lajiteltu, lista);
    assert_eq!(lista.iter().collect::<BTreeSet<_>>().len(), lista.len());
}

#[test]
fn tuonti_tulostus_ja_tiiviste() {
    let k = korpus("04-tuonti-tulostus-tiiviste");
    let (p, rek) = (s(&k, "polku"), s(&k, "rek"));
    let mut laite = Laite::uusi(&s(&k, "laite"));
    let mut v = Varasto::default();
    v.tuo_rekisteri(&mut laite, &p, &rek, &s(&k, "lahde"), &s(&k, "nyt"))
        .unwrap();
    assert_eq!(v.tulosta(&p, false), rek);
    let e = v.tuo_rekisteri(&mut laite, &p, &rek, "", NYT).unwrap_err();
    assert!(e.0.contains(&s(&k, "virhe")), "{e}");
    let t = v.tiivisteet();
    assert_eq!(t.juuri.len(), 64);
    assert!(t
        .juuri
        .bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    assert_eq!(
        t.rekisterit.keys().cloned().collect::<Vec<_>>(),
        lista_s(&k["rekisterit"])
    );
    assert_eq!(v.tiivisteet().juuri, t.juuri);
}

#[test]
fn uudelleentuonti_muokattu_pitää_tunnuksen_poistettu_saa_hautakiven_uusi_asettuu_väliin() {
    let k = korpus("05-uudelleentuonti");
    let (mut v, mut laite, p, rek) = tuotu(&k);
    let ennen: BTreeMap<String, Rivi> = v
        .lue_yksikot(&p)
        .into_iter()
        .map(|y| (y.sisalto.clone(), y))
        .collect();
    let uusi = korvaa(&rek, &k["korvaukset"]);
    let t = v.uudelleentuo(&mut laite, &p, &uusi, "b", NYT).unwrap();
    let o = &k["odotettu"];
    assert_eq!(
        t,
        Uudelleentuonti {
            sama: n(o, "sama") as i64,
            muuttunut: n(o, "muuttunut"),
            uusi: n(o, "uusi"),
            poistettu: n(o, "poistettu"),
            ristiriita: n(o, "ristiriita"),
            viety: n(o, "viety"),
        }
    );
    assert_eq!(v.tulosta(&p, false), uusi);
    let muokattu = rivi(&v, &p, &s(&k, "muokattu"));
    let alkuperainen = &ennen[&s(&k, "muokattuEnnen")];
    assert_eq!(muokattu.id, alkuperainen.id);
    assert!(muokattu.versio["testi"] > alkuperainen.versio["testi"]);
    assert!(id_lla(&v, &p, &ennen[&s(&k, "poistettuEnnen")].id).poistettu);
    assert_eq!(
        rivi(&v, &p, &s(&k, "sailynyt")).id,
        ennen[&s(&k, "sailynyt")].id
    );
    assert_eq!(
        v.uudelleentuo(&mut laite, &p, &uusi, "c", NYT)
            .unwrap()
            .sama,
        -1
    );
    assert!(v.poista_rekisteri(&mut laite, &p).unwrap());
    assert!(!v.poista_rekisteri(&mut laite, &p).unwrap());
    v.uudelleentuo(&mut laite, &p, &rek, "d", NYT).unwrap();
    assert_eq!(v.tulosta(&p, false), rek);
}

#[test]
fn vertaa_versiovektorit() {
    let k = korpus("06-vertaa");
    for tapaus in k["tapaukset"].as_array().unwrap() {
        let odotettu = match tapaus[2].as_str().unwrap() {
            "sama" => Vertailu::Sama,
            "uudempi" => Vertailu::Uudempi,
            "vanhempi" => Vertailu::Vanhempi,
            _ => Vertailu::Rinnakkainen,
        };
        assert_eq!(
            vertaa(&versio(&tapaus[0]), &versio(&tapaus[1])),
            odotettu,
            "{tapaus}"
        );
    }
}

#[test]
fn äpin_muokkaus_ja_gitin_muutos_samaan_riviin_on_ristiriita_ei_ylikirjoitus() {
    let k = korpus("07-ristiriita");
    let (mut v, mut laite, p, rek) = tuotu(&k);
    let r = rivi(&v, &p, &s(&k, "rivi"));
    // Äppi muokkaa riviä ja lisää uuden rivin.
    let appi = ilman_lahdetta(Rivi {
        sisalto: s(&k, "appiSisalto"),
        versio: lisatty(&r.versio, "iphone", 1),
        muuttaja: Some("iphone".to_string()),
        ..r.clone()
    });
    let ur = &k["uusiRivi"];
    let alku: String = valiin(&r.jarjestys, None)
        .unwrap()
        .chars()
        .take(1)
        .collect();
    let uusi = uusi_rivi(ur, &p, alku + &s(ur, "jarjestysLiite"));
    let tulos = v.vastaanota(&[], &[appi.clone(), uusi]).unwrap();
    assert_eq!(tulos.otettu, n(&k, "otettu"));
    // Git muuttaa samaa riviä ja toista riviä.
    let git = korvaa(&rek, &k["git"]);
    let t = v.uudelleentuo(&mut laite, &p, &git, "b", NYT).unwrap();
    assert_eq!(t.ristiriita, n(&k, "ristiriita"));
    assert_eq!(t.muuttunut, n(&k, "muuttunut"));
    assert_eq!(v.tulosta(&p, true), git);
    let nyt = id_lla(&v, &p, &r.id);
    assert_eq!(nyt.sisalto, s(&k, "appiSisalto"));
    assert_eq!(nyt.rinnakkaiset[0].sisalto, s(&k, "rinnakkainen"));
    assert_eq!(v.ristiriidat().len(), 1);
    for osa in lista_s(&k["tulosteessa"]) {
        assert!(v.tulosta(&p, false).contains(&osa), "{osa}");
    }
    // Äppi ratkaisee: versio ≥ molempia → ristiriita poistuu.
    let rk = &k["ratkaisu"];
    let oneplus = nyt.versio["oneplus"].max(nyt.rinnakkaiset[0].versio["oneplus"]);
    let ratkaisu = ilman_lahdetta(Rivi {
        sisalto: s(rk, "sisalto"),
        versio: [
            ("oneplus".to_string(), oneplus),
            ("iphone".to_string(), n(rk, "iphone")),
        ]
        .into_iter()
        .collect(),
        rinnakkaiset: Vec::new(),
        ..nyt.clone()
    });
    assert_eq!(
        v.vastaanota(&[], &[ratkaisu]).unwrap().ristiriidat,
        Vec::<String>::new()
    );
    assert_eq!(v.ristiriidat().len(), 0);
    // Vanha versio ei kumoa uutta, ja sama rinnakkainen ei tallennu kahdesti.
    assert_eq!(v.vastaanota(&[], &[appi]).unwrap().ohitettu, 1);
    // Seuraava git-muutos samaan riviin on taas ristiriita, koska äppi on koskenut siihen.
    let git2 = korvaa(&git, &k["git2"]);
    assert_eq!(
        v.uudelleentuo(&mut laite, &p, &git2, "c", NYT)
            .unwrap()
            .ristiriita,
        n(&k, "ristiriita2")
    );
}

#[test]
fn vastaanota_hylkää_vieraat_polut_ja_tunnukset() {
    let k = korpus("08-vieraat-polut");
    let mut v = Varasto::default();
    let meta = |rekisteri: String, versio: Versio| Meta {
        rekisteri,
        versio,
        poistettu: false,
        lahde: None,
    };
    let a1: Versio = [("a".to_string(), 1)].into_iter().collect();
    for polku in lista_s(&k["vieraatPolut"]) {
        let e = v.vastaanota(&[meta(polku, a1.clone())], &[]).unwrap_err();
        assert!(e.0.contains(&s(&k, "virhePolku")), "{e}");
    }
    let m = &k["meta"];
    v.vastaanota(&[meta(s(m, "rekisteri"), versio(&m["versio"]))], &[])
        .unwrap();
    let vk = &k["vieras"];
    let vieras = Rivi {
        id: s(vk, "id"),
        rekisteri: s(vk, "rekisteri"),
        laji: String::new(),
        osio: String::new(),
        jarjestys: String::new(),
        sisalto: String::new(),
        versio: Versio::new(),
        muutettu: None,
        muuttaja: None,
        poistettu: false,
        lahde_sisalto: None,
        lahde_versio: None,
        rinnakkaiset: Vec::new(),
    };
    let e = v.vastaanota(&[], &[vieras]).unwrap_err();
    assert!(e.0.contains(&s(&k, "virheTunnus")), "{e}");
    let idt = lista_s(&k["haeIdt"]);
    let idt: Vec<&str> = idt.iter().map(String::as_str).collect();
    let e = v.hae(&s(&k, "haePolku"), &idt).unwrap_err();
    assert!(e.0.contains(&s(&k, "virhePolku")), "{e}");
}

#[test]
fn vastaanota_hylkää_rivinvaihdon_taulukkorivissä_kirjoittamatta_mitään() {
    let k = korpus("09-rivinvaihto-taulukkorivissa");
    let (mut v, _laite, p, rek) = tuotu(&k);
    let r = rivi(&v, &p, &s(&k, "rivi"));
    let muokattu = |pohja: &Rivi, kk: &Value| {
        ilman_lahdetta(Rivi {
            sisalto: s(kk, "sisalto"),
            versio: lisatty(&pohja.versio, "iphone", n(kk, "iphone")),
            ..pohja.clone()
        })
    };
    let ok = muokattu(&r, &k["ok"]);
    let rikki = muokattu(&r, &k["rikki"]);
    let e = v.vastaanota(&[], &[ok.clone(), rikki]).unwrap_err();
    assert!(e.0.contains(&s(&k, "virhe")), "{e}");
    assert_eq!(v.tulosta(&p, false), rek);
    let alussa = Rivi {
        sisalto: s(&k, "rikkiAlussa"),
        ..ok.clone()
    };
    let e = v.vastaanota(&[], &[alussa]).unwrap_err();
    assert!(e.0.contains(&s(&k, "virhe")), "{e}");
    // Sisennetty jatkorivi listassa ei ole taulukkorivi.
    let ak = &k["alkio"];
    let alkio = v
        .lue_yksikot(&p)
        .into_iter()
        .find(|y| y.laji == s(ak, "laji"))
        .unwrap();
    assert_eq!(
        v.vastaanota(&[], &[muokattu(&alkio, ak)]).unwrap().otettu,
        1
    );
    // Perässä olevat tyhjät rivit ja otsakkeen kaksi riviä kuuluvat yksikköön.
    let tyhjalla = Rivi {
        sisalto: s(&k, "okTyhjalla"),
        ..ok
    };
    assert_eq!(v.vastaanota(&[], &[tyhjalla]).unwrap().otettu, 1);
    let ok_ = &k["otsake"];
    let otsake = v
        .lue_yksikot(&p)
        .into_iter()
        .find(|y| y.laji == s(ok_, "laji"))
        .unwrap();
    let korvattu = Rivi {
        sisalto: otsake.sisalto.replacen(
            ok_["korvaus"][0].as_str().unwrap(),
            ok_["korvaus"][1].as_str().unwrap(),
            1,
        ),
        versio: lisatty(&otsake.versio, "iphone", n(ok_, "iphone")),
        ..otsake
    };
    assert_eq!(v.vastaanota(&[], &[korvattu]).unwrap().otettu, 1);
}

#[test]
fn äpin_lisäämä_rivi_taulukon_loppuun_säilyttää_taulukon_ja_kestää_uudelleentuonnin() {
    let k = korpus("10-apin-lisaama-rivi");
    let (mut v, mut laite, p, rek) = tuotu(&k);
    let ys = jarjestetyt(&v, &p);
    let i = ys
        .iter()
        .position(|y| y.sisalto == s(&k, "ankkuri"))
        .unwrap();
    let ankkuri = ilman_lahdetta(Rivi {
        sisalto: s(&k, "ankkuriUusi"),
        versio: lisatty(&ys[i].versio, "iphone", 1),
        muuttaja: Some("iphone".to_string()),
        ..ys[i].clone()
    });
    let jarj = valiin(&ys[i].jarjestys, Some(&ys[i + 1].jarjestys)).unwrap();
    let uusi = uusi_rivi(&k["uusi"], &p, jarj);
    assert_eq!(
        v.vastaanota(&[], &[ankkuri, uusi]).unwrap().otettu,
        n(&k, "otettu")
    );
    let odotettu = korvaa(&rek, &k["odotettu"]);
    assert_eq!(v.tulosta(&p, false), odotettu);
    let git = korvaa(&rek, &k["git"]);
    let t = v.uudelleentuo(&mut laite, &p, &git, "b", NYT).unwrap();
    assert_eq!(nelja(&t), luvut(&k["luvut"]));
    assert_eq!(v.tulosta(&p, false), korvaa(&odotettu, &k["git"]));
    assert_eq!(v.tulosta(&p, true), git);
}

#[test]
fn paritus_gitin_poistama_ja_eri_lisäämä_rivi_eivät_ole_saman_rivin_muokkaus_tuotannon_005655() {
    let k = korpus("11-paritus-poisto-ja-lisays");
    let (mut v, mut laite, p, rek) = tuotu(&k);
    let r = rivi(&v, &p, &s(&k, "rivi"));
    appi_koskee(&mut v, &p, &r, &r.sisalto);
    let git = korvaa(&rek, &k["git"]);
    let t = v.uudelleentuo(&mut laite, &p, &git, "b", NYT).unwrap();
    assert_eq!(nelja(&t), luvut(&k["luvut"]));
    assert_eq!(v.ristiriidat().len(), 0);
    assert_eq!(v.tulosta(&p, false), git);
    let vanha = id_lla(&v, &p, &r.id);
    assert!(vanha.poistettu);
    assert_eq!(
        vertaa(&vanha.versio, &lisatty(&r.versio, "iphone", 1)),
        Vertailu::Uudempi
    );
    assert_ne!(rivi(&v, &p, &s(&k, "uusiRivi")).id, r.id);
}

#[test]
fn paritus_äpin_muokkaama_rivi_jonka_git_korvaa_eri_rivillä_on_poistoriita_eikä_vieras_rinnakkainen(
) {
    let k = korpus("12-paritus-poistoriita");
    let (mut v, mut laite, p, rek) = tuotu(&k);
    let r = rivi(&v, &p, &s(&k, "rivi"));
    appi_koskee(&mut v, &p, &r, &s(&k, "appiSisalto"));
    let git = korvaa(&rek, &k["git"]);
    let t = v.uudelleentuo(&mut laite, &p, &git, "b", NYT).unwrap();
    assert_eq!(vec![t.uusi, t.poistettu, t.ristiriita], luvut(&k["luvut"]));
    let vanha = id_lla(&v, &p, &r.id);
    assert_eq!(vanha.sisalto, s(&k, "appiSisalto"));
    assert!(vanha.rinnakkaiset[0].poistettu);
    assert_eq!(v.tulosta(&p, true), git);
}

#[test]
fn paritus_samankaltainen_muokkaus_pitää_tunnuksen_myös_välissä_ja_palautettu_äppimuutos_ei_ole_riita(
) {
    let k = korpus("13-paritus-samankaltainen");
    let (mut v, mut laite, p, rek) = tuotu(&k);
    let r = rivi(&v, &p, &s(&k, "rivi"));
    let kaksi = rivi(&v, &p, &s(&k, "kaksi"));
    appi_koskee(&mut v, &p, &r, &r.sisalto);
    // Molemmat rivit muuttuvat ja väliin tulee uusi: c pitää avaimensa, lista-alkio Dice-samankaltaisena.
    let git = korvaa(&rek, &k["git"]);
    let t = v.uudelleentuo(&mut laite, &p, &git, "b", NYT).unwrap();
    assert_eq!(nelja(&t), luvut(&k["luvut"]));
    assert_eq!(id_lla(&v, &p, &r.id).sisalto, s(&k, "riviNyt"));
    assert_eq!(id_lla(&v, &p, &kaksi.id).sisalto, s(&k, "kaksiNyt"));
    assert_eq!(v.tulosta(&p, false), git);
}

#[test]
fn hautakivien_siivous_kivi_tiivistyy_merkinnäksi_vanha_versio_ei_herätä_sitä_uudempi_herättää_rinnakkainen_on_riita(
) {
    let k = korpus("14-hautakivien-siivous");
    let (mut v, mut laite, p, rek) = tuotu(&k);
    let ennen: BTreeMap<String, Rivi> = v
        .lue_yksikot(&p)
        .into_iter()
        .map(|y| (y.sisalto.clone(), y))
        .collect();
    // Git poistaa kaksi riviä; äppi poistaa gitissä yhä olevan rivin (sen kiveä ei siivota).
    let gitissa = ennen[&s(&k, "gitissa")].clone();
    let poisto = Rivi {
        poistettu: true,
        versio: lisatty(&gitissa.versio, "iphone", 1),
        ..gitissa.clone()
    };
    v.vastaanota(&[], &[poisto]).unwrap();
    let git = korvaa(&rek, &k["git"]);
    v.uudelleentuo(&mut laite, &p, &git, "b", NYT).unwrap();
    let tiiviste_ennen = v.tiivisteet().juuri;
    let teksti_ennen = v.tulosta(&p, false);
    let kivi_ennen = &ennen[&s(&k, "kivi")];
    let toinen = &ennen[&s(&k, "toinen")];
    let kivi = id_lla(&v, &p, &kivi_ennen.id);
    assert_eq!(v.siivoa(&p) as u64, n(&k, "siivottu"));
    assert_eq!(v.siivoa(&p), 0);
    let siivotut = v.lue_siivotut(&p);
    let mut odotetut = vec![kivi_ennen.id.clone(), toinen.id.clone()];
    odotetut.sort();
    assert_eq!(siivotut.keys().cloned().collect::<Vec<_>>(), odotetut);
    assert!(id_lla(&v, &p, &gitissa.id).poistettu);
    assert_eq!(v.tulosta(&p, false), teksti_ennen);
    assert_eq!(v.tulosta(&p, true), git);
    assert_ne!(v.tiivisteet().juuri, tiiviste_ennen);
    assert_eq!(v.lista(&p).unwrap().siivotut, siivotut);
    let rivinvaihdolla = format!("{git}\n");
    assert_eq!(
        v.uudelleentuo(&mut laite, &p, &rivinvaihdolla, "c", NYT)
            .unwrap()
            .ristiriita,
        0
    );
    // Laite, joka ei ole nähnyt poistoa, lähettää vanhan elävän version tai saman kiven: ei herää.
    let elava = ilman_lahdetta(kivi_ennen.clone());
    let sama_kivi = Rivi {
        poistettu: true,
        versio: kivi.versio.clone(),
        ..elava.clone()
    };
    assert_eq!(
        v.vastaanota(&[], &[elava.clone(), sama_kivi])
            .unwrap()
            .ohitettu,
        2
    );
    assert!(!v.lue_yksikot(&p).iter().any(|y| y.id == elava.id));
    // Rinnakkainen muokkaus (offline-laite muokkasi riviä, jonka toinen poisti): kivi palaa ja riita kysytään.
    let ok = &k["offline"];
    let rinn = Rivi {
        sisalto: s(ok, "sisalto"),
        versio: lisatty(&elava.versio, "iphone", n(ok, "iphone")),
        ..elava.clone()
    };
    assert_eq!(
        v.vastaanota(&[], &[rinn]).unwrap().ristiriidat,
        vec![elava.id.clone()]
    );
    let riita = id_lla(&v, &p, &elava.id);
    assert!(riita.poistettu);
    assert_eq!(riita.versio, kivi.versio);
    assert_eq!(riita.rinnakkaiset[0].sisalto, s(ok, "sisalto"));
    assert!(!v.lue_siivotut(&p).contains_key(&elava.id));
    assert_eq!(v.siivoa(&p), 0);
    // Uudempi versio (kiven nähnyt laite herätti rivin) herättää suoraan.
    let hk = &k["herata"];
    let herata = ilman_lahdetta(Rivi {
        sisalto: s(hk, "sisalto"),
        poistettu: false,
        versio: lisatty(&siivotut[&toinen.id], "iphone", n(hk, "iphone")),
        ..toinen.clone()
    });
    assert_eq!(
        v.vastaanota(&[], &[herata]).unwrap(),
        Vastaanotto {
            otettu: 1,
            ohitettu: 0,
            ristiriidat: Vec::new(),
            muuttuneet: [p.clone()].into_iter().collect(),
        }
    );
    assert!(v.tulosta(&p, false).contains(&s(hk, "sisalto")));
    assert!(v.lue_siivotut(&p).is_empty());
}

#[test]
fn tuo_komento_siivoaa_lopuksi_hautakivet_localregister_siivous_tuotanto() {
    let k = korpus("15-tuo-siivoaa");
    let (p, rek) = (s(&k, "polku"), s(&k, "rek"));
    let mut laite = Laite::uusi(&s(&k, "laite"));
    let mut v = Varasto::default();
    let mut git = Git::default();
    git.kirjoita(&p, &rek);
    git.committaa(&p, "a").unwrap();
    let rivi1 = v.tuo(&mut laite, &git, NYT).unwrap().rivi();
    assert!(rivi1.ends_with(&s(&k, "ensin")), "{rivi1}");
    git.kirjoita(&p, &korvaa(&rek, &k["git"]));
    git.committaa(&p, "b").unwrap();
    let rivi2 = v.tuo(&mut laite, &git, NYT).unwrap().rivi();
    let sitten = lista_s(&k["sitten"]);
    assert!(
        rivi2.contains(&sitten[0]) && rivi2.ends_with(&sitten[1]),
        "{rivi2}"
    );
    assert_eq!(v.lue_siivotut(&p).len() as u64, n(&k, "siivotut"));
    assert!(!v.lue_yksikot(&p).iter().any(|y| y.poistettu));
}

#[test]
fn vienti_lr_git_äpin_muutokset_commitiksi_paluu_ei_ole_riita_eikä_kahdenna_muut_etuliitteet_ennallaan_localregister_vienti(
) {
    let k = korpus("16-vienti");
    let rek = s(&k, "rek");
    let (sp, mp, etuliite) = (s(&k, "S"), s(&k, "M"), s(&k, "etuliite"));
    let (sp, mp) = (sp.as_str(), mp.as_str());
    let mut laite = Laite::uusi(&s(&k, "laite"));
    let mut v = Varasto::default();
    let mut git = Git::default();
    for p in [sp, mp] {
        git.kirjoita(p, &rek);
        git.committaa(p, "a").unwrap();
    }
    v.tuo(&mut laite, &git, NYT).unwrap();
    let pari = |avain: &str| lista_s(&k[avain]);
    // Äppi: muokkaa, lisää ja poistaa scopes-rekisterissä; muokkaa muu-rekisteriä.
    let a = pari("appiS");
    let r = rivi(&v, sp, &a[0]);
    appi_koskee(&mut v, sp, &r, &a[1]);
    let ys = jarjestetyt(&v, sp);
    let i = ys
        .iter()
        .position(|y| y.sisalto == s(&k, "ankkuri"))
        .unwrap();
    let jarj = valiin(&ys[i].jarjestys, Some(&ys[i + 1].jarjestys)).unwrap();
    let uusi = uusi_rivi(&k["uusi"], sp, jarj);
    let pk = &k["pois"];
    let pois_rivi = rivi(&v, sp, &s(pk, "sisalto"));
    let pois = ilman_lahdetta(Rivi {
        poistettu: true,
        versio: lisatty(&pois_rivi.versio, "iphone", n(pk, "iphone")),
        muuttaja: Some("iphone".to_string()),
        ..pois_rivi
    });
    assert_eq!(v.vastaanota(&[], &[uusi, pois]).unwrap().otettu, 2);
    let a = pari("appiM");
    let r = rivi(&v, mp, &a[0]);
    appi_koskee(&mut v, mp, &r, &a[1]);
    let odotettu = korvaa(&rek, &k["odotettu"]);
    assert_eq!(v.tulosta(sp, false), odotettu);
    let elavat = |v: &Varasto| v.lue_yksikot(sp).iter().filter(|y| !y.poistettu).count();
    let maara = elavat(&v);

    let t = v.vie(&mut laite, &mut git, &etuliite, NYT).unwrap();
    assert_eq!(
        t.viety.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(),
        vec![sp]
    );
    assert!(t.ohitettu.is_empty() && t.syy.is_none(), "{t:?}");
    assert_eq!(git.lue(sp), Some(&odotettu));
    assert_eq!(git.head[sp], odotettu);
    assert_eq!(git.head[mp], rek);
    assert!(git.muokatut.is_empty());
    assert!(git.loki.last().unwrap().starts_with(&s(&k, "commitViesti")));
    // Paluu: ei riitaa, ei uusia yksiköitä, gitin puoli = HEAD, ja uusi vienti on tyhjä.
    assert_eq!(elavat(&v), maara);
    assert_eq!(v.lue_siivotut(sp).len() as u64, n(&k, "siivotut"));
    assert!(v.ristiriidat().is_empty());
    assert_eq!(v.tulosta(sp, true), odotettu);
    assert!(v
        .lue_yksikot(sp)
        .iter()
        .filter(|y| !y.poistettu)
        .all(|y| y.lahde_sisalto.as_deref() == Some(y.sisalto.as_str())));
    let t = v.vie(&mut laite, &mut git, &etuliite, NYT).unwrap();
    assert!(
        t.viety.is_empty() && t.ohitettu.is_empty() && t.syy.is_none(),
        "{t:?}"
    );

    // Pakkaus muuttaa gittiä ja äppi eri riviä: LR yhdistää, vienti tuo molemmat.
    git.kirjoita(sp, &korvaa(&odotettu, &k["pakkaus"]));
    git.committaa(sp, "pakkaus").unwrap();
    v.tuo(&mut laite, &git, NYT).unwrap();
    let a = pari("appiPakkaus");
    let r = rivi(&v, sp, &a[0]);
    appi_koskee(&mut v, sp, &r, &a[1]);
    assert_eq!(
        v.vie(&mut laite, &mut git, &etuliite, NYT)
            .unwrap()
            .viety
            .len(),
        1
    );
    assert_eq!(
        git.head[sp],
        korvaa(&korvaa(&odotettu, &k["pakkaus"]), &k["pakkausHead"])
    );
    assert!(v.ristiriidat().is_empty());

    // Esteet: istunnon muokkaama tiedosto, tiedoston pakkauslukko, juurirepon lukko, avoin riita.
    let tk = &k["taas"];
    let taas_rivi = rivi(&v, sp, &s(tk, "rivi"));
    let taas = ilman_lahdetta(Rivi {
        sisalto: s(tk, "sisalto"),
        muuttaja: Some("iphone".to_string()),
        versio: lisatty(&taas_rivi.versio, "iphone", n(tk, "iphone")),
        ..taas_rivi
    });
    assert_eq!(v.vastaanota(&[], &[taas]).unwrap().otettu, 1);
    let tyopuu = format!("{}{}", git.lue(sp).unwrap(), s(&k, "istunto"));
    git.kirjoita(sp, &tyopuu);
    let t = v.vie(&mut laite, &mut git, &etuliite, NYT).unwrap();
    assert_eq!(t.ohitettu, vec![(sp.to_string(), s(&k, "syyMuokattu"))]);
    git.palauta(sp);
    git.tiedostolukot.insert(sp.to_string());
    let t = v.vie(&mut laite, &mut git, &etuliite, NYT).unwrap();
    assert_eq!(t.ohitettu, vec![(sp.to_string(), s(&k, "syyLukko"))]);
    git.tiedostolukot.clear();
    git.juurilukko = true;
    let t = v.vie(&mut laite, &mut git, &etuliite, NYT).unwrap();
    assert!(t.viety.is_empty() && t.ohitettu.is_empty());
    assert_eq!(t.syy, Some(s(&k, "syyJuuri")));
    git.juurilukko = false;
    let riidalla = korvaa(git.lue(sp).unwrap(), &k["riita"]);
    git.kirjoita(sp, &riidalla);
    git.committaa(sp, "riita").unwrap();
    let t = v.vie(&mut laite, &mut git, &etuliite, NYT).unwrap();
    assert_eq!(t.ohitettu, vec![(sp.to_string(), s(&k, "syyRiita"))]);
    assert!(git.head[sp].contains(&s(&k, "riitaHead")));

    // Epäonnistunut commit (pre-commit-hook hylkää): tiedosto palautuu, eikä työpuu jää likaiseksi.
    let rp = s(&k, "R");
    git.kirjoita(&rp, &rek);
    git.committaa(&rp, "y").unwrap();
    v.tuo(&mut laite, &git, NYT).unwrap();
    let a = pari("appiR");
    let r = rivi(&v, &rp, &a[0]);
    appi_koskee(&mut v, &rp, &r, &a[1]);
    git.hylkaa_commit = Some(s(&k, "hook"));
    let t = v
        .vie(&mut laite, &mut git, &s(&k, "etuliiteR"), NYT)
        .unwrap();
    assert_eq!(t.ohitettu, vec![(rp.clone(), s(&k, "syyCommit"))]);
    assert!(git.muokatut.is_empty());
}
