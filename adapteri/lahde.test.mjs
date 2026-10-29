import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { luoLahde } from './lahde.mjs';
import { projektiNimi } from './transkriptit.mjs';

const CWD = '/home/x/proj';
const SID = 'sess-1';
const rivi = (n) => JSON.stringify({
  type: 'assistant', timestamp: `2026-10-19T10:00:0${n}.000Z`,
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text: `vastaus ${n}` }], usage: { input_tokens: n, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } },
});

// Mock-ydin (fetch): kirjaa POST-kutsut; vastaa 200 {"aika"} tai 401, jos avain on väärä.
function mockYdin() {
  const kutsut = [];
  const fetch = async (url, init) => {
    const j = JSON.parse(init.body);
    kutsut.push({ url, laji: url.split('/').pop(), auth: init.headers.authorization, laite: j.laite, sisalto: j.sisalto });
    if (init.headers.authorization !== 'Bearer A') return { status: 401, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => ({ aika: 'HLC' }) };
  };
  const maara = (laji) => kutsut.filter((k) => k.laji === laji).length;
  return { kutsut, fetch, maara };
}

function ymparisto() {
  const h = mkdtempSync(join(tmpdir(), 'scopes2-lahde-'));
  const istunnot = join(h, 'sessions');
  const projektit = join(h, 'projects');
  const agy = join(h, 'agy');
  mkdirSync(istunnot);
  mkdirSync(join(projektit, projektiNimi(CWD)), { recursive: true });
  mkdirSync(agy);
  const avain = join(h, 'avain');
  writeFileSync(avain, 'A\n');
  writeFileSync(join(istunnot, `${process.pid}.json`), JSON.stringify({
    sessionId: SID, pid: process.pid, name: 'demo', cwd: CWD, status: 'busy', startedAt: 1760000000000, entrypoint: 'cli', tmux: '/tmp/tmux-1000/default,1,0.%7',
  }));
  const transkripti = join(projektit, projektiNimi(CWD), `${SID}.jsonl`);
  writeFileSync(transkripti, `${rivi(1)}\n`);
  return { h, istunnot, projektit, agy, avain, transkripti, siivoa: () => rmSync(h, { recursive: true, force: true }) };
}

const kayttorajaTehtaat = {
  luoKayttoraja: () => async () => ({ viikko: { kaytto: 1, nollautuu: null }, viisiTuntia: null, haettu: null }),
  luoAgyKayttoraja: () => async () => ({ viikko: null, viisiTuntia: null, haettu: null }),
};

function lahde(e, y, kello, lisa = {}) {
  return luoLahde({
    ydin: 'http://ydin.test', avainTiedosto: e.avain, aja: async () => ({ koodi: 1, stdout: '' }),
    istunnotDir: e.istunnot, projektitDir: e.projektit, skooppiNimet: () => ['demo'],
    fetch: y.fetch, nyt: () => kello.t, laite: 'testilaite', loki: () => {}, ...kayttorajaTehtaat, ...lisa,
  });
}

test('(a) sama sisältö kahdesti → yksi lähetys; kentät S-5b:n mukaan', async () => {
  const e = ymparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const l = lahde(e, y, kello);
    const eka = await l.kierros();
    assert.deepEqual(eka.lahetetty, ['istunnot', 'kayttoraja']);
    kello.t += 5000;
    const toka = await l.kierros();
    assert.deepEqual(toka.lahetetty, []);
    assert.equal(y.maara('istunnot'), 1);
    const k = y.kutsut.find((x) => x.laji === 'istunnot');
    assert.equal(k.url, 'http://ydin.test/api/lahde/istunnot');
    assert.equal(k.auth, 'Bearer A');
    assert.equal(k.laite, 'testilaite');
    assert.equal(k.sisalto.length, 1);
    const i = k.sisalto[0];
    assert.deepEqual(Object.keys(i).sort(), ['alkoi', 'hereilla', 'istunto', 'konteksti', 'kysely', 'ladatut', 'nimi', 'pakattu', 'pid', 'polku', 'pysahdys', 'ruutu', 'skooppi', 'tila', 'transkripti', 'vanhempi'].sort());
    assert.equal(i.nimi, 'demo');
    assert.equal(i.pid, process.pid);
    assert.equal(i.vanhempi, process.ppid);
    assert.equal(i.polku, e.transkripti);
    assert.equal(i.istunto, SID);
    assert.equal(i.skooppi, 'demo');
    assert.equal(i.tila, 'busy');
    assert.equal(i.kysely, false);
    assert.deepEqual(i.konteksti, { tokenit: 11, aika: '2026-10-19T10:00:01.000Z' });
    assert.equal(i.pysahdys, '2026-10-19T10:00:01.000Z');
    assert.equal(i.alkoi, new Date(1760000000000).toISOString());
    assert.equal(i.ruutu, '%7');
    assert.equal(i.transkripti, `${projektiNimi(CWD)}/${SID}.jsonl`);
    assert.equal(y.kutsut.find((x) => x.laji === 'kayttoraja').sisalto.claude.viikko.kaytto, 1);
  } finally { e.siivoa(); }
});

