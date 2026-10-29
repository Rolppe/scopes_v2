// Chatin agenttilista (T-82, ARK-16:n loput, S-10): GET /api/agentit. Käytös = vanhan 8787:n (scopes/palvelu/palvelin.mjs:296 →
// viestit.agentit() = kaikkiMallit, viestit.mjs:435), kopioitu kopioriveineen. Lista: kiinteät MALLIT ja AGY_MALLIT, android/gemini
// (vain kun adb on asetettu), palvelimen LM Studion mallit (ssh, välimuisti 20 s) ja Nebius-mallit (vain kun avaintiedosto on olemassa).
// Sovitus: aja, kello ja asetukset tulevat ymp:stä (palvelin.mjs):
//   ymp.aja, ymp.kello        ssh-kutsu LM Studion malleihin; välimuistin kello (oletus Date.now)
//   ymp.adb                   valinnainen: tosi, kun adapteri on käynnistetty --adb-asetuksella (kuten lahde.mjs:198) → android/gemini listalle
//   ymp.nebiusTiedosto        valinnainen: Nebius-avaintiedosto, oletus ~/.config/scopes/nebius-avain (vain olemassaolo, sisältöä ei lueta)
// Välimuisti on palvelinkohtainen (avain ymp.aja), koska vanha piti sen luoViestit-sulkeumassa. kaikkiMallit(ymp) on vietynä
// chatille (T-69) ja purkajille (T-68). Tuonnit vain ./runko.mjs ja node:-moduulit (gate.sh tuontitarkistus).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { vastaa } from './runko.mjs';

// kopio: scopes/palvelu/viestit.mjs:18-31 (21.10.2026)
export const AGY_MALLIT = [
  { nimi: 'mac-agy/gemini-3.8-flash-low', kuvaus: 'Gemini 3.8 Flash (Low)', tyyppi: 'agy', malliId: 'gemini-3.8-flash-low' },
  { nimi: 'mac-agy/gemini-3.8-flash-medium', kuvaus: 'Gemini 3.8 Flash (Medium)', tyyppi: 'agy', malliId: 'gemini-3.8-flash-medium' },
  { nimi: 'mac-agy/gemini-3.8-flash-high', kuvaus: 'Gemini 3.8 Flash (High)', tyyppi: 'agy', malliId: 'gemini-3.8-flash-high' },
  { nimi: 'mac-agy/claude-sonnet-4-6', kuvaus: 'Claude Sonnet 4.6', tyyppi: 'agy', malliId: 'claude-sonnet-4-6' },
  { nimi: 'mac-agy/claude-opus-4-6-thinking', kuvaus: 'Claude Opus 4.6 (Thinking)', tyyppi: 'agy', malliId: 'claude-opus-4-6-thinking' },
  { nimi: 'mac-agy/gpt-oss-120b-medium', kuvaus: 'GPT-OSS 120B (Medium)', tyyppi: 'agy', malliId: 'gpt-oss-120b-medium' },
];
export const MALLIT = [
  { nimi: 'claude-fable-5-1', kuvaus: 'Fable 5.1', tyyppi: 'malli' },
  { nimi: 'claude-opus-5-5', kuvaus: 'Opus 5.5', tyyppi: 'malli' },
  { nimi: 'claude-sonnet-5-5', kuvaus: 'Sonnet 5.5', tyyppi: 'malli' },
  { nimi: 'claude-haiku-5-5', kuvaus: 'Haiku 5.5', tyyppi: 'malli' },
];

// kopio: scopes/palvelu/viestit.mjs:36-40 (21.10.2026)
export const NEBIUS_CHAT_MALLIT = [
  { nimi: 'nebius/deepseek-ai/DeepSeek-V4-Flash-0731', kuvaus: 'DeepSeek V4 Flash · Nebius', tyyppi: 'nebius', hinta: [0.14, 0.28] },
  { nimi: 'nebius/Qwen/Qwen3-30B-A3B-Instruct-2507', kuvaus: 'Qwen3 30B (nopea) · Nebius', tyyppi: 'nebius', hinta: [0.10, 0.30] },
  { nimi: 'nebius/deepseek-ai/DeepSeek-V4.1-Flash', kuvaus: 'DeepSeek V4.1 Flash · Nebius', tyyppi: 'nebius', hinta: [0.30, 1.20] },
];

// kopio: scopes/palvelu/viestit.mjs:61-62 (21.10.2026)
// Puhelimen Gemini-äppi chat-mallina (CHAT-GEMINI 15.10.2026): android.mjs ajaa sen adb:llä samalla laitteella.
export const GEMINI_AGENTTI = Object.freeze({ nimi: 'android/gemini', kuvaus: 'Gemini', tyyppi: 'gemini' });

