// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/chat.test.mjs
// T-69 (ARK-16, S-10): chat. Jokainen testidata/toiminnot/chat-*.json ajetaan oikean HTTP-toimintopalvelimen (portti 0) läpi
// ja verrataan fixtureen (status, runko tai NDJSON, argv, ajaValinnat {syote, cwd}, viiveet). Omat testit: virran katkeaminen ja
// GET /api/chat/kaynnissa -liittyminen, stop, liityttävyys LOPPUTULOS_MS ajan, virhe ennen agentin käynnistystä, keskusteluhistoria
// sekä paikallinen malli, Nebius, agy ja Gemini mock-taustoilla.
// EI oikeita claude-, ssh-, Nebius-, Gemini-, agy- eikä LM Studio -kutsuja: kaikki ulkoinen kulkee testin omien ymp.aja- ja
// ymp.android-mockien kautta, ja mock kaatuu odottamattomaan komentoon. Nebius-avain on tämän testin oma keksitty tiedosto.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projektiNimi } from '../vanhasta/lahteet.mjs';
import { LOPPUTULOS_MS, REITIT, lmsLataa } from './chat.mjs';
import { luoToimintopalvelin } from './palvelin.mjs';
import { KAIKKI, toteutetut } from './reitit.mjs';
import { TMP, ajaFixture, avaaVirta, avainTiedosto, lataaFixturet, pyyda, vertaaFixtureen } from './testiapurit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

const ID = '38c487b9-3c36-4723-b2af-5f07b106c172';

// ---------- fixturet ----------
const fixturet = lataaFixturet(/^chat-/);

// Fixturen ymparisto asettaa chatin hakemistot ajaFixturen kokoamaan hakemistoon d: projektit = d/projektit, chat = d/chat.
const fixtureYmp = (reitit) => reitit.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, {
  ...ymp, chatDir: join(dirname(ymp.projektitDir), 'chat'), nebiusTiedosto: join(dirname(ymp.projektitDir), 'nebius-avain-ei-ole') }) }));

test('reitit: kuusi chat-reittiä toteutettu ja terveyslistalla', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['POST /api/chat', 'POST /api/chat/virta', 'GET /api/chat/kaynnissa',
    'POST /api/chat/stop', 'GET /api/chat/keskustelut', 'GET /api/chat/keskustelut/*']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  for (const r of REITIT) assert.ok(toteutetut(KAIKKI).includes(`${r.metodi} ${r.kuvio}`));
});

test('fixturet: jokainen chat-ryhmä on katettu', () => {
  const nimet = fixturet.map((f) => f.tapaus);
  for (const p of ['chat-ok', 'chat-jatko', 'chat-virta', 'chat-vaara-agentti', 'chat-viesti-puuttuu', 'chat-kaynnissa-ei-ajoa', 'chat-stop-ei-ajoa',
    'chat-keskustelut-lista', 'chat-keskustelut-yksi', 'chat-keskustelut-tuntematon', 'chat-keskustelut-vaara-tunnus']) assert.ok(nimet.includes(p), `puuttuu: ${p}`);
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const { havainto } = await ajaFixture(fix, { reitit: fixtureYmp(REITIT) });
    vertaaFixtureen(fix, havainto);
  });
}

// ---------- omat testit: mock-taustat ----------
const lukko = () => { let auki; const lupaus = new Promise((ok) => { auki = ok; }); return { lupaus, auki }; };
const abortattu = (signal) => new Promise((ok) => { if (signal?.aborted) ok(); else signal?.addEventListener('abort', () => ok(), { once: true }); });

const init = (id = ID) => JSON.stringify({ type: 'system', subtype: 'init', session_id: id });
const lohko = () => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
const delta = (t) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const tulosRivi = (teksti, id = ID, kustannus = 0.02) => JSON.stringify({ type: 'result', subtype: 'success', result: teksti, session_id: id, total_cost_usd: kustannus, is_error: false });

// Tallentava aja: kasittelijat[komento](argv, valinnat) → { koodi, stdout, stderr }; muu komento kaataa testin (ei oikeita kutsuja).
function luoAja(kasittelijat) {
  const kutsut = [];
  const aja = async (komento, argv, valinnat = {}) => {
    kutsut.push({ komento, argv, valinnat });
    const k = kasittelijat[komento];
    if (!k) throw new Error(`chat.test: odottamaton komento ${komento} ${argv.join(' ')}`);
    return { koodi: 0, stdout: '', stderr: '', ...await k(argv, valinnat, kutsut.length) };
  };
  return { aja, kutsut };
}