test('(b) muutos transkriptissa → toinen lähetys', async () => {
  const e = ymparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const l = lahde(e, y, kello);
    await l.kierros();
    appendFileSync(e.transkripti, `${rivi(2)}\n`);
    kello.t += 5000;
    const r = await l.kierros();
    assert.deepEqual(r.lahetetty, ['istunnot']);
    assert.equal(y.maara('istunnot'), 2);
    assert.equal(y.kutsut.filter((x) => x.laji === 'istunnot')[1].sisalto[0].konteksti.tokenit, 12);
  } finally { e.siivoa(); }
});

test('(c) 61 s kello → elossaolo lähettää muuttumattoman sisällön', async () => {
  const e = ymparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const l = lahde(e, y, kello);
    await l.kierros();
    kello.t += 59_000;
    assert.deepEqual((await l.kierros()).lahetetty, []);
    kello.t += 2000;
    const r = await l.kierros();
    assert.deepEqual(r.lahetetty, ['istunnot', 'kayttoraja']);
    assert.equal(y.maara('istunnot'), 2);
  } finally { e.siivoa(); }
});

const PANES = 'siirto-demo-123456 agy 1760000000 4242\nmuu-istunto bash 1760000000 1\n';

test('(d) agy-keskusteluhakemiston haku (readdir+stat) vain kerran 5 s sisällä', async () => {
  const e = ymparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    let hakuja = 0;
    const komennot = [];
    const l = lahde(e, y, kello, {
      istunnotDir: null,
      agyHakemisto: e.agy,
      aja: async (k, a) => { komennot.push([k, ...a].join(' ')); return { koodi: 0, stdout: PANES }; },
      agyIstunnot: async ({ listPanes }) => { hakuja++; assert.equal(listPanes, PANES); return [{ ruutu: 'siirto-demo-123456' }]; },
    });
    await l.kierros();
    kello.t += 4000;
    await l.kierros();
    assert.equal(hakuja, 1);
    assert.equal(komennot.filter((k) => k.startsWith('tmux list-panes')).length, 2, 'list-panes joka kierros');
    assert.equal(y.maara('agy'), 1);
    kello.t += 2000; // 6 s ensimmäisestä
    await l.kierros();
    assert.equal(hakuja, 2);
  } finally { e.siivoa(); }
});

test('(e) ilman agyRuudut-lippua ei capture-pane-kutsuja; lipulla on', async () => {
  const e = ymparisto(); const y = mockYdin();
  try {
    for (const agyRuudut of [false, true]) {
      const komennot = [];
      const l = lahde(e, y, { t: 1_000_000 }, {
        istunnotDir: null,
        agyHakemisto: e.agy,
        brainHakemisto: join(e.h, 'brain'),
        agyRuudut,
        aja: async (k, a) => {
          komennot.push([k, ...a].join(' '));
          return { koodi: 0, stdout: a[0] === 'list-panes' ? PANES : 'ruudun teksti\n' };
        },
      });
      await l.kierros();
      const luettu = komennot.filter((k) => k.startsWith('tmux capture-pane'));
      assert.equal(komennot.some((k) => k.startsWith('tmux list-panes')), true);
      if (agyRuudut) assert.equal(luettu.length, 1, 'yksi agy-ruutu → yksi capture-pane'); else assert.deepEqual(luettu, []);
      const agy = y.kutsut.filter((x) => x.laji === 'agy').at(-1).sisalto;
      assert.equal(Array.isArray(agy), true);
      assert.equal(agy.length, 1);
      assert.equal(agy[0].ruutu, 'siirto-demo-123456');
      l.sulje();
    }
  } finally { e.siivoa(); }
});

