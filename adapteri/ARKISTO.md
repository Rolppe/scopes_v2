# scopes2 adapteri — arkisto

Aktiivisesta rekisteristä poistettu tai muutettu tieto sanatarkasti, vanhin ensin (V-082, 28.9.2026).
Tästä ei poisteta mitään. Purku ei lue tätä tiedostoa: se luetaan vain vianselvityksessä, kun
halutaan tietää, mitä rekisterissä on joskus ollut. Kirjoittaja: `claude/siirto/tools/arkisto.mjs`.

## 19.10.2026 — scopes2 adapteri

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-06 adapteri: T-24-G (Opus) → T-29 → T-25 (odottaa ytimen T-23, T-35) → T-34 hyväksyntäajo tuotantolähteillä (valvoja itse, H-5 cron-rivi käyttäjän luvalla) | tehty 19.10.2026: T-24-G fce665eb, T-29 18487961+bb065bfb+b707b594, T-25 db3b3ae4+00bcc65f, T-37 5ad80920+29646bf3, T-34 ajo 4 vihreä 37edddb0 ja uusintavertailu 6ea06bfa (PEILI 3487/3487, SILTA 8/8, p50 11,9 ms); H-5 tehty bc47388a (käyttäjä rootina /etc/cron.d/scopes2, */5 `kaynnista.sh`; ajo 21.30 TERVEYS: 200); V2 käynnissä 8797 | ei avointa; seuraava vaihe 3:sta |
| T-37 `kaynnista.sh` kova RLIMIT_DATA-raja (`ulimit -d` alikuoressa ennen käynnistystä: `SCOPES2_YDIN_DATARAJA` 1572864 KiB, `SCOPES2_ADAPTERI_DATARAJA` 1048576 KiB; tuloste `RAJA: ydin <KiB> adapteri <KiB>` `/proc/<pid>/limits`:stä) (toteutussuunnitelma, brief `scopes/toteutussuunnitelma/briefit/T-37.md`, Sonnet): kaikilla `oom_score_adj` -950, joten OOM 19.10.2026 valitsi uhrit mielivaltaisesti; nosto vaatii rootin (todettu Bash-työkalussa ja ssh-kuoressa), RLIMIT_DATA toimii ilman rootia | tehty 5ad80920 (gate T-37 ja T-25 vihreät päätyöpuussa); Node 22 -korjaus 19.10.2026: ssh-kuoren ja cronin PATHin /usr/bin/node 20 kaatoi adapterin (`node:sqlite` puuttuu), joten `kaynnista.sh` vaihtaa alle 22:n NODEn Node 22:een tai lopettaa exit 4:llä, gate.sh valitsee Node 22:n samoin ja T-37:ssä on tapaukset `env -i PATH=/usr/bin:/bin` ja periytynyt `NODE=/usr/bin/node` (portit vihreät minimiympäristössä) | ei avointa (T-34 vihreä; oom_score_adj nyt 0 Debian-prosesseilla, V-570) |
| Paketin katto: ARK-06 Budget-summa 1,70 M tokenia (ydin + adapteri); katto 3 × (toteutussuunnitelma luku 7) | ohje | ylitys → pysähdys ja käyttäjän päätös |

## 21.10.2026 — scopes2 adapteri

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: ei mitään — ARK-06:n adapterin osa valmis (T-34 vihreä, H-5 tehty bc47388a); seuraava työ vaihe 3:sta koordinaattorin (scopes kordinaattori) kautta — polut: scopes2/adapteri/** — aloitus: /pura scopes2 adapteri — automaattinen: ei

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-06 adapteri: T-24-G (Opus) → T-29 → T-25 (odottaa ytimen T-23, T-35) → T-34 hyväksyntäajo tuotantolähteillä (valvoja itse, H-5 cron-rivi käyttäjän luvalla) | tehty 19.10.2026: T-24-G fce665eb, T-29 18487961+bb065bfb+b707b594, T-25 db3b3ae4+00bcc65f, T-37 5ad80920+29646bf3, T-34 ajo 4 vihreä 37edddb0 ja uusintavertailu 6ea06bfa (PEILI 3487/3487, SILTA 8/8, p50 11,9 ms); H-5 tehty bc47388a (käyttäjä rootina /etc/cron.d/scopes2, */5 `kaynnista.sh`; ajo 21.30 TERVEYS: 200); V2 käynnissä 8797. **19.10.2026:** T-34 lopullinen (6ea06bfa): PEILI 3487/3487, SILTA 8/8 (ydin 7, silta 1 = /api/agentit), p50 /api/skoopit 11,9 ms, 8787 200, VmHWM ydin 214 MiB / adapteri 304 MiB, data 2,6 GB; T-34:n punaisten ajojen syyt mittausriveillä (T-34 ajot 1–3, harjoitukset). | odottaa koordinaattorin (scopes kordinaattori) vaihe 3 -tehtävää; ei ajettavaa |