// kopio: scopes/palvelu/viestit.mjs:99-107 (21.10.2026)
// palvelimen LM Studio kuuntelee vain 127.0.0.1:1234:ää, joten palvelu käyttää sitä ssh:n yli. Etäkomennot ovat
// vakioita; mallin nimi ja viestit kulkevat JSON-rungossa stdinissä, eivät komentorivillä.
export const PAIKALLINEN = 'palvelin/';
const SSH = ['-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', 'palvelin'];
const LMS_MALLIT = 'curl -s -m 5 http://127.0.0.1:1234/v1/models';
const PAIKALLINEN_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// kopio: scopes/palvelu/viestit.mjs:114-139 (21.10.2026)
// Paikallisen mallin näyttönimi (CHAT-MALLINIMET, V-330): tunnuksen viimeinen osa ilman tiedosto- ja kvantisointipäätettä,
// kokomerkinnät isolla (qwen3.5-9b-q4_k_m.gguf → Qwen3.5 9B, qwen/qwen3.6-35b-a3b → Qwen3.6 35B A3B).
const KVANTISOINTI = /^(i?q\d.*|f16|f32|bf16|fp16|fp8|\d+bit|mlx|gguf)$/i;
export function mallinNayttonimi(id) {
  const osat = id.split('/').pop().replace(/@.*$/, '').replace(/\.gguf$/i, '').split(/[-_](?=[^-_])/);
  while (osat.length > 1 && KVANTISOINTI.test(osat.at(-1))) osat.pop();
  // q4_k_m jakautuu alaviivoista: pudota kvantisoinnin alku ja sen perään jääneet k/m/s/l-osat.
  const q = osat.findIndex((o, i) => i > 0 && /^i?q\d$/i.test(o));
  if (q > 0) osat.length = q;
  return osat.map((o) => (/^a?\d+(\.\d+)?[bkm]$/i.test(o) ? o.toUpperCase() : /^v\d/.test(o) ? o : o[0].toUpperCase() + o.slice(1))).join(' ');
}

// LM Studion /v1/models → [{ nimi: 'palvelin/<id>', kuvaus: näyttönimi, tyyppi: 'paikallinen' }]; upotusmallit pois.
export function paikallisetMallit(stdout) {
  let data;
  try { data = JSON.parse(stdout).data; } catch { return []; }
  if (!Array.isArray(data)) return [];
  const mallit = data.map((m) => m?.id).filter((id) => typeof id === 'string' && PAIKALLINEN_ID.test(id) && !/embed/i.test(id))
    .map((id) => ({ nimi: PAIKALLINEN + id, kuvaus: mallinNayttonimi(id), tyyppi: 'paikallinen' }));
  // Sama malli voi olla listalla sekä kansiona että kvantisoituna tiedostona (qwen/qwen3.5-9b ja
  // …/qwen3.5-9b-q4_k_m.gguf, 14.10.2026): törmäävä nimi saa kvantisointimerkinnän perään.
  return mallit.map((m) => {
    const q = m.nimi.split('/').pop().replace(/\.gguf$/i, '').match(/[-_@](i?q\d[a-z0-9_]*|bf16|fp16|f16)$/i);
    return q && mallit.filter((x) => x.kuvaus === m.kuvaus).length > 1 ? { ...m, kuvaus: `${m.kuvaus} ${q[1].toUpperCase()}` } : m;
  });
}

// Paikallisten mallien välimuisti palvelinta (ymp.aja) kohden; vanhassa luoViestit-sulkeuman `paikalliset`.
const valimuistit = new WeakMap();

// kopio: scopes/palvelu/viestit.mjs:424-435 (21.10.2026)
// Paikallisten mallien lista välimuistissa 20 s; palvelin on usein pois päältä, jolloin lista on tyhjä eikä
// äppi tarjoa paikallisia malleja.
export async function haePaikalliset(ymp) {
  const nyt = ymp.kello ?? Date.now;
  let paikalliset = valimuistit.get(ymp.aja) ?? { aika: null, mallit: [] };
  if (paikalliset.aika !== null && nyt() - paikalliset.aika < 20_000) return paikalliset.mallit;
  const t = await ymp.aja('ssh', [...SSH, LMS_MALLIT], { aikaraja: 10_000 });
  paikalliset = { aika: nyt(), mallit: t.koodi === 0 ? paikallisetMallit(t.stdout) : [] };
  valimuistit.set(ymp.aja, paikalliset);
  return paikalliset.mallit;
}
const nebiusAvain = (ymp) => ymp.nebiusTiedosto ?? join(homedir(), '.config/scopes/nebius-avain');
const nebiusMallit = (ymp) => (existsSync(nebiusAvain(ymp)) ? NEBIUS_CHAT_MALLIT : []);
export const kaikkiMallit = async (ymp) => [...MALLIT, ...AGY_MALLIT, ...(ymp.adb ? [GEMINI_AGENTTI] : []), ...await haePaikalliset(ymp), ...nebiusMallit(ymp)];

export const REITIT = [
  { metodi: 'GET', kuvio: '/api/agentit', toteutettu: true, kasittele: async (_req, res, _osat, ymp) => vastaa(res, 200, await kaikkiMallit(ymp)) },
];
