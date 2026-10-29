# scopes2/ydin/REKISTERI.md

Tilanne: 21.10.2026 (ARK-04, ARK-05, ARK-07, ARK-12 ja ytimen ARK-06-tehtävät tehty)

SEURAAVA PAKETTI: ei mitään — kysytty 21.10.2026: ytimen jono tyhjä 28.10.2026: T-108 valmis (ff8fa832, koordinaattori c2 hyväksyi; adapterin T-109 aukeaa); T-101-tuotantoasennus ei nyt (käyttäjä 21.10.2026, overseer kuittasi 28.10.2026: tuotantoonvienti pysäytetty kunnes käyttäjä palaa); T-44-käynnistys tehty 21.10.2026: julkaisu 7da86808 asennettu 15.19 (varmuuskopio ~/.local/share/scopes2-varmuus/ydin.db.ennen-7da86808-20261021-1517, 2 977 366 016 t), adapteri e3 käynnisti 15.31.00 kaynnista.sh:lla --adapteri 8798, katko ~51,5 s (skeemasiirtymä 14 280 yks. 51 407 ms), 8797 200, VmHWM 17 MB, /api/agentit x-lahde adapteri; raportoitu koordinaattorille 68. Palautus vain käyttäjän päätöksellä (binääri d302bab0 + ydin.db varmuuskopiosta)

## Tarkoitus ja raja

scopes-V2:n solmuydin Rustilla (crate `scopes-ydin`, binääri `scopes-solmu`, portti 8797 = P-8).

Raja: polut `scopes2/ydin/**`. Ei muutoksia `scopes/**`-puuhun (vanha äppi ja 8787-palvelu, K-9; gate.sh:n `scopes/`-aita). Adapteri (`scopes2/adapteri/**`) kuuluu skoopille `scopes2 adapteri`. Arkkitehtuuri: `scopes/architecture/SUUNNITELMA.md` luku 9 (ARK-04…ARK-07, ARK-12); tehtävät ja briefit: `scopes/toteutussuunnitelma/SUUNNITELMA.md` luku 5 ja `briefit/T-nn.md`. Ei lueta purussa.

## Päätökset

- **Käyttäjä 19.10.2026:** skooppi `scopes2 ydin` luotiin komennolla `/pura uusi scopes2 ydin`.
- **Käyttäjä 19.10.2026 (ARCHITECTURE-JAKELU, H-4; tehty `scopes architecture` -skoopista käyttäjän pyynnöstä, välitetty `scopes macos` -keskustelusta):** tämä skooppi omistaa paketit ARK-04, ARK-05, ARK-06:n ytimen osan, ARK-07 ja ARK-12. ARK-01…ARK-03 eivät ole V2-polulla (K-9).
- **Käyttäjä 19.10.2026 (H-1):** rustup palvelimelle kuuluu toteutukseen. Tehty 19.10.2026 käyttäjän luvalla: Rust 1.99.1 (minimal + rustfmt, clippy) `~/.cargo`, `~/.rustup` (~500 Mt). Reitittimen allow-listaan lisättiin rustup.rs, rust-lang.org ja crates.io (`scopes macos`, käyttäjän luvalla); Clauden hiekkalaatikko estää ne yhä → cargo ajetaan `CARGO_NET_OFFLINE=true`, uudet riippuvuudet haetaan valvojan `cargo fetch`illä hiekkalaatikon ulkopuolella.
- **Käyttäjä 19.10.2026 (gate-aidat):** `gate.sh`:n git- ja `scopes/`-aidat vertaavat `--pohja`-lähtötilaan, koska puussa on muiden keskustelujen commitoimattomia muutoksia; valvoja ajaa `gate.sh --pohja` ennen toteuttajan käynnistystä (V-569 tiedoksi toteutussuunnitelmalle).
- **Käyttäjä 19.10.2026 (vieras aitamuutos):** kun `gate.sh`:n aita kaatuu vain polkuihin, joihin toteuttaja ei transkriptin mukaan kirjoittanut (muiden keskustelujen pakkaukset, jaettu `claude/siirto/mittaukset/vaihevirheet.jsonl`), valvoja ajaa portin cargo-vaiheet (fmt, clippy, test) erikseen samoilla komennoilla, kirjaa vieraat polut mittausriville ja committiviestiin ja committoi. Pohjaa ei muokata.
- **Valvoja 19.10.2026 (ryhmä D):** ennen ryhmää D moduulit saivat `reitit(tila: Arc<Tila>)` -allekirjoituksen ja api.rs välittää `tila.clone()` (766f192f); ryhmä D ajettiin sarjassa T-23 → T-30 → T-21, koska kaikki tarvitsivat sen.
- **Mittaus 19.10.2026 (T-16-G):** ensimmäinen `cargo build` (jobs=2) max RSS 420740 kB, 69 s (luku 7: ryhmät D ja E mahtuvat rinnakkain muistin puolesta, ~2,7 Gt vapaana, käännökset flockilla sarjassa); openssl-sys vaatii `OPENSSL_LIB_DIR`/`OPENSSL_INCLUDE_DIR` (pkg-config puuttuu), gate.sh asettaa ne.

