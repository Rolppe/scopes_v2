#!/usr/bin/env node
// Mock-ydin web-asiakkaan testeihin (T-38-G): toteuttaa asiakkaan käyttämän API-pinnan (S-1, S-4, S-6, S-7) ytimen
// fixtureista (scopes2/ydin/tests/fixture/, luetaan, ei kopioida). Ei riippuvuuksia.
//   node test/mock-ydin.mjs --portti <n> [--dist <hakemisto>] [--rooli ydin|vanha] [--ka <ms>]
// Tila on muistissa. Muutosloki alkaa seq:stä 10 (lokin alku 10): since < 10 → nollaus, since >= 10 jatkaa lokista.
import { createServer } from 'node:http';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: arg } = parseArgs({
  options: {
    portti: { type: 'string' },
    dist: { type: 'string' },
    rooli: { type: 'string', default: 'ydin' },
    ka: { type: 'string', default: '20000' },
  },
});
const portti = Number(arg.portti);
const ydin = arg.rooli !== 'vanha';
const KA_MS = Number(arg.ka);
if (!Number.isInteger(portti) || portti < 1 || portti > 65535) {
  console.error('käyttö: node test/mock-ydin.mjs --portti <n> [--dist <hakemisto>] [--rooli ydin|vanha] [--ka <ms>]');
  process.exit(2);
}
if (arg.rooli !== 'ydin' && arg.rooli !== 'vanha') {
  console.error('--rooli: ydin tai vanha');
  process.exit(2);
}
const AVAIN = 'testiavain';
const FIX = join(dirname(fileURLToPath(import.meta.url)), '../../ydin/tests/fixture');
const distHak = arg.dist ? resolve(arg.dist) : null;

// ---- fixturet -------------------------------------------------------------------------------------------------
const luePath = (nimi) => join(FIX, nimi);
const lueJson = (nimi) => JSON.parse(readFileSync(luePath(nimi), 'utf8'));
const skoopit = lueJson('skoopit.json');
const agentit = lueJson('agentit.json');
const rekisterit = lueJson('rekisterit.json');
const skoopinNimet = new Set(skoopit.map((s) => s.nimi));
const REK_TIEDOSTO = { 'test/REKISTERI.md': 'rekisteri-test.md', 'scopes/macos/REKISTERI.md': 'rekisteri-jaettu.md' };

function skooppiTiedot(nimi) {
  const f = `skooppi-${nimi}.json`;
  if (existsSync(luePath(f))) return lueJson(f);
  return { nimi, rekisterit: [], seuraava: null, avoimet: [], viat: [], istunnot: [] };
}

// Viestit muistissa: id = "<istunto>:<rivinro>" (S-6).
const viestitMuisti = new Map();
function viestit(nimi) {
  let v = viestitMuisti.get(nimi);
  if (!v) {
    const f = `viestit-${nimi}.json`;
    const pohja = existsSync(luePath(f)) ? lueJson(f) : { nimi, auki: false, istunto: null, voiLahettaa: false, viestit: [] };
    const tunnus = pohja.istunto ?? nimi;
    v = { ...pohja, viestit: pohja.viestit.map((m, i) => ({ id: `${tunnus}:${i + 1}`, ...m })) };
    viestitMuisti.set(nimi, v);
  }
  return v;
}

function rekisteriOsat(polku) {
  const tied = REK_TIEDOSTO[polku];
  const teksti = tied ? readFileSync(luePath(tied), 'utf8') : '';
  const osat = [];
  let nyt = { otsikko: null, teksti: '' };
  for (const rivi of teksti.split('\n')) {
    if (rivi.startsWith('## ')) {
      osat.push(nyt);
      nyt = { otsikko: rivi.slice(3).trim(), teksti: '' };
    } else nyt.teksti += rivi + '\n';
  }
  osat.push(nyt);
  return osat.filter((o) => o.otsikko !== null || o.teksti.trim() !== '');
}

