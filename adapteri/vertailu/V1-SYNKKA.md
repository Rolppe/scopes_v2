# V1-SYNKKA: scopes/palvelu-muutokset adapterin kopioita vasten (T-110, vain raportti)

Laadittu 28.10.2026 (T-110, adapteri). Työpuu HEAD 6c6574e6. Ei koodimuutosta. Luokat: **A** olemassa olevan S-5b/S-10-reitin tai -lajin käytös (synkataan), **B** uusi reitti, kenttä tai laji (sopimusmuutos, toteutussuunnitelma/arkkitehtuuri päättää), **C** ei adapterin käytössä (ei synkata).

Menetelmä: `git diff <kopiocommit> HEAD -- scopes/palvelu/<tiedosto>` kullekin `vanhasta/`-kopiolle (kopiorivin `@ <commit>`); `toiminnot/*.mjs`-sisäkopioilla (`// kopio: scopes/palvelu/<f>:<a-b> (21.10.2026)`) ei ole commitia, joten vertailupohjana on 507a61f1 (viimeisin kopioiden perustana käytetty, sama kuin viestit-vakiot) ja rivinumerot ovat vanhan tiedoston (507a61f1) rivejä. Yhden poikkeaman huomasin: `toiminnot/asetukset.mjs:58` ja `:89` kopiokommentin `palvelin.mjs:206-208/214-218` ovat 507a61f1:ssä todellisuudessa rivit ~211-212 ja ~214-219 (kommentin rivit viiden rivin päässä); sisältö on silti ennallaan.

V1-muutoskommitit 21.10. jälkeen (kopioihin vaikuttavat): ef58a316 (infra-perhe), 819d992e (mallinhallinta, sulje, ?avain, /api/mallit, ipa), c78dc60f (Mac/Linux AGY erotus, kayttoraja-Mac), 74155e4b (AGY-mallit, vaihdaMalli agy), aec8a09e (agy-sulku), 53099400 (agy-kayttoraja kiintiöviikko), 47b00af4 (terminal), 47b8ccaf (automaattisiirto, autojatko, asetukset-ssh, agy-kayttoraja), economy-sarja 7146a9b6…e17d1e39.

## Yhteenveto

| Tiedosto | A | B | C | Huomio |
|---|---|---|---|---|
| vanhasta/agy-kayttoraja.mjs | 2 | 2 | 1 | f5fc3d36 -> HEAD, +78/-2 |
| vanhasta/toiminnot-asetukset.mjs | 1 | 1 | 0 | 507a61f1 -> HEAD, +5 |
| vanhasta/agy-istunto.mjs | 0 | 0 | 0 | ennallaan 47b8ccaf:n jälkeen (kopio on jo uudelleensynkattu; sisältää kuitenkin B-kohdan, ks. alla) |
| vanhasta/{agy-luvat, android, istunto-asetukset, kayttoraja, lahteet, liitteet, palvelin, purkajat, viestit-vakiot} | 0 | 0 | 0 | ennallaan |
| toiminnot/agentit.mjs | 1 | 0 | 0 | AGY_MALLIT |
| toiminnot/chat.mjs | 1 | 0 | 0 | AGY_MALLIT |
| toiminnot/malli.mjs | 4 | 0 | 0 | vaihdaMalli |
| toiminnot/istunto.mjs | 0 | 2 | 0 | automaattisiirto-vahti, sulje |
| toiminnot/pura.mjs | 6 | 0 | 0 | puraMallitta, pura |
| toiminnot/uusi.mjs | 1 | 0 | 0 | uusiAgy infra |
| toiminnot/{viestit, asetukset, aja, android, linux}.mjs | 0 | 0 | 0 | kopioidut rivialueet ennallaan |
| Yhteensä kopioissa | 16 | 6 (+1 agy-istunto) | 1 | |

Kopioiden ulkopuoliset V1-muutokset (luku 3): B 20 taulukkoriviä (reittiä/kenttää), C yksi ryhmä (sisäinen kytkentä). Yhdelläkään B-reitillä ei ole S-10-vastinetta.

