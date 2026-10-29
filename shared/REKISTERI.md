# scopes2/shared/REKISTERI.md

Tilanne: 21.10.2026

SEURAAVA PAKETTI: odottaa koordinaattorin uutta pakettia

## Tarkoitus ja raja

scopes-V2:n jaettu Apple-koodi ScopesCore2/ScopesUI2 ja Apple-portti (ARK-08)

## Päätökset

- **Käyttäjä 19.10.2026:** skooppi `scopes2 shared` luotiin komennolla `/pura uusi scopes2 shared`.

- **19.10.2026:** Koordinaattori 19.10.2026 (VALVOJA.md 2.4): koeydin ja kertakäyttöavain, tuotannon V2-avainta ei siirretä Macille; hylättiin tuotannon 8797:ään tunneloiva ensimmäinen versio.

- **19.10.2026:** Koordinaattori: T-45 siirtää ydinlähteet (poikkeama T-45-G:stä, Mac-lukko estää päällekkäisen rakennuksen).

- **20.10.2026:** Koordinaattori (yövaltuudet), V-582: portin koeydin käännetään omaan `CARGO_TARGET_DIR`:iin `scopes2/ydin/target/koe` (flock `/tmp/scopes2-cargo.lock`, vapaa muisti > 1,5 Gt); `target/release`:a ei lueta eikä kirjoiteta, itsetesti kaatuu jos polku viittaa siihen. Todennettu: `--itsetesti` vihreä, `T-47` vihreä, release-binäärin mtime ennallaan. SHARED-MAARITTELY tehty.

- **20.10.2026:** Koordinaattorin ohje: koeydin omaan target-hakemistoon (vrt. web `target/web-koe`), ei tuotannon release-polkua; toteutus gate.sh:ssa, ei erillistä skriptiä.

- **20.10.2026:** T-52 havainto, kahden laitteen topologia: replikointi vetää vain vertaisen `/api/virta`-virrasta (push vain istunnon alussa `tasaa`ssa), eikä koeydin tunne äppien osoitteita, joten äpiltä toiselle ei kulje mitään koeytimen kautta. `testit/kaksi-laitetta.sh` ajaa macOS-äpin ja simulaattoriäpin toistensa vertaisina Macin loopbackissa (portit 18861 ja 18862; testikoukut `SCOPES2_PORTTI` ja `SCOPES2_VERTAISET`, `SolmuAsetukset.portti`) ja koeydin on edelleen vertainen (skooppilista, viestit). Briefin "molemmat vertaisena tunneliin" ei yksin riitä. Tuotannossa palvelimen on listattava laitteet vertaisikseen (ARK-14, T-53 huomioitava).
- **20.10.2026:** T-52 havainto, testidata: "test"-skoopilla ei ole istuntoa eikä viestejä, joten syöttökenttä ja viestilista puuttuvat. Luonnos-, vieritys- ja kuittaustarkistus valitsevat koeytimen datasta skoopin, jolla on avoin istunto (`istuntoja > 0`, `auki` ja `voiLahettaa`; nyt "infra expresso", 120 viestiä). Kuittaus tarvitsee skoopin, jolla on lukemattomia (rivinro tai indeksi > `kuittaus/<s>`; vanhan sillan viesteillä ei ole id:tä, indeksi on id). Kuittaus on suurin-voittaa eikä sitä voi nollata, joten muut käyttöliittymätestit ajetaan `SCOPES2_KUITTAUS=pois` (T-49:n UITests ja kaksi-laitetta.sh).
- **20.10.2026:** T-52 havainto, suorituskyky: lukemattomien seuranta haki jokaisen sivupalkin rivin viestit (5–13 s per skooppi sillan kautta), mikä viivytti ytimen PUT-vastauksia yli 8 s. Seuranta rajattu skoopeille, joilla on istunto, enintään 2 hakua rinnakkain (`Varasto.seuraaLukemattomia`).
- **20.10.2026:** T-52, käyttäjä hyväksyi gate.sh:n muokkauksen (ab54b50b): `-collect-test-diagnostics never` vain `xcodebuild test` -komennoille.