- **19.10.2026:** Käyttäjä 19.10.2026 (H-1): agentti asentaa rustupin; tehty.

- **19.10.2026:** Käyttäjä 19.10.2026 (gate-aidat): git- ja scopes/-aidat vertaavat `gate.sh --pohja`-lähtötilaan; valvoja ajaa --pohja ennen jokaista toteuttajaa.

- **19.10.2026:** Käyttäjä 19.10.2026 (vieras aitamuutos): kun aita kaatuu vain polkuihin, joihin toteuttaja ei kirjoittanut, valvoja ajaa cargo-vaiheet erikseen, kirjaa vieraat polut mittausriville ja committiviestiin ja committoi; pohjaa ei muokata (luokitin esti pohjan muokkauksen).

- **19.10.2026:** Valvoja: T-17 ja T-18 sekä ryhmä D sarjassa päätyöpuussa (T-18 tarvitsee T-17:n tyypit; ryhmän D briefit olettivat reitit(tila)-allekirjoituksen), ei worktreetä.

- **19.10.2026:** Koordinaattori-istunnon viesti ei ole käyttäjän hyväksyntä: jokaisen paketin aloitus kysyttiin käyttäjältä AskUserQuestionilla.

- **Valvoja 19.10.2026 (ryhmä E):** briefin may-lista laajennetaan kytkentäkohtiin, kun Contract muuten jäisi Blocked-tilaan (T-27: api.rs `kirjoita_ja_ilmoita`, replikointi.rs headless-suodatin; T-31-G: lr.rs signatuurit `todo!()`-rungoilla, koska `clippy --all-targets` kaataisi kaikki portit); laajennus kirjataan mittausriville ja committiviestiin. Ryhmä E ajettiin sarjassa T-22 → T-27 → T-28 → T-35 → T-31-G (T-27 riippuu T-22:sta).
- **Luokitin 19.10.2026 (T-35):** oikeaa keskustelutranskriptia (`~/.claude/projects/**`) ei viedä fixtureksi; transkripti-fixturet ovat synteettisiä ja odotetut vastaukset tuotetaan vanhalla koodilla.

- **19.10.2026:** Valvoja 19.10.2026 (T-32): kun briefin Contract ja aiemman tehtävän lukitut testit ristiriidassa, testit voittavat (signatuurit T-31-G:n mukaan); tiivisteen juuri on oikea juuritiiviste eikä "ydin".

- **19.10.2026:** Valvoja 19.10.2026 (T-33): tuotantoporttia 8797 ei käytetty; koeydin 18797 omalla datalla ja 2 h aikarajalla; gate T-33 lukee ytimen osoitteen ympäristöstä (LR_PARITEETTI_*).

