# scopes2/ios/REKISTERI.md

Tilanne: 28.10.2026

SEURAAVA PAKETTI: ei mitään — T-59-UUSINTA valmis 28.10.2026 (ajo 9 vihreä); T-59 (4)(5) odottaa tuotantoistuntoa (T-88), seuraavan tehtävän antaa koordinaattori sessions-repo-c2

## Tarkoitus ja raja

scopes-V2:n iOS-äppi (ARK-08): kuori `ScopesV2App` (solmun elinkaari scenePhasella, ydin prosessin sisällä `127.0.0.1`-API:lla), iOS:n XCUITestit simulaattorilla ja iOS-hyväksyntäajot (T-51:n iOS-osa, T-59).

Raja: polut `scopes2/ios/**` (`Sources`, `UITests`, `project.yml`, `Info.plist`, `testit/`). Ei muutoksia `scopes/**`-puuhun (vanha äppi, K-9; gate.sh:n `scopes/`-aita). `scopes2/shared/**` (ScopesCore2, ScopesUI2, `gate.sh`) kuuluu skoopille `scopes2 shared`, iOS vain katselmoi; `scopes2/macos/**` skoopille `scopes2 macos`; `scopes2/ydin/**` skoopille `scopes2 ydin`. Tuotannon 8797:ää ja sen avainta ei kosketa, `target/release`:iin ei käännetä. Arkkitehtuuri: `scopes/architecture/SUUNNITELMA.md` luku 9 (ARK-08, ARK-09, ARK-17:n iOS-osa); tehtävät: `scopes/toteutussuunnitelma/SUUNNITELMA.md` luvut 11.2 (T-49, T-51), 11.3 (T-52, T-53) ja 11.5 (T-58, T-59), Mac-rajoitteet luvussa 11.2. Ei lueta purussa.

## Vaatimukset

| # | Vaatimus | Hyväksyntä | Tila |
|---|---|---|---|
| I-1 | ARK-08 iOS: bundle `com.example.scopes-v2` (P-11) ja vanha `com.example.skoopit` toimivat rinnakkain; lista ja viestit = palvelin | `gate.sh T-49` iOS 3/0, T-51 iOS-rinnakkain | vihreä (7529ea66, fdd93fce) |
| I-2 | ARK-08 sulkeutuu | T-51 Mac-rinnakkain (tarkistus 4) | vihreä — ARK-08 kiinni (tarkistus 4 f1bf7908, koordinaattori 20.10.2026) |
| I-3 | ARK-09 iOS-puoli: tila-avaimet laitteelta toiselle < 2 s | T-53 (`kaksi-laitetta.sh`) | vihreä 20.10.2026 (T-52 ja T-53, koordinaattori 21.13 ja 21.23; SUUNNITELMA 11.3) |
| I-4 | ARK-17 iOS-puoli: Transkriptipeili-asetusosio ja `haettavissa`-rivi | `gate.sh T-58`, T-59 | T-58 vihreä 21.10.2026 (9704e106); T-59 (a)(b)(c) + gate T-49 vihreä 21.10.2026 (b70dd25c), ARK-17 HYVÄKSYTTY 21.10.2026 (SUUNNITELMA 11.5 "T-59:n tulos"); SCOPES2-PALUU-1735-uusinta 28.10.2026 vihreä (ajo 9, b9d7c220; ajo 8 punainen vanhentuneen XCFrameworkin takia, ks. Tila T-59); (4)(5) tuotantodatalla ja K-10 laitteella ovat jälkitodennuksia, eivät ehtoja |
| I-5 | Fyysinen iPhone | H-17 (käyttäjä, Xcode-allekirjoitus) ARK-14:n parituksen jälkeen | vihreä 21.10.2026 15.31 — scopes-V2 iPhonessa (devicectl install exit 0); poikkeama I-1:stä: vanha Skoopit poistettu laitteelta (käyttäjä, ilmaisen profiilin 3 äpin raja) |

## Päätökset

- **Käyttäjä 19.10.2026:** skooppi `scopes2 ios` luotiin komennolla `/pura uusi scopes2 ios`.

