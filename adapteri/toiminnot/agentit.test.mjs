// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/agentit.test.mjs
// T-82 (ARK-16:n loput, S-10): GET /api/agentit. Jokainen testidata/toiminnot/agentit-*.json ajetaan oikean HTTP-toimintopalvelimen
// (luoToimintopalvelin, portti 0) läpi: status, JSON-taulukko (järjestys mukaan lukien) ja ssh-argv verrataan fixtureen; lisäksi
// LM Studion välimuisti 20 s ymp.kello-injektiolla. Replay on tässä tiedostossa, koska testiapurit.mjs:n tmux-mock ei tunne ssh:ta
// eikä komennot.vastaukset-sääntöjä (tallenna-lisa.mjs:353-361): ssh vastataan fixturen säännöistä, muut komennot kaatavat testin.
// Ei oikeaa ssh:ta, LM Studiota eikä verkkoa; Nebius-avaimesta testataan vain tiedoston olemassaolo (sisältö on tyhjä).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_AGENTTI, MALLIT, NEBIUS_CHAT_MALLIT, REITIT, haePaikalliset, kaikkiMallit, mallinNayttonimi, paikallisetMallit } from './agentit.mjs';
import { luoToimintopalvelin } from './palvelin.mjs';
import { KAIKKI, toteutetut } from './reitit.mjs';
import { TMP, avainTiedosto, lataaFixturet, pyyda } from './testiapurit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

const fixturet = lataaFixturet(/^agentit-/);
const SSH_ARGV = ['ssh', '-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', 'palvelin', 'curl -s -m 5 http://127.0.0.1:1234/v1/models'];

// ssh-väärennös: fixturen komennot.vastaukset (ensimmäinen sääntö, jonka komento täsmää ja `sisaltaa` esiintyy argv:ssa), oletus ssh 255.
// Kirjaa argv:n ja valinnat; pito = ensimmäinen ssh-kutsu odottaa (ymparisto.samanaikainen).
function luoAja(ymparisto, ctx) {
  return async (komento, argv, valinnat = {}) => {
    ctx.kutsut.push([komento, ...argv]);
    ctx.valinnat.push(valinnat);
    if (komento !== 'ssh') throw new Error(`agentit.test: odottamaton komento ${komento} ${argv.join(' ')}`);
    if (ctx.pito && !ctx.pito.otettu) { ctx.pito.otettu = true; ctx.pito.saavutettu(); await ctx.pito.esto; }
    const rivi = argv.join(' ');
    const s = (ymparisto.komennot.vastaukset ?? []).find((x) => x.komento === komento && (x.sisaltaa === undefined || rivi.includes(x.sisaltaa)));
    return { koodi: s ? (s.koodi ?? 0) : 255, stdout: s?.stdout ?? '', stderr: s?.stderr ?? '' };
  };
}

// Käynnistää palvelimen fixturen ympäristöllä; kello = muutettava ctx.kello. fn(portti, ctx) ajetaan palvelimen ollessa pystyssä.
async function palvelimella(fix, fn, { nebiusPolku = join(TMP, 'nebius-ei-ole'), kello0 = Date.parse('2026-10-21T09:00:00.000Z') } = {}) {
  const ympa = fix.ymparisto;
  const ctx = { kutsut: [], valinnat: [], kello: kello0, pito: null };
  if (ympa.nebiusAvain) { nebiusPolku = join(TMP, `nebius-avain-${fix.tapaus}`); writeFileSync(nebiusPolku, ''); }
  const lisa = { ...(ympa.androidMukana ? { adb: true } : {}), nebiusTiedosto: nebiusPolku };
  const omat = REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) }));
  const palvelin = luoToimintopalvelin({ portti: 0, reitit: omat, koukut: [], avainTiedosto, juuri: join(TMP, 'juuri'), tila: join(TMP, 'tila'),
    aja: luoAja(ympa, ctx), kello: () => ctx.kello, loki: () => {} });
  const portti = await palvelin.kuuntele();
  try { return await fn(portti, ctx); } finally { await palvelin.sulje(); }
}

