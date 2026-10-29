#!/usr/bin/env node
// T-88 kohta (5): koeadapterin kuivatila. Jokainen tilaa muuttava android- ja palvelin-toiminto vastaa `kuiva`-kentällä (komento, jota ei ajettu),
// ja mockin loki todistaa, ettei adb-input-, am start-, push-, ssh-poweroff- tai WoL-komentoa (python3) ajettu. Vain koeadapteri; ei tuotantoa.
// Tuloste: "OK 5: …" / "FAIL 5: …"; exit 1, jos jokin FAIL.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const a = Object.fromEntries(process.argv.slice(2).reduce((r, x, i, t) => (x.startsWith('--') ? [...r, [x.slice(2), t[i + 1]]] : r), []));
for (const k of ['adapteri', 'avain', 'mockdata', 'mockloki', 'toimintoloki']) if (!a[k]) { console.error('käyttö: t88-tarkista.mjs --adapteri URL --avain F --mockdata D --mockloki F --toimintoloki F'); process.exit(2); }
const avain = readFileSync(a.avain, 'utf8').trim();
let virheita = 0;
const raportti = (ok, teksti) => { if (!ok) virheita++; console.log(`${ok ? 'OK' : 'FAIL'} 5: ${teksti}`); };

async function kutsu(metodi, polku, runko, otsakkeet = { authorization: `Bearer ${avain}` }) {
  const json = runko !== undefined && typeof runko === 'object';
  const r = await fetch(`${a.adapteri}${polku}`, {
    method: metodi,
    headers: { ...otsakkeet, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: runko === undefined ? undefined : json ? JSON.stringify(runko) : runko,
    signal: AbortSignal.timeout(30_000),
  });
  const teksti = await r.text();
  let j = null;
  try { j = JSON.parse(teksti); } catch { /* ei JSONia */ }
  return { status: r.status, json: j, teksti };
}

const mockRivit = () => (existsSync(a.mockloki) ? readFileSync(a.mockloki, 'utf8').split('\n').filter(Boolean).map((r) => JSON.parse(r)) : []);

// Terveys ja avain
const t = await kutsu('GET', '/api/terveys', undefined, {});
raportti(t.status === 200 && t.json?.adapteri === true, `terveys ilman avainta 200, reitit ${t.json?.reitit?.length ?? '?'}`);
const reitit = JSON.stringify(t.json?.reitit ?? []);
raportti(['/api/android/ruutu', '/api/android/*', '/api/palvelin'].every((k) => reitit.includes(k)), 'terveys-reitit sisältävät android- ja palvelin-reitit');
raportti((await kutsu('POST', '/api/android/napauta', { x: 0.5, y: 0.5 }, {})).status === 401, 'toiminto ilman avainta → 401');

// Android: jokainen tilaa muuttava toiminto
const androidit = [
  ['napauta', '/api/android/napauta', { x: 0.5, y: 0.25 }],
  ['pyyhkaise', '/api/android/pyyhkaise', { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2 }],
  ['nappi koti', '/api/android/nappi', { nimi: 'koti' }],
  ['nappi nukuta', '/api/android/nappi', { nimi: 'nukuta' }],
  ['avaa', '/api/android/avaa', {}],
  ['uusi', '/api/android/uusi', {}],
  ['kirjoita', '/api/android/kirjoita', { teksti: 'T-88 koe' }],
  ['kirjoita+laheta', '/api/android/kirjoita', { teksti: 'T-88 koe', laheta: true }],
  ['laheta', '/api/android/laheta', {}],
];
for (const [nimi, polku, runko] of androidit) {
  const r = await kutsu('POST', polku, runko);
  raportti(r.status === 200 && r.json?.ok === true && Boolean(r.json?.kuiva), `android ${nimi}: ${r.status} kuiva=${JSON.stringify(r.json?.kuiva ?? null)}`);
}
const liite = await kutsu('POST', '/api/android/liite?nimi=t88.txt', 'T-88 liite');
raportti(liite.status === 200 && liite.json?.ok === true && Boolean(liite.json?.kuiva), `android liite: ${liite.status} kuiva=${JSON.stringify(liite.json?.kuiva ?? null)}`);

// palvelin: sammuksissa (ping ei vastaa) → kaynnista (WoL); linux (ttl=64) → sammuta
writeFileSync(`${a.mockdata}/ping.json`, '[]');
const k = await kutsu('POST', '/api/palvelin/kaynnista', {});
raportti(k.status === 200 && Boolean(k.json?.kuiva), `palvelin kaynnista (sammuksissa): ${k.status} kuiva=${JSON.stringify(k.json?.kuiva ?? null)}`);
writeFileSync(`${a.mockdata}/ping.json`, JSON.stringify([{ sisaltaa: '192.0.2.99', stdout: '64 bytes from 192.0.2.99: icmp_seq=1 ttl=64 time=0.4 ms\n' }]));
const s = await kutsu('POST', '/api/palvelin/sammuta', {});
raportti(s.status === 200 && Boolean(s.json?.kuiva), `palvelin sammuta (linux): ${s.status} kuiva=${JSON.stringify(s.json?.kuiva ?? null)}`);
const tila = await kutsu('GET', '/api/palvelin');
raportti(tila.status === 200, `palvelin tila (luku): ${tila.status} ${JSON.stringify(tila.json)}`);

// Mockin loki: ei tilaa muuttavaa komentoa
const rivit = mockRivit();
const komento = (r) => `${r.komento} ${r.argv.join(' ')}`;
const kielletyt = rivit.filter((r) => {
  const k2 = komento(r);
  if (r.komento === 'adb') return /shell (input|am start|svc|content call|mkdir)|\bpush\b|keyevent/.test(k2);
  if (r.komento === 'ssh') return /poweroff|shutdown|sudo/.test(k2);
  return r.komento === 'python3' || r.komento === 'claude';
});
const laskuri = rivit.reduce((m, r) => ({ ...m, [r.komento]: (m[r.komento] ?? 0) + 1 }), {});
raportti(rivit.length > 0, `mock-loki ei tyhjä: ${JSON.stringify(laskuri)}`);
raportti(kielletyt.length === 0, kielletyt.length === 0 ? 'mock-lokissa ei adb-input-, am start-, push-, ssh-poweroff- eikä WoL-komentoa (python3)' : `mock-lokissa tilaa muuttavia komentoja: ${kielletyt.map(komento).join(' | ')}`);

// Toimintoloki: jokainen tilaa muuttavan toiminnon rivi on kuiva-merkitty; ei lokita ajettua komentoa ilman kuiva-kenttää
const loki = existsSync(a.toimintoloki) ? readFileSync(a.toimintoloki, 'utf8').split('\n').filter(Boolean) : [];
const lokiJson = loki.map((r) => { try { return JSON.parse(r); } catch { return { raaka: r }; } });
const toiminnot = lokiJson.filter((r) => /android|linux/i.test(JSON.stringify(r)));
const ilmanKuivaa = toiminnot.filter((r) => r.tulos !== 'hylätty' && !r.kuiva && !/kuiva/i.test(JSON.stringify(r)));
raportti(toiminnot.length > 0 && ilmanKuivaa.length === 0, `toimintoloki: ${toiminnot.length} android/linux-riviä, ilman kuiva-merkintää ${ilmanKuivaa.length}`);
for (const r of toiminnot.slice(0, 20)) console.log(`   loki: ${JSON.stringify(r)}`);

process.exit(virheita === 0 ? 0 : 1);
