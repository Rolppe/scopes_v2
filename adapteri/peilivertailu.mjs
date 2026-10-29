#!/usr/bin/env node
// Peilivertailu (T-25): jokaisen *.jsonl-transkriptin kokonaiset rivit levyllä vs. ytimen peilikopio.
//   node scopes2/adapteri/peilivertailu.mjs [--ydin http://127.0.0.1:8797] [--projektit ~/.claude/projects] [--avain ~/.config/scopes2/avain]
// Levyltä: sha256 tiedoston kokonaisista riveistä (viimeinen vajaa rivi ohitetaan) ja niiden tavumäärä.
// Ytimestä: GET /api/peili/<tiedosto>/offset (S-5a) ja peilin rivit: GET /api/listat?polku=peili (yksiköiden id
// `<tiedosto>:<alku>`) + POST /api/hae (enintään 300 id:tä kerralla; ydin palauttaa ~8 MiB sisältöä kerralla ja
// palauttamatta jääneet kentässä `jatko`, joita pyydetään uudelleen, kunnes jatko on tyhjä), sisältö = JSON-rivitaulukko (tavutaulukkona),
// yksiköt alku-offsetin järjestyksessä. Tiedosto on ok, kun offset == kokonaisten rivien tavumäärä ja tiiviste täsmää.
// UUSINTA (T-34 ajo 4): elävä transkripti voi kasvaa vertailun aikana, ja yksikkölista on haettu ajon alussa. Eroava
// tiedosto tarkistetaan uudelleen järjestyksessä offset → tuore yksikkölista → peilin rivit → levyn alku offsetiin asti;
// ero lasketaan vain, jos se pysyy.
// Tuloste: `PEILI: <ok>/<n> (uusinta <korjaantui>/<uusittu>)` ja pysyvät erot; exit 0 vain ok == n (n = 0 → exit 1).

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const kotiin = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);

function argumentit(argv) {
  const a = { ydin: process.env.SCOPES2_YDIN ?? 'http://127.0.0.1:8797', projektit: '~/.claude/projects', avain: '~/.config/scopes2/avain' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--ydin', '--projektit', '--avain'].includes(k) || argv[i + 1] == null) throw new Error(`virheellinen argumentti ${k}`);
    a[k.slice(2)] = argv[++i];
  }
  return a;
}

function jsonlTiedostot(juuri) {
  const tulos = [];
  const kay = (hak) => {
    let rivit;
    try { rivit = readdirSync(hak, { withFileTypes: true }); } catch { return; }
    for (const e of rivit.sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(hak, e.name);
      if (e.isDirectory()) kay(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) tulos.push(p);
    }
  };
  kay(juuri);
  return tulos;
}

// Levyn kokonaiset rivit (viimeinen rivinvaihdoton osa jää pois) → { tavut, tiiviste }.
export function levynRivit(polku) {
  const puskuri = readFileSync(polku);
  const loppu = puskuri.lastIndexOf(0x0a) + 1;
  const kokonaiset = puskuri.subarray(0, loppu);
  return { tavut: kokonaiset.length, tiiviste: createHash('sha256').update(kokonaiset).digest('hex') };
}

// POST /api/hae jatko-listalla, kunnes se on tyhjä (ytimen T-36 ajo 3: vastaus ~8 MiB, loput id:t kentässä jatko).
// → Map id → yksikkö. Jatko, joka ei lyhene, on virhe (muuten silmukka ei pääty).
export async function haeKaikki(pyynto, idt) {
  const yksikot = new Map();
  let pyydetyt = idt;
  while (pyydetyt.length) {
    const v = await pyynto('/api/hae', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ polku: 'peili', idt: pyydetyt }),
    });
    for (const y of v.yksikot ?? []) yksikot.set(y.id, y);
    const jatko = Array.isArray(v.jatko) ? v.jatko : [];
    if (jatko.length && jatko.length >= pyydetyt.length) throw new Error(`/api/hae: jatko ei lyhene (${jatko.length}/${pyydetyt.length})`);
    pyydetyt = jatko;
  }
  return yksikot;
}

// Tiedostot vertailtuna, eroavat uudelleen → { ok, n, uusittu, korjaantui, eroavat }.
// vertaa(t) ja uudelleen(t) → [syy…] (tyhjä = sama); uudelleen ajetaan vain ensimmäisellä kierroksella eronneille.
export async function vertaileUusinnalla(tiedostot, vertaa, uudelleen) {
  const ensimmainen = new Map();
  for (const t of tiedostot) {
    const syy = await vertaa(t);
    if (syy.length) ensimmainen.set(t, syy);
  }
  const pysyvat = new Map();
  for (const t of ensimmainen.keys()) {
    const syy = await uudelleen(t);
    if (syy.length) pysyvat.set(t, syy);
  }
  return {
    ok: tiedostot.length - pysyvat.size, n: tiedostot.length, uusittu: ensimmainen.size,
    korjaantui: ensimmainen.size - pysyvat.size, eroavat: [...pysyvat].map(([t, syy]) => `${t}: ${syy.join('; ')}`),
  };
}