// ---- muutosloki ja virta (S-1) --------------------------------------------------------------------------------
const LOKIN_ALKU = 10;
let seq = LOKIN_ALKU;
const loki = []; // {seq, polku, id, versio, aika, poistettu}
const virrat = new Set(); // avoimet /api/virta-vastaukset
const chatVirrat = new Set(); // avoimet chat-virta- ja kaynnissa-vastaukset
let hlcLaskuri = 0;
const hlc = () => `${new Date().toISOString()}-${String(++hlcLaskuri % 10000).padStart(4, '0')}-mock`;

function kirjaaTapahtuma(polku, id, poistettu = false) {
  const t = { seq: ++seq, polku, id, versio: { mock: seq }, aika: new Date().toISOString(), poistettu };
  loki.push(t);
  const { poistettu: _p, ...ulos } = t;
  for (const res of virrat) res.write(`id: ${t.seq}\nevent: muutos\ndata: ${JSON.stringify(ulos)}\n\n`);
  return t;
}

function virtaa(req, res, url) {
  const otsikosta = req.headers['last-event-id'];
  const raaka = otsikosta !== undefined && otsikosta !== '' ? otsikosta : url.searchParams.get('since');
  const since = raaka !== null && raaka !== undefined && /^\d+$/.test(raaka) ? Number(raaka) : null;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    'x-lahde': 'ydin',
  });
  res.flushHeaders();
  if (since !== null && since < LOKIN_ALKU) {
    res.write(`event: nollaus\ndata: ${JSON.stringify({ seq })}\n\n`);
  } else if (since !== null) {
    for (const t of loki) {
      if (t.seq <= since) continue;
      const { poistettu: _p, ...ulos } = t;
      res.write(`id: ${t.seq}\nevent: muutos\ndata: ${JSON.stringify(ulos)}\n\n`);
    }
  }
  virrat.add(res);
  const ajastin = setInterval(() => res.write(': ka\n\n'), KA_MS);
  res.on('close', () => { clearInterval(ajastin); virrat.delete(res); });
}

// ?since=<seq> → {seq, muuttuneet, poistetut[, nollaus]} (S-6); muuten koko lista.
function lista(url, polku, kaikki, idDe, rajaa = () => true) {
  const raaka = url.searchParams.get('since');
  if (raaka === null || !/^\d+$/.test(raaka)) return kaikki;
  const since = Number(raaka);
  if (since < LOKIN_ALKU) return { seq, muuttuneet: kaikki, poistetut: [], nollaus: true };
  const viimeisin = new Map();
  for (const t of loki) if (t.seq > since && t.polku === polku) viimeisin.set(t.id, t.poistettu);
  const poistetut = [...viimeisin].filter(([, p]) => p).map(([id]) => id);
  const muuttuneet = kaikki.filter((x) => viimeisin.get(idDe(x)) === false && rajaa(x));
  return { seq, muuttuneet, poistetut };
}

// ---- tila (S-4), asetukset, kirjatut --------------------------------------------------------------------------
const tilat = new Map(); // avain → {arvo, aika, laite}
const kirjatut = { viestit: [], chatit: [], tilat: [] };
const asetukset = { automaattijatko: false, autopack: false };