- **19.10.2026:** Käyttäjä 19.10.2026: YDIN-RYHMA-E:n jälkeen "Aloita T-32"; ARK-12:n jälkeen "Pakkaa nyt".

- **19.10.2026:** Käyttäjä 19.10.2026: T-36:n muistimittaus ja korjaukset (ajot 2–3) hyväksytty AskUserQuestionilla; hae-korjaus = tavubudjetti ja jatko (hylätty: pienempi erä asiakkaissa, pysähtyminen).

- **19.10.2026:** Käyttäjä 19.10.2026: YDIN-REKISTERIT-YTIMESTA vaihtoehto A (vain LR-kentät ytimestä; hylätty B adapterin lahde/rekisterit, C vain korjaukset). Koordinaattorin lisäys: siltavälimuisti p50 < 100 ms.

- **19.10.2026:** Käyttäjä 19.10.2026: sisarusyksiköt ensin "korjaa ennen kirjoittavaa", sitten yövaltuudella R-2 (YOLOKI aefecdbf).

- **19.10.2026:** T-39 valtuus VALVOJA.md 2.4 (ARK-10); T-44 vasta T-43:n jälkeen (koordinaattori).

- **19.10.2026:** Ydin ei kirjoita toteutussuunnitelman tiedostoihin (T-36.md, tehtavat.jsonl) koordinaattorin pyynnöstä (sääntö 15).

- **19.10.2026:** Briefit R-1, R-2: scopes2/ydin/briefit/.

- **19.10.2026:** Valvoja 19.10.2026 (T-50): may-lista laajennettiin varasto.rs:ään (vain polku + data()), koska liite.rs ei muuten löydä <data>:a; hylätty Tila.data-kenttä (muuttaisi solmu.rs, ffi.rs ja kaikki Tila-literaalit) ja argv-/proc-päättely.

- **19.10.2026:** Valvoja 19.10.2026 (T-46): release-kirjasto erilliseen target/lib-release-hakemistoon koordinaattorin rajan vuoksi.

- **19.10.2026:** Koordinaattori P-14 (1f5df207): ytimen Mac-ajot yhdessä ssh-kutsussa lockf -t 1800 ~/scopes2-rakennus/.lukko.

- **19.10.2026:** Koordinaattori 19.10.2026: aikarajan pidentäminen ei kelpaa ainoaksi korjaukseksi; korjaus testien porttivalintaan ja valmiuteen.

- **19.10.2026:** Koordinaattori kirjaa aamulle erikseen, että sharedin oletuskoeportin pitäisi olla P-6:n testiporttien ulkopuolella (ei tämän skoopin muutos).

- **20.10.2026:** Koordinaattori 20.10.2026: A+B paketiksi R-3; C (MALLOC_ARENA_MAX, adapterin kaynnista.sh) vain jos A+B eivät riitä, kysytään erikseen.

- **20.10.2026:** Rajaus ARK-17:ää vasten (koordinaattori hyväksyi): S-9 koskee vain ikkunoitua solmua, tuotanto on täysi solmu → R-3 = vain A; B päällekkäinen T-56:n kanssa (Keskustelu pohjasta, S-9d json_array_length) → päätetään R-3:n VmHWM-mittauksen jälkeen, tarvittaessa T-56:n briefiin. T-57 (6) vaatii täydeltä koeytimeltä VmHWM < 512 MiB → R-3 on sen edellytys.

- **20.10.2026:** Järjestys R-3 → T-54 (samat tiedostot peili.rs, varasto.rs).

- **20.10.2026:** T-54 poikkeama briefistä (pääistunnon päätös): `api::Tila` luodaan kentät luetellen 10 testissä → yksi kenttä `peili: PeiliIkkuna` (Default), testeihin vain `peili: Default::default(),`; hylätty: kolme kenttää (30 riviä testeihin) ja globaali rekisteri.