- **20.10.2026:** Käyttäjä/koordinaattori 20.10.2026 (cross-session palvelin-e5): iOS-vaiheen todiste porttikopiolla on yöllä riittävä; koko T-49-portti ajetaan aamulla Macin lukituksen avauksen ja macOS-testin jälkeen. Koordinaattori kuittasi T-49 iOS-vaiheen (f6a2d585).

- **20.10.2026:** Ei ajeta koeydintä `scopes2/ydin/target/release` -binäärin uudelleenkäännöstä varten; koordinaattorin kielto 20.10.2026: ei käännetä `target/release`:iin eikä kosketa 8797:ää (portti vain kopioi binäärin tmp-hakemistoon).

- **20.10.2026:** Testin vika, ei näkymän: viestimäärä-ero ratkaistiin testiä korjaamalla; shared-koodiin ei tehty muutoksia (hylätty vaihtoehto: korjata näkymää).

- **20.10.2026:** Koordinaattori 20.10.2026: laske()-korjauksen ja vertailun muokkaaja on scopes2 shared (tiedostossa sen T-52-muutokset); iOS-skooppi vain katselmoi. Vertailu: aikaleimaväli [UI vanhin, UI uusin] ennen+jälkeen-yhdistetystä /viestit-listasta (hylätty: pelkät määrät, koska /viestit on 120:n liukuva ikkuna).

- **20.10.2026:** Koordinaattori 20.10.2026: T-51 osittain hyväksytty (8/9, iOS-rinnakkain vihreä); Mac-rinnakkain ajetaan erikseen V-628:n korjauksen jälkeen; ARK-08 ei sulkeudu ennen sitä; H-17 ei riipu Mac-osasta (kirjattu jo fdd93fce:ssä luvussa Tila T-51 — ei kahdentaa Päätökset-lukuun).

- **20.10.2026:** Koordinaattori (sessions-repo-c1, cross-session): IOS-MAARITTELY hyväksytty luonnoksena (Tarkoitus ja raja, I-1…I-5; H-17 vaatimuksena I-5). T-51:n Mac-rinnakkain ajetaan vasta, kun ytimen T-22 on valmis Macilla, ja koordinaattorin erillisellä luvalla; Macin UI- ja porttiajoja ei ennen sitä. Hallinta ja jumit: scopes overseer; ruutuvalvonta: scopes vahtimestari.

- **20.10.2026:** Koordinaattori (sessions-repo-c1): T-51 tarkistus 4 hyväksytty vihreäksi aitalinjauksella (käyttäjä 19.10.: vieras muutos aidassa ei kaada ajoa, jonka testi ei kirjoittanut), uusintaa ei ajeta. Vieras polku `scopes/vahtimestari/seuraa-istunnot.sh` (scopes vahtimestarin oma, bfaec1de) muuttui 23.15.43; koordinaattori todensi lokin. T-51 hyväksytty, ARK-08 kiinni, H-17 voi edetä.

- **Käyttäjä 21.10.2026** (lähde `scopes/toteutussuunnitelma/SUUNNITELMA.md:481`, cef048d3, sanatarkasti): "Jos macos, ios ja oneplus server voidaan kehittää rinnakkain niin kehitetään." ja "Näiden kolmen välillä ei valmistumisjärjestyksellä ole väliä. Tärkeintä on että kehitys tapahtuu mahdollisimman tehokkaasti ja tulos hyvää."

- **21.10.2026:** Koordinaattori (sessions-repo-68, kutsuu itseään fe:ksi; tmux siirto-scopes-kordinaattori-123445) 21.10.2026: IOS-H17 hyväksytty käyttäjän päätöksellä, mukaan lukien -allowProvisioningUpdates sekä App ID ja kehitysprofiili tiimille YOUR_TEAM_ID. Mac-vuoron buildiin antaa koordinaattori T-87:n UI-vaiheen jälkeen.

- **21.10.2026:** Käyttäjä 21.10.2026 (overseer 28 välitti sanatarkasti): "Selvitä mitä kautta edellinen scopes asennus on tehty. Samaa asennustapaa käytetään" → skoopit-asennus.sh:n tapa (xcodegen, xcodebuild -allowProvisioningUpdates -destination id=<laite>, devicectl install). Uusinta-agentista: "Kyllä, sama kuin Skoopitilla".

