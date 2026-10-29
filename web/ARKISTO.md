# scopes2 web — arkisto

Aktiivisesta rekisteristä poistettu tai muutettu tieto sanatarkasti, vanhin ensin (V-082, 28.9.2026).
Tästä ei poisteta mitään. Purku ei lue tätä tiedostoa: se luetaan vain vianselvityksessä, kun
halutaan tietää, mitä rekisterissä on joskus ollut. Kirjoittaja: `claude/siirto/tools/arkisto.mjs`.

## 19.10.2026 — scopes2 web

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: WEB-T44-KAYTTOONOTTO — T-44 käyttäjä aamulla (päätös 19.10.2026 koordinaattorin kautta): tuotannon `scopes2/ydin/target/release` käännetään ja V2 (8797) käynnistetään uudelleen `--web`-tuella; sen jälkeen H-12 käyttäjälle; agentti ei koske 8797:ään eikä `target/release`:iin ennen sitä — aloitus: /pura scopes2 web

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-44: tuotannon release ja V2:n `--web`-uudelleenkäynnistys | odottaa käyttäjää (aamu 20.10.2026; yöllä ei tehty, koska se vaihtaa cronin käynnistämän binäärin) | 1) `cd ~/palvelin/scopes2/ydin && flock /tmp/scopes2-cargo.lock cargo build --release --bin scopes-solmu` (PATH `~/.cargo/bin`, OPENSSL_LIB_DIR=/usr/lib/aarch64-linux-gnu, OPENSSL_INCLUDE_DIR=/usr/include) 2) `node ~/palvelin/scopes2/web/build.mjs` 3) `bash ~/palvelin/scopes2/kaynnista.sh --sammuta && bash ~/palvelin/scopes2/kaynnista.sh` (tulosteessa `WEB: …/scopes2/web/dist`; 8787 ei kosketa) 4) `scopes2/web/test/hyvaksynta.ts` 8797:ää vasten kuten SUUNNITELMA luku 11.1 T-44 |

## 20.10.2026 — scopes2 web

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-44: tuotannon release ja V2:n `--web`-uudelleenkäynnistys | odottaa käyttäjää (aamu 20.10.2026; yöllä ei tehty, koska se vaihtaa cronin käynnistämän binäärin) **19.10.2026:** portit oletusympäristössä: `gate.sh T-43` exit 0 (INTEGRAATIO: 7/7), `--itsetesti` exit 0, `adapteri/gate.sh T-25` ja `T-37` exit 0 (WEB: ei, koska tuotannon ydinbinääri ei tunne `--web`-lippua); tuotannon `scopes2/ydin/target/release/scopes-solmu` (mtime 19.10. 20:31) ei tunne `--web`-lippua; uusi binääri käännetty HEADista (T-39 mukana) `target/web-koe`:hen (2 min 28 s, -j 3, flock). 8797 ja 8787 koskemattomia. `kaynnista.sh --web` todennettu --web-kykyisellä binäärillä koeportissa (WEB-rivi, /web/ 200, --sammuta ok). | 1) `cd ~/palvelin/scopes2/ydin && flock /tmp/scopes2-cargo.lock cargo build --release --bin scopes-solmu` (PATH `~/.cargo/bin`, OPENSSL_LIB_DIR=/usr/lib/aarch64-linux-gnu, OPENSSL_INCLUDE_DIR=/usr/include) 2) `node ~/palvelin/scopes2/web/build.mjs` 3) `bash ~/palvelin/scopes2/kaynnista.sh --sammuta && bash ~/palvelin/scopes2/kaynnista.sh` (tulosteessa `WEB: …/scopes2/web/dist`; 8787 ei kosketa) 4) `SCOPES2_AVAIN=$(cat ~/.config/scopes2/avain) node scopes2/web/test/hyvaksynta.ts --osoite http://127.0.0.1:8797 --vanha http://127.0.0.1:8787 --pid <ytimen pid> --git-scopes` (Node 22; avain ympäristössä, ei komentorivillä; vaihe 4 = **valmis testi 20.10.2026**, kuusi tarkistusta + kolme ehtoa; oletusosoite 18797; koevarmistus `bash scopes2/web/gate.sh T-44-koe` vihreä: HYVÄKSYNTÄ 6/6, EHDOT 3/3, `--itsetesti` vihreä; koeydin 18797 + mock-vanha 18796, kertakäyttöavain) |

