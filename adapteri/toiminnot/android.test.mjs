// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/android.test.mjs
// T-85 (ARK-19, S-10): Android-ohjaus. Jokainen testidata/toiminnot/android-*.json ajetaan oikean HTTP-toimintopalvelimen (luoToimintopalvelin,
// portti 0) läpi ja verrataan fixtureen (status, runko tai binäärivastaus, adb-/python3-argv, ajaValinnat, viiveet, nukutus). Reitit käyttävät
// vain ymp.android-oliota: testi luo sen vanhasta/android.mjs:n luoAndroid-tehtaalla (kuten adapteri.mjs) mock-ajalla, ja ymp.aja heittää.
// Lisäksi kuivatila, ilman laiteolioa -vastaukset, tallennushakemistot, sarjaan-lukko, nukutusajastin (nyt = kello), yksi jaettu laiteolio
// lähdetilan ja ohjauksen välillä sekä adapteri.mjs aliprosessina (--adb, SCOPES2_ANDROID_KUIVA, oletushakemistot). Ei oikeaa adb:tä eikä
// laitetta 127.0.0.1:5555: adb-kutsut menevät mockiin tai aliprosessitestissä PATH:n ensimmäiseen väärennettyyn adb-skriptiin.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { luoLahde } from '../lahde.mjs';
import { luoAndroid, pngAlusta } from '../vanhasta/android.mjs';
import { luoToimintopalvelin } from './palvelin.mjs';
import { REITIT } from './android.mjs';
import { KAIKKI, toteutetut } from './reitit.mjs';
import { AVAIN, TMP, avainTiedosto, kokoaYmparisto, lataaFixturet, vertaaFixtureen } from './testiapurit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

const ADAPTERI = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapteri.mjs');
const AIKA0 = Date.parse('2026-10-21T08:00:00.000Z'); // tallenna-lisa.mjs:n kiinteä kello
const fixturet = lataaFixturet(/^android-/);
const hae = (nimi) => structuredClone(fixturet.find((f) => f.tapaus === nimi));
const MUUTTAVA = /input |am start|push |content call|mkdir/;

const syvaKartta = (x, f) => (typeof x === 'string' ? f(x) : Array.isArray(x) ? x.map((y) => syvaKartta(y, f))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, syvaKartta(v, f)])) : x);

