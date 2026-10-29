// kopio: scopes/palvelu/agy-kayttoraja.mjs @ f5fc3d36 (21.10.2026); muuttuneet vain import-rivit
// AGY-käyttörajat äpin renkaille (AGY-USAGE-PALVELU 17.10.2026, AGY-USAGE-CLI):
// Kiintiötiedot (gemini 5h, 3p 5h, 3p viikko, gemini viikko) saadaan suoraan Antigravity CLI:n
// TUI-statuslinelta ilman suoria API-kutsuja. CLI tallentaa tilan ~/.local/state/scopes-agy-kayttoraja.json
// -tiedostoon, josta palvelu lukee sen muistiin ja palauttaa äpille.
// Google-malleille toinen raja on päivittäinen pyyntömäärä suhteessa 1500 pyynnön vuorokausirajaan
// (nollautuu klo 07:00 UTC / 10:00 Suomen aikaa).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MAKSIMI_PYYNNOT = 1500;
export const TILA_TIEDOSTO = join(homedir(), '.local/state/scopes-agy-kayttoraja.json');
const PY_CACHE_MS = 30_000;

// Nollautumishetki ISO-muotoon: päätepisteen mikrosekunnit tai Z-muoto siivotaan iOS-yhteensopivaksi.
const iso = (t) => (t && Number.isFinite(Date.parse(t)) ? new Date(t).toISOString() : null);

export function muunnaRaja(bucket) {
  if (!bucket) return null;
  const remaining = Number(bucket.remainingFraction ?? bucket.remaining_fraction);
  if (!Number.isFinite(remaining)) return null;
  const kaytto = Math.max(0, Math.min(100, Math.round((1 - remaining) * 10000) / 100));
  return { kaytto, nollautuu: iso(bucket.resetTime ?? bucket.reset_time) };
}

export function pacificResetAika(nytMs = Date.now()) {
  const d = new Date(nytMs);
  const paiva = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const offsetPart = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value;
  const offsetTunnit = parseInt(offsetPart?.replace('GMT', '') || '-7', 10);
  const keskiyoUtc = Date.UTC(
    parseInt(paiva.slice(0, 4), 10),
    parseInt(paiva.slice(5, 7), 10) - 1,
    parseInt(paiva.slice(8, 10), 10),
    -offsetTunnit,
    0,
    0,
    0
  );
  const seuraavaResetUtc = keskiyoUtc + 24 * 3600 * 1000;
  return { resetAika: keskiyoUtc, seuraavaReset: new Date(seuraavaResetUtc).toISOString() };
}

let pyyntoMuisti = null;

export function laskePyyntomaara({
  nytMs = Date.now(),
  brainDir = join(homedir(), '.gemini/antigravity-cli/brain'),
  maksimi = MAKSIMI_PYYNNOT,
  valiMs = PY_CACHE_MS,
} = {}) {
  if (pyyntoMuisti && (nytMs - pyyntoMuisti.aika) < valiMs && pyyntoMuisti.brainDir === brainDir) {
    return pyyntoMuisti.tulos;
  }

  const { resetAika, seuraavaReset } = pacificResetAika(nytMs);
  let maara = 0;
  try {
    const kansiot = readdirSync(brainDir);
    for (const cid of kansiot) {
      const p = join(brainDir, cid, '.system_generated/logs/transcript.jsonl');
      let stat;
      try { stat = statSync(p); } catch { continue; }
      if (stat.mtimeMs < resetAika) continue;

      const content = readFileSync(p, 'utf8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const step = JSON.parse(line);
          if (!step.created_at) continue;
          const t = new Date(step.created_at).getTime();
          if (t < resetAika) break;
          if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') maara++;
        } catch {}
      }
    }
  } catch {}

  const kaytto = Math.max(0, Math.min(100, Math.round((maara / maksimi) * 10000) / 100));
  const tulos = {
    kaytto,
    nollautuu: seuraavaReset,
    teksti: `${maara} / ${maksimi}`,
    otsikko: 'Sisempi punainen, pyynnöt',
    maara,
    maksimi,
  };

  pyyntoMuisti = { aika: nytMs, brainDir, tulos };
  return tulos;
}

export function etsiRyhma(groups, ryhma = 'gemini') {
  if (!Array.isArray(groups) || !groups.length) return null;
  const haku = String(ryhma).toLowerCase();
  if (haku === '3p' || haku === 'claude' || haku === 'gpt') {
    return groups.find((g) => g.buckets?.some((b) => b.bucketId?.startsWith('3p'))) ?? groups[0];
  }
  return (
    groups.find((g) => g.displayName?.toLowerCase().includes('gemini') || g.buckets?.some((b) => b.bucketId?.startsWith('gemini'))) ??
    null
  );
}

export function poimi5h(buckets, ryhma = 'gemini') {
  if (!Array.isArray(buckets) || !buckets.length) return null;
  const haku = String(ryhma).toLowerCase();
  if (haku === '3p' || haku === 'claude' || haku === 'gpt') {
    return buckets.find((b) => b.modelId?.startsWith('claude') || b.modelId?.startsWith('gpt')) ?? null;
  }
  return buckets.find((b) => b.modelId?.startsWith('gemini')) ?? buckets[0];
}

export function lueAgyTila(polku = TILA_TIEDOSTO) {
  try {
    if (!existsSync(polku)) return null;
    return JSON.parse(readFileSync(polku, 'utf8'));
  } catch {
    return null;
  }
}

export function luoAgyKayttoraja({
  tilaTiedosto = TILA_TIEDOSTO,
  brainDir = join(homedir(), '.gemini/antigravity-cli/brain'),
  laskePyynnot = laskePyyntomaara,
  nyt = Date.now,
} = {}) {
  let viimMtime = 0;
  let oma = null;

  function tarkistaTila() {
    try {
      if (existsSync(tilaTiedosto)) {
        const s = statSync(tilaTiedosto);
        if (s.mtimeMs !== viimMtime || !oma) {
          viimMtime = s.mtimeMs;
          oma = JSON.parse(readFileSync(tilaTiedosto, 'utf8'));
        }
      }
    } catch {}
  }

  // Alustetaan heti levyltä jos tiedosto on jo olemassa
  tarkistaTila();

  const voimassa = (r) => (r && r.nollautuu && Date.parse(r.nollautuu) <= nyt() ? { ...r, kaytto: 0, nollautuu: null } : r ?? null);

  return async function agyKayttoraja({ ryhma = 'gemini' } = {}) {
    tarkistaTila();
    const kohde = ryhma === '3p' ? oma?.kolmasOsapuoli : oma?.gemini;

    // Päivitetään pyyntömäärä tarvittaessa
    let viikko = kohde?.viikko ?? null;
    if (ryhma !== '3p') {
      try {
        const p = laskePyynnot({ nytMs: nyt(), brainDir });
        if (p) viikko = p;
      } catch {}
    }

    return {
      viikko: voimassa(viikko),
      viisiTuntia: voimassa(kohde?.viisiTuntia),
      haettu: oma ? new Date(oma.haettu ?? viimMtime ?? nyt()).toISOString() : null,
      paivitetty: oma?.paivitetty ?? null,
      lahde: oma?.lahde ?? 'levy',
    };
  };
}
