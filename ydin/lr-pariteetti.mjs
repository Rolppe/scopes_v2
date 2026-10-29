// LR-pariteettiajo tuotantodatalla (T-33): LR 1:n ja ytimen rekisteritekstit ja git-vienti identtisiä.
//
// Käyttö: node scopes2/ydin/lr-pariteetti.mjs [--vanha URL] [--ydin URL] [--vanha-avain TIEDOSTO] [--ydin-avain TIEDOSTO]
//         [--etuliite scopes/] [--data DIR] [--binaari POLKU] [--juuri LR-JUURI]
// Oletukset: vanha http://127.0.0.1:8787, ydin http://127.0.0.1:8797, avaimet ~/.config/scopes/avain ja
// ~/.config/scopes2/avain, etuliite scopes/, data ~/.local/share/scopes2-ydin, binääri target/release/scopes-solmu.
// Ympäristö (valvojan koeydin): LR_PARITEETTI_YDIN, LR_PARITEETTI_YDIN_AVAIN, LR_PARITEETTI_DATA.
//
// 1. GET <vanha>/api/lr/tiiviste → polut; odottaa enintään 60 s, että ytimen tiivisteessä on samat polut.
// 2. Jokaiselle polulle GET /api/lr/teksti/<polku> molemmista → tavuvertailu; yksiköt = vanhan POST /api/lr/listat
//    -vastauksen yksikkömäärä (lukeva kutsu).
// 3. Vienti: lr.mjs:n vientiteksti vs. `scopes-solmu lr vie --kuiva --etuliite E --data D` (stdout:
//    "<polku>\n<teksti>\n\0" per rekisteri). lr.mjs `vie()` kirjoittaa gitiin eikä ole jaettavissa, joten
//    odotusarvo = `tulosta(juuri, polku)` niistä etuliitteen rekistereistä, joita vie() tarkastelee (ei poistettu,
//    lähde olemassa). Vain luku: lr.mjs:stä tuodaan funktiot, vie()-ajoa ei tehdä.
// 4. Tulostaa `LR-PARITEETTI: <n>/<kaikki> rekisteriä, <yksiköt> yksikköä; VIENTI: <ok>/<m>` ja eroavat polut;
//    exit 0 vain n == kaikki, ok == m ja yksiköt >= 1000. Avaimia ei tulosteta.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lueMeta, OLETUSJUURI, rekisterit, tulosta } from '../../scopes/localregister/lr.mjs';

const kansio = dirname(fileURLToPath(import.meta.url));
const ODOTUS_MS = 60_000;
const LISTAERA = 100;
const MIN_YKSIKOT = 1000;

const koti = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

function asetukset(argv) {
  const e = process.env;
  const a = {
    vanha: 'http://127.0.0.1:8787',
    ydin: e.LR_PARITEETTI_YDIN || 'http://127.0.0.1:8797',
    'vanha-avain': '~/.config/scopes/avain',
    'ydin-avain': e.LR_PARITEETTI_YDIN_AVAIN || '~/.config/scopes2/avain',
    etuliite: 'scopes/',
    data: e.LR_PARITEETTI_DATA || '~/.local/share/scopes2-ydin',
    binaari: join(kansio, 'target/release/scopes-solmu'),
    juuri: OLETUSJUURI,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (!(k in a) || argv[i + 1] === undefined) throw new Error(`virheellinen valitsin: ${argv[i]}`);
    a[k] = argv[i + 1];
  }
  for (const k of ['vanha-avain', 'ydin-avain', 'data', 'binaari', 'juuri']) a[k] = koti(a[k]);
  a.vanha = a.vanha.replace(/\/+$/, '');
  a.ydin = a.ydin.replace(/\/+$/, '');
  return a;
}

function avain(polku) {
  if (!existsSync(polku)) throw new Error(`avaintiedostoa ei ole: ${polku}`);
  return readFileSync(polku, 'utf8').trim();
}

const koodaa = (polku) => polku.split('/').map(encodeURIComponent).join('/');

