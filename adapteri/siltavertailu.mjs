#!/usr/bin/env node
// Siltavertailu (T-25): scopes2-ytimen johdetut lukureitit vs. vanha palvelu (8787).
//   node scopes2/adapteri/siltavertailu.mjs [--ydin http://127.0.0.1:8797] [--vanha http://127.0.0.1:8787]
//        [--ydin-avain ~/.config/scopes2/avain] [--vanha-avain ~/.config/scopes/avain] [--uusinta-ms 20000]
// Hakee molemmista: GET /api/skoopit, /api/skoopit/<nimi> (3 ensimmäistä), /api/skoopit/<nimi>/viestit (3 ensimmäistä),
// /api/agentit. Vertaa tilakoodin ja JSON-rungon rekursiivisesti.
//
// SALLITUT EROT (avaimet, jotka ohitetaan millä tahansa syvyydellä):
//   jonossa  - jonotettujen viestien lukumäärä/lista: ydin ja vanha palvelu jonottavat eri ajanhetkinä
//   agy      - agy-lähteen tila: tulee ytimessä lähde-yksiköistä (S-5b), vanhassa suoraan lukemalla
//   transkripti - V2:n /viestit-vastauksen istunto.transkripti (T-101, S-9f-asiakkaalle); vanhassa ei kenttää
// X-Lahde-otsikko (T-35: "ydin" tai "silta") ei ole ero vaan kirjataan: tuloste "(ydin <k>, silta <m>)" kertoo,
// montako ytimen vastausta tuli ytimestä ja montako sillan kautta vanhasta.
// UUSINTA (ytimen R-1, YDIN-REKISTERIT-YTIMESTA): ydin pitää sillan vastauksista välimuistia, jota päivitetään 15 s välein,
// joten elävästi muuttuvat kentät (esim. konteksti) voivat olla ~15 s vanhoja. Eroavat reitit verrataan uudelleen
// --uusinta-ms:n (oletus 20 s, 0 = ei uusintaa) päästä; ero lasketaan vain, jos se pysyy uusinnassa.
// Tuloste: `SILTA: <ok>/<n> (ydin <k>, silta <m>; uusinta <korjaantui>/<uusittu>)` ja pysyvät erot; exit 0 vain ok == n.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const SALLITUT = new Set(['jonossa', 'agy', 'transkripti']);

function argumentit(argv) {
  const a = { ydin: 'http://127.0.0.1:8797', vanha: 'http://127.0.0.1:8787', 'ydin-avain': '~/.config/scopes2/avain', 'vanha-avain': '~/.config/scopes/avain', 'uusinta-ms': '20000' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--ydin', '--vanha', '--ydin-avain', '--vanha-avain', '--uusinta-ms'].includes(k) || argv[i + 1] == null) throw new Error(`virheellinen argumentti ${k}`);
    a[k.slice(2)] = argv[++i];
  }
  return a;
}

const kotiin = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);
const avain = (p) => { try { return readFileSync(kotiin(p), 'utf8').trim(); } catch { return ''; } };

async function hae(pohja, key, polku) {
  try {
    const v = await fetch(`${pohja.replace(/\/+$/, '')}${polku}`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const teksti = await v.text();
    let runko;
    try { runko = JSON.parse(teksti); } catch { runko = teksti; }
    return { tila: v.status, runko, lahde: v.headers.get('x-lahde') };
  } catch (e) {
    return { tila: 0, runko: null, virhe: String(e?.message ?? e), lahde: null };
  }
}

// Rekursiivinen vertailu → eroavien polkujen lista (tyhjä = sama).
export function erot(a, b, polku = '') {
  if (a === b) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const tulos = [];
    if (a.length !== b.length) tulos.push(`${polku || '/'}: pituus ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) tulos.push(...erot(a[i], b[i], `${polku}[${i}]`));
    return tulos;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const tulos = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (SALLITUT.has(k)) continue;
      if (!(k in a)) tulos.push(`${polku}.${k}: puuttuu ytimestä`);
      else if (!(k in b)) tulos.push(`${polku}.${k}: puuttuu vanhasta`);
      else tulos.push(...erot(a[k], b[k], `${polku}.${k}`));
    }
    return tulos;
  }
  return [`${polku || '/'}: ${JSON.stringify(a)?.slice(0, 80)} ≠ ${JSON.stringify(b)?.slice(0, 80)}`];
}

// Reitit vertailtuna, eroavat uudelleen uusintaMs:n päästä → { ok, n, ydinta, siltaa, uusittu, korjaantui, eroavat }.
// vertaa(polku) → { erot: [rivi…], lahde }; X-Lahde lasketaan ensimmäiseltä kierrokselta.
export async function vertaileUusinnalla(pyynnot, vertaa, { uusintaMs = 20000, odota = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let ydinta = 0;
  let siltaa = 0;
  const ensimmainen = new Map();
  for (const p of pyynnot) {
    const t = await vertaa(p);
    if (t.lahde === 'ydin') ydinta++;
    else if (t.lahde === 'silta') siltaa++;
    if (t.erot.length) ensimmainen.set(p, t.erot);
  }
  let pysyvat = ensimmainen;
  if (ensimmainen.size && uusintaMs > 0) {
    await odota(uusintaMs);
    pysyvat = new Map();
    for (const p of ensimmainen.keys()) {
      const t = await vertaa(p);
      if (t.erot.length) pysyvat.set(p, t.erot);
    }
  }
  const eroavat = [];
  for (const [p, e] of pysyvat) for (const rivi of e) eroavat.push(`${p} ${rivi}`);
  return {
    ok: pyynnot.length - pysyvat.size, n: pyynnot.length, ydinta, siltaa,
    uusittu: uusintaMs > 0 ? ensimmainen.size : 0, korjaantui: uusintaMs > 0 ? ensimmainen.size - pysyvat.size : 0, eroavat,
  };
}

async function main() {
  const a = argumentit(process.argv.slice(2));
  const ka = avain(a['ydin-avain']);
  const kv = avain(a['vanha-avain']);
  const pyynnot = ['/api/skoopit'];
  const eka = await hae(a.vanha, kv, '/api/skoopit');
  const nimet = (Array.isArray(eka.runko) ? eka.runko : []).map((s) => s?.nimi).filter((n) => typeof n === 'string').slice(0, 3);
  for (const n of nimet) pyynnot.push(`/api/skoopit/${encodeURIComponent(n)}`);
  for (const n of nimet) pyynnot.push(`/api/skoopit/${encodeURIComponent(n)}/viestit`);
  pyynnot.push('/api/agentit');

  const vertaa = async (p) => {
    const [y, v] = await Promise.all([hae(a.ydin, ka, p), hae(a.vanha, kv, p)]);
    const e = [];
    if (y.tila !== v.tila) e.push(`tila ${y.tila}${y.virhe ? ` (${y.virhe})` : ''} ≠ ${v.tila}${v.virhe ? ` (${v.virhe})` : ''}`);
    else e.push(...erot(y.runko, v.runko));
    return { erot: e, lahde: y.lahde };
  };
  const t = await vertaileUusinnalla(pyynnot, vertaa, { uusintaMs: Number(a['uusinta-ms']) });
  console.log(`SILTA: ${t.ok}/${t.n} (ydin ${t.ydinta}, silta ${t.siltaa}; uusinta ${t.korjaantui}/${t.uusittu})`);
  for (const r of t.eroavat) console.log(`ERO ${r}`);
  process.exitCode = t.ok === t.n ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`siltavertailu: ${e.message}`); process.exit(2); });