// Palvelin yhdellä chat-hakemistolla; jokainen testi saa oman tilan (chatDir = tila-avain).
async function kayta({ aja, ymp = {}, nyt = { ms: 1_000_000 } }) {
  const d = mkdtempSync(join(TMP, 'c-'));
  const omat = { chatDir: join(d, 'chat'), projektitDir: join(d, 'projektit'), nebiusTiedosto: join(d, 'nebius-avain'), kello: () => nyt.ms, ...ymp };
  mkdirSync(omat.projektitDir);
  const loki = [];
  const palvelin = luoToimintopalvelin({
    portti: 0, avainTiedosto, juuri: join(d, 'juuri'), tila: join(d, 'tila'), aja, loki: (rivi) => loki.push(rivi), koukut: [],
    reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, y) => r.kasittele(req, res, osat, { ...y, ...omat }) })),
  });
  const portti = await palvelin.kuuntele();
  return { portti, d, ymp: omat, loki, nyt, sulje: () => palvelin.sulje() };
}
const json = (v) => JSON.parse(v.teksti);
const POST = (polku, runko) => ({ metodi: 'POST', polku, runko });
const GET = (polku) => ({ metodi: 'GET', polku, runko: null });

// Kaksivaiheinen claude: kaksi tekstipalaa, sitten odotus (portti1), kolmas pala, odotus (portti2 tai pysäytys), tulos.
function hidasClaude({ vastaus = 'abc', portti1, portti2 }) {
  return async (argv, v) => {
    v.riville(init());
    v.riville(lohko());
    v.riville(delta('a'));
    v.riville(delta('b'));
    await Promise.race([portti1.lupaus, abortattu(v.signal)]);
    if (v.signal.aborted) return { koodi: -1 };
    v.riville(delta('c'));
    await Promise.race([portti2.lupaus, abortattu(v.signal)]);
    if (v.signal.aborted) return { koodi: -1 };
    return { stdout: [init(), tulosRivi(vastaus)].join('\n') + '\n' };
  };
}

test('virta: ensimmäinen rivi tulee ennen kuin tausta päättyy; yhteyden katketessa agentti jatkaa ja kaynnissa liittyy (ensin teksti yhtenä palana, sitten loput)', async () => {
  const portti1 = lukko();
  const portti2 = lukko();
  const { aja } = luoAja({ claude: hidasClaude({ portti1, portti2 }) });
  const s = await kayta({ aja });
  try {
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'claude-haiku-5-5', viesti: 'moi' }));
    assert.equal(virta.status, 200);
    assert.match(virta.tyyppi, /application\/x-ndjson/);
    // Tausta on kesken (portti1 kiinni), mutta kaksi ensimmäistä riviä on jo perillä: ei puskurointia.
    assert.deepEqual(await virta.seuraava(), { tyyppi: 'pala', teksti: 'a' });
    assert.deepEqual(await virta.seuraava(), { tyyppi: 'pala', teksti: 'b' });
    virta.sulje(); // puhelimen näyttölukko
    const liity = await avaaVirta(s.portti, GET('/api/chat/kaynnissa'));
    assert.equal(liity.status, 200);
    assert.deepEqual(await liity.seuraava(), { tyyppi: 'pala', teksti: 'ab' }, 'tähän asti kirjoitettu teksti yhtenä palana');
    portti1.auki();
    assert.deepEqual(await liity.seuraava(), { tyyppi: 'pala', teksti: 'c' });
    // Toinen liittyjä saman ajon aikana saa kertyneen tekstin 'abc' yhtenä palana ja loput samaan tahtiin.
    const toinen = await avaaVirta(s.portti, GET('/api/chat/kaynnissa'));
    assert.deepEqual(await toinen.seuraava(), { tyyppi: 'pala', teksti: 'abc' });
    portti2.auki();
    const valmis = { tyyppi: 'valmis', vastaus: 'abc', keskustelu: ID, agentti: 'claude-haiku-5-5', kustannus: 0.02 };
    assert.deepEqual(await liity.seuraava(), valmis);
    assert.equal(await liity.seuraava(), null);
    assert.deepEqual(await toinen.seuraava(), valmis);
    assert.equal(await toinen.seuraava(), null);
  } finally { await s.sulje(); }
});