async function pyynto(osoite, avaimet, polku, runko) {
  const v = await fetch(`${osoite}${polku}`, {
    method: runko === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${avaimet}`, ...(runko === undefined ? {} : { 'content-type': 'application/json' }) },
    body: runko === undefined ? undefined : JSON.stringify(runko),
    signal: AbortSignal.timeout(60_000),
  });
  if (!v.ok) throw new Error(`${osoite}${polku}: HTTP ${v.status}`);
  return v.json();
}

const nuku = (ms) => new Promise((r) => setTimeout(r, ms));

async function odotaYdin(a, vanhaAvain, ydinAvain, polut) {
  const raja = Date.now() + ODOTUS_MS;
  let puuttuu = polut;
  for (;;) {
    try {
      const t = await pyynto(a.ydin, ydinAvain, '/api/lr/tiiviste');
      puuttuu = polut.filter((p) => !(p in t.rekisterit));
      if (!puuttuu.length) return [];
    } catch (e) {
      puuttuu = [`(ydin ei vastaa: ${e.message})`];
    }
    if (Date.now() >= raja) return puuttuu;
    await nuku(2000);
  }
}

async function yksikot(a, vanhaAvain, polut) {
  let n = 0;
  for (let i = 0; i < polut.length; i += LISTAERA) {
    const listat = await pyynto(a.vanha, vanhaAvain, '/api/lr/listat', { rekisterit: polut.slice(i, i + LISTAERA) });
    for (const l of Object.values(listat)) n += l.yksikot?.length ?? 0;
  }
  return n;
}

async function teksti(osoite, avaimet, polku) {
  try {
    return (await pyynto(osoite, avaimet, `/api/lr/teksti/${koodaa(polku)}`)).teksti;
  } catch (e) {
    return { virhe: e.message };
  }
}

// Ensimmäinen eroava rivi (1-pohjainen) kahden tekstin välillä.
function eroRivi(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return `rivi ${i + 1}: vanha=${JSON.stringify((x[i] ?? '<ei riviä>').slice(0, 100))} ydin=${JSON.stringify((y[i] ?? '<ei riviä>').slice(0, 100))}`;
  }
  return 'tavut eroavat';
}

function ytimenVienti(a) {
  const ulos = execFileSync(a.binaari, ['lr', 'vie', '--kuiva', '--etuliite', a.etuliite, '--data', a.data], {
    maxBuffer: 1 << 30,
    timeout: 120_000,
  }).toString('utf8');
  const kartta = new Map();
  for (const osa of ulos.split('\0')) {
    if (osa === '') continue;
    const i = osa.indexOf('\n');
    kartta.set(osa.slice(0, i), osa.slice(i + 1).replace(/\n$/, ''));
  }
  return kartta;
}

function odotettuVienti(a) {
  const kartta = new Map();
  for (const p of rekisterit(a.juuri).filter((r) => r.startsWith(a.etuliite))) {
    const meta = lueMeta(a.juuri, p);
    if (meta.poistettu || !meta.lahde) continue;
    kartta.set(p, tulosta(a.juuri, p));
  }
  return kartta;
}

async function main(argv) {
  const a = asetukset(argv);
  if (!existsSync(a.binaari)) throw new Error(`binääriä ei ole: ${a.binaari} (cargo build --release --bin scopes-solmu)`);
  const vanhaAvain = avain(a['vanha-avain']);
  const ydinAvain = avain(a['ydin-avain']);
  const polut = Object.keys((await pyynto(a.vanha, vanhaAvain, '/api/lr/tiiviste')).rekisterit).sort();
  const puuttuu = await odotaYdin(a, vanhaAvain, ydinAvain, polut);
  if (puuttuu.length) console.log(`HUOM: ydin ei ole synkannut ${puuttuu.length} polkua ${ODOTUS_MS / 1000} s:ssa`);

  const erot = [];
  let sama = 0;
  for (const polku of polut) {
    const [v, y] = await Promise.all([teksti(a.vanha, vanhaAvain, polku), teksti(a.ydin, ydinAvain, polku)]);
    if (typeof v === 'string' && typeof y === 'string') {
      if (Buffer.from(v).equals(Buffer.from(y))) sama++;
      else erot.push(`${polku}: ${eroRivi(v, y)}`);
    } else {
      erot.push(`${polku}: ${typeof v === 'string' ? '' : `vanha ${v.virhe}`} ${typeof y === 'string' ? '' : `ydin ${y.virhe}`}`.replace(/\s+/g, ' ').trim());
    }
  }
  const yks = await yksikot(a, vanhaAvain, polut);

  const odotettu = odotettuVienti(a);
  const saatu = ytimenVienti(a);
  const kaikkiPolut = [...new Set([...odotettu.keys(), ...saatu.keys()])].sort();
  const vientiErot = [];
  let ok = 0;
  for (const p of kaikkiPolut) {
    if (!odotettu.has(p)) vientiErot.push(`VIENTI ${p}: vain ytimessä`);
    else if (!saatu.has(p)) vientiErot.push(`VIENTI ${p}: puuttuu ytimen viennistä`);
    else if (Buffer.from(odotettu.get(p)).equals(Buffer.from(saatu.get(p)))) ok++;
    else vientiErot.push(`VIENTI ${p}: ${eroRivi(odotettu.get(p), saatu.get(p))}`);
  }

  console.log(`LR-PARITEETTI: ${sama}/${polut.length} rekisteriä, ${yks} yksikköä; VIENTI: ${ok}/${kaikkiPolut.length}`);
  for (const e of erot) console.log(`ERO ${e}`);
  for (const e of vientiErot) console.log(`ERO ${e}`);
  return sama === polut.length && ok === kaikkiPolut.length && yks >= MIN_YKSIKOT ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (koodi) => { process.exitCode = koodi; },
  (e) => { console.error(`VIRHE: ${e.message}`); process.exitCode = 1; },
);