- **21.10.2026:** Käyttäjä 21.10.2026 (800b96a2, overseer 28 välitti): "Skoopin joka haluaa tehdä asennuksen ilmoittaa sunulle vasta kun on valmis asentamaan. Sinä kysyt silloin minulta että sopiiko nyt" → buildin jälkeen viesti "valmis asentamaan" overseerille 28, asennus vasta "sopiiko nyt" -vastauksen jälkeen; sama koskee uusinta-agentin luontia.

- **21.10.2026:** Overseer 28: ensiasennus suoraan istunnosta ilman LaunchAgentia; uusinta-agentin !-komennot käyttäjälle vasta ensiasennuksen jälkeen (RunAtLoad asentaisi muuten heti); luokittimen estoa ei kierretä.

- **21.10.2026:** Käyttäjä (koordinaattorin kautta) 21.10.2026: T-58 (briefit/T-58.md, transkriptipeilin ikkuna iOS-äppiin) kuuluu skoopille scopes2 ios; aloitus IOS-H17:n ja T-87:n commitin jälkeen; scopes2/shared-polkujen muutokset kirjataan sharedille vikoina; acceptance-UI-vuoro koordinaattorilta.

- **Käyttäjä 21.10.2026 ~15.20** (overseer 58 välitti, käyttäjä vahvisti tässä istunnossa d5): "Poista vanha scopes äppi" — ilmaisen kehittäjäprofiilin raja on 3 omaa äppiä laitteessa (MIInstallerErrorDomain 13); Controller ja eXpresso jäävät, Skoopit (com.example.skoopit) poistettiin. Poikkeama I-1:n rinnakkaisuudesta laitteella; overseer kirjasi sen toteutussuunnitelmaan (832ddedc). Samasta syystä vanhan Skoopitin uusinta-agentti `com.example.skoopit-asennus` bootout ja plist `~/Library/LaunchAgents/pois/`:iin (käyttäjä vahvisti; muuten se asentaisi Skoopitin takaisin ~25.10.). Hylätty: maksullinen Developer-jäsenyys.

- **21.10.2026:** **Käyttäjä 21.10.2026** (overseer 05 välitti, lähde `scopes/overseer/REKISTERI.md` Päätökset 5f1d29eb, sanatarkasti): "Minun päätös on ollut että sinä päätät kaikki nämä missä et jää jumiin mitkä noudattaa arkkitehtuuria ja toimintasuunnitelmaa." → T-59 (4)(5) vain luku 8797:ää vasten sallittu; käyttäjä vahvisti tässä istunnossa AskUserQuestionilla "Sallin vain luku -ajon" (ssh-tunneli → 8797, avain ajon ajaksi, simulaattori-B 7 vrk, katkaisu Macin päässä, ei kirjoituksia).

- **21.10.2026:** Koordinaattori 20: T-59 d5:lle; portti omassa worktreessä HEADista, vain tehtävän tiedostot (V-KORD-3); commit pääkloonissa polkuina, hash-object täsmää; ei amend/stash/pull --rebase; ei target/release, ei 8797 ilman lupaa; viikkoraja 95 % ~19.50 → pysähdy vihreään välitilaan.

- **21.10.2026:** T-59 (d) "toinen simulaattori ilman ikkunaa ennallaan" = gate T-49 (ajetaan lopuksi).

- **21.10.2026:** (4)(5) ajetaan jälkitodennuksena, kun tuotannossa on skoopillinen istunto (SUUNNITELMA 11.5); tyhjä valinta ei saa olla VIHREÄ → t59-tuotanto.sh palauttaa `TYHJÄ`/exit 2. Synteettistä uusintaa ei tehdä (hylätty T-57:n poikkeamapäätöksen mukaan).

- **21.10.2026:** iOS-kehityksen jatko (overseerin pyyntö, käyttäjä 21.10. klo 19.2x): rekisterissä ei ole muuta pakettia; ei keksitä omaa, vaan pyydetään tehtävämääritys toteutussuunnitelmalta (S-9f iOS-asiakasnäkymä). Ei Opusta, ei Android-ajoja, ei simulaattori-/UI-työtä ennen macos T-72:n lukon vapautumista.