test('stop: käynnissä oleva virta katkeaa ja valmis-rivi tuo osittaisen vastauksen (keskeytetty); lokiin chat-stop', async () => {
  const portti1 = lukko();
  const portti2 = lukko();
  const { aja } = luoAja({ claude: hidasClaude({ portti1, portti2 }) });
  const s = await kayta({ aja });
  try {
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'claude-opus-5-5', viesti: 'pitkä' }));
    await virta.seuraava();
    await virta.seuraava();
    const stop = await pyyda(s.portti, POST('/api/chat/stop', {}));
    assert.deepEqual([stop.status, json(stop)], [200, { ok: true }]);
    assert.deepEqual(await virta.seuraava(), { tyyppi: 'valmis', vastaus: 'ab', keskustelu: ID, agentti: 'claude-opus-5-5', kustannus: null, keskeytetty: true });
    assert.equal(await virta.seuraava(), null);
    assert.deepEqual(s.loki.map((r) => r.toiminto), ['chat-stop']);
    // Agentin nimi talletettiin keskeytetyllekin keskustelulle.
    assert.deepEqual(JSON.parse(readFileSync(join(s.ymp.chatDir, 'agentit.json'), 'utf8')), { [ID]: 'claude-opus-5-5' });
    // Ajo ei ole enää käynnissä: toinen stop on 409.
    const uudestaan = await pyyda(s.portti, POST('/api/chat/stop', {}));
    assert.deepEqual([uudestaan.status, json(uudestaan)], [409, { virhe: 'ei käynnissä olevaa vastausta' }]);
    // Keskeytetty vastaus pysyy liityttävänä loppurivinä.
    const liity = await avaaVirta(s.portti, GET('/api/chat/kaynnissa'));
    assert.deepEqual(await liity.kaikki(), [{ tyyppi: 'pala', teksti: 'ab' }, { tyyppi: 'valmis', vastaus: 'ab', keskustelu: ID, agentti: 'claude-opus-5-5', kustannus: null, keskeytetty: true }]);
  } finally { await s.sulje(); }
});

test('toinen chat kesken olevan aikana → 429; valmistumisen jälkeen uusi chat sallitaan', async () => {
  const portti1 = lukko();
  const portti2 = lukko();
  const { aja } = luoAja({ claude: hidasClaude({ portti1, portti2 }) });
  const s = await kayta({ aja });
  try {
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'claude-haiku-5-5', viesti: 'eka' }));
    await virta.seuraava();
    const toinen = await pyyda(s.portti, POST('/api/chat', { agentti: 'claude-haiku-5-5', viesti: 'toka' }));
    assert.deepEqual([toinen.status, json(toinen)], [429, { virhe: 'edellinen chat-vastaus on vielä kesken' }]);
    portti1.auki();
    portti2.auki();
    const rivit = await virta.kaikki();
    assert.equal(rivit.at(-1).tyyppi, 'valmis');
    const kolmas = await pyyda(s.portti, POST('/api/chat', { agentti: 'claude-haiku-5-5', viesti: 'kolmas' }));
    assert.equal(kolmas.status, 200);
  } finally { await s.sulje(); }
});

test('liityttävyys: valmis vastaus pysyy liityttävänä LOPPUTULOS_MS ajan, sen jälkeen 404; ilman ajoa 404', async () => {
  const nyt = { ms: 5_000_000 };
  const { aja } = luoAja({ claude: async (argv, v) => { v.riville(init()); v.riville(lohko()); v.riville(delta('he')); v.riville(delta('i')); return { stdout: [tulosRivi('hei')].join('\n') } ; } });
  const s = await kayta({ aja, nyt });
  try {
    const ennen = await pyyda(s.portti, GET('/api/chat/kaynnissa'));
    assert.deepEqual([ennen.status, json(ennen)], [404, { virhe: 'ei käynnissä olevaa vastausta' }]);
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'claude-sonnet-5-5', viesti: 'moi' }));
    assert.deepEqual((await virta.kaikki()).at(-1), { tyyppi: 'valmis', vastaus: 'hei', keskustelu: ID, agentti: 'claude-sonnet-5-5', kustannus: 0.02 });
    const odotettu = [{ tyyppi: 'pala', teksti: 'hei' }, { tyyppi: 'valmis', vastaus: 'hei', keskustelu: ID, agentti: 'claude-sonnet-5-5', kustannus: 0.02 }];
    nyt.ms += 30_000;
    assert.deepEqual(await (await avaaVirta(s.portti, GET('/api/chat/kaynnissa'))).kaikki(), odotettu);
    nyt.ms = 5_000_000 + LOPPUTULOS_MS; // täsmälleen rajalla vielä liityttävä
    assert.deepEqual(await (await avaaVirta(s.portti, GET('/api/chat/kaynnissa'))).kaikki(), odotettu);
    nyt.ms += 1;
    const vanhentunut = await pyyda(s.portti, GET('/api/chat/kaynnissa'));
    assert.deepEqual([vanhentunut.status, json(vanhentunut)], [404, { virhe: 'ei käynnissä olevaa vastausta' }]);
  } finally { await s.sulje(); }
});

