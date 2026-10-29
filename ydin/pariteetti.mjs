// Pariteettiajo (T-20): sama rekisterikorpus lr.mjs:lle ja ytimen `lr-pariteetti`-binäärille.
//
// Käyttö: node scopes2/ydin/pariteetti.mjs [--otos 50] [--juuri DIR] [--siemen 1] [--binaari POLKU]
//
// 1. Valitsee otoksen korpuksen rekistereistä (lajiteltu polkulista, siemenellä sekoitettu, n ensimmäistä) ja
//    kopioi ne väliaikaishakemistoon; tuotantodataa ei muuteta. Rekisterin teksti = `tulosta(.., {lahde: true})`
//    kopiosta (jos gitin puolta ei ole, yhteinen nykytila).
// 2. Teksti 1 = alkuperäinen, teksti 2 = muunnos (yksi rivi muutettu, yksi poistettu, yksi lisätty; sama molemmille).
//    lr.mjs: tuoRekisteri(teksti 1) + uudelleentuo(teksti 2) tyhjään juureen. Binääri: `lr-pariteetti tuo <polku> <t1> <t2>`.
// 3. Tiivisteen kaava (molemmilla puolilla sama), kun tuonnin jälkeen kaikki rekisterin yksiköt (myös hautakivet):
//      rivi    = id TAB versio TAB poistettu TAB sha256hex(sisalto)
//      versio  = avaimet lajiteltuina "laite=n" pilkulla erotettuna;  poistettu = 0 tai 1
//      tiiviste = sha256hex(lajitellut rivit liitettynä "\n")
//    Binääri tulostaa rivin `<tiiviste> <rekisterinTiiviste>`; jälkimmäinen on lr.mjs:n `rekisterinTiiviste`
//    (id+versiot+meta) vastaavalta Rust-puolelta. Tapaus on pariteetissa, kun koko rivi on sama.
// 4. Tulostaa `PARITEETTI: <n>/<otos>` ja eroavat polut; exit 0 vain kun n == otos.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { luoLaite, lueYksikot, rekisterinTiiviste, rekisterit, tulosta, tuoRekisteri, uudelleentuo } from '../../scopes/localregister/lr.mjs';

const kansio = dirname(fileURLToPath(import.meta.url));
const NYT = '2026-10-19T00:00:00.000Z';
const LAITE = 'pariteetti';
const LAHDE = { commit: 'pariteetti' };

const sha = (s) => createHash('sha256').update(s).digest('hex');
const vektori = (v) => Object.keys(v).sort().map((k) => `${k}=${v[k]}`).join(',');

function asetukset(argv) {
  const a = { otos: 50, juuri: join(homedir(), '.local/share/localregister/rekisterit'), siemen: 1, binaari: join(kansio, 'target/debug/lr-pariteetti') };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (!(k in a) || argv[i + 1] === undefined) throw new Error(`virheellinen valitsin: ${argv[i]}`);
    a[k] = ['otos', 'siemen'].includes(k) ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!Number.isInteger(a.otos) || a.otos < 1 || !Number.isInteger(a.siemen)) throw new Error('--otos ja --siemen ovat kokonaislukuja');
  return a;
}

// mulberry32: deterministinen satunnaisluku siemenestä.
function satunnainen(siemen) {
  let s = siemen >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function otos(polut, n, siemen) {
  const lista = [...polut].sort();
  const rnd = satunnainen(siemen);
  for (let i = lista.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [lista[i], lista[j]] = [lista[j], lista[i]];
  }
  return lista.slice(0, n);
}

// Muunnos: rivi 1/4 muutetaan, rivi 1/2 poistetaan, rivin 3/4 jälkeen lisätään uusi rivi.
function muunna(teksti) {
  const rivit = teksti.match(/[^\n]*\n|[^\n]+$/g) || [];
  const n = rivit.length;
  const i1 = Math.floor(n / 4), i2 = Math.floor(n / 2), i3 = Math.floor((3 * n) / 4);
  const ulos = rivit.slice();
  if (n >= 3 && i1 < i2 && i2 < i3) {
    ulos.splice(i3 + 1, 0, 'Pariteettitestin lisäämä rivi\n');
    ulos.splice(i2, 1);
    ulos[i1] = ulos[i1].replace(/\n?$/, ' MUOKATTU$&');
  } else {
    ulos.push('Pariteettitestin lisäämä rivi\n');
  }
  return ulos.join('');
}

function tiiviste(juuri, polku) {
  const rivit = lueYksikot(juuri, polku)
    .map((y) => `${y.id}\t${vektori(y.versio)}\t${y.poistettu ? 1 : 0}\t${sha(y.sisalto)}`)
    .sort();
  return `${sha(rivit.join('\n'))} ${rekisterinTiiviste(juuri, polku)}`;
}

function jsPuoli(tmp, polku, t1, t2) {
  const juuri = mkdtempSync(join(tmp, 'js-'));
  const laite = luoLaite(juuri, LAITE);
  tuoRekisteri(juuri, laite, polku, t1, LAHDE, NYT);
  uudelleentuo(juuri, laite, polku, t2, LAHDE, NYT);
  return tiiviste(juuri, polku);
}

function rustPuoli(a, tmp, indeksi, polku, t1, t2) {
  const f1 = join(tmp, `t1-${indeksi}.txt`), f2 = join(tmp, `t2-${indeksi}.txt`);
  writeFileSync(f1, t1);
  writeFileSync(f2, t2);
  return execFileSync(a.binaari, ['tuo', polku, f1, f2], { encoding: 'utf8', timeout: 60_000 }).trim();
}

function main(argv) {
  const a = asetukset(argv);
  if (!existsSync(a.binaari)) throw new Error(`binääriä ei ole: ${a.binaari} (cargo build --bin lr-pariteetti)`);
  const polut = otos(rekisterit(dirname(a.juuri)), a.otos, a.siemen);
  const tmp = mkdtempSync(join(tmpdir(), 'pariteetti-'));
  try {
    // rekisterit() odottaa juurta, jonka alla on rekisterit/; kopioidaan otos samaan muotoon.
    const kopio = join(tmp, 'korpus');
    mkdirSync(join(kopio, 'rekisterit'), { recursive: true });
    for (const p of polut) cpSync(join(a.juuri, p), join(kopio, 'rekisterit', p), { recursive: true });
    let sama = 0;
    const erot = [];
    polut.forEach((polku, i) => {
      let t1 = tulosta(kopio, polku, { lahde: true });
      if (t1 === '') t1 = tulosta(kopio, polku);
      const t2 = muunna(t1);
      let js, rust;
      try { js = jsPuoli(tmp, polku, t1, t2); } catch (e) { js = `VIRHE ${e.message}`; }
      try { rust = rustPuoli(a, tmp, i, polku, t1, t2); } catch (e) { rust = `VIRHE ${String(e.stderr || e.message).trim()}`; }
      if (js === rust && !js.startsWith('VIRHE')) sama++;
      else erot.push(`${polku}\n  lr.mjs: ${js}\n  rust:   ${rust}`);
    });
    console.log(`PARITEETTI: ${sama}/${polut.length}`);
    for (const e of erot) console.log(`ERO ${e}`);
    return sama === a.otos && polut.length === a.otos ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`VIRHE: ${e.message}`);
  process.exitCode = 1;
}