- **21.10.2026:** Koordinaattori 20.10.2026: B:tä ei toteuteta (B-polku 237 MiB < 512); pitkä ajo ja glibc-areenat T-44:n jälkeisen seurannan avoin riski, ei este.

- **21.10.2026:** Koordinaattori: virta.rs-poikkeama (peili-karsinta ja peili-pohja päätyvät /api/virta-virtaan, koska virta.rs:118 suodattaa vain peili-offsetin) viedään toteutussuunnitelmalle; ei korjata T-55/T-56:ssa.

- **21.10.2026:** Porttiajot (gate.sh) vain koordinaattorin vuorolla; koodaus ja yksittäiset cargo-testit lockf-lukon alla sallittu.

- **21.10.2026:** Tuotantodatan luku tai tuotantomuutos vain, kun käyttäjän hyväksyntä nähdään tässä keskustelussa (AskUserQuestion), ei vertaisen sanasta (b4658d95).

- **21.10.2026:** T-57 (4)–(5) "ei todennettu" hyväksytty (toteutussuunnitelma 04, c246e583). T-58 kuuluu iOS e0:lle, ei ytimelle (koordinaattori 68).

- **21.10.2026:** Palautus vain käyttäjän päätöksellä: binääri d302bab0 + ydin.db varmuuskopiosta (vanha ei avaa skeemaa 2).

- **21.10.2026 (koordinaattori, agy-pakkaus):** agy Flash -ajot valmiit: T-96 gate.sh-siivous 7e7402b1 (itsetesti + T-19 vihreät); T-101 /viestit-vastaukseen istunto.transkripti 2aaf1bee (T-35, T-56, siltavertailu vihreät; T-24 punainen vain kuorma.test.mjs:n kahdessa VmHWM-tarkistuksessa, /proc puuttuu Macilla, poikkeus hyväksytty overseer 185235). Raportit ~/agy-raportit/T-96, T-101; worktreet poistettu. Tuotantoon vienti (julkaise.sh --asenna) ei ajettu (oneplus server odottamaan).

- **21.10.2026:** T-101 commitoitu kahtena commitina (ydin, adapteri) briefin mukaan, vaikka overseer pyysi polut yhdessä listassa.

- **21.10.2026:** Worktree poistettiin --force:lla vasta kun sen diff oli todettu identtiseksi commitoidun kanssa.

- **28.10.2026 (SCOPES2-PALUU-1735, Opus high, patriot 307ef0d7):** T-96 (7e7402b1) ja T-101-ydinosa (2aaf1bee) katselmoitu sisällöstä: diffit vastaavat briefejä täsmälleen; Cargo.toml/lock ilman openssl/native-tls (OpenSSL-viennit kuolleita); `kentta("transkripti")` = sessiorivin arvo tai null sopimuksen mukaan; `/raaka` (peili.rs:284) ottaa arvon sellaisenaan. Ei uudelleentehtävää. Portit HEAD ec2ecf7a omassa worktreessä: --itsetesti, T-35, T-56, T-19, T-91 vihreät. `ulimit -d` ei asetu macOS:llä (unlimited); ajo oli cargo-testejä fixtureilla, ei koeydintä. Tuotantoasennus ennallaan avoin.

- **28.10.2026 (koordinaattori c2, T-108):** T-108 valmis: S-5b-laji `jono` (LAJIT 6) ja `GET /api/skoopit/<nimi>` `jonossa` = uusimman laitteen `lahde/jono`.sisalto[nimi] tai `[]`, kun jono julkaistu; muuten sillasta (siltapolku ennallaan). Vain ytimen haarassa (lahde/istunnot+agy julkaistu); `/api/skoopit`-listassa ei jonossa-kenttää. ff8fa832 (alkup. ec1ef159 haarassa ydin/t108-jono), Sonnet ~42 k; portit T-35, T-56, T-84 EXIT=0 (GATE_MAY 3 tiedostoa; ensimmäinen T-35 punainen cargo fmt --checkiin, korjattu). Koordinaattori hyväksyi; adapterin T-109 aukeaa.

