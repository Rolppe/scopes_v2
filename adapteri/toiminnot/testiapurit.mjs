// Toimintotestien yhteiset replay-apurit (T-66 viestit.test.mjs:stä, siirretty T-67:ssä; ei testitiedosto: päätteenä ei ole .test.mjs).
// Jokainen importoiva testitiedosto ajetaan omassa prosessissaan, joten tämä luo oman tmp-hakemiston (TMP), avaimen ja kodin;
// testitiedosto siivoaa: after(() => rmSync(TMP, { recursive: true, force: true })).
//   TMP, KOTI, AVAIN, avainTiedosto   testiprosessin väliaikaishakemisto, koti, V2-avain ja sen tiedosto
//   lataaFixturet(suodin)           testidata/toiminnot/*.json, joiden tapausnimi täsmää suodattimeen
//   kokoaYmparisto(ymparisto)       fixturen ymparisto levylle (juuri, istunnot, projektit, chat) → { d, juuri, istunnotDir, ..., ymp2 }
//   luoMockAja(ymp2, transkripti, ctx)  tallentava `aja`-väärennös (tmux, autovaihto.sh, pura-malliton, claude); ctx.kutsut ilman list-panes
//   pyyda(portti, pyynto)           HTTP-pyyntö Bearer-avaimella
//   ajaFixture(fix, { reitit, koukut, lisaYmp, oikeaOdotus })   koko replay: ympäristö, palvelin, samanaikainen pyyntö, varsinainen pyyntö → havainto
//   vertaaFixtureen(fix, havainto)  assert-vertailu
//   avaaVirta(portti, pyynto)       (T-69) NDJSON-vastaus rivi kerrallaan, kun palvelin vielä kirjoittaa: { status, tyyppi, seuraava(), kaikki(), sulje() }
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projektiNimi } from '../vanhasta/lahteet.mjs';
import { luoToimintopalvelin } from './palvelin.mjs';

export const TESTIDATA = fileURLToPath(new URL('../testidata/toiminnot/', import.meta.url));
export const AVAIN = 'testiapurit-testiavain-0123456789abcdef0123';
export const TMP = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'toiminto-testi-')));
export const KOTI = join(TMP, 'koti');
mkdirSync(KOTI, { recursive: true });
export const avainTiedosto = join(KOTI, 'avain');
writeFileSync(avainTiedosto, `${AVAIN}\n`);

// ---------- replay-apurit ----------
export function lataaFixturet(suodin) {
  return readdirSync(TESTIDATA).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(TESTIDATA, f), 'utf8'))).filter((o) => suodin.test(o.tapaus));
}

const syvaKartta = (x, f) => (typeof x === 'string' ? f(x) : Array.isArray(x) ? x.map((y) => syvaKartta(y, f))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, syvaKartta(v, f)])) : x);
const kirjoitaJsonl = (polku, rivit) => writeFileSync(polku, rivit.map((r) => JSON.stringify(r)).join('\n'));

// Fixturen ymparisto levylle (kuten tallenna-vanha.mjs ajaTapaus): <PID> = testiprosessin pid.
export function kokoaYmparisto(ymparisto) {
  const d = mkdtempSync(join(TMP, 't-'));
  const k = { d, juuri: join(d, 'juuri'), chatDir: join(d, 'chat'), istunnotDir: join(d, 'istunnot'), projektitDir: join(d, 'projektit'), tila: join(d, 'tila'), istunnonTranskripti: null };
  mkdirSync(join(k.juuri, 'claude/siirto/state'), { recursive: true });
  mkdirSync(k.istunnotDir);
  mkdirSync(k.projektitDir);
  const pid = String(process.pid);
  k.ymp2 = JSON.parse(JSON.stringify(ymparisto).replaceAll('"<PID>"', pid).replaceAll('<PID>', pid));
  writeFileSync(join(k.juuri, 'claude/siirto/state/skoopit.json'), JSON.stringify(k.ymp2.skooppitiedot));
  for (const i of k.ymp2.istunnot) writeFileSync(join(k.istunnotDir, i.tiedosto), JSON.stringify(i.sisalto));
  for (const t of k.ymp2.transkriptit) {
    const dir = join(k.projektitDir, projektiNimi(t.kohde === 'chat' ? k.chatDir : t.cwd));
    mkdirSync(dir, { recursive: true });
    kirjoitaJsonl(join(dir, `${t.id}.jsonl`), t.rivit);
    if (t.kohde === 'istunto') k.istunnonTranskripti = join(dir, `${t.id}.jsonl`);
  }
  return k;
}

