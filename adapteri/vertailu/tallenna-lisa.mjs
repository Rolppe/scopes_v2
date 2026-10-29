#!/usr/bin/env node
// Vanhan lisäreittien käytöksen tallennin (T-79-G, ARK-16:n loput + ARK-19, S-10). Saa tuoda scopes/-polusta kuten tallenna-vanha.mjs.
// Ajetaan käsin (ei portissa): node scopes2/adapteri/vertailu/tallenna-lisa.mjs   (uudelleenajo → git diff tyhjä)
//
// Ajaa vanhan palvelun oikean käsittelijän (scopes/palvelu/palvelin.mjs kasittelija) in-process http-palvelimella portissa 0.
// Reitit: malli (luoViestit.vaihdaMalli), uusi (luoToiminnot 'uusi' + uusiAgy), agentit (luoViestit.agentit), asetukset
// (luoAsetukset + luoIstuntoValinta), android (luoAndroid) ja linux (luoLinuxServer). Kaikki ulkoiset komennot (tmux, adb, ping,
// ssh, python3, git, bash, node, agy) kulkevat tallentavan mock-`aja`n läpi: ei oikeaa adb-laitetta (127.0.0.1:5555 ei kosketa),
// ei pingiä, WoL:ia, ssh:ta, tmux:ia eikä verkkoa. Kaikki tila on väliaikaisessa hakemistossa. Kirjoittaa
// testidata/toiminnot/<moduuli>-<tapaus>.json (moduuli = malli|uusi|agentit|asetukset|android|linux); T-63-G:n fixtureihin ei kosketa.
//
// Fixturemuoto on tallenna-vanha.mjs:n (tapaus, pyynto, ymparisto, odotus; paikkamerkit <JUURI> <KOTI> <CHAT> <PID> <TMP>) ja lisäksi:
//   pyynto.runko     merkkijono = raakarunko sellaisenaan (android/liite: tiedoston tavut), muuten JSON; polku voi sisältää kyselyn
//   ymparisto.tmux["capture-pane"]   merkkijono tai taulukko: taulukko = peräkkäiset vastaukset kutsu kerrallaan (viimeinen toistuu)
//   ymparisto.komennot.vastaukset    [{ komento, sisaltaa?, koodi?, stdout?, stdoutBase64?, stderr?, jarjestys? }]: ensimmäinen sääntö,
//                    jonka komento täsmää ja jonka `sisaltaa` esiintyy argv:ssa (välilyönnillä yhdistettynä), vastaa. `jarjestys` =
//                    peräkkäiset vastaukset kutsu kerrallaan (viimeinen toistuu), esim. dumpsys: Asleep, sitten Awake. Komennot:
//                    adb, python3, ping, ssh, agy, git, bash (install.sh), node (luo-skooppi). Oletus ilman sääntöä: koodi 0, tyhjä
//                    stdout; ping oletuksena koodi 1 (ei vastaa), ssh 255 (ei yhteyttä), agy ja tuntematon komento = virhe.
//   ymparisto.komennot["luo-skooppi"]  uusiAgy:n luo-skooppi.mjs-vastaus { koodi, stdout, stderr } (oletus KIRJOITETTU-rivi)
//   ymparisto.samanaikainen.pito     komento, jossa ensimmäinen pyyntö pidetään (oletus autovaihto.sh; linux: "python3")
//   ymparisto.asetuksetTila          [{ tiedosto, sisalto }] = kytkinten tilahakemisto (automaattivalinta.txt, istunnot/<id>/…)
//   ymparisto.androidMukana          agentit: luoViestit saa Android-olion (Gemini listalla)
//   ymparisto.nebiusAvain            Nebius-avaintiedosto on olemassa (agentit ja purkajat näyttävät Nebius-mallit)
//   ymparisto.android                { kuiva?, myohemmin?: ms }: kuivatila; myohemmin = kello etenee ms pyynnön jälkeen ja ajastimen
//                                    nukutaJosHiljaista ajetaan (tulos odotus.myohemmin = { ms, nukutettu, aja })
//   ymparisto.linux                  { kuiva? }
//   odotus.runko (binäärivastaus)    { tyyppi, base64, nimi? } kun vastaus ei ole JSON (android/ruutu, android/tuotos)
//   odotus.asetuksetTila             [{ tiedosto, sisalto }] kytkinten tilahakemiston tiedostot pyynnön jälkeen (asetusreitit)
// Lisäpaikkamerkit: <REPO> = vanhan koodin repojuuri (herata-pc.py), <ANDROID> = Android-tuotoskansio, <LIITTEET> = liitekansio.
// Deterministinen: kiinteä kello (2026-10-21T08:00:00Z), Math.random vakio, sleep-viiveet (>= 100 ms) kirjataan eikä odoteta.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { request as httpRequest, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTIDATA = fileURLToPath(new URL('../testidata/toiminnot/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const AVAIN = 'tallenna-lisa-testiavain-0123456789abcdef';
const OMAT = /^(malli|uusi|agentit|asetukset|android|linux)-.*\.json$/;

// HOME ennen vanhojen moduulien tuontia: homedir() luetaan myös moduulien latauksessa.
const TMP = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'tallenna-lisa-')));
const KOTI = join(TMP, 'koti');
mkdirSync(KOTI, { recursive: true });
process.env.HOME = KOTI;
for (const k of ['SCOPES_JUURI', 'CLAUDE_ISTUNNOT_DIR', 'CLAUDE_PROJEKTIT_DIR', 'SCOPES_CHAT_DIR', 'AGY_BIN', 'SCOPES_LINUX_KUIVA', 'SCOPES_ANDROID_KUIVA']) delete process.env[k];

const vanha = (p) => import(new URL(`../../../scopes/palvelu/${p}`, import.meta.url));
const { kasittelija } = await vanha('palvelin.mjs');
const { luoToiminnot, Hylatty } = await vanha('toiminnot.mjs');
const { luoViestit } = await vanha('viestit.mjs');
const { luoPurkajat } = await vanha('purkajat.mjs');
const { luoAsetukset } = await vanha('toiminnot-asetukset.mjs');
const { luoAndroid } = await vanha('android.mjs');
const { luoLinuxServer } = await vanha('palvelin.mjs');
const { projektiNimi } = await vanha('lahteet.mjs');
const { siistiNimi } = await vanha('liitteet.mjs');

