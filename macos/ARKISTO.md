# scopes2 macos — arkisto

Aktiivisesta rekisteristä poistettu tai muutettu tieto sanatarkasti, vanhin ensin (V-082, 28.9.2026).
Tästä ei poisteta mitään. Purku ei lue tätä tiedostoa: se luetaan vain vianselvityksessä, kun
halutaan tietää, mitä rekisterissä on joskus ollut. Kirjoittaja: `claude/siirto/tools/arkisto.mjs`.

## 20.10.2026 — scopes2 macos

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: MACOS-T49-KUORI — T-49:n macOS-osa (SUUNNITELMA luku 11.2) alkaa, kun T-48 (ScopesUI2, scopes2 shared) on vihreä; portti `scopes2/shared/gate.sh T-49` — polut: scopes2/macos/** — aloitus: /pura scopes2 macos

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| Skooppi on vasta luotu | luotu 19.10.2026 | paketti MACOS-MAARITTELY |

### Avoimet asiat — valmis

| Asia | Tila | Seuraava askel |
|---|---|---|
| V-577 scopes2 shared kirjoitti macos-tiedostot (T-45-G) | valmis 20.10.2026 (T-49 kirjoitti tiedostot uudelleen macos-skoopissa, omistus tällä) | ei jatkotoimia, IDEAT-rivi suljettavissa |

## 28.10.2026 — scopes2 macos

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-72 osa B (kohdat 2 ja 3) odottaa ihmisvaihetta: käyttäjä Macin ääressä avaamassa lukituksen displaysleepnow:n jälkeen (scopes/toteutussuunnitelma/agy/T-72.md B2). Worktree ~/sessions-repo-t71d (HEAD b3f9ed1f, tuore XCFramework + koe-solmu) jäi osaa B varten. Aiemmin: T-71-diagnoosiajo VIHREÄ 28.10.2026.

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-72 ARK-18 hyväksyntä (osa B) | punainen 21.10.2026 (lukittu näyttö estää UI-testit; T-71 testKehitysOsio -toisto epäselvä); worktree t72 jäi | overseer päättää T-71:n toiston ja K-11-todennuksen idle-sammutuksella; ei ajoja ennen sitä |

### Historia — poistettu tai muutettu

Historia: `scopes2/macos/HISTORIA.md` (syntyy ensimmäisessä pakkauksessa), ei lueta purussa.
- **28.10.2026 (overseer b3f9ed1f, T-71-diagnoosiajo):** tuore worktree ~/sessions-repo-t71d HEADista b3f9ed1f, `GATE_AJO=t71d bash scopes2/shared/gate.sh T-71` näyttö auki (screenLock immediate, pgrep -x ScopesV2Mac tyhjä, ei lukkoja): EXIT=0, NAYTTO-HEREILLA: ok, KEHITYS-OSIO: ok, PORTTI VIHREÄ: T-71 (testKehitysOsio 08.34, XCFramework + koe-solmu rakennettu uudelleen ajossa). 21.10.-kaatumisen syy jäi todentamatta mutta ei toistunut tuoreilla artefakteilla → vanhat artefaktit (8bb9fb03-worktree) ainoa todettu ero. Tarkkailuskripti sai vain pmset-vaiheen äpin (pid 41878); testiäpin lsof/sample ei tarvittu. Loki: scratchpad t71d/gate.log. Seuraavaksi T-72 B ihmisvaiheella.

## 28.10.2026 — scopes2 macos

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-72 osa B (kohdat 2 ja 3) odottaa ihmisvaihetta: käyttäjä Macin ääressä avaamassa lukituksen displaysleepnow:n jälkeen (scopes/toteutussuunnitelma/agy/T-72.md B2). Worktree ~/sessions-repo-t71d (HEAD b3f9ed1f, tuore XCFramework + koe-solmu) jäi osaa B varten. Aiemmin: T-71-diagnoosiajo VIHREÄ 28.10.2026. — polut: scopes2/macos/** — aloitus: /pura scopes2 macos

### Päätökset — poistettu tai muutettu

- **21.10.2026:** T-72 ARK-18:n hyväksyntäajo (overseer 185235, käyttäjä paikalla; raportti ~/agy-raportit/T-72/RAPORTTI.md, worktree ~/sessions-repo-t72 HEAD 8bb9fb03 jäi). Osa A: (1) T-71-portti vihreä, (4) caffeinate vain kommenttirivi. Osa B kahdesti PUNAINEN: T-49 `pmset displaysleepnow` jälkeen kaikki macOS-UI-testit kaatuivat ('Failed to activate application … Running Background'), sampler LOCKED=1 22/23 → lukittu istunto (screenLock immediate) estää XCUI:n; (2) caffeinate OK (vain Clauden oma), (3) iOS-vaihe ei ajettu → T-72 EI hyväksyttävissä nykyasetelmalla. Käyttäjän Awake (~/.gemini/.../AwakeApp, pid 63969) ei ollut syy; T-71:n pmset-tunnistus on pid/nimi-pohjainen. Uusinnan T-71 testKehitysOsio kaatui näyttö hereillä: syyksi epäillään vierasta ScopesV2Mac-instanssia (pid 37691, jaetun kloonin build, sama bundle-id; suljettu 19.47 käyttäjän luvalla) – ei todistettu. Käytäntö: jokaisen UI-ajon ENNEN-tarkistukseen `pgrep -fl ScopesV2Mac` (odotus tyhjä) + `pmset -g assertions` (ei muuta näyttöpitoa kuin Clauden/järjestelmän). Vaihtoehto K-11 -todennukselle: idle-sammutus (displaysleep 5 min, käyttäjä ei koske Maciin, T-49 ajetaan sen aikana, sampler LOCKED=0) tai displaysleepnow pois (2):sta – päätös overseerille. Ei ajoja ennen overseerin päätöstä.

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-72 ARK-18 hyväksyntä (osa B, kohdat 2 ja 3) | kesken; odottaa käyttäjää (ihmisvaihe: lukitus avataan `pmset displaysleepnow`:n jälkeen Macin ääressä; T-71 vihreä 28.10.2026 tuoreilla artefakteilla, osa A ok 21.10.) | ajetaan worktreessä ~/sessions-repo-t71d (HEAD b3f9ed1f, ei poistoa --force:lla); overseer (sessions-repo-15) tuo ihmisvaiheen käyttäjälle |