### Arvio synkkatehtävien jaosta (3 briefiä + 1 odottaa päätöstä; ei agy:lle)

1. **Pura/uusi/malli (A, 12 kohtaa, ei sopimusmuutosta)**: toiminnot/pura.mjs (6), uusi.mjs (1), malli.mjs (4), agentit.mjs + chat.mjs AGY_MALLIT (2). Yksi brief, vain `toiminnot/`-kopioiden käytös; pura-kohdat nojaavat `claude/siirto/tools/pura-malliton.mjs`:n `--autojatko`-tukeen (ajettava työkalu, ei kopio; tarkista että se on jo origin-päässä).
2. **Lähteen synkka: agy-kayttoraja + toiminnot-asetukset (A 3, B 3)**: vanhasta/agy-kayttoraja.mjs ja toiminnot-asetukset.mjs uudelleenkopiointi (T-65-sääntö: tavulleen paitsi kopiorivi ja importit). Edellyttää ensin päätöstä B-kohdista: asetukset-lajin uusi avain `automaattisiirto` (sama asia kuin REKISTERI-rivi lahde.test/T-83 punaiset) ja kayttoraja-lajin laajennus (`macAgy`, `otsikko`, `ymparisto`). Agy-kayttorajan import `./toiminnot.mjs` (C) rikkoo kopion riippumattomuuden (ks. 2.1).
3. **Istunto: sulje + automaattisiirto-vahti (B 2)**: toiminnot/istunto.mjs; uusi reitti `POST /api/skoopit/*/sulje` ja taustavahti (kaynnista-koukku, kytkin automaattisiirto + kontekstiraja 120 k). Vaatii S-10-laajennuspäätöksen.
4. **Odottaa arkkitehtuuria (ei briefiä ennen päätöstä)**: terminal (PTY/WebSocket), economy (7 GET), `/api/mallit`, `/api/kayttorajat-kaikki`, `?avain=`-kysely, `/api/ios/ipa`, DELETE (luku 3).

## 1. Kopiorivit ja luokat

### 1.1 vanhasta/*.mjs (rivi 1 = kopiorivi)

| Kopio:rivi | Lähde | Kopiocommit | Ero | Luokka |
|---|---|---|---|---|
| vanhasta/agy-istunto.mjs:1 | agy-istunto.mjs | 47b8ccaf (28.10.) | ennallaan (HEAD:ssä sama) | ennallaan |
| vanhasta/agy-kayttoraja.mjs:1 | agy-kayttoraja.mjs | f5fc3d36 | 5 hunkkia, ks. 2.1 | A2 B2 C1 |
| vanhasta/agy-luvat.mjs:1 | agy-luvat.mjs | f5fc3d36 | ennallaan | ennallaan |
| vanhasta/android.mjs:1 | android.mjs | e83f1152 | ennallaan (kopion oma .ero ennallaan) | ennallaan |
| vanhasta/istunto-asetukset.mjs:1 | istunto-asetukset.mjs | 76760840 | ennallaan | ennallaan |
| vanhasta/kayttoraja.mjs:1 | kayttoraja.mjs | 977b5f45 | ennallaan (vain kayttoraja.test.mjs muuttui) | ennallaan |
| vanhasta/lahteet.mjs:1 | lahteet.mjs | 507a61f1 | ennallaan | ennallaan |
| vanhasta/liitteet.mjs:1 | liitteet.mjs | 6338a63f | ennallaan | ennallaan |
| vanhasta/palvelin.mjs:1 | palvelin.mjs | e1d1ad03 | ennallaan | ennallaan |
| vanhasta/purkajat.mjs:1 | purkajat.mjs | 507a61f1 | ennallaan | ennallaan |
| vanhasta/toiminnot-asetukset.mjs:1 | toiminnot-asetukset.mjs | 507a61f1 | 3 hunkkia, ks. 2.2 | A1 B1 |
| vanhasta/viestit-vakiot.mjs:1 | viestit.mjs:26-31,103 | 507a61f1 | rivit 26-31 (MALLIT) ja 103 (PAIKALLINEN) ennallaan; viereinen AGY_MALLIT muuttui mutta ei osakopiossa | ennallaan |

