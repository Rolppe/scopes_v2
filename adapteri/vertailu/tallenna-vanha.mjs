#!/usr/bin/env node
// Vanhan toimintokäytöksen tallennin (T-63-G, ARK-16, S-10). Ainoa adapterin tiedosto, joka saa tuoda scopes/-polusta.
// Ajetaan käsin (ei portissa): node scopes2/adapteri/vertailu/tallenna-vanha.mjs
//
// Ajaa vanhan palvelun oikean käsittelijän (scopes/palvelu/palvelin.mjs kasittelija) in-process http-palvelimella portissa 0,
// jossa luoViestit ja luoToiminnot saavat tallentavan mock-`aja`n. Ei oikeaa tmux:ia, ei 8787:ää, ei verkkoa; kaikki tila
// (juuri, istunnot, transkriptit, chat-hakemisto, HOME) on väliaikaisessa hakemistossa. Kirjoittaa
// testidata/toiminnot/<reitti>-<tapaus>.json:
//   { "tapaus", "pyynto": { "metodi", "polku", "runko" },
//     "ymparisto": { "skooppitiedot", "istunnot", "transkriptit", "tmux", "komennot", "samanaikainen"? },
//     "odotus": { "status", "runko" | "ndjson", "aja": [[komento, ...argv]], "ajaValinnat"?, "viiveet"? } }
//
// ymparisto:
//   skooppitiedot   claude/siirto/state/skoopit.json: skooppi -> rekisteritiedostot
//   istunnot        [{ tiedosto, sisalto }] = <istunnotDir>/<tiedosto> (Claude Coden elävä istunto); "<PID>" = testiprosessin pid
//   transkriptit    [{ kohde: "istunto", cwd, id, rivit }] = projektitDir/<projektiNimi(cwd)>/<id>.jsonl;
//                   [{ kohde: "chat", id, rivit }] = chatin projektikansio; rivit = JSON-oliot, yksi per rivi
//   tmux            mockin vastaukset (stdout): "display-message" (ruudun pid; "<PID>" = oikea), "capture-pane", "list-panes";
//                   "vastaanottaa": true = send-keys Enter liittää kirjoitetun tekstin transkriptiin käyttäjän viestinä (V-305)
//   komennot        muiden komentojen vastaukset { koodi, stdout, stderr }: "autovaihto", "pura-malliton --perhe",
//                   "pura-malliton"; "claude": { koodi, stdout: [rivit] } (stream-json)
//   samanaikainen   { metodi, polku, runko }: tämä pyyntö on kesken (autovaihto-kutsu odottaa), kun varsinainen pyyntö tehdään
//   komennot.agy    (T-68, purkajat-*) `agy models` -vastaus { koodi, stdout, stderr }; puuttuu = agy ei käynnisty (koodi 127)
//   nebiusAvain     (T-68, purkajat-*) true = Nebius-avaintiedosto on olemassa (purkajalista näyttää Nebius-mallit)
// Uudelleenajo poistaa ja kirjoittaa vain tämän tiedoston tapausten fixturet (T-68): tallenna-lisa.mjs:n ja muiden fixturet säilyvät.
// odotus.aja: vanhan koodin ajamat komennot järjestyksessä ilman `tmux list-panes` -hakuja (kuten vanhat testit). Polut:
//   <JUURI> repo, <KOTI> HOME, <CHAT> chatin työhakemisto, <TMP> muu väliaikainen. odotus.ajaValinnat: rinnakkaistaulukko
//   { syote?, cwd? } (vain jos jollain kutsulla on). odotus.viiveet: setTimeout-viiveet >= 100 ms (esim. Escape + 800).
// Deterministinen: kiinteät tunnisteet ja aikaleimat syötteissä, sleep-viiveet kirjataan eikä odoteta, polut paikkamerkeillä.

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { request as httpRequest, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTIDATA = fileURLToPath(new URL('../testidata/toiminnot/', import.meta.url));
const AVAIN = 'tallenna-vanha-testiavain-0123456789abcdef';

// HOME ennen vanhojen moduulien tuontia: homedir() luetaan myös moduulien latauksessa.
const TMP = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'tallenna-vanha-')));
const KOTI = join(TMP, 'koti');
mkdirSync(KOTI, { recursive: true });
process.env.HOME = KOTI;
for (const k of ['SCOPES_JUURI', 'CLAUDE_ISTUNNOT_DIR', 'CLAUDE_PROJEKTIT_DIR', 'SCOPES_CHAT_DIR', 'AGY_BIN']) delete process.env[k];