- **21.10.2026:** Pakkauksen VIERAS-polut (11 muuta skooppia) ovat muiden elävien sessioiden työtä jaetussa kloonissa, eivät tämän session muutoksia: `vika.sh` ei ajettu.

- **21.10.2026:** Pakkaus /automaattisiirrolla (käyttäjä): sessio vaihdetaan, vaikka seuraava paketti on `ei mitään`; toteutussuunnitelman tehtävämääritys (pyyntö 21.10.2026) voi saapua vanhan session osoitteeseen, joten uusi sessio tarkistaa suunnitelman S-9f-rivin (SUUNNITELMA.md:235, REKISTERI.md:205) ennen kuin päättelee mitään.

- **28.10.2026:** T-59:n siemen tehdään ajohetkeen suhteelliseksi (`siemen.mjs`; kiinteät päivät hylätty, koska ne putoavat 7 vrk:n ikkunasta ja testi ei toistu). Ajo 8:n vaihe 3: S2 avataan tunnelin sulkeuduttua kesken ajon (kylmäkäynnistyksessä P kiinni skooppilista on tyhjä).

- **28.10.2026:** T-102 (iOS-näkymän osa 2) ei ole scopes2 ios -skoopin ajettava: `scopes2 shared` + Mac-UI-jono T-72:n jälkeen (`SUUNNITELMA.md:558-560`); ei briefata uudelleen täältä.

## Tila IOS-H17 (21.10.2026 klo 15.31 — valmis)

- Build worktreestä `~/sessions-repo-h17` (2731d14d) koordinaattorin vuorossa rakennuslukon alla 15.16.50–15.17.12 exit 0; XCFramework kopioitu t87-worktreestä (21.10. 14.32, T-84:n jälkeen). Allekirjoitus com.example.scopes-v2, tiimi YOUR_TEAM_ID, profiili vanhenee 28.10.2026 12.16 UTC.
- Ensimmäinen asennus 15.18.40 exit 1 (3 äpin raja). Skoopitin poisto 15.31.44 exit 0, asennus 15.31.46 exit 0. `devicectl device info apps`: Controller, eXpresso, scopes-V2.
- Uusinta-agentin puu valmisteltu: `scopes-v2-asennus.sh --paivita` exit 0 (`~/scopes2-ios-asennus` ← 2731d14d), asennettu profiili `asennettu.mobileprovision`:iin, `--check`: puu=on agentti=ei H=167. LaunchAgentin lataus = overseerin !-komennot käyttäjälle.

## Tila T-58 (21.10.2026 klo 16.34 — valmis, 9704e106)

- Toteutus Sonnet-ali-agentilla worktreessä `sessions-repo-t58`; XCFramework t87:n käännöksestä (14.32), koska asetukset_json ei muuttunut T-54:n (cbb42abe) jälkeen (T-91 vain sillan X-Lahde). Esitila: ScopesCore2 106/0/1, ScopesUI2 16/0, `gate.sh --itsetesti` vihreä.
- Mittausrivi (Mac, koordinaattorin UI-vuoro): T-58 16.12.10–16.22.20 exit 1 (PeiliUITests 0/2: iPhonen NavigationSplitView näyttää ensin skooppilistan, testi ei valinnut skooppia ennen Asetukset-välilehteä → testikorjaus `avaaAsetukset`) · T-47 16.22.20–16.22.40 exit 0 · T-49 16.22.40–16.29.17 exit 0 · T-58 uusinta 16.29.20–16.34.04 exit 0 (iOS UI 5/0/17: PeiliUITests 2/2 35 s ja 57 s, RunkoUITests 3/3).
- Poikkeama briefin may-listasta (perusteltu commitissa): gate.sh:n itsetesti()-silmukka ja otsikkokommentti saivat T-58:n, koska itsetesti käy läpi jokaisen tunnettu()-tapauksen.

## Tila T-59 (28.10.2026 klo 08.47 — uusinta ajo 9 VIHREÄ)