- **20.10.2026:** T-52 tila: koodi valmis mutta COMMITOIMATON, portti `gate.sh T-52` punainen kahdesti. Koordinaattori siirsi jatkon Opukselle (suunnitelman sääntö 5); tämä istunto lopetti korjaamisen. Lokit: `~/.local/state/scopes2-t52-lokit/` (portti-t52.log, portti-t52b.log, kaksi-laitetta-ajot kl25.log ja kl26.log, T-49-testiajot runko*.log).
  - **Ajo 1 (11.15–11.42, portti-t52.log):** punainen macOS-UI-testeissä. Syy 1: kaksi-laitetta-testit ajettiin T-49:n koko kohteen mukana ilman pareja ja kaatuivat (korjattu: ohitus ilman `KL_AJO=1`). Syy 2: `RunkoUITests.testViestitVastaavatPalvelinta` (viestimäärä "scopes kordinaattori" 143 vs 120, elävä istunto kasvaa) kaatui myös puhtaalla HEAD-pohjalla ilman T-52-muutoksia (todennettu, runko-pohja.log). testLiiteMacilta aikakatkesi kerran kylmällä koeytimellä (palvelin() 60 s).
  - **Ajo 2 (12.40–14.28, portti-t52b.log):** macOS-UI-testit vihreät (testViestit 1178 s) ja ScopesCore2 66/66, ScopesUI2 16/16 vihreät; punainen vain iOS-UI-testeissä: `RunkoUITests.testViestitVastaavatPalvelinta()` (2351 s). Syytä ei saatu talteen, koska portti ajaa xcodebuildin `-quiet`; erillinen iOS-ajo harnessissa kaatui 0,2 s:ssa virheeseen "Expected to decode Array<Any> but found a dictionary instead" (`/api/skoopit` palautti olion; macOS-vastine samassa ajotavassa meni läpi, joten syy on selvittämättä: avain, osoite tai kylmä koeydin iOS-testin ympäristössä). Seuraava askel: aja iOS-testi ilman `-quiet`:iä ja lue ensimmäinen virhe.
  - **gate.sh:182** "MACLUKKO[1]: sitomaton muuttuja" EI ollut haitaton (korjattu tieto 20.10. klo 15): `set -u` -virhe katkaisi `puhdista`n ennen `koeydin_loppu`a, joten ajon 2 koeydin (pid 16575, portti 18798) jäi käyntiin ja piti palvelimen Mac-lukon fd 9:ää (perintö), mikä esti seuraavan ajon (valvoja huomasi 14.53). Korjattu, commitoimatta: koeydin `exec 9>&-`, `${MACLUKKO[1]:-}`-suoja, `puhdista` lopettaa koeytimen ensin; todennettu siivoustestillä ja ajon 3 lopussa (ei koeydintä, lukko vapaa).
  - **Ajo 3 (Opus, 15.19–15.21, portti-t52c.log, GATE_MAY + `claude/siirto/mittaukset/`, caffeinate -u/-d):** punainen ympäristöstä, ei koodista: ScopesCore2 66/66 ja ScopesUI2 16/16 vihreät, macOS- ja iOS-build ok; macOS-UI-testien ajuri ei käynnistynyt: "The test runner failed to initialize for UI testing. (Underlying Error: Timed out while enabling automation mode.)", testejä ajettiin 0. Macilla `automationmodetool`: "Automation Mode is disabled. This device requires user authentication to enable Automation Mode." (näyttö ei lukossa). Agentilla ei sudo-oikeutta (NOPASSWD vain lulu-hallinta). Sääntö 5: ei ajettu uudelleen, jatko käyttäjän päätös.
  - **Ajo 4 (15.25–15.32, portti-t52d.log) keskeytetty, exit 130:** koordinaattori 15.2x: sudo-komentoa ei ajeta, vaan käyttäjä hyväksyy Touch ID -kehotteen, kun UI-testit alkavat. Valvoja 15.31: Automation Mode yhä "requires user authentication", joten keskeytä ennen macOS-UI-vaihetta. TERM ehti vasta UI-vaiheen alkuun (bash ajaa trapin ssh-lapsen päätyttyä), joten lapset lopetettiin. Siivous toimi: koeydin poissa, lukot vapaat, Macilla ei xcodebuildia. Builds ja yksikkötestit ehtivät läpi. Jatko on käyttäjän päätös: Touch ID -kehote vai without-authentication-asetus.
  - **Ajo 5 keskeytetty (15.36, portti-t52e.log):** käyttäjä valitsi sudo-reitin, joten ajo pysäytettiin ScopesUI2-vaiheessa ennen UI-testejä. Macin sudo kysyy salasanan (ei `sudo_local`ia eikä pam_tid:ia). Käyttäjä ajoi `sudo automationmodetool enable-automationmode-without-authentication`, ja 15.48 tila oli "DOES NOT REQUIRE user authentication".
  - **Ajo 6 (15.49–16.07, portti-t52f.log) punainen, syy talteen (`xtesti`):** Automation Mode toimi, todennuskehotteita ei tullut. macOS-UI-testit: 3 läpi, 10 ohitettu (kaksi laitetta ilman `KL_AJO`:ta), 1 kaatui: `testViestitVastaavatPalvelinta` noin 825 s:n kohdalla, `DecodingError.keyNotFound 'viestit'`. API palautti olion ilman viestejä, todennäköisesti sillan 502/503 `{"virhe":"silta","kohde":"8787"}`, eikä testin `palvelin()` tarkistanut HTTP-tilaa. Sama on todennäköinen syy ajon 2 iOS-kaatumiseen. Korjaus, commitoimatta: molempien `RunkoUITests.palvelin()` uusii 5xx-vastauksen 4 kertaa 10 s välein, ja muu kuin 200 heittää `ApiVirhe`n, jossa on tila ja rungon alku. build-for-testing on vihreä molemmille. Uusi porttiajo on käyttäjän päätös.
  - **Ajo 7 (16.03–17.10, portti-t52g.log) punainen ympäristöstä:** macOS-UI-testit 16.09 alkaen, ja GATE_MAC_TIMEOUT 3600 s katkaisi ne 17.10 (yhteenvetoa ei syntynyt). Koeytimen loki: jatkuva `siltahaku /api/skoopit epäonnistui (503) {"virhe":"silta","kohde":"8787"}`. Vanha 8787-palvelu (node pid 26929, `/srv/work/scopes/palvelu/palvelin.mjs`, käynnissä 22 h 44 min, CPU 47 %, RSS noin 900 Mt) ei vastannut `/api/terveys`-kutsuun 17.10, ei 10 s:ssa eikä portin pysähdyttyä (3 × 10 s). Load noin 4–5. 8787 on toisen skoopin palvelu (TYÖTAVAT 10 ja 15), eikä sitä käynnistetty uudelleen. T-52-testit tarvitsevat toimivan 8787:n (koeydin sillaa skooppilistan ja viestit).
  - **Ajo 8 (17.41–17.44, portti-t52h.log) keskeytyi, ei tulosta:** käyttäjä hyväksyi ajon 17.45 scopes macos -istunnossa. Claude Code lopetti taustakomennon macOS-UI-vaiheessa, koska palvelimen muisti loppui (vapaana 93 Mt, käytettävissä 550 Mt; kuusi Claude-istuntoa noin 250–380 Mt kukin ja 8787 noin 340 Mt). Testi ei kaatunut. Koeydin kuoli lopetuksessa. Macin orvot prosessit (xcodebuild, ajuri, äppi, tunneli) lopetettiin, ja lukot ovat vapaat. Ohjeen mukaan ajoa ei käynnistetä uudelleen omin päin.
  - **Ajo 9 (17.47–18.14, irti Claudesta, portti-t52i.log) punainen:** käyttäjä hyväksyi ajon 17.46 scopes macos -istunnossa. macOS-UI: 2 läpi, 10 ohitettu, 2 kaatui. (1) `testBundleIdOnP11nMukainen`: "Failed to activate application 'com.example.scopes-v2.mac …' (current state: Running Background)". Äppiä ei saatu etualalle, todennäköisesti koska Macilla tehtiin rinnakkaistyötä tai fokus oli muualla; aiemmissa ajoissa testi meni läpi. (2) `testViestitVastaavatPalvelinta`: "viestejä ei näy: scopes istunnot" (waitForExistence 90 s). Samaan aikaan 8787 vaihteli (V-613): tiedoston `v8787-t52i.log` mukaan alhaalla 17.49–17.49.45, 17.50–17.51, 17.53–17.57, 17.58–17.59, 18.00–18.01, 18.03–18.04.41, 18.06.21–18.06.56, 18.09.38–18.10.09 ja 18.12.21–18.14.02. Ehtojen mukaan ajoa ei toisteta. Siivous: koeydin poissa.
  - **iOS testViestit ennen ajoa 3:** erillisajo ilman `-quiet`:iä portin koeytimellä, avaimella ja tunnelilla vihreä (1339 s, 15.17). Aiempi 0,2 s "Array vs dictionary" oli ajotavan 401 (väärä avain), ei vastausmuoto. Ajon 2 iOS-kaatumisen syy jää tuntemattomaksi (xcresult ei tallessa); gate.sh tulostaa nyt punaisena xcresultin yhteenvedon (`xtesti`, commitoimatta).
  - **Vihreää:** kaksi-laitetta-tarkistukset 5/5 erillisajoissa (valinta 124 ms, luonnos 148 ms, vierityskohta 111 ms, kuittaus 895 ms, headless ok), ScopesCore2 66/66, ScopesUI2 16/16, gate.sh `--itsetesti`. Täyttä 5/5-ajoa yhdellä kertaa ei ole saatu uusimmalla koodilla kokonaan läpi (viimeisin kokonaisajo 3/5 suodattimen tuplatekstin takia, korjattu; luonnos ja vierityskohta ajettu sen jälkeen 2/2).
  - **Commitoimattomat T-52-tiedostot (työpuussa Opusta varten):** `scopes2/shared/ScopesCore2/Sources/ScopesCore2/{Tilasynkka.swift (uusi),Varasto.swift,Solmu.swift}`, `scopes2/shared/ScopesCore2/Tests/ScopesCore2Tests/{TilasynkkaTests.swift,TilasynkkaSolmuTests.swift}` (uusia), `scopes2/shared/ScopesUI2/Sources/ScopesUI2/{AsetuksetNakyma,JuuriNakyma,Lahetys,Sivupalkki,SkoopinViestit}.swift`, `scopes2/shared/testit/{KaksiLaitettaUITests.swift,kaksi-laitetta.sh}` (uusia), `scopes2/ios/{Sources/ScopesV2App.swift,UITests/RunkoUITests.swift,project.yml}`, `scopes2/macos/{Sources/ScopesV2MacApp.swift,Sources/SolmunElinkaari.swift,UITests/RunkoUITests.swift,project.yml}`, tämä rekisteri. Commitoitu on vain `gate.sh` (ab54b50b, `-collect-test-diagnostics never`, käyttäjän hyväksymä).
  - **Testikoukut:** `SCOPES2_PORTTI`, `SCOPES2_VERTAISET`, `SCOPES2_TILAVIIVE_MS`, `SCOPES2_KUITTAUS=pois`, `KL_AJO=1`. Jatkoon: korjaa iOS testViestit, aja `gate.sh T-52` vihreäksi, commitoi T-52 ja T-49-testivakautus erikseen.