// Fixturen varsinainen pyyntö; ymparisto.samanaikainen lähetetään ja pidetään kesken (ssh-kutsussa) ennen varsinaista pyyntöä.
async function ajaFixture(fix) {
  return palvelimella(fix, async (portti, ctx) => {
    let kesken = null;
    let vapauta = null;
    if (fix.ymparisto.samanaikainen) {
      let saavutettu;
      const lupaus = new Promise((ok) => { saavutettu = ok; });
      ctx.pito = { esto: new Promise((ok) => { vapauta = ok; }), saavutettu, otettu: false };
      kesken = pyyda(portti, fix.ymparisto.samanaikainen);
      await lupaus;
      ctx.kutsut.length = 0; // odotus kattaa vain varsinaisen pyynnön komennot
      ctx.valinnat.length = 0;
    }
    const v = await pyyda(portti, fix.pyynto);
    if (kesken) { vapauta(); await kesken; }
    return { status: v.status, runko: JSON.parse(v.teksti), aja: ctx.kutsut.filter((k) => !(k[0] === 'tmux' && k[1] === 'list-panes')), valinnat: ctx.valinnat };
  });
}

// ---------- testit ----------
test('reitit: GET /api/agentit toteutettu ja terveyslistalla', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['GET /api/agentit']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  assert.ok(toteutetut(KAIKKI).includes('GET /api/agentit'));
});

test('fixturet: jokainen agentit-tapaus on katettu', () => {
  assert.deepEqual(fixturet.map((f) => f.tapaus).sort(), ['agentit-android-mukana', 'agentit-android-pois', 'agentit-lmstudio-ei-vastaa',
    'agentit-lmstudio-roskavastaus', 'agentit-lmstudio-vastaa', 'agentit-nebius-avain-ei', 'agentit-nebius-avain-on']);
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const h = await ajaFixture(fix);
    assert.equal(h.status, fix.odotus.status, `${fix.tapaus}: status`);
    assert.deepEqual(h.runko, fix.odotus.runko, `${fix.tapaus}: lista järjestyksineen`);
    assert.deepEqual(h.aja, fix.odotus.aja, `${fix.tapaus}: ssh-argv-jono`);
    if ('ajaValinnat' in fix.odotus) assert.deepEqual(h.valinnat, fix.odotus.ajaValinnat, `${fix.tapaus}: ajaValinnat`);
    assert.deepEqual(h.valinnat, [{ aikaraja: 10_000 }], `${fix.tapaus}: ssh saa aikarajan 10 s (kuten vanha)`);
  });
}

test('samanaikainen: ymparisto.samanaikainen pidetään kesken ennen varsinaista pyyntöä; kesken oleva haku ei ole vielä välimuistissa (kuten vanha)', async () => {
  const fix = structuredClone(fixturet.find((f) => f.tapaus === 'agentit-lmstudio-vastaa'));
  fix.ymparisto.samanaikainen = { metodi: 'GET', polku: '/api/agentit', runko: null };
  const h = await ajaFixture(fix);
  assert.equal(h.status, 200);
  assert.deepEqual(h.runko, fix.odotus.runko);
  assert.deepEqual(h.aja, [SSH_ARGV], 'kesken olevan haun tulosta ei ole vielä välimuistissa → varsinainen pyyntö ajaa oman ssh:nsa (vanha ei yhdistä rinnakkaisia hakuja)');
});

test('ei adb:tä eikä Nebius-avainta: lista ilman android/gemini- ja nebius-rivejä', async () => {
  const h = await ajaFixture(fixturet.find((f) => f.tapaus === 'agentit-android-pois'));
  assert.ok(!h.runko.some((m) => m.nimi === GEMINI_AGENTTI.nimi || m.nimi.startsWith('nebius/')));
});

test('välimuisti 20 s: toinen pyyntö 19,9 s:n kuluttua ei aja ssh:ta, 20 s:n kuluttua ajaa; epäonnistunutkin haku jää välimuistiin', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'agentit-lmstudio-vastaa');
  await palvelimella(fix, async (portti, ctx) => {
    const paikalliset = (v) => JSON.parse(v.teksti).filter((m) => m.tyyppi === 'paikallinen').map((m) => m.nimi);
    const ensin = paikalliset(await pyyda(portti, fix.pyynto));
    assert.deepEqual(ensin, ['palvelin/qwen/qwen3.5-9b', 'palvelin/qwen3.5-9b-q4_k_m.gguf', 'palvelin/google/gemma-4-12b']);
    assert.deepEqual(ctx.kutsut, [SSH_ARGV]);
    ctx.kello += 19_999;
    assert.deepEqual(paikalliset(await pyyda(portti, fix.pyynto)), ensin);
    assert.equal(ctx.kutsut.length, 1, '19,999 s: välimuistista');
    ctx.kello += 1;
    assert.deepEqual(paikalliset(await pyyda(portti, fix.pyynto)), ensin);
    assert.equal(ctx.kutsut.length, 2, '20 s: uusi haku');
    assert.deepEqual(ctx.kutsut[1], SSH_ARGV);
  });
  const ei = fixturet.find((f) => f.tapaus === 'agentit-lmstudio-ei-vastaa');
  await palvelimella(ei, async (portti, ctx) => {
    for (let i = 0; i < 3; i++) { assert.equal((await pyyda(portti, ei.pyynto)).status, 200); ctx.kello += 5_000; }
    assert.equal(ctx.kutsut.length, 1, 'tyhjä tulos on myös välimuistissa 20 s');
    ctx.kello += 10_000;
    await pyyda(portti, ei.pyynto);
    assert.equal(ctx.kutsut.length, 2);
  });
});

