#!/usr/bin/env node
// Latenssimittari (T-25): p50/p90 ytimen johdetuille lukureiteille.
//   node scopes2/adapteri/mittaa-latenssi.mjs [--ydin http://127.0.0.1:8797] [--kierrokset 50]
//        [--raja-skoopit <ms>] [--raja-viestit <ms>] [--avain ~/.config/scopes2/avain]
// Mittaa GET /api/skoopit ja GET /api/skoopit/<nimi>/viestit (ensimmäinen skooppi; ilman skoopteja viestit ohitetaan).
// Tuloste: `P50 /api/skoopit <ms>`, `P90 /api/skoopit <ms>`, sama viesteille.
// Exit: 0 kun p50 < raja kummallekin annetulle rajalle (ilman rajoja aina 0); 1 raja ylittyi tai pyyntö epäonnistui.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const kotiin = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);

function argumentit(argv) {
  const a = { ydin: process.env.SCOPES2_YDIN ?? 'http://127.0.0.1:8797', kierrokset: '50', avain: '~/.config/scopes2/avain', 'raja-skoopit': null, 'raja-viestit': null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--ydin', '--kierrokset', '--avain', '--raja-skoopit', '--raja-viestit'].includes(k) || argv[i + 1] == null) throw new Error(`virheellinen argumentti ${k}`);
    a[k.slice(2)] = argv[++i];
  }
  return a;
}

const prosentti = (jarjestetty, p) => jarjestetty[Math.min(jarjestetty.length - 1, Math.ceil(p * jarjestetty.length) - 1)];
const ms = (x) => x.toFixed(1);

async function main() {
  const a = argumentit(process.argv.slice(2));
  const kierrokset = Number(a.kierrokset);
  if (!Number.isInteger(kierrokset) || kierrokset < 1) throw new Error('--kierrokset ei ole positiivinen kokonaisluku');
  const pohja = a.ydin.replace(/\/+$/, '');
  let key = '';
  try { key = readFileSync(kotiin(a.avain), 'utf8').trim(); } catch { /* ydin hylkää */ }
  const hae = async (polku) => {
    const v = await fetch(`${pohja}${polku}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
    const runko = await v.text();
    if (!v.ok) throw new Error(`${polku}: HTTP ${v.status}`);
    return runko;
  };

  const skoopit = JSON.parse(await hae('/api/skoopit'));
  const nimi = Array.isArray(skoopit) ? skoopit.map((s) => s?.nimi).find((n) => typeof n === 'string') : undefined;
  const mitattavat = [{ polku: '/api/skoopit', raja: a['raja-skoopit'] }];
  if (nimi) mitattavat.push({ polku: `/api/skoopit/${encodeURIComponent(nimi)}/viestit`, raja: a['raja-viestit'], nayta: '/api/skoopit/<nimi>/viestit' });

  let tulos = 0;
  for (const m of mitattavat) {
    const ajat = [];
    for (let i = 0; i < kierrokset; i++) {
      const alku = performance.now();
      await hae(m.polku);
      ajat.push(performance.now() - alku);
    }
    ajat.sort((x, y) => x - y);
    const p50 = prosentti(ajat, 0.5);
    const nayta = m.nayta ?? m.polku;
    console.log(`P50 ${nayta} ${ms(p50)}`);
    console.log(`P90 ${nayta} ${ms(prosentti(ajat, 0.9))}`);
    if (m.raja != null && !(p50 < Number(m.raja))) {
      console.log(`RAJA YLITTYI ${nayta}: p50 ${ms(p50)} ≥ ${m.raja}`);
      tulos = 1;
    }
  }
  process.exitCode = tulos;
}

main().catch((e) => { console.error(`mittaa-latenssi: ${e.message}`); process.exit(2); });