test('virhe ennen agentin käynnistystä palaa tavallisena virhekoodina (ei NDJSON-virtaa) eikä käynnistä taustaa', async () => {
  const { aja, kutsut } = luoAja({});
  const s = await kayta({ aja });
  try {
    const tapaukset = [
      [{ agentti: 'ei-ole', viesti: 'moi' }, 400, 'tuntematon agentti'],
      [{ agentti: 'claude-haiku-5-5', viesti: ' ' }, 400, 'viesti puuttuu'],
      [{ agentti: 'claude-haiku-5-5' }, 400, 'viesti puuttuu'],
      [{ agentti: 'claude-haiku-5-5', viesti: 'x'.repeat(8001) }, 413, 'viesti yli 8000 merkkiä'],
      [{ agentti: 'claude-haiku-5-5', viesti: 'moi', keskustelu: 'ei-tunnus' }, 400, 'keskustelun tunnus ei kelpaa'],
    ];
    for (const [runko, status, virhe] of tapaukset) {
      for (const polku of ['/api/chat', '/api/chat/virta']) {
        const v = await pyyda(s.portti, POST(polku, runko));
        assert.deepEqual([polku, v.status, v.tyyppi.includes('json') && !v.tyyppi.includes('ndjson'), json(v)], [polku, status, true, { virhe }]);
      }
    }
    assert.equal(kutsut.length, 0, 'taustaa ei käynnistetty');
    assert.equal((await pyyda(s.portti, GET('/api/chat/kaynnissa'))).status, 404, 'hylätty pyyntö ei luonut liityttävää ajoa');
    const iso = await pyyda(s.portti, POST('/api/chat', { agentti: 'claude-haiku-5-5', viesti: 'x'.repeat(40_000) }));
    assert.deepEqual([iso.status, json(iso)], [413, { virhe: 'runko liian suuri' }]);
  } finally { await s.sulje(); }
});

test('agentin virhe käynnistyksen jälkeen: virta antaa virhe-rivin, suora chat 502; kaynnissa tuo virhe-rivin', async () => {
  let kierros = 0;
  const { aja } = luoAja({ claude: async (argv, v) => { v.riville(init()); return kierros++ === 0 ? { koodi: 1, stderr: 'rivi 1\nkaatui\n' } : { stdout: `${JSON.stringify({ type: 'result', is_error: true, result: 'raja täynnä', session_id: ID })}\n` }; } });
  const s = await kayta({ aja });
  try {
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'claude-haiku-5-5', viesti: 'moi' }));
    assert.equal(virta.status, 200);
    assert.deepEqual(await virta.kaikki(), [{ tyyppi: 'virhe', virhe: 'agentti ei vastannut: kaatui' }]);
    const liity = await avaaVirta(s.portti, GET('/api/chat/kaynnissa'));
    assert.deepEqual(await liity.kaikki(), [{ tyyppi: 'virhe', virhe: 'agentti ei vastannut: kaatui' }]);
    const suora = await pyyda(s.portti, POST('/api/chat', { agentti: 'claude-haiku-5-5', viesti: 'moi' }));
    assert.deepEqual([suora.status, json(suora)], [502, { virhe: 'agentti ei vastannut: raja täynnä' }]);
  } finally { await s.sulje(); }
});

