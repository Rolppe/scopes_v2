# scopes2 shared — arkisto

Aktiivisesta rekisteristä poistettu tai muutettu tieto sanatarkasti, vanhin ensin (V-082, 28.9.2026).
Tästä ei poisteta mitään. Purku ei lue tätä tiedostoa: se luetaan vain vianselvityksessä, kun
halutaan tietää, mitä rekisterissä on joskus ollut. Kirjoittaja: `claude/siirto/tools/arkisto.mjs`.

## 19.10.2026 — scopes2 shared

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: SHARED-T45G-RUNKO — T-45-G (Sonnet, brief `scopes/toteutussuunnitelma/briefit/T-45-G.md`, SUUNNITELMA luku 11.2): Apple-runko ja portti `scopes2/shared/gate.sh` Macilla ssh:n yli (ScopesCore2/ScopesUI2 tyhjinä, `scopes2/ios|macos/project.yml`); H-2 tehty (PATH=$HOME/.cargo/bin:$PATH Macilla), H-7 LuLu käyttäjällä; sitten T-47 → T-48 (vaativat H-14 tunneli ja H-15 avain) — polut: scopes2/shared/** (T-45-G:n may sisältää lisäksi scopes2/ios/project.yml ja scopes2/macos/project.yml, SUUNNITELMA 11.2) — aloitus: /pura scopes2 shared

## 20.10.2026 — scopes2 shared

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-52 (ARK-09, Macin kaksi laitetta) — odottaa T-49:ää (scopes2 ios ja macos) ja ytimen T-50:n vakautta — polut: scopes2/shared/gate.sh — aloitus: /pura scopes2 shared

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-52 (ARK-09, Macin kaksi laitetta) | odottaa T-49:ää ja ytimen T-50:n vakautta | aja `bash scopes2/shared/gate.sh T-52`, kun T-49 on vihreä |

## 20.10.2026 — scopes2 shared

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-52 jatko (Opus, ARK-09) — koodi valmis työpuussa mutta commitoimatta, portti punainen: korjaa iOS RunkoUITests.testViestitVastaavatPalvelinta, aja gate T-52 vihreäksi ja commitoi (ks. päätösrivi "T-52 tila") — polut: scopes2/shared/gate.sh — aloitus: /pura scopes2 shared

### Päätökset — poistettu tai muutettu

  - **gate.sh:182** tulostaa ajon lopussa "MACLUKKO[1]: sitomaton muuttuja" (`mac_lukko_vapauta` kutsuu `eval "exec ${MACLUKKO[1]}>&-"` tilassa `set -u`, kun lukkoprosessia ei ole käynnissä). Haitaton varoitus, ei muuta exit-koodia; korjaus: `${MACLUKKO[1]:-}`-suojaus.

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-52 (ARK-09, kaksi laitetta): koodi valmis työpuussa, commitoimatta; portti punainen | avoin (todenna viim. 3.11.2026) | Opus: aja iOS testViestitVastaavatPalvelinta ilman `-quiet`:iä ja korjaa, aja `gate.sh T-52` vihreäksi, commitoi T-52 ja T-49-testivakautus erikseen; tiedostot päätösrivillä "T-52 tila" |

### Viat — poistettu tai muutettu

| Vika | Tila |
|---|---|
| iOS `RunkoUITests.testViestitVastaavatPalvelinta` kaatuu myös vakautuksen jälkeen portissa (2351 s), syy tallentamatta; harness-ajo 0,2 s "Array vs dictionary" (`/api/skoopit` palautti olion). | avoin (todenna viim. 3.11.2026) |
| gate.sh:182 `MACLUKKO[1]: sitomaton muuttuja` ajon lopussa (set -u + puuttuva lukkoprosessi); haitaton; korjaus `${MACLUKKO[1]:-}`. | avoin (todenna viim. 3.11.2026) |

## 20.10.2026 — scopes2 shared

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-52 jatko Macilla (Opus, ARK-09) — sovella scopes2/shared/T-52-TYOPUU.patch, sovita gate.sh Macille (koeytimen flock, ss, OPENSSL ja tunneli; ks. muistion avoimet asiat), aja gate T-52, kun 8787 (V-613) on vakaa ja Macilla ei tehdä muuta; vihreällä kolme committia (gate.sh, T-52, T-49-vakautus) ja patch pois — polut: scopes2/shared/gate.sh, scopes2/shared/T-52-TYOPUU.patch — aloitus: /pura scopes2 shared

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-52 (ARK-09, kaksi laitetta): VIHREÄ 20.10.2026 ajo 11 (21.03–21.13, exit 0; valinta 91, luonnos 151, vierityskohta 84, kuittaus 1139, headless 4388 ms; loki ~/.local/state/scopes2-t52-lokit/portti-t52k.log). Koodi 70170bc1, gate.sh c17ed80c, KL-vakautus (synkattu valinta avaaSkooppi-polussa) tässä committissa | tehty | Avoin este jatkoon: `--tunnelitesti` ajettava palvelimelta uudelleen (Mac-lukko coproc → FIFO myös ssh-polulla) |

### Viat — poistettu tai muutettu

| Vika | Tila |
|---|---|
| iOS `RunkoUITests.testViestitVastaavatPalvelinta` kaatui ajossa 2 (syy tallentamatta); erillisajo 20.10. 15.17 vihreä (1339 s); "Array vs dictionary" oli 401 väärällä avaimella. Todennäköinen syy: sama sillan 5xx kuin ajossa 6; korjaus: `palvelin()`-uusinta. | avoin: todennetaan seuraavassa portissa, jossa `xtesti` tallentaa syyn (todenna viim. 3.11.2026) |

## 20.10.2026 — scopes2 shared

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: TUNNELITESTI — gate.sh --tunnelitesti palvelimelta (Mac-lukko coproc → FIFO myös ssh-polulla), kun palvelimen ~/palvelin on synkattu (23 vaihevirheet.jsonl-riviä talteen claude siirrolle → stash → reset origin-haaraan; käyttäjän päätös koordinaattorin avoimissa), Mac vapaa ja palvelimella > 1536 Mt vapaata — polut: scopes2/shared/gate.sh — aloitus: /pura scopes2 shared

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| TUNNELITESTI | avoin | `bash scopes2/shared/gate.sh --tunnelitesti` palvelimelta, kun palvelimen ~/palvelin on synkattu (23 vaihevirheet.jsonl-riviä talteen claude siirrolle → stash → reset origin-haaraan; käyttäjän päätös koordinaattorin avoimissa), Mac vapaa ja palvelimella > 1536 Mt vapaata. |

## 20.10.2026 — scopes2 shared

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| V-605 gate.sh-rinnakkaistus | kesken; odottaa konetta mac (todennus koordinaattorin vuorolla, itsetesti vihreä 20.10.2026) | Koordinaattori ajaa `scopes2/shared/V-605.md`:n todennuskohdat 1–5 palvelimelta. |

## 21.10.2026 — scopes2 shared

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-87 — Android-etäohjaus ja palvelimen paneeli V2-äppeihin (ARK-19; brief `scopes/toteutussuunnitelma/briefit/T-87.md`): koodi valmis ja käännetty COMMITOIMATTA worktreessä `~/sessions-repo-t87` (30028f77; ScopesCore2 94 testiä, OhjausTests 28, macOS/iOS build-for-testing ok; UI-testit ajamatta); Acceptance (gate.sh T-87, T-49) odottaa skooppia scopes2 ydin (T-64: ytimen `--adapteri`-lippu puuttuu, koeydin_ohjaus_alku kaatuu ilman sitä) ja koordinaattorin UI-vuoroa — polut: briefin may-lista — aloitus: /pura scopes2 shared

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| Testidatan siemennys koeytimeen (T-62) | valmis 21.10.2026: siemen `koeydin_alku`:ssa ("SIEMEN: test 17 viestiä", `ruutu` → voiLahettaa), T-49 vihreä (testViestitVastaavatPalvelinta Passed macOS + iOS), T-52 5/5 avaaSkooppi-paluulla sivupalkkiin; koeportti P-6 (18800–18819), Darwinin koeydin-cargo Macin cargo-lukolla | Acceptance-poikkeama: tuotannon /viestit-tilaa ei luettu (koordinaattori fe: V-KORD-4), siemen todistettu koeytimen tulosteella. Jatkotehtävä toteutussuunnitelmalle (fe → 9f). |
| T-71 Kehitys-osio, näyttö hereillä ja diagnostiikka (ARK-18, K-11) | valmis 21.10.2026: T-71 (NAYTTO-HEREILLA ok, testKehitysOsio), T-49 ja T-52 5/5 vihreitä worktreestä; kaksi testikorjausta: pmset-väite pid:n ja tyypin perusteella (pmset tulostaa ääkköset korvausmerkkeinä), tilateksti value-kentästä | Automaatio-lupa (osascript quit → ScopesV2Mac) on annettu ja toimii. |
| V-605 gate.sh-rinnakkaistus | valmis 21.10.2026: kohdat 1–5 vihreitä (itsetesti 29 ok; tunnelitesti 24 ok; T-49 273 s; T-48 ∥ T-47 603 s vs 994 s; T-52 5/5), tulokset V-605.md | Toteutussuunnitelma päivittää P-14/P-15 ja T-48/T-49 (V-605.md "Muiden skooppien dokumentit"); koordinaattori välittää. |

### Viat — poistettu tai muutettu

| Vika | Tila |
|---|---|
| V-605:n kuvaus (92d8cb81, V-605.md) väitti ajokohtaista `~/scopes2-rakennus-<ajo>`:a myös Darwinille; Macilla RAK = työpuu, joten saman puun ajot sarjoittuvat ja XCFramework rakentuu työpuun keskeneräisestä ydin/src:stä (T-49 20.10.2026 23.37, exit 2, ei todisteeksi). | korjattu kuvaus (gate.sh:14–17, V-605.md); Mac-todennus erillisistä worktreeistä |

## 21.10.2026 — scopes2 shared

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-87 — Android-etäohjaus ja palvelimen paneeli V2-äppeihin (ARK-19; brief `scopes/toteutussuunnitelma/briefit/T-87.md`): koodi valmis ja käännetty COMMITOIMATTA worktreessä `~/sessions-repo-t87` (30028f77; ScopesCore2 94 testiä, OhjausTests 28, macOS/iOS build-for-testing ok; UI-testit ajamatta); Acceptance (gate.sh T-87, T-49) odottaa skooppia scopes2 ydin (T-64: ytimen `--adapteri`-lippu puuttuu, koeydin_ohjaus_alku kaatuu ilman sitä) ja koordinaattorin UI-vuoroa — polut: scopes2/shared/ScopesCore2/Sources/ScopesCore2/Ohjaus.swift, scopes2/shared/gate.sh, scopes2/shared/testit/mock-ohjaus.mjs — aloitus: /pura scopes2 shared

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-87 Acceptance (Android-etäohjaus, palvelin-paneeli, ARK-19) | kesken (koodi valmis worktreessä t87, commitoimatta); odottaa skooppia scopes2 ydin | Odottaa ytimen T-64:ää (`--adapteri`) ja koordinaattorin UI-vuoroa. T-64:n jälkeen worktree t87 rebase HEADiin, `gate.sh T-87` → `T-49`, sitten commit polkuina. |
| Worktree t87 (`~/sessions-repo-t87`) | avoin (commitoimaton koodi: 11 polkua + 72 fixturea, kaikki briefin may-listalla) | Ei saa poistaa ennen committia. |
