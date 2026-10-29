// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/pura.test.mjs
// T-68 (ARK-16, S-10): POST /api/skoopit/*/pura ja GET /api/purkajat. Jokainen testidata/toiminnot/{pura,purkajat}-*.json ajetaan
// oikean HTTP-toimintopalvelimen (luoToimintopalvelin, portti 0) läpi ja verrataan fixtureen (status, runko, argv ilman list-panes,
// ajaValinnat, viiveet). Lisäksi /exit-suojausten negatiiviset testit, Mac-agy (scp), yhteinen lukko (429), skriptivirheet ja
// purkajalistan välimuisti. Oma mock-aja (agy, scp ja ruutukohtainen pane_pid), koska testiapurit.mjs:n luoMockAja ei tunne niitä;
// testiapurit.mjs:stä käytetään vain olemassa olevia apureita. Ei oikeaa tmux:ia, skriptejä, agy:tä eikä Mac-ssh/scp:tä.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ajaKomento, toimintoKaynnissa } from './aja.mjs';
import { luoToimintopalvelin } from './palvelin.mjs';
import { REITIT } from './pura.mjs';
import { KAIKKI, toteutetut } from './reitit.mjs';
import { KOTI, TMP, avainTiedosto, kokoaYmparisto, lataaFixturet, pyyda, vertaaFixtureen } from './testiapurit.mjs';

// Purkutiedosto on ~/.local/state/pura/<slug>.md (homedir()); fixtureissa <KOTI> = tallentimen HOME.
process.env.HOME = KOTI;
after(() => rmSync(TMP, { recursive: true, force: true }));

const fixturet = lataaFixturet(/^(pura|purkajat)-/);
const hae = (nimi) => structuredClone(fixturet.find((f) => f.tapaus === nimi));
const POST = (skooppi, runko = {}) => ({ metodi: 'POST', polku: `/api/skoopit/${skooppi}/pura`, runko });
const AGY_MODELS = { koodi: 0, stdout: 'Fetching available models...\ngemini-9-pro\tGemini 9 Pro\nclaude-x-1\tClaude X 1\n', stderr: '' };
const PERHE = { 'pura-malliton --perhe': { koodi: 0, stdout: 'PERHE: kyllä\n', stderr: '' }, 'pura-malliton': { koodi: 0, stdout: 'KIRJOITETTU: x\n', stderr: '' } };
const EI_PERHE = { 'pura-malliton --perhe': { koodi: 1, stdout: 'PERHE: ei\n', stderr: '' } };
const MALLITON = '<JUURI>/claude/siirto/tools/pura-malliton.mjs';
const AUTOVAIHTO = '<JUURI>/claude/siirto/tools/autovaihto.sh';

// ---------- apurit (vain tässä tiedostossa; testiapurit.mjs:ää ei muuteta) ----------
const syvaKartta = (x, f) => (typeof x === 'string' ? f(x) : Array.isArray(x) ? x.map((y) => syvaKartta(y, f))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, syvaKartta(v, f)])) : x);

// Tallentava aja-väärennös kuten tallenna-vanha.mjs:n (tmux, autovaihto.sh, pura-malliton, agy) sekä scp ja kaksi testilaajennusta:
// tmux.ruudut = { '%5': '<pid>\n', … } (display-message ruuduittain) ja tmux.sendKeysKoodi (send-keys epäonnistuu).
// ctx.pito = { kohde(komento, argv) } pysäyttää ensimmäisen osuvan kutsun, kunnes pito vapautetaan.
function luoAja(ymp2, ctx) {
  const tulos = (t = {}) => ({ koodi: t.koodi ?? 0, stdout: t.stdout ?? '', stderr: t.stderr ?? '' });
  return async (komento, argv, valinnat = {}) => {
    if (!(komento === 'tmux' && argv[0] === 'list-panes')) ctx.kutsut.push({ kutsu: [komento, ...argv], valinnat: { ...(valinnat.syote ? { syote: valinnat.syote } : {}), ...(valinnat.cwd ? { cwd: valinnat.cwd } : {}) } });
    const pito = ctx.pito;
    if (pito && !pito.otettu && pito.kohde(komento, argv)) { pito.otettu = true; pito.saavutettu(); await pito.esto; }
    const tm = ymp2.tmux;
    if (komento === 'tmux') {
      if (argv[0] === 'display-message' && tm.ruudut) return tulos({ stdout: tm.ruudut[argv[argv.indexOf('-t') + 1]] ?? '' });
      if (argv[0] === 'send-keys' && tm.sendKeysKoodi) return tulos({ koodi: tm.sendKeysKoodi });
      return tulos({ stdout: tm[argv[0]] ?? '' });
    }
    if (komento === 'bash' && argv[0].endsWith('autovaihto.sh')) return tulos(ymp2.komennot.autovaihto ?? { stdout: 'UUSI: …\nOK: https://claude.ai/code/session_REDACTED\n' });
    if (komento === 'node' && argv[0].endsWith('pura-malliton.mjs')) return tulos(ymp2.komennot[argv[1] === '--perhe' ? 'pura-malliton --perhe' : 'pura-malliton'] ?? { koodi: 1 });
    if (komento === 'agy') return tulos(ymp2.komennot.agy ?? { koodi: 127, stderr: 'agy: komentoa ei löydy' });
    if (komento === 'scp') return tulos(ymp2.komennot.scp ?? { koodi: 0 });
    throw new Error(`pura.test: odottamaton komento ${komento} ${argv.join(' ')}`);
  };
}

