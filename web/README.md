# web — scopes-V2:n web-asiakas

Rakenne: `src/` (index.html, app.css, main.ts, sovellus.ts, nakymat/*.ts) → `dist/` (build.mjs; esbuild-niputus `app.js`, kopiot `index.html` ja `app.css`); `test/` (mock-ydin.mjs, apu.ts, savu*.ts, *.test.ts). `dist/` ja `node_modules/` eivät ole git-puussa.

Ajo (Node 22 tai uudempi, koska testit ajetaan suoraan .ts:stä Noden tyyppienriisunnalla):

    npm ci
    node build.mjs                                   # dist/
    node test/mock-ydin.mjs --portti 18796 --dist dist [--rooli ydin|vanha] [--ka <ms>]
    node --test test/*.test.ts                       # yksikkötestit

Mock-ydin tarjoilee `dist/`:n ja vastaa API:ssa ytimen fixtureista (`ydin/tests/fixture/`), Bearer-avain `testiavain`. Muutosloki alkaa seq:stä 10: `since` < 10 → nollaus. Testiohjaus (vain 127.0.0.1, ei avainta): `POST /__testi/tapahtuma {"polku","id"[,"poistettu":true][,"skooppi","viesti":{…}]}`, `GET /__testi/kirjatut`, `POST /__testi/katko`. Selaintestit (`savu*.ts`, `hyvaksynta*.ts`, `integraatio.ts`) käyttävät Chromiumia: polku ympäristömuuttujasta `SCOPES2_CHROMIUM`, muuten järjestelmän tai Playwrightin välimuistin Chromium. `tsc` tarkistaa vain `src/`: `test/`-tiedostot ajetaan Noden tyyppienriisunnalla, koska `@types/node` ei kuulu kiinnitettyyn työkaluketjuun.

Periaatteet: ei kehystä (selaimen DOM ja TypeScript ilman React/Vue/Svelte-tyyppistä kehystä, DOM vain createElement/textContent/setAttribute); virta fetch-virtana: EventSource ei lähetä otsakkeita, joten `Authorization: Bearer` ja `Last-Event-ID` kulkevat fetchillä; työkaluketju kiinnitetty (typescript 5.9.3, esbuild 0.25.12, playwright-core 1.63.0, ei `dependencies`-kenttää).
