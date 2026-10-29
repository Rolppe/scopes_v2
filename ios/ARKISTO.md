# scopes2 ios — arkisto

Aktiivisesta rekisteristä poistettu tai muutettu tieto sanatarkasti, vanhin ensin (V-082, 28.9.2026).
Tästä ei poisteta mitään. Purku ei lue tätä tiedostoa: se luetaan vain vianselvityksessä, kun
halutaan tietää, mitä rekisterissä on joskus ollut. Kirjoittaja: `claude/siirto/tools/arkisto.mjs`.

## 20.10.2026 — scopes2 ios

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: IOS-T49-PORTTI — iOS-osa on vihreä porttikopiolla (20.10.2026 klo 01.08); jäljellä vain koko portti `bash scopes2/shared/gate.sh T-49` exit 0, kun scopes2 macos -testi on vihreä ja aita puhdas — polut: scopes2/ios/** — aloitus: /pura scopes2 ios

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| Skooppi on vasta luotu | luotu 19.10.2026 | paketti IOS-MAARITTELY |

## 20.10.2026 — scopes2 ios

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| Skooppi on vasta luotu | avoin (luotu 19.10.2026) | paketti IOS-MAARITTELY (käyttäjä valitsi 20.10.2026) |

## 21.10.2026 — scopes2 ios

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: IOS-H17 — fyysinen iPhone (I-5): laiteallekirjoitus ja asennus H-17 (käyttäjä, Xcode); agentti valmistelee komennot ja tarkistukset (ARK-08 kiinni, T-51 hyväksytty f1bf7908) — polut: scopes2/ios/project.yml, scopes2/ios/REKISTERI.md — aloitus: /pura scopes2 ios

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| Mac-vuorot rinnakkaiskehityksessä (koordinaattorin järjestely, `scopes/kordinaattori/REKISTERI.md` 130b148c) | avoin; odottaa skooppia scopes kordinaattori (V-605) | iOS-portit omasta worktreestä V-605:n todennuksen jälkeen; sitä ennen vuoro koordinaattorilta (sessions-repo-91), jumit overseerille |
| H-17 fyysinen iPhone (I-5) | avoin; voi edetä (koordinaattori 20.10.2026, ARK-08 kiinni) | paketti IOS-H17: agentti valmistelee, käyttäjä allekirjoittaa ja asentaa Xcodella |

## 21.10.2026 — scopes2 ios

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: IOS-SEURAAVA — kysy koordinaattorilta (sessions-repo-68) seuraava iOS-tehtävä: avoimina I-3 (T-53 kaksi-laitetta) ja I-4:n T-59 — polut: scopes2/ios/REKISTERI.md — aloitus: /pura scopes2 ios

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| H-17 fyysinen iPhone (I-5) | valmis pois — asennettu 21.10.2026 15.31 (Tila IOS-H17) | — |
| scopes-V2-uusinta-agentti (`scopes2/ios/asennus/`) | valmis pois — overseer 58 latasi käyttäjän luvalla 21.10. 15.40 (bootstrap exit 0); d5 todensi: `launchctl print` runs = 1, last exit code = 0, `ajastus.loki` "15:40:07 ok H=167" | — |
| T-58 transkriptipeilin ikkuna iOS-äppiin | valmis pois — 9704e106 (Tila T-58) | — |
| T-58:n shared-muutokset sharedille | valmis pois — V-640 tiedoksi scopes2 sharedille (6d61a5d, käyttäjän /vika 21.10.) | — |

## 21.10.2026 — scopes2 ios

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: ei määriteltyä toteutuspakettia — iOS:n Raakarivien asiakasnäkymä (S-9f, palvelinpuoli T-60 valmis) odottaa toteutussuunnitelman tehtävämääritystä (pyydetty 21.10.2026 klo 19.4x, overseerin pyyntö iOS-kehityksen jatkosta); jälkitodennus (ei ehto): T-59 (4)(5) `bash scopes2/ios/testit/t59/t59-tuotanto.sh <ScopesV2.app>` simulaattorilukon alla, kun tuotannossa on skoopillinen istunto — aloitus: /pura scopes2 ios

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-59 (4)(5) tuotantodatalla (ARK-17, T-57:n siirretyt) | odottaa: tuotannon 8797:ssä 101 skooppia mutta `istuntoja=0` ja `/viestit` tyhjä jokaiselle, joten t59-tuotanto.sh:n vertailu on tyhjä (0/101 valittu; skripti tulosti VIHREÄ tyhjästä → korjattu: valittuja 0 → `T59-TUOTANTO TYHJÄ`, exit 2) | kun ensimmäinen skoopillinen tuotantoistunto on (T-88 tuotantoon), aja t59-tuotanto.sh (ks. SEURAAVA PAKETTI); ilmoita koordinaattorille 20 |

### Avoimet asiat — valmis

| Asia | Tila | Seuraava askel |
|---|---|---|
| V-576 (IDEAT.md) | todennettu 21.10.2026 (tuotannossa, ilmoitus scopes2 sharedilta: T-45-G ae07949d, otsikkohaku 763514c4: project.yml, ScopesV2App.swift, RunkoUITests.swift, .gitignore; ei ajettavaa) | todennettu: gate T-49 vihreä 21.10.2026 18.35; sulkeminen IDEAT-pitäjälle |
| V-607 (IDEAT.md) | todennettu 21.10.2026 (tuotannossa, ilmoitus scopes2 sharedilta: sama polkujoukko (T-52-vaihe); ei ajettavaa) | gate T-49 vihreä 21.10.2026 18.35 |
| V-629 (IDEAT.md) | todennettu 21.10.2026 (tuotannossa, ilmoitus scopes2 sharedilta: T-52-koodi ja RunkoUITests-vakautus 70170bc1, iOS tarkisti diffin 20.10.2026; ei ajettavaa) | gate T-49 vihreä 21.10.2026 18.35 |
| V-645 (IDEAT.md) | todennettu 21.10.2026 (tuotannossa, ilmoitus scopes2 sharedilta: OhjausUITests.swift (T-87 00cce758, c25fd4d) ohittaa itsensä ilman TEST_RUNNER_SCOPES2_OHJAUS=mock; ei ajettavaa) | T-87 vihreä (ARKISTO.md:267) |

## 28.10.2026 — scopes2 ios

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: ei mitään — T-97 (S-9f `peiliRaaka`, brief `scopes/toteutussuunnitelma/briefit/T-97.md`) kuuluu skooppiin scopes2 shared (polut `scopes2/shared/ScopesCore2/**`, portti `gate.sh T-97`); ajaja on koordinaattorin 180115 päätös (agy klo 22 jälkeen tai Sonnet heti), iOS-näkymän osa 2 briefataan T-97:n jälkeen; jälkitodennus T-59 (4)(5) odottaa skoopillista tuotantoistuntoa (ei ehto)

### Vaatimukset — poistettu tai muutettu

| # | Vaatimus | Hyväksyntä | Tila |
|---|---|---|---|
| I-4 | ARK-17 iOS-puoli: Transkriptipeili-asetusosio ja `haettavissa`-rivi | `gate.sh T-58`, T-59 | T-58 vihreä 21.10.2026 (9704e106); T-59 (a)(b)(c) + gate T-49 vihreä (b70dd25c), ARK-17 HYVÄKSYTTY 21.10.2026 (SUUNNITELMA 11.5 "T-59:n tulos"); (4)(5) tuotantodatalla ja K-10 laitteella ovat jälkitodennuksia, eivät ehtoja |

### Tila T-59 (21.10.2026 klo 18.40 — simulaattoriosa ja gate vihreät, (4)(5) odottaa) — poistettu tai muutettu

- Toteutus: `scopes2/ios/testit/t59/**` (t59.sh, siemen.mjs, valitys.mjs = TCP-välitys P, t59-tuotanto.sh, lukuvalitys.mjs = vain luku -välitys, vertaa-tuotanto.py, SUUNNITELMA.md) ja `UITests/T59UITests.swift` (4 vaihetta, XCTSkip ilman T59_VAIHE).
- **Mittausrivi T59 simulaattori (Mac, ajo 7, 18.12–18.18, exit 0):** (a) ikkuna 7 vrk, katto 38 Mt, koko 0,0 Mt / 38 Mt (testidata ~KB, joten ≤ katto on triviaali) · (b) P kiinni (curl exit 7 kylmäkäynnistyksessä ja kesken ajon): test-viestejä 9 = 9, S2 (`scopes2`) 4 viestiä, haettavissa-rivi kyllä, VANHA ei näy, TUORE näkyy · (c) P takaisin: S2 8 viestiä, VANHA näkyy 13 s käynnistyksestä, haettavissa poistui. Ajot 1–6: vaiheet 2–4 kaatuivat testin omiin virheisiin (palautettu valinta; `listaan` palasi listan käynnistysvilahdukseen ennen palautetun valinnan työntöä → korjattu vakaaksi näkyvyydeksi 3 s; ajo 6 kaatui ajon 5 jäämään, P-välitys 19100 → t59.sh sulkee P:n ennen vaihetta 4).
- **Tuotantoajo vain luku (18.2x, `t59-tuotanto.sh`, exit 0, lupa 21.10.2026):** B-solmu 7 vrk / 38 Mt tasaantui 197 s, `/api/peili/koko` tavut 39 676 506 = 37,84 Mt ≤ 38 Mt (A: 2,95 Gt, 14 285 yksikköä) → ikkunan katto täyttyy tuotannon kokoisella peilillä. (4)(5): ikkunan sisäisiä skooppeja 0 / 101, koska tuotannossa `istuntoja=0` (ei istuntokartoitusta; speksi: ajetaan ensimmäisestä skoopillisesta tuotantoistunnosta) → ei todiste. Lukuvälitys esti 0 kirjoitusta. Avain poistettu ajon jälkeen.
- **Gate T-49 (d):** ajo 1 18.20–18.27 PUNAINEN (`koeytimen avain puuttuu` ScopesUI2-vaiheessa, ScopesCore2 106/0/1 vihreä; koeytimen avaintiedosto katosi kesken ajon, syy tuntematon, ei toistunut) · ajo 2 18.28–18.35 exit 0 (Core2, UI2, macOS UI, iOS UI, T59UITests ohittuvat). Havainto `scopes2 shared`:lle: avaintiedoston katoaminen kesken gate-ajon (ei kirjattu viaksi, ei toistunut).

## 28.10.2026 — scopes2 ios

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-59-UUSINTA — T-59 ajo 8 punainen 28.10.2026 ((a) peili-koko "–", (b) VANHA näkyy tunneli kiinni ilman haettavissa-riviä; (c) OK): diagnosoi ikkuna-asetuksen kulku äpistä ytimeen, bisect b70dd25c..HEAD (daf6171b T-97, 2aaf1bee T-101), korjaus omistajalle, `bash scopes2/ios/testit/t59/t59.sh` uudelleen, raportti koordinaattorille sessions-repo-e0 — polut: scopes2/ios/testit/t59/**, scopes2/ios/UITests/T59UITests.swift, scopes2/ios/REKISTERI.md — aloitus: /pura scopes2 ios — automaattinen: kyllä

### Vaatimukset — poistettu tai muutettu

| # | Vaatimus | Hyväksyntä | Tila |
|---|---|---|---|
| I-4 | ARK-17 iOS-puoli: Transkriptipeili-asetusosio ja `haettavissa`-rivi | `gate.sh T-58`, T-59 | T-58 vihreä 21.10.2026 (9704e106); T-59 (a)(b)(c) + gate T-49 vihreä 21.10.2026 (b70dd25c), ARK-17 HYVÄKSYTTY 21.10.2026 (SUUNNITELMA 11.5 "T-59:n tulos"); SCOPES2-PALUU-1735-uusinta 28.10.2026 PUNAINEN (ajo 8, ks. Tila T-59); (4)(5) tuotantodatalla ja K-10 laitteella ovat jälkitodennuksia, eivät ehtoja |

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-59-uusinta (SCOPES2-PALUU-1735) | kesken; ajo 8 PUNAINEN 28.10.2026 ((a) koko "–", (b) VANHA tunneli kiinni, ei haettavissa; (c) OK) | VALMIS 28.10.2026: ajo 9 vihreä, raportoitu c2:lle |

### Viat — poistettu tai muutettu

| Vika | Tila |
|---|---|
| T-59 ajo 8 (a)(b) punainen 28.10.2026: iOS-solmun ikkuna ei näytä olevan voimassa (koko "–", VANHA paikallisena); omistaja (ios/shared/ydin) selvittämättä | avoin; odottaa ajoa (todenna viim. 11.11.2026) |

### Viat — valmis

| Vika | Tila |
|---|---|
| T-59 ajo 8 (a)(b) punainen 28.10.2026: omistaja ios (t59.sh ei varmistanut XCFrameworkia), korjaus b9d7c220 | todennettu 28.10.2026 (ajo 9 vihreä, 30bf64b2) |