// ---- chat -----------------------------------------------------------------------------------------------------
const NDJSON = { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' };
const LOPPUTULOS_MS = 10 * 60_000;
const PALAVALI_MS = 300;
let ajo = null; // {teksti, kuuntelijat:Set<res>, loppu, ajastimet:[], aika}
const keskustelut = []; // {id, agentti, aika, viestit:[{rooli, teksti}]}
const kirjoitaRiviin = (res, o) => { if (!res.destroyed) res.write(JSON.stringify(o) + '\n'); };

function aloitaChat(res, pyynto) {
  const keskustelu = typeof pyynto.keskustelu === 'string' && pyynto.keskustelu ? pyynto.keskustelu : 'k-1';
  const palat = ['Mock ', 'vastaa: ', pyynto.viesti];
  const oma = (ajo = { teksti: '', kuuntelijat: new Set([res]), loppu: null, ajastimet: [], aika: Date.now(), keskustelu });
  chatVirrat.add(res);
  res.on('close', () => { oma.kuuntelijat.delete(res); chatVirrat.delete(res); });
  res.writeHead(200, NDJSON);
  res.flushHeaders();
  kirjatut.chatit.push({ agentti: pyynto.agentti, viesti: pyynto.viesti, keskustelu });
  const lopeta = (loppu) => {
    if (oma.loppu) return;
    oma.loppu = loppu;
    for (const t of oma.ajastimet) clearTimeout(t);
    for (const r of oma.kuuntelijat) { kirjoitaRiviin(r, loppu); r.end(); }
    oma.kuuntelijat.clear();
    if (loppu.tyyppi === 'valmis') {
      let k = keskustelut.find((x) => x.id === keskustelu);
      if (!k) keskustelut.unshift((k = { id: keskustelu, agentti: pyynto.agentti, aika: new Date().toISOString(), viestit: [] }));
      k.viestit.push({ rooli: 'kayttaja', teksti: pyynto.viesti }, { rooli: 'agentti', teksti: loppu.vastaus });
    }
    oma.ajastimet.push(setTimeout(() => { if (ajo === oma) ajo = null; }, LOPPUTULOS_MS).unref());
  };
  oma.lopeta = lopeta;
  palat.forEach((teksti, i) => {
    oma.ajastimet.push(setTimeout(() => {
      oma.teksti += teksti;
      for (const r of oma.kuuntelijat) kirjoitaRiviin(r, { tyyppi: 'pala', teksti });
      if (i === palat.length - 1) lopeta({ tyyppi: 'valmis', vastaus: oma.teksti, keskustelu });
    }, (i + 1) * PALAVALI_MS));
  });
}

function liityChattiin(res) {
  res.writeHead(200, NDJSON);
  res.flushHeaders();
  if (ajo.teksti) kirjoitaRiviin(res, { tyyppi: 'pala', teksti: ajo.teksti });
  if (ajo.loppu) { kirjoitaRiviin(res, ajo.loppu); res.end(); return; }
  ajo.kuuntelijat.add(res);
  chatVirrat.add(res);
  const oma = ajo;
  res.on('close', () => { oma.kuuntelijat.delete(res); chatVirrat.delete(res); });
}

// ---- HTTP-apu -------------------------------------------------------------------------------------------------
function jsonVastaus(res, koodi, olio, lisa = {}) {
  const runko = JSON.stringify(olio);
  res.writeHead(koodi, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(runko),
    ...(ydin ? { 'x-lahde': 'ydin' } : {}),
    ...lisa,
  });
  res.end(runko);
}
const eiLoydy = (res) => jsonVastaus(res, 404, { virhe: 'tuntematon polku' });

function lueRunko(req) {
  return new Promise((ok, virhe) => {
    const osat = [];
    let koko = 0;
    req.on('data', (d) => {
      koko += d.length;
      if (koko > 1_000_000) { virhe(new Error('runko liian suuri')); req.destroy(); } else osat.push(d);
    });
    req.on('end', () => ok(Buffer.concat(osat).toString('utf8')));
    req.on('error', virhe);
  });
}

async function lueJsonRunko(req, res) {
  let teksti;
  try { teksti = await lueRunko(req); } catch { jsonVastaus(res, 413, { virhe: 'runko liian suuri' }); return undefined; }
  if (teksti.trim() === '') return {};
  try {
    const o = JSON.parse(teksti);
    if (o !== null && typeof o === 'object') return o;
  } catch { /* alla */ }
  jsonVastaus(res, 400, { virhe: 'virheellinen JSON' });
  return undefined;
}

function paikallinen(req) {
  return ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress ?? '');
}