// Palvelin fixturen ympäristöllä. lisaYmp = ymp-lisät reiteille; Nebius-avain fixturen ymparisto.nebiusAvain-kentästä.
async function palvelin(fix, { reitit = REITIT, lisaYmp = {}, kello = () => Date.parse('2026-10-21T09:00:00.000Z') } = {}) {
  const k = kokoaYmparisto(fix.ymparisto);
  const ctx = { kutsut: [], pito: null, loki: [] };
  const nebiusTiedosto = join(k.d, k.ymp2.nebiusAvain ? 'nebius-avain' : 'ei-nebius-avainta');
  if (k.ymp2.nebiusAvain) writeFileSync(nebiusTiedosto, 'avain\n');
  const lisa = { istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, nebiusTiedosto, agyHakemisto: join(k.d, 'agy'), brainHakemisto: join(k.d, 'brain'), ...lisaYmp };
  const p = luoToimintopalvelin({
    portti: 0, koukut: [], avainTiedosto, juuri: k.juuri, tila: k.tila, aja: luoAja(k.ymp2, ctx), kello, loki: (rivi) => ctx.loki.push(rivi),
    reitit: reitit.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) })),
  });
  const portti = await p.kuuntele();
  const korvaukset = [[k.juuri, '<JUURI>'], [KOTI, '<KOTI>'], [TMP, '<TMP>']];
  const norm = (x) => syvaKartta(x, (s) => korvaukset.reduce((t, [a, b]) => t.replaceAll(a, b), s));
  // Pitää ensimmäisen kohde-kutsun (oletus autovaihto.sh) kesken: → { saavutettu: Promise, vapauta() }.
  const pida = (kohde = (komento, argv) => komento === 'bash' && argv[0].endsWith('autovaihto.sh')) => {
    let vapauta;
    let saavutettu;
    const lupaus = new Promise((ok) => { saavutettu = ok; });
    ctx.pito = { kohde, esto: new Promise((ok) => { vapauta = ok; }), saavutettu, otettu: false };
    return { saavutettu: lupaus, vapauta: () => vapauta() };
  };
  const havainto = async (pyynto) => {
    ctx.kutsut.length = 0;
    const v = await pyyda(portti, pyynto);
    const h = { status: v.status, runko: JSON.parse(v.teksti), aja: ctx.kutsut.map((c) => c.kutsu) };
    if (ctx.kutsut.some((c) => Object.keys(c.valinnat).length)) h.ajaValinnat = ctx.kutsut.map((c) => c.valinnat);
    return norm(h);
  };
  return { k, ctx, portti, pida, havainto, norm, ymp: { tila: k.tila }, sulje: async () => { await p.sulje(); rmSync(k.d, { recursive: true, force: true }); } };
}

// Koko replay kuten testiapurit.mjs:n ajaFixture: samanaikainen pyyntö pidetään autovaihto-kutsussa varsinaisen pyynnön ajan.
async function ajaFixture(fix, valinnat = {}) {
  const p = await palvelin(fix, valinnat);
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
    return { havainto: h, loki: p.ctx.loki, k: p.k };
  } finally {
    await p.sulje();
  }
}