// Peiliyksiköt tiedostoittain listasta: tiedosto → [{ alku, id }] alun mukaan.
function ryhmittele(lista) {
  const yksikot = new Map();
  for (const { id } of lista.yksikot ?? []) {
    const i = id.lastIndexOf(':');
    if (i < 0) continue;
    const t = id.slice(0, i);
    if (!yksikot.has(t)) yksikot.set(t, []);
    yksikot.get(t).push({ alku: Number(id.slice(i + 1)), id });
  }
  for (const osat of yksikot.values()) osat.sort((x, y) => x.alku - y.alku);
  return yksikot;
}

async function peilinRivit(pyynto, osat) {
  const rivit = [];
  for (let i = 0; i < osat.length; i += 300) {
    const haetut = await haeKaikki(pyynto, osat.slice(i, i + 300).map((o) => o.id));
    for (const o of osat.slice(i, i + 300)) {
      const y = haetut.get(o.id);
      if (y && !y.poistettu) rivit.push(...JSON.parse(Buffer.from(y.sisalto ?? []).toString('utf8')));
    }
  }
  return rivit;
}

const tiivisteRiveista = (rivit) => createHash('sha256').update(rivit.map((r) => `${r}\n`).join('')).digest('hex');

// Levyn ensimmäiset `tavut` tavua → tiiviste (null, jos tiedosto on lyhyempi).
function levynAlku(polku, tavut) {
  const puskuri = Buffer.alloc(tavut);
  const fd = openSync(polku, 'r');
  try {
    let luettu = 0;
    while (luettu < tavut) {
      const n = readSync(fd, puskuri, luettu, tavut - luettu, luettu);
      if (n === 0) return null;
      luettu += n;
    }
  } finally { closeSync(fd); }
  return createHash('sha256').update(puskuri).digest('hex');
}

async function main() {
  const a = argumentit(process.argv.slice(2));
  const projektit = resolve(kotiin(a.projektit));
  const pohja = a.ydin.replace(/\/+$/, '');
  let key = '';
  try { key = readFileSync(kotiin(a.avain), 'utf8').trim(); } catch { /* ydin hylkää */ }
  const pyynto = async (polku, asetukset = {}) => {
    const v = await fetch(`${pohja}${polku}`, {
      ...asetukset,
      headers: { ...(asetukset.headers ?? {}), authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!v.ok) throw new Error(`${polku}: HTTP ${v.status}`);
    return v.json();
  };

  const offsetUrl = (tiedosto) => `/api/peili/${tiedosto.split('/').map(encodeURIComponent).join('/')}/offset`;
  const yksikot = ryhmittele(await pyynto('/api/listat?polku=peili'));
  const polku = (tiedosto) => join(projektit, tiedosto);

  const vertaa = async (tiedosto) => {
    const syy = [];
    try {
      const levy = levynRivit(polku(tiedosto));
      const { offset } = await pyynto(offsetUrl(tiedosto));
      if (offset !== levy.tavut) syy.push(`offset ${offset} ≠ levy ${levy.tavut}`);
      const rivit = await peilinRivit(pyynto, yksikot.get(tiedosto) ?? []);
      const peili = tiivisteRiveista(rivit);
      if (peili !== levy.tiiviste) syy.push(`tiiviste ${peili.slice(0, 12)} ≠ levy ${levy.tiiviste.slice(0, 12)} (${rivit.length} riviä peilissä)`);
    } catch (e) {
      syy.push(String(e?.message ?? e));
    }
    return syy;
  };
  // Uusinta ilman kilpaa: offset ensin, sitten tuore lista ja rivit, levyltä vain offsetiin asti.
  const uudelleen = async (tiedosto) => {
    try {
      const { offset } = await pyynto(offsetUrl(tiedosto));
      const rivit = await peilinRivit(pyynto, ryhmittele(await pyynto('/api/listat?polku=peili')).get(tiedosto) ?? []);
      const tavut = rivit.reduce((s, r) => s + Buffer.byteLength(r) + 1, 0);
      if (tavut !== offset) return [`uusinta: peilin rivit ${tavut} tavua ≠ offset ${offset}`];
      const levy = levynAlku(polku(tiedosto), offset);
      if (levy == null) return [`uusinta: levy lyhyempi kuin offset ${offset}`];
      const peili = tiivisteRiveista(rivit);
      return peili === levy ? [] : [`uusinta: tiiviste ${peili.slice(0, 12)} ≠ levyn alku ${levy.slice(0, 12)} (offset ${offset})`];
    } catch (e) {
      return [`uusinta: ${String(e?.message ?? e)}`];
    }
  };

  const tiedostot = jsonlTiedostot(projektit).map((p) => relative(projektit, p).split('\\').join('/'));
  const t = await vertaileUusinnalla(tiedostot, vertaa, uudelleen);
  console.log(`PEILI: ${t.ok}/${t.n} (uusinta ${t.korjaantui}/${t.uusittu})`);
  for (const r of t.eroavat) console.log(`ERO ${r}`);
  process.exitCode = t.n > 0 && t.ok === t.n ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`peilivertailu: ${e.message}`); process.exit(2); });
