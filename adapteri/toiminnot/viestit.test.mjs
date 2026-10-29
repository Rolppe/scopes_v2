// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/viestit.test.mjs
// T-66 (ARK-16, S-10): viesti, stream, stop ja kysymys-pois. Jokainen testidata/toiminnot/{viesti,stream,stop,kysymys-pois}-*.json
// ajetaan oikean HTTP-toimintopalvelimen (luoToimintopalvelin, portti 0) läpi ja verrataan fixtureen: status, runko tai NDJSON-rivit,
// tmux-/ssh-argv-jono (ilman `tmux list-panes` -hakuja), ajaValinnat ja viiveet.
// Replay-apurit (lataaFixturet, kokoaYmparisto, luoMockAja, pyyda, ajaFixture, vertaaFixtureen) ovat tiedostossa testiapurit.mjs (T-67).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { luoToimintopalvelin } from './palvelin.mjs';
import { KAIKKI, toteutetut } from './reitit.mjs';
import { TMP, ajaFixture, avainTiedosto, kokoaYmparisto, lataaFixturet, luoMockAja, pyyda, vertaaFixtureen } from './testiapurit.mjs';
import { REITIT } from './viestit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------- testit ----------
const fixturet = lataaFixturet(/^(viesti|stream|stop|kysymys-pois)-/);

test('reitit: neljä viestireittiä toteutettu ja terveyslistalla', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['POST /api/skoopit/*/viesti', 'POST /api/skoopit/*/stream', 'POST /api/skoopit/*/stop', 'POST /api/skoopit/*/kysymys-pois']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  for (const r of REITIT) assert.ok(toteutetut(KAIKKI).includes(`${r.metodi} ${r.kuvio}`));
});

test('fixturet: jokainen viesti-, stream-, stop- ja kysymys-pois-ryhmä on katettu', () => {
  const nimet = fixturet.map((f) => f.tapaus);
  for (const p of ['viesti-ok', 'viesti-kysymys-auki', 'viesti-vaara-ruutu', 'viesti-ei-istuntoa', 'viesti-liian-pitka', 'stream-ok', 'stop-kiireinen', 'stop-vapaa', 'kysymys-pois-ok', 'kysymys-pois-ei-kysymysta']) {
    assert.ok(nimet.includes(p), `puuttuu: ${p}`);
  }
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const { havainto } = await ajaFixture(fix, { reitit: REITIT });
    vertaaFixtureen(fix, havainto);
  });
}

test('oletus-odotus: 800 ms:n Escape-tauko toimii ilman injektoitua odotusta (escapeTauko 1 ms)', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'viesti-kysymys-auki');
  const { havainto } = await ajaFixture(fix, { reitit: REITIT, oikeaOdotus: true, lisaYmp: { escapeTauko: 1 } });
  assert.equal(havainto.status, 200);
  assert.deepEqual(havainto.aja, fix.odotus.aja);
  assert.equal(havainto.viiveet, undefined);
});

test('viesti: toimintolokiin ok-rivi (muoto kuten vanha: toiminto, nimi, istunto, merkkeja, alku, kesto, tulos)', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'viesti-ok');
  const { loki } = await ajaFixture(fix, { reitit: REITIT });
  assert.equal(loki.length, 1);
  assert.deepEqual({ ...loki[0], aika: undefined }, { aika: undefined, toiminto: 'viesti', nimi: 'a', istunto: 's1', merkkeja: 11, alku: 'Hei maailma', kesto: 0, tulos: 'ok' });
  assert.match(loki[0].aika, /^2026-10-21T09:00:00\.000Z$/);
});

test('viesti: teksti ei näy transkriptissa → 504, capture-pane ja lokirivi "ei näkynyt" (kello etenee, ei oikeaa odotusta)', async () => {
  const fix = structuredClone(fixturet.find((f) => f.tapaus === 'viesti-ok'));
  fix.ymparisto.tmux.vastaanottaa = false;
  fix.ymparisto.tmux['capture-pane'] = 'rivi 1\n\nrivi 2\n';
  const { havainto, loki, kello } = await ajaFixture(fix, { reitit: REITIT });
  assert.equal(havainto.status, 504);
  assert.equal(havainto.runko.virhe, 'viesti ei näkynyt istunnossa — se voi odottaa istunnon syöttökentässä; tarkista ennen uudelleenlähetystä');
  assert.deepEqual(havainto.aja.at(-1), ['tmux', 'capture-pane', '-p', '-t', '%5']);
  assert.ok(havainto.viiveet.length >= 20 && havainto.viiveet.every((v) => v === 500), `viiveet ${havainto.viiveet}`);
  assert.equal(loki.length, 1);
  assert.equal(loki[0].tulos, 'ei näkynyt');
  assert.deepEqual(loki[0].ruutu, ['rivi 1', 'rivi 2']);
  assert.ok(loki[0].kesto >= 10_000 && kello - Date.parse('2026-10-21T09:00:00.000Z') >= 10_000);
});