const naytot = (aja) => aja.filter((a) => a[0] === 'tmux' && a[1] === 'send-keys');
const exitit = (aja) => aja.filter((a) => a[1] === 'send-keys' && a.includes('/exit')).map((a) => a[a.indexOf('-t') + 1]);

// ---------- reitit ja fixturet ----------
test('reitit: POST /api/skoopit/*/pura ja GET /api/purkajat toteutettu ja terveyslistalla', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['POST /api/skoopit/*/pura', 'GET /api/purkajat']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  for (const r of REITIT) assert.ok(toteutetut(KAIKKI).includes(`${r.metodi} ${r.kuvio}`));
});

test('fixturet: kaikki pura-tapaukset ja purkajat-tapaukset (lista, virheellinen malli) ovat mukana', () => {
  const nimet = new Set(fixturet.map((f) => f.tapaus));
  for (const n of ['pura-perhe', 'pura-perhe-pakattu-suljetaan', 'pura-ei-perhe', 'pura-toinen-toiminto-kaynnissa', 'purkajat-lista', 'purkajat-virheellinen-malli']) assert.ok(nimet.has(n), n);
  assert.ok(fixturet.length >= 22, `fixtureja ${fixturet.length}`);
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const { havainto } = await ajaFixture(fix);
    vertaaFixtureen(fix, havainto);
  });
}

// ---------- /exit-suojaukset (negatiiviset testit) ----------
test('/exit: elävä (pakkaamaton) istunto skoopissa → 409 ennen yhtään komentoa; ruutu ei saa /exitiä', async () => {
  for (const [nimi, perhe] of [['ei perhe', EI_PERHE], ['perhe', PERHE]]) {
    const fix = hae('purkajat-pura-kaynnissa-oleva');
    fix.ymparisto.komennot = perhe;
    const { havainto } = await ajaFixture(fix);
    assert.deepEqual([havainto.status, havainto.runko, havainto.aja], [409, { virhe: 'skoopissa on jo käynnissä oleva istunto' }, []], nimi);
  }
});

test('/exit: elävä istunto ja pakattu istunto samassa skoopissa → 409, kumpikaan ruutu ei saa /exitiä', async () => {
  const fix = hae('pura-perhe-pakattu-suljetaan');
  const elava = { tiedosto: `${process.ppid}.json`, sisalto: { pid: process.ppid, sessionId: 's2', cwd: '/y', name: 'a', status: 'idle', tmux: 'siirto-a-2:@2.%6' } };
  fix.ymparisto.istunnot.push(elava);
  fix.ymparisto.transkriptit.push({ kohde: 'istunto', cwd: '/y', id: 's2', rivit: [{ type: 'user', timestamp: '2026-10-21T08:00:00.000Z', message: { content: '/pura a' } }] });
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual([havainto.status, havainto.runko, havainto.aja], [409, { virhe: 'skoopissa on jo käynnissä oleva istunto' }, []]);
});

test('/exit: toisen skoopin elävä istunto ei saa /exitiä; vain oman skoopin pakattu ruutu suljetaan', async () => {
  for (const perhe of [PERHE, EI_PERHE]) {
    const fix = hae('pura-perhe-pakattu-suljetaan');
    fix.ymparisto.komennot = perhe;
    fix.ymparisto.istunnot.push({ tiedosto: `${process.ppid}.json`, sisalto: { pid: process.ppid, sessionId: 's2', cwd: '/y', name: 'b', status: 'idle', tmux: 'siirto-b-2:@2.%6' } });
    fix.ymparisto.transkriptit.push({ kohde: 'istunto', cwd: '/y', id: 's2', rivit: [{ type: 'user', timestamp: '2026-10-21T08:00:00.000Z', message: { content: '/pura b' } }] });
    fix.ymparisto.tmux.ruudut = { '%5': `${process.pid}\n`, '%6': `${process.ppid}\n` };
    const { havainto } = await ajaFixture(fix);
    assert.equal(havainto.status, 200);
    assert.deepEqual(havainto.runko.suljettiin, ['s1']);
    assert.deepEqual(exitit(havainto.aja), ['%5']);
    assert.ok(!havainto.aja.some((a) => a.includes('%6')), 'toisen skoopin ruutuun ei kosketa');
  }
});

