# scopes2/web — scopes-V2:n web-asiakas (ARK-10)

Rakenne: `src/` (index.html, app.css, main.ts, sovellus.ts, nakymat/*.ts) → `dist/` (build.mjs; esbuild-niputus `app.js`, kopiot `index.html` ja `app.css`); `test/` (mock-ydin.mjs, apu.ts, savu*.ts, *.test.ts); `gate.sh` (portti). `dist/` ja `node_modules/` eivät ole git-puussa.

Ajo (Node 22: `$HOME/.local/opt/node-v22.23.3-linux-arm64/bin`; järjestelmän node 20 ei riisu tyyppejä):

    node build.mjs                                   # dist/
    node test/mock-ydin.mjs --portti 18796 --dist dist [--rooli ydin|vanha] [--ka <ms>]
    node --test test/*.test.ts                       # yksikkötestit suoraan .ts:stä
    bash scopes2/web/gate.sh --itsetesti             # portin oma testi
    bash scopes2/web/gate.sh T-38                    # tapaukset T-38, T-40, T-41, T-42, T-43

Mock-ydin tarjoilee `dist/`:n S-7:n mukaan ja vastaa API:ssa ytimen fixtureista (`scopes2/ydin/tests/fixture/`), Bearer-avain `testiavain`. Muutosloki alkaa seq:stä 10: `since` < 10 → nollaus. Testiohjaus (vain 127.0.0.1, ei avainta): `POST /__testi/tapahtuma {"polku","id"[,"poistettu":true][,"skooppi","viesti":{…}]}`, `GET /__testi/kirjatut`, `POST /__testi/katko`. Portti ajaa Chromiumin (`/usr/bin/chromium`) vain kun `free -m` available ≥ 1536 Mt ja `flock /tmp/scopes2-cargo.lock` on vapaa. `tsc` tarkistaa vain `src/`: `test/`-tiedostot ajetaan Noden tyyppienriisunnalla, koska `@types/node` ei kuulu kiinnitettyyn työkaluketjuun (P-13).

P-2, P-12 ja P-13 pitävät: ei kehystä (selaimen DOM ja TypeScript ilman React/Vue/Svelte-tyyppistä kehystä, DOM vain createElement/textContent/setAttribute); virta fetch-virtana: EventSource ei lähetä otsakkeita, joten `Authorization: Bearer` ja `Last-Event-ID` kulkevat fetchillä; työkaluketju kiinnitetty (typescript 5.9.3, esbuild 0.25.12, playwright-core 1.63.0, ei `dependencies`-kenttää).
