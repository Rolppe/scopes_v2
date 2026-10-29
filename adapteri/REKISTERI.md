# scopes2/adapteri/REKISTERI.md

Tilanne: 28.10.2026

SEURAAVA PAKETTI: ei briefattua adapterityötä — odottaa koordinaattorin (sessions-repo-c2) tai toteutussuunnitelman seuraavaa briefiä (T-110:n V1-synkkabriefit) — polut: scopes2/adapteri/** — aloitus: /pura scopes2 adapteri

## Tarkoitus ja raja

scopes-V2:n Node-adapteri: lukee transkriptit, tmuxin, agyn ja adb:n inkrementaalisesti ja kirjoittaa ne ytimeen (porttiin 8797) peileinä ja lähdetilana.

Raja: polut `scopes2/adapteri/**` ja `scopes2/kaynnista.sh`. Ei muutoksia `scopes/**`-puuhun (vanha `scopes/palvelu` ja 8787 koskemattomia, K-9; gate.sh:n `scopes/`-aita). Ytimen koodi (`scopes2/ydin/**`) kuuluu skoopille `scopes2 ydin`. Arkkitehtuuri: `scopes/architecture/SUUNNITELMA.md` luku 9 (ARK-06); tehtävät ja briefit: `scopes/toteutussuunnitelma/SUUNNITELMA.md` luku 5 ja `briefit/T-nn.md`. Ei lueta purussa.

## Päätökset

- **Käyttäjä 19.10.2026:** skooppi `scopes2 adapteri` luotiin komennolla `/pura uusi scopes2 adapteri`.
- **Käyttäjä 19.10.2026 (ARCHITECTURE-JAKELU, H-4; tehty `scopes architecture` -skoopista käyttäjän pyynnöstä, välitetty `scopes macos` -keskustelusta):** tämä skooppi omistaa ARK-06:n adapterin osan (T-24-G, T-29, T-25, hyväksyntäajo T-34); ytimen osa (T-23, T-30, T-35) kuuluu `scopes2 ydin` -skoopille.
- **Käyttäjä 19.10.2026 (aitalinjaus, välitetty `scopes kordinaattori` -istunnosta):** jos gate.sh:n aita kaatuu vain vieraisiin polkuihin, joihin muut istunnot kirjoittivat ajon aikana (esim. `claude/siirto/mittaukset/vaihevirheet.jsonl`, muiden skooppien pakkaukset) eikä toteuttaja transkriptin mukaan kirjoittanut niihin, valvoja ajaa portin `node --test`-vaiheen erikseen, kirjaa vieraat polut ja omistajat mittausriville ja committiviestiin ja committoi muuttamatta porttia.

- **19.10.2026:** Käyttäjä 19.10.2026: gate-aidat vertaavat ajon alun lähtötilaan (V-567, briefien Poikkeama-luvut T-24-G, T-29, T-25).

- **19.10.2026:** Käyttäjä (koordinaattorin kautta): aitalinjaus vieraista poluista (rekisterin Päätökset); alkoi ISO S-5b:n mukaan; ladatut/nimi/pid/vanhempi/polku S-5b:n lisäkenttinä (T-29.md Poikkeama); siltavertailun uusinta (T-25.md Poikkeama); ytimen runkorajaa ei muuteta (adapteri pilkkoo); T-34 ajo 4 harjoituksen kautta.

- **19.10.2026:** Raportit koordinaattorille palvelin-e5 (scopes kordinaattori); H-5 asensi käyttäjä rootina /etc/cron.d/scopes2 (bc47388a), adapteri ei lisää cron-rivejä.

- **21.10.2026:** Portit /tmp-kloonissa (clone --local + origin-kärki + muutokset tarilla, ydin symlinkkinä, flock /tmp/scopes2-koeportti.lock), ei cron-puussa eikä Macin jaetussa kloonissa. Siivouksessa tarkat pidit, ei pkill -f.

- **21.10.2026:** Tuotantopuun päivitys ja tuotannon adapterin käynnistys eivät kuulu adapteri-sessiolle: käyttäjä päätti 21.10. klo 10.5x "oneplus server odottamaan, iOS ja macOS jatkuvat, ARK-16 jatkuu" (lähde scopes/patriot/REKISTERI.md 1269d843); ARK-11a, T-90 ja adapterin käynnistys odottavat.

- **21.10.2026:** Fixturemuodon laajennukset (ymparisto.*, odotus.ajaValinnat/viiveet, binäärivastaus): 9f kuittasi (6cc12c75, 5bcfd268, 61f93843).

- **21.10.2026:** Osakopiosopimus (gate.sh t65): rivi 1 "// osakopio: scopes/palvelu/<alkup>:<a>-<b>[,…] (…)", rivit 2… = alkuperäisen rivialueet; koordinaattorin hyväksymä.

- **21.10.2026:** Yhteinen toimintolukko aja.mjs:ssä (avain ymp.tila; pura, istunto, T-81 uusi) kuten vanhan yksi `kaynnissa`; T-68 ajettiin toteuttaja-opuksella (väärä /exit sulkee elävän istunnon).

- **21.10.2026:** may-laajennukset koordinaattorin luvalla: testiapurit.mjs, aja.mjs/istunto.mjs (lukko), gate.sh (t65 osakopiot), adapteri.mjs/agentit.test.mjs (adb). Hylätty: SALLITUT_TUONNIT:n täysi tyhjennys (rivi 446 pysyy tavulleen).

- **21.10.2026:** fe: T-85 poikkeamat (1) ajaTavut, (2) --android-kuiva ja SCOPES2_ANDROID_KUIVA, (4) lähdetilan tila() ei kulje sarjaan-lukon kautta hyväksytty; (3) 502-yksinkertaistus EI hyväksytty, vanhat statuskoodit palautettu (iOS/macOS-asiakkaat odottavat vanhaa käytöstä, T-70 vertaa 8787:ään).

- **21.10.2026:** fe: T-67 ja T-68 ajetaan T-86:n regressioina erillisinä gate-ajoina (gate.sh:iin ei koskettu).

- **21.10.2026:** käyttäjä: pakkaa nyt (AskUserQuestion). Fe pyysi sulkemaan istunnon viikkorajan säästämiseksi; aloitus /pura scopes2 adapteri, kun ytimen T-84 on vihreä.

- **21.10.2026:** käyttäjä (kortti): T-70-valmistelu ja koe ilman tuotantoa saa alkaa. Tuotantoajo vaatii erillisen luvan koordinaattorilta (käyttäjän päätös); adapteri-sessio ei aloita sitä.

- **21.10.2026:** koeajuri käyttää julkaise.sh --koe -binääriä SOLMU-muuttujalla, ei tuotantobinääriä eikä asennusta.

- **21.10.2026:** Käyttäjä (AskUserQuestion): T-70-ajo ja V2-uudelleenkäynnistys "Kyllä, aja"; tuotantopuusta vain 7 tiedostoa (hylätty: koko puu 43 commitilla + merge); H-18 ensin siirretty (hylätty: uusi koe-skooppi /api/uusi:lla, koska se luo oikean skoopin, commitin ja Claude-istunnon), sitten ajettu overseerin välittämällä luvalla.

- **21.10.2026:** 04 (fe): A → T-95 (ei kopiota, vanha scopes-chat); B hyväksytty (V-639, kayttoraja ilman parametreja Contractin muotoon); T-70 hyväksytään kun (7), H-18 ja chat-vertailu OK (nyt tehty); T-95 ennen T-94:ää; cron.d-tarjous T-94:n jälkeen.

- **21.10.2026:** H-18: koeistunto olemassa olevalle skoopille "scopes test", ei pakkausta. Kirjaus: T-95/T-94-viennin hyväksyjä overseer V-OVS-4, ei käyttäjä; käyttäjä hyväksyi itse vain asennuksen 7da86808 ja V2-uudelleenkäynnistyksen (overseer REKISTERI 0dceb548).

- **21.10.2026:** Repon Infra/linux/palvelin/cron.d-scopes2 kuuluu infralle; ei muutettu.

- **21.10.2026:** Koordinaattori 20 valitsi ruutukorjaukseksi PNG-allekirjoitusta edeltävien tavujen poiston (ei allekirjoitusta = vanha 500); `-d <näytön id>` hylätty, koska näytön id voi vaihtua. Korjaus tehtiin tietoisena erona vanhaan kopioon (T-65:n .ero-tiedosto), vanhan 8787:n korjaus kuuluu scopesin omistajalle.

- **21.10.2026:** Tuotannon adapterin uudelleenkäynnistyksestä päätti overseer; adapteri-sessio ei käynnistänyt 7903:a.

- **21.10.2026:** T-88 (6) lykättiin käyttäjän päätöksellä 5736f24e ("android etäohjausta voidaan jättää myöhemmäksi ios ja mac äpeissä"); valmisteltu työ jäi repoon. Seuraavan paketin valinnassa käyttäjä valitsi 21.10.2026 "Ei seuraavaa pakettia — pakkaa vain"; hylätty vaihtoehto: tuotantopuun synkka (43 commitia, päätettävä erikseen).

- **21.10.2026:** Seuraavan paketin valinta 21.10.2026 (uusi pakkaus): käyttäjä valitsi "Ei seuraavaa pakettia — pakkaa vain"; hylätty: tuotantopuun synkka.

- **21.10.2026 (koordinaattori, agy-pakkaus):** agy Flash -ajot valmiit: T-98 6eba3f10 (kirjattu aiemmin 5e758027); T-101 siltavertailu sallii eron istunto.transkripti 2eddfd95 (siltavertailu.test vihreä). Raportit ~/agy-raportit/T-98, T-101.

- **28.10.2026 (SCOPES2-PALUU-1735, koordinaattori sessions-repo-21; patriot 307ef0d7):** adapteri-valvoja Opus high tarkisti rajan jälkeiset: 3198b79e (ruutu), T-98 6eba3f10 ja T-101:n adapteriosa 2eddfd95 oikein, ei uudelleentoteutusta; T-88 (6) ei ajettu (Android lykätty 5736f24e, V-OVS-13), skriptit katselmoitu staattisesti. ARK-16:n adapteriosa katselmoitu Opuksella (3 katselmoijaa, löydökset Avoimissa). Konfliktimerkit (stash) poistettu REKISTERI/ARKISTO/HISTORIA:sta (Updated upstream -puoli säilyi). T-65 vertaa kopiota kopiorivin commitiin (myös osakopio `@ <commit>`); vanhan palvelun myöhempi muutos tulostaa TIEDOKSI-rivin eikä punaa. vanhasta/agy-istunto.mjs synkattu 47b8ccaf:iin (a85e3c0b oli muuttanut kopiota osittain, ei rajapintamuutosta); agy-kayttoraja.mjs ja toiminnot-asetukset.mjs EI synkattu, koska uusi alkuperäinen muuttaa S-5b/kayttoraja-vastausta (automaattisiirto, ymparisto/otsikko).

- **28.10.2026 (overseer, pane-vastaus malliton purku):** ei kumpaakaan: tuotannon adapteria ei käynnistetä eikä ~/palvelinta pullata; ARK-11a ja T-90 odottavat. ARK-16-löydökset vietiin koordinaattorille.

- **28.10.2026 (valvoja, toteutussuunnitelma hyväksyi bce4e619):** gate t94 (c) odottaa toiselta limittäiseltä ajolta "LUKKO: toinen kaynnista.sh käynnissä" (tarkoitus ennallaan: ei toista ydintä, ytimiä 1). scopes2/kaynnista.sh kuuluu adapterin rajaan.

- **28.10.2026 (valvoja, T-104; ilmoitettu koordinaattorille c2):** kopioon vain ASETUKSET-rivi automaattisiirto ja kopiorivi @ 47b8ccaf + uusi vanhasta/toiminnot-asetukset.mjs.ero; ssh dev-host -lohkoa ei tuoda adapteriin.

- **28.10.2026 (T-104, toteuttaja):** briefin reitti `…/automaattisiirto/paalla` on kirjoitusvirhe; oikea tila on `paalle` (toiminnot/asetukset.mjs:56 TILA), testi käyttää `paalle`.

- **28.10.2026 (toteutussuunnitelma):** onMac-kenttää ei lisätä ennen päätöstä; S-5b laajennetaan (ei suodatusta); jonon omistaa adapteri (T-108 ydin ensin, sitten T-109). Järjestys adapterille: T-103…T-107, T-109 T-108:n jälkeen, T-111; T-110 rinnalla. Raportit koordinaattorille: sessions-repo-c2 (tmux siirto-scopes-kordinaattori).

- **Valvoja 28.10.2026 (T-106):** brief rajasi muutoksen asetuksetSisalto-riveihin; samanaikaisen kaksoishaun estämiseksi myös keraajat.agy vaihdettiin agyJaettuun (agySisalto-runko ennallaan).
- **Valvoja 28.10.2026 (T-111):** uusi↔pura-lukko palauttaa 429 kuten vanha (brief sanoi 409; testi vahvistaa 429); T-111 toteutettiin ennen T-109:ää (T-109 odottaa ytimen T-108:aa).

## Avoimet asiat

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-06 adapteri: T-24-G (Opus) → T-29 → T-25 (odottaa ytimen T-23, T-35) → T-34 hyväksyntäajo tuotantolähteillä (valvoja itse, H-5 cron-rivi käyttäjän luvalla) | tehty 19.10.2026: T-24-G fce665eb, T-29 18487961+bb065bfb+b707b594, T-25 db3b3ae4+00bcc65f, T-37 5ad80920+29646bf3, T-34 ajo 4 vihreä 37edddb0 ja uusintavertailu 6ea06bfa (PEILI 3487/3487, SILTA 8/8, p50 11,9 ms); H-5 tehty bc47388a (käyttäjä rootina /etc/cron.d/scopes2, */5 `kaynnista.sh`; ajo 21.30 TERVEYS: 200); V2 käynnissä 8797. **19.10.2026:** T-34 lopullinen (6ea06bfa): PEILI 3487/3487, SILTA 8/8 (ydin 7, silta 1 = /api/agentit), p50 /api/skoopit 11,9 ms, 8787 200, VmHWM ydin 214 MiB / adapteri 304 MiB, data 2,6 GB; T-34:n punaisten ajojen syyt mittausriveillä (T-34 ajot 1–3, harjoitukset). **21.10.2026:** portit palvelimella 21.10.2026 (tarilla muutokset originin 4880929e päälle), kaikki exit 0, ei aita-/TUONTI-osumia: --itsetesti, T-68 69/69, T-67 58/58, T-66 42/42, T-65 (11 kopiota diffattu), T-63 22/22, T-82 40/40, T-69 48/48, T-80 50/50, T-83 48/48, T-25; aiemmin T-24 26/26, T-29 10/10, T-89; free -m avail 4,4–5,1 Gt ennen ajoja. **21.10.2026:** portit palvelimen /tmp-kloonissa (flock /tmp/scopes2-koeportti.lock, free -m ennen, klooni siivottu): T-29 vihreä (myös T-85:n korjauksen jälkeen); T-81, T-86, T-63, T-67, T-68, T-65, T-82, T-69, T-85 vihreitä. palvelimelta pääsee ssh:lla (BatchMode) ja se kloonaa GitHubista; T-81/T-86/T-85-portit eivät tarvitse ydintä (symlinkkiä ei tarvittu). **21.10.2026:** T-25 todettu 21.10.2026: adapterin /api/terveys-reitit 29 = toteutetut 29; stop vapaalle 409, kysymys-pois 409, pakkaa olemattomaan 404, chat/keskustelut, purkajat, malli olemattomaan 404 ja uusi olemassa olevalla nimellä 409 samoin kuin vanha (X-Lahde adapteri); asetukset, 3 skoopin asetukset ja kayttoraja (ilman/agy) X-Lahde ydin = vanha; adapteri kiinni → 503 {"virhe":"adapteri"} (pakkaa, purkajat, chat/keskustelut, agentit), vanhan toimintoloki ei kasvanut; gate T-25 uudella binäärillä PEILI 6/6; VmHWM ydin 6 MiB, adapteri 80 MiB; vanhan terveys 200 ennen ja jälkeen; git status -- scopes/ ennallaan. | odottaa koordinaattorin (scopes kordinaattori) vaihe 3 -tehtävää; ei ajettavaa |
| Päällekkäiset vakiokopiot (MALLIT, PAIKALLINEN: viestit-vakiot, agentit, chat) | avoin | kirjattu purkua varten (fe); fe 21.10.2026: adapteripuolella ei ole ajettavaa ennen T-84:ää. |
| lahde.kierros()-kierroslukko puuttuu (kaksi kutsua voi lähettää saman sisällön kahdesti) | korjattu 91a7227f 28.10.2026 (T-111: kierros() liittyy käynnissä olevaan); odottaa ajoa (todenna viim. 11.11.2026) | jäljellä: `--agy-luvat` kaynnista.sh:ssa vanhan alasajossa; Mac-agy-fixture puuttuu (~-polku, käsin testattu). |
| pura.mjs (kuten vanha): kahden ruudun skoopissa ensimmäinen saa /exit ennen toisen pid-tarkistusta | avoin | — |
| Tuotannon adapterin käynnistys (tehty 21.10.2026 klo 15.31, käyttäjä hyväksyi) ja T-90 + ARK-11a | tuotanto ylhäällä: ydin 7da86808 pid 7476, adapteri pid 7903 (`--toiminnot 8798 --chat`); T-90 ja ARK-11a odottavat käyttäjää | T-90 ja ARK-11a: käyttäjä/overseer (b5) päättää; adapteri-sessio ei tee. |
| T-88 (ARK-19-hyväksyntäajo, valvoja) | kohta (5) VIHREÄ 21.10.2026 klo 17.30 palvelimen /tmp-kloonissa (b4c0ccd0, `vertailu/t88-koe.sh` + `t88-tarkista.mjs`, koeadapteri 18822, oma HOME, ydin-URL suljettuun 18829:ään, adb/ssh/ping/python3 mockeina): 9 android- ja 2 palvelin-toimintoa + liite vastasi 200 ja `kuiva`-kentällä (merkkijono = komento, jota ei ajettu; ei literaali `true` kuten vanhassa), mock-loki 0 kiellettyä (adb input/am start/push, ssh poweroff, python3/WoL), toimintoloki 9 riviä kaikki kuiva-merkittyjä, VmHWM 61 MiB, terveys 29 reittiä, 401 ilman avainta, tuotannon adapteri pid 7903 ja 8798 ennallaan; huomio: linux kaynnista -rivin kuiva-teksti toimintolokissa näyttää polun `<juuri>/scopes2/Infra/linux/…/herata-pc.py` (vastauksessa oikein `<juuri>/Infra/…`) — vain lokiteksti, ei ajettu **21.10.2026:** T-88 (6) Mac-ajo: gate T-87:n macOS OhjausUITests kulki oikean koeadapterin kautta (välittäjän todiste: ruutu 14, palvelin tila 8, sammuta 1, nappi 1, napauta 1; kaikki 200); iOS-vaihe kaatui kahdesti: `xcodebuild: Unable to find a device ... name:iPhone 17 Pro, OS:latest` (iPhone 17 Pro vain OS 26.5; gate valitsi sen GATE_SIMIT-oletuksesta, kun iPhone 15 Pro oli varattu); kolmas yritys GATE_SIMIT="iPhone 15 Pro" keskeytettiin. Koko gate-loki /tmp/t88-mac-gate.out (ajoista viimeinen ennen keskeytystä). | **21.10.2026 klo ~17.40 (overseer 05, käyttäjän "Sinä päätät", scopes/overseer/REKISTERI.md 5f1d29eb; vain luku):** (1) OK 29 reittiä, T-85/T-86-reitit mukana; (2) OK ydin 200 X-Lahde ydin = vanha, avainrakenne sama; (3) ui ja tuotokset OK (rungot samat), **ruutu FAIL**: 500 "JPEG-muunnos epäonnistui: PIL.UnidentifiedImageError" — täsmälleen sama virhe myös vanhassa 8787:ssä ja adapterissa 8798 suoraan, joten ei adapterin regressio; juurisyy: laitteessa on kaksi näyttöä (HWC display 1 = LG TV SSCR2), jolloin `adb exec-out screencap -p` kirjoittaa ennen PNG:tä 347 tavun `[Warning] Multiple displays were found…` -tekstin (PNG-allekirjoitus offsetissa 347) eikä PIL tunnista kuvaa; (4) OK palvelin ydin = vanha {"tila":"linux"}; (7) OK silta 8/8 (ydin 7, silta 0), 8787 terveys 200 ennen ja jälkeen, tuotannon git status -- scopes/ ennallaan; adapteria ei käynnistetty uudelleen, tuotantoon ei kirjoitettu. Skripti `vertailu/t88-tuotanto.mjs` (aecc3e07). | **21.10.2026 klo ~18.05 (overseer vei tuotantopuuhun vain vanhasta/android.mjs; adapteri käynnistetty uudelleen, cron pid 15313):** `vertailu/t88-tuotanto.mjs` kokonaan vihreä: (1) 29 reittiä, (2) OK, (3) ruutu 200 image/jpeg 11057 tavua JPEG-alku ffd8, ui ja tuotokset = vanha, (4) OK; (7) silta 8/8, 8787 terveys 200 ennen ja jälkeen, tuotannon git status -- scopes/ ennallaan. **T-88 jäljellä vain (6) Mac (T-59:n jälkeen).** **Korjattu 21.10.2026 (3198b79e):** koeadapteri 18822 oikealla laitteella ruutu 200 image/jpeg; tuotannon 7903 ajaa vielä vanhaa koodia, joten (3) ruutu tuotannossa vihreä vasta overseerin päättämän uudelleenkäynnistyksen jälkeen (uusinta: `vertailu/t88-tuotanto.mjs`). (Alkuperäinen suunta:) ruutu: korjaus (PNG-alkua edeltävien tavujen pois tai `screencap -p -d <näytön id>`) kuuluu `vanhasta/android.mjs`-kopioon (T-65-kopio, erota vanhasta tietoisesti) ja vanhaan 8787:ään (scopes); käyttöönotto vaatii adapterin uudelleenkäynnistyksen, joten koordinaattori päättää. (6): Mac, T-59:n jälkeen. **21.10.2026 klo ~18.30: (6) LYKÄTTY käyttäjän päätöksellä 5736f24e** ("android etäohjausta voidaan jättää myöhemmäksi ios ja mac äpeissä"; overseer 9f pysäytti ajon). Valmisteltu ja pushattu mutta ei suoritettu loppuun: `vertailu/t88-valitys.mjs`, `t88-koe-palvelu.sh`, `t88-mac.sh` (bf64c0a1, 8b157dc1) ja `shared/gate.sh`:n GATE_OHJAUS_MOCK/GATE_OHJAUS_LISA-koukku (shared-omistajalle tiedoksi). Havainnot: gate T-87:n macOS OhjausUITests kulki oikean koeadapterin kautta (ruutu, palvelin tila ja sammuta, nappi, napauta; välittäjän todiste) ja gate eteni iOS-vaiheeseen; iOS-vaihe kaatui kahdesti simulaattorin valintaan (`iPhone 17 Pro` OS:latest ei löydy; GATE_SIMIT="iPhone 15 Pro" -ajo keskeytettiin). Siivottu: tunneli, koeadapteri ja palvelimen /tmp-hakemistot pois, Mac-koeydin 96091 kuollut, worktree poistettu. Jatko: `GATE_SIMIT="iPhone 15 Pro" bash scopes2/adapteri/vertailu/t88-mac.sh` committoidusta worktreestä, kun Android-osa otetaan työn alle. |
| T-70 (hyväksyntä) | tehty 21.10.2026: kohdat 1–7 ja H-18 OK (tuotannossa, aita puhdas); poikkeamat A → T-95 ja B → V-639 käsitelty; cron.d-rivi todennettu 21.10.2026 klo 16.55: `/etc/cron.d/scopes2` sisältää SCOPES2_TOIMINNOT=8798 ja cronin ajama kaynnista.sh sai sen (`CRON-AJO pid 5345 16:55:01 SCOPES2_TOIMINNOT=8798`, tarkista-skripti exit 0); odottaa fe:n/overseerin kuittausta | kun fe/overseer kuittaa T-70:n hyväksytyksi (odottaa muuta sessiota, ei adapterin tehtävä). |
| V-637 → scopes2 (vika.sh, f3d98a1) | avoin | scopes2/kaynnista.sh muutettu tässä sessiossa (T-89 adapterin uudelleenkäynnistys, T-63-G SCOPES2_TOIMINNOT); jää omistajalle (fe 21.10.2026). **21.10.2026:** todettu 21.10.2026: scopes2/kaynnista.sh ei anna ytimelle --adapteri-lippua (vain adapterille --toiminnot); V-637:n omistaja päättää. |
| Ydin: GET /api/agentit X-Lahde-otsikko (nakymat.rs) | avoin (kuuluu skoopille scopes2 ydin); odottaa skooppia scopes2 ydin | ydin korjaa; sen jälkeen aja uudelleen: SOLMU=<uusi binääri> bash scopes2/adapteri/vertailu/t70-koe.sh palvelimen /tmp-kloonissa flockin alla. |
| Tuotantopuu ~/palvelin: 43 commitia originin takana, 4 siirto-commitia edellä; työpuussa scopes2/adapteri/{ARKISTO,HISTORIA,REKISTERI}.md, gate.sh, adapteri.mjs, chat.test.mjs, scopes2/kaynnista.sh (= 7c9bda9d) ja lisäämättömät vertailu/t70-koe.sh, t70-tarkista.mjs; tuotanto ajaa tästä puusta (cron /srv/work) | avoin; odottaa käyttäjää (pull/merge päätettävä erikseen) **21.10.2026:** Tuotannon `git status -- scopes/` ennallaan `t88-tuotanto.mjs`-uusintaajon jälkeen (29 reittiä, ydin/ruutu/ui/tuotokset/palvelin = vanha, silta 8/8; 8787 terveys 200 ennen ja jälkeen). | kun käyttäjä päättää pull/mergen: komento annetaan hänelle, adapteri-sessio ei tee sitä itse. |
| ARK-16-katselmointi 28.10.2026 (Opus): löydökset | kesken; korjaukset briefattu 038c6589 (T-103…T-111); T-103 korjattu f221b910, T-104 korjattu 8b847c97, T-105 korjattu e6cb4a6e, T-106 korjattu 4e10954e, T-107 korjattu e3992fcd, T-111 korjattu 91a7227f, T-109 korjattu d5d90d60 28.10.2026 (portit palvelimen /tmp-kloonissa EXIT=0: T-106 T-29, T-83, T-25; T-107 T-67, T-68; T-111 T-24, T-29, T-63, T-65, T-81, T-25; T-109 T-29, T-67, T-25 GATE_SOLMU = ydin ff8fa832); T-110 korjattu abd8a50b (V1-SYNKKA.md); odottaa ajoa (todenna viim. 11.11.2026) | Jäljellä: T-111 kohta 4: --istunnot/--agy/--brain ilman omaa testiä (vain --projektit katettu). |
| Vanha scopes/palvelu muuttui 26.–27.10.2026 kopioiden jälkeen (toiminnot.mjs, viestit.mjs, palvelin.mjs, agy-kayttoraja.mjs, toiminnot-asetukset.mjs: agy pura C-c/kill-window, --autojatko, scp, agy infra-perheelle, vaihdaMalli agy, AGY_MALLIT, automaattisiirto, sulje, Mac AGY -kayttoraja) | kesken; kartoitettu T-110:ssä abd8a50b (scopes2/adapteri/vertailu/V1-SYNKKA.md: A 16, B 6+1, C 1; kopioiden ulkopuolella B 20, ei S-10-vastinetta), toteutussuunnitelma kuittasi a6146354; odottaa skooppia scopes toteutussuunnitelma | synkkabriefit toteutussuunnitelmalta seuraavassa istunnossa (paketti V1-SYNKKA-BRIEFIT); kopioiden synkka on oma tehtävä (muuttaa V2-sopimusta). |
| gate.sh jättää koehakemistot /tmp/scopes2-koe ja /tmp/scopes2-koe37 ajon jälkeen | avoin (tiedoksi) | kun gate.sh:ta muutetaan seuraavan kerran, odottaa vaihe 3 -tehtävää |
| --istunnot ei täytä vanhoja transkripteja tuoreeseen ytimeen | avoin (tiedoksi; tuotannossa peili jo täynnä) | kun uusi solmu tarvitsee täyttöä (vaihe 3), odottaa koordinaattoria |

