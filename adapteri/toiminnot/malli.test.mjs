// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/malli.test.mjs
// T-80 (ARK-16, S-10): mallin ja effortin vaihto tmuxiin. Jokainen testidata/toiminnot/malli-*.json ajetaan oikean HTTP-toimintopalvelimen
// (luoToimintopalvelin, portti 0) läpi ja verrataan fixtureen: status, runko, tmux-argv-jono (ilman `tmux list-panes` -hakuja) ja viiveet
// (malliTauko 1000 ms ymp.odota-injektiolla, testi ei odota oikeaa sekuntia).
// Fixturen ymparisto.tmux["capture-pane"] voi olla taulukko (peräkkäiset vastaukset kutsu kerrallaan, viimeinen toistuu; tallenna-lisa.mjs:12-31),
// jota testiapurit.mjs:n luoMockAja ei tunne: tämä testi korvaa capture-pane-vastaukset omalla jonollaan reittikääreessä (kutsu kirjautuu silti
// apureiden mockiin, joten argv-jono on apureiden).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { EFFORTIT, MALLIT, REITIT } from './malli.mjs';
import { KAIKKI, toteutetut } from './reitit.mjs';
import { TMP, ajaFixture, lataaFixturet, vertaaFixtureen } from './testiapurit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

const fixturet = lataaFixturet(/^malli-/);
const hae = (nimi) => structuredClone(fixturet.find((f) => f.tapaus === nimi));

// capture-pane-vastaukset fixturen mukaan ymp.aja-kääreellä; muut kutsut ja kirjaus kulkevat apureiden mockin läpi.
// sendKeysKoodi: tmux send-keys palauttaa tämän koodin (virheen simulointi).
function reitit(fix, { sendKeysKoodi = 0 } = {}) {
  const v = fix.ymparisto.tmux['capture-pane'];
  const jono = Array.isArray(v) ? [...v] : [v ?? ''];
  const seuraava = () => (jono.length > 1 ? jono.shift() : (jono[0] ?? ''));
  return REITIT.map((r) => ({
    ...r,
    kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, {
      ...ymp,
      aja: async (komento, argv, valinnat) => {
        const t = await ymp.aja(komento, argv, valinnat);
        if (komento === 'tmux' && argv[0] === 'capture-pane') return { ...t, stdout: seuraava() };
        if (komento === 'tmux' && argv[0] === 'send-keys' && sendKeysKoodi) return { ...t, koodi: sendKeysKoodi };
        return t;
      },
    }),
  }));
}
const aja = (fix, lisa = {}, valinnat = {}) => ajaFixture(fix, { reitit: reitit(fix, valinnat), lisaYmp: lisa });

test('reitit: POST /api/skoopit/*/malli toteutettu ja terveyslistalla', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['POST /api/skoopit/*/malli']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  assert.ok(toteutetut(KAIKKI).includes('POST /api/skoopit/*/malli'));
});