// Tallentava aja-väärennös (tmux-mockin vastaukset fixturen ymparisto.tmux:stä; ei oikeaa tmux:ia). `tmux list-panes` vastataan mutta ei kirjata.
export function luoMockAja(ymp2, istunnonTranskripti, ctx) {
  const tulos = (t = {}) => ({ koodi: t.koodi ?? 0, stdout: t.stdout ?? '', stderr: t.stderr ?? '' });
  return async (komento, argv, valinnat = {}) => {
    if (!(komento === 'tmux' && argv[0] === 'list-panes')) ctx.kutsut.push({ kutsu: [komento, ...argv], valinnat: { ...(valinnat.syote ? { syote: valinnat.syote } : {}), ...(valinnat.cwd ? { cwd: valinnat.cwd } : {}) } });
    const tm = ymp2.tmux;
    if (komento === 'tmux') {
      if (argv[0] === 'send-keys' && tm.vastaanottaa && istunnonTranskripti) {
        const k = argv.slice(argv.indexOf('-t') + 2);
        if (k[0] === 'C-u') ctx.kentta = '';
        else if (k[0] === '-l') ctx.kentta += k[1];
        else if (k[0] === 'Enter' && ctx.kentta) { appendFileSync(istunnonTranskripti, `\n${JSON.stringify({ type: 'user', message: { content: ctx.kentta } })}`); ctx.kentta = ''; }
      }
      return tulos({ stdout: tm[argv[0]] ?? '' });
    }
    if (komento === 'bash' && argv[0].endsWith('autovaihto.sh')) {
      if (ctx.pito && !ctx.pito.otettu) { ctx.pito.otettu = true; ctx.pito.saavutettu(); await ctx.pito.esto; }
      return tulos(ymp2.komennot.autovaihto ?? { stdout: 'UUSI: …\nOK: https://claude.ai/code/session_abc123\n' });
    }
    if (komento === 'node' && argv[0].endsWith('pura-malliton.mjs')) {
      return tulos(ymp2.komennot[argv[1] === '--perhe' ? 'pura-malliton --perhe' : 'pura-malliton'] ?? { koodi: 1 });
    }
    if (komento === 'claude') {
      const c = ymp2.komennot.claude ?? { koodi: 1, stderr: 'ei vastausta' };
      for (const r of c.stdout ?? []) valinnat.riville?.(r);
      return tulos({ ...c, stdout: (c.stdout ?? []).map((r) => `${r}\n`).join('') });
    }
    throw new Error(`testiapurit: odottamaton komento ${komento} ${argv.join(' ')}`);
  };
}

export function pyyda(portti, { metodi, polku, runko }) {
  return new Promise((ok, ei) => {
    const data = runko == null ? null : JSON.stringify(runko);
    const r = httpRequest({ host: '127.0.0.1', port: portti, method: metodi, path: polku, headers: {
      authorization: `Bearer ${AVAIN}`, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (p) => { t += p; });
      res.on('end', () => ok({ status: res.statusCode, tyyppi: String(res.headers['content-type'] ?? ''), teksti: t }));
    });
    r.on('error', ei);
    r.end(data ?? undefined);
  });
}