### 1.2 toiminnot/*.mjs sisäkopiot (pohja 507a61f1; "e" = ennallaan)

| Kopio:rivi | Lähde (vanha rivialue) | Luokka |
|---|---|---|
| agentit.mjs:15 | viestit.mjs:18-31 (AGY_MALLIT) | **A** (2.3) |
| agentit.mjs:31 | viestit.mjs:36-40 | e |
| agentit.mjs:38 | viestit.mjs:61-62 | e |
| agentit.mjs:42 | viestit.mjs:99-107 | e |
| agentit.mjs:50 | viestit.mjs:114-139 | e |
| agentit.mjs:81 | viestit.mjs:424-435 | e |
| viestit.mjs:16 | viestit.mjs:44 | e |
| viestit.mjs:19 | viestit.mjs:141-236 | e |
| viestit.mjs:135 | viestit.mjs:248-258 | e |
| viestit.mjs:148 | viestit.mjs:260-394 | e |
| viestit.mjs:285 | viestit.mjs:396-416 | e |
| viestit.mjs:309 | viestit.mjs:758-805 | e (V1 lisäsi onkoMacAgy rivin 757/758 väliin, ei kopioidulla alueella) |
| viestit.mjs:359 | viestit.mjs:807-827 | e |
| viestit.mjs:382 | viestit.mjs:899-935 | e |
| viestit.mjs:424 | palvelin.mjs:248-261 | e |
| aja.mjs:6 | toiminnot.mjs:32-73 | e |
| asetukset.mjs:58 | palvelin.mjs:206-208 (todell. ~211-212) | e (avainlista tulee toiminnot-asetukset.mjs:stä, ks. 2.2 B) |
| asetukset.mjs:89 | palvelin.mjs:214-218 | e |
| istunto.mjs:22 | toiminnot.mjs:75-77 | e |
| istunto.mjs:31 | toiminnot.mjs:83-86 | e |
| istunto.mjs:58 | toiminnot.mjs:96-113 | e |
| istunto.mjs:79 | toiminnot.mjs:115-118 | e |
| istunto.mjs:82 | toiminnot.mjs:120-121 | e |
| istunto.mjs:86 | toiminnot.mjs:123-134 | e |
| istunto.mjs:100 | toiminnot.mjs:148-154 | e |
| istunto.mjs:109 | toiminnot.mjs:156-199 | **B** (2.4: `istuntoon(..., haluttuIstunto)` rivit 158/162/176) |
| istunto.mjs:155 | toiminnot.mjs:201-236 | **B** (2.4: puraJonon loppu kutsuu tarkistaAutomaattisiirto, rivi 235) |
| istunto.mjs:195 | toiminnot.mjs:301-304 | e (sulje lisätty heti perään, ks. 2.4) |
| istunto.mjs:203 | toiminnot.mjs:340-354 | e |
| istunto.mjs:233 | toiminnot.mjs:355-356 | e |
| istunto.mjs:238 | palvelin.mjs:275-276 | **B** (2.4: reittiregex + sulje) |
| android.mjs:25 | palvelin.mjs:196-200 | e |
| android.mjs:36 / :41 / :46 / :51 | palvelin.mjs:300 / 301 / 302 / 303 | e |
| android.mjs:56 | palvelin.mjs:223 | e |
| android.mjs:65 | palvelin.mjs:224-225 | e |
| malli.mjs:17 | viestit.mjs:26-31 | e |
| malli.mjs:24 | viestit.mjs:45-46 | e |
| malli.mjs:42 | viestit.mjs:396-416 | e |
| malli.mjs:66 | viestit.mjs:829-897 (vaihdaMalli) | **A** (2.5) |
| malli.mjs:140 | palvelin.mjs:262-263 | e |
| chat.mjs:22 | viestit.mjs:18-43 | **A** (2.3) |
| chat.mjs:50 | viestit.mjs:61-139 | e |
| chat.mjs:131 | viestit.mjs:141-142 | e |
| chat.mjs:136 | palvelin.mjs:155 | e |
| chat.mjs:162 | viestit.mjs:418-568 | e |
| chat.mjs:315 | viestit.mjs:573-686 | e |
| chat.mjs:434 | palvelin.mjs:148-189 | e |
| chat.mjs:476 | palvelin.mjs:244-247, 321-325 | e |
| pura.mjs:56 | toiminnot.mjs:120-121 | e |
| pura.mjs:60 | toiminnot.mjs:123-146 | e |
| pura.mjs:86 | toiminnot.mjs:238-254 (puraMallitta) | **A** (2.6) |
| pura.mjs:105 | toiminnot.mjs:275-300 (pura) | **A** (2.6) |
| pura.mjs:137 | palvelin.mjs:272-274, 297 | e |
| uusi.mjs:17 | toiminnot.mjs:136-146 | e |
| uusi.mjs:30 | toiminnot.mjs:256-272 (uusiAgy) | **A** (2.7) |
| uusi.mjs:49 | toiminnot.mjs:305-314 | e |
| uusi.mjs:65 | palvelin.mjs:227 | e |
| linux.mjs:54 | palvelin.mjs:220-221, 298 | e |

