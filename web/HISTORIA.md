# scopes2 web — toteutushistoria

## Toteutushistoria

- 20.10.2026 — klo 16.47 T-44 vaiheet 1–3 (käyttäjän lupa AskUserQuestion: "Agentti ajaa vaiheet 3–4 nyt"): release-binääri oli jo käännetty 19.10. 23.51 (V-582:n sivuvaikutus, ydin-HEAD 00eebade jälkeen, `--help` näyttää `--web`), `scopes2/web/dist` 20.10. 9.17; `bash scopes2/kaynnista.sh --sammuta && bash scopes2/kaynnista.sh` → `WEB: …/scopes2/web/dist`, YDIN 12647, ADAPTERI 12649, TERVEYS 200; `/web/` 200. 8787 koskematon.
  - Ensimmäinen vaihe 4 -ajo jumittui 300 s tulostamatta → oma vika: `test/hyvaksynta.ts` fetchit ilman aikarajaa. Korjattu: `AbortSignal.timeout` (api 15 s, terveys 5 s), VIRHE-rivi vanhan terveydestä ja `/api/skoopit`-statuksesta; tuotantoajo kaatuu nyt 6 s:ssa syineen; `bash scopes2/web/gate.sh T-44-koe` exit 0 (HYVÄKSYNTÄ 6/6, EHDOT 3/3, 13 s). Commit 0daca34a.
  - 20.10. ~17.45 vaihe 4 tuotantoa vastaan (`hyvaksynta.ts --osoite :8797 --vanha :8787 --pid 12647 --git-scopes`): HYVÄKSYNTÄ 6/6, EHDOT 2/3 — punainen VmHWM 824460 kB > 512 MiB (RSS 803672 kB 48 min käynnistyksestä). Commit 444cda5f. Raportoitu koordinaattorille (palvelin-e5).
  - V1-jumin diagnostiikka kerätty (ps, top -H, status, fd, ss, limits, lokien häntä); koordinaattori kopioi sen: `~/.local/share/scopes2-varmuus/v1-jumi-20261020/`.
  - /sa päällä (cron-työt dfda8c4d, 8c77c031, uusinta 270a365d 27.10.).
  - viat (ratkaistu, ei rekisteriin): muiden skooppien vikoja (V-613 V1 8787 -jumi; V2-ytimen VmHWM scopes2 ydin), ei tämän rekisterin Viat-taulukkoon
  - todettu (ei rekisteriin): V1 8787 (pid 26929, käynnissä 19.10. 18.26) tukossa 20.10.: pääsäie CPU 100 %, silmukkaviive 3,3 s jo 16.14 → 7–13 s 16.29 alkaen (`~/.local/state/scopes-pyynnot.loki`, tyyppi silmukka), kuuntelujono 129/128, VmHWM 1,24 Gt; toistuvia `GET /api/skoopit/scopes%20kordinaattori/viestit` katkesi:true; cronin `scopes/palvelu/kaynnista.sh` kaatuu EADDRINUSE (terveystarkistus ei tapa jumittunutta).
  - todettu (ei rekisteriin): Toipui itsestään 17.13 (sama pid). V2 `/api/skoopit` palautti jumin aikana 503 (siltahaku 8787).
  - todettu (ei rekisteriin): Koordinaattori: jumi kirjattu V-613.
  - todettu (ei rekisteriin): V1:n pysäytys (kill) estyi auto-mode-luokittimella [Interfere With Workloads]; ei kierretty.
  - todettu (ei rekisteriin): `vika.sh` ei tunne skooppia "scopes palvelu"; `scopes/palvelu`-polun commitit: scopes istunnot 7, chat 6, infra 5, notifications 2.
