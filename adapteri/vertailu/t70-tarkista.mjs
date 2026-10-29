#!/usr/bin/env node
// T-70-kokeen tarkistaja (ARK-16 hyväksyntäajon harjoitus, ei tuotantoa): vertaa ydintä (adapteri mukana) vanhaan palveluun.
//   node scopes2/adapteri/vertailu/t70-tarkista.mjs vertailu   --ydin URL --vanha URL --adapteri URL --avain2 TIEDOSTO --avain1 TIEDOSTO
//   node scopes2/adapteri/vertailu/t70-tarkista.mjs pysaytetty --ydin URL --vanha URL --avain2 TIEDOSTO --avain1 TIEDOSTO
// Vaihe vertailu = SUUNNITELMA-luvun T-70 kohdat (1), (2) ja (7): adapterin /api/terveys-reitit = toteutetut reitit; siirretty reitti
// vastaa X-Lahde: adapteri (T-84:n lukureitit: ydin); sivuvaikutuksettomat tapaukset antavat saman statuksen ja rungon kuin vanha.
// Vaihe pysaytetty = kohta (3): adapteri kiinni → siirretty reitti 503 {"virhe":"adapteri"}.
// Tuloste: "OK <kohta>: …" / "FAIL <kohta>: …"; exit 1, jos jokin FAIL. Ei muuta tilaa: vain sivuvaikutuksettomat pyynnöt.
import { readFileSync } from 'node:fs';
import { KAIKKI, toteutetut } from '../toiminnot/reitit.mjs';

const [vaihe, ...loput] = process.argv.slice(2);
const a = Object.fromEntries(loput.reduce((r, x, i, t) => (x.startsWith('--') ? [...r, [x.slice(2), t[i + 1]]] : r), []));
if (!['vertailu', 'pysaytetty'].includes(vaihe) || !a.ydin || !a.vanha || !a.avain2 || !a.avain1) { console.error('käyttö: t70-tarkista.mjs vertailu|pysaytetty --ydin URL --vanha URL [--adapteri URL] --avain2 F --avain1 F'); process.exit(2); }
const avain = (f) => readFileSync(f, 'utf8').trim();
const AVAIN = { ydin: avain(a.avain2), vanha: avain(a.avain1) };
let virheita = 0;
const raportti = (ok, kohta, teksti) => { if (!ok) virheita++; console.log(`${ok ? 'OK' : 'FAIL'} ${kohta}: ${teksti}`); };

async function kutsu(kohde, metodi, polku, runko) {
  const r = await fetch(`${a[kohde]}${polku}`, {
    method: metodi,
    headers: { authorization: `Bearer ${AVAIN[kohde]}`, ...(runko === undefined ? {} : { 'content-type': 'application/json' }) },
    body: runko === undefined ? undefined : JSON.stringify(runko),
    signal: AbortSignal.timeout(20_000),
  });
  const teksti = await r.text();
  let json = null;
  try { json = JSON.parse(teksti); } catch { /* ei JSONia */ }
  return { status: r.status, lahde: r.headers.get('x-lahde'), json, teksti };
}
const siisti = (x) => { // kayttoraja: `haettu` saa erota (≤ 120 s, SUUNNITELMA T-70 (7))
  if (Array.isArray(x)) return x.map(siisti);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'haettu').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, siisti(v)]));
  return x;
};
const sama = (p, v) => p.status === v.status && JSON.stringify(siisti(p.json ?? p.teksti)) === JSON.stringify(siisti(v.json ?? v.teksti));
const ero = (p, v) => { // ensimmäinen eroava kohta kanonisoitujen runkojen välillä
  const a = JSON.stringify(siisti(p.json ?? p.teksti)); const b = JSON.stringify(siisti(v.json ?? v.teksti));
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return `ero kohdassa ${i}: ydin …${a.slice(Math.max(0, i - 40), i + 120)} | vanha …${b.slice(Math.max(0, i - 40), i + 120)}`;
};
const lyhyt = (r, n = 90) => `${r.status} ${r.teksti.slice(0, n).replace(/\s+/g, ' ')}`;

