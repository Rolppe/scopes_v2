#!/usr/bin/env node
// T-88 kohta (6) (ARK-19): välittäjä koeytimen ja koeadapterin väliin. Korvaa gate.sh t87:n mock-ohjaus.mjs:n (GATE_OHJAUS_MOCK), mutta välittää
// toimintoreitit oikealle koeadapterille (ssh-tunneli, kuivatila, oma tilahakemisto): ruutu, tuotokset, tuotos, POST /api/android/* ja palvelin.
// Muu (GET /api/android = lähdetila, skoopit/rekisterit vanhan 8787:n tilalla, terveys, siemennys) vastaa kuten mock-ohjaus.mjs, jonka luoMock-tehdasta käytetään.
// 8787:ää ei käytetä: --vanha osoittaa tähän. Testiohjaus (koe-loki, koe-nollaa) kuten mockissa, jotta OhjausUITests toimivat muuttamatta.
//   node t88-valitys.mjs --avain-tiedosto F --ylavirta URL --ylavirta-avain F [--portti 0] [--portti-tiedosto F] [--ydin URL] [--elinkaari F] [--todiste F]
// palvelin: onnistuneen sammutuksen jälkeen GET /api/palvelin vastaa "sammuksissa" koe-nollaa:an asti (kuiva-adapterin ping ei muutu, mockin käytös).
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { luoMock } from '../../shared/testit/mock-ohjaus.mjs';

function argumentit(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return a;
}

const a = argumentit(process.argv.slice(2));
for (const k of ['avain-tiedosto', 'ylavirta', 'ylavirta-avain']) if (!a[k]) { console.error(`käyttö: t88-valitys.mjs --avain-tiedosto F --ylavirta URL --ylavirta-avain F … (puuttuu --${k})`); process.exit(2); }
const lue = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const mock = luoMock({ avainTiedosto: a['avain-tiedosto'] });
let loki = [];
let ruutuHaut = 0;
let linuxSammutettu = false;

const json = (res, status, kohde) => {
  const data = Buffer.from(JSON.stringify(kohde));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
  res.end(data);
};
const runko = async (req) => {
  const palat = [];
  let koko = 0;
  for await (const p of req) { koko += p.length; if (koko > 8 << 20) break; palat.push(p); }
  return Buffer.concat(palat);
};
const jasenna = (data) => {
  if (!data.length) return null;
  try { return JSON.parse(data.toString('utf8')); } catch { return data.toString('utf8'); }
};

const valitetaan = (metodi, p) =>
  (metodi === 'GET' && ['/api/android/ruutu', '/api/android/tuotokset', '/api/android/tuotos'].includes(p))
  || (metodi === 'POST' && /^\/api\/android\/(?!koe-)[^/]+$/.test(p))
  || p === '/api/palvelin' || /^\/api\/palvelin\/[^/]+$/.test(p);

const palvelin = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const testiohjaus = p === '/api/android/koe-loki' || p === '/api/android/koe-nollaa';
    if (!testiohjaus && !valitetaan(req.method, p)) return mock.palvelin.emit('request', req, res);
    const avain = lue(a['avain-tiedosto']);
    if (!avain || req.headers.authorization !== `Bearer ${avain}`) return json(res, 401, { virhe: 'avain puuttuu tai väärä' });
    if (req.method === 'GET' && p === '/api/android/koe-loki') return json(res, 200, { pyynnot: loki, ruutuHaut });
    if (req.method === 'POST' && p === '/api/android/koe-nollaa') {
      await runko(req);
      loki = []; ruutuHaut = 0; linuxSammutettu = false;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/palvelin' && linuxSammutettu) return json(res, 200, { tila: 'sammuksissa' });

    const data = req.method === 'POST' ? await runko(req) : Buffer.alloc(0);
    if (req.method === 'GET' && p === '/api/android/ruutu') ruutuHaut++;
    if (req.method === 'POST' || p === '/api/android/tuotos') loki.push({ aika: new Date().toISOString(), metodi: req.method, polku: p + url.search, runko: req.method === 'POST' ? jasenna(data) : null });
    if (loki.length > 500) loki.shift();

    const otsakkeet = { authorization: `Bearer ${lue(a['ylavirta-avain'])}` };
    if (req.headers['content-type']) otsakkeet['content-type'] = req.headers['content-type'];
    let ylos;
    try {
      ylos = await fetch(a.ylavirta + req.url, { method: req.method, headers: otsakkeet, body: req.method === 'POST' ? data : undefined, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      return json(res, 502, { virhe: `koeadapteri ei vastaa: ${e.message}` });
    }
    const tavut = Buffer.from(await ylos.arrayBuffer());
    if (req.method === 'POST' && /^\/api\/palvelin\/sammuta$/.test(p) && ylos.status === 200) linuxSammutettu = true;
    if (a.todiste) appendFileSync(a.todiste, `${JSON.stringify({ aika: new Date().toISOString(), metodi: req.method, polku: p + url.search, status: ylos.status, tyyppi: ylos.headers.get('content-type'), tavua: tavut.length, lahde: ylos.headers.get('x-lahde'), alku: ylos.headers.get('content-type')?.startsWith('application/json') ? tavut.toString('utf8').slice(0, 300) : undefined })}\n`);
    res.writeHead(ylos.status, { 'Content-Type': ylos.headers.get('content-type') ?? 'application/json', 'Content-Length': tavut.length });
    res.end(tavut);
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    json(res, 500, { virhe: String(e.message ?? e) });
  }
});

await new Promise((ok, virhe) => { palvelin.once('error', virhe); palvelin.listen(Number(a.portti ?? 0), '127.0.0.1', ok); });
const portti = palvelin.address().port;
if (a['portti-tiedosto']) writeFileSync(a['portti-tiedosto'], `${portti}\n`);
console.log(`T-88-VALITYS: portti ${portti} → ${a.ylavirta}`);

const sulje = () => { palvelin.close(); process.exit(0); };
process.on('SIGTERM', sulje);
process.on('SIGINT', sulje);
if (a.elinkaari) setInterval(() => { if (!existsSync(a.elinkaari)) sulje(); }, 2000).unref?.();

if (a.ydin) {
  // Lähdetila koeytimeen kuten mock-ohjaus.mjs (GET /api/android on ytimen lähdetilasta, T-84).
  const siemenna = async () => (await fetch(`${a.ydin}/api/lahde/android`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${lue(a['avain-tiedosto'])}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ laite: 'koe-ohjaus', sisalto: mock.sisalto() }),
    signal: AbortSignal.timeout(5000),
  })).ok;
  let onnistui = false;
  for (let i = 0; i < 90 && !onnistui; i++) {
    try { onnistui = await siemenna(); } catch { /* ydin ei vastaa vielä */ }
    if (!onnistui) await new Promise((v) => setTimeout(v, 1000));
  }
  console.log(onnistui ? 'T-88-VALITYS: lähdetila android siemennetty' : 'T-88-VALITYS: lähdetilan siemennys epäonnistui');
  setInterval(() => { siemenna().catch(() => {}); }, 30_000);
}
