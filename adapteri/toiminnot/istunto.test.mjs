// node --test --test-timeout=120000 scopes2/adapteri/toiminnot/istunto.test.mjs
// T-67 (ARK-16, S-10): pakkaa, automaattisiirto, herata ja herata-pois. Jokainen testidata/toiminnot/{pakkaa,automaattisiirto,herata,herata-pois}-*.json
// ajetaan oikean HTTP-toimintopalvelimen (luoToimintopalvelin, portti 0) läpi ja verrataan fixtureen (status, runko, argv ilman list-panes,
// ajaValinnat, viiveet). Lisäksi omat testit: kaksi ruutua, ei ruutua, agy-varareitti, jonon kirjoitus ja purku (jonoVali 20 ms),
// uudelleenkäynnistys jonon ollessa kesken, ryhmän uusin korvaa vanhemman sekä rikkinäinen jonotiedosto.
// Replay-apurit ovat tiedostossa testiapurit.mjs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { luoToimintopalvelin } from './palvelin.mjs';
import { JONO_RYHMA, JONOTIEDOSTO, REITIT, jonoKaikki, jonotiedostonPolku, kaynnista } from './istunto.mjs';
import { REITIT as PURA_REITIT } from './pura.mjs';
import { toimintoKaynnissa } from './aja.mjs';
import { KAIKKI, KOUKUT, toteutetut } from './reitit.mjs';
import { TMP, ajaFixture, avainTiedosto, kokoaYmparisto, lataaFixturet, luoMockAja, pyyda, vertaaFixtureen } from './testiapurit.mjs';

after(() => rmSync(TMP, { recursive: true, force: true }));

const KOUKKU = [{ nimi: 'istunto', kaynnista }];
const fixturet = lataaFixturet(/^(pakkaa|automaattisiirto|herata|herata-pois)-/);
const hae = (nimi) => structuredClone(fixturet.find((f) => f.tapaus === nimi));
const POST = (komento, skooppi = 'a') => ({ metodi: 'POST', polku: `/api/skoopit/${skooppi}/${komento}`, runko: {} });

test('reitit: neljä istuntoreittiä toteutettu, terveyslistalla ja kaynnista-koukku rekisteröity reitit.mjs:ssä', () => {
  assert.deepEqual(REITIT.map((r) => `${r.metodi} ${r.kuvio}`), ['POST /api/skoopit/*/pakkaa', 'POST /api/skoopit/*/automaattisiirto', 'POST /api/skoopit/*/herata', 'POST /api/skoopit/*/herata-pois']);
  assert.ok(REITIT.every((r) => r.toteutettu === true && typeof r.kasittele === 'function'));
  for (const r of REITIT) assert.ok(toteutetut(KAIKKI).includes(`${r.metodi} ${r.kuvio}`));
  const koukku = KOUKUT.find((q) => q.nimi === 'istunto');
  assert.equal(koukku?.kaynnista, kaynnista);
});

test('fixturet: kaikki 12 pakkaa-, automaattisiirto-, herata- ja herata-pois-tapausta katettu', () => {
  const nimet = fixturet.map((f) => f.tapaus).sort();
  const odotetut = ['pakkaa', 'automaattisiirto', 'herata', 'herata-pois'].flatMap((n) => ['vapaa', 'kiireinen', 'kysymys-auki'].map((t) => `${n}-${t}`)).sort();
  assert.deepEqual(nimet, odotetut);
  assert.deepEqual(JONO_RYHMA, { '/sa': 'herätys', '/sa pois': 'herätys', '/automaattisiirto': 'siirto' });
});

for (const fix of fixturet) {
  test(`fixture ${fix.tapaus}`, async () => {
    const { havainto } = await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
    vertaaFixtureen(fix, havainto);
  });
}

test('oletus-odotus: pakkaa-kysymys-auki toimii ilman injektoitua odotusta (escapeTauko 1 ms)', async () => {
  const fix = fixturet.find((f) => f.tapaus === 'pakkaa-kysymys-auki');
  const { havainto } = await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, oikeaOdotus: true, lisaYmp: { escapeTauko: 1, jonoVali: 0 } });
  assert.equal(havainto.status, 200);
  assert.deepEqual(havainto.aja, fix.odotus.aja);
  assert.equal(havainto.viiveet, undefined);
});