const vanha = (p) => import(new URL(`../../../scopes/palvelu/${p}`, import.meta.url));
const { kasittelija } = await vanha('palvelin.mjs');
const { luoToiminnot } = await vanha('toiminnot.mjs');
const { luoViestit } = await vanha('viestit.mjs');
const { luoPurkajat } = await vanha('purkajat.mjs');
const { projektiNimi } = await vanha('lahteet.mjs');

// ---------- syötteet (kiinteät) ----------
const ID = '38c487b9-3c36-4723-b2af-5f07b106c172';
const ID2 = '00000000-0000-4000-8000-000000000002';
const TUNTEMATON_ID = '00000000-0000-4000-8000-000000000009';
const PID = '<PID>';
const TMUX = 'siirto-a-1:@1.%5';
const teksti = (t, aika, extra = {}) => ({ type: 'assistant', timestamp: aika, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: t }] }, ...extra });
const kayttaja = (t, aika) => ({ type: 'user', timestamp: aika, message: { content: t } });
const TR = [kayttaja('/pura a', '2026-10-21T08:00:00.000Z'), teksti('Purku valmis.', '2026-10-21T08:00:01.000Z')];
const KYSYMYS = { type: 'assistant', timestamp: '2026-10-21T08:00:02.000Z', message: { content: [
  { type: 'tool_use', id: 'k1', name: 'AskUserQuestion', input: { questions: [{ question: 'Mitä tehdään?', header: 'Jatko', multiSelect: false, options: [{ label: 'Aloita', description: 'paketti' }, { label: 'Ei mitään' }] }] } }] } };
const TR_KYSYMYS = [...TR, KYSYMYS];
const TR_PAKATTU = [kayttaja('/pakkaa', '2026-10-21T08:00:00.000Z'), teksti('PAKKAUS: vahvistettu — commit abc1234', '2026-10-21T08:00:01.000Z')];
const istunto = (tila, extra = {}) => ({ tiedosto: `${PID}.json`, sisalto: { pid: PID, sessionId: 's1', cwd: '/x', name: 'a', status: tila, tmux: TMUX, ...extra } });
const ymp = ({ tila = 'idle', kysely = false, istunnot = true, transkripti = TR, ruudunPid = PID, tmux = {}, komennot = {}, ...muut } = {}) => ({
  skooppitiedot: { a: ['R.md'], b: ['R.md'] },
  istunnot: istunnot ? [istunto(tila, kysely ? { waitingFor: 'input needed' } : {})] : [],
  transkriptit: transkripti ? [{ kohde: 'istunto', cwd: '/x', id: 's1', rivit: transkripti }] : [],
  tmux: { 'display-message': `${ruudunPid}\n`, 'capture-pane': '', 'list-panes': '', ...tmux },
  komennot,
  ...muut,
});
const POST = (polku, runko = {}) => ({ metodi: 'POST', polku, runko });
const GET = (polku) => ({ metodi: 'GET', polku, runko: null });

