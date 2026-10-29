// Transkriptipeili ytimeen (S-5a, T-24): lisätyt rivit POST <ydin>/api/peili, 409 → jatketaan ytimen offsetista,
// ytimen ollessa poissa rivit jonoon ja uusinta 5 s välein. Avainta ei koskaan lokiteta.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import { lueLisays, transkriptiValimuisti } from './transkriptit.mjs';

export const UUSINTA_MS = 5000;
const AIKARAJA_MS = 15000;
const TOIPUMISIA = 3;
// Muistijonon yläraja tavuina: rajan yli rivejä ei pidetä muistissa, vaan offset palautetaan ja levy toimii jonona
// (T-34 ajo 2: rajaton jono ajoi 512 MB:n keon täyteen, kun yksi lähetys epäonnistui).
export const JONORAJA = 8 * 1024 * 1024;
// Yhden POST-rungon yläraja (JSON-merkkeinä): ytimen axum hylkää yli 2 MB:n rungon 413:lla (T-34 ajo 2).
export const ERARAJA = 1_500_000;
// 413:n jälkeen samaa tiedostoa ei yritetä ennen tätä (kasvaa kerroittain, enintään 10 min).
export const HYLATTY_TAUKO_MS = 60_000;

const kotiin = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);

// Rivien tiiviste: sha256 (hex) täsmälleen niistä tavuista, jotka lisätään ytimen kopioon (rivit rivinvaihtoineen).
export const tiiviste = (rivit) => createHash('sha256').update(rivit.map((r) => `${r}\n`).join('')).digest('hex');

// Rivit eriksi, joiden JSON-runko pysyy ERARAJA:n alla (vähintään yksi rivi per erä) → [{ offset, rivit, tavut }].
// tavut = rivien tavut rivinvaihtoineen (seuraavan erän offset ja jonon koko).
export function erat(alku, rivit, raja = ERARAJA) {
  const tulos = [];
  let nyky = { offset: alku, rivit: [], tavut: 0 };
  let merkit = 200;
  for (const r of rivit) {
    const m = JSON.stringify(r).length + 1;
    if (nyky.rivit.length && merkit + m > raja) {
      tulos.push(nyky);
      nyky = { offset: nyky.offset + nyky.tavut, rivit: [], tavut: 0 };
      merkit = 200;
    }
    nyky.rivit.push(r);
    nyky.tavut += Buffer.byteLength(r) + 1;
    merkit += m;
  }
  if (nyky.rivit.length) tulos.push(nyky);
  return tulos;
}