Vanhan viitteet otsikkokommenteissa (viestit.mjs:1, istunto.mjs:2, pura.mjs:1, malli.mjs:2, android.mjs:2, linux.mjs:2, asetukset.mjs:2, agentit.mjs:1, chat.mjs:3, uusi.mjs:1, aja.mjs:52) ovat samoja alueita kuin yllä; ei omaa riviluokkaa.

## 2. Erot ja luokitukset

### 2.1 vanhasta/agy-kayttoraja.mjs (f5fc3d36 -> HEAD; kuluttaja: lahde.mjs:16,184-196 kayttoraja-laji)
- A: `laskePyyntomaara` laskee `step.type === 'USER_INPUT'` eikä MODEL/PLANNER_RESPONSE (kopion `:79`; V1 47b8ccaf). Muuttaa `kayttoraja.agy.viikko.kaytto`-arvoa olemassa olevassa lajissa.
- A: viikon `nollautuu` otetaan `kohde.kiintioViikko ?? kohde.viikko ?? p.nollautuu` (`:164-167`; V1 53099400). Sama laji, sama kenttä, uusi arvolähde.
- B: palautusolioon uudet kentät `otsikko: 'OnePlus Linux AGY'`, `ymparisto: 'oneplus'` (V1 c78dc60f). Uusia kenttiä S-5b kayttoraja-lajissa.
- B: uusi `luoMacAgyKayttoraja` + `MAC_TILA_TIEDOSTO`/`MAC_BRAIN_DIR` (V1 c78dc60f; ssh `mac`, Mac-polut). Uusi lähde, jota lahde.mjs ei lähetä (`{claude, agy}` -> tarvitaisi `macAgy`).
- C: `import { ajaKomento } from './toiminnot.mjs'` (V1 c78dc60f). Kopio ei saa tuoda `toiminnot.mjs`:ää (gate.sh tuontitarkistus, T-65 rajaa vain import-rivit eron ulkopuolelle); kopiossa import tulee poistaa tai korvata `toiminnot/aja.mjs`:llä, ja Mac-tehtaan ssh-polku viittaa `~/sessions-repo/scopes/palvelu/agy-kayttoraja.mjs`-merkkijonoon (gate.sh:78 -tyyppinen merkkijonovakio).