test('/exit: pakattu mutta varattu istunto → 409, ei /exitiä eikä skriptejä (busy ja waiting)', async () => {
  for (const tila of ['busy', 'waiting']) {
    const fix = hae('purkajat-pura-pakattu-varattu');
    fix.ymparisto.istunnot[0].sisalto.status = tila;
    const { havainto } = await ajaFixture(fix);
    assert.deepEqual([havainto.status, havainto.runko, havainto.aja], [409, { virhe: `pakattu istunto on vielä varattu (${tila}); yritä vuoron jälkeen` }, []], tila);
  }
});

test('/exit: ruudun pane_pid ei ole istunnon claude → 409, ei send-keysiä eikä uutta istuntoa (perhe ja ei perhe)', async () => {
  for (const perhe of [PERHE, EI_PERHE]) {
    const fix = hae('purkajat-pura-vaara-ruutu');
    fix.ymparisto.komennot = perhe;
    const { havainto } = await ajaFixture(fix);
    assert.deepEqual([havainto.status, havainto.runko], [409, { virhe: 'istunnon tmux-ruutu ei täsmää' }]);
    assert.deepEqual(naytot(havainto.aja), []);
    assert.ok(!havainto.aja.some((a) => a[0] === 'bash'), 'autovaihto ei käynnisty');
  }
});

test('/exit: display-message epäonnistuu (ruutu kadonnut) → 409, ei send-keysiä', async () => {
  const fix = hae('pura-perhe-pakattu-suljetaan');
  fix.ymparisto.tmux.ruudut = {};
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual([havainto.status, naytot(havainto.aja)], [409, []]);
});

test('/exit: pakkaamaton agy-ruutu skoopissa → 409 ennen perhetunnistusta, ei näppäilyä', async () => {
  const fix = hae('pura-ei-perhe');
  fix.pyynto = POST('a--b');
  fix.ymparisto.skooppitiedot = { 'a--b': ['R.md'] };
  fix.ymparisto.tmux['list-panes'] = 'siirto-a--b-123456 agy 1700000000 4242\n';
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual([havainto.status, havainto.runko, havainto.aja], [409, { virhe: 'skoopissa on jo käynnissä oleva agy-istunto' }, []]);
});

test('/exit: pakattu istunto ilman tmux-ruutua (Remote Control) → ei /exitiä, suljettiin []', async () => {
  const fix = hae('pura-perhe-pakattu-suljetaan');
  delete fix.ymparisto.istunnot[0].sisalto.tmux;
  const { havainto } = await ajaFixture(fix);
  assert.equal(havainto.status, 200);
  assert.deepEqual([havainto.runko.suljettiin, naytot(havainto.aja)], [[], []]);
  assert.deepEqual(havainto.aja[1], ['node', MALLITON, 'a', '--kohde', 'claude']);
});

test('/exit: perhetunnistus tai purkutiedoston kirjoitus epäonnistuu → ei /exitiä (skooppi ei jää ilman istuntoa)', async () => {
  for (const n of ['purkajat-pura-perhe-tunnistus-epaonnistuu', 'purkajat-pura-malliton-epaonnistuu']) {
    const { havainto } = await ajaFixture(hae(n));
    assert.equal(havainto.status, 500, n);
    assert.deepEqual(naytot(havainto.aja), [], n);
  }
});

test('/exit: send-keys epäonnistuu → 502, uutta istuntoa ei avata', async () => {
  const fix = hae('pura-perhe-pakattu-suljetaan');
  fix.ymparisto.tmux.sendKeysKoodi = 1;
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual([havainto.status, havainto.runko], [502, { virhe: 'tmux send-keys epäonnistui' }]);
  assert.ok(!havainto.aja.some((a) => a[0] === 'bash'));
});