// HTTP-pyyntö kuten tallenna-lisa.mjs: merkkijonorunko sellaisenaan (liitteen tavut), muu JSONina; vastaus tavuina.
function pyyda(portti, { metodi, polku, runko }) {
  return new Promise((ok, ei) => {
    const raaka = typeof runko === 'string';
    const data = runko == null ? null : raaka ? runko : JSON.stringify(runko);
    const r = httpRequest({ host: '127.0.0.1', port: portti, method: metodi, path: polku, headers: {
      authorization: `Bearer ${AVAIN}`, ...(data !== null ? { ...(raaka ? {} : { 'content-type': 'application/json' }), 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const palat = [];
      res.on('data', (p) => palat.push(p));
      res.on('end', () => ok({ status: res.statusCode, tyyppi: String(res.headers['content-type'] ?? ''), levy: String(res.headers['content-disposition'] ?? ''), puskuri: Buffer.concat(palat) }));
    });
    r.on('error', ei);
    r.end(data ?? undefined);
  });
}

// Laiteolion adb-/python3-väärennös (tallenna-lisa.mjs ajaTavut): stdout tavuina, säännöt fixturen komennot.vastaukset (ensimmäinen osuva,
// jarjestys = peräkkäiset vastaukset), oletus koodi 0 ja tyhjä stdout. t.pito = { ehto(komento, argv), esto, saavutettu, otettu } pysäyttää
// ensimmäisen osuvan kutsun. Muu kuin adb ja python3 on virhe.
function luoLaiteAja(ymp2, t) {
  const sarjat = new Map();
  const saanto = (komento, argv) => {
    const rivi = argv.join(' ');
    const s = (ymp2.komennot.vastaukset ?? []).find((x) => x.komento === komento && (x.sisaltaa === undefined || rivi.includes(x.sisaltaa)));
    if (!s || !s.jarjestys) return s ?? null;
    const i = sarjat.get(s) ?? 0;
    sarjat.set(s, Math.min(i + 1, s.jarjestys.length - 1));
    return s.jarjestys[i];
  };
  return async (komento, argv, valinnat = {}) => {
    if (komento !== 'adb' && komento !== 'python3') throw new Error(`android.test: odottamaton komento ${komento} ${argv.join(' ')}`);
    const v = {};
    if (valinnat.syote) v.syote = Buffer.isBuffer(valinnat.syote) ? `<${valinnat.syote.length} tavua>` : valinnat.syote;
    if (valinnat.cwd) v.cwd = valinnat.cwd;
    t.kutsut.push({ kutsu: [komento, ...argv], valinnat: v });
    const pito = t.pito;
    if (pito && !pito.otettu && pito.ehto(komento, argv)) { pito.otettu = true; pito.saavutettu(); await pito.esto; }
    const s = saanto(komento, argv) ?? {};
    const stdout = s.stdoutBase64 !== undefined ? Buffer.from(s.stdoutBase64, 'base64') : Buffer.from(s.stdout ?? '');
    return { koodi: s.koodi ?? 0, stdout, stderr: s.stderr ?? '' };
  };
}

// Palvelin fixturen ympäristöllä: laiteolio (luoAndroid, ei oikeaa adb:tä) annetaan reiteille ymp.android:ina, kello ja olion nyt = t.aika.
// ilmanOliota = adapteri ilman --adb. ymp.aja heittää: android-moduuli ei saa ajaa komentoja itse.
async function palvelin(fix, { kuiva = fix.ymparisto.android?.kuiva === true, ilmanOliota = false } = {}) {
  const k = kokoaYmparisto(fix.ymparisto);
  const t = { kutsut: [], viiveet: [], aika: AIKA0, pito: null };
  const androidDir = join(k.d, 'android');
  const liitteetDir = join(k.tila, 'liitteet');
  const olio = ilmanOliota ? null : luoAndroid({
    aja: luoLaiteAja(k.ymp2, t), loki: join(k.tila, 'toiminnot.loki'), kuiva, tuotoksetDir: androidDir,
    odota: async (ms) => { if (ms >= 100) t.viiveet.push(ms); }, nyt: () => t.aika,
  });
  const p = luoToimintopalvelin({
    portti: 0, koukut: [], avainTiedosto, juuri: k.juuri, tila: k.tila, kello: () => t.aika,
    aja: async (komento) => { throw new Error(`ymp.aja ei kuulu android-reiteille: ${komento}`); },
    reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, olio ? { ...ymp, android: olio } : ymp) })),
  });
  const portti = await p.kuuntele();
  // Sallitut erot: tiedostopolkujen juuri (<ANDROID>, <LIITTEET>) ja liitepolun satunnaisosa (luoLiitteet: randomBytes(3)).
  const korvaukset = [[androidDir, '<ANDROID>'], [liitteetDir, '<LIITTEET>'], [k.juuri, '<JUURI>'], [TMP, '<TMP>']];
  const norm = (x) => syvaKartta(x, (s) => korvaukset.reduce((u, [a, b]) => u.replaceAll(a, b), s).replace(/\d{8}T\d{6}-[0-9a-f]{6}-/g, '20261021T080000-abcdef-'));
  const alkuRandom = Math.random;
  const pyynto = async (kysely) => {
    t.kutsut.length = 0;
    t.viiveet.length = 0;
    Math.random = () => 0.5; // luoAndroid:n dump-tiedoston nimi (tallenna-lisa.mjs)
    try { return await pyyda(portti, kysely); } finally { Math.random = alkuRandom; }
  };
  const havainto = async (kysely) => {
    const v = await pyynto(kysely);
    const h = { status: v.status };
    if (v.tyyppi.includes('json')) h.runko = JSON.parse(v.puskuri.toString('utf8'));
    else h.runko = { tyyppi: v.tyyppi, base64: v.puskuri.toString('base64'), ...(v.levy ? { nimi: decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(v.levy)?.[1] ?? '') } : {}) };
    h.aja = t.kutsut.map((c) => c.kutsu);
    if (t.kutsut.some((c) => Object.keys(c.valinnat).length)) h.ajaValinnat = t.kutsut.map((c) => c.valinnat);
    if (t.viiveet.length) h.viiveet = [...t.viiveet];
    return norm(h);
  };
  const pida = (ehto) => {
    let vapauta;
    let saavutettu;
    const lupaus = new Promise((ok) => { saavutettu = ok; });
    t.pito = { ehto, esto: new Promise((ok) => { vapauta = ok; }), saavutettu, otettu: false };
    return { saavutettu: lupaus, vapauta: () => vapauta() };
  };
  const komennot = () => t.kutsut.map((c) => c.kutsu.at(-1));
  return { k, t, olio, portti, pyynto, havainto, pida, komennot, norm, androidDir, liitteetDir, sulje: async () => { olio?.lopeta(); await p.sulje(); rmSync(k.d, { recursive: true, force: true }); } };
}