- Toteutus: `scopes2/ios/testit/t59/**` (t59.sh, siemen.mjs, valitys.mjs, t59-tuotanto.sh, lukuvalitys.mjs, vertaa-tuotanto.py, SUUNNITELMA.md) ja `UITests/T59UITests.swift`. Siemen ajohetkeen suhteellinen (S1 viimeinen = nyt − 24 h, TUORE nyt − 27 h, VANHA nyt − 23 vrk); `t59.sh` vain otsikkokommentti.
- **Mittausrivi T59 ajo 8 (Mac, 28.10.2026 08.06–08.21, HEAD f6ec34d2 + siemenkorjaus, exit 1):** koeydin 18900, silta 19000, S2 `scopes2` (sillan listalla 110), siemen A test 17 / scopes2 8 viestiä, build exit 0 · (a) PUNAINEN: Asetukset peili-koko "–" alussa ja replikoinnin jälkeen (ajo 7: "0,0 Mt / 38 Mt"), ikkuna 7 vrk ja katto 38 Mt näkyvät, vaihe 1 exit 65 · (b) PUNAINEN: test-viestejä 9 = 9 (vaihe 2 exit 0, P kiinni curl exit 7); vaihe 3: S2 8 viestiä, VANHA näkyy, haettavissa-rivi ei, exit 65 · (c) OK: VANHA näkyy 36 s käynnistyksestä, haettavissa ei, vaihe 4 exit 0.
- **Mittausrivi T59 ajo 9 (Mac, 28.10.2026 08.35–08.47, HEAD b9d7c220, XCFRAMEWORK 28.10. 08.37, exit 0):** (a) OK koko 0,0 Mt / 38 Mt alussa ja replikoinnin jälkeen · (b) OK P kiinni test 9 = 9, S2 4 viestiä, haettavissa kyllä, VANHA ei, TUORE kyllä · (c) OK S2 8, VANHA 34 s. Raportoitu koordinaattorille c2.
- **Diagnoosi 28.10.2026 (todennettu, lähdebisect turha):** ajo 8 käytti vanhentunutta `ydin/apple/ScopesSolmu.xcframework`:ia (20.10. 19.38, ennen T-60/T-73…T-76); t59.sh ei varmistanut sitä. (a) xcresultin ruutunauhoite: "Peilin kokoa ei saatu: The data couldn't be read…" — vanha `/api/peili/koko` palauttaa `vanhin` HLC-merkkijonona (cbb42abe), PeiliKoko odottaa Int?. (b) vanha ikkuna HLC-ajasta (ennen T-73 sisältöaikaa) → replikoitu VANHA näyttää tuoreelta. daf6171b/2aaf1bee vain lisäyksiä, syyttömiä. Korjaus: t59.sh ajaa `xcframework_varmista` ennen koeydintä ja tulostaa XCFRAMEWORK-rivin; uusinta odottaa koordinaattorin Mac-UI-vuoroa.
- Lokit: Macin scratchpad `…/90462eca-51f0-4f75-a324-498d8403ffe5/scratchpad/t59-ajo8.log` ja `t59-ulos/` (xcodebuild-vaihe{1..4}.log, vaihe{1..4}.txt), xcresult `scopes2/ios/build/t59-vaihe{1,3}.xcresult`; säilyvät Macin uudelleenkäynnistykseen asti.
- **Koordinaattori sessions-repo-c2 28.10.2026:** iOS:lle ei jonossa tehtävää; T-102 kuuluu shared + Mac-UI-jonoon (SUUNNITELMA.md:558-560); S-9f iOS-asiakasnäkymä avoin suunnitelmamuutoksessa (SUUNNITELMA.md:235), tehtävämääritys tulee toteutussuunnitelmalta. Ei omaa työtä (koordinaattorin ohje).
- Aiempi: 21.10.2026 ajo 7 vihreä (b70dd25c), tuotanto vain luku exit 0 (37,84 Mt ≤ 38 Mt; (4)(5) tyhjä, `istuntoja=0`), gate T-49 (d) exit 0; yksityiskohdat `HISTORIA.md`.

