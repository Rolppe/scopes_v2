// kopio: scopes/palvelu/purkajat.mjs @ 507a61f1 (21.10.2026); muuttuneet vain import-rivit
// Purun mallivalinta (SCOPES-PURA-MALLI 15.10.2026; käyttäjä: "varmistusviestin yhteydessä pitää olla malli valinta.
// Tässä pitää olla myös agy ja paikalliset mallit saatavilla claude agenttien lisäksi"). Kaksi valintaa:
//   purkaja — kuka ajaa purkuvaiheen: /pura-argumentin `--ajaja=<moottori>[:<malli>]` (aja-siirtaja.sh) — Claude-mallit
//             claude -p:llä, siirtaja-sonnet-agentti, agy:n mallit (`agy models`) ja palvelimen LM Studio -mallit
//             (vaihesilmukka.mjs:n paikallinen-sovitin); tyhjä = claude/siirto/ajaja.json
//   malli   — uuden Claude Code -istunnon malli (autovaihto.sh --model): Claude-mallit tai palvelimen LM Studio -mallit
//             (palvelin/<id>; käyttäjä 15.10.2026: "Paikalliset mallit pitää saada myös keskustelun ajoon"). Paikallinen
//             istunto ei saa Remote Controlia, joten se näkyy vain äpin skoopin viesteissä.
// Turvamalli (toiminnot.mjs): puhelin lähettää vain tunnuksen, jonka on oltava tämän listan jäsen; muu on 400.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGY_MALLI, MAC_AGY_MALLI, ajaKomento, Hylatty } from '../toiminnot/aja.mjs';
import { MALLIT, PAIKALLINEN } from './viestit-vakiot.mjs';

export const AGENTTI = 'siirtaja-sonnet';
const AGY_TUNNUS = /^[a-z0-9][a-z0-9.-]*$/;
const AGY_VALIMUISTI_MS = 10 * 60_000;

// `agy models` → [{ id, nimi }]; otsikkorivi ("Fetching available models...") ja muut muodot pois.
export function agyMallit(stdout) {
  return String(stdout ?? '').split('\n').map((r) => r.split('\t')).filter(([id, nimi]) => AGY_TUNNUS.test(id ?? '') && nimi?.trim())
    .map(([id, nimi]) => ({ id, nimi: nimi.trim() }));
}