### 2.2 vanhasta/toiminnot-asetukset.mjs (507a61f1 -> HEAD; kuluttajat: adapteri.mjs:31, lahde.mjs:18, toiminnot/asetukset.mjs:21)
- B: `ASETUKSET.automaattisiirto = 'automaattisiirto.txt'` (V1 47b8ccaf; sama avain myös `claude/siirto/tools/asetus-tila.mjs`:ssä 47b8ccaf). Uusi avain: S-5b asetukset-lajin `yhteiset`/`istunnot`-sisältö ja S-10 `POST /api/asetukset/automaattisiirto/*` -arvojoukko laajenevat (sama asia kuin REKISTERI-rivi "T-29 ja T-83 punaisia originin kärjessä").
- A: `aseta()` kirjoittaa ei-darwin-alustalla lisäksi Macin tilatiedoston ssh:lla (`ssh dev-host ... echo > …/state/<tiedosto>`; V1 47b8ccaf, rivit 48-50). Olemassa olevan `POST /api/asetukset/*/*` -reitin sivuvaikutus. Huom: synkka muuttaisi adapterin sivuvaikutuksia (ssh Macille tuotannossa) ja merkkijono on shell-komento `echo '${arvo}'`; arvo on boolean joten injektio ei ole mahdollinen, mutta synkka kannattaa tehdä tietoisesti (valvoja).

### 2.3 AGY_MALLIT (viestit.mjs old 18-24; kopiot agentit.mjs:15, chat.mjs:22)
- A: V1 lisäsi kuusi `agy/<malli>`-riviä (Linux-agy, kuvaus "· Linux"; V1 74155e4b) listaan, joka palautuu `GET /api/agentit`-reitillä ja jota chat käyttää agentin tunnistamiseen (`chat.mjs:361`). Olemassa oleva reitti, uudet arvot.

### 2.4 toiminnot.mjs: automaattisiirto-vahti ja sulje (istunto.mjs:109, :155, :195, :238)
- B: `tarkistaAutomaattisiirto`, `kaynnistaVahti`/`pysaytaVahti`, `laukaistutAutomaattisiirrot`, `kytkimet`-valinta ja `istuntoon(..., haluttuIstunto)` (V1 47b8ccaf; old toiminnot.mjs:88, 94, 158, 162, 176, 235, 357). Uusi taustatoiminto: kun kytkin `automaattisiirto` päällä ja istunnon konteksti >= 120 000 tokenia ja istunto idle/kysymys, ajaa `/automaattisiirto` ilman käyttäjää. Ei uutta reittiä mutta uusi taustakäytös + riippuvuus uuteen kytkimeen (2.2 B); sopii adapterin `kaynnista(ymp)`-koukkuun (palvelin.mjs:4,60), mutta on S-10-laajennus.
- B: `sulje`-toiminto ja reitti `/api/skoopit/<nimi>/(pakkaa|automaattisiirto|herata|herata-pois|arkistoi|sulje)` (V1 819d992e; old toiminnot.mjs:304+, palvelin.mjs:275). Uusi POST-reitti, ei S-10-vastinetta (adapterin `istunto.mjs:243` REITIT-lista kattaa neljä).

### 2.5 vaihdaMalli (malli.mjs:66; viestit.mjs old 829-897; V1 74155e4b)
Reitti `POST /api/skoopit/*/malli` on olemassa; käytös muuttui seuraavasti, kaikki A:
- A: sallitut mallit = MALLIT + AGY_MALLIT + `kaikkiMallit()` (dynaamiset), ei vain MALLIT.
- A: agy-istuntohaara (Linux/Mac AGY): `/model`- ja `/effort`-valitsimet, `poimiAgyRuudunAsetukset`/`jasennaAgyRuutu` (kumpikin jo `vanhasta/agy-istunto.mjs`:ssä), effort johdetaan mallinimen päätteestä.
- A: Claude Code -haarassa välimuistivahvistus "Change effort level?" hyväksytään (`1`/Enter) ja `~/.claude/settings.json` palautetaan ennalleen jos se muuttui (vanha: vahvistusta ei koskaan hyväksytty, Escape).
- A: odotusregex `effort level to ${effort}` ilman "(this session only)" ja löyhä `effort level|switched to|for this session` -hyväksyntä.
Huom: uusi `settings.json`-kirjoitus (writeFileSync) on tuotantokosketus synkassa; kuuluu valvojan tarkistettavaksi.

