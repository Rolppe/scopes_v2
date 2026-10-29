// T-63-G: toimintokuuntelijan (S-10) tunnistus, terveys, 404/501 ja reittien kokoaminen.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as luoTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KAIKKI, KOUKUT, MODUULIT, etsi, koukut, tasmaa, toteutetut } from './reitit.mjs';
import { luoToimintopalvelin } from './palvelin.mjs';
import { vastaa } from './runko.mjs';
import { projektiNimi } from '../transkriptit.mjs';
import { ajaFixture, lataaFixturet, vertaaFixtureen } from './testiapurit.mjs';

const ADAPTERI = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapteri.mjs');
const AVAIN = 'koe-avain-'.padEnd(48, 'x');
const koti = mkdtempSync(join(tmpdir(), 'scopes2-toiminnot-'));
const avainTiedosto = join(koti, 'avain');
writeFileSync(avainTiedosto, `${AVAIN}\n`);
after(() => rmSync(koti, { recursive: true, force: true }));

// ARK-16-reitit (SUUNNITELMA S-10, T-63-G brief): kuviot eivät muutu, vaikka myöhemmät tehtävät toteuttavat ne.
const ARK16 = [
  'POST /api/skoopit/*/viesti', 'POST /api/skoopit/*/stream', 'POST /api/skoopit/*/stop', 'POST /api/skoopit/*/kysymys-pois',
  'POST /api/skoopit/*/pakkaa', 'POST /api/skoopit/*/automaattisiirto', 'POST /api/skoopit/*/herata', 'POST /api/skoopit/*/herata-pois',
  'POST /api/skoopit/*/pura', 'GET /api/purkajat',
  'POST /api/chat', 'POST /api/chat/virta', 'GET /api/chat/kaynnissa', 'POST /api/chat/stop', 'GET /api/chat/keskustelut', 'GET /api/chat/keskustelut/*',
];
// Lisäreitit (T-79-G, arkkitehtuurin luku 9 "Sillan muut reitit"): ARK-16:n loput (malli, uusi, agentit, asetukset) ja ARK-19 (android, linux).
// GET /api/android, GET /api/asetukset, GET /api/skoopit/*/asetukset ja GET /api/kayttoraja eivät kuulu adapterille (ydin vastaa, T-84).
const LISA = [
  'POST /api/skoopit/*/malli', 'POST /api/uusi', 'GET /api/agentit',
  'POST /api/asetukset/*/*', 'POST /api/skoopit/*/asetukset/*/*',
  'GET /api/android/ruutu', 'GET /api/android/ui', 'GET /api/android/tuotokset', 'GET /api/android/tuotos', 'POST /api/android/liite', 'POST /api/android/*',
  'GET /api/palvelin', 'POST /api/palvelin/*',
];
const EI_ADAPTERIN = ['GET /api/android', 'GET /api/asetukset', 'GET /api/skoopit/a/asetukset', 'GET /api/kayttoraja'];

function pyyntö(portti, metodi, polku, { avain = AVAIN, runko } = {}) {
  return new Promise((ok, ei) => {
    const req = request({ host: '127.0.0.1', port: portti, method: metodi, path: polku, headers: avain ? { authorization: `Bearer ${avain}` } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => ok({ status: res.statusCode, runko: data ? JSON.parse(data) : null }));
    });
    req.on('error', ei);
    req.end(runko);
  });
}

let palvelin;
let portti;
const kutsut = [];
before(async () => {
  const koe = [
    { metodi: 'POST', kuvio: '/api/koe/*/tee', toteutettu: true, kasittele: async (_req, res, osat, ymp) => { kutsut.push({ osat, ymp: Object.keys(ymp).sort() }); vastaa(res, 200, { osat }); } },
    { metodi: 'GET', kuvio: '/api/koe/lista/**', toteutettu: true, kasittele: async (_req, res, osat) => vastaa(res, 200, { osat }) },
    { metodi: 'POST', kuvio: '/api/koe/kaatuu', toteutettu: true, kasittele: async () => { throw new Error('kaatui'); } },
    ...KAIKKI,
  ];
  palvelin = luoToimintopalvelin({ portti: 0, reitit: koe, avainTiedosto, juuri: '/koe/juuri', tila: join(koti, 'tila'), aja: 'koe-aja', kello: () => 0 });
  portti = await palvelin.kuuntele();
});
after(() => palvelin.sulje());