test('viesti: liian suuri runko → 413, tuntematon skooppi → 404, tyhjä teksti → 400', async () => {
  const pohja = fixturet.find((f) => f.tapaus === 'viesti-ok');
  const hae = async (muokkaa) => { const f = structuredClone(pohja); muokkaa(f); return (await ajaFixture(f, { reitit: REITIT })).havainto; };
  const iso = await hae((f) => { f.pyynto.runko = { teksti: 'x'.repeat(40_000) }; });
  assert.deepEqual([iso.status, iso.runko], [413, { virhe: 'runko liian suuri' }]);
  const tuntematon = await hae((f) => { f.pyynto.polku = '/api/skoopit/ei-ole/viesti'; });
  assert.deepEqual([tuntematon.status, tuntematon.runko], [404, { virhe: 'tuntematon skooppi' }]);
  const tyhja = await hae((f) => { f.pyynto.runko = { teksti: '   ' }; });
  assert.deepEqual([tyhja.status, tyhja.runko], [400, { virhe: 'viesti puuttuu' }]);
});

test('stop ja kysymys-pois: URL-koodattu skoopin nimi puretaan (osat[0])', async () => {
  const fix = structuredClone(fixturet.find((f) => f.tapaus === 'stop-kiireinen'));
  fix.ymparisto.skooppitiedot = { 'scopes infra': ['R.md'] };
  fix.ymparisto.istunnot[0].sisalto.name = 'scopes infra';
  fix.pyynto.polku = '/api/skoopit/scopes%20infra/stop';
  const { havainto } = await ajaFixture(fix, { reitit: REITIT });
  assert.equal(havainto.status, 200);
  assert.deepEqual(havainto.aja.at(-1), ['tmux', 'send-keys', '-t', '%5', 'Escape']);
});

// agy-ruudut (ei fixtureja): stop ja kysymys-pois lähettävät Escapen agy-ruutuun vanhan lahteet/agy-istunto-logiikan mukaan.
const AGY = { skooppitiedot: { a: ['R.md'] }, istunnot: [], transkriptit: [], komennot: {} };
const agyRuutu = (capture) => ({ ...AGY, tmux: { 'display-message': 'agy\n', 'capture-pane': capture, 'list-panes': 'siirto-a-123456 agy 1700000000 4242\n' } });
const agyTapaus = (polku, capture) => ({ tapaus: `agy-${polku}`, pyynto: { metodi: 'POST', polku: `/api/skoopit/a/${polku}`, runko: {} }, ymparisto: agyRuutu(capture) });

test('agy: stop työssä olevalle agy-ruudulle → Escape; vapaa agy-ruutu → 409', async () => {
  const ty = (await ajaFixture(agyTapaus('stop', 'Thinking...\n'), { reitit: REITIT })).havainto;
  assert.deepEqual([ty.status, ty.runko], [200, { ok: true, istunto: 'siirto-a-123456' }]);
  assert.deepEqual(ty.aja.at(-1), ['tmux', 'send-keys', '-t', 'siirto-a-123456', 'Escape']);
  const vapaa = (await ajaFixture(agyTapaus('stop', '> \n? for shortcuts\n'), { reitit: REITIT })).havainto;
  assert.deepEqual([vapaa.status, vapaa.runko], [409, { virhe: 'istunto ei ole työssä' }]);
  assert.ok(!vapaa.aja.some((a) => a[1] === 'send-keys'));
});

test('agy: kysymys-pois auki olevalle kysymykselle → Escape + lokirivi; ilman kysymystä 409', async () => {
  const auki = await ajaFixture(agyTapaus('kysymys-pois', 'Question 1/1\nNavigate · enter Select\n'), { reitit: REITIT });
  assert.deepEqual([auki.havainto.status, auki.havainto.runko], [200, { ok: true, istunto: 'siirto-a-123456' }]);
  assert.deepEqual(auki.havainto.aja.at(-1), ['tmux', 'send-keys', '-t', 'siirto-a-123456', 'Escape']);
  assert.equal(auki.loki[0].toiminto, 'sulje-kysymys');
  assert.equal(auki.loki[0].agy, true);
  const ei = (await ajaFixture(agyTapaus('kysymys-pois', '> \n? for shortcuts\n'), { reitit: REITIT })).havainto;
  assert.deepEqual([ei.status, ei.runko], [409, { virhe: 'ei auki olevaa kysymystä' }]);
});

test('oletuspalvelin: oletusloki kirjoittaa tila/toiminnot.loki-tiedostoon (S-10), ymp.loki-rivi saa aikaleiman', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'viesti-ok');
  const k = kokoaYmparisto(fix.ymparisto);
  const ctx = { kutsut: [], kentta: '' };
  const palvelin = luoToimintopalvelin({ portti: 0, reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, odota: async () => {} }) })),
    koukut: [], avainTiedosto, juuri: k.juuri, tila: k.tila, aja: luoMockAja(k.ymp2, k.istunnonTranskripti, ctx) });
  const portti = await palvelin.kuuntele();
  try {
    assert.equal((await pyyda(portti, fix.pyynto)).status, 200);
    const rivit = readFileSync(join(k.tila, 'toiminnot.loki'), 'utf8').trim().split('\n').map((r) => JSON.parse(r));
    assert.equal(rivit.length, 1);
    assert.deepEqual({ ...rivit[0], aika: null, kesto: null }, { aika: null, toiminto: 'viesti', nimi: 'a', istunto: 's1', merkkeja: 11, alku: 'Hei maailma', kesto: null, tulos: 'ok' });
    assert.match(rivit[0].aika, /^\d{4}-\d\d-\d\dT/);
  } finally {
    await palvelin.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});
