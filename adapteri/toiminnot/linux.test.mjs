// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/linux.test.mjs
// T-86 (ARK-19, S-10): GET /api/palvelin ja POST /api/palvelin/<kaynnista|sammuta>. Jokainen testidata/toiminnot/linux-*.json
// ajetaan oikean HTTP-toimintopalvelimen (luoToimintopalvelin, portti 0) läpi ja verrataan fixtureen (status, runko, ping-/ssh-/python3-argv).
// Lisäksi kuivatila (ymp.linuxKuiva ja SCOPES2_LINUX_KUIVA=1), 429 rinnakkaisella toiminnolla ja lukon vapautuminen, herata-pc.py:n polku
// ymp.juuri:sta sekä toimintoloki. Oma mock-aja (ping, python3, ssh fixturen ymparisto.komennot.vastaukset-säännöistä); ei oikeaa pingiä,
// WoL:ia (herata-pc.py) eikä ssh:ta palvelimeen tai pc:hen.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { luoToimintopalvelin } from './palvelin.mjs';
import { REITIT } from './linux.mjs';
import { KAIKKI, toteutetut } from './reitit.mjs';
import { TMP, avainTiedosto, kokoaYmparisto, lataaFixturet, pyyda, vertaaFixtureen } from './testiapurit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

const fixturet = lataaFixturet(/^linux-/);
const hae = (nimi) => structuredClone(fixturet.find((f) => f.tapaus === nimi));

const syvaKartta = (x, f) => (typeof x === 'string' ? f(x) : Array.isArray(x) ? x.map((y) => syvaKartta(y, f))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, syvaKartta(v, f)])) : x);

// Tallentava aja-väärennös: komennot.vastaukset = [{ komento, sisaltaa?, koodi?, stdout?, stderr? }], ensimmäinen osuva; ei osuvaa = koodi 1
// (ping ei vastaa). ctx.pito = { komento } pysäyttää ensimmäisen osuvan kutsun, kunnes pito vapautetaan.
function luoAja(ymp2, ctx) {
  return async (komento, argv) => {
    ctx.kutsut.push([komento, ...argv]);
    const pito = ctx.pito;
    if (pito && !pito.otettu && pito.komento === komento) { pito.otettu = true; pito.saavutettu(); await pito.esto; }
    const v = (ymp2.komennot.vastaukset ?? []).find((r) => r.komento === komento && (!r.sisaltaa || argv.join(' ').includes(r.sisaltaa)));
    return { koodi: v?.koodi ?? (v ? 0 : 1), stdout: v?.stdout ?? '', stderr: v?.stderr ?? '' };
  };
}

// Palvelin fixturen ympäristöllä; lisaYmp = ymp-lisät reiteille (linuxKuiva).
async function palvelin(fix, lisaYmp = {}) {
  const k = kokoaYmparisto(fix.ymparisto);
  const ctx = { kutsut: [], pito: null };
  const lisa = { ...(k.ymp2.linux?.kuiva ? { linuxKuiva: true } : {}), ...lisaYmp };
  const p = luoToimintopalvelin({
    portti: 0, koukut: [], avainTiedosto, juuri: k.juuri, tila: k.tila, aja: luoAja(k.ymp2, ctx),
    reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) })),
  });
  const portti = await p.kuuntele();
  const norm = (x) => syvaKartta(x, (s) => s.replaceAll(k.juuri, '<REPO>'));
  const pida = (komento = 'python3') => {
    let vapauta;
    let saavutettu;
    const lupaus = new Promise((ok) => { saavutettu = ok; });
    ctx.pito = { komento, esto: new Promise((ok) => { vapauta = ok; }), saavutettu, otettu: false };
    return { saavutettu: lupaus, vapauta: () => vapauta() };
  };
  const havainto = async (pyynto) => {
    ctx.kutsut.length = 0;
    const v = await pyyda(portti, pyynto);
    return norm({ status: v.status, runko: JSON.parse(v.teksti), aja: [...ctx.kutsut] });
  };
  return { k, ctx, portti, pida, havainto, sulje: async () => { await p.sulje(); rmSync(k.d, { recursive: true, force: true }); } };
}

// Koko replay: samanaikainen pyyntö pidetään fixturen pito-komennossa varsinaisen pyynnön ajan.
async function ajaFixture(fix, lisaYmp) {
  const p = await palvelin(fix, lisaYmp);
  try {
    let kesken = null;
    let pito = null;
    const s = p.k.ymp2.samanaikainen;
    if (s) {
      pito = p.pida(s.pito);
      kesken = pyyda(p.portti, s);
      await pito.saavutettu;
    }
    const h = await p.havainto(fix.pyynto);
    if (pito) { pito.vapauta(); await kesken; }
    return { havainto: h, k: p.k };
  } finally {
    await p.sulje();
  }
}

// ---------- reitit ja fixturet ----------
test('reitit: GET /api/palvelin ja POST /api/palvelin/* toteutettu ja terveyslistalla', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['GET /api/palvelin', 'POST /api/palvelin/*']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  for (const r of REITIT) assert.ok(toteutetut(KAIKKI).includes(`${r.metodi} ${r.kuvio}`));
});

test('fixturet: kaikki 21 linux-tapausta mukana', () => {
  assert.equal(fixturet.length, 21);
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const { havainto } = await ajaFixture(fix);
    vertaaFixtureen(fix, havainto);
  });
}