// Nebius Token Factory -istuntomallit (autovaihto.sh --model nebius/<id>, nebius-valitys.mjs; käyttäjä 18.10.2026). Valikoitu
// lista Nebiuksen /v1/models-listasta (28 mallia 18.10.2026): Claude Code -agenttitesti piilotesteineen 14/14 läpi, järjestys
// hinta-laatusuhteen mukaan (NEBIUS-MALLIT 18.10.2026). Pois: Qwen3-30B ja Qwen3.8-27B (jumiutuivat), Qwen3-235B ja Gemma 3.
// Näkyy vain, kun avain on annettu (äpin Asetukset → Nebius).
export const NEBIUS_MALLI = 'nebius/';
export const NEBIUS_MALLIT = [
  { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', kuvaus: 'DeepSeek V4 Flash · Nebius (edullisin)' },
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash', kuvaus: 'DeepSeek V4.1 Flash · Nebius' },
  { id: 'MiniMaxAI/MiniMax-M3', kuvaus: 'MiniMax M3 · Nebius' },
  { id: 'moonshotai/Kimi-K2.7-Code', kuvaus: 'Kimi K2.7 Code · Nebius' },
  { id: 'deepseek-ai/DeepSeek-V4-Pro-0813', kuvaus: 'DeepSeek V4 Pro · Nebius (vaativa)' },
];

export function luoPurkajat({ juuri, paikalliset = async () => [], aja = ajaKomento, nyt = Date.now, nebiusTiedosto = join(homedir(), '.config/scopes/nebius-avain') } = {}) {
  // Vanhentunut agy-lista palautetaan heti ja päivitetään taustalla; vain ensimmäinen haku odottaa. Kylmä välimuisti
  // odotutti koko listaa, myös istunnon malleja, joihin agy ei kuulu (käyttäjä 15.10.2026: "Näkyy mutta tuli viiveellä";
  // pyyntöloki 14:05Z /api/purkajat 6 538 ms, lämpimänä 0–3 ms).
  let agy = { aika: -Infinity, mallit: [], haku: null };
  function paivitaAgy() {
    agy.haku ??= aja('agy', ['models'], { aikaraja: 20_000 })
      .then((t) => { agy = { aika: nyt(), mallit: t.koodi === 0 ? agyMallit(t.stdout) : [], haku: null }; },
        () => { agy.haku = null; });
    return agy.haku;
  }
  async function haeAgy() {
    if (nyt() - agy.aika < AGY_VALIMUISTI_MS) return agy.mallit;
    const haku = paivitaAgy();
    if (agy.aika === -Infinity) await haku;
    return agy.mallit;
  }

  function oletus() {
    try {
      const p = JSON.parse(readFileSync(join(juuri, 'claude/siirto/ajaja.json'), 'utf8')).pura ?? {};
      return [p.moottori, p.agentti ?? p.malli].filter(Boolean).join(' ');
    } catch { return 'ajaja.json'; }
  }

  async function lista() {
    const [agyt, kaikki] = await Promise.all([haeAgy(), paikalliset().catch(() => [])]);
    const lms = kaikki.filter((m) => m.tyyppi === 'paikallinen' && m.nimi.startsWith(PAIKALLINEN));
    const purkajat = [
      { tunnus: '', kuvaus: `Oletus (${oletus()})`, ryhma: 'oletus' },
      ...MALLIT.map((m) => ({ tunnus: `claude-cli:${m.nimi}`, kuvaus: m.kuvaus, ryhma: 'Claude' })),
      { tunnus: `claude-agent:${AGENTTI}`, kuvaus: `${AGENTTI}-agentti`, ryhma: 'Claude' },
      ...agyt.map((m) => ({ tunnus: `mac-agy:${m.id}`, kuvaus: `${m.nimi} · macos`, ryhma: 'Mac AGY' })),
      ...agyt.map((m) => ({ tunnus: `agy:${m.id}`, kuvaus: `${m.nimi} · oneplus linux`, ryhma: 'OnePlus Linux AGY' })),
      ...lms.map((m) => ({ tunnus: `paikallinen:${m.nimi.slice(PAIKALLINEN.length)}`, kuvaus: m.kuvaus, ryhma: 'Paikalliset' })),
    ];
    const mallit = [...MALLIT.map(({ nimi, kuvaus }) => ({ nimi, kuvaus, ryhma: 'Claude' })),
      ...agyt.map((m) => ({ nimi: `${MAC_AGY_MALLI}${m.id}`, kuvaus: `${m.nimi} · macos`, ryhma: 'Mac AGY' })),
      ...agyt.map((m) => ({ nimi: `${AGY_MALLI}${m.id}`, kuvaus: `${m.nimi} · oneplus linux`, ryhma: 'OnePlus Linux AGY' })),
      ...lms.map(({ nimi, kuvaus }) => ({ nimi, kuvaus, ryhma: 'Paikalliset' })),
      ...(existsSync(nebiusTiedosto) ? NEBIUS_MALLIT.map((m) => ({ nimi: `${NEBIUS_MALLI}${m.id}`, kuvaus: m.kuvaus, ryhma: 'Nebius' })) : [])];
    return { purkajat, mallit, oletusMalli: 'claude-opus-5-5' };
  }

  // Runko {purkaja?, malli?} → { ajaja, malli }; tyhjä tai puuttuva = oletus (null).
  async function tarkista(runko = {}) {
    let purkaja = runko.purkaja ?? '';
    let malli = runko.malli ?? '';
    if (typeof purkaja !== 'string' || typeof malli !== 'string') throw new Hylatty(400, 'purkaja ja malli ovat merkkijonoja');
    const l = (purkaja || malli) ? await lista() : null;

    if (malli && l) {
      if (malli.startsWith('macos-agy/')) {
        malli = `${MAC_AGY_MALLI}${malli.slice(10)}`;
      } else if (!malli.includes('/')) {
        const loytyi = l.mallit.find((m) => m.nimi === `${MAC_AGY_MALLI}${malli}` || m.nimi === `${AGY_MALLI}${malli}`);
        if (loytyi) malli = loytyi.nimi;
      }
    }
    if (purkaja && l) {
      if (purkaja.startsWith('macos-agy:')) {
        purkaja = `mac-agy:${purkaja.slice(10)}`;
      } else if (!purkaja.includes(':')) {
        const loytyi = l.purkajat.find((p) => p.tunnus === `mac-agy:${purkaja}` || p.tunnus === `agy:${purkaja}`);
        if (loytyi) purkaja = loytyi.tunnus;
      }
    }

    if (malli && !l.mallit.some((m) => m.nimi === malli)) throw new Hylatty(400, `tuntematon istunnon malli ${malli.slice(0, 80)}`);
    if (purkaja && !l.purkajat.some((p) => p.tunnus === purkaja)) {
      throw new Hylatty(400, `purkaja ei ole saatavilla: ${purkaja.slice(0, 120)}`);
    }
    return { ajaja: purkaja || null, malli: malli || null };
  }

  return { lista, tarkista };
}