test('(f) android: tila() 1 s välimuistilla, vain adb shell -kutsuja', async () => {
  const e = ymparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const komennot = [];
    const l = lahde(e, y, kello, {
      istunnotDir: null,
      adb: '127.0.0.1:5555',
      aja: async (k, a) => {
        komennot.push([k, ...a].join(' '));
        const rivi = a.at(-1);
        if (/dumpsys power/.test(rivi)) return { koodi: 0, stdout: 'mWakefulness=Awake\n' };
        if (/wm size/.test(rivi)) return { koodi: 0, stdout: 'Physical size: 1080x2400\n' };
        return { koodi: 1, stdout: '' };
      },
    });
    assert.deepEqual((await l.kierros()).lahetetty, ['android']);
    const maara = komennot.length;
    await l.kierros(); // 0 ms: välimuistista
    assert.equal(komennot.length, maara);
    assert.equal(komennot.every((k) => k.startsWith('adb -s 127.0.0.1:5555 shell')), true);
    assert.equal(komennot.some((k) => /screencap/.test(k)), false);
    assert.deepEqual(y.kutsut.find((x) => x.laji === 'android').sisalto, { hereilla: true, heratimme: false, koko: [1080, 2400], kuiva: false });
    kello.t += 1500;
    await l.kierros();
    assert.ok(komennot.length > maara, 'TTL umpeutui → uusi haku');
    assert.equal(y.maara('android'), 1, 'sisältö ei muuttunut');
  } finally { e.siivoa(); }
});

test('401 → avain luetaan uudelleen ja yritetään kerran; ydin poissa → ei kaadu, uusinta seuraavalla kierroksella', async () => {
  const e = ymparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    writeFileSync(e.avain, 'VANHA\n');
    const l = lahde(e, y, kello);
    writeFileSync(e.avain, 'A\n');
    await l.kierros();
    assert.equal(y.kutsut.filter((k) => k.laji === 'istunnot').map((k) => k.auth).join(), 'Bearer VANHA,Bearer A');

    let poissa = true;
    const l2 = lahde(e, y, kello, { fetch: async (...a) => { if (poissa) throw new Error('ECONNREFUSED'); return y.fetch(...a); } });
    assert.deepEqual((await l2.kierros()).lahetetty, []);
    poissa = false;
    assert.deepEqual((await l2.kierros()).lahetetty, ['istunnot', 'kayttoraja']);
  } finally { e.siivoa(); }
});

// ---- T-83: laji asetukset (S-5b) --------------------------------------------------------------------------------------
// /proc-väärennös (Mac: /proc puuttuu): <proc>/<pid>/stat, jonka kenttä 4 on vanhempi.
function asetusYmparisto() {
  const e = ymparisto();
  const proc = join(e.h, 'proc');
  mkdirSync(join(proc, String(process.pid)), { recursive: true });
  writeFileSync(join(proc, String(process.pid), 'stat'), `${process.pid} (node) S ${process.ppid} ${'0 '.repeat(30)}`);
  const tila = join(e.h, 'asetus-tila');
  mkdirSync(tila);
  return { ...e, proc, tila };
}
const kirjoitaTila = (tila, tiedosto, sisalto) => {
  mkdirSync(join(tila, tiedosto, '..'), { recursive: true });
  writeFileSync(join(tila, tiedosto), sisalto);
};

test('asetukset: ilman asetusHakemisto-asetusta lajia ei kerätä eikä lähetetä (T-29-lajit ennallaan)', async () => {
  const e = asetusYmparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const l = lahde(e, y, kello, { proc: e.proc });
    assert.deepEqual((await l.kierros()).lahetetty, ['istunnot', 'kayttoraja']);
    assert.equal(y.maara('asetukset'), 0);
  } finally { e.siivoa(); }
});

