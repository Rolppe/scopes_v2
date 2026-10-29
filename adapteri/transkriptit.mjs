// Transkriptien inkrementaalinen luku (T-24): jokaisesta *.jsonl-tiedostosta luetaan vain edellisen kierroksen jälkeen
// kirjoitetut kokonaiset rivit. Vain luku: mikään funktio ei kirjoita levylle.
//
// Jäsennys tuodaan kopiosta vanhasta/lahteet.mjs (T-65, SUUNNITELMA luku 11.6): kopio = scopes/palvelu/lahteet.mjs tavulleen paitsi kopiorivi ja import-rivit; alkuperäistä ei muuteta (K-9).

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  konteksti, pysahdys, pakattu, hereilla, istunnonSkooppi, istunnonLadatut, lueSkoopit, projektiNimi,
} from './vanhasta/lahteet.mjs';

export { konteksti, pysahdys, pakattu, hereilla, istunnonSkooppi, istunnonLadatut, lueSkoopit, projektiNimi };

// polku → { koko, mtimeMs, offset }. offset = ensimmäinen lukematon tavu (aina rivin alussa).
export const transkriptiValimuisti = new Map();

// Yhden lukukerran yläraja tavuina: ensimmäinen kierros ei lue monen kymmenen megatavun transkriptia yhteen pyyntöön.
// Rajaan osunut luku palauttaa kesken: true, ja seuraava kutsu jatkaa (koko ei jää välimuistiin).
export const LUKURAJA = 1024 * 1024;

function lueTavut(polku, alku, maara) {
  const puskuri = Buffer.alloc(maara);
  const fd = openSync(polku, 'r');
  try {
    let luettu = 0;
    while (luettu < maara) {
      const n = readSync(fd, puskuri, luettu, maara - luettu, alku + luettu);
      if (n === 0) break;
      luettu += n;
    }
    return puskuri.subarray(0, luettu);
  } finally {
    closeSync(fd);
  }
}

// Lisätyt kokonaiset rivit → { rivit, luettu, alku[, nollattu][, kesken] }. alku = tavu, josta rivit alkavat
// (S-5a:n offset); luettu = rivien tavut rivinvaihtoineen. Vajaa viimeinen rivi jää odottamaan.
export function lueLisays(polku, valimuisti = transkriptiValimuisti, raja = LUKURAJA) {
  const st = statSync(polku);
  const vanha = valimuisti.get(polku) ?? { koko: -1, mtimeMs: -1, offset: 0 };
  if (st.size === vanha.koko && st.mtimeMs === vanha.mtimeMs) return { rivit: [], luettu: 0, alku: vanha.offset };
  let alku = vanha.offset;
  let nollattu = false;
  if (st.size < alku) { alku = 0; nollattu = true; }
  const jaljella = st.size - alku;
  let puskuri = lueTavut(polku, alku, Math.min(jaljella, raja));
  let kesken = puskuri.length < jaljella;
  let loppu = puskuri.lastIndexOf(0x0a);
  if (loppu < 0 && kesken) {
    // Rajaa pidempi rivi: luetaan loppuun asti, ettei luku jää jumiin.
    puskuri = lueTavut(polku, alku, jaljella);
    kesken = false;
    loppu = puskuri.lastIndexOf(0x0a);
  }
  const luettu = loppu + 1;
  const rivit = luettu > 0 ? puskuri.subarray(0, loppu).toString('utf8').split('\n') : [];
  valimuisti.set(polku, { koko: kesken ? -1 : st.size, mtimeMs: kesken ? -1 : st.mtimeMs, offset: alku + luettu });
  const tulos = { rivit, luettu, alku };
  if (nollattu) tulos.nollattu = true;
  if (kesken) tulos.kesken = true;
  return tulos;
}

// Elääkö pid samana prosessina: /proc/<pid>/stat kenttä 22 = procStart. Ei ps-varakeinoa (ei synkronisia alikomentoja).
function elossa(pid, procStart, proc) {
  try {
    const stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8');
    const kentat = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return procStart == null || kentat[19] === String(procStart);
  } catch {
    return false;
  }
}

// Elävät Claude-istunnot ilman transkriptin jäsennystä: [{ id, nimi, tila, kysely, alkoi, pid, ruutu, polku }].
// polku = transkripti; ilman projektitDir-argumenttia suhteessa projektihakemistoon (S-5a:n tiedosto-kenttä).
export function istuntotiedostot(istunnotDir, proc = '/proc', projektitDir = '') {
  const tulos = [];
  if (!existsSync(istunnotDir)) return tulos;
  for (const tiedosto of readdirSync(istunnotDir).filter((f) => /^\d+\.json$/.test(f))) {
    let s;
    try { s = JSON.parse(readFileSync(join(istunnotDir, tiedosto), 'utf8')); } catch { continue; }
    if (!s?.sessionId || !elossa(s.pid, s.procStart, proc)) continue;
    tulos.push({
      id: s.sessionId,
      nimi: s.name ?? null,
      tila: s.status ?? null,
      kysely: s.status === 'waiting' && s.waitingFor === 'input needed',
      alkoi: s.startedAt ?? 0,
      pid: s.pid,
      ruutu: (s.entrypoint ?? 'cli') === 'cli' ? /\.(%\d+)$/.exec(s.tmux ?? '')?.[1] ?? null : null,
      polku: join(projektitDir, projektiNimi(s.cwd ?? ''), `${s.sessionId}.jsonl`),
    });
  }
  return tulos;
}
