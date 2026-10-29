# T-59 simulaattoriosa — toteutussuunnitelma (d5, 21.10.2026)

Määrittely: scopes/toteutussuunnitelma/SUUNNITELMA.md:517 (T-59). Tämä tiedosto kattaa vain simulaattoriosan:
(a) asetusnäkymän koko ≤ katto pakotetulla ikkunalla, (b) 7 vrk:n viestit näkyvät "tunneli suljettuna",
(c) vanha istunto hakee viestit tunnelin palattua. (d) "toinen simulaattori ilman ikkunaa" = gate T-49 (pääistunto ajaa).
Kohdat (4)(5) tuotantodatalla EIVÄT kuulu tähän (odottavat käyttäjän lupaa) — älä koske 8797:ään.

## Ytimen faktat (Explore, HEAD ee80aa31; polut scopes2/-alla)
- Ikkuna = yksikön sisältöaika = rivien suurin `timestamp` (ydin/src/peili.rs:555-580, 661-668). Ei kello-env:iä. Vanha data = vanhat timestampit.
- Yksikkö = yksi POST /api/peili (offset tavuina, sha256 vain sen POSTin riveistä; peili.rs:196-201, 240-253).
- Kokonaan ikkunan ulkopuolinen istunto ei hae koskaan (peili.rs:957-961) → S2:n pitää olla sekaistunto:
  yksikkö 1 offset 0 VANHA (timestampit esim. 2026-10-05), yksikkö 2 offset = yksikön 1 tavukoko TUORE (esim. 2026-10-20).
- S-9e-haku käynnistyy /viestit-pyynnöstä, kun pohja on (pohja.rivi>0) ja viestejä < 120; enintään kerran / 60 s / tiedosto,
  uudessa prosessissa heti (nakymat.rs:2043-2182). haettavissa=true, kun viimeisin haku epäonnistui.
- Äpin solmun vertainen = env SCOPES2_VERTAINEN (Solmu.swift:150-153; ScopesV2App.swift:64-69: myös `vanha`).
  Ikkuna: käynnistysargumentti `-scopes2.peili-ikkuna-vrk 7`. Data-hakemisto: env SCOPES2_DATA.
- Siemen mallina: scopes2/shared/gate.sh:220-290 (koeydin_siemen; S1 = testidata/siemen-*, skooppi "test", timestampit 19.10. = ikkunassa).
  koeydin_kaynnista gate.sh:292-330 (Darwin: paikallinen koeydin, --vanha = Macin silta 8787:ään).

## Rakenne
1. Koeydin A (täysi solmu) kuten gate.sh (sama binääri koe_binaari/koeydin_rakenna, EI target/release, EI 8797/18797);
   siemen S1 kuten gate + S2 (sekaistunto, oma transkripti, sama `lahde/istunnot`-POST sisältää molemmat istunnot).
   S2:n skooppi: nimi, joka on sillan skooppilistalla (tarkista A:n /api/skoopit; "test" on jo S1:n). Vanhan yksikön
   teksteihin merkki "T59-VANHA", tuoreen "T59-TUORE". Pienet: 2 user + 2 assistant -riviä per yksikkö.
2. TCP-välitys P (node `net`, oma tiedosto) Macin 127.0.0.1:<vapaa koeportti> → A. "Tunneli suljettuna" = P pysäytetty
   (curl P → exit 7 todistaa). Äpin SCOPES2_VERTAINEN = P.
3. UI-testit `scopes2/ios/UITests/T59UITests.swift`: jokainen testi `XCTSkip`, ellei env T59_VAIHE vastaa sitä
   (muuten gate T-49/T-58 ajaisivat ne). Kaikissa sama SCOPES2_DATA = env T59_DATA (kiinteä polku, ajon välillä säilyvä),
   SCOPES2_KUITTAUS=pois, ikkuna 7 vrk. Ajot `xcodebuild test-without-building -only-testing:ScopesV2UITests/T59UITests/<testi>`
   TEST_RUNNER_-etuliitteellä välitetyin env:ein (avain ei argv:hen eikä lokiin).
   - vaihe1 (P auki): Asetukset → peili-ikkuna "7 vrk", peili-koko "x Mt / 38 Mt", x ≤ 38 (kuten PeiliUITests).
     Odota replikointi: skooppi "test" → `viesti`-rivejä ≥ 1 (odota ≤ 120 s, avaa uudelleen tarvittaessa). Kirjaa määrä.
     ÄLÄ avaa S2:ta vaiheessa 1 (muuten S-9e hakisi vanhat jo nyt). Odota lisäksi ~20 s, jotta pohja (S-9d) ehtii.
   - [skripti: P pois, todista curl exit 7]
   - vaihe2 (P kiinni): "test" → `viesti`-rivit ≥ 1 ja sama määrä kuin vaiheessa 1 (määrä env:llä tai tiedostosta).
     S2 avataan: kirjaa viestimäärä, `haettavissa`-rivi näkyy/ei, "T59-VANHA" EI näy (diagnostiikka; kova ehto: VANHA ei näy).
   - [skripti: P takaisin]
   - vaihe3 (P auki): S2 → odota ≤ 180 s, että "T59-VANHA"-teksti näkyy (avaa skooppi uudelleen ~65 s välein, koska haku
     käynnistyy /viestit-pyynnöstä) ja `haettavissa` poistuu. Myös "T59-TUORE" näkyy.
   Napautus: iPhonella NavigationSplitView näyttää ensin skooppilistan; skooppi valitaan rivistä id `skooppi-<nimi>`
   (ks. PeiliUITests.avaaAsetukset ja RunkoUITests:214-226). Viestirivit: accessibilityIdentifier "viesti"/"tyokalu-rivi",
   "haettavissa", "viestit-tyhja" (shared/ScopesUI2/Sources/ScopesUI2/SkoopinViestit.swift).
4. Skripti `scopes2/ios/testit/t59/t59.sh` (malli: scopes2/ios/testit/t51/t51.sh ja gate.sh:n funktiot): rakennuslukko
   `lockf -t 1800 ~/scopes2-rakennus/.lukko` käännöksille, simulaattorilukko kuten gate.sh sim_lukossa; xcodegen +
   build-for-testing (CODE_SIGNING_ALLOWED=NO) kerran, sitten kolme vaihetta; trap siivoaa A:n, P:n, sillan ja datan.
   Tulostaa mittausrivit: `T59 (a) …`, `T59 (b) …`, `T59 (c) …` ja lopuksi `T59 VIHREÄ`/`T59 PUNAINEN`, exit 0/1.
   Aikaraja koko ajolle 30 min.
