// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/asetukset.test.mjs
// T-83 (ARK-16:n loput, S-5b, S-10): asetusten muutos, asetuspeili ja agy-luvat. Jokainen testidata/toiminnot/asetukset-*.json
// ajetaan oikean HTTP-toimintopalvelimen (luoToimintopalvelin, portti 0) läpi: status, JSON-runko ja kytkinten tilahakemiston
// tiedostot (polku, sisältö; myös ylijäämä-.tmux-tiedostot) verrataan fixtureen. Lisäksi: toimintoloki, peilin muoto ja päivitys
// heti POSTin jälkeen (lahde.mjs-laji asetukset + ymp.lahdeKierros), heti-kierroksen virheensieto sekä agy-luvat-silmukka pois
// ja päällä mock-tmuxilla. Tilahakemisto on aina TMP:n alla (ymp.asetusHakemisto); tuotannon tilaa, oikeaa tmuxia ja agy:tä ei kosketa.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { luoLahde } from '../lahde.mjs';
import { lueSkoopit } from '../transkriptit.mjs';
import { projektiNimi } from '../vanhasta/lahteet.mjs';
import { OLETUS_HAKEMISTO } from '../vanhasta/toiminnot-asetukset.mjs';
import { luoToimintopalvelin } from './palvelin.mjs';
import { REITIT, kaynnista } from './asetukset.mjs';
import { KAIKKI, KOUKUT, toteutetut } from './reitit.mjs';
import { TMP, ajaFixture, avainTiedosto, kokoaYmparisto, lataaFixturet, luoMockAja, pyyda, vertaaFixtureen } from './testiapurit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

const fixturet = lataaFixturet(/^asetukset-/);
const hae = (nimi) => structuredClone(fixturet.find((f) => f.tapaus === nimi));
const POST = (polku) => ({ metodi: 'POST', polku, runko: {} });
const KOUKKU = [{ nimi: 'asetukset', kaynnista }];
const odotaMs = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function odotaEhto(ehto, ms = 3000) {
  const raja = Date.now() + ms;
  while (!ehto()) {
    if (Date.now() > raja) throw new Error('odotus umpeutui');
    await odotaMs(10);
  }
}

// ---------- apurit ----------
let tilaLaskuri = 0;
const uusiTila = () => { const h = join(TMP, `asetus-tila-${tilaLaskuri++}`); mkdirSync(h, { recursive: true }); return h; };
// Tilahakemiston tiedostot suhteellisina polkuina aakkosjärjestyksessä (kuten tallenna-lisa.mjs; .tmp-tiedostot mukana, jottei niitä jää).
function lueTila(hak, alku = hak) {
  let rivit = [];
  for (const d of readdirSync(hak, { withFileTypes: true })) {
    const p = join(hak, d.name);
    if (d.isDirectory()) rivit = rivit.concat(lueTila(p, alku));
    else rivit.push({ tiedosto: relative(alku, p), sisalto: readFileSync(p, 'utf8') });
  }
  return rivit.sort((a, b) => a.tiedosto.localeCompare(b.tiedosto));
}
function siemenna(tila, tiedostot = []) {
  for (const t of tiedostot) {
    mkdirSync(join(tila, t.tiedosto, '..'), { recursive: true });
    writeFileSync(join(tila, t.tiedosto), t.sisalto);
  }
}
async function ajaTilalla(fix, lisaYmp = {}) {
  const tila = uusiTila();
  siemenna(tila, fix.ymparisto.asetuksetTila);
  const tulos = await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { asetusHakemisto: tila, ...lisaYmp } });
  return { ...tulos, tila: lueTila(tila) };
}

// ---------- reitit ----------
test('reitit: kaksi asetusreittiä toteutettu, terveyslistalla ja kaynnista-koukku rekisteröity reitit.mjs:ssä', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['POST /api/asetukset/*/*', 'POST /api/skoopit/*/asetukset/*/*']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  for (const r of REITIT) assert.ok(toteutetut(KAIKKI).includes(`${r.metodi} ${r.kuvio}`));
  assert.equal(KOUKUT.find((q) => q.nimi === 'asetukset')?.kaynnista, kaynnista);
});

test('oletushakemisto on vanhan tilahakemisto', () => {
  assert.equal(OLETUS_HAKEMISTO, join(homedir(), '.claude/skills/keskustelun-siirto/state'));
});