// claude -p --output-format stream-json: ajattelulohko, tekstilohko kahdessa palassa, ei-JSON-rivi ja result-rivi.
const sevt = (event) => JSON.stringify({ type: 'stream_event', event });
const CLAUDE_VIRTA = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: ID }),
  sevt({ type: 'content_block_start', content_block: { type: 'thinking' } }),
  sevt({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'mietin' } }),
  sevt({ type: 'content_block_start', content_block: { type: 'text' } }),
  sevt({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'h' } }),
  sevt({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ei' } }),
  'ei json',
  JSON.stringify({ type: 'result', subtype: 'success', result: 'hei', session_id: ID, total_cost_usd: 0.01, is_error: false }),
];
const CHAT = { komennot: { claude: { koodi: 0, stdout: CLAUDE_VIRTA } } };
// purkajat (T-68): `agy models` -tuloste (otsikkorivi ja kaksi mallia) ja perhetunnistuksen vastaukset.
const AGY_MODELS = { koodi: 0, stdout: 'Fetching available models...\ngemini-9-pro\tGemini 9 Pro\nclaude-x-1\tClaude X 1\n', stderr: '' };
const PERHE = { 'pura-malliton --perhe': { koodi: 0, stdout: 'PERHE: kyllä\n', stderr: '' }, 'pura-malliton': { koodi: 0, stdout: 'KIRJOITETTU: x\n', stderr: '' } };
const EI_PERHE = { 'pura-malliton --perhe': { koodi: 1, stdout: 'PERHE: ei\n', stderr: '' } };
const CHAT_HISTORIA = [
  { kohde: 'chat', id: ID, rivit: [kayttaja('eka kysymys', '2026-10-21T09:00:00.000Z'),
    { type: 'assistant', timestamp: '2026-10-21T09:00:01.000Z', message: { model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'vastaus' }] } }] },
  { kohde: 'chat', id: ID2, rivit: [kayttaja('toinen', '2026-10-21T09:05:00.000Z'), teksti('moi', '2026-10-21T09:05:01.000Z')] },
];