test('/exit: kaksi pakattua ruutua, toisen pane_pid väärä → ensimmäinen suljetaan, toinen ei, 409 (vanha järjestys)', async () => {
  const fix = hae('pura-perhe-pakattu-suljetaan');
  fix.ymparisto.komennot = EI_PERHE;
  const toinen = { tiedosto: `${process.ppid}.json`, sisalto: { pid: process.ppid, sessionId: 's2', cwd: '/y', name: 'a', status: 'idle', tmux: 'siirto-a-2:@2.%6' } };
  fix.ymparisto.istunnot.push(toinen);
  fix.ymparisto.transkriptit.push({ ...fix.ymparisto.transkriptit[0], cwd: '/y', id: 's2' });
  fix.ymparisto.tmux.ruudut = { '%5': `${process.pid}\n`, '%6': '424242\n' };
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual([havainto.status, havainto.runko], [409, { virhe: 'istunnon tmux-ruutu ei täsmää' }]);
  assert.ok(!exitit(havainto.aja).includes('%6'), 'väärän pid:n ruutu ei saa /exitiä');
  assert.ok(!havainto.aja.some((a) => a[0] === 'bash'));
});

// ---------- Mac-agy ----------
test('Mac-agy (perhe): purkutiedosto scp:llä Macille muulla kuin darwinilla; viesti osoittaa Macin polkuun', async () => {
  const fix = hae('purkajat-pura-agy-perhe');
  fix.pyynto = POST('b', { malli: 'macos-agy/gemini-9-pro' });
  fix.ymparisto.komennot.autovaihto = { koodi: 0, stdout: 'OK: mac-agy tmux siirto-b-1\n', stderr: '' };
  fix.ymparisto.komennot.scp = { koodi: 1, stderr: 'ei yhteyttä' }; // scp:n virhe ei estä purkua (vanha .catch)
  const viesti = 'Malliton purku: lue ~/.local/state/pura/b.md ja noudata sitä.';
  const linux = (await ajaFixture(fix, { lisaYmp: { alusta: 'linux' } })).havainto;
  assert.equal(linux.status, 200);
  assert.deepEqual(linux.runko, { ok: true, toiminto: 'pura', nimi: 'b', tmux: 'siirto-b-1', suljettiin: [], tiedosto: '~/.local/state/pura/b.md', malli: 'mac-agy/gemini-9-pro' });
  assert.deepEqual(linux.aja, [
    ['agy', 'models'],
    ['node', MALLITON, '--perhe', 'b'],
    ['node', MALLITON, 'b', '--kohde', 'neutraali'],
    ['scp', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '<KOTI>/.local/state/pura/b.md', '<KOTI>/.local/state/pura/b.json', 'mac:~/.local/state/pura/'],
    ['bash', AUTOVAIHTO, 'vaihda', 'b', '--ei-sulje', '--model', 'mac-agy/gemini-9-pro', '--viesti', viesti],
  ]);
  const mac = (await ajaFixture(fix, { lisaYmp: { alusta: 'darwin' } })).havainto;
  assert.equal(mac.status, 200);
  assert.ok(!mac.aja.some((a) => a[0] === 'scp'), 'darwinilla ei scp:tä');
  assert.deepEqual(mac.aja.at(-1).at(-1), viesti);
});

test('Mac-agy ei perhe → 400 ennen /exitiä ja autovaihtoa', async () => {
  const fix = hae('pura-perhe-pakattu-suljetaan');
  fix.pyynto = POST('a', { malli: 'mac-agy/gemini-9-pro' });
  fix.ymparisto.komennot = { ...EI_PERHE, agy: AGY_MODELS };
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual([havainto.status, havainto.runko], [400, { virhe: 'agy-istunto kuuluu vain scopes-perheen skoopeille' }]);
  assert.deepEqual(havainto.aja, [['agy', 'models'], ['node', MALLITON, '--perhe', 'a']]);
});

// ---------- lukko (429) ----------
test('429: toinen pura kesken → hylätty-rivi lokiin; lukko vapautuu, kun ensimmäinen valmistuu', async () => {
  const fix = hae('pura-toinen-toiminto-kaynnissa');
  const p = await palvelin(fix);
  try {
    const pito = p.pida();
    const kesken = pyyda(p.portti, fix.pyynto);
    await pito.saavutettu;
    assert.equal(toimintoKaynnissa(p.ymp), 'pura');
    const toinen = await p.havainto(fix.pyynto);
    assert.deepEqual([toinen.status, toinen.runko, toinen.aja], [429, { virhe: 'toinen toiminto on käynnissä (pura)' }, []]);
    assert.deepEqual(p.ctx.loki.at(-1), { toiminto: 'pura', nimi: 'b', tulos: 'hylätty', syy: 'toinen toiminto käynnissä' });
    pito.vapauta();
    assert.equal((await kesken).status, 200);
    assert.equal(toimintoKaynnissa(p.ymp), null);
    assert.deepEqual(p.ctx.loki.at(-1), { toiminto: 'pura', nimi: 'b', tulos: 'ok', osoite: 'https://claude.ai/code/session_REDACTED', suljettiin: [] });
    assert.equal((await p.havainto(fix.pyynto)).status, 200);
  } finally {
    await p.sulje();
  }
});

