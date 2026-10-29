// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/uusi.test.mjs
// T-81 (ARK-16, S-10): POST /api/uusi. Jokainen testidata/toiminnot/uusi-*.json ajetaan oikean HTTP-toimintopalvelimen (luoToimintopalvelin,
// portti 0) läpi ja verrataan fixtureen (status, runko, argv, ajaValinnat). Lisäksi yhteinen toimintolukko (429, vapautuu), toimintoloki
// ja agy-luonnin vaiheiden järjestys. Oma mock-aja (agy, luo-skooppi, install.sh ja git fixturen ymparisto.komennot-vastauksista), koska
// testiapurit.mjs:n luoMockAja ei tunne niitä; testiapurit.mjs:stä käytetään vain olemassa olevia apureita. Ei oikeaa autovaihtoa, agy:tä eikä gitiä.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toimintoKaynnissa, yksiToiminto } from './aja.mjs';
import { luoToimintopalvelin } from './palvelin.mjs';
import { REITIT } from './uusi.mjs';
import { KAIKKI, toteutetut } from './reitit.mjs';
import { TMP, avainTiedosto, kokoaYmparisto, lataaFixturet, pyyda, vertaaFixtureen } from './testiapurit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

const fixturet = lataaFixturet(/^uusi-/);
const hae = (nimi) => structuredClone(fixturet.find((f) => f.tapaus === nimi));

const syvaKartta = (x, f) => (typeof x === 'string' ? f(x) : Array.isArray(x) ? x.map((y) => syvaKartta(y, f))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, syvaKartta(v, f)])) : x);

// Tallentava aja-väärennös: autovaihto.sh (ymparisto.komennot.autovaihto, pidettävissä), luo-skooppi.mjs (komennot["luo-skooppi"]) sekä
// komennot.vastaukset = [{ komento, sisaltaa?, koodi?, stdout?, stderr? }] (agy, bash install.sh, git); oletus koodi 0 ja tyhjä tuloste.
function luoAja(ymp2, ctx) {
  const tulos = (t = {}) => ({ koodi: t.koodi ?? 0, stdout: t.stdout ?? '', stderr: t.stderr ?? '' });
  return async (komento, argv, valinnat = {}) => {
    ctx.kutsut.push({ kutsu: [komento, ...argv], valinnat: valinnat.cwd ? { cwd: valinnat.cwd } : {} });
    if (komento === 'bash' && argv[0].endsWith('autovaihto.sh')) {
      if (ctx.pito && !ctx.pito.otettu) { ctx.pito.otettu = true; ctx.pito.saavutettu(); await ctx.pito.esto; }
      return tulos(ymp2.komennot.autovaihto);
    }
    if (komento === 'node' && argv[0].endsWith('luo-skooppi.mjs')) return tulos(ymp2.komennot['luo-skooppi'] ?? { koodi: 1, stderr: 'ei vastausta' });
    const v = (ymp2.komennot.vastaukset ?? []).find((r) => r.komento === komento && (!r.sisaltaa || argv.join(' ').includes(r.sisaltaa)));
    if (v) return tulos(v);
    if (komento === 'git' || (komento === 'bash' && argv[0].endsWith('install.sh'))) return tulos();
    throw new Error(`uusi.test: odottamaton komento ${komento} ${argv.join(' ')}`);
  };
}