// ---- /web/* (S-7) ---------------------------------------------------------------------------------------------
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const TYYPIT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
};
const EI_VALIMUISTIA = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);

function tarjoaWeb(req, res, polku) {
  if (!distHak) return eiLoydy(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8', 'x-lahde': 'ydin' });
    res.end(JSON.stringify({ virhe: 'metodi ei sallittu' }));
    return;
  }
  let suhde;
  try { suhde = decodeURIComponent(polku.slice('/web/'.length)); } catch { return eiLoydy(res); }
  if (suhde === '') suhde = 'index.html';
  if (suhde.includes('..') || suhde.includes('\0') || suhde.startsWith('/') || suhde.includes('\\')) return eiLoydy(res);
  const tyyppi = TYYPIT[extname(suhde)];
  if (!tyyppi) return eiLoydy(res);
  let tiedosto;
  try {
    const juuri = realpathSync(distHak);
    tiedosto = realpathSync(join(juuri, suhde));
    if (!tiedosto.startsWith(juuri + sep) || !statSync(tiedosto).isFile()) return eiLoydy(res);
  } catch { return eiLoydy(res); }
  const runko = readFileSync(tiedosto);
  res.writeHead(200, {
    'content-type': tyyppi,
    'content-length': runko.length,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-lahde': 'ydin',
    'cache-control': EI_VALIMUISTIA.has(suhde) ? 'no-cache' : 'max-age=300',
  });
  res.end(req.method === 'HEAD' ? undefined : runko);
}