## 21.10.2026 — scopes2 adapteri

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-81 — POST /api/uusi (toiminnot/uusi.mjs; yhteinen toimintolukko aja.mjs:ssä valmiina), sen jälkeen T-85 ∥ T-86 — polut: scopes2/adapteri/** — aloitus: /pura scopes2 adapteri

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-06 adapteri: T-24-G (Opus) → T-29 → T-25 (odottaa ytimen T-23, T-35) → T-34 hyväksyntäajo tuotantolähteillä (valvoja itse, H-5 cron-rivi käyttäjän luvalla) | tehty 19.10.2026: T-24-G fce665eb, T-29 18487961+bb065bfb+b707b594, T-25 db3b3ae4+00bcc65f, T-37 5ad80920+29646bf3, T-34 ajo 4 vihreä 37edddb0 ja uusintavertailu 6ea06bfa (PEILI 3487/3487, SILTA 8/8, p50 11,9 ms); H-5 tehty bc47388a (käyttäjä rootina /etc/cron.d/scopes2, */5 `kaynnista.sh`; ajo 21.30 TERVEYS: 200); V2 käynnissä 8797. **19.10.2026:** T-34 lopullinen (6ea06bfa): PEILI 3487/3487, SILTA 8/8 (ydin 7, silta 1 = /api/agentit), p50 /api/skoopit 11,9 ms, 8787 200, VmHWM ydin 214 MiB / adapteri 304 MiB, data 2,6 GB; T-34:n punaisten ajojen syyt mittausriveillä (T-34 ajot 1–3, harjoitukset). **21.10.2026:** portit palvelimella 21.10.2026 (tarilla muutokset originin 4880929e päälle), kaikki exit 0, ei aita-/TUONTI-osumia: --itsetesti, T-68 69/69, T-67 58/58, T-66 42/42, T-65 (11 kopiota diffattu), T-63 22/22, T-82 40/40, T-69 48/48, T-80 50/50, T-83 48/48, T-25; aiemmin T-24 26/26, T-29 10/10, T-89; free -m avail 4,4–5,1 Gt ennen ajoja. | odottaa koordinaattorin (scopes kordinaattori) vaihe 3 -tehtävää; ei ajettavaa |
| T-81 (POST /api/uusi, toiminnot/uusi.mjs; kopio toiminnot.mjs `uusi`, `avaaIstunto`, `uusiAgy`; käyttää aja.mjs:n yhteistä lukkoa `yksiToiminto(ymp, 'uusi', nimi, f)`; aja.mjs on T-81:n must-not) | avoin (heti ajettava, Sonnet) | seuraava paketti; briefi originin kärjestä. |
| T-85 (Android-ohjaus, android.mjs) ∥ T-86 (palvelin, linux.mjs) | avoin (T-79-G ja T-65 valmiit; T-85:n briefin tarkistus 9f:llä) | kytkee myös ymp.android (chatin Gemini, T-69) ja laiteolion; ymp.adb on jo kytketty (6ac8d4a7). |
| ymp.paikalliset (purkajalista, T-68) oletuksena tyhjä: LM Studio -mallit purkajalistaan vaativat agentit.mjs-kytkennän | avoin | ehdotus pieneksi jatkoksi koordinaattorille. |
| T-84 (ydin, ei adapteri): lahde/asetukset-laji ytimeen | avoin | siihen asti adapterin lokissa "lahde asetukset hylättiin: HTTP 400" joka kierros. |
| Päällekkäiset vakiokopiot (MALLIT, PAIKALLINEN: viestit-vakiot, agentit, chat) | avoin | kirjattu purkua varten (fe). |
| T-70 (hyväksyntä) | avoin | odottaa kaikkia ARK-16-tehtäviä. |
| V-637 → scopes2 (vika.sh, f3d98a1) | avoin | scopes2/kaynnista.sh muutettu tässä sessiossa (T-89 adapterin uudelleenkäynnistys, T-63-G SCOPES2_TOIMINNOT). |

