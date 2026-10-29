# scopes2/macos/REKISTERI.md

Tilanne: 28.10.2026

SEURAAVA PAKETTI: ei mitään — odottaa käyttäjää: Tuotantobinäärin palautus (V-582) (T-44 ajetaan käyttäjän ollessa paikalla, ei tämän skoopin työ) (T-72 valmis ja hyväksytty 28.10.2026, ei tämän skoopin odottavia rivejä)

## Tarkoitus ja raja

scopes-V2:n macOS-äppi (ARK-08)

## Päätökset

- **Käyttäjä 19.10.2026:** skooppi `scopes2 macos` luotiin komennolla `/pura uusi scopes2 macos`.

- **19.10.2026:** Ei kirjattuja päätöksiä: deterministinen synteesi ei tulkitse keskustelun linjauksia

- **20.10.2026:** Käyttäjä 20.10.2026: V-582 päätetty (851b0343): uusi HEAD-binääri jää target/release:iin, vanhaa ei palauteta, varmuuskopio säilyy, T-44 käyttäjän ollessa paikalla.

- **20.10.2026:** Käyttäjä 20.10.2026: "älä sammuta näyttöä" -kytkin tehdään scopes-V2 macOS-äpin asetuksiin (kaikki Mac-kehitykseen tarvittavat asetukset), ei Ohjauskeskus-ControlWidgetinä (vaatisi allekirjoitetun laajennuksen) eikä Shortcutsina; ei ajeta scopes architecturen kautta tässä skoopissa → V-584 scopes macos -skoopille (V-583 jäi architectureen, ei poisteta).

- **20.10.2026:** Koordinaattori: tuotannon target/release:iin ei rakenneta enää; portin koeydin target/koe:ssa; GATE_MAY sisältää claude/siirto/mittaukset/.

- **20.10.2026:** Oma ratkaisu (POIKKEAA kirjattu): GATE_MAC_TIMEOUT 1800 → 3300 s vain ajon ympäristömuuttujana.

- **21.10.2026:** Käytäntö jokaisen UI-ajon ENNEN-tarkistukseen (T-72 ARK-18:n osa B kaatui 21.10. lukittuun istuntoon, screenLock immediate): `pgrep -fl ScopesV2Mac` (odotus tyhjä) + `pmset -g assertions` (ei muuta näyttöpitoa kuin Clauden/järjestelmän). T-72 hyväksytty 28.10.2026 (ks. alla).

- **21.10.2026 (koordinaattori, agy-pakkaus):** agy Flash -ajo valmis: T-100 1cfce137 (T-72 (4) vihreäksi, kommentit ilman ssh-caffeinatea; gate.sh --itsetesti vihreä, grep caffeinate 0 osumaa). Raportti ~/agy-raportit/T-100; worktree poistettu.

- **28.10.2026 (koordinaattori, PALUU-1735):** T-100 (1cfce137) tarkistettu lähteestä: kaksi kommenttiriviä, `grep -rniE caffeinate scopes2/macos/UITests scopes2/shared/testit` 0 osumaa → uudelleentekoa ei tarvita.

- **28.10.2026 (koordinaattori c2):** T-72 osa B: diagnostiikka ensin, enintään 3 ajoa (KEHITYSMALLI 3.4); käytetty 2/3, ei lisäajoja. Diagnostiikka (vain lokirivejä) committoitu. T-72 hyväksytty (portti T-49 vihreä, kaikki neljä kohtaa OK, raportti ~/agy-raportit/T-72/RAPORTTI.md). Jos AUKKO toistuu: `laske()`-logiikka menee sharedin tai toteutussuunnitelman päätettäväksi (shared omistaa laske()-logiikan, 20.10. päätös).

- **28.10.2026:** Tämä skooppi ei raportoi koordinaattorille eikä overseerille ilman käyttäjän pyyntöä (muistisääntö 21.10.2026); poikkeus: ihmisvaiheen pyyntö overseerille ja yksirivinen vuoronluovutus koordinaattorille (koordinaattorin sessionimi 28.10. alkaen sessions-repo-c2). Toisten skooppien likaiset tiedostot jätetään koskematta (V-KORD-5).

## Avoimet asiat

| Asia | Tila | Seuraava askel |
|---|---|---|
| V-584 kehitysasetukset äpissä (näytön hereillä pito ensin) | avoin (siirretty skoopille scopes macos 20.10.2026, ei tämän skoopin työ); odottaa skooppia scopes macos | ei jatkotoimia tässä skoopissa |
| Tuotantobinäärin palautus (V-582) | avoin (päätetty 20.10.2026, scopes/kordinaattori/REKISTERI.md, 851b0343: uusi HEAD-binääri jää target/release:iin, varmuuskopio ~/.local/share/scopes2-varmuus/scopes-solmu.tuotanto-20-31 säilyy); odottaa käyttäjää | T-44 ajetaan käyttäjän ollessa paikalla (ei tämän skoopin työ) |
| GATE_MAC_TIMEOUT-oletus ja Viestit-testin 12 min | avoin (ehdotus lähetetty scopes2 shared -skoopille); odottaa skooppia scopes2 shared | scopes2 shared päättää |
| `testViestitVastaavatPalvelinta` ajoittainen kaatuminen `limitys katkesi` (RunkoUITests.swift:197, `laske()`) | avoin; odottaa ajoa (todenna viim. 11.11.2026; 1 punainen ajo 2:sta 28.10.2026, syy todistamatta, diagnostiikka 541db0ca asennettu, c2 kielsi lisäajot) | kun AUKKO toistuu tulevassa T-49-ajossa: ota xcresultin `laskenta`-liite talteen ja raportoi c2:lle; laske()-logiikka on sharedin |

## Viat

| Vika | Tila |
|---|---|
| V-584 (scopes macos): vaatimus, ks. Päätökset. | avoin |

## Historia

Historia: `scopes2/macos/HISTORIA.md`, ei lueta purussa.