test('asetukset: sisalto S-5b:n mukaan (yhteiset, avointen istuntojen omat arvot, skoopit); tiivisteellä ja 60 s elossaololla', async () => {
  const e = asetusYmparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const l = lahde(e, y, kello, { proc: e.proc, asetusHakemisto: e.tila, skooppiNimet: () => ['demo', 'toinen'] });
    assert.deepEqual((await l.kierros()).lahetetty, ['istunnot', 'kayttoraja', 'asetukset']);
    const a = y.kutsut.find((x) => x.laji === 'asetukset');
    assert.equal(a.url, 'http://ydin.test/api/lahde/asetukset');
    assert.equal(a.auth, 'Bearer A');
    assert.equal(a.laite, 'testilaite');
    assert.deepEqual(a.sisalto, {
      yhteiset: { automaattijatko: false, autopack: false, automaattisiirto: false, agyluvat: false },
      istunnot: { [SID]: { automaattijatko: false, autopack: false, automaattisiirto: false } },
      skoopit: { demo: [SID], toinen: [] },
    });

    // Sama sisältö → ei uutta lähetystä; 61 s → elossaolo.
    kello.t += 5000;
    assert.deepEqual((await l.kierros()).lahetetty, []);
    kello.t += 61000;
    assert.deepEqual((await l.kierros()).lahetetty, ['istunnot', 'kayttoraja', 'asetukset']);

    // Muutos tilatiedostoissa (yhteinen ja istuntokohtainen) → seuraava kierros lähettää; istunnon oma arvo voittaa yhteisen.
    kirjoitaTila(e.tila, 'automaattivalinta.txt', 'true\n');
    kirjoitaTila(e.tila, `istunnot/${SID}/automaattivalinta.txt`, 'false\n');
    kirjoitaTila(e.tila, `istunnot/${SID}/autopack.txt`, 'true\n');
    kirjoitaTila(e.tila, 'agy-luvat.txt', 'true\n');
    kello.t += 5000;
    assert.deepEqual((await l.kierros()).lahetetty, ['asetukset']);
    assert.deepEqual(y.kutsut.filter((x) => x.laji === 'asetukset').at(-1).sisalto, {
      yhteiset: { automaattijatko: true, autopack: false, automaattisiirto: false, agyluvat: true },
      istunnot: { [SID]: { automaattijatko: false, autopack: true, automaattisiirto: false } },
      skoopit: { demo: [SID], toinen: [] },
    });
  } finally { e.siivoa(); }
});