## 21.10.2026 — scopes2 adapteri

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-06 adapteri: T-24-G (Opus) → T-29 → T-25 (odottaa ytimen T-23, T-35) → T-34 hyväksyntäajo tuotantolähteillä (valvoja itse, H-5 cron-rivi käyttäjän luvalla) | tehty 19.10.2026: T-24-G fce665eb, T-29 18487961+bb065bfb+b707b594, T-25 db3b3ae4+00bcc65f, T-37 5ad80920+29646bf3, T-34 ajo 4 vihreä 37edddb0 ja uusintavertailu 6ea06bfa (PEILI 3487/3487, SILTA 8/8, p50 11,9 ms); H-5 tehty bc47388a (käyttäjä rootina /etc/cron.d/scopes2, */5 `kaynnista.sh`; ajo 21.30 TERVEYS: 200); V2 käynnissä 8797. **19.10.2026:** T-34 lopullinen (6ea06bfa): PEILI 3487/3487, SILTA 8/8 (ydin 7, silta 1 = /api/agentit), p50 /api/skoopit 11,9 ms, 8787 200, VmHWM ydin 214 MiB / adapteri 304 MiB, data 2,6 GB; T-34:n punaisten ajojen syyt mittausriveillä (T-34 ajot 1–3, harjoitukset). **21.10.2026:** portit palvelimella 21.10.2026 (tarilla muutokset originin 4880929e päälle), kaikki exit 0, ei aita-/TUONTI-osumia: --itsetesti, T-68 69/69, T-67 58/58, T-66 42/42, T-65 (11 kopiota diffattu), T-63 22/22, T-82 40/40, T-69 48/48, T-80 50/50, T-83 48/48, T-25; aiemmin T-24 26/26, T-29 10/10, T-89; free -m avail 4,4–5,1 Gt ennen ajoja. **21.10.2026:** portit palvelimen /tmp-kloonissa (flock /tmp/scopes2-koeportti.lock, free -m ennen, klooni siivottu): T-29 vihreä (myös T-85:n korjauksen jälkeen); T-81, T-86, T-63, T-67, T-68, T-65, T-82, T-69, T-85 vihreitä. palvelimelta pääsee ssh:lla (BatchMode) ja se kloonaa GitHubista; T-81/T-86/T-85-portit eivät tarvitse ydintä (symlinkkiä ei tarvittu). | odottaa koordinaattorin (scopes kordinaattori) vaihe 3 -tehtävää; ei ajettavaa |
| T-84 (ydin, ei adapteri): lahde/asetukset-laji ytimeen | avoin (kuuluu skoopille scopes2 ydin, tulee ytimen T-57:n jälkeen); odottaa skooppia scopes2 ydin | adapteri odottaa; siihen asti adapterin lokissa "lahde asetukset hylättiin: HTTP 400" joka kierros. |
| T-70 (hyväksyntä) | avoin; odottaa käyttäjää | odottaa kaikkia ARK-16-tehtäviä; tuotantoajo, vaatii käyttäjän päätöksen; adapteri-sessio ei aloita. |
| V-637 → scopes2 (vika.sh, f3d98a1) | avoin | scopes2/kaynnista.sh muutettu tässä sessiossa (T-89 adapterin uudelleenkäynnistys, T-63-G SCOPES2_TOIMINNOT); jää omistajalle (fe 21.10.2026). |