export function luoPeili({
  ydin = process.env.SCOPES2_YDIN ?? 'http://127.0.0.1:8797',
  avainTiedosto = '~/.config/scopes2/avain',
  projektitDir,
  fetch = globalThis.fetch,
  nyt = Date.now,
  valimuisti = transkriptiValimuisti,
  loki = (rivi) => process.stderr.write(`${rivi}\n`),
} = {}) {
  const pohja = ydin.replace(/\/+$/, '');
  const lueAvain = () => { try { return readFileSync(kotiin(avainTiedosto), 'utf8').trim(); } catch { return ''; } };
  let avain = lueAvain();
  const odottavat = []; // [{ polku, tiedosto, offset, rivit }]
  let seuraavaYritys = 0;
  let suljettu = false;

  const tiedostoksi = (polku) => relative(projektitDir, polku).split('\\').join('/');
  const offsetUrl = (tiedosto) => `${pohja}/api/peili/${tiedosto.split('/').map(encodeURIComponent).join('/')}/offset`;

  // Yksi pyyntö; 401 → avain luetaan uudelleen ja yritetään kerran. Yhteysvirhe → null.
  async function pyynto(url, asetukset = {}) {
    for (let kerta = 0; kerta < 2; kerta++) {
      let vastaus;
      try {
        vastaus = await fetch(url, {
          ...asetukset,
          headers: { ...(asetukset.headers ?? {}), Authorization: `Bearer ${avain}` },
          signal: AbortSignal.timeout(AIKARAJA_MS),
        });
      } catch {
        return null;
      }
      if (vastaus.status === 401 && kerta === 0) { await vastaus.body?.cancel(); avain = lueAvain(); continue; }
      let runko = null;
      try { runko = await vastaus.json(); } catch { /* ei JSON-runkoa */ }
      return { tila: vastaus.status, runko };
    }
    return null; // ei saavuteta
  }

  // POST S-5a → { tila: 200 | 409 | 401 | <muu> | 'poissa', offset? }.
  async function laheta(tiedosto, offset, rivit) {
    const v = await pyynto(`${pohja}/api/peili`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tiedosto, offset, rivit, sha256: tiiviste(rivit) }),
    });
    if (!v) return { tila: 'poissa' };
    if (v.tila === 200) loki(`peili ${tiedosto} +${rivit.length} → ${v.runko?.offset}`);
    else if (v.tila !== 409) loki(`peili ${tiedosto} +${rivit.length} hylätty ${v.tila}`);
    return { tila: v.tila, offset: v.runko?.offset };
  }

  // GET ytimen offset → välimuistiin (koko tuntematon, joten seuraava lueLisays lukee). null = ydin poissa tai virhe.
  async function alusta(polku) {
    const v = await pyynto(offsetUrl(tiedostoksi(polku)));
    if (!v) return null;
    const offset = v.tila === 200 && Number.isInteger(v.runko?.offset) ? v.runko.offset : v.tila === 404 ? 0 : null;
    if (offset == null) return null;
    valimuisti.set(polku, { koko: -1, mtimeMs: -1, offset });
    return offset;
  }

  let jonossa = 0; // odottavien rivien tavut
  const hylatyt = new Map(); // polku → { kerrat, seuraava }: 413-tauko

  const jonoon = (polku, tiedosto, e) => {
    odottavat.push({ polku, tiedosto, offset: e.offset, rivit: e.rivit, tavut: e.tavut });
    jonossa += e.tavut;
    if (!seuraavaYritys) seuraavaYritys = nyt() + UUSINTA_MS;
  };
  const otaJonosta = () => { const e = odottavat.shift(); jonossa -= e.tavut; return e; };
  // Lukematta jätetyt rivit: seuraava lueLisays aloittaa tästä (koko tuntematon → luetaan).
  const palauta = (polku, offset) => valimuisti.set(polku, { koko: -1, mtimeMs: -1, offset });

  // Jonon purku vanhimmasta alkaen; ytimen ollessa yhä poissa uusi yritys UUSINTA_MS:n päästä.
  async function pura() {
    if (!odottavat.length) { seuraavaYritys = 0; return true; }
    if (nyt() < seuraavaYritys) return false;
    while (odottavat.length) {
      const e = odottavat[0];
      const t = await laheta(e.tiedosto, e.offset, e.rivit);
      if (t.tila === 'poissa') { seuraavaYritys = nyt() + UUSINTA_MS; return false; }
      otaJonosta();
      if (t.tila !== 200) {
        // 409 tai hylätty: saman tiedoston jonotetut rivit pois ja luetaan levyltä uudelleen (409: ytimen offsetista).
        let pienin = e.offset;
        for (let i = odottavat.length - 1; i >= 0; i--) {
          if (odottavat[i].polku !== e.polku) continue;
          pienin = Math.min(pienin, odottavat[i].offset);
          jonossa -= odottavat[i].tavut;
          odottavat.splice(i, 1);
        }
        palauta(e.polku, t.tila === 409 && Number.isInteger(t.offset) ? t.offset : pienin);
        if (t.tila === 413) merkitseHylatty(e.polku);
        else if (t.tila === 409) await kasittele(e.polku);
        if (odottavat.length && nyt() < seuraavaYritys) return false;
      }
    }
    seuraavaYritys = 0;
    return true;
  }

  function merkitseHylatty(polku) {
    const h = hylatyt.get(polku) ?? { kerrat: 0, seuraava: 0 };
    h.kerrat += 1;
    h.seuraava = nyt() + Math.min(HYLATTY_TAUKO_MS * h.kerrat, 10 * 60_000);
    hylatyt.set(polku, h);
  }

  // Tiedoston lisäys ytimeen erinä. Palauttaa lähetettyjen rivien määrän (jonoon menneet eivät lasketa).
  async function kasittele(polku) {
    if (suljettu) return 0;
    const h = hylatyt.get(polku);
    if (h && nyt() < h.seuraava) return 0;
    const tiedosto = tiedostoksi(polku);
    let lahetetty = 0;
    let toipumisia = 0;
    for (;;) {
      let r;
      try { r = lueLisays(polku, valimuisti); } catch { return lahetetty; } // tiedosto poistui
      if (r.luettu === 0) return lahetetty;
      const jaljella = erat(r.alku, r.rivit);
      let uudelleen = false;
      while (jaljella.length) {
        const e = jaljella[0];
        if (odottavat.length) {
          // Järjestys säilyy: uudet erät jonon perään (jos mahtuvat), ja jono puretaan ensin.
          if (jonossa + e.tavut > JONORAJA) { palauta(polku, e.offset); return lahetetty; }
          jonoon(polku, tiedosto, jaljella.shift());
          continue;
        }
        const t = await laheta(tiedosto, e.offset, e.rivit);
        if (t.tila === 200) { lahetetty += e.rivit.length; jaljella.shift(); continue; }
        if (t.tila === 'poissa') {
          // Ydin poissa: erä jonoon, jos mahtuu; muuten levy on jono.
          if (jonossa + e.tavut > JONORAJA) { palauta(polku, e.offset); return lahetetty; }
          jonoon(polku, tiedosto, jaljella.shift());
          continue;
        }
        if (t.tila === 409 && toipumisia < TOIPUMISIA) {
          // Ydin on eri kohdassa: luetaan levyltä ytimen offsetista.
          toipumisia += 1;
          const ytimen = Number.isInteger(t.offset) ? t.offset : await alusta(polku);
          if (ytimen == null) { palauta(polku, e.offset); return lahetetty; }
          palauta(polku, ytimen);
          uudelleen = true;
          break;
        }
        // 413, 401 avaimen uudelleenluvun jälkeen tai muu hylkäys: rivit luetaan uudelleen myöhemmin.
        palauta(polku, e.offset);
        if (t.tila === 413) merkitseHylatty(polku);
        return lahetetty;
      }
      if (odottavat.length && !(await pura())) return lahetetty;
      if (!uudelleen && !r.kesken) return lahetetty;
    }
  }

  return {
    laheta,
    kasittele,
    alusta,
    pura,
    jono: () => odottavat.map(({ tiedosto, offset, rivit }) => ({ tiedosto, offset, rivit })),
    jonoTavut: () => jonossa,
    hylatyt: () => [...hylatyt.values()].reduce((s, h) => s + h.kerrat, 0),
    sulje: () => { suljettu = true; },
  };
}