// ---------- syötteet (kiinteät) ----------
const PID = '<PID>';
const TMUX = 'siirto-a-1:@1.%5';
const S1 = 'sessio-a-0001';
const S2 = 'sessio-a-0002';
const AIKA0 = Date.parse('2026-10-21T08:00:00.000Z');
const teksti = (t, aika) => ({ type: 'assistant', timestamp: aika, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: t }] } });
const kayttaja = (t, aika) => ({ type: 'user', timestamp: aika, message: { content: t } });
const TR = [kayttaja('/pura a', '2026-10-21T08:00:00.000Z'), teksti('Purku valmis.', '2026-10-21T08:00:01.000Z')];
const KYSYMYS = { type: 'assistant', timestamp: '2026-10-21T08:00:02.000Z', message: { content: [
  { type: 'tool_use', id: 'k1', name: 'AskUserQuestion', input: { questions: [{ question: 'Mitä tehdään?', header: 'Jatko', multiSelect: false, options: [{ label: 'Aloita', description: 'paketti' }, { label: 'Ei mitään' }] }] } }] } };
const TR_KYSYMYS = [...TR, KYSYMYS];
const istunto = (tila, extra, id, tiedosto) => ({ tiedosto, sisalto: { pid: PID, sessionId: id, cwd: '/x', name: 'a', status: tila, tmux: TMUX, ...extra } });
const ymp = ({ tila = 'idle', kysely = false, ids = [S1], istunnot = true, transkripti = TR, ruudunPid = PID, tmux = {}, komennot = {}, ...muut } = {}) => ({
  skooppitiedot: { a: ['R.md'], b: ['R.md'], 'scopes koe': ['R.md'] },
  istunnot: istunnot ? ids.map((id, i) => istunto(tila, kysely ? { waitingFor: 'input needed' } : {}, id, i === 0 ? `${PID}.json` : `${1000 + i}.json`)) : [],
  transkriptit: transkripti ? ids.map((id) => ({ kohde: 'istunto', cwd: '/x', id, rivit: transkripti })) : [],
  tmux: { 'display-message': `${ruudunPid}\n`, 'capture-pane': '', 'list-panes': '', ...tmux },
  komennot,
  ...muut,
});
const tyhjaYmp = (muut = {}) => ymp({ istunnot: false, transkripti: null, ...muut });
const POST = (polku, runko = {}) => ({ metodi: 'POST', polku, runko });
const GET = (polku) => ({ metodi: 'GET', polku, runko: null });

// ---------- malli ----------
const MA = '/api/skoopit/a/malli';
const VALITSIN = [' Select model', '   1. Fable 5.1', ' ❯ 2. Opus 5.5 ✔', '   3. Sonnet 5.5', '   4. Haiku 5.5', ' Enter to confirm · Esc to exit'].join('\n');
const VAHV_MALLI = ' Set model to Sonnet 5.5 (for this session only)';
const vahvEffort = (taso) => ` Set effort level to ${taso} (this session only)`;
const DIALOGI = [' Change effort level?', ' Changing effort invalidates the prompt cache.', ' ❯ 1. Yes, change it', '   2. No, go back'].join('\n');
const vain = (capture) => ({ 'capture-pane': capture });