test('reittitaulukko: kaikki 16 ARK-16-reittiä ja 13 lisäreittiä rekisteröity moduuleittain', () => {
  assert.equal(ARK16.length, 16);
  assert.deepEqual(Object.keys(MODUULIT), ['viestit', 'istunto', 'pura', 'chat', 'malli', 'uusi', 'agentit', 'asetukset', 'android', 'linux']);
  const rekisteroidyt = KAIKKI.map((r) => `${r.metodi} ${r.kuvio}`);
  assert.deepEqual(rekisteroidyt.filter((k) => ARK16.includes(k)).sort(), [...ARK16].sort());
  assert.deepEqual(rekisteroidyt.filter((k) => LISA.includes(k)).sort(), [...LISA].sort());
  assert.deepEqual([...rekisteroidyt].sort(), [...ARK16, ...LISA].sort()); // ei muita reittejä
  const moduulinReitit = (nimi) => MODUULIT[nimi].map((r) => `${r.metodi} ${r.kuvio}`);
  assert.deepEqual(moduulinReitit('malli'), ['POST /api/skoopit/*/malli']);
  assert.deepEqual(moduulinReitit('uusi'), ['POST /api/uusi']);
  assert.deepEqual(moduulinReitit('agentit'), ['GET /api/agentit']);
  assert.deepEqual(moduulinReitit('asetukset'), ['POST /api/asetukset/*/*', 'POST /api/skoopit/*/asetukset/*/*']);
  assert.equal(moduulinReitit('android').length, 6);
  assert.deepEqual(moduulinReitit('linux'), ['GET /api/palvelin', 'POST /api/palvelin/*']);
  for (const r of KAIKKI) {
    assert.equal(typeof r.toteutettu, 'boolean');
    assert.equal(typeof r.kasittele, 'function');
  }
});

test('tasmaa: * on yksi osa, /** etuliite, osat URL-purettuina', () => {
  assert.deepEqual(tasmaa('/api/skoopit/*/viesti', '/api/skoopit/scopes%20infra/viesti'), ['scopes infra']);
  assert.equal(tasmaa('/api/skoopit/*/viesti', '/api/skoopit/a/b/viesti'), null);
  assert.equal(tasmaa('/api/skoopit/*/viesti', '/api/skoopit//viesti'), null);
  assert.equal(tasmaa('/api/skoopit/*/viesti', '/api/skoopit/a/viestit'), null);
  assert.deepEqual(tasmaa('/api/chat/keskustelut/*', '/api/chat/keskustelut/k1'), ['k1']);
  assert.equal(tasmaa('/api/chat/keskustelut/*', '/api/chat/keskustelut'), null);
  assert.deepEqual(tasmaa('/api/koe/lista/**', '/api/koe/lista/a/b'), ['a/b']);
  assert.deepEqual(tasmaa('/api/koe/lista/**', '/api/koe/lista/'), ['']);
  assert.equal(tasmaa('/api/koe/lista/**', '/api/koe'), null);
  assert.equal(etsi(KAIKKI, 'GET', '/api/skoopit/a/viesti'), null); // väärä metodi
});