## Viat

| Vika | Tila |
|---|---|
| `gate.sh`-aita (lähtötila-aita) punastui kahdesti jaetussa Mac-puussa 21.10.2026, kun toinen sessio loi `KOE.tmp`-tiedostoja (`scopes/`, `scopes2/ydin/`); uusintaajo vihreä. Ennestään tunnettu: lähtötila-aita on globaali jaetussa puussa. Ratkaisu: portit /tmp-kloonissa. | avoin (uusintaajo vihreä; ratkaisu = portit /tmp-kloonissa) |
| V-639 → scopes (vika.sh, commit 23e18dd, 21.10.2026): scopes/palvelu (8787) `GET /api/kayttoraja` ilman parametreja aikakatkaisu yli 100 s kahdella yrityksellä, vaikka /api/terveys 200 ja ?tyyppi=agy 45 ms; 8797 vastaa 2 ms. Oire, ei adapterin vika; tila tuotannossa. | avoin 21.10.2026; odottaa skooppia scopes |
| V-648 → scopes2 shared (vika.sh, b161d5c, 21.10.2026): `scopes2/shared/gate.sh` sai pienen koukun (GATE_OHJAUS_MOCK/GATE_OHJAUS_LISA, oletus ennallaan); omistajalle tiedoksi. | avoin; odottaa skooppia scopes2 shared |
| Havainto scopes2 shared:lle (ei erillistä vika.sh-riviä, 21.10.2026): gate.sh T-87:n iOS-vaihe valitsee GATE_SIMIT-oletuksen toisen simulaattorin `iPhone 17 Pro` (OS:latest ei löydy, vain 26.5), kun `iPhone 15 Pro` on varattu; ajot kaatuvat "Unable to find a device". | avoin; odottaa skooppia scopes2 shared |

## Historia

Historia: `scopes2/adapteri/HISTORIA.md` (syntyy ensimmäisessä pakkauksessa), ei lueta purussa.