## Avoimet asiat

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-59-uusinta (SCOPES2-PALUU-1735) | valmis b9d7c220 28.10.2026 (ajo 9 vihreä; ajo 8 punainen vanhentuneen XCFrameworkin takia) | ei mitään (rivi arkistoon seuraavassa arkisto-ajossa) |
| T-59 (4)(5) tuotantodatalla (ARK-17, T-57:n siirretyt) | odottaa: tuotannon 8797:ssä 101 skooppia mutta `istuntoja=0` ja `/viestit` tyhjä jokaiselle, joten t59-tuotanto.sh:n vertailu on tyhjä (0/101 valittu; skripti tulosti VIHREÄ tyhjästä → korjattu: valittuja 0 → `T59-TUOTANTO TYHJÄ`, exit 2) **21.10.2026:** ARK-17 HYVÄKSYTTY 21.10.2026; (4)(5) ja K-10 jälkitodennuksia ilman ehtoja (SUUNNITELMA.md:542-546). T-53 vihreä 20.10.2026 (SUUNNITELMA.md:472, ARKISTO.md:146). S-9f iOS-asiakasnäkymä avoin, päätös suunnitelmamuutoksessa (SUUNNITELMA.md:235). | kun ensimmäinen skoopillinen tuotantoistunto on (T-88 tuotantoon), aja t59-tuotanto.sh (ks. SEURAAVA PAKETTI) |

## Tila T-51 (20.10.2026 klo 23.15 — hyväksytty, ARK-08 kiinni)

- **Koordinaattorin päätös 20.10.2026:** T-51 hyväksytty osittain, 8/9 vihreä; iOS-simulaattorin rinnakkain-osa vihreä (vanha ja V2 yhtä aikaa). Mac-rinnakkain avoin (yllä); H-17 (iOS-laite) ei riipu Mac-osasta. Listavertailu API-tasolla (koeydin vs 8787) on hyväksytty poikkeama T-51-rivin sanamuodosta; UI-tason vastaavuus = T-49:n RunkoUITestit.
- **Mittausrivi T-51 (Mac, 21.28.46–21.31.31, exit 1, skripti `scopes2/ios/testit/t51/t51.sh` + `vertaa.py`, gate.sh 846b0a2f:n funktiot):** 8787 ennen 200 · macOS UI 4/0/10 · liite sha256 f3879a75…b085 = koeytimen `data/liitteet/`-tiedosto ennen trapia · rinnakkain PUNAINEN: V2 Mac (3 yhteyttä 18797:ään), vanha iOS ja V2 iOS (2 yhteyttä) käynnissä, vanha ScopesMac (DerivedData `ScopesMac-eglyeupjxtuggdbiksshgvbdckqx`, käännetty 20.10. 18.54.22, ad-hoc) kaatui 4 s:ssa SIGABRT (SwiftUI-asettelusilmukka, sama kuin 08.10.54 launchdin käynnistämänä) → V-628 · lista API: 97 skooppia, 0 eroa (nimi, tila, seuraava) · viestit infra expresso ja claude samat · 8787 jälkeen 200 · RSS-huippu 13 MiB (304 `ps -o rss=` -näytettä 0,5 s välein; Macissa ei VmHWM:ää), raja 512 MiB · `scopes/` ei uusia rivejä · jälkitila puhdas (18797/18787 eivät kuuntele, koedata poistettu). LuLu-kehotetta ei tullut.

- **Mittausrivi T-51 tarkistus 4 (Mac-rinnakkain, 23.14.34–23.15.43, exit 1, `scopes2/ios/testit/t51/t51-mac.sh`, HEAD ajon alussa 55099784):** 8787 ennen 3 × 200 (5/4/5 ms) · vanha ScopesMac käännetty HEADista d259de73 klo 23.13 (scratchpadin kopio, ad-hoc) · V2 Mac (käännetty 21.14, ad-hoc) · rinnakkain 25 s ja 60 s OK (molemmat käynnissä, V2 Mac 2 yhteyttä 18797:ään) · ei kaatumisraportteja · 8787 jälkeen 3 × 200 (5/123/3 ms) · RSS-huippu 14 MiB · jälkitila puhdas · PUNAINEN vain `scopes/`-aidasta: `scopes/vahtimestari/seuraa-istunnot.sh` muuttui 23.15.43 (vieras polku, scopes vahtimestarin oma bfaec1de; testi ei kirjoittanut siihen) → koordinaattori hyväksyi vihreäksi aitalinjauksella, ei uusintaa. Havainto: käyttäjän oma vanha ScopesMac (pid 54658, DerivedData-käännös 18.54 ennen V-628-korjausta d14a726e) oli käynnissä koko ajon; testi käynnisti erillisen instanssin eikä koskenut siihen.