if (vaihe === 'pysaytetty') {
  // (3) adapteri pysäytettynä siirretty reitti antaa 503 {"virhe":"adapteri"}
  for (const [m, p, runko] of [['POST', '/api/skoopit/ei-ole/pakkaa', {}], ['GET', '/api/purkajat'], ['GET', '/api/chat/keskustelut'], ['GET', '/api/agentit']]) {
    const r = await kutsu('ydin', m, p, runko);
    raportti(r.status === 503 && r.json?.virhe === 'adapteri', '3', `${m} ${p} adapteri kiinni → ${lyhyt(r)}`);
  }
  process.exit(virheita ? 1 : 0);
}

// (1) adapterin /api/terveys-reitit = toteutetut reitit (T-66…T-69, T-80…T-86)
const th = await (await fetch(`${a.adapteri}/api/terveys`)).json();
const odotetut = [...toteutetut(KAIKKI)].sort();
const saadut = [...(th.reitit ?? [])].sort();
raportti(JSON.stringify(odotetut) === JSON.stringify(saadut), '1', `adapterin terveysreitit ${saadut.length} kpl = toteutetut ${odotetut.length} kpl${JSON.stringify(odotetut) === JSON.stringify(saadut) ? '' : ` (ero: ${odotetut.filter((x) => !saadut.includes(x)).concat(saadut.filter((x) => !odotetut.includes(x))).join(', ')})`}`);

const skoopit = (await kutsu('vanha', 'GET', '/api/skoopit')).json ?? [];
const S = encodeURIComponent(skoopit[0]?.nimi ?? 'a');
const OLEMATON = 'ei-ole-koe-skooppi';
// [kohta, metodi, polku, runko, odotettu X-Lahde]; sama status ja runko kuin vanha
const tapaukset = [
  ['2 stop vapaalle', 'POST', `/api/skoopit/${S}/stop`, {}, 'adapteri'],
  ['2 kysymys-pois ilman kysymystä', 'POST', `/api/skoopit/${S}/kysymys-pois`, {}, 'adapteri'],
  ['2 pakkaa olemattomaan', 'POST', `/api/skoopit/${OLEMATON}/pakkaa`, {}, 'adapteri'],
  ['2 chat/keskustelut', 'GET', '/api/chat/keskustelut', undefined, 'adapteri'],
  ['2 purkajat', 'GET', '/api/purkajat', undefined, 'adapteri'],
  ['7 malli olemattomaan', 'POST', `/api/skoopit/${OLEMATON}/malli`, { malli: 'claude-opus-5-5' }, 'adapteri'],
  ['7 uusi olemassa olevalla nimellä', 'POST', '/api/uusi', { nimi: skoopit[0]?.nimi ?? 'a' }, 'adapteri'],
  ['7 agentit', 'GET', '/api/agentit', undefined, 'adapteri'],
  ['7 asetukset', 'GET', '/api/asetukset', undefined, 'ydin'],
  ...skoopit.slice(0, 3).map((s, i) => [`7 skoopin asetukset ${i + 1}`, 'GET', `/api/skoopit/${encodeURIComponent(s.nimi)}/asetukset`, undefined, 'ydin']),
  ['7 kayttoraja', 'GET', '/api/kayttoraja', undefined, 'ydin'],
  ['7 kayttoraja agy', 'GET', '/api/kayttoraja?tyyppi=agy', undefined, 'ydin'],
];
for (const [kohta, m, p, runko, lahde] of tapaukset) {
  let v = await kutsu('vanha', m, p, runko);
  let y = await kutsu('ydin', m, p, runko);
  // lähdetila täyttyy vähän ydinkäynnistyksen jälkeen: ydin-lukureitit voivat vastata ensin sillasta
  for (let i = 0; i < 20 && lahde === 'ydin' && y.lahde !== 'ydin'; i++) { await new Promise((r) => setTimeout(r, 1000)); y = await kutsu('ydin', m, p, runko); v = await kutsu('vanha', m, p, runko); }
  const ok = sama(y, v) && y.lahde === lahde;
  raportti(ok, kohta, ok ? `${m} ${p} = vanha (X-Lahde: ${y.lahde}) ${lyhyt(y)}` : `${m} ${p}: ydin [${y.lahde}] ${y.status} ≠ vanha ${v.status}; ${sama(y, v) ? 'rungot samat' : ero(y, v)}${y.lahde === lahde ? '' : `; odotettu X-Lahde: ${lahde}`}`);
}
process.exit(virheita ? 1 : 0);