### 2.6 pura.mjs (toiminnot.mjs old 238-254 ja 275-300; V1 47b8ccaf, aec8a09e, ef58a316)
- A: `puraMallitta` lisää `--autojatko` pura-malliton-kutsuun kun kytkin automaattijatko päällä (V1 47b8ccaf; old 241). Vaatii kytkimien luvun (`kytkimetAsetus.lue().automaattijatko`) adapterissa.
- A: Mac-agy-haarassa scp:ataan lisäksi tilatiedostot `automaattivalinta.txt`, `autopack.txt`, `agy-luvat.txt` Macille (V1 47b8ccaf; old 248). Uusia scp-kutsuja Maciin.
- A: suljettavat agy-ruudut suljetaan `C-c`, `C-d`, `kill-window` eikä `/exit` (V1 aec8a09e; old 251). Sama muutos `pura()`-metodissa (old 297).
- A: `pura()` lisää `--autojatko` /pura-viestiin kun kytkin päällä (V1 47b8ccaf; old 297-298).
- A: virheilmoitus "agy-istunto kuuluu vain scopes- ja infra-perheen skoopeille" (V1 ef58a316; old 295, adapteri `pura.mjs:126`).
- A: `import existsSync` (V1 a9645ded; old 24) tarvitaan scp-tilatiedostoille; sama synkassa.

### 2.7 uusi.mjs (uusiAgy, old 256-272; V1 ef58a316)
- A: `uusiAgy` sallii skoopit `scopes ` ja `infra ` (adapteri `uusi.mjs:34` hylkää vain `scopes `); virheteksti muuttuu. Vaatii pura-malliton.mjs:n `--perhe`-tuen infralle (työkalu, ei kopio).

### 2.8 vanhasta/agy-istunto.mjs (jo uudelleensynkattu 28.10.)
- B (jo kopiossa): `agyIstunnot`-tuloksen jokaisessa Mac-ssh-ruudussa kenttä `onMac: true` (kopio:233, :647; V1 c78dc60f/74155e4b). Tämä kenttä kulkee jo S-5b agy-lajin sisällössä (lahde.mjs:157-170 välittää olion sellaisenaan). Tarkistettava: sisältyykö `onMac` ytimen S-5b agy-skeemaan (ohitetaanko tuntematon kenttä). Muut sen mukanaan tuomat muutokset (busy-tunnistus ruudusta, `transcript_full.jsonl`, `poimiAgyRuudunAsetukset`, USER_INPUT/SYSTEM-suodatus, malli/effort-päättely) ovat A-tason arvomuutoksia agy-lajissa ja jo mukana (47b8ccaf).

## 3. V1:n uudet reitit palvelin.mjs:ssä 21.10. jälkeen

`git log --since=2026-10-21 -- scopes/palvelu/palvelin.mjs` + `git diff 507a61f1 HEAD`. Vastine = S-10 (`scopes2/adapteri/toiminnot/*.mjs` REITIT, kuvio listattu `grep metodi:`). Mikään uusista ei ole S-10:ssä.