test('toimintolokiin ok-rivi (muoto kuten vanha: toiminto, nimi, tulos, ...tulos) ja hylätty-rivi syyn kanssa', async () => {
  const ok = await ajaFixture(hae('pakkaa-vapaa'), { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
  assert.deepEqual(ok.loki.map((r) => ({ ...r, aika: undefined })), [{ aika: undefined, toiminto: 'pakkaa', nimi: 'a', tulos: 'ok', istunto: 's1', komento: '/pakkaa' }]);
  const hylatty = await ajaFixture(hae('pakkaa-kiireinen'), { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
  assert.deepEqual(hylatty.loki.map((r) => ({ ...r, aika: undefined })), [{ aika: undefined, toiminto: 'pakkaa', nimi: 'a', tulos: 'hylätty', syy: 'istunto on varattu (busy); yritä vuoron jälkeen' }]);
});

test('tuntematon skooppi → 404, kaikki neljä komentoa', async () => {
  for (const komento of ['pakkaa', 'automaattisiirto', 'herata', 'herata-pois']) {
    const fix = hae('pakkaa-vapaa');
    fix.pyynto = POST(komento, 'ei-ole');
    const { havainto } = await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
    assert.deepEqual([havainto.status, havainto.runko, havainto.aja], [404, { virhe: 'tuntematon skooppi' }, []], komento);
  }
});

test('kaksi vapaata tmux-ruutua → 409 "useita tmux-istuntoja", ei näppäilyä (kaikki neljä komentoa)', async () => {
  for (const [komento, tila] of [['pakkaa', 'idle'], ['automaattisiirto', 'busy'], ['herata', 'idle'], ['herata-pois', 'busy']]) {
    const fix = hae('pakkaa-vapaa');
    fix.pyynto = POST(komento);
    const toinen = structuredClone(fix.ymparisto.istunnot[0]);
    toinen.tiedosto = `${process.ppid}.json`;
    Object.assign(toinen.sisalto, { pid: process.ppid, sessionId: 's2', tmux: 'siirto-a-2:@2.%6', status: tila });
    fix.ymparisto.istunnot.push(toinen);
    const { havainto } = await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
    assert.deepEqual([havainto.status, havainto.runko, havainto.aja], [409, { virhe: 'skoopissa on useita tmux-istuntoja' }, []], komento);
  }
});

test('ei tmux-ruutua (eikä agy-ruutua) → 409 komento nimettynä, kaikki neljä komentoa', async () => {
  const tekstit = { pakkaa: '/pakkaa', automaattisiirto: '/automaattisiirto', herata: '/sa', 'herata-pois': '/sa pois' };
  for (const [komento, teksti] of Object.entries(tekstit)) {
    const fix = hae('pakkaa-vapaa');
    fix.pyynto = POST(komento);
    delete fix.ymparisto.istunnot[0].sisalto.tmux;
    const { havainto } = await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
    assert.deepEqual([havainto.status, havainto.runko, havainto.aja], [409, { virhe: `skoopilla ei ole tmux-istuntoa, johon ${teksti} voi lähettää` }, []], komento);
  }
});

test('vaara ruutu (ruudun pid ei täsmää) → 409 ja ei send-keys', async () => {
  const fix = hae('herata-vapaa');
  fix.ymparisto.tmux['display-message'] = '424242\n';
  const { havainto } = await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
  assert.deepEqual([havainto.status, havainto.runko], [409, { virhe: 'istunnon tmux-ruutu ei täsmää' }]);
  assert.ok(!havainto.aja.some((a) => a[1] === 'send-keys'));
});

// agyRuudut-varareitti on käytössä, kun elävien istuntojen listassa ei ole skoopin tmux-istuntoa mutta list-panes näyttää agy-ruudun.
// Tässä lista jää tyhjäksi, koska istunnotAsync tunnistaa agy-ruudun skoopin mallittomalla slugilla ('a-b') ja agyRuudut
// jokaisen ei-aakkosnumeerisen merkin viivaksi ('a--b'); skoopin 'a--b' ruutu löytyy vain agyRuudut-haulla.
const agyVara = (komento) => {
  const fix = hae('pakkaa-vapaa');
  fix.pyynto = POST(komento, 'a--b');
  fix.ymparisto.skooppitiedot = { 'a--b': ['R.md'] };
  fix.ymparisto.istunnot = [];
  fix.ymparisto.transkriptit = [];
  fix.ymparisto.tmux = { 'display-message': 'agy\n', 'capture-pane': '> \n? for shortcuts\n', 'list-panes': 'siirto-a--b-123456 agy 1700000000 4242\n' };
  return fix;
};

test('agy-varareitti: ei Claude-ruutua, yksi agy-ruutu → komento kirjaimellisesti ja Enter agy-ruutuun (ei tarkistaRuutu eikä jonoa)', async () => {
  for (const [komento, teksti] of [['pakkaa', '/pakkaa'], ['automaattisiirto', '/automaattisiirto'], ['herata', '/sa'], ['herata-pois', '/sa pois']]) {
    const { havainto, loki } = await ajaFixture(agyVara(komento), { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
    assert.equal(havainto.status, 200, komento);
    assert.deepEqual(havainto.runko, { ok: true, toiminto: komento, nimi: 'a--b', istunto: 'siirto-a--b-123456', komento: teksti });
    assert.deepEqual(havainto.aja, [['tmux', 'send-keys', '-t', 'siirto-a--b-123456', '-l', teksti], ['tmux', 'send-keys', '-t', 'siirto-a--b-123456', 'Enter']]);
    assert.equal(loki.at(-1).tulos, 'ok');
  }
});

test('agy-ruutu tavallisena skoopin istuntona (pane_pid täsmää) → kirjoitus agy-ruutuun; väärä pane_pid → 409', async () => {
  const fix = agyVara('pakkaa');
  fix.pyynto = POST('pakkaa');
  fix.ymparisto.skooppitiedot = { a: ['R.md'] };
  fix.ymparisto.tmux['list-panes'] = 'siirto-a-123456 agy 1700000000 4242\n';
  fix.ymparisto.tmux['display-message'] = '4242\n';
  const ok = (await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } })).havainto;
  assert.deepEqual([ok.status, ok.runko.istunto], [200, 'siirto-a-123456']);
  assert.deepEqual(ok.aja.slice(-2), [['tmux', 'send-keys', '-t', 'siirto-a-123456', '-l', '/pakkaa'], ['tmux', 'send-keys', '-t', 'siirto-a-123456', 'Enter']]);
  fix.ymparisto.tmux['display-message'] = '1\n';
  const vaara = (await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } })).havainto;
  assert.deepEqual([vaara.status, vaara.runko], [409, { virhe: 'istunnon tmux-ruutu ei täsmää' }]);
});