test('välimuisti alkaa tyhjänä myös kellolla 0 (ensimmäinen pyyntö hakee aina)', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'agentit-lmstudio-vastaa');
  await palvelimella(fix, async (portti, ctx) => {
    const v = JSON.parse((await pyyda(portti, fix.pyynto)).teksti);
    assert.equal(ctx.kutsut.length, 1);
    assert.ok(v.some((m) => m.nimi === 'palvelin/qwen/qwen3.5-9b'));
  }, { kello0: 0 });
});

test('välimuisti on palvelinkohtainen: toinen palvelin hakee omalla ssh-kutsullaan', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'agentit-lmstudio-vastaa');
  for (let i = 0; i < 2; i++) await palvelimella(fix, async (portti, ctx) => { await pyyda(portti, fix.pyynto); assert.equal(ctx.kutsut.length, 1); });
});

test('kaikkiMallit(ymp): vietävä funktio chatille ja purkajille, sama lista kuin reitti', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'agentit-lmstudio-vastaa');
  const kutsut = [];
  const aja = async (komento, argv, valinnat) => { kutsut.push([komento, ...argv, valinnat]); return { koodi: 0, stdout: fix.ymparisto.komennot.vastaukset[0].stdout, stderr: '' }; };
  const lista = await kaikkiMallit({ aja, kello: () => 1_000, adb: true, nebiusTiedosto: join(TMP, 'ei-ole') });
  assert.deepEqual(lista.slice(0, 4), MALLIT);
  assert.ok(lista.some((m) => m.nimi === 'android/gemini'));
  assert.deepEqual(lista.filter((m) => m.tyyppi === 'paikallinen').map((m) => m.kuvaus), ['Qwen3.5 9B', 'Qwen3.5 9B Q4_K_M', 'Gemma 4 12B']);
  assert.deepEqual(kutsut, [[...SSH_ARGV.slice(0, 1), ...SSH_ARGV.slice(1), { aikaraja: 10_000 }]]);
  assert.equal((await haePaikalliset({ aja, kello: () => 1_000 })).length, 3);
  assert.equal(kutsut.length, 1);
  const nebius = join(TMP, 'nebius-kaikki');
  writeFileSync(nebius, '');
  const kaikki = await kaikkiMallit({ aja, kello: () => 1_000, nebiusTiedosto: nebius });
  assert.deepEqual(kaikki.slice(-3), NEBIUS_CHAT_MALLIT);
  assert.ok(!kaikki.some((m) => m.nimi === 'android/gemini'));
});

test('paikallisetMallit ja mallinNayttonimi: upotusmallit pois, virheellinen JSON → tyhjä, kvantisointi kuten vanha', () => {
  assert.deepEqual(paikallisetMallit('ei json'), []);
  assert.deepEqual(paikallisetMallit('{"data":"x"}'), []);
  assert.deepEqual(paikallisetMallit('{"data":[{"id":"text-embedding-x"},{"id":"-huono"},{"id":5},null,{"id":"a/b-7b"}]}'),
    [{ nimi: 'palvelin/a/b-7b', kuvaus: 'B 7B', tyyppi: 'paikallinen' }]);
  assert.equal(mallinNayttonimi('qwen3.5-9b-q4_k_m.gguf'), 'Qwen3.5 9B');
  assert.equal(mallinNayttonimi('qwen/qwen3.6-35b-a3b'), 'Qwen3.6 35B A3B');
});

test('autentikointi: ilman avainta 401 (ei ssh-kutsua)', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'agentit-lmstudio-vastaa');
  await palvelimella(fix, async (portti, ctx) => {
    const { request } = await import('node:http');
    const status = await new Promise((ok, ei) => { const r = request({ host: '127.0.0.1', port: portti, path: '/api/agentit' }, (res) => { res.resume(); ok(res.statusCode); }); r.on('error', ei); r.end(); });
    assert.equal(status, 401);
    assert.equal(ctx.kutsut.length, 0);
  });
});