## 20.10.2026 — scopes2 web

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: WEB-T44-KAYTTOONOTTO — T-44 käyttäjä aamulla (päätös 19.10.2026 koordinaattorin kautta): tuotannon `scopes2/ydin/target/release` käännetään ja V2 (8797) käynnistetään uudelleen `--web`-tuella; sen jälkeen H-12 käyttäjälle; agentti ei koske 8797:ään eikä `target/release`:iin ennen sitä — polut: scopes2/web/** — aloitus: /pura scopes2 web

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-44: tuotannon release ja V2:n `--web`-uudelleenkäynnistys **20.10.2026:** `bash scopes2/web/gate.sh T-44-koe` → HYVÄKSYNTÄ 6/6, EHDOT 3/3, PORTTI VIHREÄ (exit 0). Ensimmäinen ajo oli 5/6: tarkistus 5 otti ensimmäisen rekisterin, mutta mock-ytimellä vain `test/REKISTERI.md`:llä on osia → testi valitsee nyt ensimmäisen rekisterin, jonka `/api/rekisterit/<polku>`-vastauksessa on osia. | **20.10.2026 klo ~17.45 vaihe 4 tuotantoa vastaan:** HYVÄKSYNTÄ 6/6, EHDOT 2/3 — punainen: ytimen VmHWM 824460 kB > 512 MiB (pid 12647, RSS 803672 kB 48 min käynnistyksestä; koeytimellä ehto vihreä); vanha 200 ennen/jälkeen ja scopes/-puu koskematon vihreät. V1 8787 toipui itsestään 17.13 (sama pid 26929, ei uudelleenkäynnistystä). Muistiraja on ytimen asia → koordinaattori päättää. **20.10.2026 klo 16.47:** vaiheet 1–3 tehty (käyttäjän lupa: agentti ajaa 3–4): release-binääri oli jo käännetty 19.10. 23.51 (V-582, ydin-HEAD 00eebade jälkeen, tuntee `--web`), dist 20.10. 9.17; `kaynnista.sh --sammuta && kaynnista.sh` → `WEB: …/scopes2/web/dist`, YDIN 12647, TERVEYS 200; `/web/` 200. Vaihe 4 odottaa V1:tä: 8787 tukossa (CPU 100 %, silmukkaviive 7–13 s klo 16.29 alkaen, ennen V2:n uudelleenkäynnistystä) → V2 `/api/skoopit` 503; käyttäjä kirjaa V1:n omistajalle, agentti ajaa vaiheen 4 kun 8787 vastaa. Aiempi: odottaa käyttäjää (aamu 20.10.2026; yöllä ei tehty, koska se vaihtaa cronin käynnistämän binäärin) **19.10.2026:** portit oletusympäristössä: `gate.sh T-43` exit 0 (INTEGRAATIO: 7/7), `--itsetesti` exit 0, `adapteri/gate.sh T-25` ja `T-37` exit 0 (WEB: ei, koska tuotannon ydinbinääri ei tunne `--web`-lippua); tuotannon `scopes2/ydin/target/release/scopes-solmu` (mtime 19.10. 20:31) ei tunne `--web`-lippua; uusi binääri käännetty HEADista (T-39 mukana) `target/web-koe`:hen (2 min 28 s, -j 3, flock). 8797 ja 8787 koskemattomia. `kaynnista.sh --web` todennettu --web-kykyisellä binäärillä koeportissa (WEB-rivi, /web/ 200, --sammuta ok). | 1) `cd ~/palvelin/scopes2/ydin && flock /tmp/scopes2-cargo.lock cargo build --release --bin scopes-solmu` (PATH `~/.cargo/bin`, OPENSSL_LIB_DIR=/usr/lib/aarch64-linux-gnu, OPENSSL_INCLUDE_DIR=/usr/include) 2) `node ~/palvelin/scopes2/web/build.mjs` 3) `bash ~/palvelin/scopes2/kaynnista.sh --sammuta && bash ~/palvelin/scopes2/kaynnista.sh` (tulosteessa `WEB: …/scopes2/web/dist`; 8787 ei kosketa) 4) `SCOPES2_AVAIN=$(cat ~/.config/scopes2/avain) node scopes2/web/test/hyvaksynta.ts --osoite http://127.0.0.1:8797 --vanha http://127.0.0.1:8787 --pid <ytimen pid> --git-scopes` (Node 22; avain ympäristössä, ei komentorivillä; vaihe 4 = **valmis testi 20.10.2026**, kuusi tarkistusta + kolme ehtoa; oletusosoite 18797; koevarmistus `bash scopes2/web/gate.sh T-44-koe` vihreä: HYVÄKSYNTÄ 6/6, EHDOT 3/3, `--itsetesti` vihreä; koeydin 18797 + mock-vanha 18796, kertakäyttöavain) |
| H-12: viesti todelliseen skooppi-istuntoon V2:n web-asiakkaasta | odottaa käyttäjää; T-44:n jälkeen | selaimessa `http://127.0.0.1:8797/web/#avain=<~/.config/scopes2/avain>` (Macilta `ssh -L 8797:127.0.0.1:8797 palvelin`): valitse skooppi, lähetä viesti, tarkista että se tulee istuntoon |

### Viat — poistettu tai muutettu

| Vika | Tila |
|---|---|
| `test/hyvaksynta.ts` `terveys()` ja `api()` kutsuvat fetchiä ilman aikarajaa: T-44:n tuotantoajo 20.10.2026 jumittui 300 s (ulkoinen `timeout`), tulostamatta mitään, kun vanha palvelu 8787 ei vastannut (V1 CPU 100 %, silmukkaviive 7–13 s, kuuntelujono 129/128). | korjattu 20.10.2026: `AbortSignal.timeout` (api 15 s, terveys 5 s), VIRHE-rivi vanhan terveydestä ja `/api/skoopit`-statuksesta; tuotantoajo kaatuu nyt 6 s:ssa syineen, `gate.sh T-44-koe` vihreä (6/6, 3/3) |

### Viat — valmis

| Vika | Tila |
|---|---|
| `test/hyvaksynta.ts` `terveys()` ja `api()` kutsuvat fetchiä ilman aikarajaa: T-44:n tuotantoajo 20.10.2026 jumittui 300 s (ulkoinen `timeout`), tulostamatta mitään, kun vanha palvelu 8787 ei vastannut (V1 CPU 100 %, silmukkaviive 7–13 s, kuuntelujono 129/128). | korjattu 0daca34a 20.10.2026: `AbortSignal.timeout` (api 15 s, terveys 5 s), VIRHE-rivi vanhan terveydestä ja `/api/skoopit`-statuksesta; tuotantoajo kaatuu nyt 6 s:ssa syineen, `gate.sh T-44-koe` vihreä (6/6, 3/3) |
