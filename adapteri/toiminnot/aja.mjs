// Toimintojen suorittaja ja virheluokka (T-63-G, ARK-16). Ajonaikainen koodi ei tuo mitään scopes/-polusta (gate.sh:n tuontitarkistus).
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// kopio: scopes/palvelu/toiminnot.mjs:32-73 (21.10.2026)
// 1–12 sanaa (SIIRTO-SYVAT-ALASKOOPIT 13.10.2026: alaskoopit vähintään 10 sanan syvyyteen).
export const UUSI_NIMI = /^[a-z0-9][a-z0-9-]{0,23}( [a-z0-9][a-z0-9-]{0,23}){0,11}$/;

// Purkutiedoston nimi: sama sääntö kuin pura-malliton.mjs:n `slug` (testi tarkistaa yhtäläisyyden).
export const mallitonSlug = (skooppi) => skooppi.trim().replace(/\s+/g, '-');

export class Hylatty extends Error {
  constructor(koodi, viesti) { super(viesti); this.koodi = koodi; }
}

// Oletusajaja: execFile ilman kuorta. PATH:iin ~/.local/bin, koska cron käynnistää palvelun suppealla PATH:lla.
// syote kirjoitetaan stdiniin (chat: viesti ei kulje komentorivillä); cwd valinnainen.
// riville (DEMO-SCOPES-SUORATOISTO): kutsutaan jokaiselle valmiille stdout-riville jo ajon aikana; signal katkaisee.
export function ajaKomento(komento, argumentit, { aikaraja = 150_000, syote = null, cwd, riville, signal, puskuri = 4 << 20 } = {}) {
  const env = { ...process.env, PATH: `${join(homedir(), '.local/bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` };
  delete env.CLAUDE_CODE_SESSION_ID; // autovaihto.sh ei saa lukea kutsujan istuntoa
  delete env.TMUX_PANE;
  return new Promise((ok) => {
    const lapsi = execFile(komento, argumentit, { env, cwd, signal, timeout: aikaraja, maxBuffer: puskuri }, (virhe, stdout, stderr) =>
      ok({ koodi: virhe ? (typeof virhe.code === 'number' ? virhe.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) }));
    if (riville) {
      let kesken = '';
      lapsi.stdout.setEncoding('utf8');
      lapsi.stdout.on('data', (pala) => {
        const rivit = (kesken + pala).split('\n');
        kesken = rivit.pop();
        for (const r of rivit) if (r) riville(r);
      });
    }
    lapsi.stdin.on('error', () => { /* lapsi sulki stdinin; tulos tulee callbackista */ });
    lapsi.stdin.end(syote ?? '');
  });
}

// autovaihto.sh:n tulosteesta Remote Control -osoite (OK: <url>).
export const istuntoOsoite = (stdout) => /^OK: (https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+)$/m.exec(stdout)?.[1] ?? null;
// Paikallisen mallin istunnolla ei ole Remote Controlia (autovaihto.sh, 15.10.2026): OK-rivi nimeää tmux-istunnon.
// Agy-istunto (AGY-PRE-ISTUNTO 16.10.2026) on samanlainen: tmux, ei Remote Controlia.
export const paikallinenTmux = (stdout) => /^OK: (?:paikallinen|agy|mac-agy|nebius) tmux (siirto-[a-z0-9-]+)$/m.exec(stdout)?.[1] ?? null;
export const MAC_AGY_MALLI = 'mac-agy/';
// Istunnon malli `agy/<agy-mallin tunnus>` ajaa istunnon agy:llä (autovaihto.sh); agy ei aja Clauden /pura-taitoa, joten se
// kuuluu vain scopes-perheelle, jonka purku on skripti (pura-malliton.mjs --kohde neutraali).
export const AGY_MALLI = 'agy/';

// Yhteinen toimintolukko (T-68, ARK-16; koordinaattori 21.10.2026): vanhan luoToiminnot-sulkeuman yksi `kaynnissa`
// (scopes/palvelu/toiminnot.mjs:92 ja :340-354) kattaa pura-, uusi- ja istuntotoiminnot (pakkaa, automaattisiirto, herata,
// herata-pois ja niiden jono). Lukko on tilahakemistoa kohden (ymp.tila, oletus ~/.local/state/scopes2 kuten istunto.mjs:n
// jonotiedosto): yksi palvelin = yksi lukko, ja testien palvelimet (eri tila) eivät estä toisiaan.
//   toimintoKaynnissa(ymp)                 käynnissä olevan toiminnon nimi tai null
//   varaaToiminto(ymp, toiminto)           varaa lukon → vapauta(); null, jos toinen toiminto on jo käynnissä
//   yksiToiminto(ymp, toiminto, nimi, f)   vanhan suorita()-rungon lukko-osa: 429 "toinen toiminto on käynnissä (<nimi>)", kun
//                                          lukko on varattu; muuten f() lukossa, toimintolokiin ok/hylätty-rivi (ymp.loki) ja
//                                          vastaus { ok: true, toiminto, nimi, ...tulos }. Tuntemattoman toiminnon 404 tarkistaa kutsuja.
const LUKOT = new Map(); // lukon avain → { toiminto }
const lukonAvain = (ymp) => ymp?.tila ?? join(homedir(), '.local/state/scopes2');

export const toimintoKaynnissa = (ymp) => LUKOT.get(lukonAvain(ymp))?.toiminto ?? null;

export function varaaToiminto(ymp, toiminto) {
  const avain = lukonAvain(ymp);
  if (LUKOT.has(avain)) return null;
  const varaus = { toiminto };
  LUKOT.set(avain, varaus);
  return () => { if (LUKOT.get(avain) === varaus) LUKOT.delete(avain); };
}

export async function yksiToiminto(ymp, toiminto, nimi, f) {
  const kirjaa = (rivi) => { try { ymp.loki?.(rivi); } catch { /* loki ei estä toimintoa */ } };
  const vapauta = varaaToiminto(ymp, toiminto);
  if (!vapauta) { kirjaa({ toiminto, nimi, tulos: 'hylätty', syy: 'toinen toiminto käynnissä' }); throw new Hylatty(429, `toinen toiminto on käynnissä (${toimintoKaynnissa(ymp)})`); }
  try {
    const tulos = await f();
    kirjaa({ toiminto, nimi, tulos: 'ok', ...tulos });
    return { ok: true, toiminto, nimi, ...tulos };
  } catch (e) {
    kirjaa({ toiminto, nimi, tulos: 'hylätty', syy: e.message });
    throw e;
  } finally {
    vapauta();
  }
}