// ---------- kuivatila, lukko, polku, loki ----------
test('kuiva: SCOPES2_LINUX_KUIVA=1 ajaa saman kuin ymp.linuxKuiva (ei python3- eikä ssh-kutsua)', async () => {
  const vanha = process.env.SCOPES2_LINUX_KUIVA;
  process.env.SCOPES2_LINUX_KUIVA = '1';
  try {
    for (const nimi of ['linux-kaynnista-sammuksissa-kuiva', 'linux-kaynnista-windows-kuiva', 'linux-sammuta-kuiva']) {
      const fix = hae(nimi);
      delete fix.ymparisto.linux;
      const { havainto } = await ajaFixture(fix);
      vertaaFixtureen(fix, havainto);
      assert.ok(havainto.runko.kuiva, nimi);
      assert.ok(havainto.aja.every((a) => a[0] === 'ping'), `${nimi}: vain ping`);
    }
  } finally {
    if (vanha === undefined) delete process.env.SCOPES2_LINUX_KUIVA; else process.env.SCOPES2_LINUX_KUIVA = vanha;
  }
});

test('ei kuiva ilman asetusta: käynnistys sammuksista ajaa herata-pc.py:n', async () => {
  const { havainto } = await ajaFixture(hae('linux-kaynnista-sammuksissa'));
  assert.ok(havainto.aja.some((a) => a[0] === 'python3'));
  assert.equal(havainto.runko.kuiva, undefined);
});

test('herata-pc.py ratkaistaan ymp.juuri:sta (ei vanhasta/-hakemistosta)', async () => {
  const { havainto } = await ajaFixture(hae('linux-kaynnista-sammuksissa'));
  assert.deepEqual(havainto.aja.find((a) => a[0] === 'python3'), ['python3', '<REPO>/Infra/linux/palvelin/herata-pc.py', '--odota', '90']);
});

test('lukko: 429 rinnakkaiselle toiminnolle (kumpikin suunta) ja lukko vapautuu', async () => {
  for (const nimi of ['linux-kaynnista-toinen-toiminto-kaynnissa', 'linux-sammuta-toinen-toiminto-kaynnissa']) {
    const p = await palvelin(hae(nimi));
    try {
      const pito = p.pida('python3');
      const kesken = pyyda(p.portti, hae(nimi).ymparisto.samanaikainen);
      await pito.saavutettu;
      const h = await p.havainto(hae(nimi).pyynto);
      assert.deepEqual([h.status, h.runko], [429, { virhe: 'kaynnista on jo käynnissä' }], nimi);
      pito.vapauta();
      assert.equal((await kesken).status, 200);
      const jalkeen = await p.havainto({ metodi: 'GET', polku: '/api/palvelin', runko: null });
      assert.equal(jalkeen.status, 200);
      const uusi = await p.havainto({ metodi: 'POST', polku: '/api/palvelin/kaynnista', runko: {} });
      assert.notEqual(uusi.status, 429, 'lukko vapautui');
    } finally {
      await p.sulje();
    }
  }
});

test('loki: toiminnot kirjataan tilahakemiston toiminnot.lokiin, tila-haku ei', async () => {
  const p = await palvelin(hae('linux-kaynnista-sammuksissa'));
  try {
    await p.havainto({ metodi: 'GET', polku: '/api/palvelin', runko: null });
    await p.havainto(hae('linux-kaynnista-sammuksissa').pyynto);
    await p.havainto({ metodi: 'POST', polku: '/api/palvelin/ei-ole', runko: {} });
    const rivit = readFileSync(join(p.k.tila, 'toiminnot.loki'), 'utf8').trim().split('\n').map((r) => JSON.parse(r));
    assert.deepEqual(rivit.map((r) => [r.toiminto, r.tulos]), [['palvelin kaynnista', 'ok'], ['palvelin ei-ole', 'hylätty']]);
    assert.equal(rivit[1].syy, 'tuntematon toiminto');
  } finally {
    await p.sulje();
  }
});

test('turva: GET ei koskaan aja python3- tai ssh-komentoa; sammutus ei aja ssh:ta, kun kone on sammuksissa tai Windowsissa', async () => {
  for (const nimi of ['linux-tila-linux', 'linux-tila-windows', 'linux-tila-sammuksissa', 'linux-sammuta-sammuksissa', 'linux-sammuta-windows']) {
    const { havainto } = await ajaFixture(hae(nimi));
    assert.ok(havainto.aja.every((a) => a[0] === 'ping'), nimi);
  }
});

test('loki: kuivatilan kuiva-teksti lokissa on sama korjattu herata-pc.py-polku kuin vastauksessa', async () => {
  const p = await palvelin(hae('linux-kaynnista-sammuksissa-kuiva'));
  try {
    const v = await p.havainto(hae('linux-kaynnista-sammuksissa-kuiva').pyynto);
    assert.equal(v.status, 200);
    const rivit = readFileSync(join(p.k.tila, 'toiminnot.loki'), 'utf8').trim().split('\n').map((r) => JSON.parse(r));
    assert.equal(rivit.length, 1);
    assert.equal(rivit[0].toiminto, 'palvelin kaynnista');
    assert.equal(rivit[0].tulos, 'ok');
    assert.equal(rivit[0].kuiva, `python3 ${join(p.k.juuri, 'Infra/linux/palvelin/herata-pc.py')} --odota 90`);
    assert.ok(!rivit[0].kuiva.includes('scopes2/Infra'), 'ei kopion syvyydestä laskettua polkua');
  } finally {
    await p.sulje();
  }
});
