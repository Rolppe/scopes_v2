#!/usr/bin/env node
// T-88 kohdat (1)–(4) (ARK-19 hyväksyntäajo, tuotanto, VAIN LUKU): ydin 8797, adapteri 8798 ja vanha 8787. Vain GET-pyynnöt; mitään ei kirjoiteta, adapteria ei käynnistetä uudelleen.
//   node scopes2/adapteri/vertailu/t88-tuotanto.mjs [--ydin URL] [--adapteri URL] [--vanha URL] [--avain2 F] [--avain1 F]
// (1) adapterin /api/terveys-reitit sisältävät T-85:n ja T-86:n reitit. (2) ydin GET /api/android (X-Lahde ydin) = vanhan samoin avaimin.
// (3) ydin GET /api/android/ruutu?leveys=360 (X-Lahde adapteri) image/jpeg, > 0 tavua; ui ja tuotokset = vanhan. (4) GET /api/palvelin (X-Lahde adapteri) = vanhan.
// Kohdat (3)/(4) kutsuvat laitetta (ruutu, ui, tuotokset) ja palvelimen tilaa (ping): käyttäjän valtuutus overseerin kautta (21.10.2026). Avaimia ei tulosteta.
// Tuloste: "OK <kohta>: …" / "FAIL <kohta>: …"; exit 1, jos jokin FAIL.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const oletus = { ydin: 'http://127.0.0.1:8797', adapteri: 'http://127.0.0.1:8798', vanha: 'http://127.0.0.1:8787', avain2: '~/.config/scopes2/avain', avain1: '~/.config/scopes/avain' };
const a = { ...oletus, ...Object.fromEntries(process.argv.slice(2).reduce((r, x, i, t) => (x.startsWith('--') ? [...r, [x.slice(2), t[i + 1]]] : r), [])) };
const lue = (f) => readFileSync(f.startsWith('~/') ? homedir() + f.slice(1) : f, 'utf8').trim();
const AVAIN = { ydin: lue(a.avain2), vanha: lue(a.avain1) };
let virheita = 0;
const raportti = (ok, kohta, teksti) => { if (!ok) virheita++; console.log(`${ok ? 'OK' : 'FAIL'} ${kohta}: ${teksti}`); };

async function hae(kohde, polku) {
  const r = await fetch(`${a[kohde]}${polku}`, { headers: AVAIN[kohde] ? { authorization: `Bearer ${AVAIN[kohde]}` } : {}, signal: AbortSignal.timeout(60_000) });
  const tavut = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(tavut.toString('utf8')); } catch { /* ei JSONia */ }
  return { status: r.status, lahde: r.headers.get('x-lahde'), tyyppi: r.headers.get('content-type'), tavut, json };
}
// Avainrakenne: objektien avaimet rekursiivisesti, taulukoista ensimmäisen alkion rakenne.
const muoto = (v) => (Array.isArray(v) ? [v.length ? muoto(v[0]) : null] : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, muoto(v[k])])) : typeof v);
const sama = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const lyhyt = (v) => JSON.stringify(v).slice(0, 300);

// (1) adapterin terveys
const t = await hae('adapteri', '/api/terveys');
const reitit = t.json?.reitit ?? [];
const tarvitaan = ['GET /api/android/ruutu', 'GET /api/android/ui', 'GET /api/android/tuotokset', 'GET /api/android/tuotos', 'POST /api/android/liite', 'POST /api/android/*', 'GET /api/palvelin', 'POST /api/palvelin/*'];
const puuttuu = tarvitaan.filter((r) => !reitit.includes(r));
raportti(t.status === 200 && puuttuu.length === 0, 1, `adapterin /api/terveys 200, ${reitit.length} reittiä; T-85/T-86-reitit ${puuttuu.length === 0 ? 'kaikki mukana' : `puuttuu: ${puuttuu.join(', ')}`}`);

// (2) GET /api/android: ydin vs vanha
const ya = await hae('ydin', '/api/android');
const va = await hae('vanha', '/api/android');
raportti(ya.status === va.status && ya.lahde === 'ydin', 2, `ydin ${ya.status} X-Lahde=${ya.lahde}; vanha ${va.status}`);
raportti(sama(muoto(ya.json), muoto(va.json)), 2, `avainrakenne sama (ydin ${lyhyt(muoto(ya.json))}; vanha ${lyhyt(muoto(va.json))})`);
console.log(`   ydin  /api/android: ${lyhyt(ya.json)}\n   vanha /api/android: ${lyhyt(va.json)}`);

// (3) ruutu (jpeg), ui, tuotokset
const ru = await hae('ydin', '/api/android/ruutu?leveys=360');
raportti(ru.status === 200 && ru.lahde === 'adapteri' && /^image\/jpeg/.test(ru.tyyppi ?? '') && ru.tavut.length > 0 && ru.tavut[0] === 0xff && ru.tavut[1] === 0xd8,
  3, `ruutu ${ru.status} X-Lahde=${ru.lahde} ${ru.tyyppi} ${ru.tavut.length} tavua, JPEG-alku ${ru.tavut[0]?.toString(16)}${ru.tavut[1]?.toString(16)}`);
for (const nimi of ['ui', 'tuotokset']) {
  const y = await hae('ydin', `/api/android/${nimi}`);
  const v = await hae('vanha', `/api/android/${nimi}`);
  const yhta = y.status === v.status && sama(y.json, v.json);
  raportti(y.status === 200 && y.lahde === 'adapteri' && yhta, 3, `${nimi}: ydin ${y.status} X-Lahde=${y.lahde}, vanha ${v.status}, ${yhta ? 'rungot samat' : `rungot eroavat (ydin ${lyhyt(y.json)} | vanha ${lyhyt(v.json)})`}`);
}

// (4) palvelin
const yl = await hae('ydin', '/api/palvelin');
const vl = await hae('vanha', '/api/palvelin');
raportti(yl.status === vl.status && yl.lahde === 'adapteri' && sama(yl.json, vl.json), 4, `palvelin: ydin ${yl.status} X-Lahde=${yl.lahde} ${lyhyt(yl.json)}; vanha ${vl.status} ${lyhyt(vl.json)}`);

process.exit(virheita === 0 ? 0 : 1);