## Avoimet asiat

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-06 ytimen osa: T-23 f039ff45, T-30 bd556285, T-35 2652161a (Opus 1 ajo, 5/5; valvoja kytki nakymat::kaynnista main.rs:ään; transkripti-fixture synteettinen, koska luokitin esti oikean transkriptin; rekisterikentät, konteksti ja jonossa sillasta T-33:een asti). Adapterin lahde/istunnot ei sisällä nimeä, pid:tä, vanhempaa eikä polkua → otetaan sillasta (koordinaattorille tiedoksi 19.10.2026). Adapterin osa `scopes2 adapteri` (T-25 → T-34) | ytimen tehtävät valmiit | T-34 hyväksyntäajo adapterin T-25:n jälkeen (valvoja, H-5) **19.10.2026:** Tokenit (task-notification usage): T-22 52 k, T-27 77 k, T-28 32 k, T-35 152 k, T-31-G 84 k, T-32 106 k, T-33 63 k; yhteensä ~566 k, ei uusintoja eikä eskalaatioita; Luokitin (Sensitive-Source Provenance) esti oikean keskustelutranskriptin viemisen T-35:n fixtureksi. |
| P-1 Haiku-pilotti (korpus-fixturet): ei briefiä; T-17:n korpuksen kirjoitti Opus ja T-31-G:n fixturet valvoja curlilla, joten P-1 ei ole tuottanut mittausta Haikun käytöstä (luku 7) | avoin | toteutussuunnitelman päätös |
| Paketin katto: Budget-summat ARK-04 1,25 M, ARK-05 0,65 M, ARK-07 0,45 M, ARK-12 0,85 M tokenia; katto 3 × (toteutussuunnitelma luku 7) | odottaa (pysyvä ohje: laukeaa vain, kun paketin Budget-summa ylittyy) | ei askelta; ylityksessä paketti pysähtyy |
| Ytimen runkoraja: axumin oletus 2 MB → T-34 ajo 2 punainen (6 peililähetystä 413); koordinaattori 19.10.2026: adapteri pilkkoo rungot ≤ 1,5 Mt, ytimen rajaa ei muuteta nyt **19.10.2026:** T-34 ajon 4 harjoitus punainen (83e3b314): syy /api/listat?polku=peili → VmData 1,55 Gt / 4 s, SIGABRT exit 134; tyhjäkäynti VmData 20,6 Mt, 9 säiettä (areenahypoteesi kumottu); T-34 ajo 4 vihreä (37edddb0): p50 11 ms, ydin VmHWM 203 MiB. | odottaa (tiedoksi, ei ajettava: uudelleenarvio vasta, jos adapterin pilkonta (≤ 1,5 Mt) ei riitä; T-34 ajo 4 vihreä 37edddb0 ilman 413:a) | uudelleenarvio vasta, jos adapterin pilkonta ei riitä |
| Sisarusyksiköt Lr-replikoinnissa (R-1-havainto): korjattu R-2:ssa (käyttäjän yövaltuus 19.10.2026, YOLOKI aefecdbf; brief `briefit/R-2.md`, Sonnet ~47 k): `yhdistaja_yksikolle` → `rekisterit/*` + id:ssä `~` = Lww; portit R-2, T-21, T-22, T-32, R-1, T-36 exit 0. Huom.: rinnakkaiset rivit (`r-1`) jäävät solmuittain erilaisiksi Lr:n semantiikalla, kunnes kattava versio kirjoitetaan (R-2-havainto, ei todennettu: vastaako lr.mjs:n `vertaa`-semantiikkaa vai onko rivitason konvergenssivika; tiiviste eroaa solmujen välillä siihen asti). T-22 antoi kerran 401:n (`PUT koe/0`) ennen ydinkoodia, uusinta vihreä — satunnaisvirhe, ei tutkittu **19.10.2026:** R-1 Notes: päärekisterikartta, 6/92 skooppia ilman yksiselitteistä merkintää. **19.10.2026:** T-50 ajo 2 juurisyy 19.10.2026: kiinteät koeportit 18797/18798 jaettu shared/gate.sh:n (oletus 18798), adapteri/gate.sh:n (18797) sekä kaksi_solmua- ja tila_kaksi_solmua-testien kanssa; vieras solmu 18798:ssa → oma B "Address already in use", odota_valmiiksi hyväksyi vieraan terveysvastauksen, PUT 401 → 503 (toistettu). Sama syy selittää R-2:n T-22-satunnaisvirheen. | avoin (rivihavainto, ei todennettu; sisarusyksiköt korjattu R-2:ssa) | todenna rinnakkaisten rivien käytös lr.mjs:ää vasten ennen ARK-12:n kirjoittavaa tilaa; T-22:n 401: tutki, jos toistuu |
| T-44 release + V2 `--web` | avoin (edellytys T-43; koordinaattori päättää) | ei askelta tässä skoopissa |
| R-3 peilin muistipiikki (T-44 muistiehto punainen, 444cda5f): tuotantoydin 12647 RSS 803 Mt / HWM 824 Mt, lähes kaikki noin 64 Mt:n glibc-areenoissa; muistipaineessa 686 Mt swappiin eikä palannut (kylmää, työmuisti noin 110 Mt). Syyarvio: `peili.rs:73` rivit_alkaen lataa ja jäsentää transkriptin kaikki yksiköt ennen offset-suodatusta; `nakymat.rs:1411` lukee elävät transkriptit offsetista 0. Peili 2,8 Gt / 14 230 yksikköä; koordinaattorin transkripti bacfad9b on 120 Mt ja kasvaa. Koordinaattorin päätös 20.10.2026: A = id:t ensin, sisältö vain offsetin jälkeisistä; B = rakennus vain hännästä (MAARA). C (MALLOC_ARENA_MAX, adapterin kaynnista.sh) vain, jos A+B eivät riitä, ja kysytään erikseen. **Rajaus ARK-17:ää vasten 20.10.2026 (0a295851):** S-9 ikkunoi vain ikkunoidun solmun; tuotanto on täysi solmu (S-9: "käytös ennallaan"), joten ARK-17 ei poista tuotannon piikkiä. T-57 (6) vaatii täydeltä koeytimeltä A (tuotannon kopio) VmHWM < 512 MiB, joten R-3 on käytännössä T-57:n edellytys. R-3 = vain A (`peili.rs` rivit_alkaen + `varasto.rs`:n id-haku ilman sisältöä); ei ristiriitaa S-9:n kanssa, eri funktiot kuin T-54:n riisu, karsi ja poista_paikallisesti. B on päällekkäinen T-56:n kanssa (Keskustelu pohjasta, S-9d:n json_array_length-rivimäärä), joten B jää pois: jos A:n jälkeen käynnistyksen VmHWM ≥ 512 MiB, B tehdään T-56:n pohjalla (täysi solmu aloittaa hännästä, pohja SQL:llä; numerointi ennallaan). Järjestys: R-3 ennen T-54:ää tai sen jälkeen, ei rinnakkain (samat tiedostot peili.rs ja varasto.rs) **20.10.2026:** Syy (koodista): ennen R-3:a rivit_alkaen latasi ja jäsensi koko transkriptin joka peilipäivityksellä; `nakymat.rs:1411` paivita_lahteet lukee elävät transkriptit offsetista 0 (B, ei korjattu). Siltavälimuisti pieni (2 Value-arvoa). | korjattu 136603f6 (A tehty: `peili.rs` rivit_alkaen lukee välin otsakkeina ja hakee sisällön vain offset >= -yksiköistä; portti R-3 exit 0: peili 10/10, nakymat 8/8, varasto 14/14); VmHWM mitattu 20.10.2026 23.17–23.19 palvelimella (koeydin tuotannon ydin.db:n backup-kopiolla, prlimit --data=600000000, portti 18841, ilman --vanhaa ja vertaisia; käynnistys + 5 peilipäivitystä suurimpaan elävään transkriptiin bacfad9b, offset 112 518 250): ennen (136603f6~) käynnistys 143 MiB, päivitysten jälkeen 277 MiB; jälkeen (työpuu 7cbcb930) käynnistys 122 MiB, päivitysten jälkeen 124 MiB < 512 MiB; loki palvelin:/tmp/r3/r3.log. B-polku mitattu 23.21–23.24 samalla järjestelyllä A-koodilla (7cbcb930; loki palvelin:/tmp/r3/r3b.log): käynnistys 122, B1 lähdemuutos ilman uusia transkripteja 123, B2 suurin pois 123, B3 suurin takaisin (offsetista 0) 124, B4 kaikki elävät pois 124, B5 kaikki 10 elävää takaisin 236, 5 peilipäivitystä 237 MiB < 512 MiB → koordinaattorin tulkinnalla B:tä ei tarvita nyt; pitkä ajo ja glibc-areenat T-44:n jälkeisen seurannan avoin riski **21.10.2026:** R-3 A mitattu (koeydin tuotannon ydin.db:n backup-kopiolla, prlimit --data=600000000, portti 18841, ilman --vanhaa/vertaisia): ennen 136603f6~ käynnistys 143 / päivitysten jälkeen 277 MiB; jälkeen 122 / 124 MiB; R-3 B (7cbcb930) mitattu: käynnistys 122, B1 123, B2 123, B3 suurin takaisin 124, B4 124, B5 kaikki 10 elävää takaisin 236, 5 peilipäivitystä 237 MiB < 512. RSS ei laskenut B5:n jälkeen. **21.10.2026:** T-57-uusinta (2c73044a) 21.10.2026: kopio 15 s, siirto 85 s; skeemasiirtymä 1→2 14 280 yks. 26 831 ms, MUISTI varasto_avattu 31 391 744 t; A 73 MiB, B1 367 MiB, B 36 994 365 t (katto 38 Mt, riisunta lähellä kattoa). | koeydin tuotannon ydin.db:n kopiolla (`prlimit --data=600000000`, oma --target-dir, vapaa koeportti, ei 18798); VmHWM ennen (HEAD~ ennen 136603f6) ja jälkeen samalla kopiolla, sekä käynnistyksessä että peilipäivityksen aikana; tulos koordinaattorille → B-päätös |
| Peiliyksikkö yli ~550 kt ei mahdu `/api/laheta`-runkoon (axum 2 Mt JSONina) replikoinnissa | odottaa (tiedoksi, ei ajettava: laukeaa vasta kun peiliä replikoidaan solmujen välillä; ei vielä käytössä) | uudelleenarvio silloin |
| `liite.rs` avaa oman rusqlite-yhteyden `ydin.db`:hen `liitteet`-taululle (Varastossa ei API:a), busy_timeout 5 s | odottaa (tiedoksi, ei ajettava: varaston liite-API-päätös skoopilta toteutussuunnitelma) | ei askelta nyt |
| Siirto Macille (käyttäjä 20.10.2026 18.35, viesti scopes macos -istunnosta): palvelinsidonnaiset työkalut, sovitettava Macilla: (1) `scopes2/ydin/gate.sh:109` `flock /tmp/scopes2-cargo.lock` — macOS:ssä ei flockia oletuksena; (2) scratchpadin `vahti-gate.sh` (free -m, setsid, /proc, CARGO_TARGET_DIR=target/ark17) Linux-only, ei repossa; (3) prlimit Linux-only; (4) gate.sh:n aita tarvitsee GATE_POHJA-pohjan (`gate.sh --pohja`), oletus /tmp/scopes2-ydin-gate-pohja.txt; (5) R-3:n VmHWM-mittaus ja tuotannon 8797 (data ~/.local/share/scopes2-ydin/ydin.db) ovat palvelimella → mittaus ajetaan palvelimella tai kopio siirretään (2,8 Gt); (6) Rust-työkaluketju Macilla tarkistettava; (7) palvelimella ei sqlite3-CLI:tä (käytin python3:a) | avoin | sovita kohdat (1)–(7) Macilla |
| Avoin päätös, ei tämän skoopin: 8787 jumittuu (V-613), koordinaattorin ehdotus V2:n sillan päivitysväli 15 → 120 s (`nakymat.rs` SILTAVALI) | avoin | ei askelta tässä skoopissa |
| T-101-muutoksen tuotantoasennus (julkaise.sh --asenna) | avoin; odottaa käyttäjää (tuotantoasennus, 51 s katko: ytimen omistajan ja käyttäjän päätös) | odottaa käyttäjää: päätös asennuksesta; ei ajettavissa ilman sitä |