// ---------- fixturet ----------
test('fixturet: kaikki 16 asetukset-tapausta katettu', () => {
  assert.equal(fixturet.length, 16);
  assert.ok(fixturet.every((f) => Array.isArray(f.odotus.asetuksetTila)));
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const { havainto, tila } = await ajaTilalla(fix);
    vertaaFixtureen(fix, havainto);
    assert.deepEqual(tila, fix.odotus.asetuksetTila, `${fix.tapaus}: tilahakemiston tiedostot`);
  });
}

// ---------- toimintoloki ----------
test('toimintolokiin ok-rivi ja hylätty-rivi syyn kanssa kuten vanha (yhteinen ja istuntokohtainen)', async () => {
  const lokiRivit = async (nimi) => (await ajaTilalla(hae(nimi))).loki.map((r) => ({ ...r, aika: undefined }));
  assert.deepEqual(await lokiRivit('asetukset-yhteinen-paalle'), [{ aika: undefined, toiminto: 'asetus', nimi: 'automaattijatko', arvo: true, tulos: 'ok' }]);
  assert.deepEqual(await lokiRivit('asetukset-tuntematon-nimi'), [{ aika: undefined, toiminto: 'asetus', nimi: 'ei-ole', tulos: 'hylätty', syy: 'tuntematon asetus' }]);
  assert.deepEqual(await lokiRivit('asetukset-istunto-paalle'), [{ aika: undefined, toiminto: 'asetus-istunto', nimi: 'automaattijatko', istunto: 'sessio-a-0001', arvo: true, tulos: 'ok' }]);
  assert.deepEqual(await lokiRivit('asetukset-istunto-agyluvat-hylatty'), [{ aika: undefined, toiminto: 'asetus-istunto', nimi: 'agyluvat', tulos: 'hylätty', syy: 'tuntematon asetus' }]);
  assert.deepEqual(await lokiRivit('asetukset-istunto-ilman-istuntoa'), [], 'istunnon valinnan hylkäys ei kirjaudu (vanha: valitse heittää ennen kirjausta)');
});

test('tuntematon skooppi ja tila ennen skooppitarkistusta: tila "ehka" → 404 tuntematon toiminto myös istuntoreitillä', async () => {
  const fix = hae('asetukset-istunto-paalle');
  fix.pyynto = POST('/api/skoopit/ei-ole/asetukset/autopack/ehka');
  const { havainto } = await ajaTilalla(fix);
  assert.deepEqual([havainto.status, havainto.runko], [404, { virhe: 'tuntematon toiminto' }]);
});

// ---------- heti-kierros ----------
const mockYdin = () => {
  const kutsut = [];
  const fetch = async (url, init) => {
    const j = JSON.parse(init.body);
    kutsut.push({ laji: url.split('/').pop(), laite: j.laite, sisalto: j.sisalto });
    return { status: 200, ok: true, json: async () => ({ aika: 'HLC' }) };
  };
  return { kutsut, fetch, asetukset: () => kutsut.filter((k) => k.laji === 'asetukset') };
};
const kayttorajaTehtaat = {
  luoKayttoraja: () => async () => ({ viikko: null, viisiTuntia: null, haettu: null }),
  luoAgyKayttoraja: () => async () => ({ viikko: null, viisiTuntia: null, haettu: null }),
};
// Pelkkä /proc-väärennös (Mac: /proc puuttuu): <proc>/<pid>/stat, jonka kenttä 4 on vanhempi.
function luoProc(hak) {
  mkdirSync(join(hak, String(process.pid)), { recursive: true });
  writeFileSync(join(hak, String(process.pid), 'stat'), `${process.pid} (node) S ${process.ppid} ${'0 '.repeat(30)}`);
  return hak;
}