- **20.10.2026:** käyttäjä (AskUserQuestion): gate.sh saa muokata ja commitoida erikseen; muutos: `-collect-test-diagnostics never` vain `xcodebuild test`. Peruste: T-49:n 600 s diagnostiikkakeruun aikakatkaisu.

- **20.10.2026:** käyttäjä (AskUserQuestion): T-49:n testViestitVastaavatPalvelinta vakautetaan (ei commitoida punaisena); koordinaattori vahvisti.

- **20.10.2026:** käyttäjä (AskUserQuestion): pakkaa nyt; koordinaattorin pyyntö: T-52:n koodia ei committoida punaisella portilla, jätetään työpuuhun Opukselle.

- **20.10.2026:** Hylätty: kaksi äppiä pelkästään koeytimen vertaisina (ei välitä äpiltä toiselle); kuittaus-ehdokkaaksi "test" (ei viestejä).

- **20.10.2026:** Testikoukut: SCOPES2_PORTTI, SCOPES2_VERTAISET, SCOPES2_TILAVIIVE_MS, SCOPES2_KUITTAUS=pois, KL_AJO=1.

- **20.10.2026:** Käyttäjä 20.10.: T-52 jatketaan tässä istunnossa (pura-valinta). Käyttäjä hyväksyi 4. ajon ja sudo-reitin (Touch ID -reitti hylättiin). Ajon 7 hyväksyi käyttäjä täällä. Ajojen 8 ja 9 hyväksynnän välitti scopes macos -istunto (klo 17.45 ja 17.46).