// Koko replay: pyyntö, odotus ja fixturen android.myohemmin (kello etenee ja ajastimen nukutaJosHiljaista ajetaan).
async function ajaFixture(fix, valinnat) {
  const p = await palvelin(fix, valinnat);
  try {
    const h = await p.havainto(fix.pyynto);
    const ms = fix.ymparisto.android?.myohemmin;
    if (ms) {
      p.t.aika += ms;
      p.t.kutsut.length = 0;
      const nukutettu = await p.olio.nukutaJosHiljaista();
      h.myohemmin = p.norm({ ms, nukutettu, aja: p.t.kutsut.map((c) => c.kutsu) });
    }
    return h;
  } finally {
    await p.sulje();
  }
}

// ---------- reitit ja fixturet ----------
test('reitit: kuusi android-reittiä toteutettu ja terveyslistalla', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), [
    'GET /api/android/ruutu', 'GET /api/android/ui', 'GET /api/android/tuotokset', 'GET /api/android/tuotos', 'POST /api/android/liite', 'POST /api/android/*']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  for (const r of REITIT) assert.ok(toteutetut(KAIKKI).includes(`${r.metodi} ${r.kuvio}`));
});

test('fixturet: kaikki 49 android-tapausta mukana', () => {
  assert.equal(fixturet.length, 49);
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const h = await ajaFixture(fix);
    vertaaFixtureen(fix, h);
    if (fix.odotus.myohemmin) assert.deepEqual(h.myohemmin, fix.odotus.myohemmin, `${fix.tapaus}: nukutus pyynnön jälkeen`);
    else assert.equal(h.myohemmin, undefined);
  });
}

// ---------- kuivatila ----------
test('kuiva: tilaa muuttavia adb-komentoja ei ajeta ja vastauksessa on kuiva', async () => {
  for (const nimi of ['android-napauta-kuiva', 'android-nappi-kuiva', 'android-kirjoita-kuiva', 'android-liite-kuiva']) {
    const h = await ajaFixture(hae(nimi));
    assert.ok(h.runko.kuiva, `${nimi}: kuiva puuttuu`);
    assert.ok(h.aja.every((a) => !MUUTTAVA.test(a.join(' '))), `${nimi}: muuttava komento ajettiin`);
  }
  // sama pyyntö ilman kuivatilaa ajaa napautuksen (kuivafixturen pyyntö, ei android.kuiva)
  const fix = hae('android-napauta-kuiva');
  delete fix.ymparisto.android;
  const h = await ajaFixture(fix);
  assert.ok(h.aja.some((a) => a.at(-1).startsWith('input tap')));
  assert.equal(h.runko.kuiva, undefined);
});