test('listat: MALLIT ja EFFORTIT kuten vanhassa', () => {
  assert.deepEqual(MALLIT.map((m) => m.nimi), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(EFFORTIT, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('fixturet: kaikki 17 malli-tapausta katettu', () => {
  assert.deepEqual(fixturet.map((f) => f.tapaus).sort(), [
    'malli-ei-istuntoa', 'malli-ei-vapaa', 'malli-ei-vapaa-kysymys-kortti', 'malli-effort-ei-vahvistu', 'malli-effort-low-ok',
    'malli-effort-ok', 'malli-effort-vahvistusdialogi', 'malli-effort-vahvistusdialogi-jaa-auki', 'malli-kysymys-auki',
    'malli-malli-ja-effort-ok', 'malli-malli-ok', 'malli-tuntematon-effort', 'malli-tuntematon-malli', 'malli-tuntematon-skooppi',
    'malli-tyhja-runko', 'malli-vaara-ruutu', 'malli-valitsin-ei-aukea',
  ].sort());
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const { havainto } = await aja(fix);
    vertaaFixtureen(fix, havainto);
  });
}

test('oletus-odotus: malliTauko 1 ms toimii ilman injektoitua odotusta (ei viiveitä kirjattu)', async () => {
  const fix = hae('malli-malli-ja-effort-ok');
  const { havainto } = await ajaFixture(fix, { reitit: reitit(fix), oikeaOdotus: true, lisaYmp: { malliTauko: 1 } });
  assert.equal(havainto.status, 200);
  assert.deepEqual(havainto.aja, fix.odotus.aja);
  assert.equal(havainto.viiveet, undefined);
});

test('malliTauko-asetus: ymp.malliTauko määrää tauon pituuden (oletus 1000)', async () => {
  const fix = hae('malli-effort-ok');
  const { havainto } = await aja(fix, { malliTauko: 250 });
  assert.deepEqual(havainto.viiveet, [250, 250]);
});

test('toimintolokiin malli-rivi (toiminto, nimi, istunto, komennot) onnistuneesta vaihdosta; virheestä ei riviä', async () => {
  const ok = await aja(hae('malli-malli-ja-effort-ok'));
  assert.deepEqual(ok.loki.map((r) => ({ ...r, aika: undefined })), [{ aika: undefined, toiminto: 'malli', nimi: 'a', istunto: 'sessio-a-0001', komennot: ['model claude-sonnet-5-5', 'effort xhigh'] }]);
  const ei = await aja(hae('malli-effort-ei-vahvistu'));
  assert.deepEqual(ei.loki, []);
});

test('tmux send-keys epäonnistuu → 502 "tmux send-keys epäonnistui" heti ensimmäisestä näppäimestä', async () => {
  const { havainto } = await aja(hae('malli-malli-ok'), {}, { sendKeysKoodi: 1 });
  assert.deepEqual([havainto.status, havainto.runko], [502, { virhe: 'tmux send-keys epäonnistui' }]);
  assert.equal(havainto.aja.filter((a) => a[1] === 'send-keys').length, 1);
});

test('runko yli 1 kt → 413; runko ilman malli- ja effort-kenttiä (taulukko) → 400; ei näppäilyä', async () => {
  const iso = hae('malli-malli-ok');
  iso.pyynto.runko = { malli: 'x'.repeat(2000) };
  const a = await aja(iso);
  assert.deepEqual([a.havainto.status, a.havainto.runko, a.havainto.aja], [413, { virhe: 'runko liian suuri' }, []]);
  const lista = hae('malli-malli-ok');
  lista.pyynto.runko = [];
  const b = await aja(lista);
  assert.deepEqual([b.havainto.status, b.havainto.runko, b.havainto.aja], [400, { virhe: 'malli tai effort puuttuu' }, []]);
});

test('malli null ja effort null → 400 (null = puuttuu); null malli + kelvollinen effort vaihtaa vain effortin', async () => {
  const tyhja = hae('malli-malli-ok');
  tyhja.pyynto.runko = { malli: null, effort: null };
  assert.deepEqual((await aja(tyhja)).havainto.runko, { virhe: 'malli tai effort puuttuu' });
  const vain = hae('malli-effort-ok');
  vain.pyynto.runko = { malli: null, effort: 'high' };
  const { havainto } = await aja(vain);
  assert.equal(havainto.status, 200);
  assert.deepEqual(havainto.aja, vain.odotus.aja);
});

test('effort-näppäimet: Left×4 ja Right×indeksi jokaiselle tasolle', async () => {
  for (const [taso, n] of EFFORTIT.map((t, i) => [t, i])) {
    const fix = hae('malli-effort-ok');
    fix.pyynto.runko = { effort: taso };
    fix.ymparisto.tmux['capture-pane'] = [` Set effort level to ${taso} (this session only)`];
    const { havainto } = await aja(fix);
    assert.equal(havainto.status, 200, taso);
    const nappaimet = havainto.aja.filter((a) => a[1] === 'send-keys' && (a[4] === 'Left' || a[4] === 'Right')).map((a) => a.slice(4));
    assert.deepEqual(nappaimet, [Array(4).fill('Left'), ...(n ? [Array(n).fill('Right')] : [])], taso);
  }
});

test('mallin valinta: Up/Down indeksin erotuksen mukaan, nykyinen malli = ❯-rivi', async () => {
  for (const [malli, kuvaus, ero] of [['claude-fable-5-1', 'Fable 5.1', ['Up']], ['claude-opus-5-5', 'Opus 5.5', []], ['claude-haiku-5-5', 'Haiku 5.5', ['Down', 'Down']]]) {
    const fix = hae('malli-malli-ok');
    fix.pyynto.runko = { malli };
    fix.ymparisto.tmux['capture-pane'][1] = ` Set model to ${kuvaus} (for this session only)`;
    const { havainto } = await aja(fix);
    assert.equal(havainto.status, 200, malli);
    const suunnat = havainto.aja.filter((a) => a[1] === 'send-keys' && (a[4] === 'Up' || a[4] === 'Down')).flatMap((a) => a.slice(4));
    assert.deepEqual(suunnat, ero, malli);
  }
});