// Palvelin fixturen ympäristöllä. Palauttaa havainto(pyynto), pida() (autovaihto-kutsu kesken) ja ctx.loki.
async function palvelin(fix) {
  const k = kokoaYmparisto(fix.ymparisto);
  const ctx = { kutsut: [], pito: null, loki: [] };
  const nebiusTiedosto = join(k.d, 'ei-nebius-avainta');
  const lisa = { istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, nebiusTiedosto, agyHakemisto: join(k.d, 'agy'), brainHakemisto: join(k.d, 'brain') };
  const p = luoToimintopalvelin({
    portti: 0, koukut: [], avainTiedosto, juuri: k.juuri, tila: k.tila, aja: luoAja(k.ymp2, ctx), kello: () => Date.parse('2026-10-21T09:00:00.000Z'),
    loki: (rivi) => ctx.loki.push(rivi),
    reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) })),
  });
  const portti = await p.kuuntele();
  const korvaukset = [[k.juuri, '<JUURI>']];
  const norm = (x) => syvaKartta(x, (s) => korvaukset.reduce((t, [a, b]) => t.replaceAll(a, b), s));
  const pida = () => {
    let vapauta;
    let saavutettu;
    const lupaus = new Promise((ok) => { saavutettu = ok; });
    ctx.pito = { esto: new Promise((ok) => { vapauta = ok; }), saavutettu, otettu: false };
    return { saavutettu: lupaus, vapauta: () => vapauta() };
  };
  const havainto = async (pyynto) => {
    ctx.kutsut.length = 0;
    const v = await pyyda(portti, pyynto);
    const h = { status: v.status, runko: JSON.parse(v.teksti), aja: ctx.kutsut.map((c) => c.kutsu) };
    if (ctx.kutsut.some((c) => Object.keys(c.valinnat).length)) h.ajaValinnat = ctx.kutsut.map((c) => c.valinnat);
    return norm(h);
  };
  return { k, ctx, portti, pida, havainto, ymp: { tila: k.tila }, sulje: async () => { await p.sulje(); rmSync(k.d, { recursive: true, force: true }); } };
}

// Koko replay: samanaikainen pyyntö pidetään autovaihto-kutsussa varsinaisen pyynnön ajan.
async function ajaFixture(fix) {
  const p = await palvelin(fix);
  try {
    let kesken = null;
    let pito = null;
    if (p.k.ymp2.samanaikainen) {
      pito = p.pida();
      kesken = pyyda(p.portti, p.k.ymp2.samanaikainen);
      await pito.saavutettu;
    }
    const h = await p.havainto(fix.pyynto);
    if (pito) { pito.vapauta(); await kesken; }
    return { havainto: h, loki: p.ctx.loki };
  } finally {
    await p.sulje();
  }
}

// ---------- reitit ja fixturet ----------
test('reitit: POST /api/uusi toteutettu ja terveyslistalla', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['POST /api/uusi']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  assert.ok(toteutetut(KAIKKI).includes('POST /api/uusi'));
});

test('fixturet: kaikki 12 uusi-tapausta mukana', () => {
  assert.deepEqual(fixturet.map((f) => f.tapaus).sort(), [
    'uusi-agy', 'uusi-agy-asennus-epaonnistuu', 'uusi-agy-commit-epaonnistuu', 'uusi-agy-ei-scopes-perhe', 'uusi-autovaihto-epaonnistuu',
    'uusi-nimi-puuttuu', 'uusi-ok', 'uusi-ok-valinnat', 'uusi-skooppi-on-jo', 'uusi-toinen-toiminto-kaynnissa', 'uusi-tuntematon-malli', 'uusi-virheellinen-nimi',
  ]);
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const { havainto } = await ajaFixture(fix);
    vertaaFixtureen(fix, havainto);
  });
}

// ---------- lukko ja loki ----------
test('lukko: uusi varaa yhteisen toimintolukon ja vapauttaa sen onnistumisen ja virheen jälkeen', async () => {
  const p = await palvelin(hae('uusi-ok'));
  try {
    const pito = p.pida();
    const kesken = pyyda(p.portti, hae('uusi-ok').pyynto);
    await pito.saavutettu;
    assert.equal(toimintoKaynnissa(p.ymp), 'uusi');
    pito.vapauta();
    assert.equal((await kesken).status, 200);
    assert.equal(toimintoKaynnissa(p.ymp), null);
    const h = await p.havainto({ metodi: 'POST', polku: '/api/uusi', runko: { nimi: 'Väärä!' } });
    assert.equal(h.status, 400);
    assert.equal(toimintoKaynnissa(p.ymp), null);
  } finally {
    await p.sulje();
  }
});