// adapteri.mjs --adb → ymp.adb → GET /api/agentit listaa android/gemini (ilman --adb ei). Oikea prosessi, PATHissa tmux-mockin adb ja ssh
// (ei oikeaa laitetta 127.0.0.1:5555 eikä oikeaa ssh:ta; TMUX_MOCK_LOKI/DATA koehakemistossa, oletusvastaukset tyhjiä).
test('adapteri --adb: android/gemini agenttilistalla, ilman --adb ei', async () => {
  const adapteri = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapteri.mjs');
  const mockit = join(dirname(fileURLToPath(import.meta.url)), '..', 'testidata', 'tmux-mock');
  const vapaa = () => new Promise((ok) => { const x = createServer(); x.listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => ok(p)); }); });
  const hae = (portti, polku = '/api/agentit') => new Promise((ok, ei) => {
    const req = request({ host: '127.0.0.1', port: portti, path: polku, headers: { authorization: `Bearer ${'k'.repeat(48)}` } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => ok({ status: res.statusCode, runko: d ? JSON.parse(d) : null }));
    });
    req.on('error', ei); req.end();
  });
  const ajaAdapteri = async (nimi, liput, { polku, ssh } = {}) => {
    const koti = join(TMP, `adb-${nimi}`);
    mkdirSync(join(koti, '.config', 'scopes2'), { recursive: true });
    mkdirSync(join(koti, 'projektit'), { recursive: true });
    mkdirSync(join(koti, 'mockdata'), { recursive: true });
    writeFileSync(join(koti, '.config', 'scopes2', 'avain'), 'k'.repeat(48));
    if (ssh) writeFileSync(join(koti, 'mockdata', 'ssh.json'), JSON.stringify(ssh));
    const portti = await vapaa();
    const lapsi = spawn(process.execPath, [adapteri, '--ydin', 'http://127.0.0.1:1', '--projektit', join(koti, 'projektit'), '--toiminnot', String(portti), ...liput], {
      env: { ...process.env, HOME: koti, PATH: `${mockit}:${dirname(process.execPath)}:/usr/bin:/bin`, TMUX_MOCK_LOKI: join(koti, 'mock.loki'), TMUX_MOCK_DATA: join(koti, 'mockdata') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let virhe = '';
    lapsi.stderr.on('data', (c) => { virhe += c; });
    let v = null;
    for (let i = 0; i < 100 && !v; i++) { v = await hae(portti, polku).catch(() => null); if (!v) await new Promise((r) => setTimeout(r, 100)); }
    return { lapsi, v, virhe: () => virhe };
  };
  const a = await ajaAdapteri('on', ['--adb', 'koe-laite:1']);
  const b = await ajaAdapteri('ei', []);
  // ymp.paikalliset-oletus: purkajalista (T-68) saa palvelimen LM Studio -mallit ssh:n yli (mock), ilman --adb:tä.
  const c = await ajaAdapteri('paik', [], { polku: '/api/purkajat', ssh: [{ sisaltaa: 'curl -s -m 5 http://127.0.0.1:1234/v1/models', stdout: '{"data":[{"id":"qwen/qwen3.5-9b"},{"id":"text-embedding-x"},{"id":"google/gemma-4-12b"}]}' }] });
  try {
    assert.ok(c.v, `ei kuuntele; stderr: ${c.virhe()}`);
    assert.equal(c.v.status, 200);
    const lms = JSON.stringify(c.v.runko);
    assert.ok(lms.includes('paikallinen:qwen/qwen3.5-9b') && lms.includes('paikallinen:google/gemma-4-12b'), `LM Studio -mallit puuttuvat purkajalistalta: ${lms}`);
    assert.ok(!lms.includes('text-embedding-x'), 'upotusmalli listalla');
    assert.ok(a.v, `ei kuuntele; stderr: ${a.virhe()}`);
    assert.equal(a.v.status, 200);
    assert.ok(a.v.runko.some((m) => m.nimi === GEMINI_AGENTTI.nimi), 'android/gemini puuttuu --adb:llä');
    assert.ok(b.v, `ei kuuntele; stderr: ${b.virhe()}`);
    assert.equal(b.v.status, 200);
    assert.ok(!b.v.runko.some((m) => m.nimi === GEMINI_AGENTTI.nimi), 'android/gemini mukana ilman --adb:tä');
  } finally { a.lapsi.kill('SIGKILL'); b.lapsi.kill('SIGKILL'); c.lapsi.kill('SIGKILL'); }
});