test('peili: asetukset-laji lähtee heti POSTin jälkeen (ennen vastausta), muoto S-5b:n mukainen, epäonnistunut POST ei kierrä', async () => {
  const fix = hae('asetukset-istunto-useita-valinta');
  const k = kokoaYmparisto(fix.ymparisto);
  const tila = uusiTila();
  const y = mockYdin();
  const l = luoLahde({
    ydin: 'http://ydin.test', avainTiedosto, aja: async () => ({ koodi: 1, stdout: '' }), fetch: y.fetch, laite: 'testilaite', loki: () => {},
    istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, skooppiNimet: () => Object.keys(lueSkoopit(k.juuri)),
    proc: luoProc(join(k.d, 'proc')), asetusHakemisto: tila, ...kayttorajaTehtaat,
  });
  const lisa = { istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, asetusHakemisto: tila, lahdeKierros: () => l.kierros() };
  const palvelin = luoToimintopalvelin({
    portti: 0, avainTiedosto, juuri: k.juuri, tila: k.tila, aja: luoMockAja(k.ymp2, k.istunnonTranskripti, { kutsut: [], kentta: '' }),
    reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) })), koukut: [], loki: () => {},
  });
  const portti = await palvelin.kuuntele();
  try {
    const nolla = { automaattijatko: false, autopack: false, automaattisiirto: false };
    await l.kierros();
    assert.equal(y.asetukset().length, 1);
    assert.equal(y.asetukset()[0].laite, 'testilaite');
    assert.deepEqual(y.asetukset()[0].sisalto, {
      yhteiset: { automaattijatko: false, autopack: false, automaattisiirto: false, agyluvat: false },
      istunnot: { 'sessio-a-0001': nolla, 'sessio-a-0002': nolla },
      skoopit: { a: ['sessio-a-0001', 'sessio-a-0002'], b: [], 'scopes koe': [] },
    });

    // Istuntokohtainen muutos näkyy peilissä jo vastauksen saapuessa; yhteinen arvo ei muutu.
    const r1 = await pyyda(portti, POST('/api/skoopit/a/asetukset/autopack/paalle?istunto=sessio-a-0002'));
    assert.equal(r1.status, 200);
    assert.equal(y.asetukset().length, 2, 'heti-kierros ennen vastausta');
    assert.deepEqual(y.asetukset()[1].sisalto, {
      yhteiset: { automaattijatko: false, autopack: false, automaattisiirto: false, agyluvat: false },
      istunnot: { 'sessio-a-0001': nolla, 'sessio-a-0002': { automaattijatko: false, autopack: true, automaattisiirto: false } },
      skoopit: { a: ['sessio-a-0001', 'sessio-a-0002'], b: [], 'scopes koe': [] },
    });

    // Yhteinen muutos: istunnot perivät yhteisen oletuksen, jos niillä ei ole omaa arvoa.
    const r2 = await pyyda(portti, POST('/api/asetukset/automaattijatko/paalle'));
    assert.equal(r2.status, 200);
    assert.equal(y.asetukset().length, 3);
    assert.deepEqual(y.asetukset()[2].sisalto.yhteiset, { automaattijatko: true, autopack: false, automaattisiirto: false, agyluvat: false });
    assert.deepEqual(y.asetukset()[2].sisalto.istunnot['sessio-a-0001'], { automaattijatko: true, autopack: false, automaattisiirto: false });
    assert.deepEqual(y.asetukset()[2].sisalto.istunnot['sessio-a-0002'], { automaattijatko: true, autopack: true, automaattisiirto: false });

    const r3 = await pyyda(portti, POST('/api/asetukset/agyluvat/paalle'));
    assert.equal(r3.status, 200);
    assert.equal(y.asetukset().length, 4);
    assert.equal(y.asetukset()[3].sisalto.yhteiset.agyluvat, true);

    // Hylätty POST ei muuta tilaa eikä ajaa kierrosta; sama sisältö ei lähde uudelleen.
    assert.equal((await pyyda(portti, POST('/api/asetukset/ei-ole/paalle'))).status, 404);
    assert.equal((await pyyda(portti, POST('/api/skoopit/a/asetukset/autopack/paalle'))).status, 409);
    assert.equal(y.asetukset().length, 4);
    await l.kierros();
    assert.equal(y.asetukset().length, 4, 'tiiviste ennallaan → ei lähetystä');

    // Pakattu istunto putoaa istunnot-kentästä ja skooppilistasta, eikä sitä voi valita.
    const t2 = join(k.projektitDir, projektiNimi('/x'), 'sessio-a-0002.jsonl');
    appendFileSync(t2, `\n${JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T08:05:00.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'PAKATTU: valmis' }] } })}\n`);
    await l.kierros();
    assert.equal(y.asetukset().length, 5);
    assert.deepEqual(Object.keys(y.asetukset()[4].sisalto.istunnot), ['sessio-a-0001']);
    assert.deepEqual(y.asetukset()[4].sisalto.skoopit.a, ['sessio-a-0001']);
    const r4 = await pyyda(portti, POST('/api/skoopit/a/asetukset/autopack/pois?istunto=sessio-a-0002'));
    assert.deepEqual([r4.status, JSON.parse(r4.teksti)], [404, { virhe: 'istuntoa ei löydy tästä skoopista' }]);
    const r5 = await pyyda(portti, POST('/api/skoopit/a/asetukset/autopack/paalle'));
    assert.equal(r5.status, 200, 'yksi avoin istunto valitaan itsestään');
    assert.equal(JSON.parse(r5.teksti).istunto, 'sessio-a-0001');
    assert.equal(y.asetukset().length, 6);
    assert.deepEqual(y.asetukset()[5].sisalto.istunnot['sessio-a-0001'], { automaattijatko: true, autopack: true, automaattisiirto: false });
  } finally {
    await palvelin.sulje();
    l.sulje();
  }
});