test('429: lukko vapautuu myös virheen jälkeen (500), ja virheestä hylätty-rivi lokiin', async () => {
  const fix = hae('purkajat-pura-perhe-tunnistus-epaonnistuu');
  const p = await palvelin(fix);
  try {
    assert.equal((await p.havainto(fix.pyynto)).status, 500);
    assert.deepEqual(p.ctx.loki.at(-1), { toiminto: 'pura', nimi: 'a', tulos: 'hylätty', syy: 'skooppikartta rikki' });
    assert.equal(toimintoKaynnissa(p.ymp), null);
    assert.equal((await p.havainto(fix.pyynto)).status, 500, 'ei 429');
  } finally {
    await p.sulje();
  }
});

test('429: valintojen tarkistus (400) tehdään ennen lukkoa kuten vanhassa; eri tilahakemiston palvelin ei esty', async () => {
  const fix = hae('pura-toinen-toiminto-kaynnissa');
  fix.ymparisto.komennot.agy = AGY_MODELS;
  const p = await palvelin(fix);
  const q = await palvelin(hae('pura-ei-perhe'));
  try {
    const pito = p.pida();
    const kesken = pyyda(p.portti, fix.pyynto);
    await pito.saavutettu;
    const v = await p.havainto(POST('b', { malli: 'ei-ole' }));
    assert.deepEqual([v.status, v.runko], [400, { virhe: 'tuntematon istunnon malli ei-ole' }]);
    assert.equal((await q.havainto(POST('b'))).status, 200, 'toisen palvelimen (eri ymp.tila) lukko on eri');
    pito.vapauta();
    await kesken;
  } finally {
    await p.sulje();
    await q.sulje();
  }
});

// ---------- skriptivirheet (viesti kuten vanhassa) ----------
test('skripti epäonnistuu ilman stderriä → vanhan exit-viesti', async () => {
  const tapaukset = [
    ['purkajat-pura-perhe-tunnistus-epaonnistuu', { 'pura-malliton --perhe': { koodi: 2 } }, 500, 'pura-malliton --perhe exit 2'],
    ['purkajat-pura-malliton-epaonnistuu', { ...PERHE, 'pura-malliton': { koodi: 3 } }, 500, 'pura-malliton exit 3'],
    ['purkajat-pura-autovaihto-epaonnistuu', { ...EI_PERHE, autovaihto: { koodi: 1 } }, 502, 'istunto ei käynnistynyt: autovaihto exit 1'],
    ['purkajat-pura-autovaihto-epaonnistuu', { ...EI_PERHE, autovaihto: { koodi: 0, stdout: 'OK: jotain muuta\n' } }, 502, 'istunto ei käynnistynyt: autovaihto exit 0'],
  ];
  for (const [nimi, komennot, status, virhe] of tapaukset) {
    const fix = hae(nimi);
    fix.ymparisto.komennot = komennot;
    const { havainto } = await ajaFixture(fix);
    assert.deepEqual([havainto.status, havainto.runko], [status, { virhe }], virhe);
  }
});

test('skripti: pitkä stderr katkaistaan 300 merkkiin (viimeinen ei-tyhjä rivi)', async () => {
  const fix = hae('purkajat-pura-perhe-tunnistus-epaonnistuu');
  fix.ymparisto.komennot['pura-malliton --perhe'].stderr = `eka\n${'x'.repeat(400)}\n\n`;
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual([havainto.status, havainto.runko], [500, { virhe: 'x'.repeat(300) }]);
});