// ---- reititys -------------------------------------------------------------------------------------------------
async function kasittele(req, res) {
  const url = new URL(req.url ?? '/', 'http://mock');
  const polku = url.pathname;
  const metodi = req.method ?? 'GET';

  if (polku.startsWith('/__testi/')) return testiohjaus(req, res, polku, metodi);

  if (ydin && polku === '/') {
    if (metodi !== 'GET' && metodi !== 'HEAD') return eiLoydy(res);
    res.writeHead(302, { location: '/web/', 'x-lahde': 'ydin' });
    return res.end();
  }
  if (ydin && (polku === '/web' || polku.startsWith('/web/'))) {
    if (polku === '/web') { res.writeHead(302, { location: '/web/', 'x-lahde': 'ydin' }); return res.end(); }
    return tarjoaWeb(req, res, polku);
  }

  if (!polku.startsWith('/api/')) return eiLoydy(res);
  if (polku === '/api/terveys') return jsonVastaus(res, 200, ydin ? { ok: true, v2: true, seq } : { ok: true });

  const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!auth || (ydin && auth[1] !== AVAIN)) return jsonVastaus(res, 401, { virhe: 'avain puuttuu tai on väärä' });

  const osat = polku.split('/').slice(2).map((o) => { try { return decodeURIComponent(o); } catch { return o; } });
  const [a, b, c] = osat;

  if (ydin && a === 'virta' && osat.length === 1 && metodi === 'GET') return virtaa(req, res, url);

  if (ydin && a === 'tila') {
    if (osat.length === 1 && metodi === 'GET') {
      const etuliite = url.searchParams.get('etuliite') ?? '';
      const lista_ = [...tilat].filter(([k]) => k.startsWith(etuliite)).map(([avain, t]) => ({ avain, ...t }));
      return jsonVastaus(res, 200, { tilat: lista_ });
    }
    const avain = polku.slice('/api/tila/'.length).split('/').map((o) => decodeURIComponent(o)).join('/');
    if (osat.length >= 2 && metodi === 'GET') {
      const t = tilat.get(avain);
      return t ? jsonVastaus(res, 200, { avain, ...t }) : jsonVastaus(res, 404, { virhe: 'avainta ei ole' });
    }
    if (osat.length >= 2 && metodi === 'PUT') {
      const o = await lueJsonRunko(req, res);
      if (o === undefined) return;
      if (!('arvo' in o)) return jsonVastaus(res, 400, { virhe: 'arvo puuttuu' });
      const edellinen = tilat.get(avain);
      if (avain.startsWith('kuittaus/')) {
        if (!Number.isInteger(o.arvo)) return jsonVastaus(res, 400, { virhe: 'arvon on oltava kokonaisluku' });
        if (edellinen && edellinen.arvo >= o.arvo) return jsonVastaus(res, 200, { aika: edellinen.aika });
      }
      const aika = hlc();
      tilat.set(avain, { arvo: o.arvo, aika, laite: 'mock' });
      kirjatut.tilat.push({ avain, arvo: o.arvo });
      kirjaaTapahtuma('tila', avain);
      return jsonVastaus(res, 200, { aika });
    }
    return eiLoydy(res);
  }

  if (a === 'terveys') return eiLoydy(res);

  if (a === 'skoopit') {
    if (osat.length === 1 && metodi === 'GET') {
      return jsonVastaus(res, 200, ydin ? lista(url, 'skoopit', skoopit, (s) => s.nimi) : skoopit);
    }
    if (!skoopinNimet.has(b ?? '')) {
      return osat.length >= 2 && (metodi === 'GET' || metodi === 'POST') ? jsonVastaus(res, 404, { virhe: `tuntematon skooppi: ${b}` }) : eiLoydy(res);
    }
    if (osat.length === 2 && metodi === 'GET') return jsonVastaus(res, 200, skooppiTiedot(b));
    if (c === 'viestit' && osat.length === 3 && metodi === 'GET') {
      const v = viestit(b);
      if (!ydin || url.searchParams.get('since') === null) return jsonVastaus(res, 200, v);
      const l = lista(url, 'viestit', v.viestit, (m) => m.id);
      return jsonVastaus(res, 200, Array.isArray(l) ? v : l);
    }
    if (c === 'viesti' && osat.length === 3 && metodi === 'POST') {
      const o = await lueJsonRunko(req, res);
      if (o === undefined) return;
      if (typeof o.teksti !== 'string' || o.teksti === '') return jsonVastaus(res, 400, { virhe: 'teksti puuttuu' });
      kirjatut.viestit.push({ skooppi: b, teksti: o.teksti });
      return jsonVastaus(res, 200, { ok: true });
    }
    if (c === 'asetukset') {
      if (osat.length === 3 && metodi === 'GET') return jsonVastaus(res, 200, { istunto: null, istuntoja: 0, ...asetukset });
      if (osat.length === 5 && metodi === 'POST' && osat[3] in asetukset && (osat[4] === 'paalle' || osat[4] === 'pois')) {
        asetukset[osat[3]] = osat[4] === 'paalle';
        return jsonVastaus(res, 200, { istunto: null, istuntoja: 0, ...asetukset });
      }
    }
    return eiLoydy(res);
  }

  if (a === 'agentit' && osat.length === 1 && metodi === 'GET') {
    return jsonVastaus(res, 200, ydin ? lista(url, 'agentit', agentit, (x) => x.nimi) : agentit);
  }

  if (a === 'chat') {
    if (b === 'virta' && osat.length === 2 && metodi === 'POST') {
      const o = await lueJsonRunko(req, res);
      if (o === undefined) return;
      if (typeof o.agentti !== 'string' || typeof o.viesti !== 'string' || o.viesti === '') return jsonVastaus(res, 400, { virhe: 'agentti ja viesti vaaditaan' });
      if (ajo && !ajo.loppu) return jsonVastaus(res, 409, { virhe: 'ajo on käynnissä' });
      return aloitaChat(res, o);
    }
    if (b === 'kaynnissa' && osat.length === 2 && metodi === 'GET') {
      return ajo ? liityChattiin(res) : jsonVastaus(res, 404, { virhe: 'ei käynnissä olevaa ajoa' });
    }
    if (b === 'stop' && osat.length === 2 && metodi === 'POST') {
      const kaynnissa = !!ajo && !ajo.loppu;
      if (kaynnissa) ajo.lopeta({ tyyppi: 'valmis', vastaus: ajo.teksti, keskustelu: ajo.keskustelu, pysaytetty: true });
      return jsonVastaus(res, 200, { ok: true, pysaytetty: kaynnissa });
    }
    if (b === 'keskustelut' && osat.length === 1 + 1 && metodi === 'GET') {
      return jsonVastaus(res, 200, keskustelut.map(({ id, agentti, aika }) => ({ id, agentti, aika })));
    }
    if (b === 'keskustelut' && osat.length === 3 && metodi === 'GET') {
      const k = keskustelut.find((x) => x.id === c);
      return k ? jsonVastaus(res, 200, k) : jsonVastaus(res, 404, { virhe: 'keskustelua ei ole' });
    }
    return eiLoydy(res);
  }

  if (a === 'rekisterit' && metodi === 'GET') {
    if (osat.length === 1) return jsonVastaus(res, 200, ydin ? lista(url, 'rekisterit', rekisterit, (r) => r.polku) : rekisterit);
    const rp = osat.slice(1).join('/');
    if (!rekisterit.some((r) => r.polku === rp)) return jsonVastaus(res, 404, { virhe: 'tuntematon rekisteri' });
    return jsonVastaus(res, 200, { polku: rp, osat: rekisteriOsat(rp) });
  }

  if (a === 'lr' && b === 'ristiriidat' && osat.length === 2 && metodi === 'GET') return jsonVastaus(res, 200, []);

  if (a === 'asetukset') {
    if (osat.length === 1 && metodi === 'GET') return jsonVastaus(res, 200, { ...asetukset });
    if (osat.length === 3 && metodi === 'POST' && b in asetukset && (c === 'paalle' || c === 'pois')) {
      asetukset[b] = c === 'paalle';
      return jsonVastaus(res, 200, { ...asetukset });
    }
  }

  return eiLoydy(res);
}