- **20.10.2026:** Käyttäjä (koordinaattorin kautta): 8787:ään ei kosketa, ja V-613 kuuluu scopes2 webille ja scopes palvelulle.

- **20.10.2026:** Käyttäjä (AskUserQuestion, T-52 Mac-valmistelu): Macilta ajetussa portissa koeydin ajetaan Macilla, ja palvelimen 8787-avain (`~/.config/scopes/avain`) luetaan ssh:lla ajon ajaksi koeytimen hakemistoon (0600, poistetaan lopussa) ja tunneli Mac 18787 → 8787. Tämä on poikkeus P-14:n sääntöön, ettei avain lähde palvelimelta. Valinta "vain valmistelu": ei porttiajoa, ei committia.

- **20.10.2026:** Koordinaattori, T-49-vakautus: `vakaat()` (ios ja macos RunkoUITests) ei käytä 10 min rajaa, koska /viestit palauttaa viestejä vain palvelimella avoimille istunnoille (19.48 vain infra expresso, elävä). Testiskoopit valitaan niistä, joilla on viestejä, vanhin viimeisin viesti ensin; testi vaatii vähintään yhden avoimen istunnon. Todennettu: macOS testViestitVastaavatPalvelinta yksinään vihreä 19.50 omalla koeytimellä. Jatkoehdotus: testidata siemennetään koeytimeen, jotta testi ei tarvitse palvelimen avointa istuntoa.