test('autovaihto: paikallisen mallin OK-rivi → { tmux }', async () => {
  const fix = hae('pura-ei-perhe');
  fix.ymparisto.komennot.autovaihto = { koodi: 0, stdout: 'OK: paikallinen tmux siirto-b-7\n' };
  const { havainto } = await ajaFixture(fix);
  assert.deepEqual(havainto.runko, { ok: true, toiminto: 'pura', nimi: 'b', tmux: 'siirto-b-7', suljettiin: [] });
});

// ---------- purkajat ----------
test('purkajat: agy-lista välimuistissa 10 min; vanhentunut palautetaan heti ja päivitetään taustalla', async () => {
  let ms = Date.parse('2026-10-21T09:00:00.000Z');
  const fix = hae('purkajat-lista');
  const p = await palvelin(fix, { kello: () => ms });
  try {
    const eka = await p.havainto(fix.pyynto);
    assert.deepEqual([eka.runko, eka.aja], [fix.odotus.runko, [['agy', 'models']]]);
    ms += 9 * 60_000;
    const toka = await p.havainto(fix.pyynto);
    assert.deepEqual([toka.runko, toka.aja], [fix.odotus.runko, []]);
    ms += 2 * 60_000;
    p.k.ymp2.komennot.agy = { koodi: 0, stdout: 'uusi-1\tUusi 1\n' };
    const vanha = await p.havainto(fix.pyynto);
    assert.deepEqual([vanha.runko, vanha.aja], [fix.odotus.runko, [['agy', 'models']]]);
    const uusi = await p.havainto(fix.pyynto);
    assert.ok(uusi.runko.mallit.some((m) => m.nimi === 'agy/uusi-1'));
  } finally {
    await p.sulje();
  }
});

test('purkajat: ymp.paikalliset → palvelimen mallit purkajiksi ja istunnon malleiksi; virhe = tyhjä', async () => {
  const fix = hae('purkajat-lista');
  const paikalliset = async () => [{ nimi: 'palvelin/qwen-x', kuvaus: 'Qwen X', tyyppi: 'paikallinen' }, { nimi: 'android/gemini', kuvaus: 'G', tyyppi: 'android' }];
  const p = await palvelin(fix, { lisaYmp: { paikalliset } });
  try {
    const { runko } = await p.havainto(fix.pyynto);
    assert.deepEqual(runko.purkajat.at(-1), { tunnus: 'paikallinen:qwen-x', kuvaus: 'Qwen X', ryhma: 'Paikalliset' });
    assert.deepEqual(runko.mallit.at(-1), { nimi: 'palvelin/qwen-x', kuvaus: 'Qwen X', ryhma: 'Paikalliset' });
  } finally {
    await p.sulje();
  }
  const q = await palvelin(fix, { lisaYmp: { paikalliset: async () => { throw new Error('ssh'); } } });
  try {
    assert.deepEqual((await q.havainto(fix.pyynto)).runko, fix.odotus.runko);
  } finally {
    await q.sulje();
  }
});

test('purkajat: ylisuuri tai rikkinäinen runko → 413 / 400 ennen yhtään komentoa', async () => {
  const p = await palvelin(hae('pura-ei-perhe'));
  try {
    const iso = await p.havainto(POST('b', { purkaja: 'x'.repeat(2000) }));
    assert.deepEqual([iso.status, iso.runko, iso.aja], [413, { virhe: 'runko liian suuri' }, []]);
  } finally {
    await p.sulje();
  }
});

// ---------- skriptien ympäristö (aja.mjs ajaKomento, palvelimen oletusajaja) ----------
test('ajaKomento: CLAUDE_CODE_SESSION_ID ja TMUX_PANE pois, ~/.local/bin PATHin alkuun', async () => {
  const ennen = { s: process.env.CLAUDE_CODE_SESSION_ID, t: process.env.TMUX_PANE };
  process.env.CLAUDE_CODE_SESSION_ID = 'kutsujan-istunto';
  process.env.TMUX_PANE = '%9';
  try {
    const r = await ajaKomento(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.CLAUDE_CODE_SESSION_ID ?? null, process.env.TMUX_PANE ?? null, process.env.PATH]))']);
    const [s, t, polku] = JSON.parse(r.stdout);
    assert.deepEqual([r.koodi, s, t], [0, null, null]);
    assert.ok(polku.startsWith(`${join(KOTI, '.local/bin')}:`), polku);
  } finally {
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', ennen.s], ['TMUX_PANE', ennen.t]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