| Metodi | Polku | Commit | S-10-vastine | Luokka |
|---|---|---|---|---|
| GET | /api/terminal/sessions | 47b00af4 | ei | B |
| GET | /api/terminal/sessions/<id> | 47b00af4 | ei | B |
| POST | /api/terminal/sessions | 47b00af4 | ei | B |
| DELETE | /api/terminal/sessions/<id>[?killTmux=true] | 47b00af4 | ei (adapterin 405 "vain GET ja POST") | B |
| WS upgrade | (terminal.asennaWsUpgrade, palvelin.mjs:499-) | 47b00af4 | ei | B |
| GET | /api/economy/git-tila | 7146a9b6, e17d1e39 | ei | B |
| GET | /api/economy/tiedostokartta | 8e620436 | ei | B |
| GET | /api/economy/tilasto | 8e620436 | ei | B |
| GET | /api/economy/task-odotus | 82e2f012 | ei | B |
| GET | /api/economy/hybridi-pakkaus | 6960dc56 | ei | B |
| GET | /api/economy/kuluttajat | 796d37c3 | ei | B |
| GET | /api/economy/budjetti | e17d1e39 | ei | B |
| GET | /api/mallit | 819d992e | ei; sisältö = `purkajat.lista()` eli sama kuin S-10 `GET /api/purkajat` (pura.mjs:144) | B (alias) |
| GET | /api/kayttorajat-kaikki ja /api/kayttoraja?kaikki=1 | c78dc60f | ei; kayttoraja-reitti on ytimen, ei S-10:n | B |
| GET | /api/kayttoraja?ymparisto=&laite=&ryhma= (Mac-haara, `otsikko: 'Claude'`) | c78dc60f | ei (ydin palvelee lahde.kayttoraja:sta; vaatii 2.1 B-kentät) | B |
| GET | /api/ios/ipa ja /api/skoopit.ipa | 819d992e | ei | B |
| POST | /api/skoopit/<nimi>/sulje | 819d992e | ei (istunto.mjs REITIT: 4 toimintoa) | B |
| kaikki | `?avain=<avain>` kyselyparametri Bearer-otsakkeen vaihtoehtona (WebSocket-tunnistus) | 819d992e/47b00af4 | ei; adapterin palvelin.mjs hyväksyy vain Bearer | B |
| GET/POST | /api/asetukset(/*) ja /api/skoopit/*/asetukset: uusi avain `automaattisiirto` | 47b8ccaf | on reitti, avain puuttuu (2.2) | B |
| GET | /api/skoopit/<nimi>/viestit: `istunto.onMac` agy-istunnolla, malli/effort ruudusta | 74155e4b | ydin palvelee (peili), ei S-10 | B (ydin-skeema) |

C (ei adapterin käytössä): `palvelin.mjs`-tuonnit (`existsSync`, `luoMacAgyKayttoraja`, `luoTerminaali`, `luoEconomyPalvelu`), `kasittelija`-allekirjoituksen uudet oletusparametrit, `suorita?.asetaKytkimet?.(kytkimet)`, pääohjelman `kaynnistaVahti`/`terminal.asennaWsUpgrade`-kytkentä (V1:n käynnistys, adapterilla oma palvelin.mjs), `viestit.onkoMacAgy` (vain `/api/kayttoraja` käyttää), viestit.mjs:n tuonti `poimiAgyRuudunAsetukset`.

## 4. Huomiot toteutussuunnitelmalle
- Tuotantokosketukset synkassa (valvojan katselmoitava): ssh Macille toiminnot-asetuksissa (2.2) ja pura-scp:ssa (2.6), `settings.json`-kirjoitus (2.5), Mac-ssh kayttorajassa (2.1).
- A-kohdat 2.3-2.7 eivät muuta ydin- tai äppisopimusta; B-kohdat 2.1, 2.2, 2.4 ja luvun 3 reitit vaativat S-5b/S-10-päätöksen (kenttälista, uudet reitit, `?avain=`). Uudet reitit/kentät joita nykyiset sopimukset eivät kata (terminal/WebSocket, economy, kayttorajat-kaikki, ipa) vie toteutussuunnitelma arkkitehtuurille.
- Ennallaan olevat kopiot (9 vanhasta/-tiedostoa + viestit-vakiot) eivät tarvitse toimenpidettä.
- `T-65` tulostaa jo TIEDOKSI-rivit muuttuneista lähteistä (agy-kayttoraja, toiminnot-asetukset, viestit); sama lista kuin tässä (osakopion viestit-vakiot ei muuttunut rivien 26-31, 103 osalta).