## Tila T-49 (20.10.2026 klo 20.50 — valmis)

- `Sources/ScopesV2App.swift`: solmu käynnistyy etualalle (`.active`), näkymä pois ja solmu pysähtyy taustalle; `JuuriNakyma().id(sukupolvi)` ottaa uuden osoitteen. Varaston virtaa ei voi sulkea sovelluksesta (`Varasto` on JuuriNakyman sisäinen @State, shared on vain luku): näkymän poisto jättää Virta-tehtävän odottamaan, kunnes yhteys katkeaa. Jos vuoto haittaa, pyydä shared-skoopilta `Varasto`-viite tai deinit.
- UI-testit (iPhone 15 Pro, koeydin, tunneli): `testBundleIdOnP11nMukainen` vihreä, `testListaVastaaPalvelinta` vihreä (39 s), `testViestitVastaavatPalvelinta` vihreä (11 min; työkalurivi näkyy kolmena elementtinä samalla tunnisteella, lasketaan vain kuva; API:n yläraja on 120 viimeisintä, `nakymat.rs:34`; näkymä on oikein, vika oli testin laskennassa). `RinnakkainVanhanKanssa` on testissä vain bundle-id-tarkistus; Keychain-palvelun erillisyys todistetaan ScopesCore2:n `Avain.palvelu`-vakiosta, ei UI-testillä.
- **T-49 koko portti VIHREÄ 20.10.2026 klo 20.44–20.50** (`bash scopes2/shared/gate.sh T-49` exit 0, Darwin, aita puhdas): ScopesCore2 ja ScopesUI2 vihreät, macOS UI 4/0/10, iOS UI 3/0/10 (pass/fail/skip). Ajettu tila = commitit c17ed80c (gate.sh Darwin + 8787-silta 18787) ja 70170bc1 (T-52 + T-49-testivakautus); blobit gate.sh 846b0a2f, macOS RunkoUITests 7cbf1ce0, iOS RunkoUITests 14d30c5f (koordinaattori tarkisti, faef805e). Loki Macin scratchpadissa `t49-gate-4/gate.log` (istunto 39df5fcb).
- **Mittausrivi T-49 (4 Mac-ajoa, koordinaattorin vuorot):** 19.35 mitätön (gate.sh muuttui sekunti ajon alun jälkeen; Darwin-koeydin ilman 8787-siltaa → `testKoeydinVertaisena` 503 silta; aita: vieras `claude/siirto/mittaukset/vaihevirheet.jsonl`) · 19.42 punainen exit 1 (macOS `testViestitVastaavatPalvelinta`: ei yli 10 min vanhaa skooppia — 8787:ssä viestejä vain infra expressolla, 1/97) · 20.03 punainen exit 1 (iOS sama testi: UI 11780 vs API 120 — `laske()` limitti paikallaan olevan ikkunan itseensä identtisillä työkaluriveillä k=2 s=896, 600 kierrosta, 21 min; korjaus: paikallaan ennen limitystä, siirtymäraja 0,75 × korkeus, yksilöllisten rivien siirtymäehto; vertailu aikaleimaväliin ennen+jälkeen-listoista, koska /viestit on 120:n liukuva ikkuna) · 20.44 vihreä exit 0 (iOS UI ~3 min).
- Ajoaika ajossa 4: koko portti 5 min 30 s; iOS UI-vaihe ~3 min.

## Viat

| Vika | Tila |
|---|---|
| V-692 scopes-v2-asennus (LaunchAgent com.example.scopes-v2-asennus): devicectl install epäonnistui 9 ajossa 28.10.2026 klo 10.53–14.22 (Mac `~/Projects/scopes_2/scopes2-ios-asennus/asennus.loki` r. 152–203); klo 14.52 asennus valmis ilman korjausta (r. 206); lähde `claude/idea/IDEAT.md:141`. Seuraava: tarkista seuraavat ajot asennus.lokista; toistuessa selvitä devicectl-virheteksti. | kesken 28.10.2026 (juurisyy auki); odottaa ajoa (todenna viim. 4.11.2026) |

## Historia

Historia: `scopes2/ios/HISTORIA.md` (syntyy ensimmäisessä pakkauksessa), ei lueta purussa.