- **20.10.2026:** Punaisella portilla koodia ei commitoida (koordinaattori). Mac-siirron takia työpuu tallennetaan patchina (tämän session ratkaisu; ilman sitä Macin puhdas klooni menettäisi T-52:n).

- **20.10.2026:** Käyttäjä 18.35 (scopes macos -istunnon kautta): kaikki scopes2-istunnot pakataan ja avataan Macilla (mac:~/sessions-repo), koska palvelimen muisti ei riitä. Git-vahvistus on annettu siirtoa varten.

- **20.10.2026:** Käyttäjä 20.10.2026 (AskUserQuestion): 8787-avain luetaan ajon ajaksi Macille (poikkeus P-14:ään), kirjattu REKISTERIin; ei koeydintä palvelimelle.

- **20.10.2026:** Käyttäjä: commitit vihreällä sallittu. Porttiajot koordinaattorin päätöksellä (muisti feedback_scopes2_paata_itse).

- **20.10.2026:** Koordinaattori: T-49-vakautuksen linja (vaihtoehto 2: aikavälivertailu; testidatan siemennys jatkoehdotuksena); aita ei muutu (vieraat polut kirjataan); palvelimen puuta ei synkata nyt (reset jaetussa puussa VALVOJA.md luku 5; vaihevirheet-rivit claude siirrolle).

- **20.10.2026:** Käyttäjä (pakkauksen AskUserQuestion): seuraava paketti TUNNELITESTI.

- **20.10.2026:** Hylätty: koeydin palvelimella Macin ajossa; 10 min hiljaisuusraja; ehdoton yksilöllisen viestirivin vaatimus (c).

- **20.10.2026:** Palvelimen synkka stash + rebase (ei reset): käyttäjä valitsi 20.10.2026; säilyttää infra expresson committit.

- **20.10.2026:** Seuraava sharedin työ V-605 (gate.sh-rinnakkaistus) vasta T-51:n jälkeen koordinaattorin vuorolla (koordinaattori sessions-repo-c1, 20.10.2026).

- **20.10.2026:** V-605 toteutetaan cargo-lukko = vanha ~/scopes2-rakennus/.lukko, jotta ytimen gate.sh:n Mac-cargo ja sharedin XCFramework sarjoittuvat ilman ytimen muutosta.

- **20.10.2026:** Seuraava paketti V-605:n Mac-todennus (käyttäjä valitsi 20.10.2026 automaattisiirron paketinvalinnassa).

- **21.10.2026:** Koordinaattori c1 20.10.: V-605 kuvauskorjaus, ei koodimuutosta (Darwinilla työpuukohtainen lukko on oikea eristys); Mac-todennus erillisistä worktreeistä.