// ---------- tapaukset ----------
const A = '/api/skoopit/a';
const tapaukset = [
  // viesti
  ['viesti-ok', POST(`${A}/viesti`, { teksti: 'Hei\nmaailma' }), ymp({ tmux: { vastaanottaa: true } })],
  ['viesti-kysymys-auki', POST(`${A}/viesti`, { teksti: 'Aloita' }), ymp({ tila: 'waiting', kysely: true, transkripti: TR_KYSYMYS, tmux: { vastaanottaa: true } })],
  ['viesti-vaara-ruutu', POST(`${A}/viesti`, { teksti: 'Hei' }), ymp({ ruudunPid: '424242' })],
  ['viesti-ei-istuntoa', POST('/api/skoopit/b/viesti', { teksti: 'Hei' }), ymp()],
  ['viesti-liian-pitka', POST(`${A}/viesti`, { teksti: 'x'.repeat(8001) }), ymp()],
  ['stream-ok', POST(`${A}/stream`, { teksti: 'Hei' }), ymp({ tmux: { vastaanottaa: true } })],
  // stop ja kysymys-pois
  ['stop-kiireinen', POST(`${A}/stop`), ymp({ tila: 'busy' })],
  ['stop-vapaa', POST(`${A}/stop`), ymp({ tila: 'idle' })],
  ['kysymys-pois-ok', POST(`${A}/kysymys-pois`), ymp({ tila: 'waiting', kysely: true, transkripti: TR_KYSYMYS })],
  ['kysymys-pois-ei-kysymysta', POST(`${A}/kysymys-pois`), ymp({ tila: 'idle' })],
  // pakkaa, automaattisiirto, herata, herata-pois: vapaa, kiireinen (jono; pakkaa hylkää) ja kysymys auki
  ...[['pakkaa', 'pakkaa'], ['automaattisiirto', 'automaattisiirto'], ['herata', 'herata'], ['herata-pois', 'herata-pois']].flatMap(([nimi, reitti]) => [
    [`${nimi}-vapaa`, POST(`${A}/${reitti}`), ymp({ tila: 'idle' })],
    [`${nimi}-kiireinen`, POST(`${A}/${reitti}`), ymp({ tila: 'busy' })],
    [`${nimi}-kysymys-auki`, POST(`${A}/${reitti}`), ymp({ tila: 'waiting', kysely: true, transkripti: TR_KYSYMYS })],
  ]),
  // pura
  ['pura-perhe', POST('/api/skoopit/b/pura'), ymp({ istunnot: false, transkripti: null, komennot: {
    'pura-malliton --perhe': { koodi: 0, stdout: 'PERHE: kyllä\n', stderr: '' }, 'pura-malliton': { koodi: 0, stdout: 'KIRJOITETTU: x\n', stderr: '' } } })],
  ['pura-perhe-pakattu-suljetaan', POST(`${A}/pura`), ymp({ transkripti: TR_PAKATTU, komennot: {
    'pura-malliton --perhe': { koodi: 0, stdout: 'PERHE: kyllä\n', stderr: '' }, 'pura-malliton': { koodi: 0, stdout: 'KIRJOITETTU: x\n', stderr: '' } } })],
  ['pura-ei-perhe', POST('/api/skoopit/b/pura'), ymp({ istunnot: false, transkripti: null, komennot: { 'pura-malliton --perhe': { koodi: 1, stdout: 'PERHE: ei\n', stderr: '' } } })],
  ['pura-toinen-toiminto-kaynnissa', POST('/api/skoopit/b/pura'), ymp({ istunnot: false, transkripti: null,
    komennot: { 'pura-malliton --perhe': { koodi: 1, stdout: 'PERHE: ei\n', stderr: '' } }, samanaikainen: POST('/api/skoopit/b/pura') })],
  // purkajat (T-68): GET /api/purkajat ja purun valintojen tarkistus (purkajat.mjs lista ja tarkista) sekä purun skriptivirheet
  ['purkajat-lista', GET('/api/purkajat'), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS } })],
  ['purkajat-lista-nebius', GET('/api/purkajat'), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS }, nebiusAvain: true })],
  ['purkajat-lista-agy-ei-vastaa', GET('/api/purkajat'), ymp({ istunnot: false, transkripti: null, komennot: { agy: { koodi: 1, stdout: '', stderr: 'ei kirjautunut\n' } } })],
  ['purkajat-virheellinen-malli', POST('/api/skoopit/b/pura', { malli: 'ei-ole' }), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS, ...EI_PERHE } })],
  ['purkajat-virheellinen-purkaja', POST('/api/skoopit/b/pura', { purkaja: 'claude-cli:ei-ole' }), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS, ...EI_PERHE } })],
  ['purkajat-ei-merkkijono', POST('/api/skoopit/b/pura', { malli: 5 }), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS, ...EI_PERHE } })],
  ['purkajat-pura-valinnat', POST('/api/skoopit/b/pura', { purkaja: 'claude-agent:siirtaja-sonnet', malli: 'claude-sonnet-5-5' }), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS, ...EI_PERHE } })],
  ['purkajat-pura-agy-lyhenne', POST('/api/skoopit/b/pura', { purkaja: 'gemini-9-pro' }), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS, ...EI_PERHE } })],
  ['purkajat-pura-agy-perhe', POST('/api/skoopit/b/pura', { malli: 'agy/gemini-9-pro' }), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS, ...PERHE,
    autovaihto: { koodi: 0, stdout: 'OK: agy tmux siirto-b-1\n', stderr: '' } } })],
  ['purkajat-pura-agy-ei-perhe', POST('/api/skoopit/b/pura', { malli: 'agy/gemini-9-pro' }), ymp({ istunnot: false, transkripti: null, komennot: { agy: AGY_MODELS, ...EI_PERHE } })],
  ['purkajat-pura-perhe-tunnistus-epaonnistuu', POST(`${A}/pura`), ymp({ transkripti: TR_PAKATTU, komennot: { 'pura-malliton --perhe': { koodi: 2, stdout: '', stderr: 'rivi 1\nskooppikartta rikki\n' } } })],
  ['purkajat-pura-malliton-epaonnistuu', POST(`${A}/pura`), ymp({ transkripti: TR_PAKATTU, komennot: { ...PERHE, 'pura-malliton': { koodi: 3, stdout: '', stderr: 'REKISTERI puuttuu\n' } } })],
  ['purkajat-pura-malliton-varoitus', POST(`${A}/pura`), ymp({ transkripti: TR_PAKATTU, komennot: { ...PERHE, 'pura-malliton': { koodi: 4, stdout: 'KIRJOITETTU: x\n', stderr: 'VAROITUS: y\n' } } })],
  ['purkajat-pura-autovaihto-epaonnistuu', POST(`${A}/pura`), ymp({ transkripti: TR_PAKATTU, komennot: { ...EI_PERHE, autovaihto: { koodi: 1, stdout: '', stderr: 'tmux ei käynnisty\n' } } })],
  ['purkajat-pura-kaynnissa-oleva', POST(`${A}/pura`), ymp({ komennot: EI_PERHE })],
  ['purkajat-pura-pakattu-varattu', POST(`${A}/pura`), ymp({ tila: 'busy', transkripti: TR_PAKATTU, komennot: EI_PERHE })],
  ['purkajat-pura-vaara-ruutu', POST(`${A}/pura`), ymp({ transkripti: TR_PAKATTU, ruudunPid: '424242', komennot: EI_PERHE })],
  ['purkajat-pura-tuntematon-skooppi', POST('/api/skoopit/ei-ole/pura'), ymp({ istunnot: false, transkripti: null, komennot: EI_PERHE })],
  // chat (claude-tausta mockina)
  ['chat-ok', POST('/api/chat', { agentti: 'claude-haiku-5-5', viesti: 'moi; rm -rf /' }), ymp({ istunnot: false, transkripti: null, ...CHAT })],
  ['chat-jatko', POST('/api/chat', { agentti: 'claude-opus-5-5', viesti: 'jatka', keskustelu: ID }), ymp({ istunnot: false, transkripti: null, ...CHAT })],
  ['chat-virta', POST('/api/chat/virta', { agentti: 'claude-haiku-5-5', viesti: 'moi' }), ymp({ istunnot: false, transkripti: null, ...CHAT })],
  ['chat-vaara-agentti', POST('/api/chat', { agentti: 'ei-ole', viesti: 'moi' }), ymp({ istunnot: false, transkripti: null, ...CHAT })],
  ['chat-viesti-puuttuu', POST('/api/chat', { agentti: 'claude-haiku-5-5', viesti: ' ' }), ymp({ istunnot: false, transkripti: null, ...CHAT })],
  ['chat-kaynnissa-ei-ajoa', GET('/api/chat/kaynnissa'), ymp({ istunnot: false, transkripti: null })],
  ['chat-stop-ei-ajoa', POST('/api/chat/stop'), ymp({ istunnot: false, transkripti: null })],
  ['chat-keskustelut-lista', GET('/api/chat/keskustelut'), ymp({ istunnot: false, transkripti: null, transkriptit: CHAT_HISTORIA })],
  ['chat-keskustelut-yksi', GET(`/api/chat/keskustelut/${ID}`), ymp({ istunnot: false, transkripti: null, transkriptit: CHAT_HISTORIA })],
  ['chat-keskustelut-tuntematon', GET(`/api/chat/keskustelut/${TUNTEMATON_ID}`), ymp({ istunnot: false, transkripti: null, transkriptit: CHAT_HISTORIA })],
  ['chat-keskustelut-vaara-tunnus', GET('/api/chat/keskustelut/ei-tunnus'), ymp({ istunnot: false, transkripti: null, transkriptit: CHAT_HISTORIA })],
];