// ---------- ilman laiteolioa (adapteri ilman --adb) ----------
test('ilman ymp.android-oliota: vanhan statuskoodit, kun adb ei vastaa (ei komentoja laitteelle)', async () => {
  const p = await palvelin(hae('android-ui'), { ilmanOliota: true });
  try {
    const odotus = [
      [{ metodi: 'GET', polku: '/api/android/ruutu', runko: null }, 502],
      [{ metodi: 'GET', polku: '/api/android/ui', runko: null }, 502],
      [{ metodi: 'GET', polku: '/api/android/tuotokset', runko: null }, 200, { tiedostot: [] }],
      [{ metodi: 'GET', polku: '/api/android/tuotos?polku=%2Fsdcard%2FDownload%2Fa.txt', runko: null }, 404],
      [{ metodi: 'GET', polku: '/api/android/tuotos?polku=%2Fetc%2Fpasswd', runko: null }, 400],
      [{ metodi: 'POST', polku: '/api/android/liite?nimi=a.txt', runko: 'sisältö' }, 502],
      [{ metodi: 'POST', polku: '/api/android/napauta', runko: { x: 0.5, y: 0.5 } }, 502],
      [{ metodi: 'POST', polku: '/api/android/ei-ole', runko: {} }, 404, { virhe: 'tuntematon toiminto' }],
    ];
    for (const [pyynto, status, runko] of odotus) {
      const h = await p.havainto(pyynto);
      assert.equal(h.status, status, pyynto.polku);
      if (runko) assert.deepEqual(h.runko, runko, pyynto.polku);
      else if (status === 502) assert.match(h.runko.virhe, /^adb ei vastaa: /, pyynto.polku);
      assert.deepEqual(h.aja, [], pyynto.polku);
    }
  } finally {
    await p.sulje();
  }
});

// ---------- tallennus omiin hakemistoihin ----------
test('tallennus: liite <tila>/liitteet/android/, tuotos ja talteen laiteolion tuotoksetDir (ei vanhan hakemistoihin)', async () => {
  const p = await palvelin(hae('android-liite'));
  try {
    const h = await p.havainto(hae('android-liite').pyynto);
    assert.equal(h.status, 200);
    assert.deepEqual(readdirSync(join(p.k.tila, 'liitteet')), ['android']);
    const liitteet = readdirSync(join(p.k.tila, 'liitteet', 'android'));
    assert.equal(liitteet.length, 1);
    assert.match(liitteet[0], /^20261021T080000-[0-9a-f]{6}-muistio\.txt$/, 'aika tulee ymp.kellosta');
    assert.equal(readFileSync(join(p.k.tila, 'liitteet', 'android', liitteet[0]), 'utf8'), 'liitteen sisältö');
    assert.deepEqual(readdirSync(p.k.tila).sort(), ['liitteet', 'toiminnot.loki']);
  } finally {
    await p.sulje();
  }
  const q = await palvelin(hae('android-tuotos'));
  try {
    await q.havainto(hae('android-tuotos').pyynto);
    assert.equal(readFileSync(join(q.androidDir, 'laitteelta', 'raportti.txt'), 'utf8'), 'raportin sisältö\n');
    assert.ok(!existsSync(join(q.k.tila, 'liitteet')), 'tuotos ei kirjoita liitehakemistoon');
  } finally {
    await q.sulje();
  }
  const r = await palvelin(hae('android-talteen'));
  try {
    const h = await r.havainto(hae('android-talteen').pyynto);
    assert.equal(h.runko.polku, '<ANDROID>/20261021T080000-gemini.md');
    assert.deepEqual(readdirSync(r.androidDir), ['20261021T080000-gemini.md']);
  } finally {
    await r.sulje();
  }
});

// ---------- sarjaan-lukko ----------
test('sarjaan: kaksi rinnakkaista toimintoa ajetaan peräkkäin (toinen odottaa, kunnes ensimmäinen on valmis)', async () => {
  const p = await palvelin(hae('android-napauta'));
  try {
    const pito = p.pida((komento, argv) => argv.at(-1).startsWith('input tap'));
    p.t.kutsut.length = 0;
    const a = pyyda(p.portti, { metodi: 'POST', polku: '/api/android/napauta', runko: { x: 0.5, y: 0.5 } });
    await pito.saavutettu;
    const b = pyyda(p.portti, { metodi: 'POST', polku: '/api/android/nappi', runko: { nimi: 'koti' } });
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(p.komennot().length, 3, 'toinen toiminto ei aloittanut, vaikka ensimmäinen on kesken');
    assert.ok(p.komennot()[2].startsWith('input tap'));
    pito.vapauta();
    const [va, vb] = await Promise.all([a, b]);
    assert.deepEqual([va.status, vb.status], [200, 200]);
    assert.equal(p.komennot().length, 5);
    assert.deepEqual(p.komennot().slice(3), ['dumpsys power | grep mWakefulness=', 'input keyevent KEYCODE_HOME']);
  } finally {
    await p.sulje();
  }
});

