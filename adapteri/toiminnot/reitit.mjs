// Toimintoreittien kokoaminen (T-63-G, S-10): jokainen moduuli vie REITIT = [{ metodi, kuvio, toteutettu, kasittele }].
// kuvio: polku, jossa "*" = yksi polun osa ja loppu "/**" = etuliite. kasittele(req, res, osat, ymp): osat = "*"-osat
// URL-purettuina, "/**"-kuviossa viimeisenä loppupolku. Myöhemmät tehtävät (T-66…T-69, T-80…T-83, T-85, T-86) muuttavat vain oman moduulinsa taulukkoa.
import * as agentit from './agentit.mjs';
import * as android from './android.mjs';
import * as asetukset from './asetukset.mjs';
import * as chat from './chat.mjs';
import * as istunto from './istunto.mjs';
import * as linux from './linux.mjs';
import * as malli from './malli.mjs';
import * as pura from './pura.mjs';
import * as uusi from './uusi.mjs';
import * as viestit from './viestit.mjs';

// T-79-G: ARK-16:n lisäksi malli, uusi, agentit, asetukset (ARK-16-loput) sekä android ja linux (ARK-19). Moduulin voi
// viedä myös valinnaisen koukun `kaynnista(ymp) → { pysayta() }` (taustasilmukat); palvelin kutsuu sen kuuntelun alussa.
const NIMET = { viestit, istunto, pura, chat, malli, uusi, agentit, asetukset, android, linux };

export const MODUULIT = Object.fromEntries(Object.entries(NIMET).map(([nimi, m]) => [nimi, m.REITIT]));
export const KAIKKI = Object.values(MODUULIT).flat();

// Moduulien kaynnista-koukut [{ nimi, kaynnista }] moduulijärjestyksessä (moduulit = nimiavaruudet, testeissä korvattavissa).
export const koukut = (moduulit = NIMET) => Object.entries(moduulit).filter(([, m]) => typeof m.kaynnista === 'function').map(([nimi, m]) => ({ nimi, kaynnista: m.kaynnista }));
export const KOUKUT = koukut();

// Kuvion tasmays polkuun → osat-taulukko tai null. Kuvion osat ja polun osat verrataan kokonaisina (ei osittain).
export function tasmaa(kuvio, polku) {
  const k = kuvio.split('/');
  const p = polku.split('/');
  const etuliite = k[k.length - 1] === '**';
  if (etuliite ? p.length < k.length : p.length !== k.length) return null;
  const osat = [];
  for (let i = 0; i < k.length; i++) {
    if (etuliite && i === k.length - 1) { osat.push(p.slice(i).map(decodeURIComponent).join('/')); break; }
    if (k[i] === '*') { if (p[i] === '') return null; osat.push(decodeURIComponent(p[i])); } else if (k[i] !== p[i]) return null;
  }
  return osat;
}

// Ensimmäinen reitti, jonka metodi ja kuvio täsmäävät → { reitti, osat } tai null.
export function etsi(reitit, metodi, polku) {
  for (const reitti of reitit) {
    if (reitti.metodi !== metodi) continue;
    const osat = tasmaa(reitti.kuvio, polku);
    if (osat) return { reitti, osat };
  }
  return null;
}

// Terveyslistan rivit: vain toteutetut reitit, "METODI kuvio".
export const toteutetut = (reitit) => reitit.filter((r) => r.toteutettu).map((r) => `${r.metodi} ${r.kuvio}`);