// ---------- ajo ----------
const alkuSetTimeout = globalThis.setTimeout;
let viiveet = null;
// Pitkät odotukset (Escape + 800 ms, perillä-väli) kirjataan ja ohitetaan; lyhyet (http, ajastimet) ajetaan normaalisti.
globalThis.setTimeout = (fn, ms, ...a) => {
  if (viiveet && typeof ms === 'number' && ms >= 100) { viiveet.push(ms); return alkuSetTimeout(fn, 0, ...a); }
  return alkuSetTimeout(fn, ms, ...a);
};

const kirjoitaJsonl = (polku, rivit) => writeFileSync(polku, rivit.map((r) => JSON.stringify(r)).join('\n'));
const syvaKartta = (x, f) => (typeof x === 'string' ? f(x) : Array.isArray(x) ? x.map((y) => syvaKartta(y, f))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, syvaKartta(v, f)])) : x);

function pyyda(portti, { metodi, polku, runko }) {
  return new Promise((ok, ei) => {
    const data = runko == null ? null : JSON.stringify(runko);
    const r = httpRequest({ host: '127.0.0.1', port: portti, method: metodi, path: polku, headers: {
      authorization: `Bearer ${AVAIN}`, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (p) => { t += p; });
      res.on('end', () => ok({ status: res.statusCode, tyyppi: String(res.headers['content-type'] ?? ''), teksti: t }));
    });
    r.on('error', ei);
    r.end(data ?? undefined);
  });
}