test('terveys ilman avainta: ok, adapteri ja vain toteutetut reitit', async () => {
  const v = await pyyntö(portti, 'GET', '/api/terveys', { avain: null });
  assert.equal(v.status, 200);
  assert.deepEqual(v.runko, { ok: true, adapteri: true, reitit: ['POST /api/koe/*/tee', 'GET /api/koe/lista/**', 'POST /api/koe/kaatuu', ...toteutetut(KAIKKI)] });
  assert.ok(v.runko.reitit.every((r) => /^(GET|POST) \//.test(r)));
});

test('väärä tai puuttuva avain → 401 (myös tuntemattomalla ja toteuttamattomalla reitillä)', async () => {
  for (const avain of ['väärä'.padEnd(48, 'x'), 'lyhyt', null]) {
    for (const [m, p] of [['POST', '/api/koe/a/tee'], ['POST', '/api/skoopit/a/viesti'], ['GET', '/api/ei/ole']]) {
      const v = await pyyntö(portti, m, p, { avain });
      assert.deepEqual([v.status, v.runko], [401, { virhe: 'avain puuttuu tai väärä' }], `${m} ${p} avain ${avain}`);
    }
  }
});

test('toteuttamaton ARK-16-reitti → 501, tuntematon polku → 404, muu metodi → 405', async () => {
  for (const kuvio of [...ARK16, ...LISA].filter((k) => !toteutetut(KAIKKI).includes(k))) {
    const [m, p] = kuvio.split(' ');
    const v = await pyyntö(portti, m, p.replaceAll('*', 'a'), { runko: m === 'POST' ? '{}' : undefined });
    assert.deepEqual([v.status, v.runko], [501, { virhe: 'ei siirretty' }], kuvio);
  }
  assert.deepEqual((await pyyntö(portti, 'GET', '/api/ei/ole')).runko, { virhe: 'tuntematon polku' });
  assert.equal((await pyyntö(portti, 'GET', '/api/ei/ole')).status, 404);
  assert.equal((await pyyntö(portti, 'GET', '/api/skoopit/a/viesti')).status, 404); // POST-reitti GETillä
  const v = await pyyntö(portti, 'DELETE', '/api/chat');
  assert.deepEqual([v.status, v.runko], [405, { virhe: 'vain GET ja POST' }]);
});

test('lisäreitit: tyhjä moduuli palauttaa 501, adapterin ulkopuoliset reitit 404, tarkka android-reitti ennen jokerikuviota', async () => {
  for (const kuvio of LISA) {
    const [m, p] = kuvio.split(' ');
    const reitti = KAIKKI.find((r) => r.metodi === m && r.kuvio === p);
    if (reitti.toteutettu) continue; // toteutettu moduuli testaa itsensä (T-80…T-86)
    const v = await pyyntö(portti, m, p.replaceAll('*', 'a'), { runko: m === 'POST' ? '{}' : undefined });
    assert.deepEqual([v.status, v.runko], [501, { virhe: 'ei siirretty' }], kuvio);
  }
  for (const kuvio of EI_ADAPTERIN) {
    const [m, p] = kuvio.split(' ');
    const v = await pyyntö(portti, m, p);
    assert.deepEqual([v.status, v.runko], [404, { virhe: 'tuntematon polku' }], kuvio);
  }
  assert.equal(etsi(KAIKKI, 'POST', '/api/android/liite').reitti.kuvio, '/api/android/liite');
  assert.equal(etsi(KAIKKI, 'POST', '/api/android/napauta').reitti.kuvio, '/api/android/*');
  assert.deepEqual(etsi(KAIKKI, 'POST', '/api/android/napauta').osat, ['napauta']);
  assert.equal(etsi(KAIKKI, 'GET', '/api/android/tuotos').reitti.kuvio, '/api/android/tuotos');
  assert.equal(etsi(KAIKKI, 'GET', '/api/android/tuotokset').reitti.kuvio, '/api/android/tuotokset');
  assert.deepEqual(etsi(KAIKKI, 'POST', '/api/skoopit/scopes%20infra/asetukset/autopack/paalle').osat, ['scopes infra', 'autopack', 'paalle']);
  assert.deepEqual(etsi(KAIKKI, 'POST', '/api/asetukset/autopack/pois').osat, ['autopack', 'pois']);
  assert.equal(etsi(KAIKKI, 'POST', '/api/skoopit/a/asetukset/autopack'), null); // puuttuva tila
  assert.equal(etsi(KAIKKI, 'GET', '/api/palvelin').reitti.kuvio, '/api/palvelin');
  assert.deepEqual(etsi(KAIKKI, 'POST', '/api/palvelin/kaynnista').osat, ['kaynnista']);
});

test('terveys: lisäreitti on listalla vain, kun sen toteutettu on true', async () => {
  const v = await pyyntö(portti, 'GET', '/api/terveys', { avain: null });
  for (const kuvio of LISA) {
    const [m, p] = kuvio.split(' ');
    const toteutettu = KAIKKI.find((r) => r.metodi === m && r.kuvio === p).toteutettu;
    assert.equal(v.runko.reitit.includes(kuvio), toteutettu, kuvio);
  }
  const t = luoToimintopalvelin({ portti: 0, avainTiedosto, juuri: '/koe/juuri', tila: join(koti, 'tila'), reitit: [
    { metodi: 'GET', kuvio: '/api/agentit', toteutettu: false, kasittele: async () => {} },
    { metodi: 'GET', kuvio: '/api/palvelin', toteutettu: true, kasittele: async (_q, res) => vastaa(res, 200, { tila: 'koe' }) },
  ] });
  const p = await t.kuuntele();
  try {
    assert.deepEqual((await pyyntö(p, 'GET', '/api/terveys', { avain: null })).runko.reitit, ['GET /api/palvelin']);
    assert.deepEqual((await pyyntö(p, 'GET', '/api/palvelin')).runko, { tila: 'koe' });
  } finally { await t.sulje(); }
});

test('moduulikoukku: kaynnista kutsutaan kuuntele():ssa ymp:llä, pysayta sulje():ssa (käänteisessä järjestyksessä, kerran)', async () => {
  const tapahtumat = [];
  const moduuli = (nimi, extra = {}) => ({ nimi, kaynnista: async (ymp) => { tapahtumat.push(`${nimi}+ ${Object.keys(ymp).sort().join(',')}`); return { pysayta: async () => { tapahtumat.push(`${nimi}-`); } }; }, ...extra });
  const t = luoToimintopalvelin({ portti: 0, avainTiedosto, juuri: '/koe/juuri', tila: join(koti, 'tila'), reitit: [], koukut: [moduuli('a'), moduuli('b')] });
  assert.deepEqual(tapahtumat, []); // ei ennen kuuntelua
  await t.kuuntele();
  assert.deepEqual(tapahtumat, ['a+ aja,juuri,kello,loki,tila', 'b+ aja,juuri,kello,loki,tila']);
  await t.sulje();
  assert.deepEqual(tapahtumat.slice(2), ['b-', 'a-']);
  await t.sulje(); // toinen sulku ei pysäytä uudelleen
  assert.equal(tapahtumat.length, 4);
});

test('moduulikoukku: pysayta on valinnainen; kaatuva kaynnista pysäyttää jo käynnistyneet ja hylkää kuuntelun; varattu portti pysäyttää kaikki', async () => {
  const tapahtumat = [];
  const hyva = (nimi) => ({ nimi, kaynnista: () => { tapahtumat.push(`${nimi}+`); return { pysayta: () => { tapahtumat.push(`${nimi}-`); } }; } });
  const ilmanPysayta = { nimi: 'x', kaynnista: () => { tapahtumat.push('x+'); } };
  const kaatuu = { nimi: 'k', kaynnista: () => { throw new Error('koukku kaatui'); } };
  const uusi = (koukut) => luoToimintopalvelin({ portti: 0, avainTiedosto, juuri: '/koe/juuri', tila: join(koti, 'tila'), reitit: [], koukut });

  const a = uusi([hyva('a'), ilmanPysayta]);
  await a.kuuntele();
  await a.sulje();
  assert.deepEqual(tapahtumat.splice(0), ['a+', 'x+', 'a-']);

  const b = uusi([hyva('a'), kaatuu, hyva('c')]);
  await assert.rejects(b.kuuntele(), /koukku kaatui/);
  assert.deepEqual(tapahtumat.splice(0), ['a+', 'a-']); // c ei käynnisty
  await b.sulje();
  assert.deepEqual(tapahtumat, []);

  const varattu = luoTcp();
  await new Promise((ok) => varattu.listen(0, '127.0.0.1', ok));
  try {
    const c = luoToimintopalvelin({ portti: varattu.address().port, avainTiedosto, juuri: '/koe/juuri', tila: join(koti, 'tila'), reitit: [], koukut: [hyva('d')] });
    await assert.rejects(c.kuuntele(), /EADDRINUSE/);
    assert.deepEqual(tapahtumat.splice(0), ['d+', 'd-']);
    await c.sulje();
  } finally { await new Promise((ok) => varattu.close(ok)); }
});

test('koukut(): vain kaynnista-funktion vievät moduulit; tyhjät moduulit eivät vie koukkua', () => {
  const k = () => ({ pysayta() {} });
  assert.deepEqual(koukut({ a: { REITIT: [] }, b: { REITIT: [], kaynnista: k }, c: { REITIT: [], kaynnista: 'ei' } }).map((x) => x.nimi), ['b']);
  assert.equal(koukut({ b: { kaynnista: k } })[0].kaynnista, k);
  assert.ok(Array.isArray(KOUKUT));
  assert.equal(luoToimintopalvelin({ portti: 0, avainTiedosto, juuri: '/x' }).palvelin.listening, false); // oletuskoukut (KOUKUT) eivät käynnisty ennen kuuntelua
});

test('toteutettu reitti saa osat ja ymp (aja, juuri, tila, loki, kello); poikkeus → 500', async () => {
  const v = await pyyntö(portti, 'POST', '/api/koe/scopes%20infra/tee', { runko: '{}' });
  assert.deepEqual([v.status, v.runko], [200, { osat: ['scopes infra'] }]);
  assert.deepEqual(kutsut.at(-1).ymp, ['aja', 'juuri', 'kello', 'loki', 'tila']);
  assert.deepEqual((await pyyntö(portti, 'GET', '/api/koe/lista/a/b')).runko, { osat: ['a/b'] });
  const k = await pyyntö(portti, 'POST', '/api/koe/kaatuu', { runko: '{}' });
  assert.deepEqual([k.status, k.runko], [500, { virhe: 'kaatui' }]);
  const rikki = await pyyntö(portti, 'GET', '/api/koe/lista/%E0%A4%A'); // virheellinen %-koodaus: vanha 500 {virhe:'URI malformed'} (T-111)
  assert.deepEqual([rikki.status, rikki.runko], [500, { virhe: 'URI malformed' }]);
});

test('adapteri --toiminnot <portti> kuuntelee; ilman lippua ei kuuntele', async () => {
  const vapaa = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const ajaAdapteri = async (liput) => {
    const p = await vapaa();
    const lapsi = spawn(process.execPath, [ADAPTERI, '--ydin', 'http://127.0.0.1:1', '--projektit', join(koti, 'projektit'), ...liput(p)], {
      env: { ...process.env, HOME: koti }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let virhe = '';
    lapsi.stderr.on('data', (c) => { virhe += c; });
    return { p, lapsi, virhe: () => virhe };
  };
  const odota = async (ehto) => { for (let i = 0; i < 100; i++) { if (await ehto()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

  const a = await ajaAdapteri((p) => ['--toiminnot', String(p)]);
  try {
    assert.ok(await odota(async () => (await pyyntö(a.p, 'GET', '/api/terveys', { avain: null }).catch(() => null))?.status === 200), `ei kuuntele; stderr: ${a.virhe()}`);
    assert.deepEqual((await pyyntö(a.p, 'GET', '/api/terveys', { avain: null })).runko, { ok: true, adapteri: true, reitit: toteutetut(KAIKKI) });
  } finally { a.lapsi.kill('SIGKILL'); }

  const b = await ajaAdapteri(() => []);
  try {
    await new Promise((r) => setTimeout(r, 1500));
    await assert.rejects(pyyntö(b.p, 'GET', '/api/terveys', { avain: null }), /ECONNREFUSED/);
  } finally { b.lapsi.kill('SIGKILL'); }
});

test('T-111: rikkinäinen %-koodaus = vanhan palvelimen vastaus (fixture palvelin-rikkinainen-koodaus: 500 {virhe:"URI malformed"})', async () => {
  const [fix] = lataaFixturet(/^palvelin-rikkinainen-koodaus$/);
  assert.ok(fix);
  const { havainto } = await ajaFixture(fix, { reitit: KAIKKI });
  vertaaFixtureen(fix, havainto);
});

test('T-111: adapteri --projektit/--chat annettu polku näkyy toimintoreitin ymp:ssä (chat-lista lukee annetusta projektihakemistosta, ei ~/.claude/projects)', async () => {
  const d = mkdtempSync(join(koti, 't111-'));
  const projektit = join(d, 'omat-projektit');
  const chat = join(d, 'chat');
  const ID = '38c487b9-3c36-4723-b2af-5f07b106c172';
  mkdirSync(join(projektit, projektiNimi(chat)), { recursive: true });
  writeFileSync(join(projektit, projektiNimi(chat), `${ID}.jsonl`), [
    { type: 'user', timestamp: '2026-10-21T09:00:00.000Z', message: { content: 'eka kysymys' } },
    { type: 'assistant', timestamp: '2026-10-21T09:00:01.000Z', message: { model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'vastaus' }] } },
  ].map((r) => JSON.stringify(r)).join('\n'));
  mkdirSync(join(koti, '.config/scopes2'), { recursive: true });
  writeFileSync(join(koti, '.config/scopes2/avain'), `${AVAIN}\n`);
  const p = await new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => ok(x)); }); });
  const lapsi = spawn(process.execPath, [ADAPTERI, '--ydin', 'http://127.0.0.1:1', '--projektit', projektit, '--chat', chat, '--toiminnot', String(p)], {
    env: { ...process.env, HOME: koti }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let virhe = '';
  lapsi.stderr.on('data', (c) => { virhe += c; });
  try {
    let v = null;
    for (let i = 0; i < 100 && v?.status !== 200; i++) {
      v = await pyyntö(p, 'GET', '/api/chat/keskustelut').catch(() => null);
      if (v?.status !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(v?.status, 200, `stderr: ${virhe}`);
    assert.ok(JSON.stringify(v.runko).includes(ID), JSON.stringify(v.runko));
  } finally { lapsi.kill('SIGKILL'); }
});