// T-104: automaattisiirto (S-5b laajennettu 28.10.2026) — yhteinen ja istuntokohtainen POST 200, seuraava kierros lähettää uuden arvon.
test('automaattisiirto: yhteinen ja istuntokohtainen POST → 200, seuraava lahde.kierros() lähettää uuden arvon', async () => {
  const fix = hae('asetukset-istunto-useita-valinta');
  const k = kokoaYmparisto(fix.ymparisto);
  const tila = uusiTila();
  const y = mockYdin();
  const l = luoLahde({
    ydin: 'http://ydin.test', avainTiedosto, aja: async () => ({ koodi: 1, stdout: '' }), fetch: y.fetch, laite: 'testilaite', loki: () => {},
    istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, skooppiNimet: () => Object.keys(lueSkoopit(k.juuri)),
    proc: luoProc(join(k.d, 'proc')), asetusHakemisto: tila, ...kayttorajaTehtaat,
  });
  // Ilman lahdeKierros-koukkua: arvo lähtee vasta seuraavalla tavallisella kierroksella.
  const lisa = { istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, asetusHakemisto: tila };
  const palvelin = luoToimintopalvelin({
    portti: 0, avainTiedosto, juuri: k.juuri, tila: k.tila, aja: luoMockAja(k.ymp2, k.istunnonTranskripti, { kutsut: [], kentta: '' }),
    reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) })), koukut: [], loki: () => {},
  });
  const portti = await palvelin.kuuntele();
  try {
    await l.kierros();
    assert.equal(y.asetukset().at(-1).sisalto.yhteiset.automaattisiirto, false);

    const r1 = await pyyda(portti, POST('/api/asetukset/automaattisiirto/paalle'));
    assert.equal(r1.status, 200, r1.teksti);
    assert.deepEqual(JSON.parse(r1.teksti), { automaattijatko: false, autopack: false, automaattisiirto: true, agyluvat: false });
    await l.kierros();
    assert.equal(y.asetukset().at(-1).sisalto.yhteiset.automaattisiirto, true);
    assert.deepEqual(lueTila(tila), [{ tiedosto: 'automaattisiirto.txt', sisalto: 'true\n' }]);

    const r2 = await pyyda(portti, POST('/api/skoopit/a/asetukset/automaattisiirto/pois?istunto=sessio-a-0002'));
    assert.equal(r2.status, 200, r2.teksti);
    assert.equal(JSON.parse(r2.teksti).automaattisiirto, false);
    const r3 = await pyyda(portti, POST('/api/skoopit/a/asetukset/automaattisiirto/paalle?istunto=sessio-a-0001'));
    assert.equal(r3.status, 200, r3.teksti);
    await l.kierros();
    const viim = y.asetukset().at(-1).sisalto;
    assert.equal(viim.istunnot['sessio-a-0001'].automaattisiirto, true);
    assert.equal(viim.istunnot['sessio-a-0002'].automaattisiirto, false, 'istunnon oma arvo voittaa yhteisen');
  } finally {
    await palvelin.sulje();
    l.sulje();
  }
});

test('heti-kierros ei kaada eikä viivytä onnistunutta muutosta: puuttuva, heittävä ja jumittunut lahdeKierros → 200', async () => {
  const tapaukset = [
    ['puuttuva', {}],
    ['heittävä', { lahdeKierros: async () => { throw new Error('ydin poissa'); } }],
    ['jumittunut', { lahdeKierros: () => new Promise(() => {}), lahdeAikaraja: 50 }],
  ];
  for (const [nimi, lisa] of tapaukset) {
    const { havainto, tila } = await ajaTilalla(hae('asetukset-yhteinen-paalle'), lisa);
    assert.equal(havainto.status, 200, nimi);
    assert.deepEqual(havainto.runko, { automaattijatko: true, autopack: false, automaattisiirto: false, agyluvat: false }, nimi);
    assert.deepEqual(tila, [{ tiedosto: 'automaattivalinta.txt', sisalto: 'true\n' }], nimi);
  }
});