test('asetukset: pakattu istunto ei ole avoin (ei istunnot-kentässä eikä skooppilistassa); puuttuva tilahakemisto = kaikki pois', async () => {
  const e = asetusYmparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    rmSync(e.tila, { recursive: true });
    const l = lahde(e, y, kello, { proc: e.proc, asetusHakemisto: e.tila });
    await l.kierros();
    assert.deepEqual(y.kutsut.find((x) => x.laji === 'asetukset').sisalto.yhteiset, { automaattijatko: false, autopack: false, automaattisiirto: false, agyluvat: false });
    appendFileSync(e.transkripti, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-19T10:00:05.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'PAKATTU: valmis' }] } })}\n`);
    kello.t += 5000;
    assert.deepEqual((await l.kierros()).lahetetty, ['istunnot', 'asetukset']);
    assert.deepEqual(y.kutsut.filter((x) => x.laji === 'asetukset').at(-1).sisalto, {
      yhteiset: { automaattijatko: false, autopack: false, automaattisiirto: false, agyluvat: false }, istunnot: {}, skoopit: { demo: [] },
    });
  } finally { e.siivoa(); }
});

// ---- T-106: asetukset-lista sisältää agy-istunnot kuten vanha istunto-asetukset (lahteet.istunnot: Claude, sitten agy) ----
const AGY_ID = 'siirto-toinen-123456';

test('asetukset (T-106): avoin agy-istunto skoopit- ja istunnot-kentissä Claude-istuntojen perässä; pakattu agy ei ole avoin', async () => {
  const e = asetusYmparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const l = lahde(e, y, kello, {
      proc: e.proc, asetusHakemisto: e.tila, skooppiNimet: () => ['demo', 'toinen'], agyHakemisto: e.agy,
      aja: async () => ({ koodi: 0, stdout: PANES }),
      agyIstunnot: async () => [
        { id: AGY_ID, skooppi: 'toinen', pakattu: false },
        { id: 'siirto-demo-654321', skooppi: 'demo', pakattu: true },
      ],
    });
    await l.kierros();
    kirjoitaTila(e.tila, `istunnot/${AGY_ID}/autopack.txt`, 'true\n');
    kello.t += 5000;
    await l.kierros();
    assert.deepEqual(y.kutsut.filter((x) => x.laji === 'asetukset').at(-1).sisalto, {
      yhteiset: { automaattijatko: false, autopack: false, automaattisiirto: false, agyluvat: false },
      istunnot: {
        [SID]: { automaattijatko: false, autopack: false, automaattisiirto: false },
        [AGY_ID]: { automaattijatko: false, autopack: true, automaattisiirto: false },
      },
      skoopit: { demo: [SID], toinen: [AGY_ID] },
    });
  } finally { e.siivoa(); }
});

test('asetukset (T-106): agy-haku kerran kierroksella ja 5 s välimuistista; agy-lajin lähetysmäärä ei kasva asetuksista', async () => {
  const e = asetusYmparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    let hakuja = 0;
    const l = lahde(e, y, kello, {
      proc: e.proc, asetusHakemisto: e.tila, agyHakemisto: e.agy,
      aja: async () => ({ koodi: 0, stdout: PANES }),
      agyIstunnot: async () => { hakuja++; return [{ id: AGY_ID, skooppi: 'demo', pakattu: false }]; },
    });
    assert.deepEqual((await l.kierros()).lahetetty, ['istunnot', 'agy', 'kayttoraja', 'asetukset']);
    assert.equal(hakuja, 1, 'agy-laji ja asetukset jakavat yhden haun');
    kirjoitaTila(e.tila, 'agy-luvat.txt', 'true\n');
    kello.t += 4000;
    assert.deepEqual((await l.kierros()).lahetetty, ['asetukset']);
    assert.equal(hakuja, 1, 'TTL:n sisällä ei uutta hakua');
    assert.equal(y.maara('agy'), 1);
    assert.deepEqual(y.kutsut.filter((x) => x.laji === 'asetukset').at(-1).sisalto.skoopit, { demo: [SID, AGY_ID] });
  } finally { e.siivoa(); }
});

test('asetukset (T-106): ilman agyHakemistoa agy-hakua ei tehdä ja lista on ennallaan', async () => {
  const e = asetusYmparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    let hakuja = 0;
    const l = lahde(e, y, kello, {
      proc: e.proc, asetusHakemisto: e.tila,
      agyIstunnot: async () => { hakuja++; return [{ id: AGY_ID, skooppi: 'demo', pakattu: false }]; },
    });
    assert.deepEqual((await l.kierros()).lahetetty, ['istunnot', 'kayttoraja', 'asetukset']);
    assert.equal(hakuja, 0);
    assert.deepEqual(y.kutsut.find((x) => x.laji === 'asetukset').sisalto.skoopit, { demo: [SID] });
  } finally { e.siivoa(); }
});

test('T-111: kaksi samanaikaista kierros()-kutsua → yksi lähetys lajia kohden', async () => {
  const e = ymparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const l = lahde(e, y, kello);
    const [a, b] = await Promise.all([l.kierros(), l.kierros()]);
    assert.deepEqual(a.lahetetty, ['istunnot', 'kayttoraja']);
    assert.deepEqual(b.lahetetty, a.lahetetty);
    assert.equal(y.maara('istunnot'), 1);
    assert.equal(y.maara('kayttoraja'), 1);
  } finally { e.siivoa(); }
});

// ---- T-109: laji jono (S-5b) -------------------------------------------------------------------------------------------
test('jono (T-109): lisäys jonoon → seuraava kierros lähettää jono-lajin uudella sisällöllä; ennallaan → ei lähetystä (tiiviste), 60 s jälkeen elossaolo', async () => {
  const e = asetusYmparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const sisalto = {};
    const l = lahde(e, y, kello, { proc: e.proc, jono: () => structuredClone(sisalto) });
    assert.ok((await l.kierros()).lahetetty.includes('jono'));
    assert.deepEqual(y.kutsut.filter((x) => x.laji === 'jono').at(-1).sisalto, {});
    assert.equal(y.kutsut.find((x) => x.laji === 'jono').url, 'http://ydin.test/api/lahde/jono');
    sisalto.demo = [{ komento: '/pakkaa', aika: 5 }];
    assert.ok((await l.kierros()).lahetetty.includes('jono'));
    assert.deepEqual(y.kutsut.filter((x) => x.laji === 'jono').at(-1).sisalto, { demo: [{ komento: '/pakkaa', aika: 5 }] });
    kello.t += 5000;
    assert.ok(!(await l.kierros()).lahetetty.includes('jono'), 'ennallaan → ei lähetystä');
    assert.equal(y.maara('jono'), 2);
    kello.t += 60000;
    assert.ok((await l.kierros()).lahetetty.includes('jono'), 'elossaolo 60 s');
    assert.equal(y.maara('jono'), 3);
  } finally { e.siivoa(); }
});

test('jono (T-109): ilman jono-asetusta (ei --toiminnot) lajia ei kerätä eikä lähetetä', async () => {
  const e = asetusYmparisto(); const y = mockYdin(); const kello = { t: 1_000_000 };
  try {
    const l = lahde(e, y, kello, { proc: e.proc });
    assert.ok(!(await l.kierros()).lahetetty.includes('jono'));
    assert.equal(y.maara('jono'), 0);
  } finally { e.siivoa(); }
});