## Viat

| Vika | Tila |
|---|---|
| Oma virhe 20.10.2026 17.44 (T-44-muistiselvitys): ajoin python3-sqlite-kyselyt tuotannon ydin.db:hen (2,8 Gt) ilman muistirajaa → prosessi RSS 1,4 Gt, palvelimen vapaa muisti 356–413 MiB, Claude Coden muistisiivous tappoi T-52:n porttiajon. Jatkossa raskaat kyselyt `prlimit --data=600000000`-rajalla ja vain koordinaattorin luvalla, kun muita ajoja ei ole käynnissä | korjattu b59bb0af 21.10.2026 (kirjattu 136603f6): T-52 uusittu, KAKSI-LAITETTA 5/5 kahdesti (T-62 a59644e2, T-71 3b199453; koordinaattori 20); prlimit-käytäntö jää voimaan |
| V-OVS-10, oma virhe 21.10.2026 (istunto 8c, T-57-b-seuranta): taustan odotussilmukka bj1zy0oy4 pyöri 8 h 42 min ja esti automaattisiirron — `pgrep -f 't57-b-seuranta'` osui silmukan omaan komentoriviin, ja ehto vaati lokiin yli 60 riviä, kun seuranta kirjoittaa tasan 60. Jatkossa odotussilmukassa ei `pgrep -f`:ää (tila `dispatch-pid.mjs status` tai pid-tiedosto, aikaraja), ja odottaja pysäytetään, kun tulos luetaan käsin. Koodikorjausta ei nyt (overseer 58) | avoin (overseerin rekisterissä V-OVS-10; käytäntö) |
| V-OVS-11, 21.10.2026 15.39.17 (istunto 8c, pakkaus 5bf9b5b2): jaetun kloonin ~/sessions-repo haara rebasettiin juuri ennen pakkauscommitia, vastoin V-KORD-5:tä (ei amendia, stashia eikä pull --rebasea; vain commit polulla ja push; hylätty push → merge tai kysy overseeriltä). Reflogin mukaan rebase ja 5bf9b5b2 samassa sekunnissa ja rebase poimi siirtotyökalun AJO-commitin f8c23450: rebasen teki siirtotyökalun `pakkaa-git.sh`:n vaihe 2 (`synkka ennen`, rebase origin/<haara>), ei ydin käsin | avoin (overseerin rekisterissä V-OVS-11; viety claude siirrolle overseerin kautta) |

## Historia

Historia: `scopes2/ydin/HISTORIA.md` (syntyy ensimmäisessä pakkauksessa), ei lueta purussa.