test('agy-varareitti: kaksi agy-ruutua → 409', async () => {
  const fix = agyVara('pakkaa');
  fix.ymparisto.tmux['list-panes'] = 'siirto-a--b-123456 agy 1700000000 4242\nsiirto-a--b-654321 agy 1700000001 4243\n';
  const { havainto } = await ajaFixture(fix, { reitit: REITIT, koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
  assert.equal(havainto.status, 409);
  assert.ok(!havainto.aja.some((a) => a[1] === 'send-keys'));
});

test('jonotiedosto: ymp.tila + toiminnot-jono.json, oletus ~/.local/state/scopes2; vanhaa scopes-toiminnot-jono.json ei käytetä', () => {
  assert.equal(JONOTIEDOSTO, 'toiminnot-jono.json');
  assert.equal(jonotiedostonPolku({ tila: '/x/tila' }), '/x/tila/toiminnot-jono.json');
  assert.equal(jonotiedostonPolku({}), join(homedir(), '.local/state/scopes2/toiminnot-jono.json'));
  assert.ok(!jonotiedostonPolku({}).includes('scopes-toiminnot-jono'));
});

// ---------- jono: oma palvelin, oikea ajastin (jonoVali 20 ms), tila levyllä ----------
const odotaEhto = async (ehto, ms = 5000) => {
  const raja = Date.now() + ms;
  while (Date.now() < raja) { if (ehto()) return true; await new Promise((ok) => setTimeout(ok, 10)); }
  return ehto();
};

// Palvelin kaynnista-koukulla ja annetulla ympäristöllä; ymp-lisäykset (istunnotDir, projektitDir, jonoVali, odota) reiteille ja koukulle.
async function palvelinJonolle(k, { jonoVali = 20, kaari = (aja) => aja, lisaYmp = {} } = {}) {
  const ctx = { kutsut: [], kentta: '', loki: [] };
  const lisa = { istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, jonoVali, odota: async () => {}, ...lisaYmp };
  const palvelin = luoToimintopalvelin({
    portti: 0, avainTiedosto, juuri: k.juuri, tila: k.tila, aja: kaari(luoMockAja(k.ymp2, k.istunnonTranskripti, ctx)), kello: () => 1_000_000, loki: (rivi) => ctx.loki.push(rivi),
    reitit: REITIT.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) })),
    koukut: KOUKKU.map((q) => ({ ...q, kaynnista: (ymp) => q.kaynnista({ ...ymp, ...lisa }) })),
  });
  const portti = await palvelin.kuuntele();
  const kirjoitukset = () => ctx.kutsut.filter((c) => c.kutsu[1] === 'send-keys').map((c) => c.kutsu.slice(4));
  return { ctx, portti, sulje: () => palvelin.sulje(), kirjoitukset };
}
const jonoTiedosto = (k) => join(k.tila, JONOTIEDOSTO);
const lueJono = (k) => JSON.parse(readFileSync(jonoTiedosto(k), 'utf8'));
// Muuttaa elävän istunnon tilaa levyllä (status, waitingFor) – kuten Claude Code päivittää istuntotiedostoaan.
function muutaIstunto(k, muutos) {
  const [i] = k.ymp2.istunnot;
  Object.assign(i.sisalto, muutos);
  writeFileSync(join(k.istunnotDir, i.tiedosto), JSON.stringify(i.sisalto));
}