- **21.10.2026:** Koordinaattori fe 21.10.: tuotannon /viestit-tilaa ei lueta T-62:n Acceptanceen (V-KORD-4) → poikkeama kirjattu; T-62 reitti C; T-49/T-52 macOS-UI-osat ajetaan, vaikka macOS-kehitys oli hetken pysäytetty (käyttäjä kumosi 10.5x, 1269d843).

- **21.10.2026:** Commitit polkuina pääkloonissa, pushaa koordinaattori; punaisella ei uusintaa ilman koordinaattorin päätöstä.

- **21.10.2026:** Hylätty: T-62 reitti B (siemen vain T-49:lle), A (T-52 4/5 jatkotehtävällä).

- **21.10.2026:** koordinaattori fe: T-87:n UI-vuorot annettiin käyttäjän luvalla; commit polkuina, fe pushaa; pääklooniin ei pullata (päivittyy synkassa). T-58 siirtyy iOS-istunnolle d5 (korvaa e0:n); sen muutokset sharedin poluissa kirjataan sharedille vikoina.

- **21.10.2026:** overseer 05: scopes2 shared on agy-pilotti Clauden viikkorajan seisokissa (käyttäjän päätös patriot 69bd92c0, koordinaattori 20 valitsi sharedin); SEURAAVA PAKETTI kirjoitetaan agy-kelpoiseksi (yksi gate-todennettava tehtävä, ei koordinointia, ei tuotantoa/8797, ei hookeja, oma worktree HEADista, commit poluittain). Valinta tehty itse (muisti feedback_scopes2_paata_itse), ei AskUserQuestionia.

- **21.10.2026:** Hylätty agy-paketiksi: T-47/T-48/T-49-portit (8787 ja tuotannon avain), V-624 (jo tehty), T-53/T-72 (valvojan hyväksyntäajot), testBundleIdOnP11nMukainen (UI-flaky, ei gate-tehtävä).

- **21.10.2026 (koordinaattori, agy-pakkaus):** agy Flash -ajo valmis: T-97 daf6171b (S-9f peiliRaaka ScopesCore2:een + gate.sh T-97, vain swift test). T-100:n kommenttimuutos sharedin KaksiLaitettaUITests.swiftiin sisältyy macosin commitiin 1cfce137. Raportti ~/agy-raportit/T-97.

## Avoimet asiat

| Asia | Tila | Seuraava askel |
|---|---|---|
| Palvelimen stash@{0} (vaihevirheet.jsonl 23 riviä claude siirrolle + vanhat gate.sh/RunkoUITests-versiot) | avoin; odottaa skooppia claude siirto | claude siirto poimii vaihevirheet-rivit stashista (`git stash show -p stash@{0} -- claude/siirto/mittaukset/vaihevirheet.jsonl` palvelimella), sitten stash pudotetaan. |
| Palvelimen 3 infra expresso -committia pushaamatta | avoin; odottaa skooppia infra expresso | Omistaja pushaa (ei sharedin tehtävä). |
| Worktree t87 (`~/sessions-repo-t87`) | poistettu (puhdas; 21.10.2026) | — |
| T-87 portitettu ennen T-91:tä | lykätty (päätös 5736f24e) | T-87-UUSINTA pysäytetty 21.10.2026 18.2x käyttäjän päätöksellä (Android-työ odottaa suunnitelman rajausta ARK-19:ssä), ei tulosta, loki /tmp/t87u.log lukematta. |

## Viat

| Vika | Tila |
|---|---|
| macOS `testBundleIdOnP11nMukainen` jää tilaan "Running Background", kun Macia käytetään rinnakkain (ajo 9). Ajo vaatii Macin ilman muuta käyttöä. | avoin (ei korjattu) |
| Ympäristö: 8787 (V-613, ideakirja `claude/idea/IDEAT.md:208`, scopes-skooppi) jumittui 16.14– ja vaihteli 17.49–18.14. | avoin (havainnot lähetetty koordinaattorille ja 0e:lle; ideakirjaa ei muokattu, /vika on käyttäjän) |

## Historia

Historia: `scopes2/shared/HISTORIA.md` (syntyy ensimmäisessä pakkauksessa), ei lueta purussa.