// ---------- agy-luvat ----------
const LUPAKYSELY = 'Run this command?\n  > 1. Yes, run command\n  2. Yes, always allow in this conversation\n  3. Persist to settings.json\n  4. No\n';

function agyYmpariston(lisaYmp = {}) {
  const tila = uusiTila();
  const kutsut = [];
  const loki = [];
  const aja = async (komento, argv) => {
    kutsut.push([komento, ...argv]);
    const tulos = (stdout = '') => ({ koodi: 0, stdout, stderr: '' });
    if (komento !== 'tmux') return { koodi: 1, stdout: '', stderr: 'ei komentoa' };
    if (argv[0] === 'list-panes') return tulos('siirto-abc-123456 agy\nmuu-istunto bash\n');
    if (argv[0] === 'capture-pane') return tulos(LUPAKYSELY);
    return tulos();
  };
  const lisa = { asetusHakemisto: tila, agyLuvatVali: 20, ...lisaYmp };
  const palvelin = luoToimintopalvelin({
    portti: 0, avainTiedosto, juuri: join(TMP, 'juuri-tyhja'), tila: join(TMP, 'palvelin-tila'), aja, loki: (rivi) => loki.push(rivi),
    reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) })),
    koukut: KOUKUT.filter((q) => q.nimi === 'asetukset').map((q) => ({ ...q, kaynnista: (ymp) => q.kaynnista({ ...ymp, ...lisa }) })),
  });
  return { tila, kutsut, loki, palvelin };
}

test('agy-luvat: ilman lippua silmukkaa ei käynnistetä, vaikka agyluvat-tiedosto on päällä', async () => {
  const y = agyYmpariston();
  writeFileSync(join(y.tila, 'agy-luvat.txt'), 'true\n');
  await y.palvelin.kuuntele();
  try {
    await odotaMs(200); // 10 kierrosta, jos silmukka ajaisi
    assert.deepEqual(y.kutsut, []);
  } finally { await y.palvelin.sulje(); }
});

test('agy-luvat: lipulla silmukka lukee agyluvat-arvon joka kierroksella ja vastaa vain, kun se on päällä', async () => {
  const y = agyYmpariston({ agyLuvat: true });
  const portti = await y.palvelin.kuuntele();
  try {
    await odotaMs(150);
    assert.deepEqual(y.kutsut, [], 'agyluvat pois → ei tmux-kutsuja');

    assert.equal((await pyyda(portti, POST('/api/asetukset/agyluvat/paalle'))).status, 200);
    await odotaEhto(() => y.kutsut.some((c) => c[1] === 'send-keys'));
    const vastaus = y.kutsut.find((c) => c[1] === 'send-keys');
    assert.deepEqual(vastaus, ['tmux', 'send-keys', '-t', 'siirto-abc-123456', '2'], 'always allow in this conversation, ei Persist- eikä No-vaihtoehtoa');
    assert.ok(y.kutsut.some((c) => c[1] === 'capture-pane' && c.includes('siirto-abc-123456')));
    assert.ok(!y.kutsut.some((c) => c[1] === 'capture-pane' && c.includes('muu-istunto')), 'vain siirto-*-ruudut (agy|ssh)');
    await odotaEhto(() => y.loki.some((r) => r.toiminto === 'agy-lupa'));
    assert.deepEqual(y.loki.find((r) => r.toiminto === 'agy-lupa'), { toiminto: 'agy-lupa', istunto: 'siirto-abc-123456', valinta: 'Yes, always allow in this conversation', tulos: 'ok' });

    assert.equal((await pyyda(portti, POST('/api/asetukset/agyluvat/pois'))).status, 200);
    await odotaMs(80); // keskeneräinen kierros ehtii loppuun
    const maara = y.kutsut.length;
    await odotaMs(150);
    assert.equal(y.kutsut.length, maara, 'agyluvat pois → silmukka ei kutsu tmuxia');
  } finally { await y.palvelin.sulje(); }
});

test('agy-luvat: pysäytys sulje():ssa lopettaa silmukan', async () => {
  const y = agyYmpariston({ agyLuvat: true });
  writeFileSync(join(y.tila, 'agy-luvat.txt'), 'true\n');
  await y.palvelin.kuuntele();
  await odotaEhto(() => y.kutsut.length > 0);
  await y.palvelin.sulje();
  await odotaMs(80);
  const maara = y.kutsut.length;
  await odotaMs(150);
  assert.equal(y.kutsut.length, maara);
});