// ---------- nukutusajastin ----------
test('nukutus: itse herätetty ruutu nukkumaan vasta 60 s hiljaisuuden jälkeen (nyt = ymp.kello), muuten ei', async () => {
  const p = await palvelin(hae('android-nukutus'));
  try {
    await p.pyynto(hae('android-nukutus').pyynto);
    p.t.aika += 59_999;
    assert.equal(await p.olio.nukutaJosHiljaista(), false, '59,999 s: liian aikaisin');
    p.t.aika += 1;
    p.t.kutsut.length = 0;
    assert.equal(await p.olio.nukutaJosHiljaista(), true, '60 s: nukutus');
    assert.deepEqual(p.komennot(), ['dumpsys power | grep mWakefulness=', 'input keyevent KEYCODE_SLEEP']);
    p.t.aika += 120_000;
    assert.equal(await p.olio.nukutaJosHiljaista(), false, 'ei toista nukutusta');
  } finally {
    await p.sulje();
  }
});

test('nukutus: 15 s:n ajastin kutsuu nukutaJosHiljaista ja lopeta() pysäyttää sen', async () => {
  const ajetut = [];
  let hereilla = false;
  const ok = (stdout = '') => ({ koodi: 0, stdout: Buffer.from(stdout), stderr: '' });
  const aja = async (komento, argv) => {
    const rivi = argv.at(-1);
    ajetut.push(rivi);
    if (rivi.startsWith('dumpsys power')) return ok(hereilla ? 'mWakefulness=Awake\n' : 'mWakefulness=Asleep\n');
    if (rivi === 'wm size') return ok('Physical size: 1080x2400\n');
    if (rivi.includes('KEYCODE_WAKEUP')) hereilla = true;
    return ok();
  };
  let aika = AIKA0;
  const tyhjenna = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  mock.timers.enable({ apis: ['setInterval'] });
  const olio = luoAndroid({ aja, nyt: () => aika, odota: async () => {} });
  try {
    await olio.suorita('nappi', { nimi: 'koti' });
    ajetut.length = 0;
    aika += 45_000;
    mock.timers.tick(15_000);
    await tyhjenna();
    assert.deepEqual(ajetut, [], '45 s: ajastin ei nukuta');
    aika += 15_000;
    mock.timers.tick(15_000);
    await tyhjenna();
    assert.ok(ajetut.some((r) => r.includes('KEYCODE_SLEEP')), '60 s: ajastin nukuttaa');
    olio.lopeta();
    ajetut.length = 0;
    hereilla = true;
    aika += 600_000;
    mock.timers.tick(60_000);
    await tyhjenna();
    assert.deepEqual(ajetut, [], 'lopeta() pysäytti ajastimen');
  } finally {
    olio.lopeta();
    mock.timers.reset();
  }
});

// ---------- yksi laiteolio lähdetilan ja ohjauksen välillä ----------
test('jaettu olio: lähdetila saa saman olion kuin ohjaus; herätystila ja sarjaan-lukko ovat yhteiset', async () => {
  const p = await palvelin(hae('android-heratys'));
  try {
    const bodyt = [];
    let luotu = 0;
    let lahdeOlio = null;
    const lahde = luoLahde({
      ydin: 'http://ydin.testi', avainTiedosto, adb: 'testilaite:1', loki: () => {},
      aja: async () => { throw new Error('lähde ei saa ajaa omaa adb:tä, kun olio on injektoitu'); },
      fetch: async (url, valinnat) => { bodyt.push({ url, runko: JSON.parse(valinnat.body) }); return { status: 200, ok: true }; },
      luoAndroid: () => { luotu++; lahdeOlio = p.olio; return p.olio; },
    });
    // 1. Ohjaus herättää ruudun HTTP:n kautta → olion heratimme; lähdetilan tila() näkee sen samasta oliosta.
    const h = await p.havainto(hae('android-heratys').pyynto);
    assert.equal(h.status, 200);
    assert.deepEqual((await lahde.kierros()).lahetetty, ['android']);
    assert.equal(luotu, 1, 'lähde loi olion injektoidulla tehtaalla kerran');
    assert.equal(bodyt.length, 1);
    assert.equal(bodyt[0].url, 'http://ydin.testi/api/lahde/android');
    assert.deepEqual(bodyt[0].runko.sisalto, { hereilla: false, heratimme: true, koko: [1080, 2400], kuiva: false });
    // 2. Lähteen olio ja ohjauksen olio ovat sama → yhteinen sarjaan-lukko: lähteen oliolle annettu toiminto jonottaa HTTP-toiminnon taakse.
    assert.equal(lahdeOlio, p.olio);
    const pito = p.pida((komento, argv) => argv.at(-1).startsWith('input tap'));
    p.t.kutsut.length = 0;
    const a = pyyda(p.portti, { metodi: 'POST', polku: '/api/android/napauta', runko: { x: 0.5, y: 0.5 } });
    await pito.saavutettu;
    const b = lahdeOlio.suorita('nappi', { nimi: 'takaisin' });
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(p.komennot().length, 3, 'lähteen olion toiminto jonottaa HTTP-toiminnon taakse');
    pito.vapauta();
    const [va, vb] = await Promise.all([a, b]);
    assert.equal(va.status, 200);
    assert.equal(vb.ok, true);
    assert.ok(p.komennot().at(-1).includes('KEYCODE_BACK'));
    lahde.sulje();
  } finally {
    await p.sulje();
  }
});