- 20.10.2026 — /pura scopes2 web; käyttäjä ei valinnut WEB-T44-KAYTTOONOTTOa vaan antoi koordinaattorin (palvelin-e5) tehtävän: T-44:n esiehto `scopes2/web/test/hyvaksynta.ts` puuttui repolta. T-44:ää (tuotannon release, 8797-uudelleenkäynnistys) EI ajettu: koordinaattorin päätös 20.10., tehdään käyttäjän ollessa paikalla.
  - Commit 44862dff (polut scopes2/web/**): uusi `test/hyvaksynta.ts` (kuusi tarkistusta SUUNNITELMA 11.1 T-44: lista=/api/skoopit, eniten viestejä sisältävän skoopin viestimäärä=API, viesti olemattomaan skooppiin → 404 + virhe + ei sivuvaikutusta, chat "Vastaa vain sanalla ok." ensimmäiselle Claude-agentille → ≥1 pala + valmis, rekisterilista + osat-näkymä, PUT /api/tila/koe/web → virtatapahtuma < 2 s), uusi `test/hyvaksynta-koe.ts` (ajaa testin koeytimelle), `gate.sh` (tapaus T-44-koe + itsetestin tarkistus "hyväksyntä ilman avainta → exit 2"), `REKISTERI.md` (T-44:n vaihe 4 = valmis testi).
  - Parametrit: `--osoite` (oletus http://127.0.0.1:18797, ei 8797), avain SCOPES2_AVAIN-ympäristöstä tai `--avain-tiedosto` (ei komentorivillä), valinnaiset ehdot `--vanha <osoite>` (8787-terveys ennen/jälkeen), `--pid <n>` (VmHWM < 512 MiB), `--git-scopes` (git status -- scopes/ ei uusia rivejä).
  - Raportti lähetetty palvelin-e5:lle SendMessagella.
  - todettu (ei rekisteriin): `bash scopes2/web/gate.sh --itsetesti` → ITSETESTI VIHREÄ (exit 0), 20.10.2026.
  - todettu (ei rekisteriin): Ajon jälkeen koeportit 18793–18797 vapaat, /tmp/scopes2-web-hyvaksynta-koe poistettu. 8797, 8787 ja target/release koskemattomia. `cargo build --release` koehakemistoon `target/web-koe`: Finished 0,56 s (ei muutoksia).
  - todettu (ei rekisteriin): Tuotannossa tarkistus 4 lähettää oikean viestin → yksi LLM-kutsu.
- 19.10.2026 — 88729c41 T-38-G: runko, työkaluketju (typescript 5.9.3, esbuild 0.25.12, playwright-core 1.63.0), `test/mock-ydin.mjs` (S-1/S-4/S-6/S-7 fixtureista, `/__testi/*`, `--rooli vanha`), savu.ts, apu.ts, gate.sh.
  - 0079488e T-40: `src/{api,avain,virta,ndjson,tila}.ts`, sovellus.ts, 4 testitiedostoa (38/38).
  - b0796b88 T-41+T-42: kuusi näkymää, savu-viestit.ts, savu-chat.ts; kaksi Sonnet-aliagenttia worktreissä, yhdistin käsin (app.css-hunkit törmäsivät) ja ajoin portit yhdistetyssä puussa.
  - d7c58772 T-43: PWA (manifest, sw.js `scopes2-kuori-<sha256(app.js)[0:8]>`, kuvake), `kaynnista.sh --web`, `test/integraatio.ts` (oikea ydin 18797 + mock-vanha 18796, 7 tarkistusta).
  - 53bb96be, 54920c2b: gate.sh rust()-ympäristö ja erillinen CARGO_TARGET_DIR (oletus `scopes2/ydin/target/web-koe`, tuotannon `target` kielletty), `portit_vapaat()`, `--kohde`; rekisteri SEURAAVA T-44 + H-12.
  - vika.sh TIEDOKSI V-581 → scopes2 (commit 48ba028).
  - todettu (ei rekisteriin): Node 22 `$HOME/.local/opt/node-v22.23.3-linux-arm64/bin`; cargo `$HOME/.cargo/bin` (ei PATHissa); openssl-sys tarvitsee OPENSSL_LIB_DIR=/usr/lib/aarch64-linux-gnu ja OPENSSL_INCLUDE_DIR=/usr/include.
  - todettu (ei rekisteriin): Orpo mock pid 32613 (18796) oli oma: `( cd … && node … & echo $! )` tallensi alikuoren pid:n; gaten trap toimi. Lopetettu.
  - todettu (ei rekisteriin): Gate-aita kaatui toistuvasti muiden sessioiden muutoksiin (scopes2/ydin, scopes2/shared, scopes/KOE.tmp); testivaiheet menivät läpi, T-41/T-42 ajettiin kerran laajennetulla GATE_MAY:llä.
  - todettu (ei rekisteriin): apu.ts `kaynnistaMock` hyväksyy vieraan palvelimen terveysvastauksen omakseen (savu: "title ''"); apu.ts on lukittu, suoja on gate.sh:n portit_vapaat().