test('jono: kiireisen istunnon /sa jonoon (rakenne kuten vanha), purku ajastimella kun ruutu vapautuu, ruutu vapautuu jonosta', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const p = await palvelinJonolle(k);
  try {
    const v = await pyyda(p.portti, fix.pyynto);
    assert.deepEqual([v.status, JSON.parse(v.teksti)], [200, fix.odotus.runko]);
    assert.deepEqual(lueJono(k), [{ nimi: 'a', istunto: 's1', komento: '/sa', toiminto: 'herata', aika: 1_000_000 }]);
    assert.ok(!p.ctx.kutsut.some((c) => c.kutsu[1] === 'send-keys'), 'varattuun istuntoon ei kirjoiteta');
    await new Promise((ok) => setTimeout(ok, 120));
    assert.deepEqual(p.kirjoitukset(), [], 'busy-istunnosta jono ei pura');
    muutaIstunto(k, { status: 'idle' });
    assert.ok(await odotaEhto(() => p.kirjoitukset().length === 2), `kirjoitukset ${JSON.stringify(p.kirjoitukset())}`);
    assert.deepEqual(p.kirjoitukset(), [['-l', '/sa'], ['Enter']]);
    assert.ok(await odotaEhto(() => lueJono(k).length === 0));
    assert.deepEqual(p.ctx.loki.at(-1), { toiminto: 'herata', nimi: 'a', tulos: 'ok', istunto: 's1', komento: '/sa', jonosta: true });
    // Ruutu vapautui: seuraava komento menee suoraan, ei jonoon.
    const suora = await pyyda(p.portti, POST('herata-pois'));
    assert.equal(JSON.parse(suora.teksti).jonossa, undefined);
    assert.deepEqual(lueJono(k), []);
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('jono: ajastin pysähtyy kun jono tyhjenee ja kun palvelin suljetaan (pysayta); ei kirjoituksia suljetun palvelimen jälkeen', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const p = await palvelinJonolle(k);
  try {
    await pyyda(p.portti, fix.pyynto);
  } finally {
    await p.sulje();
  }
  muutaIstunto(k, { status: 'idle' });
  await new Promise((ok) => setTimeout(ok, 150));
  assert.deepEqual(p.kirjoitukset(), [], 'suljetun palvelimen ajastin ei pura jonoa');
  assert.equal(lueJono(k).length, 1, 'jono säilyy levyllä');
  rmSync(k.d, { recursive: true, force: true });
});

test('jono: adapterin uudelleenkäynnistys jonon ollessa kesken – uusi kaynnista() lukee jonon tiedostosta ja purkaa sen', async () => {
  const fix = hae('automaattisiirto-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const ensimmainen = await palvelinJonolle(k, { jonoVali: 0 });
  try {
    const v = await pyyda(ensimmainen.portti, fix.pyynto);
    assert.deepEqual(JSON.parse(v.teksti), fix.odotus.runko);
  } finally {
    await ensimmainen.sulje();
  }
  assert.deepEqual(lueJono(k), [{ nimi: 'a', istunto: 's1', komento: '/automaattisiirto', toiminto: 'automaattisiirto', aika: 1_000_000 }]);
  muutaIstunto(k, { status: 'idle' });
  const toinen = await palvelinJonolle(k);
  try {
    assert.ok(await odotaEhto(() => toinen.kirjoitukset().length === 2), `kirjoitukset ${JSON.stringify(toinen.kirjoitukset())}`);
    assert.deepEqual(toinen.kirjoitukset(), [['-l', '/automaattisiirto'], ['Enter']]);
    assert.ok(await odotaEhto(() => lueJono(k).length === 0));
    assert.equal(toinen.ctx.loki.at(-1).jonosta, true);
  } finally {
    await toinen.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('jono: ryhmän uusin korvaa vanhemman (/sa → /sa pois), automaattisiirto on oma ryhmänsä', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const p = await palvelinJonolle(k, { jonoVali: 0 });
  try {
    await pyyda(p.portti, POST('herata'));
    assert.deepEqual(lueJono(k).map((j) => j.komento), ['/sa']);
    await pyyda(p.portti, POST('herata-pois'));
    assert.deepEqual(lueJono(k).map((j) => [j.komento, j.toiminto]), [['/sa pois', 'herata-pois']]);
    await pyyda(p.portti, POST('automaattisiirto'));
    assert.deepEqual(lueJono(k).map((j) => j.komento).sort(), ['/automaattisiirto', '/sa pois']);
    await pyyda(p.portti, POST('herata'));
    assert.deepEqual(lueJono(k).map((j) => j.komento).sort(), ['/automaattisiirto', '/sa']);
    const v = await pyyda(p.portti, POST('pakkaa'));
    assert.equal(v.status, 409, 'pakkaa ei jonoteta');
    assert.equal(lueJono(k).length, 2);
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('jono: vapaaseen istuntoon lähtevä komento poistaa saman ryhmän jonotetun; purkujärjestys herätys ennen siirtoa', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const p = await palvelinJonolle(k, { jonoVali: 0 });
  try {
    await pyyda(p.portti, POST('herata-pois'));
    muutaIstunto(k, { status: 'idle' });
    const v = await pyyda(p.portti, POST('herata'));
    assert.deepEqual(JSON.parse(v.teksti), { ok: true, toiminto: 'herata', nimi: 'a', istunto: 's1', komento: '/sa' });
    assert.deepEqual(lueJono(k), [], 'korvattu /sa pois poistui jonosta');
  } finally {
    await p.sulje();
  }
  muutaIstunto(k, { status: 'busy' });
  const q = await palvelinJonolle(k);
  try {
    await pyyda(q.portti, POST('automaattisiirto'));
    await pyyda(q.portti, POST('herata'));
    muutaIstunto(k, { status: 'idle' });
    assert.ok(await odotaEhto(() => q.kirjoitukset().filter((x) => x[0] === '-l').length === 2));
    assert.deepEqual(q.kirjoitukset().filter((x) => x[0] === '-l'), [['-l', '/sa'], ['-l', '/automaattisiirto']]);
  } finally {
    await q.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('jono: jonotettu /automaattisiirto puretaan myös auki olevan kysymyksen kohdalla (Escape ensin)', async () => {
  const fix = hae('automaattisiirto-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const p = await palvelinJonolle(k);
  try {
    await pyyda(p.portti, fix.pyynto);
    muutaIstunto(k, { status: 'waiting', waitingFor: 'input needed' });
    assert.ok(await odotaEhto(() => p.kirjoitukset().length === 3), `kirjoitukset ${JSON.stringify(p.kirjoitukset())}`);
    assert.deepEqual(p.kirjoitukset(), [['Escape'], ['-l', '/automaattisiirto'], ['Enter']]);
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('jono: jonossa ollut istunto päättyi → komento putoaa ja hylätty-rivi lokiin', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const p = await palvelinJonolle(k);
  try {
    await pyyda(p.portti, fix.pyynto);
    rmSync(join(k.istunnotDir, k.ymp2.istunnot[0].tiedosto));
    assert.ok(await odotaEhto(() => lueJono(k).length === 0));
    assert.deepEqual(p.ctx.loki.at(-1), { toiminto: 'herata', nimi: 'a', tulos: 'hylätty', syy: 'jonossa ollut istunto päättyi', istunto: 's1' });
    assert.deepEqual(p.kirjoitukset(), []);
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('rikkinäinen tai kelpaamaton jonotiedosto ei kaada eikä tuo komentoriville muuta kuin jonotettavia komentoja', async () => {
  const fix = hae('herata-vapaa');
  for (const sisalto of ['{ei json', '', '{}', '"teksti"', 'null']) {
    const k = kokoaYmparisto(fix.ymparisto);
    muutaTiedosto(k, sisalto);
    const p = await palvelinJonolle(k);
    try {
      const v = await pyyda(p.portti, fix.pyynto);
      assert.deepEqual([v.status, JSON.parse(v.teksti)], [200, fix.odotus.runko], sisalto);
      assert.deepEqual(p.kirjoitukset(), [['-l', '/sa'], ['Enter']], sisalto);
    } finally {
      await p.sulje();
      rmSync(k.d, { recursive: true, force: true });
    }
  }
});

function muutaTiedosto(k, sisalto) {
  mkdirSync(k.tila, { recursive: true });
  writeFileSync(jonoTiedosto(k), sisalto);
}

test('kelpaamattomat jonorivit ohitetaan: vain jonotettava komento, merkkijonokentät ja luku-aika; muu ei päädy tmuxiin', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  muutaIstunto(k, { status: 'idle' });
  const hyva = { nimi: 'a', istunto: 's1', komento: '/sa', toiminto: 'herata', aika: 5 };
  muutaTiedosto(k, JSON.stringify([
    { ...hyva, komento: 'rm -rf /' },
    { ...hyva, komento: '/pakkaa', toiminto: 'pakkaa' },
    { ...hyva, nimi: 5 },
    { ...hyva, istunto: null },
    { ...hyva, toiminto: 7 },
    { ...hyva, aika: 'nyt' },
    'merkkijono', null, 42, [],
    hyva,
  ]));
  const p = await palvelinJonolle(k);
  try {
    assert.ok(await odotaEhto(() => p.kirjoitukset().length === 2), `kirjoitukset ${JSON.stringify(p.kirjoitukset())}`);
    await new Promise((ok) => setTimeout(ok, 120));
    assert.deepEqual(p.kirjoitukset(), [['-l', '/sa'], ['Enter']]);
    assert.ok(!JSON.stringify(p.ctx.kutsut).includes('rm -rf'));
    assert.ok(await odotaEhto(() => lueJono(k).length === 0));
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

// ---------- T-68: yhteinen toimintolukko (aja.mjs) — pura ja istuntotoiminnot jakavat yhden lukon kuten vanhan yksi kaynnissa ----------
test('yhteinen lukko: pura käynnissä (autovaihto kesken) → istuntokomento 429 "toinen toiminto on käynnissä (pura)", ei näppäilyä', async () => {
  for (const komento of ['pakkaa', 'automaattisiirto', 'herata', 'herata-pois']) {
    const fix = hae('pakkaa-vapaa');
    fix.pyynto = POST(komento);
    fix.ymparisto.samanaikainen = { metodi: 'POST', polku: '/api/skoopit/b/pura', runko: {} };
    const { havainto, loki } = await ajaFixture(fix, { reitit: [...REITIT, ...PURA_REITIT], koukut: KOUKKU, lisaYmp: { jonoVali: 0 } });
    assert.deepEqual([havainto.status, havainto.runko, havainto.aja], [429, { virhe: 'toinen toiminto on käynnissä (pura)' }, []], komento);
    assert.deepEqual(loki.find((r) => r.toiminto === komento), { aika: loki.find((r) => r.toiminto === komento).aika, toiminto: komento, nimi: 'a', tulos: 'hylätty', syy: 'toinen toiminto käynnissä' });
    assert.equal(loki.at(-1).toiminto, 'pura', 'pura valmistuu pidon jälkeen');
  }
});

// Palvelin istunto- ja purkureiteillä; odota = ymp.odota (Escape-tauko), jolla istuntotoiminto voidaan pitää kesken lukossa.
async function palvelinMolemmille(k, { odota = async () => {}, jonoVali = 0 } = {}) {
  const ctx = { kutsut: [], kentta: '', loki: [], pito: null };
  const lisa = { istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, jonoVali, odota };
  const palvelin = luoToimintopalvelin({
    portti: 0, avainTiedosto, juuri: k.juuri, tila: k.tila, aja: luoMockAja(k.ymp2, k.istunnonTranskripti, ctx), kello: () => 1_000_000, loki: (rivi) => ctx.loki.push(rivi),
    reitit: [...REITIT, ...PURA_REITIT].map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) })),
    koukut: KOUKKU.map((q) => ({ ...q, kaynnista: (ymp) => q.kaynnista({ ...ymp, ...lisa }) })),
  });
  const portti = await palvelin.kuuntele();
  const kirjoitukset = () => ctx.kutsut.filter((c) => c.kutsu[1] === 'send-keys').map((c) => c.kutsu.slice(4));
  return { ctx, portti, sulje: () => palvelin.sulje(), kirjoitukset };
}

test('yhteinen lukko: istuntotoiminto käynnissä (pakkaa Escape-tauossa) → pura 429 "toinen toiminto on käynnissä (pakkaa)", ei skriptejä', async () => {
  const fix = hae('pakkaa-kysymys-auki');
  const k = kokoaYmparisto(fix.ymparisto);
  let vapauta;
  let saavutettu;
  const tauolla = new Promise((ok) => { saavutettu = ok; });
  const p = await palvelinMolemmille(k, { odota: () => { saavutettu(); return new Promise((ok) => { vapauta = ok; }); } });
  try {
    const kesken = pyyda(p.portti, fix.pyynto);
    await tauolla;
    assert.equal(toimintoKaynnissa({ tila: k.tila }), 'pakkaa');
    const ennen = p.ctx.kutsut.length;
    const v = await pyyda(p.portti, { metodi: 'POST', polku: '/api/skoopit/b/pura', runko: {} });
    assert.deepEqual([v.status, JSON.parse(v.teksti)], [429, { virhe: 'toinen toiminto on käynnissä (pakkaa)' }]);
    assert.deepEqual(p.ctx.kutsut.slice(ennen), [], 'pura ei ajanut mitään');
    assert.deepEqual(p.ctx.loki.at(-1), { toiminto: 'pura', nimi: 'b', tulos: 'hylätty', syy: 'toinen toiminto käynnissä' });
    vapauta();
    assert.equal((await kesken).status, 200);
    assert.equal(toimintoKaynnissa({ tila: k.tila }), null);
    const pura = await pyyda(p.portti, { metodi: 'POST', polku: '/api/skoopit/b/pura', runko: {} });
    assert.equal(pura.status, 200, 'lukon vapauduttua pura menee läpi');
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('yhteinen lukko: jono ei pura komentoa, kun pura pitää lukkoa; purkaa sen, kun lukko vapautuu', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const p = await palvelinMolemmille(k, { jonoVali: 20 });
  try {
    await pyyda(p.portti, fix.pyynto);
    assert.equal(lueJono(k).length, 1);
    let vapauta;
    let saavutettu;
    const pidossa = new Promise((ok) => { saavutettu = ok; });
    p.ctx.pito = { esto: new Promise((ok) => { vapauta = ok; }), saavutettu, otettu: false };
    const kesken = pyyda(p.portti, { metodi: 'POST', polku: '/api/skoopit/b/pura', runko: {} });
    await pidossa;
    muutaIstunto(k, { status: 'idle' });
    await new Promise((ok) => setTimeout(ok, 150));
    assert.deepEqual(p.kirjoitukset(), [], 'jono odottaa purun lukkoa');
    assert.equal(lueJono(k).length, 1, 'komento pysyy jonossa');
    vapauta();
    assert.equal((await kesken).status, 200);
    assert.ok(await odotaEhto(() => p.kirjoitukset().length === 2), `kirjoitukset ${JSON.stringify(p.kirjoitukset())}`);
    assert.deepEqual(p.kirjoitukset(), [['-l', '/sa'], ['Enter']]);
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

// ---- T-107: puraJono odottaa skoopinIstunnot-kutsua (list-panes ennen istuntotiedostoja) ennen lukkoa -----------------------
// Viritetty pito pysäyttää seuraavan list-panes-kutsun, kunnes testi vapauttaa sen; muut kutsut kulkevat.
function luoPito() {
  const p = { viritetty: false };
  p.viritä = () => { p.viritetty = true; p.saavutettu = new Promise((ok) => { p.saavu = ok; }); p.esto = new Promise((ok) => { p.vapauta = ok; }); };
  p.kaari = (aja) => async (komento, argv, valinnat) => {
    if (p.viritetty && komento === 'tmux' && argv[0] === 'list-panes') { p.viritetty = false; p.saavu(); await p.esto; }
    return aja(komento, argv, valinnat);
  };
  return p;
}

test('jono (T-107): kierros odottaa istuntolistaa, ajastin ei aja toista kierrosta päälle → /automaattisiirto täsmälleen kerran', async () => {
  const fix = hae('automaattisiirto-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const pito = luoPito();
  const p = await palvelinJonolle(k, { jonoVali: 10, kaari: pito.kaari });
  try {
    await pyyda(p.portti, fix.pyynto);
    pito.viritä();
    await pito.saavutettu;
    muutaIstunto(k, { status: 'idle' });
    await new Promise((ok) => setTimeout(ok, 80)); // useita ajastinkierroksia odotuksen aikana
    pito.vapauta();
    assert.ok(await odotaEhto(() => lueJono(k).length === 0));
    await new Promise((ok) => setTimeout(ok, 80));
    assert.deepEqual(p.kirjoitukset(), [['-l', '/automaattisiirto'], ['Enter']]);
    assert.equal(p.ctx.loki.filter((r) => r.jonosta).length, 1);
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('jono (T-107): alkio poistuu jonosta kierroksen odotuksen aikana → kierros ei lähetä poistettua /sa:ta', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  const pito = luoPito();
  const p = await palvelinJonolle(k, { jonoVali: 10, kaari: pito.kaari });
  try {
    await pyyda(p.portti, fix.pyynto);
    pito.viritä();
    await pito.saavutettu;
    muutaIstunto(k, { status: 'idle' });
    // Vapaaseen istuntoon suoraan lähtevä /sa pois poistaa saman ryhmän jonotetun /sa:n (kuten vanha).
    const v = await pyyda(p.portti, POST('herata-pois'));
    assert.equal(v.status, 200);
    assert.deepEqual(lueJono(k), []);
    pito.vapauta();
    await new Promise((ok) => setTimeout(ok, 80));
    assert.deepEqual(p.kirjoitukset(), [['-l', '/sa pois'], ['Enter']]);
    assert.ok(!p.ctx.loki.some((r) => r.jonosta), JSON.stringify(p.ctx.loki));
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});

test('jono (T-109): lisäys ja purku kutsuvat ymp.lahdeKierros (ei odoteta); jonoKaikki antaa jonon skoopeittain, tyhjä = {}', async () => {
  const fix = hae('herata-kiireinen');
  const k = kokoaYmparisto(fix.ymparisto);
  let kierroksia = 0;
  const p = await palvelinJonolle(k, { lisaYmp: { lahdeKierros: () => { kierroksia++; return new Promise(() => {}); } } });
  try {
    assert.deepEqual(jonoKaikki({ tila: k.tila }), {});
    await pyyda(p.portti, fix.pyynto);
    assert.equal(kierroksia, 1, 'lisäys → heti-kierros');
    assert.deepEqual(jonoKaikki({ tila: k.tila }), { a: [{ komento: '/sa', aika: 1_000_000 }] });
    muutaIstunto(k, { status: 'idle' });
    assert.ok(await odotaEhto(() => lueJono(k).length === 0));
    assert.ok(kierroksia >= 2, 'purku → heti-kierros');
    assert.deepEqual(jonoKaikki({ tila: k.tila }), {});
  } finally {
    await p.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
});