// ---------- adapteri.mjs aliprosessina: --adb, jaettu olio, kuivatila, oletushakemistot ----------
const FAKE_ADB = `#!${process.execPath}
const fs = require('node:fs');
const [s, laite, ...rest] = process.argv.slice(2);
const kansio = process.env.FAKE_ADB_KANSIO;
fs.appendFileSync(kansio + '/adb.log', JSON.stringify([s, laite, ...rest]) + '\\n');
if (s !== '-s' || laite !== 'testilaite:1') { process.stderr.write('vaara laite'); process.exit(3); }
const rivi = rest[1] ?? '';
if (rest[0] === 'shell') {
  if (rivi.includes('dumpsys power')) process.stdout.write(fs.existsSync(kansio + '/hereilla') ? 'mWakefulness=Awake\\n' : 'mWakefulness=Asleep\\n');
  else if (rivi.includes('wm size')) process.stdout.write('Physical size: 1080x2400\\n');
  else if (rivi.includes('KEYCODE_WAKEUP')) fs.writeFileSync(kansio + '/hereilla', '1');
} else if (rest[0] === 'exec-out' && rivi.startsWith('cat ')) process.stdout.write('tuotoksen sisältö\\n');
`;

function mockYdin() {
  const android = [];
  const palvelin = createServer((req, res) => {
    let runko = '';
    req.on('data', (c) => { runko += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/lahde/android') android.push(JSON.parse(runko).sisalto);
      else res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((ok) => palvelin.listen(0, '127.0.0.1', () => ok({ palvelin, android, url: `http://127.0.0.1:${palvelin.address().port}` })));
}

async function odotaEhto(ehto, ms = 20_000) {
  const raja = Date.now() + ms;
  while (Date.now() < raja) {
    if (ehto()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Käynnistää adapterin (--toiminnot 0) väärennetyllä adb:llä ja eristetyllä HOME:lla; PATH:n ensimmäinen adb on väärennös.
async function aliprosessi({ argumentit = ['--adb', 'testilaite:1'], env = {} }, tarkista) {
  const h = mkdtempSync(join(TMP, 'adapteri-'));
  const bin = join(h, 'bin');
  const koti = join(h, 'koti');
  mkdirSync(bin);
  mkdirSync(join(koti, '.config', 'scopes2'), { recursive: true });
  mkdirSync(join(h, 'projektit'));
  writeFileSync(join(koti, '.config', 'scopes2', 'avain'), AVAIN);
  writeFileSync(join(bin, 'adb'), FAKE_ADB);
  chmodSync(join(bin, 'adb'), 0o755);
  const ydin = await mockYdin();
  const ymparisto = { ...process.env, HOME: koti, PATH: `${bin}:/usr/bin:/bin`, SCOPES2_ALUSTA: 'linux', FAKE_ADB_KANSIO: h, ...env };
  if (!('SCOPES2_ANDROID_KUIVA' in env)) delete ymparisto.SCOPES2_ANDROID_KUIVA;
  const lapsi = spawn(process.execPath, [ADAPTERI, '--ydin', ydin.url, '--projektit', join(h, 'projektit'), '--toiminnot', '0', ...argumentit], { env: ymparisto, stdio: ['ignore', 'ignore', 'pipe'] });
  let virhe = '';
  lapsi.stderr.on('data', (c) => { virhe += c; });
  try {
    assert.ok(await odotaEhto(() => /toiminnot: kuuntelee 127\.0\.0\.1:\d+/.test(virhe)), `toimintopalvelin ei käynnistynyt; stderr: ${virhe}`);
    const portti = Number(/toiminnot: kuuntelee 127\.0\.0\.1:(\d+)/.exec(virhe)[1]);
    const adbLoki = () => (existsSync(join(h, 'adb.log')) ? readFileSync(join(h, 'adb.log'), 'utf8').trim().split('\n').map((r) => JSON.parse(r)) : []);
    await tarkista({ h, koti, portti, ydin, adbLoki, stderr: () => virhe });
  } finally {
    lapsi.kill('SIGKILL');
    ydin.palvelin.closeAllConnections?.();
    ydin.palvelin.close();
  }
}

test('adapteri.mjs --adb: yksi olio lähdetilalle ja ohjaukselle, tavuajaja, oletushakemistot ~/.local/state/scopes2/{liitteet/android,android}', async () => {
  await aliprosessi({}, async ({ koti, portti, ydin, adbLoki, stderr }) => {
    const r = await pyyda(portti, { metodi: 'POST', polku: '/api/android/nappi', runko: { nimi: 'herata' } });
    assert.equal(r.status, 200, r.puskuri.toString());
    assert.deepEqual(JSON.parse(r.puskuri.toString()), { ok: true });
    // lähdetila (saman olion heratimme) lähtee ytimeen seuraavalla kierroksella
    assert.ok(await odotaEhto(() => ydin.android.some((s) => s.heratimme === true)), `lähdetila ei nähnyt ohjauksen herätystä; stderr: ${stderr()}`);
    assert.equal(ydin.android.at(-1).kuiva, false);
    const t = await pyyda(portti, { metodi: 'GET', polku: '/api/android/tuotos?polku=%2Fsdcard%2FDownload%2Fa.txt', runko: null });
    assert.equal(t.status, 200);
    assert.equal(t.puskuri.toString(), 'tuotoksen sisältö\n');
    assert.equal(readFileSync(join(koti, '.local/state/scopes2/android/laitteelta/a.txt'), 'utf8'), 'tuotoksen sisältö\n');
    // liite: tallennus liitteet/android/, sitten adb push; fake-adb ei tuota dumpia, joten liite päättyy 502:een laitteen puolella
    const l = await pyyda(portti, { metodi: 'POST', polku: '/api/android/liite?nimi=m.txt', runko: 'abc' });
    assert.equal(l.status, 502, l.puskuri.toString());
    const tallennetut = readdirSync(join(koti, '.local/state/scopes2/liitteet/android'));
    assert.equal(tallennetut.length, 1);
    assert.match(tallennetut[0], /^\d{8}T\d{6}-[0-9a-f]{6}-m\.txt$/);
    const push = adbLoki().find((a) => a[2] === 'push');
    assert.equal(push[3], join(koti, '.local/state/scopes2/liitteet/android', tallennetut[0]));
    assert.ok(adbLoki().every((a) => a[0] === '-s' && a[1] === 'testilaite:1'), 'vain --adb:n laite');
    assert.ok(!adbLoki().some((a) => JSON.stringify(a).includes('127.0.0.1:5555')));
  });
});

test('adapteri.mjs: kuivatila SCOPES2_ANDROID_KUIVA=1 ja --android-kuiva ohittavat tilaa muuttavat adb-komennot', async () => {
  for (const asetus of [{ env: { SCOPES2_ANDROID_KUIVA: '1' } }, { argumentit: ['--adb', 'testilaite:1', '--android-kuiva'] }]) {
    await aliprosessi(asetus, async ({ portti, ydin, adbLoki, stderr }) => {
      const r = await pyyda(portti, { metodi: 'POST', polku: '/api/android/nappi', runko: { nimi: 'koti' } });
      assert.equal(r.status, 200, r.puskuri.toString());
      assert.deepEqual(JSON.parse(r.puskuri.toString()), { ok: true, kuiva: 'input keyevent KEYCODE_HOME' });
      assert.ok(await odotaEhto(() => ydin.android.length > 0), `lähdetila ei lähtenyt; stderr: ${stderr()}`);
      assert.equal(ydin.android[0].kuiva, true);
      assert.ok(adbLoki().length > 0);
      assert.ok(adbLoki().every((a) => !MUUTTAVA.test(a.slice(3).join(' '))), 'muuttava komento ajettiin kuivana');
    });
  }
});

test('adapteri.mjs ilman --adb: android-reitit toteutettu terveyslistalla, vastaus 502 eikä adb-kutsuja', async () => {
  await aliprosessi({ argumentit: [] }, async ({ portti, adbLoki }) => {
    const terveys = JSON.parse((await pyyda(portti, { metodi: 'GET', polku: '/api/terveys', runko: null })).puskuri.toString());
    for (const r of REITIT) assert.ok(terveys.reitit.includes(`${r.metodi} ${r.kuvio}`));
    const r = await pyyda(portti, { metodi: 'POST', polku: '/api/android/nappi', runko: { nimi: 'koti' } });
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.puskuri.toString()).virhe, /^adb ei vastaa: /);
    const t = await pyyda(portti, { metodi: 'GET', polku: '/api/android/tuotokset', runko: null });
    assert.equal(t.status, 200);
    assert.deepEqual(JSON.parse(t.puskuri.toString()), { tiedostot: [] });
    assert.deepEqual(adbLoki(), []);
  });
});

// T-88: laitteen toinen näyttö (TV) tuottaa screencapin alkuun varoitustekstin ennen PNG:tä; ruutu hylkää PNG-allekirjoitusta edeltävät tavut.
// Tietoinen ero vanhaan 8787:ään (vanhasta/android.mjs.ero); ilman allekirjoitusta syöte ei muutu → vanha 500.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('kuvadata')]);
const VAROITUS = Buffer.from('[Warning] Multiple displays were found, but no display id was specified! Defaulting to the first display found.\n');

test('T-88 pngAlusta: varoitusprefiksi pois, puhdas PNG ja allekirjoitukseton ennallaan', () => {
  assert.deepEqual(pngAlusta(Buffer.concat([VAROITUS, PNG])), PNG);
  assert.deepEqual(pngAlusta(PNG), PNG);
  const roska = Buffer.from('ei kuvaa');
  assert.equal(pngAlusta(roska), roska);
});

test('T-88 ruutu: python3 saa vain PNG-tavut, kun screencapin alussa on varoitus; ilman allekirjoitusta syöte ennallaan', async () => {
  const kokeile = async (screencap) => {
    const syotteet = [];
    const aja = async (komento, argv, valinnat = {}) => {
      if (komento === 'python3') { syotteet.push(valinnat.syote); return { koodi: 0, stdout: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), stderr: '' }; }
      if (argv.includes('screencap')) return { koodi: 0, stdout: screencap, stderr: '' };
      return { koodi: 0, stdout: Buffer.from('mWakefulness=Awake\n'), stderr: '' };
    };
    const vastaus = await luoAndroid({ laite: 'koe:1', aja, kuiva: true, tuotoksetDir: join(TMP, 'ruutu-t88') }).ruutu(360);
    return { vastaus, syote: syotteet[0] };
  };
  const varoituksella = await kokeile(Buffer.concat([VAROITUS, PNG, Buffer.alloc(200)]));
  assert.equal(varoituksella.vastaus.tyyppi, 'image/jpeg');
  assert.deepEqual(varoituksella.syote.subarray(0, PNG.length), PNG);
  assert.equal(varoituksella.syote.length, PNG.length + 200);
  const puhdas = await kokeile(Buffer.concat([PNG, Buffer.alloc(200)]));
  assert.equal(puhdas.syote.length, PNG.length + 200);
  const ilman = Buffer.concat([VAROITUS, Buffer.alloc(200, 7)]);
  assert.deepEqual((await kokeile(ilman)).syote, ilman);
});