test('T-111 lukko: uusi ja pura/pakkaa eivät aja yhtä aikaa (yhteinen aja.mjs-lukko, 429 kuten vanhassa; sama lukko molempiin suuntiin)', async () => {
  const p = await palvelin(hae('uusi-ok'));
  try {
    const pito = p.pida();
    const kesken = pyyda(p.portti, hae('uusi-ok').pyynto);
    await pito.saavutettu;
    for (const toiminto of ['pura', 'pakkaa']) {
      let ajettiin = false;
      await assert.rejects(yksiToiminto(p.ymp, toiminto, 'x', async () => { ajettiin = true; return {}; }),
        (e) => e.koodi === 429 && e.message === 'toinen toiminto on käynnissä (uusi)');
      assert.equal(ajettiin, false);
    }
    pito.vapauta();
    assert.equal((await kesken).status, 200);
    // toiseen suuntaan: pura pitää lukon, uusi saa 429
    let vapautaPura;
    const puraKesken = yksiToiminto(p.ymp, 'pura', 'x', () => new Promise((ok) => { vapautaPura = () => ok({}); }));
    await new Promise((ok) => setImmediate(ok));
    assert.equal(toimintoKaynnissa(p.ymp), 'pura');
    const h = await p.havainto(hae('uusi-ok').pyynto);
    assert.deepEqual([h.status, h.runko], [429, { virhe: 'toinen toiminto on käynnissä (pura)' }]);
    vapautaPura();
    await puraKesken;
    assert.equal(toimintoKaynnissa(p.ymp), null);
  } finally {
    await p.sulje();
  }
});

test('loki: onnistunut ja hylätty yritys kirjataan toimintolokiin nimellä', async () => {
  const { loki } = await ajaFixture(hae('uusi-ok'));
  assert.equal(loki.length, 1);
  assert.deepEqual([loki[0].toiminto, loki[0].nimi, loki[0].tulos], ['uusi', 'uusi koe', 'ok']);
  const { loki: hylatty } = await ajaFixture(hae('uusi-skooppi-on-jo'));
  assert.deepEqual([hylatty[0].toiminto, hylatty[0].nimi, hylatty[0].tulos, hylatty[0].syy], ['uusi', 'a', 'hylätty', 'skooppi on jo olemassa']);
});

test('agy: luonti ennen autovaihtoa, autovaihto ilman --viesti-lippua; epäonnistuneen commitin jälkeen istuntoa ei avata', async () => {
  const { havainto } = await ajaFixture(hae('uusi-agy'));
  const nimet = havainto.aja.map((a) => a[1].split('/').pop());
  assert.deepEqual(nimet, ['models', 'luo-skooppi.mjs', 'install.sh', 'add', 'commit', 'autovaihto.sh']);
  assert.ok(!havainto.aja.at(-1).includes('--viesti'));
  const { havainto: kaatui } = await ajaFixture(hae('uusi-agy-commit-epaonnistuu'));
  assert.ok(!kaatui.aja.some((a) => a[0] === 'bash' && a[1].endsWith('autovaihto.sh')));
});

test('luo-skooppi exit 4 (olemassa) → varoitus; muu poikkeava exit → 500', async () => {
  const fix = hae('uusi-agy');
  fix.ymparisto.komennot['luo-skooppi'].koodi = 4;
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual([havainto.status, havainto.runko.varoitus], [200, true]);
  const huono = hae('uusi-agy');
  Object.assign(huono.ymparisto.komennot['luo-skooppi'], { koodi: 2, stderr: 'rikki\n' });
  const { havainto: h2 } = await ajaFixture(huono);
  assert.deepEqual([h2.status, h2.runko], [500, { virhe: 'rikki' }]);
});