test('claude-chat: oma chat-hakemisto (ymp.chatDir tai tila/chat, ei vanha scopes-chat), argv, stdin ja jatko', async () => {
  const { aja, kutsut } = luoAja({ claude: async (argv, v) => { v.riville(init()); return { stdout: tulosRivi('ok') + '\n' }; } });
  const s = await kayta({ aja, ymp: { chatDir: undefined } });
  try {
    const v = await pyyda(s.portti, POST('/api/chat', { agentti: 'claude-fable-5-1', viesti: 'moi', keskustelu: ID }));
    assert.equal(v.status, 200);
    const oletus = join(s.d, 'tila', 'chat');
    assert.deepEqual(kutsut[0].valinnat.cwd, oletus);
    assert.ok(!oletus.includes('scopes-chat'));
    assert.deepEqual(kutsut[0].valinnat.syote, 'moi');
    assert.deepEqual(kutsut[0].argv, ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--model', 'claude-fable-5-1', '--resume', ID]);
    assert.deepEqual(readdirSync(oletus), ['agentit.json']);
  } finally { await s.sulje(); }
});

test('keskusteluhistoria: claude-transkripti listautuu agentin nimellä agentit.json:sta ja avautuu tunnuksella', async () => {
  const { aja } = luoAja({ claude: async (argv, v) => { v.riville(init()); return { stdout: tulosRivi('vastaus') + '\n' }; } });
  const s = await kayta({ aja });
  try {
    assert.deepEqual(json(await pyyda(s.portti, GET('/api/chat/keskustelut'))), []);
    assert.equal((await pyyda(s.portti, POST('/api/chat', { agentti: 'claude-opus-5-5', viesti: 'kysymys' }))).status, 200);
    // claude kirjoittaisi transkriptin projektikansioon; testissä se kirjoitetaan käsin (ei oikeaa claudea).
    const kansio = join(s.ymp.projektitDir, projektiNimi(s.ymp.chatDir));
    mkdirSync(kansio, { recursive: true });
    writeFileSync(join(kansio, `${ID}.jsonl`), [
      { type: 'user', timestamp: '2026-10-21T09:00:00.000Z', message: { content: 'kysymys' } },
      { type: 'assistant', timestamp: '2026-10-21T09:00:01.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'vastaus' }] } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    assert.deepEqual(json(await pyyda(s.portti, GET('/api/chat/keskustelut'))), [{ id: ID, otsikko: 'kysymys', agentti: 'claude-opus-5-5', viesteja: 2, aika: '2026-10-21T09:00:01.000Z' }]);
    assert.deepEqual(json(await pyyda(s.portti, GET(`/api/chat/keskustelut/${ID}`))), { id: ID, agentti: 'claude-opus-5-5', viestit: [
      { rooli: 'kayttaja', teksti: 'kysymys', aika: '2026-10-21T09:00:00.000Z' }, { rooli: 'agentti', teksti: 'vastaus', aika: '2026-10-21T09:00:01.000Z' }] });
  } finally { await s.sulje(); }
});

// ---------- paikallinen malli (LM Studio ssh:lla) ----------
const sse = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}`;
const lmStudio = ({ mallit = ['qwen/qwen3.5-9b', 'meta/llama-3'], vastaukset }) => ({
  ssh: async (argv, v) => {
    const komento = argv.at(-1);
    if (komento.startsWith('curl -s -m 5 ')) return { stdout: JSON.stringify({ data: mallit.map((id) => ({ id })) }) };
    if (komento.startsWith('mkdir -p ~/.lmstudio')) return {};
    const rivit = vastaukset.shift().map(sse);
    rivit.push('data: [DONE]');
    for (const r of rivit) v.riville?.(r);
    return { stdout: rivit.join('\n') };
  },
});

test('paikallinen malli: ssh:lla LM Studioon, vastaus palana, keskustelu tallentuu ja listautuu, jatko vaatii saman mallin', async () => {
  const vastaukset = [['he', 'i'], ['kiva'], ['x']];
  const { aja, kutsut } = luoAja(lmStudio({ vastaukset }));
  const s = await kayta({ aja });
  try {
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'palvelin/qwen/qwen3.5-9b', viesti: 'moi' }));
    const rivit = await virta.kaikki();
    const id = rivit.at(-1).keskustelu;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(rivit, [{ tyyppi: 'pala', teksti: 'he' }, { tyyppi: 'pala', teksti: 'i' }, { tyyppi: 'valmis', vastaus: 'hei', keskustelu: id, agentti: 'palvelin/qwen/qwen3.5-9b', kustannus: 0 }]);
    // Komennot: malliluettelo, lataus (lmsLataa), keskustelu. Viesti kulkee stdinissä JSON-rungossa, ei komentorivillä.
    assert.deepEqual(kutsut.map((k) => k.komento), ['ssh', 'ssh', 'ssh']);
    assert.deepEqual(kutsut[0].argv.slice(0, 5), ['-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', 'palvelin']);
    assert.equal(kutsut[1].argv.at(-1), lmsLataa('qwen/qwen3.5-9b'));
    assert.deepEqual(JSON.parse(kutsut[2].valinnat.syote), { model: 'qwen/qwen3.5-9b', stream: true, messages: [{ role: 'user', content: 'moi' }] });
    assert.ok(!kutsut.some((k) => k.argv.some((a) => a.includes('moi') && !a.includes('curl'))));
    // Historia: chatDir/paikalliset/<id>.json
    const tallessa = JSON.parse(readFileSync(join(s.ymp.chatDir, 'paikalliset', `${id}.json`), 'utf8'));
    assert.equal(tallessa.agentti, 'palvelin/qwen/qwen3.5-9b');
    assert.deepEqual(tallessa.viestit.map((x) => [x.rooli, x.teksti]), [['kayttaja', 'moi'], ['agentti', 'hei']]);
    const lista = json(await pyyda(s.portti, GET('/api/chat/keskustelut')));
    assert.deepEqual(lista.map((x) => ({ ...x, aika: typeof x.aika })), [{ id, otsikko: 'moi', agentti: 'palvelin/qwen/qwen3.5-9b', viesteja: 2, aika: 'string' }]);
    assert.deepEqual(json(await pyyda(s.portti, GET(`/api/chat/keskustelut/${id}`))).viestit.map((x) => x.teksti), ['moi', 'hei']);
    // Jatko samalla mallilla: koko historia mukana, sama tunnus.
    const jatko = await pyyda(s.portti, POST('/api/chat', { agentti: 'palvelin/qwen/qwen3.5-9b', viesti: 'jatka', keskustelu: id }));
    assert.deepEqual(json(jatko), { vastaus: 'kiva', keskustelu: id, agentti: 'palvelin/qwen/qwen3.5-9b', kustannus: 0 });
    assert.deepEqual(JSON.parse(kutsut.at(-1).valinnat.syote).messages.map((m) => m.content), ['moi', 'hei', 'jatka']);
    assert.equal(json(await pyyda(s.portti, GET(`/api/chat/keskustelut/${id}`))).viestit.length, 4);
    // Toinen malli ei jatka tätä keskustelua; tuntematon keskustelu on 404.
    const toinen = await pyyda(s.portti, POST('/api/chat', { agentti: 'palvelin/meta/llama-3', viesti: 'x', keskustelu: id }));
    assert.deepEqual([toinen.status, json(toinen)], [409, { virhe: 'keskustelu kuuluu toiselle mallille' }]);
    const outo = await pyyda(s.portti, POST('/api/chat', { agentti: 'palvelin/meta/llama-3', viesti: 'x', keskustelu: '00000000-0000-4000-8000-000000000009' }));
    assert.deepEqual([outo.status, json(outo)], [404, { virhe: 'tuntematon keskustelu' }]);
  } finally { await s.sulje(); }
});

test('paikallinen malli: ssh-virhe → 502 eikä viestiä jää historiaan; mallin lataus epäonnistuu → 502', async () => {
  let vaihe = 0;
  const { aja } = luoAja({ ssh: async (argv) => {
    const komento = argv.at(-1);
    if (komento.startsWith('curl -s -m 5 ')) return { stdout: JSON.stringify({ data: [{ id: 'qwen/qwen3.5-9b' }] }) };
    if (komento.startsWith('mkdir -p ~/.lmstudio')) return vaihe++ === 0 ? { koodi: 1, stderr: 'lms: ei muistia\n' } : {};
    return { koodi: 7, stderr: 'yhteys katkesi\n' };
  } });
  const s = await kayta({ aja });
  try {
    const lataus = await pyyda(s.portti, POST('/api/chat', { agentti: 'palvelin/qwen/qwen3.5-9b', viesti: 'moi' }));
    assert.deepEqual([lataus.status, json(lataus)], [502, { virhe: 'mallin lataus epäonnistui: lms: ei muistia' }]);
    const chat = await pyyda(s.portti, POST('/api/chat', { agentti: 'palvelin/qwen/qwen3.5-9b', viesti: 'moi' }));
    assert.deepEqual([chat.status, json(chat)], [502, { virhe: 'malli ei vastannut: yhteys katkesi' }]);
    assert.deepEqual(json(await pyyda(s.portti, GET('/api/chat/keskustelut'))), []);
  } finally { await s.sulje(); }
});

// ---------- Nebius (ssh, avain stdinissä) ----------
test('Nebius: avain luetaan ymp.nebiusTiedosto:sta, kulkee vain stdinissä (ei argvissa, vastauksessa eikä lokissa); reitti 255 → seuraava kone; kustannus käytöstä', async () => {
  const AVAIN_TEKSTI = 'testi-nebius-avain-keksitty-123';
  const koneet = [];
  const { aja, kutsut } = luoAja({ ssh: async (argv, v) => {
    koneet.push(argv[4]);
    if (argv[4] === 'palvelin') return { koodi: 255, stderr: 'ssh: connect to host palvelin: ei yhteyttä\n' };
    const rivit = [sse('Vas'), sse('taus'), `data: ${JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } })}`];
    for (const r of rivit) v.riville(r);
    return { stdout: rivit.join('\n') };
  } });
  const s = await kayta({ aja });
  try {
    // Ilman avainta malli ei ole valittavissa.
    const ei = await pyyda(s.portti, POST('/api/chat', { agentti: 'nebius/Qwen/Qwen3-30B-A3B-Instruct-2507', viesti: 'moi' }));
    assert.deepEqual([ei.status, json(ei)], [400, { virhe: 'tuntematon agentti' }]);
    writeFileSync(s.ymp.nebiusTiedosto, `${AVAIN_TEKSTI}\n`);
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'nebius/Qwen/Qwen3-30B-A3B-Instruct-2507', viesti: 'moi' }));
    const rivit = await virta.kaikki();
    const valmis = rivit.at(-1);
    assert.deepEqual(rivit.slice(0, -1), [{ tyyppi: 'pala', teksti: 'Vas' }, { tyyppi: 'pala', teksti: 'taus' }]);
    assert.equal(valmis.vastaus, 'Vastaus');
    assert.ok(Math.abs(valmis.kustannus - 0.4) < 1e-9, `kustannus ${valmis.kustannus}`);
    assert.deepEqual(koneet, ['palvelin', 'mac']);
    for (const k of kutsut) {
      assert.ok(!k.argv.some((a) => a.includes(AVAIN_TEKSTI)), 'avain ei argvissa');
      assert.ok(k.valinnat.syote.startsWith(`${AVAIN_TEKSTI}\n{`), 'avain stdinin alussa');
    }
    assert.ok(!JSON.stringify(rivit).includes(AVAIN_TEKSTI));
    assert.ok(!JSON.stringify(s.loki).includes(AVAIN_TEKSTI));
    assert.equal(JSON.parse(kutsut[0].valinnat.syote.split('\n')[1]).max_tokens, 8192);
    // Historia paikalliset-kansiossa kuten paikallisella mallilla.
    assert.deepEqual(json(await pyyda(s.portti, GET('/api/chat/keskustelut'))).map((x) => [x.agentti, x.viesteja]), [['nebius/Qwen/Qwen3-30B-A3B-Instruct-2507', 2]]);
  } finally { await s.sulje(); }
});

// ---------- agy ja Gemini ----------
test('agy: komento AGY_BIN:stä, kehote argvissa, cwd = juuri; tyhjä vastaus → 502', async () => {
  const vanha = process.env.AGY_BIN;
  process.env.AGY_BIN = '/testi/agy';
  let kierros = 0;
  const { aja, kutsut } = luoAja({ '/testi/agy': async (argv, v) => { if (kierros++ === 0) { v.riville('eka rivi'); v.riville('toka rivi'); return { stdout: 'eka rivi\ntoka rivi\n' }; } return { stderr: 'agy kaatui' }; } });
  const s = await kayta({ aja });
  try {
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'mac-agy/gemini-3.8-flash-low', viesti: 'moi' }));
    const rivit = await virta.kaikki();
    assert.deepEqual(rivit.slice(0, 2), [{ tyyppi: 'pala', teksti: 'eka rivi\n' }, { tyyppi: 'pala', teksti: 'toka rivi\n' }]);
    assert.equal(rivit.at(-1).vastaus, 'eka rivi\ntoka rivi');
    assert.equal(rivit.at(-1).agentti, 'mac-agy/gemini-3.8-flash-low');
    assert.equal(kutsut[0].komento, '/testi/agy');
    assert.deepEqual(kutsut[0].argv.slice(0, 6), ['--dangerously-skip-permissions', '--model', 'gemini-3.8-flash-low', '--add-dir', join(s.d, 'juuri'), '-p']);
    assert.equal(kutsut[0].argv[6], '[Uusi viesti]\nKäyttäjä: moi\nKoordinaattori:');
    assert.equal(kutsut[0].valinnat.cwd, join(s.d, 'juuri'));
    const vika = await pyyda(s.portti, POST('/api/chat', { agentti: 'mac-agy/gemini-3.8-flash-low', viesti: 'taas' }));
    assert.deepEqual([vika.status, json(vika)], [502, { virhe: 'AGY-malli ei vastannut: agy kaatui' }]);
  } finally {
    if (vanha === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = vanha;
    await s.sulje();
  }
});

test('Gemini: valittavissa vain kun ymp.android on annettu; vastaus palana, historia paikalliset-kansioon, jatkoviestissä aiempi keskustelu', async () => {
  const { aja, kutsut } = luoAja({});
  const kysytty = [];
  // Olio kuten adapteri.mjs:179 (android: androidOlio), ei funktio (T-105).
  const android = { kysyGeminilta: async ({ teksti, pala }) => { kysytty.push(teksti); pala?.('Gem'); pala?.('ini'); return { vastaus: 'Gemini' }; } };
  const ilman = await kayta({ aja });
  try {
    const ei = await pyyda(ilman.portti, POST('/api/chat', { agentti: 'android/gemini', viesti: 'moi' }));
    assert.deepEqual([ei.status, json(ei)], [400, { virhe: 'tuntematon agentti' }]);
  } finally { await ilman.sulje(); }
  const s = await kayta({ aja, ymp: { android } });
  try {
    const virta = await avaaVirta(s.portti, POST('/api/chat/virta', { agentti: 'android/gemini', viesti: 'moi' }));
    const rivit = await virta.kaikki();
    const id = rivit.at(-1).keskustelu;
    assert.deepEqual(rivit.slice(0, 2), [{ tyyppi: 'pala', teksti: 'Gem' }, { tyyppi: 'pala', teksti: 'ini' }]);
    assert.deepEqual(rivit.at(-1), { tyyppi: 'valmis', vastaus: 'Gemini', keskustelu: id, agentti: 'android/gemini', kustannus: 0 });
    const jatko = await pyyda(s.portti, POST('/api/chat', { agentti: 'android/gemini', viesti: 'lisää', keskustelu: id }));
    assert.equal(jatko.status, 200);
    assert.equal(kysytty[0], 'moi');
    assert.match(kysytty[1], /^Jatka alla olevaa keskustelua[\s\S]*Minä: moi\nGemini: Gemini\n[\s\S]*\[Uusi viesti\]\nlisää$/);
    assert.equal(kutsut.length, 0, 'Gemini ei käytä ymp.aja:a');
  } finally { await s.sulje(); }
});

test('T-105: android-olio (adapteri.mjs:179) → POST /api/chat android/gemini 200, vastaus viestinä (ennen korjausta 500 "android is not a function")', async () => {
  const { aja } = luoAja({});
  const android = { kysyGeminilta: async () => ({ vastaus: 'Hei Geminiltä' }) };
  const s = await kayta({ aja, ymp: { android } });
  try {
    const r = await pyyda(s.portti, POST('/api/chat', { agentti: 'android/gemini', viesti: 'moi' }));
    assert.equal(r.status, 200, r.teksti);
    const v = json(r);
    assert.equal(v.vastaus, 'Hei Geminiltä');
    assert.equal(v.agentti, 'android/gemini');
    assert.ok(v.keskustelu);
  } finally { await s.sulje(); }
});

test('T-95: ymp.chatDir (adapteri.mjs --chat) listaa vanhan chat-hakemiston historian; ilman sitä oma tyhjä <tila>/chat', async () => {
  const ID2 = '11111111-2222-4333-8444-555555555555';
  const vanha = mkdtempSync(join(TMP, 'vanha-chat-'));
  const { aja } = luoAja({});
  const s = await kayta({ aja, ymp: { chatDir: vanha } });
  const oletus = await kayta({ aja, ymp: { chatDir: undefined } });
  try {
    // Vanhan 8787:n kirjoittama historia: claude-transkripti projektikansiossa ja paikallinen keskustelu chatDir/paikalliset/<id>.json.
    const kansio = join(s.ymp.projektitDir, projektiNimi(vanha));
    mkdirSync(kansio, { recursive: true });
    writeFileSync(join(kansio, `${ID}.jsonl`), [
      { type: 'user', timestamp: '2026-10-21T09:00:00.000Z', message: { content: 'kysymys' } },
      { type: 'assistant', timestamp: '2026-10-21T09:00:01.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'vastaus' }] } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    mkdirSync(join(vanha, 'paikalliset'));
    writeFileSync(join(vanha, 'paikalliset', `${ID2}.json`), JSON.stringify({ agentti: 'palvelin/qwen/qwen3.5-9b', viestit: [
      { rooli: 'kayttaja', teksti: 'moi', aika: '2026-10-20T08:00:00.000Z' }, { rooli: 'agentti', teksti: 'hei', aika: '2026-10-20T08:00:01.000Z' }] }));
    const lista = json(await pyyda(s.portti, GET('/api/chat/keskustelut')));
    assert.deepEqual(lista.map((x) => x.id).sort(), [ID, ID2].sort());
    assert.deepEqual(json(await pyyda(s.portti, GET(`/api/chat/keskustelut/${ID2}`))).viestit.map((x) => x.teksti), ['moi', 'hei']);
    // Ilman chatDir:iä sama projektikansio ja paikalliset eivät näy: oma <tila>/chat on tyhjä.
    assert.deepEqual(json(await pyyda(oletus.portti, GET('/api/chat/keskustelut'))), []);
  } finally { await s.sulje(); await oletus.sulje(); }
});