// ---------- uusi ----------
const OK_RC = { autovaihto: { koodi: 0, stdout: 'UUSI: …\nOK: https://claude.ai/code/session_abc123\n', stderr: '' } };
const AGY_LISTA = { komento: 'agy', stdout: 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' };
const LUO_SKOOPPI = { koodi: 0, stdout: 'KIRJOITETTU: scopes-koe/REKISTERI.md\nKIRJOITETTU: scopes-koe/HISTORIA.md\n', stderr: '' };
const AGY_AUTOVAIHTO = { autovaihto: { koodi: 0, stdout: 'UUSI: …\nOK: agy tmux siirto-scopes-koe-1\n', stderr: '' } };

// ---------- android ----------
const b64 = (x) => Buffer.from(x).toString('base64');
const adb = (sisaltaa, tulos) => ({ komento: 'adb', sisaltaa, ...tulos });
const HEREILLA = adb('dumpsys power', { stdout: 'mWakefulness=Awake\n' });
const KOKO = adb('wm size', { stdout: 'Physical size: 1080x2400\n' });
const attr = (s) => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const solmu = ({ teksti: t = '', kuvaus = '', id = '', luokka = 'android.widget.TextView', napautettava = false, alue = [0, 0, 100, 100] }) =>
  `<node index="0" text="${attr(t)}" resource-id="${id ? `com.google.android.apps.bard:id/${id}` : ''}" class="${luokka}" content-desc="${attr(kuvaus)}" clickable="${napautettava}" bounds="[${alue.join('][')}]" />`;
const UI = (...solmut) => adb('uiautomator dump', { stdout: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${solmut.map(solmu).join('')}</hierarchy>` });
const NAPPI = (kuvaus, alue = [100, 2000, 300, 2100]) => ({ kuvaus, napautettava: true, luokka: 'android.widget.Button', alue });
const SEND = NAPPI('Send');
const KESKUSTELU = [
  { teksti: 'Moi Gemini', id: 'assistant_robin_user_message_text', alue: [0, 100, 1080, 200] },
  { teksti: 'Hei! Miten voin auttaa?', id: 'assistant_robin_text', alue: [0, 300, 1080, 400] },
];
const AR = (...saannot) => ({ komennot: { vastaukset: [HEREILLA, KOKO, ...saannot] } });
const LIITENIMI = 'scopes-080000-muistio.txt';
const LIITE_UI = UI(NAPPI('Add attachments'), { teksti: 'Files', alue: [0, 1500, 500, 1600] }, { teksti: LIITENIMI, alue: [0, 1700, 900, 1800] }, SEND);
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PNG = Buffer.alloc(200, 7);

// ---------- linux ----------
const ping = (ip, ttl) => ({ komento: 'ping', sisaltaa: ip, stdout: `64 bytes from ${ip}: icmp_seq=1 ttl=${ttl} time=0.4 ms\n` });
const LINUX_PAALLA = [ping('192.0.2.99', 64)];
const WINDOWS_PAALLA = [ping('192.0.2.99', 128)];
const PC_ALAS = [];
const herata = (tulos) => ({ komento: 'python3', sisaltaa: 'herata-pc.py', ...tulos });
const SSH_WINDOWS = (tulos = {}) => ({ komento: 'ssh', sisaltaa: 'pc', ...tulos });
const SSH_POWEROFF = (tulos = {}) => ({ komento: 'ssh', sisaltaa: 'poweroff', ...tulos });
const LR = (...saannot) => ({ komennot: { vastaukset: saannot } });
const LK = '/api/palvelin';

// ---------- tapaukset ----------
const A = '/api/skoopit/a';
const tapaukset = [
  // malli: /model ja /effort vapaan istunnon valitsimesta
  ['malli-malli-ok', POST(MA, { malli: 'claude-sonnet-5-5' }), ymp({ tmux: vain([VALITSIN, VAHV_MALLI]) })],
  ['malli-effort-ok', POST(MA, { effort: 'high' }), ymp({ tmux: vain([vahvEffort('high')]) })],
  ['malli-effort-low-ok', POST(MA, { effort: 'low' }), ymp({ tmux: vain([vahvEffort('low')]) })],
  ['malli-malli-ja-effort-ok', POST(MA, { malli: 'claude-sonnet-5-5', effort: 'xhigh' }), ymp({ tmux: vain([VALITSIN, VAHV_MALLI, vahvEffort('xhigh')]) })],
  ['malli-ei-vapaa-kysymys-kortti', POST(MA, { effort: 'high' }), ymp({ tila: 'waiting', kysely: true, transkripti: TR_KYSYMYS })],
  ['malli-ei-vapaa', POST(MA, { malli: 'claude-sonnet-5-5' }), ymp({ tila: 'busy' })],
  ['malli-kysymys-auki', POST(MA, { effort: 'high' }), ymp({ tila: 'idle', transkripti: TR_KYSYMYS })],
  ['malli-effort-vahvistusdialogi', POST(MA, { effort: 'high' }), ymp({ tmux: vain([DIALOGI, DIALOGI, '']) })],
  ['malli-effort-vahvistusdialogi-jaa-auki', POST(MA, { effort: 'high' }), ymp({ tmux: vain([DIALOGI]) })],
  ['malli-tuntematon-malli', POST(MA, { malli: 'claude-ei-ole' }), ymp()],
  ['malli-tuntematon-effort', POST(MA, { effort: 'ultra' }), ymp()],
  ['malli-tyhja-runko', POST(MA, {}), ymp()],
  ['malli-ei-istuntoa', POST('/api/skoopit/b/malli', { malli: 'claude-sonnet-5-5' }), ymp()],
  ['malli-vaara-ruutu', POST(MA, { malli: 'claude-sonnet-5-5' }), ymp({ ruudunPid: '424242' })],
  ['malli-tuntematon-skooppi', POST('/api/skoopit/ei-ole/malli', { malli: 'claude-sonnet-5-5' }), ymp()],
  ['malli-valitsin-ei-aukea', POST(MA, { malli: 'claude-sonnet-5-5' }), ymp({ tmux: vain(['']) })],
  ['malli-effort-ei-vahvistu', POST(MA, { effort: 'high' }), ymp({ tmux: vain(['Esc to cancel']) })],

  // uusi: autovaihto.sh, uusiAgy (luo-skooppi, install, commit) ja valinnat
  ['uusi-ok', POST('/api/uusi', { nimi: 'uusi koe' }), tyhjaYmp({ komennot: OK_RC })],
  ['uusi-ok-valinnat', POST('/api/uusi', { nimi: 'uusi koe', purkaja: 'claude-cli:claude-haiku-5-5', malli: 'claude-opus-5-5' }),
    tyhjaYmp({ komennot: { ...OK_RC, vastaukset: [AGY_LISTA] } })],
  ['uusi-skooppi-on-jo', POST('/api/uusi', { nimi: 'a' }), tyhjaYmp({ komennot: OK_RC })],
  ['uusi-agy', POST('/api/uusi', { nimi: 'scopes uusi', malli: 'agy/gemini-3.8-flash-low' }),
    tyhjaYmp({ komennot: { ...AGY_AUTOVAIHTO, 'luo-skooppi': LUO_SKOOPPI, vastaukset: [AGY_LISTA] } })],
  ['uusi-agy-asennus-epaonnistuu', POST('/api/uusi', { nimi: 'scopes uusi', malli: 'agy/gemini-3.8-flash-low' }),
    tyhjaYmp({ komennot: { ...AGY_AUTOVAIHTO, 'luo-skooppi': LUO_SKOOPPI, vastaukset: [AGY_LISTA, { komento: 'bash', sisaltaa: 'install.sh', koodi: 1 }] } })],
  ['uusi-agy-commit-epaonnistuu', POST('/api/uusi', { nimi: 'scopes uusi', malli: 'agy/gemini-3.8-flash-low' }),
    tyhjaYmp({ komennot: { ...AGY_AUTOVAIHTO, 'luo-skooppi': LUO_SKOOPPI, vastaukset: [AGY_LISTA, { komento: 'git', sisaltaa: 'commit', koodi: 1, stderr: 'nothing to commit' }] } })],
  ['uusi-agy-ei-scopes-perhe', POST('/api/uusi', { nimi: 'koe', malli: 'agy/gemini-3.8-flash-low' }),
    tyhjaYmp({ komennot: { ...AGY_AUTOVAIHTO, vastaukset: [AGY_LISTA] } })],
  ['uusi-toinen-toiminto-kaynnissa', POST('/api/uusi', { nimi: 'uusi koe' }), tyhjaYmp({ komennot: OK_RC, samanaikainen: POST('/api/uusi', { nimi: 'toinen koe' }) })],
  ['uusi-virheellinen-nimi', POST('/api/uusi', { nimi: 'Väärä Nimi!' }), tyhjaYmp({ komennot: OK_RC })],
  ['uusi-nimi-puuttuu', POST('/api/uusi', {}), tyhjaYmp({ komennot: OK_RC })],
  ['uusi-tuntematon-malli', POST('/api/uusi', { nimi: 'uusi koe', malli: 'ei-ole/malli' }), tyhjaYmp({ komennot: { ...OK_RC, vastaukset: [AGY_LISTA] } })],
  ['uusi-autovaihto-epaonnistuu', POST('/api/uusi', { nimi: 'uusi koe' }), tyhjaYmp({ komennot: { autovaihto: { koodi: 1, stdout: '', stderr: 'tmux ei vastaa\n' } } })],

  // agentit: chatin mallilista (Claude, agy, Gemini, LM Studio, Nebius)
  ['agentit-android-pois', GET('/api/agentit'), tyhjaYmp()],
  ['agentit-android-mukana', GET('/api/agentit'), tyhjaYmp({ androidMukana: true })],
  ['agentit-nebius-avain-ei', GET('/api/agentit'), tyhjaYmp()],
  ['agentit-nebius-avain-on', GET('/api/agentit'), tyhjaYmp({ nebiusAvain: true })],
  ['agentit-lmstudio-vastaa', GET('/api/agentit'), tyhjaYmp({ komennot: { vastaukset: [{ komento: 'ssh', sisaltaa: 'curl -s -m 5 http://127.0.0.1:1234/v1/models', stdout:
    JSON.stringify({ data: [{ id: 'qwen/qwen3.5-9b' }, { id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'qwen3.5-9b-q4_k_m.gguf' }, { id: 'google/gemma-4-12b' }] }) }] } })],
  ['agentit-lmstudio-ei-vastaa', GET('/api/agentit'), tyhjaYmp({ komennot: { vastaukset: [{ komento: 'ssh', sisaltaa: 'palvelin', koodi: 255, stderr: 'ssh: connect to host palvelin port 22: Connection refused' }] } })],
  ['agentit-lmstudio-roskavastaus', GET('/api/agentit'), tyhjaYmp({ komennot: { vastaukset: [{ komento: 'ssh', sisaltaa: 'palvelin', stdout: 'ei json' }] } })],

  // asetukset: yhteiset ja istuntokohtaiset kytkimet
  ['asetukset-yhteinen-paalle', POST('/api/asetukset/automaattijatko/paalle'), tyhjaYmp()],
  ['asetukset-yhteinen-pois', POST('/api/asetukset/automaattijatko/pois'), tyhjaYmp({ asetuksetTila: [{ tiedosto: 'automaattivalinta.txt', sisalto: 'true\n' }, { tiedosto: 'autopack.txt', sisalto: 'true\n' }] })],
  ['asetukset-autopack-paalle', POST('/api/asetukset/autopack/paalle'), tyhjaYmp()],
  ['asetukset-agyluvat-paalle', POST('/api/asetukset/agyluvat/paalle'), tyhjaYmp()],
  ['asetukset-tuntematon-nimi', POST('/api/asetukset/ei-ole/paalle'), tyhjaYmp()],
  ['asetukset-tuntematon-tila', POST('/api/asetukset/autopack/ehka'), tyhjaYmp()],
  ['asetukset-istunto-paalle', POST(`${A}/asetukset/automaattijatko/paalle`), ymp()],
  ['asetukset-istunto-pois', POST(`${A}/asetukset/autopack/pois`), ymp({ asetuksetTila: [{ tiedosto: 'autopack.txt', sisalto: 'true\n' }, { tiedosto: `istunnot/${S1}/autopack.txt`, sisalto: 'true\n' }] })],
  ['asetukset-istunto-ilman-istuntoa', POST('/api/skoopit/b/asetukset/autopack/paalle'), ymp()],
  ['asetukset-istunto-useita-ilman-valintaa', POST(`${A}/asetukset/autopack/paalle`), ymp({ ids: [S1, S2] })],
  ['asetukset-istunto-useita-valinta', POST(`${A}/asetukset/autopack/paalle?istunto=${S2}`), ymp({ ids: [S1, S2] })],
  ['asetukset-istunto-tuntematon', POST(`${A}/asetukset/autopack/paalle?istunto=ei-ole-sessio`), ymp()],
  ['asetukset-istunto-agyluvat-hylatty', POST(`${A}/asetukset/agyluvat/paalle`), ymp()],
  ['asetukset-istunto-tuntematon-asetus', POST(`${A}/asetukset/ei-ole/paalle`), ymp()],
  ['asetukset-istunto-tuntematon-skooppi', POST('/api/skoopit/ei-ole/asetukset/autopack/paalle'), ymp()],
  ['asetukset-istunto-lyhyt-tunnus', POST(`${A}/asetukset/autopack/paalle`), ymp({ ids: ['s1'] })],

  // android: toiminnot, ruutu, ui, tuotokset, tuotos, liite, kuivatila, herätys ja nukutus
  ['android-napauta', POST('/api/android/napauta', { x: 0.5, y: 0.25 }), tyhjaYmp(AR())],
  ['android-napauta-arvo-virheellinen', POST('/api/android/napauta', { x: 1.5, y: 0 }), tyhjaYmp(AR())],
  ['android-pyyhkaise', POST('/api/android/pyyhkaise', { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, kesto: 500 }), tyhjaYmp(AR())],
  ['android-nappi', POST('/api/android/nappi', { nimi: 'takaisin' }), tyhjaYmp(AR())],
  ['android-nappi-tuntematon', POST('/api/android/nappi', { nimi: 'ei-ole' }), tyhjaYmp(AR())],
  ['android-nappi-nukuta', POST('/api/android/nappi', { nimi: 'nukuta' }), tyhjaYmp(AR())],
  ['android-avaa', POST('/api/android/avaa'), tyhjaYmp(AR())],
  ['android-uusi', POST('/api/android/uusi'), tyhjaYmp(AR(UI(NAPPI('New chat'))))],
  ['android-uusi-ei-nappia', POST('/api/android/uusi'), tyhjaYmp(AR(UI({ teksti: 'Gemini' })))],
  ['android-kirjoita', POST('/api/android/kirjoita', { teksti: 'Hei äiti' }), tyhjaYmp(AR(UI({ teksti: 'Gemini' })))],
  ['android-kirjoita-laheta', POST('/api/android/kirjoita', { teksti: 'Hei äiti', laheta: true }), tyhjaYmp(AR(UI(SEND)))],
  ['android-kirjoita-tyhja', POST('/api/android/kirjoita', { teksti: '  ' }), tyhjaYmp(AR())],
  ['android-kirjoita-liian-pitka', POST('/api/android/kirjoita', { teksti: 'x'.repeat(8001) }), tyhjaYmp(AR())],
  ['android-kirjoita-liite-odottaa', POST('/api/android/kirjoita', { teksti: 'Hei' }), tyhjaYmp(AR(UI({ kuvaus: 'List of attachments' })))],
  ['android-kirjoita-vienti-epaonnistuu', POST('/api/android/kirjoita', { teksti: 'Hei' }),
    tyhjaYmp(AR(UI({ teksti: 'Gemini' }), adb('android.intent.action.SEND', { koodi: 1, stderr: 'Error: Activity not started' })))],
  ['android-kirjoita-kuiva', POST('/api/android/kirjoita', { teksti: 'Hei äiti', laheta: true }), tyhjaYmp({ ...AR(UI(SEND)), android: { kuiva: true } })],
  ['android-laheta', POST('/api/android/laheta'), tyhjaYmp(AR(UI(SEND)))],
  ['android-laheta-ei-nappia', POST('/api/android/laheta'), tyhjaYmp(AR(UI({ teksti: 'Gemini' })))],
  ['android-laheta-jako-kuitataan', POST('/api/android/laheta'),
    tyhjaYmp(AR(UI({ teksti: 'This content was automatically added from another app. Share it with Gemini?' }, { teksti: 'Share', napautettava: true, alue: [500, 1000, 700, 1100] }, SEND)))],
  ['android-talteen', POST('/api/android/talteen'), tyhjaYmp(AR(UI(...KESKUSTELU)))],
  ['android-talteen-ei-keskustelua', POST('/api/android/talteen'), tyhjaYmp(AR(UI({ teksti: 'Gemini' })))],
  ['android-tuntematon-toiminto', POST('/api/android/ei-ole'), tyhjaYmp(AR())],
  ['android-adb-ei-vastaa', POST('/api/android/avaa'), tyhjaYmp({ komennot: { vastaukset: [adb('dumpsys power', { koodi: 1, stderr: 'error: device offline' })] } })],
  ['android-heratys', POST('/api/android/nappi', { nimi: 'koti' }), tyhjaYmp({ komennot: { vastaukset: [adb('dumpsys power', { stdout: 'mWakefulness=Asleep\n' }), KOKO] } })],
  ['android-nukutus', POST('/api/android/nappi', { nimi: 'koti' }),
    tyhjaYmp({ android: { myohemmin: 61000 }, komennot: { vastaukset: [adb('dumpsys power', { jarjestys: [{ stdout: 'mWakefulness=Asleep\n' }, { stdout: 'mWakefulness=Awake\n' }] }), KOKO] } })],
  ['android-nukutus-ei-viela', POST('/api/android/nappi', { nimi: 'koti' }),
    tyhjaYmp({ android: { myohemmin: 30000 }, komennot: { vastaukset: [adb('dumpsys power', { jarjestys: [{ stdout: 'mWakefulness=Asleep\n' }, { stdout: 'mWakefulness=Awake\n' }] }), KOKO] } })],
  ['android-nukutus-ei-itse-heratetty', POST('/api/android/nappi', { nimi: 'koti' }), tyhjaYmp({ android: { myohemmin: 61000 }, ...AR() })],
  ['android-ruutu', GET('/api/android/ruutu'), tyhjaYmp(AR(adb('screencap', { stdoutBase64: b64(PNG) }), { komento: 'python3', sisaltaa: 'Image', stdoutBase64: b64(JPEG) }))],
  ['android-ruutu-leveys', GET('/api/android/ruutu?leveys=360'), tyhjaYmp(AR(adb('screencap', { stdoutBase64: b64(PNG) }), { komento: 'python3', sisaltaa: 'Image', stdoutBase64: b64(JPEG) }))],
  ['android-ruutu-screencap-epaonnistuu', GET('/api/android/ruutu'), tyhjaYmp(AR(adb('screencap', { koodi: 1, stderr: 'error: closed' })))],
  ['android-ruutu-muunnos-epaonnistuu', GET('/api/android/ruutu'), tyhjaYmp(AR(adb('screencap', { stdoutBase64: b64(PNG) }), { komento: 'python3', sisaltaa: 'Image', koodi: 1, stderr: 'ModuleNotFoundError: PIL' }))],
  ['android-ui', GET('/api/android/ui'), tyhjaYmp(AR(UI(...KESKUSTELU, NAPPI('Send'), { kuvaus: 'Stop generating response' })))],
  ['android-ui-ei-dumpia', GET('/api/android/ui'), tyhjaYmp(AR(adb('uiautomator dump', { stdout: 'ERROR: could not get idle state.' })))],
  ['android-tuotokset', GET('/api/android/tuotokset'), tyhjaYmp(AR(adb('find', { stdout: '1760000000|1234|/sdcard/Download/raportti.txt\n1760000100|99|/sdcard/Pictures/kuva.png\nroska\n' })))],
  ['android-tuotokset-tyhja', GET('/api/android/tuotokset'), tyhjaYmp(AR())],
  ['android-tuotos', GET('/api/android/tuotos?polku=%2Fsdcard%2FDownload%2Fraportti.txt'), tyhjaYmp(AR(adb('exec-out', { stdoutBase64: b64('raportin sisältö\n') })))],
  ['android-tuotos-vaara-polku', GET('/api/android/tuotos?polku=%2Fdata%2Fdata%2Fsalaisuus.txt'), tyhjaYmp(AR())],
  ['android-tuotos-ei-loydy', GET('/api/android/tuotos?polku=%2Fsdcard%2FDownload%2Fei-ole.txt'), tyhjaYmp(AR(adb('exec-out', { koodi: 1, stderr: 'cat: No such file' })))],
  ['android-tuotos-liian-suuri', GET('/api/android/tuotos?polku=%2Fsdcard%2FMovies%2Fiso.mp4'), tyhjaYmp(AR(adb('exec-out', { koodi: -2 })))],
  ['android-liite', POST('/api/android/liite?nimi=muistio.txt', 'liitteen sisältö'), tyhjaYmp(AR(LIITE_UI))],
  ['android-liite-teksti', POST(`/api/android/liite?nimi=muistio.txt&teksti=${encodeURIComponent('Katso tämä')}`, 'liitteen sisältö'), tyhjaYmp(AR(LIITE_UI))],
  ['android-liite-kuiva', POST('/api/android/liite?nimi=muistio.txt', 'liitteen sisältö'), tyhjaYmp({ ...AR(), android: { kuiva: true } })],
  ['android-liite-ei-liitepainiketta', POST('/api/android/liite?nimi=muistio.txt', 'liitteen sisältö'), tyhjaYmp(AR(UI({ teksti: 'Gemini' })))],
  ['android-liite-ei-tiedostoa-valitsimessa', POST('/api/android/liite?nimi=muistio.txt', 'liitteen sisältö'),
    tyhjaYmp(AR(UI(NAPPI('Add attachments'), { teksti: 'Files', alue: [0, 1500, 500, 1600] })))],
  ['android-liite-push-epaonnistuu', POST('/api/android/liite?nimi=muistio.txt', 'liitteen sisältö'), tyhjaYmp(AR(adb(' push ', { koodi: 1, stderr: 'adb: error: failed to copy' }), LIITE_UI))],
  ['android-liite-tyhja', POST('/api/android/liite?nimi=muistio.txt', ''), tyhjaYmp(AR(LIITE_UI))],
  ['android-liite-teksti-liian-pitka', POST(`/api/android/liite?nimi=muistio.txt&teksti=${'x'.repeat(8001)}`, 'liitteen sisältö'), tyhjaYmp(AR(LIITE_UI))],
  ['android-napauta-kuiva', POST('/api/android/napauta', { x: 0.5, y: 0.25 }), tyhjaYmp({ ...AR(), android: { kuiva: true } })],
  ['android-nappi-kuiva', POST('/api/android/nappi', { nimi: 'koti' }), tyhjaYmp({ ...AR(), android: { kuiva: true } })],

  // linux: tila, käynnistys ja sammutus
  ['linux-tila-linux', GET(LK), tyhjaYmp(LR(...LINUX_PAALLA))],
  ['linux-tila-windows', GET(LK), tyhjaYmp(LR(...WINDOWS_PAALLA))],
  ['linux-tila-windows-wifi', GET(LK), tyhjaYmp(LR(ping('192.0.2.99', 128)))],
  ['linux-tila-sammuksissa', GET(LK), tyhjaYmp(LR(...PC_ALAS))],
  ['linux-kaynnista-linux', POST(`${LK}/kaynnista`), tyhjaYmp(LR(...LINUX_PAALLA))],
  ['linux-kaynnista-windows', POST(`${LK}/kaynnista`), tyhjaYmp(LR(...WINDOWS_PAALLA, SSH_WINDOWS()))],
  ['linux-kaynnista-windows-vaihto-epaonnistuu', POST(`${LK}/kaynnista`), tyhjaYmp(LR(...WINDOWS_PAALLA, SSH_WINDOWS({ koodi: 255, stderr: 'Permission denied (publickey).' })))],
  ['linux-kaynnista-sammuksissa', POST(`${LK}/kaynnista`), tyhjaYmp(LR(herata({ stdout: 'WoL lähetetty\nLinux vastaa 192.0.2.99 (34 s)\n' })))],
  ['linux-kaynnista-sammuksissa-windows-vastaa', POST(`${LK}/kaynnista`), tyhjaYmp(LR(herata({ stdout: 'WoL lähetetty\nWindows vastaa 192.0.2.99 (31 s)\n' }), SSH_WINDOWS()))],
  ['linux-kaynnista-sammuksissa-herata-epaonnistuu', POST(`${LK}/kaynnista`), tyhjaYmp(LR(herata({ koodi: 1, stderr: 'ei vastausta' })))],
  ['linux-kaynnista-toinen-toiminto-kaynnissa', POST(`${LK}/kaynnista`), tyhjaYmp({ ...LR(herata({ stdout: 'Linux vastaa 192.0.2.99 (34 s)\n' })), samanaikainen: { ...POST(`${LK}/kaynnista`), pito: 'python3' } })],
  ['linux-sammuta-linux', POST(`${LK}/sammuta`), tyhjaYmp(LR(...LINUX_PAALLA, SSH_POWEROFF({ koodi: 255, stderr: 'Connection to 192.0.2.99 closed by remote host.' })))],
  ['linux-sammuta-linux-koodi-0', POST(`${LK}/sammuta`), tyhjaYmp(LR(...LINUX_PAALLA, SSH_POWEROFF()))],
  ['linux-sammuta-tunnistusvirhe', POST(`${LK}/sammuta`), tyhjaYmp(LR(...LINUX_PAALLA, SSH_POWEROFF({ koodi: 255, stderr: 'Permission denied (publickey).' })))],
  ['linux-sammuta-sammuksissa', POST(`${LK}/sammuta`), tyhjaYmp(LR(...PC_ALAS))],
  ['linux-sammuta-windows', POST(`${LK}/sammuta`), tyhjaYmp(LR(...WINDOWS_PAALLA))],
  ['linux-sammuta-toinen-toiminto-kaynnissa', POST(`${LK}/sammuta`), tyhjaYmp({ ...LR(herata({ stdout: 'Linux vastaa 192.0.2.99 (34 s)\n' })), samanaikainen: { ...POST(`${LK}/kaynnista`), pito: 'python3' } })],
  ['linux-kaynnista-sammuksissa-kuiva', POST(`${LK}/kaynnista`), tyhjaYmp({ ...LR(), linux: { kuiva: true } })],
  ['linux-kaynnista-windows-kuiva', POST(`${LK}/kaynnista`), tyhjaYmp({ ...LR(...WINDOWS_PAALLA), linux: { kuiva: true } })],
  ['linux-sammuta-kuiva', POST(`${LK}/sammuta`), tyhjaYmp({ ...LR(...LINUX_PAALLA), linux: { kuiva: true } })],
  ['linux-tuntematon-toiminto', POST(`${LK}/ei-ole`), tyhjaYmp(LR())],
];

// ---------- ajo ----------
const alkuSetTimeout = globalThis.setTimeout;
const alkuRandom = Math.random;
let viiveet = null;
// Pitkät odotukset (tauko 1000 ms, Escape + 800 ms) kirjataan ja ohitetaan; lyhyet (http, ajastimet) ajetaan normaalisti.
globalThis.setTimeout = (fn, ms, ...a) => {
  if (viiveet && typeof ms === 'number' && ms >= 100) { viiveet.push(ms); return alkuSetTimeout(fn, 0, ...a); }
  return alkuSetTimeout(fn, ms, ...a);
};

const kirjoitaJsonl = (polku, rivit) => writeFileSync(polku, rivit.map((r) => JSON.stringify(r)).join('\n'));
const syvaKartta = (x, f) => (typeof x === 'string' ? f(x) : Array.isArray(x) ? x.map((y) => syvaKartta(y, f))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, syvaKartta(v, f)])) : x);

function pyyda(portti, { metodi, polku, runko }) {
  return new Promise((ok, ei) => {
    const raaka = typeof runko === 'string';
    const data = runko == null ? null : raaka ? runko : JSON.stringify(runko);
    const r = httpRequest({ host: '127.0.0.1', port: portti, method: metodi, path: polku, headers: {
      authorization: `Bearer ${AVAIN}`, ...(data !== null ? { ...(raaka ? {} : { 'content-type': 'application/json' }), 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const palat = [];
      res.on('data', (p) => palat.push(p));
      res.on('end', () => ok({ status: res.statusCode, tyyppi: String(res.headers['content-type'] ?? ''), levy: String(res.headers['content-disposition'] ?? ''), puskuri: Buffer.concat(palat) }));
    });
    r.on('error', ei);
    r.end(data ?? undefined);
  });
}

// Tiedostot hakemistossa suhteellisina polkuina aakkosjärjestyksessä (kytkinten tila).
function tiedostot(hak, alku = hak) {
  let rivit = [];
  for (const d of readdirSync(hak, { withFileTypes: true })) {
    const p = join(hak, d.name);
    if (d.isDirectory()) rivit = rivit.concat(tiedostot(p, alku));
    else if (!d.name.endsWith('.tmp')) rivit.push({ tiedosto: relative(alku, p), sisalto: readFileSync(p, 'utf8') });
  }
  return rivit.sort((a, b) => a.tiedosto.localeCompare(b.tiedosto));
}

async function ajaTapaus([nimi, pyynto, ymparisto]) {
  const d = mkdtempSync(join(TMP, 't-'));
  const juuri = join(d, 'juuri');
  const chatDir = join(d, 'chat');
  const istunnotDir = join(d, 'istunnot');
  const projektitDir = join(d, 'projektit');
  const tilaDir = join(d, 'asetus-tila');
  const androidDir = join(d, 'android');
  const liitteetDir = join(d, 'liitteet');
  mkdirSync(join(juuri, 'claude/siirto/state'), { recursive: true });
  mkdirSync(istunnotDir);
  mkdirSync(projektitDir);
  mkdirSync(tilaDir);
  const pid = String(process.pid);
  const ymp2 = JSON.parse(JSON.stringify(ymparisto).replaceAll('"<PID>"', pid).replaceAll('<PID>', pid));
  writeFileSync(join(juuri, 'claude/siirto/state/skoopit.json'), JSON.stringify(ymp2.skooppitiedot));
  for (const i of ymp2.istunnot) writeFileSync(join(istunnotDir, i.tiedosto), JSON.stringify(i.sisalto));
  let istunnonTranskripti = null;
  for (const t of ymp2.transkriptit) {
    const dir = join(projektitDir, projektiNimi(t.kohde === 'chat' ? chatDir : t.cwd));
    mkdirSync(dir, { recursive: true });
    kirjoitaJsonl(join(dir, `${t.id}.jsonl`), t.rivit);
    if (t.kohde === 'istunto') istunnonTranskripti = join(dir, `${t.id}.jsonl`);
  }
  for (const t of ymp2.asetuksetTila ?? []) {
    mkdirSync(join(tilaDir, t.tiedosto, '..'), { recursive: true });
    writeFileSync(join(tilaDir, t.tiedosto), t.sisalto);
  }
  const nebiusTiedosto = join(d, 'nebius-avain');
  if (ymp2.nebiusAvain) writeFileSync(nebiusTiedosto, 'koe-nebius-avain-0123456789');

  const ctx = { kutsut: [], pito: null, kentta: '' };
  let siirto = 0; // android-kellon siirto ms
  const sarjat = new Map(); // sääntö → seuraava `jarjestys`-indeksi
  const saanto = (komento, argv) => {
    const rivi = argv.join(' ');
    const s = (ymp2.komennot.vastaukset ?? []).find((x) => x.komento === komento && (x.sisaltaa === undefined || rivi.includes(x.sisaltaa)));
    if (!s) return null;
    if (!s.jarjestys) return s;
    const i = sarjat.get(s) ?? 0;
    sarjat.set(s, Math.min(i + 1, s.jarjestys.length - 1));
    return s.jarjestys[i];
  };
  const OLETUS_KOODI = { ping: 1, ssh: 255 };
  const tulosOlio = (komento, argv, tavuina) => {
    const s = saanto(komento, argv) ?? { koodi: OLETUS_KOODI[komento] ?? 0 };
    const stdout = s.stdoutBase64 !== undefined ? Buffer.from(s.stdoutBase64, 'base64') : Buffer.from(s.stdout ?? '');
    return { koodi: s.koodi ?? 0, stdout: tavuina ? stdout : stdout.toString('utf8'), stderr: s.stderr ?? '' };
  };
  const tulos = (t = {}) => ({ koodi: t.koodi ?? 0, stdout: t.stdout ?? '', stderr: t.stderr ?? '' });
  const kirjaa = (komento, argv, valinnat) => {
    if (komento === 'tmux' && argv[0] === 'list-panes') return;
    const v = {};
    if (valinnat.syote) v.syote = Buffer.isBuffer(valinnat.syote) ? `<${valinnat.syote.length} tavua>` : valinnat.syote;
    if (valinnat.cwd) v.cwd = valinnat.cwd;
    ctx.kutsut.push({ kutsu: [komento, ...argv], valinnat: v });
  };
  const pidaTarvittaessa = async (komento, argv) => {
    const pitoKomento = ymp2.samanaikainen?.pito;
    const osuu = pitoKomento ? komento === pitoKomento : (komento === 'bash' && argv[0].endsWith('autovaihto.sh'));
    if (ctx.pito && !ctx.pito.otettu && osuu) { ctx.pito.otettu = true; ctx.pito.saavutettu(); await ctx.pito.esto; }
  };
  const tmuxVastaus = (avain) => {
    const v = ymp2.tmux[avain];
    if (!Array.isArray(v)) return v ?? '';
    return v.length > 1 ? v.shift() : (v[0] ?? '');
  };
  // Merkkijonotulosten ajaja (viestit, toiminnot, purkajat, linux).
  const aja = async (komento, argv, valinnat = {}) => {
    kirjaa(komento, argv, valinnat);
    if (komento === 'tmux') {
      if (argv[0] === 'send-keys' && ymp2.tmux.vastaanottaa && istunnonTranskripti) {
        const k = argv.slice(argv.indexOf('-t') + 2);
        if (k[0] === 'C-u') ctx.kentta = '';
        else if (k[0] === '-l') ctx.kentta += k[1];
        else if (k[0] === 'Enter' && ctx.kentta) { appendFileSync(istunnonTranskripti, `\n${JSON.stringify({ type: 'user', message: { content: ctx.kentta } })}`); ctx.kentta = ''; }
      }
      return tulos({ stdout: tmuxVastaus(argv[0]) });
    }
    await pidaTarvittaessa(komento, argv);
    if (komento === 'bash' && argv[0].endsWith('autovaihto.sh')) return tulos(ymp2.komennot.autovaihto ?? { stdout: 'UUSI: …\nOK: https://claude.ai/code/session_abc123\n' });
    if (komento === 'node' && argv[0].endsWith('luo-skooppi.mjs')) return tulos(ymp2.komennot['luo-skooppi'] ?? LUO_SKOOPPI);
    if (komento === 'agy') {
      if (!saanto('agy', argv)) throw new Error(`tallenna-lisa: agy-vastaus puuttuu: ${argv.join(' ')}`);
      return tulosOlio('agy', argv, false);
    }
    if (['bash', 'git', 'ping', 'ssh', 'python3'].includes(komento)) return tulosOlio(komento, argv, false);
    throw new Error(`tallenna-lisa: odottamaton komento ${komento} ${argv.join(' ')}`);
  };
  // luoAndroid-ajaja: stdout tavuina.
  const ajaTavut = async (komento, argv, valinnat = {}) => {
    kirjaa(komento, argv, valinnat);
    if (komento !== 'adb' && komento !== 'python3') throw new Error(`tallenna-lisa: odottamaton android-komento ${komento}`);
    return tulosOlio(komento, argv, true);
  };

  const toimintoloki = join(d, 'loki/t.loki');
  const asetukset = {
    juuri, istunnotDir, projektitDir, chatDir, avain: AVAIN, listPanes: '', escapeTauko: undefined,
    toimintoloki, nebiusTiedosto, tilaDir, liitteetDir,
    agyHakemisto: join(d, 'agy'), brainHakemisto: join(d, 'brain'),
  };
  const viestit = luoViestit(asetukset, { aja, android: ymp2.androidMukana ? () => ({}) : null });
  const suorita = luoToiminnot(asetukset, { aja, jonoVali: 0 });
  const purkajat = luoPurkajat({ juuri, paikalliset: async () => [], aja, nebiusTiedosto });
  const kytkimet = luoAsetukset({ hakemisto: tilaDir, loki: toimintoloki });
  const linux = luoLinuxServer({ aja, loki: toimintoloki, kuiva: ymp2.linux?.kuiva === true });
  const android = luoAndroid({
    aja: ajaTavut, loki: toimintoloki, kuiva: ymp2.android?.kuiva === true, tuotoksetDir: androidDir,
    odota: async (ms) => { if (viiveet && ms >= 100) viiveet.push(ms); },
    nyt: () => AIKA0 + siirto,
  });
  // Liite: kuten luoLiitteet (<aika>-<satunnainen>-<nimi>), mutta kiinteä aika ja satunnaisosa.
  const liitteet = async (skooppi, tiedostonimi, req) => {
    const palat = [];
    for await (const p of req) palat.push(p);
    const data = Buffer.concat(palat);
    if (data.length === 0) throw new Hylatty(400, 'liite on tyhjä');
    const hak = join(liitteetDir, siistiNimi(skooppi, 'skooppi'));
    mkdirSync(hak, { recursive: true });
    const polku = join(hak, `20261021T080000-abcdef-${siistiNimi(tiedostonimi, 'liite')}`);
    writeFileSync(polku, data);
    return { polku, koko: data.length };
  };
  // Muut riippuvuudet tyhjinä, ettei oletusarvojen luonti kirjoita mitään (diagnostiikka, lr, kayttoraja, kordinaattori).
  const kasittele = kasittelija(asetukset, suorita, viestit, async () => ({}), liitteet, {}, kytkimet, {}, purkajat, linux, android, async () => ({}), {});
  const palvelin = createServer(kasittele);
  await new Promise((ok) => palvelin.listen(0, '127.0.0.1', ok));
  const portti = palvelin.address().port;
  viiveet = [];
  Math.random = () => 0.5;
  try {
    let pito = null;
    let kesken = null;
    if (ymp2.samanaikainen) {
      let vapauta;
      let saavutettu;
      const saavutettuLupaus = new Promise((ok) => { saavutettu = ok; });
      pito = ctx.pito = { esto: new Promise((ok) => { vapauta = ok; }), saavutettu, otettu: false };
      kesken = pyyda(portti, ymp2.samanaikainen);
      await saavutettuLupaus;
      ctx.kutsut.length = 0; // odotus kattaa vain varsinaisen pyynnön komennot
      viiveet.length = 0;
      pito.vapauta = vapauta;
    }
    const vastaus = await pyyda(portti, pyynto);
    if (pito) { pito.vapauta(); await kesken; }
    const korvaukset = [[androidDir, '<ANDROID>'], [liitteetDir, '<LIITTEET>'], [juuri, '<JUURI>'], [chatDir, '<CHAT>'], [KOTI, '<KOTI>'], [TMP, '<TMP>'], [REPO, '<REPO>']];
    const norm = (x) => syvaKartta(x, (s) => korvaukset.reduce((t, [a, b]) => t.replaceAll(a, b), s));
    const odotus = { status: vastaus.status };
    if (vastaus.tyyppi.includes('ndjson')) odotus.ndjson = vastaus.puskuri.toString('utf8').split('\n').filter(Boolean).map((r) => JSON.parse(r));
    else if (vastaus.tyyppi.includes('json')) odotus.runko = JSON.parse(vastaus.puskuri.toString('utf8'));
    else odotus.runko = { tyyppi: vastaus.tyyppi, base64: vastaus.puskuri.toString('base64'), ...(vastaus.levy ? { nimi: decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(vastaus.levy)?.[1] ?? '') } : {}) };
    odotus.aja = ctx.kutsut.map((k) => k.kutsu);
    if (ctx.kutsut.some((k) => Object.keys(k.valinnat).length)) odotus.ajaValinnat = ctx.kutsut.map((k) => k.valinnat);
    if (viiveet.length) odotus.viiveet = [...viiveet];
    if (pyynto.polku.includes('/asetukset/')) odotus.asetuksetTila = tiedostot(tilaDir);
    if (ymp2.android?.myohemmin) {
      const ennen = ctx.kutsut.length;
      siirto += ymp2.android.myohemmin;
      const nukutettu = await android.nukutaJosHiljaista();
      odotus.myohemmin = { ms: ymp2.android.myohemmin, nukutettu, aja: ctx.kutsut.slice(ennen).map((k) => k.kutsu) };
    }
    return { tapaus: nimi, pyynto, ymparisto, odotus: norm(odotus) };
  } finally {
    viiveet = null;
    Math.random = alkuRandom;
    android.lopeta();
    await new Promise((ok) => palvelin.close(ok));
  }
}

try {
  mkdirSync(TESTIDATA, { recursive: true });
  for (const f of readdirSync(TESTIDATA).filter((x) => OMAT.test(x))) rmSync(join(TESTIDATA, f));
  const nimet = new Set();
  for (const t of tapaukset) {
    if (nimet.has(t[0])) throw new Error(`tapausnimi kahdesti: ${t[0]}`);
    if (!OMAT.test(`${t[0]}.json`)) throw new Error(`tapausnimi ei kuulu lisämoduuleihin: ${t[0]}`);
    nimet.add(t[0]);
    const fixture = await ajaTapaus(t);
    writeFileSync(join(TESTIDATA, `${t[0]}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`${t[0]}: ${fixture.odotus.status}`);
  }
} finally {
  globalThis.setTimeout = alkuSetTimeout;
  rmSync(TMP, { recursive: true, force: true });
}