// Koko replay. reitit = palveltavat reitit; koukut = palvelimen moduulikoukut ([{ nimi, kaynnista }], oletus ei yhtään; kaynnista
// saa saman lisaYmp-täydennetyn ymp:n kuin reitit); lisaYmp = ymp-lisät (oletus: odota kirjaa viiveet ≥ 100 ms eikä odota oikeasti;
// kello etenee odotettujen millisekuntien verran, joten raja-ajat toimivat ilman oikeaa odotusta).
export async function ajaFixture(fix, { reitit, koukut = [], lisaYmp = {}, oikeaOdotus = false } = {}) {
  const k = kokoaYmparisto(fix.ymparisto);
  const ctx = { kutsut: [], pito: null, kentta: '', loki: [] };
  const viiveet = [];
  let kelloMs = Date.parse('2026-10-21T09:00:00.000Z');
  const odota = async (ms) => { if (ms >= 100) viiveet.push(ms); kelloMs += ms; };
  const lisa = { istunnotDir: k.istunnotDir, projektitDir: k.projektitDir, ...(oikeaOdotus ? {} : { odota }), ...lisaYmp };
  const omat = reitit.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { ...ymp, ...lisa }) }));
  const omatKoukut = koukut.map((q) => ({ ...q, kaynnista: (ymp) => q.kaynnista({ ...ymp, ...lisa }) }));
  const palvelin = luoToimintopalvelin({
    portti: 0, reitit: omat, koukut: omatKoukut, avainTiedosto, juuri: k.juuri, tila: k.tila,
    aja: luoMockAja(k.ymp2, k.istunnonTranskripti, ctx), kello: () => kelloMs, loki: (rivi) => ctx.loki.push({ aika: new Date(kelloMs).toISOString(), ...rivi }),
  });
  const portti = await palvelin.kuuntele();
  try {
    let pito = null;
    let kesken = null;
    if (k.ymp2.samanaikainen) {
      let vapauta;
      let saavutettu;
      const saavutettuLupaus = new Promise((ok) => { saavutettu = ok; });
      pito = ctx.pito = { esto: new Promise((ok) => { vapauta = ok; }), saavutettu, otettu: false };
      kesken = pyyda(portti, k.ymp2.samanaikainen);
      await saavutettuLupaus;
      ctx.kutsut.length = 0; // odotus kattaa vain varsinaisen pyynnön komennot
      viiveet.length = 0;
      pito.vapauta = vapauta;
    }
    const vastaus = await pyyda(portti, fix.pyynto);
    if (pito) { pito.vapauta(); await kesken; }
    const korvaukset = [[k.juuri, '<JUURI>'], [k.chatDir, '<CHAT>'], [KOTI, '<KOTI>'], [TMP, '<TMP>']];
    const norm = (x) => syvaKartta(x, (s) => korvaukset.reduce((t, [a, b]) => t.replaceAll(a, b), s));
    const havainto = { status: vastaus.status };
    if (vastaus.tyyppi.includes('ndjson')) havainto.ndjson = vastaus.teksti.split('\n').filter(Boolean).map((r) => JSON.parse(r));
    else havainto.runko = JSON.parse(vastaus.teksti);
    havainto.aja = ctx.kutsut.map((c) => c.kutsu);
    if (ctx.kutsut.some((c) => Object.keys(c.valinnat).length)) havainto.ajaValinnat = ctx.kutsut.map((c) => c.valinnat);
    if (viiveet.length) havainto.viiveet = [...viiveet];
    return { havainto: norm(havainto), loki: ctx.loki, kello: kelloMs, k };
  } finally {
    await palvelin.sulje();
    rmSync(k.d, { recursive: true, force: true });
  }
}

export function vertaaFixtureen(fix, havainto) {
  const o = fix.odotus;
  assert.equal(havainto.status, o.status, `${fix.tapaus}: status`);
  if ('ndjson' in o) assert.deepEqual(havainto.ndjson, o.ndjson, `${fix.tapaus}: NDJSON-rivit`);
  else assert.deepEqual(havainto.runko, o.runko, `${fix.tapaus}: runko`);
  assert.deepEqual(havainto.aja, o.aja, `${fix.tapaus}: tmux-/ssh-argv-jono`);
  assert.deepEqual(havainto.ajaValinnat, o.ajaValinnat, `${fix.tapaus}: ajaValinnat`);
  assert.deepEqual(havainto.viiveet, o.viiveet, `${fix.tapaus}: viiveet`);
}

// T-69: pitkäkestoisen NDJSON-vastauksen lukija. pyyda() odottaa koko vastauksen loppua; tämä palauttaa heti otsakkeiden jälkeen, ja
// seuraava() antaa seuraavan NDJSON-rivin (olion) heti kun se on saapunut tai null, kun vastaus on päättynyt tai katkaistu.
// sulje() katkaisee yhteyden asiakkaan puolelta (puhelimen näyttölukko). Virhe ennen otsakkeita hylkää lupauksen.
export function avaaVirta(portti, { metodi, polku, runko }) {
  return new Promise((ok, ei) => {
    const data = runko == null ? null : JSON.stringify(runko);
    const r = httpRequest({ host: '127.0.0.1', port: portti, method: metodi, path: polku, headers: {
      authorization: `Bearer ${AVAIN}`, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const jono = [];
      let kesken = '';
      let loppu = false;
      let odottaja = null;
      const herata = () => { if (odottaja && (jono.length || loppu)) { const f = odottaja; odottaja = null; f(); } };
      res.setEncoding('utf8');
      res.on('data', (pala) => {
        const rivit = (kesken + pala).split('\n');
        kesken = rivit.pop();
        for (const rivi of rivit) if (rivi) jono.push(JSON.parse(rivi));
        herata();
      });
      res.on('error', () => {});
      res.on('close', () => { loppu = true; herata(); });
      const seuraava = async () => {
        if (!jono.length && !loppu) await new Promise((o) => { odottaja = o; });
        return jono.shift() ?? null;
      };
      const kaikki = async () => { const tulos = []; for (let x = await seuraava(); x; x = await seuraava()) tulos.push(x); return tulos; };
      ok({ status: res.statusCode, tyyppi: String(res.headers['content-type'] ?? ''), seuraava, kaikki, sulje: () => { res.destroy(); r.destroy(); } });
    });
    r.on('error', (e) => ei(e));
    r.end(data ?? undefined);
  });
}