// Testiohjaus ilman avainta, vain 127.0.0.1:stä.
async function testiohjaus(req, res, polku, metodi) {
  if (!paikallinen(req)) return eiLoydy(res);
  if (polku === '/__testi/tapahtuma' && metodi === 'POST') {
    const o = await lueJsonRunko(req, res);
    if (o === undefined) return;
    if (typeof o.polku !== 'string' || typeof o.id !== 'string') return jsonVastaus(res, 400, { virhe: 'polku ja id vaaditaan' });
    // Lisäkenttä viesti + skooppi lisää viestin skoopin viestilistaan ennen tapahtumaa.
    if (o.polku === 'viestit' && typeof o.skooppi === 'string' && o.viesti && typeof o.viesti === 'object' && skoopinNimet.has(o.skooppi)) {
      viestit(o.skooppi).viestit.push({ id: o.id, ...o.viesti });
    }
    const t = kirjaaTapahtuma(o.polku, o.id, o.poistettu === true);
    return jsonVastaus(res, 200, { seq: t.seq });
  }
  if (polku === '/__testi/kirjatut' && metodi === 'GET') return jsonVastaus(res, 200, kirjatut);
  if (polku === '/__testi/katko' && metodi === 'POST') {
    for (const r of [...virrat, ...chatVirrat]) r.destroy();
    return jsonVastaus(res, 200, { ok: true });
  }
  return eiLoydy(res);
}

const palvelin = createServer((req, res) => {
  kasittele(req, res).catch((e) => {
    console.error('MOCK: ' + (e instanceof Error ? e.stack : String(e)));
    if (!res.headersSent) jsonVastaus(res, 500, { virhe: 'sisäinen virhe' });
    else res.destroy();
  });
});
palvelin.listen(portti, '127.0.0.1', () => console.log(`MOCK: ${arg.rooli} 127.0.0.1:${portti}`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { for (const r of [...virrat, ...chatVirrat]) r.destroy(); palvelin.close(); process.exit(0); });