## 21.10.2026 — scopes2 adapteri

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-70 — ARK-16:n hyväksyntäajo tuotannossa: pyydä ensin koordinaattorilta (fe) erillinen lupa (käyttäjän päätös), harjoitus t70-koe.sh on ajettu (e0f0b9ca; ydinkorjaus /api/agentit X-Lahde ensin) — polut: scopes2/adapteri/** — aloitus: /pura scopes2 adapteri

## 21.10.2026 — scopes2 adapteri

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: ei ajettavaa adapteri-sessiolla — T-88 (1)–(5) ja (7) vihreitä ja kuitattu (7ab36c0c); (6) lykätty käyttäjän päätöksellä 5736f24e ("android etäohjausta voidaan jättää myöhemmäksi ios ja mac äpeissä"), joten ARK-19:n hyväksyntä ei odota (6):tta adapterin osalta (sulun ratkaisee koordinaattori/overseer). Uusi tehtävä koordinaattorilta — polut: scopes2/adapteri/** — aloitus: /pura scopes2 adapteri

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-88 (ARK-19-hyväksyntäajo, valvoja) | kohta (5) VIHREÄ 21.10.2026 klo 17.30 palvelimen /tmp-kloonissa (b4c0ccd0, `vertailu/t88-koe.sh` + `t88-tarkista.mjs`, koeadapteri 18822, oma HOME, ydin-URL suljettuun 18829:ään, adb/ssh/ping/python3 mockeina): 9 android- ja 2 palvelin-toimintoa + liite vastasi 200 ja `kuiva`-kentällä (merkkijono = komento, jota ei ajettu; ei literaali `true` kuten vanhassa), mock-loki 0 kiellettyä (adb input/am start/push, ssh poweroff, python3/WoL), toimintoloki 9 riviä kaikki kuiva-merkittyjä, VmHWM 61 MiB, terveys 29 reittiä, 401 ilman avainta, tuotannon adapteri pid 7903 ja 8798 ennallaan; huomio: linux kaynnista -rivin kuiva-teksti toimintolokissa näyttää polun `<juuri>/scopes2/Infra/linux/…/herata-pc.py` (vastauksessa oikein `<juuri>/Infra/…`) — vain lokiteksti, ei ajettu | **21.10.2026 klo ~17.40 (overseer 05, käyttäjän "Sinä päätät", scopes/overseer/REKISTERI.md 5f1d29eb; vain luku):** (1) OK 29 reittiä, T-85/T-86-reitit mukana; (2) OK ydin 200 X-Lahde ydin = vanha, avainrakenne sama; (3) ui ja tuotokset OK (rungot samat), **ruutu FAIL**: 500 "JPEG-muunnos epäonnistui: PIL.UnidentifiedImageError" — täsmälleen sama virhe myös vanhassa 8787:ssä ja adapterissa 8798 suoraan, joten ei adapterin regressio; juurisyy: laitteessa on kaksi näyttöä (HWC display 1 = LG TV SSCR2), jolloin `adb exec-out screencap -p` kirjoittaa ennen PNG:tä 347 tavun `[Warning] Multiple displays were found…` -tekstin (PNG-allekirjoitus offsetissa 347) eikä PIL tunnista kuvaa; (4) OK palvelin ydin = vanha {"tila":"linux"}; (7) OK silta 8/8 (ydin 7, silta 0), 8787 terveys 200 ennen ja jälkeen, tuotannon git status -- scopes/ ennallaan; adapteria ei käynnistetty uudelleen, tuotantoon ei kirjoitettu. Skripti `vertailu/t88-tuotanto.mjs` (aecc3e07). | **21.10.2026 klo ~18.05 (overseer vei tuotantopuuhun vain vanhasta/android.mjs; adapteri käynnistetty uudelleen, cron pid 15313):** `vertailu/t88-tuotanto.mjs` kokonaan vihreä: (1) 29 reittiä, (2) OK, (3) ruutu 200 image/jpeg 11057 tavua JPEG-alku ffd8, ui ja tuotokset = vanha, (4) OK; (7) silta 8/8, 8787 terveys 200 ennen ja jälkeen, tuotannon git status -- scopes/ ennallaan. **T-88 jäljellä vain (6) Mac (T-59:n jälkeen).** **Korjattu 21.10.2026 (3198b79e):** koeadapteri 18822 oikealla laitteella ruutu 200 image/jpeg; tuotannon 7903 ajaa vielä vanhaa koodia, joten (3) ruutu tuotannossa vihreä vasta overseerin päättämän uudelleenkäynnistyksen jälkeen (uusinta: `vertailu/t88-tuotanto.mjs`). (Alkuperäinen suunta:) ruutu: korjaus (PNG-alkua edeltävien tavujen pois tai `screencap -p -d <näytön id>`) kuuluu `vanhasta/android.mjs`-kopioon (T-65-kopio, erota vanhasta tietoisesti) ja vanhaan 8787:ään (scopes); käyttöönotto vaatii adapterin uudelleenkäynnistyksen, joten koordinaattori päättää. (6): Mac, T-59:n jälkeen. **21.10.2026 klo ~18.30: (6) LYKÄTTY käyttäjän päätöksellä 5736f24e** ("android etäohjausta voidaan jättää myöhemmäksi ios ja mac äpeissä"; overseer 9f pysäytti ajon). Valmisteltu ja pushattu mutta ei suoritettu loppuun: `vertailu/t88-valitys.mjs`, `t88-koe-palvelu.sh`, `t88-mac.sh` (bf64c0a1, 8b157dc1) ja `shared/gate.sh`:n GATE_OHJAUS_MOCK/GATE_OHJAUS_LISA-koukku (shared-omistajalle tiedoksi). Havainnot: gate T-87:n macOS OhjausUITests kulki oikean koeadapterin kautta (ruutu, palvelin tila ja sammuta, nappi, napauta; välittäjän todiste) ja gate eteni iOS-vaiheeseen; iOS-vaihe kaatui kahdesti simulaattorin valintaan (`iPhone 17 Pro` OS:latest ei löydy; GATE_SIMIT="iPhone 15 Pro" -ajo keskeytettiin). Siivottu: tunneli, koeadapteri ja palvelimen /tmp-hakemistot pois, Mac-koeydin 96091 kuollut, worktree poistettu. Jatko: `GATE_SIMIT="iPhone 15 Pro" bash scopes2/adapteri/vertailu/t88-mac.sh` committoidusta worktreestä, kun Android-osa otetaan työn alle. |
| T-70 (hyväksyntä) | tehty 21.10.2026: kohdat 1–7 ja H-18 OK (tuotannossa, aita puhdas); poikkeamat A → T-95 ja B → V-639 käsitelty; cron.d-rivi todennettu 21.10.2026 klo 16.55: `/etc/cron.d/scopes2` sisältää SCOPES2_TOIMINNOT=8798 ja cronin ajama kaynnista.sh sai sen (`CRON-AJO pid 5345 16:55:01 SCOPES2_TOIMINNOT=8798`, tarkista-skripti exit 0); odottaa fe:n/overseerin kuittausta | ei ajettavaa adapteri-sessiolla; fe/overseer kuittaa T-70:n hyväksytyksi. |
| Tuotantopuu ~/palvelin: 43 commitia originin takana, 4 siirto-commitia edellä; työpuussa scopes2/adapteri/{ARKISTO,HISTORIA,REKISTERI}.md, gate.sh, adapteri.mjs, chat.test.mjs, scopes2/kaynnista.sh (= 7c9bda9d) ja lisäämättömät vertailu/t70-koe.sh, t70-tarkista.mjs; tuotanto ajaa tästä puusta (cron /srv/work) | avoin | pull/merge päätettävä erikseen |

### Viat — poistettu tai muutettu

| Vika | Tila |
|---|---|
| T-88 (3) ruutu: `GET /api/android/ruutu` 500 "JPEG-muunnos epäonnistui" tuotannossa (ydin, adapteri ja vanha 8787 samoin), koska laitteen toinen näyttö (LG TV SSCR2) saa `adb exec-out screencap -p` -tulosteen alkuun 347 tavun varoitustekstin ennen PNG-allekirjoitusta (21.10.2026, todettu `adb`-tulosteen tavuista). Vanhassa palvelussa sama vika, joten ei adapterin regressio; ruudun katselu puhelimen ohjauksessa ei toimi tällä hetkellä. Korjausvaihtoehdot: poista PNG-allekirjoitusta edeltävät tavut (`\x89PNG`-haku) tai anna `-d <id>` (`dumpsys SurfaceFlinger --display-id`). | korjattu 3198b79e, tuotannossa 21.10.2026 klo ~18.05 todennettu (ruutu 200 image/jpeg) (pngAlusta, T-65:n sallittu ero `vanhasta/android.mjs.ero`; gate T-65 ja T-85 vihreät /tmp-kloonissa; koeadapteri 18822 oikeaa laitetta vasten: ruutu 200 image/jpeg 4307 tavua, PIL avaa 360x640); **tuotannossa vasta kun overseer käynnistää adapterin 7903 uudelleen** (ei tehdä ilman overseerin ilmoitusta); vanhan 8787:n sama vika reititetään scopesin omistajalle (koordinaattori 20) |

## 21.10.2026 — scopes2 adapteri

### Viat — poistettu tai muutettu

| Vika | Tila |
|---|---|
| Pieni korjaus (T-88 (5), 21.10.2026, koordinaattori 20 kuittasi): `toiminnot/linux.mjs` korvaa `kuiva`-tekstissä `HERATA`-polun vasta vastaukseen, mutta `vanhasta/palvelin.mjs` kirjaa toimintolokiin ensin: loki näyttää `<juuri>/scopes2/Infra/linux/palvelin/herata-pc.py` (HERATA lasketaan `vanhasta/`-syvyydestä), vastaus oikean `<juuri>/Infra/…`. Vain kuivatilan lokiteksti; ei ajettu komento, ei estä T-88:aa. Korjaus: välitä `herata`-polku `luoLinuxServer`ille tai korvaa lokirivin kuiva-teksti samoin; gate T-86. | korjattu 21.10.2026 (T-98): linux.mjs kirjaa toimintolokiin suoraan korjatun kuiva-tekstin (loki: null luoLinuxServerille); gate T-86 ja T-65 vihreät |

## 28.10.2026 — scopes2 adapteri

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: ei mitään — kysytty 21.10.2026: käyttäjä valitsi pakkaa vain (tuotantopuun synkkaa ei valittu; T-90 ja ARK-11a odottavat käyttäjää/overseeria)

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-16-katselmointi 28.10.2026 (Opus): löydökset | avoin; korjaukset odottavat koordinaattorin tehtävää | **KORKEA** kaynnista.sh:199-239 täyskäynnistys ei pysäytä `pidit`-tiedoston vanhaa adapteria (ydin kuollut/kaatuu → jokainen cron-ajo jättää orvon adapterin, 8798 vanhalla koodilla; ei flockia). **KESKI** toiminnot/chat.mjs:151,300 kutsuu `android()` funktiona, adapteri.mjs:179 antaa olion → POST /api/chat android/gemini 500 "android is not a function" (testi mockaa funktiona; Android lykätty). **KESKI** T-83 lahde.mjs:202-209 asetukset-peilin avoimet istunnot vain Claude-transkripteista (vanha istunnot() sisältää agy:n) → agy-skoopin GET istunto null, POST hyväksyy. **KESKI** T-67 istunto.mjs:159-175 puraJono: await skoopinIstunnot ennen lukkoa, ei uudelleentarkistusta `jono.get(avain)===j` → vanhentunut /sa tai tupla /automaattisiirto. **KESKI** T-67 `jonossa` (istunto.mjs:235) ei käytössä: ydin ottaa jonossa sillasta (8787) → adapterin jono ei näy äpissä (omistajapäätös: adapteri vai ydin). Matalat: lahdeKierros ohittaa kaynnissa-vartijan (lahde.mjs:246); uusi.test ei testaa uusi↔pura/pakkaa-lukkoa; gate T-65 ei aja T-24/T-29-testejä (brief Do 6); toimintoreitit eivät saa --projektit/--istunnot/--agy/--brain-polkuja (adapteri.mjs:178); palvelin.mjs:49 rikkinäinen %-koodaus 400 vs vanha 500; t70-koe.sh:36/46 adapterille ei --chat (chat-vertailu tyhjä); t88-koe-palvelu.sh:28-30 orpo koeadapteri terveysvirheessä; kaynnista.sh:88-91 --sammuta ilman cmdline-tarkistusta (T-25). |
| T-29 ja T-83 punaisia originin kärjessä: claude/siirto/tools/asetus-tila.mjs (47b8ccaf, 27.10, scopes siirto agymacos) lisäsi asetuksen `automaattisiirto` → S-5b asetukset-lajin sisältö muuttuu (lahde.test 1, asetukset-fixturet 4 punaisia) | avoin; odottaa päätöstä (toteutussuunnitelma/arkkitehtuuri: S-5b laajennetaan vai adapteri suodattaa) | portit 28.10.2026 /tmp-kloonissa: --itsetesti, T-24, T-63, T-65, T-66–T-69, T-95, T-79–T-82, T-85, T-86, T-89, T-25, T-92, T-94 vihreitä (GATE_SOLMU = julkaisu 7da86808); T-29 ja T-83 punaisia vain tästä syystä. |
| Vanha scopes/palvelu muuttui 26.–27.10.2026 kopioiden jälkeen (toiminnot.mjs, viestit.mjs, palvelin.mjs, agy-kayttoraja.mjs, toiminnot-asetukset.mjs: agy pura C-c/kill-window, --autojatko, scp, agy infra-perheelle, vaihdaMalli agy, AGY_MALLIT, automaattisiirto, sulje, Mac AGY -kayttoraja) | avoin (tiedoksi; T-65 TIEDOKSI-rivit) | kopioiden synkka uuteen V1:een on oma tehtävä (muuttaa V2-sopimusta); odottaa toteutussuunnitelmaa. |

### Viat — poistettu tai muutettu

| Vika | Tila |
|---|---|
| a85e3c0b (27.10.2026, tekijäskooppi ei trailerissa; samaan aikaan scopes ios/macos-commitit) muutti adapterin `vanhasta/agy-istunto.mjs`-kopiota suoraan ilman .ero-tiedostoa → TUONTI-sallittu rivi 446 siirtyi, kaikki portit punaisia (Sääntö 15). | korjattu 28.10.2026: kopio synkattu 47b8ccaf:iin, sallittu rivi 470. |

### Viat — valmis

| Vika | Tila |
|---|---|
| a85e3c0b (27.10.2026, tekijäskooppi ei trailerissa; samaan aikaan scopes ios/macos-commitit) muutti adapterin `vanhasta/agy-istunto.mjs`-kopiota suoraan ilman .ero-tiedostoa → TUONTI-sallittu rivi 446 siirtyi, kaikki portit punaisia (Sääntö 15). | korjattu 4eab1ff5 28.10.2026 (kopio synkattu 47b8ccaf:iin, sallittu rivi 470) |

## 28.10.2026 — scopes2 adapteri

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: ei mitään — odottaa käyttäjää: Tuotannon adapterin käynnistys ja T-90 + ARK-11a (käyttäjä/overseer päättää); Tuotantopuu ~/palvelin pull/merge (käyttäjä päättää). SCOPES2-PALUU-1735 tehty 28.10.2026 (4eab1ff5); ARK-16-löydösten korjaukset odottavat koordinaattoria

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-16-katselmointi 28.10.2026 (Opus): löydökset | avoin; odottaa skooppia scopes kordinaattori (korjaustehtävä) | odottaa koordinaattoria (korjaustehtävä): **KORKEA** kaynnista.sh:199-239 täyskäynnistys ei pysäytä `pidit`-tiedoston vanhaa adapteria (ydin kuollut/kaatuu → jokainen cron-ajo jättää orvon adapterin, 8798 vanhalla koodilla; ei flockia). **KESKI** toiminnot/chat.mjs:151,300 kutsuu `android()` funktiona, adapteri.mjs:179 antaa olion → POST /api/chat android/gemini 500 "android is not a function" (testi mockaa funktiona; Android lykätty). **KESKI** T-83 lahde.mjs:202-209 asetukset-peilin avoimet istunnot vain Claude-transkripteista (vanha istunnot() sisältää agy:n) → agy-skoopin GET istunto null, POST hyväksyy. **KESKI** T-67 istunto.mjs:159-175 puraJono: await skoopinIstunnot ennen lukkoa, ei uudelleentarkistusta `jono.get(avain)===j` → vanhentunut /sa tai tupla /automaattisiirto. **KESKI** T-67 `jonossa` (istunto.mjs:235) ei käytössä: ydin ottaa jonossa sillasta (8787) → adapterin jono ei näy äpissä (omistajapäätös: adapteri vai ydin). Matalat: lahdeKierros ohittaa kaynnissa-vartijan (lahde.mjs:246); uusi.test ei testaa uusi↔pura/pakkaa-lukkoa; gate T-65 ei aja T-24/T-29-testejä (brief Do 6); toimintoreitit eivät saa --projektit/--istunnot/--agy/--brain-polkuja (adapteri.mjs:178); palvelin.mjs:49 rikkinäinen %-koodaus 400 vs vanha 500; t70-koe.sh:36/46 adapterille ei --chat (chat-vertailu tyhjä); t88-koe-palvelu.sh:28-30 orpo koeadapteri terveysvirheessä; kaynnista.sh:88-91 --sammuta ilman cmdline-tarkistusta (T-25). |
| T-29 ja T-83 punaisia originin kärjessä: claude/siirto/tools/asetus-tila.mjs (47b8ccaf, 27.10, scopes siirto agymacos) lisäsi asetuksen `automaattisiirto` → S-5b asetukset-lajin sisältö muuttuu (lahde.test 1, asetukset-fixturet 4 punaisia) | avoin; odottaa päätöstä (toteutussuunnitelma/arkkitehtuuri: S-5b laajennetaan vai adapteri suodattaa) | odottaa toteutussuunnitelmaa (koordinaattorin kautta); portit 28.10.2026 /tmp-kloonissa: --itsetesti, T-24, T-63, T-65, T-66–T-69, T-95, T-79–T-82, T-85, T-86, T-89, T-25, T-92, T-94 vihreitä (GATE_SOLMU = julkaisu 7da86808); T-29 ja T-83 punaisia vain tästä syystä. |
| Vanha scopes/palvelu muuttui 26.–27.10.2026 kopioiden jälkeen (toiminnot.mjs, viestit.mjs, palvelin.mjs, agy-kayttoraja.mjs, toiminnot-asetukset.mjs: agy pura C-c/kill-window, --autojatko, scp, agy infra-perheelle, vaihdaMalli agy, AGY_MALLIT, automaattisiirto, sulje, Mac AGY -kayttoraja) | avoin; odottaa skooppia scopes toteutussuunnitelma (tiedoksi; T-65 TIEDOKSI-rivit) | odottaa toteutussuunnitelmaa: kopioiden synkka uuteen V1:een on oma tehtävä (muuttaa V2-sopimusta); odottaa toteutussuunnitelmaa. |

## 28.10.2026 — scopes2 adapteri

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-104 — S-5b automaattisiirto (brief scopes/toteutussuunnitelma/briefit/T-104.md, valvojan päätös: ASETUKSET-rivi + kopiorivi @ 47b8ccaf + vanhasta/toiminnot-asetukset.mjs.ero), sitten T-105, T-106, T-107, T-111 (T-109 T-108:n jälkeen) — polut: scopes2/adapteri/**, scopes2/kaynnista.sh — aloitus: worktree ~/sessions-repo-ark16, toteuttaja Sonnet, portit palvelimen /tmp-kloonissa flockin alla, raportit koordinaattorille sessions-repo-c2 — automaattinen: kyllä

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| ARK-16-katselmointi 28.10.2026 (Opus): löydökset | kesken; korjaukset briefattu 038c6589 (T-103…T-111); T-103 korjattu f221b910 28.10.2026 (KORKEA: täyskäynnistys pysäyttää vanhan adapterin, flock-lukko, --sammuta tarkistaa komentorivin; portit T-103, T-25, T-89, T-92, T-94 EXIT=0 /tmp-kloonissa, GATE_SOLMU 7da86808); T-110 korjattu abd8a50b (V1-SYNKKA.md); T-104 aloitettu, ei koodimuutoksia | seuraava: T-104 valvojan päätöksellä, sitten T-105, T-106, T-107; T-109 odottaa scopes2 ytimen T-108:aa; lopuksi T-111. Jäljellä: **KESKI** toiminnot/chat.mjs:151,300 kutsuu `android()` funktiona, adapteri.mjs:179 antaa olion → POST /api/chat android/gemini 500. **KESKI** T-83 lahde.mjs:202-209 asetukset-peilin avoimet istunnot vain Claude-transkripteista → agy-skoopin GET istunto null, POST hyväksyy. **KESKI** T-67 istunto.mjs:159-175 puraJono: await ennen lukkoa, ei uudelleentarkistusta `jono.get(avain)===j`. **KESKI** T-67 `jonossa` (istunto.mjs:235) ei käytössä: ydin ottaa jonossa sillasta (8787) → omistajapäätös. Matalat: lahdeKierros ohittaa kaynnissa-vartijan (lahde.mjs:246); uusi.test ei testaa uusi↔pura/pakkaa-lukkoa; gate T-65 ei aja T-24/T-29-testejä; toimintoreitit eivät saa --projektit/--istunnot/--agy/--brain-polkuja (adapteri.mjs:178); palvelin.mjs:49 %-koodaus 400 vs vanha 500; t70-koe.sh:36/46 adapterille ei --chat; t88-koe-palvelu.sh:28-30 orpo koeadapteri terveysvirheessä. |
| T-29 ja T-83 punaisia originin kärjessä: claude/siirto/tools/asetus-tila.mjs (47b8ccaf, 27.10, scopes siirto agymacos) lisäsi asetuksen `automaattisiirto` → S-5b asetukset-lajin sisältö muuttuu (lahde.test 1, asetukset-fixturet 4 punaisia) | kesken; päätetty 28.10.2026 (toteutussuunnitelma: S-5b laajennetaan, ei suodatusta; onMac-kenttää ei lisätä); korjaus T-104:ssä | seuraava: T-104: kopioon vain ASETUKSET-rivi automaattisiirto ja kopiorivi @ 47b8ccaf + uusi vanhasta/toiminnot-asetukset.mjs.ero (ssh dev-host -lohko, V1 rivit 48–50, ei tuoda; may-lista laajenee yhdellä tiedostolla). Syy, miksi briefin "osakopio @ C" ei toimi: V1 toiminnot-asetukset.mjs (47b8ccaf) eroaa avaimen lisäksi spawnSync-importilla ja ssh dev-host -lohkolla; gate.sh:n osakopiohaara (:481-497) ei ohita import-rivejä, ja tavallinen kopio sallii eron vain <nimi>.ero-tiedostolla (:500-512, T-88-malli). Portit 28.10.2026 vihreitä paitsi T-29 ja T-83. |

### Avoimet asiat — valmis

| Asia | Tila | Seuraava askel |
|---|---|---|
| T-29 ja T-83 punaisia originin kärjessä: claude/siirto/tools/asetus-tila.mjs (47b8ccaf, 27.10, scopes siirto agymacos) lisäsi asetuksen `automaattisiirto` → S-5b asetukset-lajin sisältö muuttuu (lahde.test 1, asetukset-fixturet 4 punaisia) | valmis 28.10.2026 (korjattu 8b847c97; portit T-29, T-83, T-65, T-25 EXIT=0 palvelimen /tmp-kloonissa) | —  |

## 28.10.2026 — scopes2 adapteri

### (alku) — poistettu tai muutettu

SEURAAVA PAKETTI: T-106 — asetukset-peili sisältää agy-istunnot kuten vanha istunto-asetukset (brief scopes/toteutussuunnitelma/briefit/T-106.md), sitten T-107, T-111 (T-109 T-108:n jälkeen) — polut: scopes2/adapteri/**, scopes2/kaynnista.sh — aloitus: worktree ~/sessions-repo-ark16 (haara adapteri/ark16-korjaukset, e6cb4a6e), toteuttaja Sonnet, portit palvelimen /tmp-kloonissa flockin alla (klooni ssh-aliaksella github-claude-project, ei varakloonia), raportit koordinaattorille sessions-repo-c2 — automaattinen: kyllä

### Avoimet asiat — poistettu tai muutettu

| Asia | Tila | Seuraava askel |
|---|---|---|
| lahde.kierros()-kierroslukko puuttuu (kaksi kutsua voi lähettää saman sisällön kahdesti) | avoin | pieni; `--agy-luvat` kaynnista.sh:ssa vanhan alasajossa; Mac-agy-fixture puuttuu (~-polku, käsin testattu). |
| ARK-16-katselmointi 28.10.2026 (Opus): löydökset | kesken; korjaukset briefattu 038c6589 (T-103…T-111); T-103 korjattu f221b910, T-104 korjattu 8b847c97 ja T-105 korjattu e6cb4a6e 28.10.2026 (portit T-29, T-83, T-65, T-25 ja T-69, T-95, T-85 EXIT=0 palvelimen /tmp-kloonissa); T-110 korjattu abd8a50b (V1-SYNKKA.md) | seuraava: T-106, sitten T-107; T-109 odottaa scopes2 ytimen T-108:aa; lopuksi T-111. Jäljellä: **KESKI** T-83 lahde.mjs:202-209 asetukset-peilin avoimet istunnot vain Claude-transkripteista → agy-skoopin GET istunto null, POST hyväksyy (T-106). **KESKI** T-67 istunto.mjs:159-175 puraJono: await ennen lukkoa, ei uudelleentarkistusta `jono.get(avain)===j`. **KESKI** T-67 `jonossa` (istunto.mjs:235) ei käytössä: ydin ottaa jonossa sillasta (8787) → omistajapäätös. Matalat: lahdeKierros ohittaa kaynnissa-vartijan (lahde.mjs:246); uusi.test ei testaa uusi↔pura/pakkaa-lukkoa; gate T-65 ei aja T-24/T-29-testejä; toimintoreitit eivät saa --projektit/--istunnot/--agy/--brain-polkuja (adapteri.mjs:178); palvelin.mjs:49 %-koodaus 400 vs vanha 500; t70-koe.sh:36/46 adapterille ei --chat; t88-koe-palvelu.sh:28-30 orpo koeadapteri terveysvirheessä. |