async function ajaTapaus([nimi, pyynto, ymparisto]) {
  const d = mkdtempSync(join(TMP, 't-'));
  const juuri = join(d, 'juuri');
  const chatDir = join(d, 'chat');
  const istunnotDir = join(d, 'istunnot');
  const projektitDir = join(d, 'projektit');
  mkdirSync(join(juuri, 'claude/siirto/state'), { recursive: true });
  mkdirSync(istunnotDir);
  mkdirSync(projektitDir);
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

  const ctx = { kutsut: [], pito: null, kentta: '' };
  const tulos = (t = {}) => ({ koodi: t.koodi ?? 0, stdout: t.stdout ?? '', stderr: t.stderr ?? '' });
  const aja = async (komento, argv, valinnat = {}) => {
    if (!(komento === 'tmux' && argv[0] === 'list-panes')) ctx.kutsut.push({ kutsu: [komento, ...argv], valinnat: { ...(valinnat.syote ? { syote: valinnat.syote } : {}), ...(valinnat.cwd ? { cwd: valinnat.cwd } : {}) } });
    const tm = ymp2.tmux;
    if (komento === 'tmux') {
      if (argv[0] === 'send-keys' && tm.vastaanottaa && istunnonTranskripti) {
        const k = argv.slice(argv.indexOf('-t') + 2);
        if (k[0] === 'C-u') ctx.kentta = '';
        else if (k[0] === '-l') ctx.kentta += k[1];
        else if (k[0] === 'Enter' && ctx.kentta) { appendFileSync(istunnonTranskripti, `\n${JSON.stringify({ type: 'user', message: { content: ctx.kentta } })}`); ctx.kentta = ''; }
      }
      return tulos({ stdout: tm[argv[0]] ?? '' });
    }
    if (komento === 'bash' && argv[0].endsWith('autovaihto.sh')) {
      if (ctx.pito && !ctx.pito.otettu) { ctx.pito.otettu = true; ctx.pito.saavutettu(); await ctx.pito.esto; }
      return tulos(ymp2.komennot.autovaihto ?? { stdout: 'UUSI: …\nOK: https://claude.ai/code/session_REDACTED\n' });
    }
    if (komento === 'node' && argv[0].endsWith('pura-malliton.mjs')) {
      return tulos(ymp2.komennot[argv[1] === '--perhe' ? 'pura-malliton --perhe' : 'pura-malliton'] ?? { koodi: 1 });
    }
    if (komento === 'agy') return tulos(ymp2.komennot.agy ?? { koodi: 127, stderr: 'agy: komentoa ei löydy' });
    if (komento === 'claude') {
      const c = ymp2.komennot.claude ?? { koodi: 1, stderr: 'ei vastausta' };
      for (const r of c.stdout ?? []) valinnat.riville?.(r);
      return tulos({ ...c, stdout: (c.stdout ?? []).map((r) => `${r}\n`).join('') });
    }
    throw new Error(`tallenna-vanha: odottamaton komento ${komento} ${argv.join(' ')}`);
  };

  const asetukset = {
    juuri, istunnotDir, projektitDir, chatDir, avain: AVAIN, listPanes: '', escapeTauko: undefined,
    toimintoloki: join(d, 'loki/t.loki'), nebiusTiedosto: join(d, 'ei-nebius-avainta'),
    agyHakemisto: join(d, 'agy'), brainHakemisto: join(d, 'brain'),
  };
  const viestit = luoViestit(asetukset, { aja, android: null });
  const suorita = luoToiminnot(asetukset, { aja, jonoVali: 0 });
  if (ymp2.nebiusAvain) writeFileSync(asetukset.nebiusTiedosto, 'avain\n');
  const purkajat = luoPurkajat({ juuri, paikalliset: async () => [], aja, nebiusTiedosto: asetukset.nebiusTiedosto });
  // Muut riippuvuudet tyhjinä, ettei oletusarvojen luonti kirjoita mitään (diagnostiikka, lr, android, linux, kytkimet).
  const kasittele = kasittelija(asetukset, suorita, viestit, () => ({}), async () => ({}), {}, {}, {}, purkajat, {}, {}, async () => ({}), {});
  const palvelin = createServer(kasittele);
  await new Promise((ok) => palvelin.listen(0, '127.0.0.1', ok));
  const portti = palvelin.address().port;
  viiveet = [];
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
    const korvaukset = [[juuri, '<JUURI>'], [chatDir, '<CHAT>'], [KOTI, '<KOTI>'], [TMP, '<TMP>']];
    const norm = (x) => syvaKartta(x, (s) => korvaukset.reduce((t, [a, b]) => t.replaceAll(a, b), s));
    const odotus = { status: vastaus.status };
    if (vastaus.tyyppi.includes('ndjson')) odotus.ndjson = vastaus.teksti.split('\n').filter(Boolean).map((r) => JSON.parse(r));
    else odotus.runko = JSON.parse(vastaus.teksti);
    odotus.aja = ctx.kutsut.map((k) => k.kutsu);
    if (ctx.kutsut.some((k) => Object.keys(k.valinnat).length)) odotus.ajaValinnat = ctx.kutsut.map((k) => k.valinnat);
    if (viiveet.length) odotus.viiveet = [...viiveet];
    return { tapaus: nimi, pyynto, ymparisto, odotus: norm(odotus) };
  } finally {
    viiveet = null;
    await new Promise((ok) => palvelin.close(ok));
  }
}

try {
  mkdirSync(TESTIDATA, { recursive: true });
  const omat = new Set(tapaukset.map((t) => `${t[0]}.json`));
  for (const f of readdirSync(TESTIDATA).filter((x) => omat.has(x))) rmSync(join(TESTIDATA, f));
  const nimet = new Set();
  for (const t of tapaukset) {
    if (nimet.has(t[0])) throw new Error(`tapausnimi kahdesti: ${t[0]}`);
    nimet.add(t[0]);
    const fixture = await ajaTapaus(t);
    writeFileSync(join(TESTIDATA, `${t[0]}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`${t[0]}: ${fixture.odotus.status}`);
  }
} finally {
  globalThis.setTimeout = alkuSetTimeout;
  rmSync(TMP, { recursive: true, force: true });
}
