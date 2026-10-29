// Chat (T-69, ARK-16, S-10): suora (POST /api/chat) ja virta (POST /api/chat/virta), käynnissä olevaan ajoon liittyminen
// (GET /api/chat/kaynnissa), stop-nappi (POST /api/chat/stop) ja keskusteluhistoria (GET /api/chat/keskustelut[/<id>]).
// Käytös = vanhan 8787:n (scopes/palvelu/viestit.mjs: taustat ja chat, palvelin.mjs: virtaa/liity), kopioitu kopioriveineen.
// Taustat: claude (stream-json, viesti stdinissä, cwd = chat-hakemisto, 300 s), palvelimen LM Studio ssh:lla, Nebius ssh:lla
// (avain stdinissä), agy ja puhelimen Gemini. Kaikki ulkoiset kutsut kulkevat ymp.aja:n (tai ymp.android:n) kautta.
//   ymp.chatDir        chatin työhakemisto ja historia; oletus join(ymp.tila, 'chat') = ~/.local/state/scopes2/chat (oma, ei vanhan scopes-chat)
//   ymp.projektitDir   Claude Coden projektikansio (transkriptit); oletus CLAUDE_PROJEKTIT_DIR / ~/.claude/projects
//   ymp.nebiusTiedosto Nebius-avain; oletus ~/.config/scopes/nebius-avain (sama tiedosto kuin vanha; avainta ei kopioida eikä lokiteta)
//   ymp.android        valinnainen olio { kysyGeminilta({ teksti, pala, pysaytetty }) }; ilman sitä Gemini ei ole valittavissa (kuten vanha)
//   ymp.kello          valinnainen () → ms; oletus Date.now (liityttävän loppuvastauksen vanheneminen, paikallisten mallien välimuisti)
// Chat-ajon tila (käynnissä oleva ajo, liityttävä loppu, paikallisten mallien välimuisti) on moduulin sisäinen, avaimena chatDir:
// samassa hakemistossa ajaa yksi chat kerrallaan. Tuonnit vain ./aja.mjs, ./runko.mjs, ./viestit.mjs, ../vanhasta/* ja node:-moduulit.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projektiNimi, pysahdys } from '../vanhasta/lahteet.mjs';
import { Hylatty } from './aja.mjs';
import { NDJSON, kirjoitaNdjson, lueRunko, vastaa } from './runko.mjs';
import { VIESTIN_MAKSIMI, keskustelu } from './viestit.mjs';

// kopio: scopes/palvelu/viestit.mjs:18-43 (21.10.2026)
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
// Nebius Token Factory -chat (käyttäjä 18.10.2026: "parhaat mallit ... eri tehtäviin ... asenna ne äppiin"). Kutsu kulkee
// palvelimen kautta (OnePlus ei saa yhteyttä Nebiukseen), avain stdinissä eikä komentorivillä. Ei Claude Codea välissä,
// joten viesti maksaa vain omat tokeninsa. Valinta ja hinnat ($/M syöte, tuloste) mittauksesta 18.10.2026 (NEBIUS-MALLIT).
export const NEBIUS = 'nebius/';
export const NEBIUS_CHAT_MALLIT = [
  { nimi: 'nebius/deepseek-ai/DeepSeek-V4-Flash-0731', kuvaus: 'DeepSeek V4 Flash · Nebius', tyyppi: 'nebius', hinta: [0.14, 0.28] },
  { nimi: 'nebius/Qwen/Qwen3-30B-A3B-Instruct-2507', kuvaus: 'Qwen3 30B (nopea) · Nebius', tyyppi: 'nebius', hinta: [0.10, 0.30] },
  { nimi: 'nebius/deepseek-ai/DeepSeek-V4.1-Flash', kuvaus: 'DeepSeek V4.1 Flash · Nebius', tyyppi: 'nebius', hinta: [0.30, 1.20] },
];
// Reitti Nebiukseen: palvelin, sen ollessa pois Mac (kumpikin pääsee Nebiukseen, OnePlus ei; 19.10.2026).
const NEBIUS_REITIT = ['palvelin', 'mac'];
const NEBIUS_CHAT = 'read -r K; curl -sN -m 300 -H "Authorization: Bearer $K" -H \'Content-Type: application/json\' --data-binary @- https://api.tokenfactory.nebius.com/v1/chat/completions';

// kopio: scopes/palvelu/viestit.mjs:61-139 (21.10.2026)
// Puhelimen Gemini-äppi chat-mallina (CHAT-GEMINI 15.10.2026): android.mjs ajaa sen adb:llä samalla laitteella.
export const GEMINI_AGENTTI = Object.freeze({ nimi: 'android/gemini', kuvaus: 'Gemini', tyyppi: 'gemini' });
const GEMINI_MAKSIMI = 8000; // android.mjs TEKSTIN_MAKSIMI: jakointentin tekstikenttä

// Jatkoviesti Geminille: jokainen kysymys on oma Gemini-chattinsa (android.mjs kysyGeminilta), joten aiempi keskustelu
// kulkee tekstin alussa kuten paikallisten mallien messages-listassa. Vanhimmat viestit jäävät pois, kun raja tulee vastaan.

export function agyKehote(aiemmat, uusiViesti, jarjestelmaKehote = null, maksimi = 16000) {
  let prompt = '';
  if (jarjestelmaKehote) {
    prompt += '[Järjestelmäohjeet]\n' + jarjestelmaKehote + '\n\n';
  }
  if (aiemmat && aiemmat.length > 0) {
    prompt += '[Aiempi keskustelu]\n';
    for (const v of aiemmat) {
      const rooli = v.rooli === 'kayttaja' ? 'Käyttäjä' : 'Koordinaattori';
      prompt += rooli + ': ' + v.teksti + '\n';
    }
    prompt += '\n';
  }
  prompt += '[Uusi viesti]\nKäyttäjä: ' + uusiViesti + '\nKoordinaattori:';
  return prompt;
}

export function geminiKehote(aiemmat, viesti, maksimi = GEMINI_MAKSIMI) {
  if (!aiemmat.length) return viesti;
  const alku = 'Jatka alla olevaa keskustelua ja vastaa vain viimeiseen viestiin.\n\n[Aiempi keskustelu]\n';
  const loppu = `\n[Uusi viesti]\n${viesti}`;
  const rivit = aiemmat.map((v) => `${v.rooli === 'kayttaja' ? 'Minä' : 'Gemini'}: ${v.teksti}\n`);
  let tila = maksimi - alku.length - loppu.length;
  const mukaan = [];
  for (let i = rivit.length - 1; i >= 0 && tila > 40; i--) {
    const r = rivit[i].length <= tila ? rivit[i] : `…${rivit[i].slice(-(tila - 2))}\n`;
    mukaan.unshift(r);
    tila -= r.length;
  }
  return mukaan.length ? alku + mukaan.join('') + loppu : viesti;
}
const ISTUNTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// palvelimen LM Studio kuuntelee vain 127.0.0.1:1234:ää, joten palvelu käyttää sitä ssh:n yli. Etäkomennot ovat
// vakioita; mallin nimi ja viestit kulkevat JSON-rungossa stdinissä, eivät komentorivillä.
export const PAIKALLINEN = 'palvelin/';
const SSH = ['-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', 'palvelin'];
const LMS_MALLIT = 'curl -s -m 5 http://127.0.0.1:1234/v1/models';
const LMS_CHAT = "curl -sN -m 300 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:1234/v1/chat/completions";
const PAIKALLINEN_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// Mallin vaihto: LM Studio ei mahdu lataamaan toista isoa mallia ensimmäisen rinnalle (8 GB VRAM, 30 GB RAM;
// "insufficient system resources" 13.10.2026), joten muu ladattu malli puretaan ensin. Tunnus on tarkistettu
// listalta ja PAIKALLINEN_ID-muodosta, joten se ei sisällä lainausmerkkejä eikä kuoren erikoismerkkejä.
export const lmsLataa = (id) => `mkdir -p ~/.lmstudio/.internal/temp; L=~/.lmstudio/bin/lms; $L ps --json | grep -qF '"identifier":"${id}"' || `
  + `{ $L unload --all >/dev/null && $L load '${id}' -y --identifier '${id}' -c 8192; }`;

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

// kopio: scopes/palvelu/viestit.mjs:141-142 (21.10.2026)
// Työkalukutsu yhdeksi lyhyeksi riviksi (DEMO-SCOPES-PARANNUKSET 13.10.2026): komento tai muokattu tiedosto.
const lyhenna = (t, n = 120) => { const r = String(t ?? '').split('\n')[0].trim(); return r.length > n ? `${r.slice(0, n - 1)}…` : r; };

// Valmis ajo pysyy liityttävänä LOPPUTULOS_MS ajan, jotta uuden keskustelun tunnus ei katoa katkoksessa.
// kopio: scopes/palvelu/palvelin.mjs:155-155 (21.10.2026)
export const LOPPUTULOS_MS = 10 * 60_000;

// Moduulin sisäinen tila chatDir kohti: { kaynnissa, pysaytin, ajo: { teksti, kuuntelijat, loppu, aika } | null, paikalliset }.
// Vanhassa nämä olivat luoViestit:n (chatKaynnissa, chatPysaytin, paikalliset) ja kasittelija:n (ajo) sulkeumassa.
const TILAT = new Map();
const chatTila = (chatDir) => {
  if (!TILAT.has(chatDir)) TILAT.set(chatDir, { kaynnissa: false, pysaytin: null, ajo: null, paikalliset: { aika: 0, mallit: [] } });
  return TILAT.get(chatDir);
};

// luoChat(ymp): vanhan luoViestit:n chat-osat. Luodaan pyynnöittäin; pysyvä tila on TILAT:ssa.
export function luoChat(ymp) {
  const aja = ymp.aja;
  const kello = ymp.kello ?? Date.now;
  const android = ymp.android ?? null;
  const chatDir = ymp.chatDir ?? join(ymp.tila ?? join(homedir(), '.local/state/scopes2'), 'chat');
  const asetukset = {
    juuri: ymp.juuri,
    chatDir,
    projektitDir: ymp.projektitDir ?? process.env.CLAUDE_PROJEKTIT_DIR ?? join(homedir(), '.claude/projects'),
    nebiusTiedosto: ymp.nebiusTiedosto,
  };
  const tila = chatTila(chatDir);
  const kirjaa = (rivi) => { try { ymp.loki?.(rivi); } catch { /* loki ei estä pysäytystä */ } };

// kopio: scopes/palvelu/viestit.mjs:418-568 (21.10.2026) (sovitettu: tila, kello, ymp)
  // Chatin keskusteluhistoria (DEMO-SCOPES-PARANNUKSET): claude kirjoittaa jokaisen chatin transkriptiksi chatin
  // työhakemiston projektikansioon, ja --resume jatkaa samaa tiedostoa, joten lista luetaan sieltä. Agentin nimi
  // talletetaan erikseen (agentit.json), koska --agent-ajon transkripti ei kerro sitä; jatko vaatii saman agentin.
  const chatProjekti = () => join(asetukset.projektitDir, projektiNimi(asetukset.chatDir));
  const agenttiTiedosto = () => join(asetukset.chatDir, 'agentit.json');
  const lueAgentit = () => { try { return JSON.parse(readFileSync(agenttiTiedosto(), 'utf8')); } catch { return {}; } };
  // Paikallisten mallien lista välimuistissa 20 s; palvelin on usein pois päältä, jolloin lista on tyhjä eikä
  // äppi tarjoa paikallisia malleja.
  async function haePaikalliset() {
    if (kello() - tila.paikalliset.aika < 20_000) return tila.paikalliset.mallit;
    const t = await aja('ssh', [...SSH, LMS_MALLIT], { aikaraja: 10_000 });
    tila.paikalliset = { aika: kello(), mallit: t.koodi === 0 ? paikallisetMallit(t.stdout) : [] };
    return tila.paikalliset.mallit;
  }
  const nebiusAvain = () => asetukset.nebiusTiedosto ?? join(homedir(), '.config/scopes/nebius-avain');
  const nebiusMallit = () => (existsSync(nebiusAvain()) ? NEBIUS_CHAT_MALLIT : []);
  const kaikkiMallit = async () => [...MALLIT, ...AGY_MALLIT, ...(android ? [GEMINI_AGENTTI] : []), ...await haePaikalliset(), ...nebiusMallit()];

  // Paikallisen mallin keskustelu talletetaan itse (LM Studio ei pidä historiaa): chatDir/paikalliset/<uuid>.json.
  // Samaan kansioon menevät Gemini-keskustelut, koska Geminin oma historia on joka kysymykselle eri chat.
  const paikallisetDir = () => join(asetukset.chatDir, 'paikalliset');
  const luePaikallinen = (id) => { try { return JSON.parse(readFileSync(join(paikallisetDir(), `${id}.json`), 'utf8')); } catch { return null; } };

  async function paikallinenChat(valittu, viesti, jatko, { pala, alku, signal, pysaytetty }) {
    const k = jatko ? luePaikallinen(jatko) : { agentti: valittu.nimi, viestit: [] };
    if (!k) throw new Hylatty(404, 'tuntematon keskustelu');
    if (k.agentti !== valittu.nimi) throw new Hylatty(409, 'keskustelu kuuluu toiselle mallille');
    k.viestit.push({ rooli: 'kayttaja', teksti: viesti, aika: new Date().toISOString() });
    const runko = JSON.stringify({ model: valittu.nimi.slice(PAIKALLINEN.length), stream: true,
      messages: k.viestit.map((v) => ({ role: v.rooli === 'kayttaja' ? 'user' : 'assistant', content: v.teksti })) });
    alku?.();
    const lataus = await aja('ssh', [...SSH, lmsLataa(valittu.nimi.slice(PAIKALLINEN.length))], { aikaraja: 240_000, signal });
    if (lataus.koodi !== 0 && !pysaytetty()) {
      tila.paikalliset.aika = 0;
      const rivi = (lataus.stderr + lataus.stdout).trim().split('\n').filter(Boolean).pop() ?? `ssh exit ${lataus.koodi}`;
      throw new Hylatty(502, `mallin lataus epäonnistui: ${rivi.slice(0, 300)}`);
    }
    let vastaus = '';
    let syy = null;
    // SSE-rivit "data: {…}"; vain content-palat näytetään, reasoning_content (ajattelu) jää pois.
    const riville = (r) => {
      let e;
      try { e = JSON.parse(r.replace(/^data: /, '')); } catch { return; }
      if (e.error) syy = e.error.message ?? String(e.error);
      const d = e.choices?.[0]?.delta?.content;
      if (d) { vastaus += d; pala?.(d); }
    };
    const t = pysaytetty() ? null : await aja('ssh', [...SSH, LMS_CHAT], { syote: runko, aikaraja: 300_000, riville, signal, puskuri: 32 << 20 });
    // Pysäytetty: käyttäjän viesti ja osittainen vastaus jäävät historiaan, kuten claude-transkriptiin.
    if (!pysaytetty() && (t.koodi !== 0 || !vastaus)) {
      throw new Hylatty(502, `malli ei vastannut: ${(syy ?? t.stderr.trim().split('\n').filter(Boolean).pop() ?? `ssh exit ${t.koodi}`).slice(0, 300)}`);
    }
    vastaus = vastaus.trim();
    if (vastaus) k.viestit.push({ rooli: 'agentti', teksti: vastaus, aika: new Date().toISOString() });
    const id = jatko ?? randomUUID();
    mkdirSync(paikallisetDir(), { recursive: true });
    writeFileSync(join(paikallisetDir(), `${id}.json`), JSON.stringify(k));
    return { vastaus, keskustelu: id, agentti: valittu.nimi, kustannus: 0, ...(pysaytetty() ? { keskeytetty: true } : {}) };
  }

  async function nebiusChat(valittu, viesti, jatko, { pala, alku, signal, pysaytetty }) {
    const k = jatko ? luePaikallinen(jatko) : { agentti: valittu.nimi, viestit: [] };
    if (!k) throw new Hylatty(404, 'tuntematon keskustelu');
    if (k.agentti !== valittu.nimi) throw new Hylatty(409, 'keskustelu kuuluu toiselle mallille');
    let avain;
    try { avain = readFileSync(nebiusAvain(), 'utf8').trim(); } catch { throw new Hylatty(409, 'Nebius-avain puuttuu (Asetukset → Nebius)'); }
    k.viestit.push({ rooli: 'kayttaja', teksti: viesti, aika: new Date().toISOString() });
    const runko = JSON.stringify({ model: valittu.nimi.slice(NEBIUS.length), stream: true, stream_options: { include_usage: true }, max_tokens: 8192,
      messages: k.viestit.map((v) => ({ role: v.rooli === 'kayttaja' ? 'user' : 'assistant', content: v.teksti })) });
    alku?.();
    let vastaus = '';
    let syy = null;
    let kaytto = null;
    // SSE-rivit kuten paikallisella mallilla; ajattelu (reasoning_content) jää pois, käyttö kustannusta varten.
    const riville = (r) => {
      let e;
      try { e = JSON.parse(r.replace(/^data: /, '')); } catch { return; }
      if (e.detail || e.error) syy = e.error?.message ?? String(e.detail ?? e.error);
      if (e.usage) kaytto = e.usage;
      const d = e.choices?.[0]?.delta?.content;
      if (d) { vastaus += d; pala?.(d); }
    };
    // ssh:n koodi 255 = yhteys ei auennut, jolloin kokeillaan seuraavaa reittiä; muu virhe on Nebiuksen vastaus.
    let t = null;
    for (const kone of NEBIUS_REITIT) {
      if (pysaytetty()) break;
      t = await aja('ssh', ['-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', kone, NEBIUS_CHAT], { syote: `${avain}\n${runko}`, aikaraja: 300_000, riville, signal, puskuri: 32 << 20 });
      if (t.koodi !== 255) break;
    }
    if (!pysaytetty() && (t.koodi !== 0 || !vastaus)) {
      throw new Hylatty(502, `Nebius ei vastannut: ${(syy ?? t.stderr.trim().split('\n').filter(Boolean).pop() ?? `ssh exit ${t.koodi}`).slice(0, 300)}`);
    }
    vastaus = vastaus.trim();
    if (vastaus) k.viestit.push({ rooli: 'agentti', teksti: vastaus, aika: new Date().toISOString() });
    const id = jatko ?? randomUUID();
    mkdirSync(paikallisetDir(), { recursive: true });
    writeFileSync(join(paikallisetDir(), `${id}.json`), JSON.stringify(k));
    const kustannus = kaytto ? (kaytto.prompt_tokens * valittu.hinta[0] + kaytto.completion_tokens * valittu.hinta[1]) / 1e6 : null;
    return { vastaus, keskustelu: id, agentti: valittu.nimi, kustannus, ...(pysaytetty() ? { keskeytetty: true } : {}) };
  }

  async function agyChat(valittu, viesti, jatko, { pala, alku, signal, pysaytetty, jarjestelmaKehote } = {}) {
    const k = jatko ? luePaikallinen(jatko) : { agentti: valittu.nimi, viestit: [] };
    if (!k) throw new Hylatty(404, 'tuntematon keskustelu');
    if (k.agentti !== valittu.nimi) throw new Hylatty(409, 'keskustelu kuuluu toiselle mallille');
    const aiemmat = [...k.viestit];
    k.viestit.push({ rooli: 'kayttaja', teksti: viesti, aika: new Date().toISOString() });
    alku?.();
    let vastaus = '';
    const agyKomento = process.env.AGY_BIN ?? (process.platform === 'darwin' ? '~/.local/bin/agy' : '~/.local/bin/agy');
    const syoteKehote = agyKehote(aiemmat, viesti, jarjestelmaKehote);
    const argumentit = ['--dangerously-skip-permissions', '--model', valittu.malliId, '--add-dir', asetukset.juuri, '-p', syoteKehote];
    const riville = (r) => {
      if (r) {
        vastaus += r + '\n';
        pala?.(r + '\n');
      }
    };
    const t = pysaytetty() ? null : await aja(agyKomento, argumentit, { cwd: asetukset.juuri, riville, signal, aikaraja: 180_000 });
    if (!pysaytetty() && (t?.koodi !== 0 || !vastaus.trim())) {
      const virheTeksti = t?.stderr || t?.stdout || 'AGY ei vastannut';
      throw new Hylatty(502, `AGY-malli ei vastannut: ${virheTeksti.slice(0, 300)}`);
    }
    vastaus = vastaus.trim();
    if (vastaus) k.viestit.push({ rooli: 'agentti', teksti: vastaus, aika: new Date().toISOString() });
    const id = jatko ?? randomUUID();
    mkdirSync(paikallisetDir(), { recursive: true });
    writeFileSync(join(paikallisetDir(), `${id}.json`), JSON.stringify(k));
    return { vastaus, keskustelu: id, agentti: valittu.nimi, kustannus: 0, ...(pysaytetty() ? { keskeytetty: true } : {}) };
  }
  async function geminiChat(valittu, viesti, jatko, { pala, alku, pysaytetty }) {
    const k = jatko ? luePaikallinen(jatko) : { agentti: valittu.nimi, viestit: [] };
    if (!k) throw new Hylatty(404, 'tuntematon keskustelu');
    if (k.agentti !== valittu.nimi) throw new Hylatty(409, 'keskustelu kuuluu toiselle mallille');
    const kehote = geminiKehote(k.viestit, viesti);
    k.viestit.push({ rooli: 'kayttaja', teksti: viesti, aika: new Date().toISOString() });
    alku?.();
    const { vastaus } = await android.kysyGeminilta({ teksti: kehote, pala, pysaytetty });
    if (!vastaus && !pysaytetty()) throw new Hylatty(502, 'Gemini ei vastannut (ruudulta ei löytynyt vastausta)');
    if (vastaus) k.viestit.push({ rooli: 'agentti', teksti: vastaus, aika: new Date().toISOString() });
    const id = jatko ?? randomUUID();
    mkdirSync(paikallisetDir(), { recursive: true });
    writeFileSync(join(paikallisetDir(), `${id}.json`), JSON.stringify(k));
    return { vastaus, keskustelu: id, agentti: valittu.nimi, kustannus: 0, ...(pysaytetty() ? { keskeytetty: true } : {}) };
  }
  const malliTranskriptista = (rivit) => {
    for (const r of rivit) { try { const m = JSON.parse(r).message?.model; if (MALLIT.some((x) => x.nimi === m)) return m; } catch { /* ohita */ } }
    return null;
  };
  return {
    agentit: kaikkiMallit,

// kopio: scopes/palvelu/viestit.mjs:573-686 (21.10.2026) (keskustelut, keskustelunViestit, chat, pysaytaChat; sovitettu: tila)
    keskustelut() {
      const dir = chatProjekti();
      const nimet = lueAgentit();
      const tulos = [];
      // Ilman yhtään Claude-chattia kansiota ei ole, mutta paikalliset ja Gemini-keskustelut luetaan silti.
      for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.jsonl')) : []) {
        const id = f.slice(0, -6);
        if (!ISTUNTO_ID.test(id)) continue;
        const polku = join(dir, f);
        const teksti = readFileSync(polku, 'utf8');
        const viestit = keskustelu(teksti, Infinity);
        const eka = viestit.find((v) => v.rooli === 'kayttaja');
        if (!eka) continue;
        tulos.push({ id, otsikko: lyhenna(eka.teksti, 80), agentti: nimet[id] ?? malliTranskriptista(teksti.split('\n')),
          viesteja: viestit.length, aika: pysahdys(teksti) ?? statSync(polku).mtime.toISOString() });
      }
      if (existsSync(paikallisetDir())) {
        for (const f of readdirSync(paikallisetDir()).filter((x) => x.endsWith('.json'))) {
          const id = f.slice(0, -5);
          const k = ISTUNTO_ID.test(id) && luePaikallinen(id);
          const eka = k?.viestit?.find((v) => v.rooli === 'kayttaja');
          if (!eka) continue;
          tulos.push({ id, otsikko: lyhenna(eka.teksti, 80), agentti: k.agentti, viesteja: k.viestit.length,
            aika: statSync(join(paikallisetDir(), f)).mtime.toISOString() });
        }
      }
      return tulos.sort((a, b) => b.aika.localeCompare(a.aika));
    },

    keskustelunViestit(id) {
      if (!ISTUNTO_ID.test(id ?? '')) throw new Hylatty(400, 'keskustelun tunnus ei kelpaa');
      const p = luePaikallinen(id);
      if (p) return { id, agentti: p.agentti, viestit: p.viestit.slice(-200) };
      const polku = join(chatProjekti(), `${id}.jsonl`);
      if (!existsSync(polku)) throw new Hylatty(404, 'tuntematon keskustelu');
      const teksti = readFileSync(polku, 'utf8');
      return { id, agentti: lueAgentit()[id] ?? malliTranskriptista(teksti.split('\n')), viestit: keskustelu(teksti, 200) };
    },

    // Vastaus suoratoistona (DEMO-SCOPES-SUORATOISTO 13.10.2026): claude kirjoittaa stream-json-tapahtumia, joista
    // tekstin palat menevät `pala`-kutsulle sitä mukaa kuin agentti kirjoittaa; lopullinen vastaus tulee result-rivistä.
    // `alku` kutsutaan, kun pyyntö on hyväksytty ja agentti käynnistyy (palvelin avaa vasta silloin virran);
    // `signal` katkaisee ajon, kun puhelin sulkee yhteyden.
    async chat({ agentti, viesti, keskustelu: jatko, jarjestelmaKehote } = {}, { pala, alku, signal } = {}) {
      const valittu = MALLIT.find((a) => a.nimi === agentti)
        ?? AGY_MALLIT.find((a) => a.nimi === agentti)
        ?? nebiusMallit().find((a) => a.nimi === agentti)
        ?? (android && agentti === GEMINI_AGENTTI.nimi ? GEMINI_AGENTTI : undefined)
        ?? (typeof agentti === 'string' && agentti.startsWith(PAIKALLINEN) ? (await haePaikalliset()).find((a) => a.nimi === agentti) : undefined);
      if (!valittu) throw new Hylatty(400, 'tuntematon agentti');
      if (typeof viesti !== 'string' || !viesti.trim()) throw new Hylatty(400, 'viesti puuttuu');
      if (viesti.length > VIESTIN_MAKSIMI) throw new Hylatty(413, `viesti yli ${VIESTIN_MAKSIMI} merkkiä`);
      if (jatko != null && !(typeof jatko === 'string' && ISTUNTO_ID.test(jatko))) throw new Hylatty(400, 'keskustelun tunnus ei kelpaa');
      if (tila.kaynnissa) throw new Hylatty(429, 'edellinen chat-vastaus on vielä kesken');
      tila.kaynnissa = true;
      const pysaytin = tila.pysaytin = new AbortController();
      const pysaytetty = () => pysaytin.signal.aborted;
      signal = signal ? AbortSignal.any([signal, pysaytin.signal]) : pysaytin.signal;
      try {
        if (valittu.tyyppi === 'agy') return await agyChat(valittu, viesti, jatko, { pala, alku, signal, pysaytetty, jarjestelmaKehote });
        if (valittu.tyyppi === 'nebius') return await nebiusChat(valittu, viesti, jatko, { pala, alku, signal, pysaytetty });
        if (valittu.tyyppi === 'paikallinen') return await paikallinenChat(valittu, viesti, jatko, { pala, alku, signal, pysaytetty });
        if (valittu.tyyppi === 'gemini') return await geminiChat(valittu, viesti, jatko, { pala, alku, pysaytetty });
        mkdirSync(asetukset.chatDir, { recursive: true });
        const argumentit = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '',
          '--model', valittu.nimi,
          ...(jatko ? ['--resume', jatko] : [])];
        alku?.();
        let lohkoja = 0;
        // Pysäytyksen varalle: istunnon id init-rivistä ja tähän asti kirjoitettu teksti (result-riviä ei tule).
        let istunto = null;
        let osittain = '';
        const kirjoita = (t) => { osittain += t; pala?.(t); };
        const riville = (r) => {
          let e;
          try { e = JSON.parse(r); } catch { return; }
          if (e.type === 'system' && ISTUNTO_ID.test(e.session_id ?? '')) istunto = e.session_id;
          if (e.type !== 'stream_event') return;
          // Uusi tekstilohko saman vastauksen sisällä erotetaan tyhjällä rivillä, kuten result-kenttä.
          if (e.event?.type === 'content_block_start' && e.event.content_block?.type === 'text' && lohkoja++) kirjoita('\n\n');
          if (e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta' && e.event.delta.text) kirjoita(e.event.delta.text);
        };
        const muistaAgentti = (id) => {
          if (!ISTUNTO_ID.test(id ?? '')) return;
          const nimet = lueAgentit();
          if (nimet[id] !== valittu.nimi) writeFileSync(agenttiTiedosto(), JSON.stringify({ ...nimet, [id]: valittu.nimi }));
        };
        const t = await aja('claude', argumentit, { syote: viesti, cwd: asetukset.chatDir, aikaraja: 300_000, riville, signal, puskuri: 32 << 20 });
        if (pysaytetty()) {
          const id = istunto ?? jatko ?? null;
          muistaAgentti(id);
          return { vastaus: osittain.trim(), keskustelu: id, agentti: valittu.nimi, kustannus: null, keskeytetty: true };
        }
        let j = null;
        for (const r of t.stdout.split('\n')) { try { const e = JSON.parse(r); if (e.type === 'result') j = e; } catch { /* ohita */ } }
        if (t.koodi !== 0 || !j || j.is_error) {
          const syy = (j?.result ?? t.stderr.trim().split('\n').filter(Boolean).pop() ?? `claude exit ${t.koodi}`).slice(0, 300);
          throw new Hylatty(502, `agentti ei vastannut: ${syy}`);
        }
        muistaAgentti(j.session_id);
        return { vastaus: j.result ?? '', keskustelu: j.session_id, agentti: valittu.nimi, kustannus: j.total_cost_usd ?? null };
      } finally {
        tila.kaynnissa = false;
        if (tila.pysaytin === pysaytin) tila.pysaytin = null;
      }
    },

    // Stop-nappi (CHAT-STOP): keskeyttää käynnissä olevan vastauksen heti; chat() palaa osittaisella vastauksella.
    pysaytaChat() {
      if (!tila.pysaytin) throw new Hylatty(409, 'ei käynnissä olevaa vastausta');
      tila.pysaytin.abort();
      kirjaa({ toiminto: 'chat-stop' });
      return { ok: true };
    },
    tila,
  };
}

// kopio: scopes/palvelu/palvelin.mjs:148-189 (21.10.2026) — virtaa ja liity; sovitus: ajo tilassa, kirjoitaNdjson, ymp.kello
// Chat suoratoistona (DEMO-SCOPES-SUORATOISTO): NDJSON-rivit {tyyppi: 'pala', teksti} …, lopuksi
// {tyyppi: 'valmis', vastaus, keskustelu, …} tai {tyyppi: 'virhe', virhe}. Hylkäys ennen agentin käynnistystä
// palaa tavallisena virhekoodina. Yhteyden katketessa (puhelimen näyttölukko, äpin vaihto) agentti jatkaa, ja
// GET /api/chat/kaynnissa liittyy ajoon uudelleen: ensin tähän asti kirjoitettu teksti yhtenä palana, sitten loput.
async function virtaa(res, pyynto, ymp) {
  const kello = ymp.kello ?? Date.now;
  const c = luoChat(ymp);
  const tila = c.tila;
  let oma = null;
  try {
    const v = await c.chat(pyynto, {
      alku: () => {
        oma = tila.ajo = { teksti: '', kuuntelijat: new Set([res]), loppu: null, aika: kello() };
        res.on('close', () => oma.kuuntelijat.delete(res));
        res.writeHead(200, NDJSON);
      },
      pala: (teksti) => { oma.teksti += teksti; for (const r of oma.kuuntelijat) kirjoitaNdjson(r, { tyyppi: 'pala', teksti }); },
    });
    oma.loppu = { tyyppi: 'valmis', ...v };
  } catch (e) {
    if (!oma) throw e;
    oma.loppu = { tyyppi: 'virhe', virhe: e.message };
  }
  oma.aika = kello();
  for (const r of oma.kuuntelijat) { kirjoitaNdjson(r, oma.loppu); r.end(); }
  oma.kuuntelijat.clear();
}

function liity(res, ymp) {
  const kello = ymp.kello ?? Date.now;
  const { ajo } = luoChat(ymp).tila;
  if (!ajo || (ajo.loppu && kello() - ajo.aika > LOPPUTULOS_MS)) throw new Hylatty(404, 'ei käynnissä olevaa vastausta');
  res.writeHead(200, NDJSON);
  if (ajo.teksti) kirjoitaNdjson(res, { tyyppi: 'pala', teksti: ajo.teksti });
  if (ajo.loppu) { kirjoitaNdjson(res, ajo.loppu); return res.end(); }
  const oma = ajo;
  oma.kuuntelijat.add(res);
  res.on('close', () => oma.kuuntelijat.delete(res));
}

// Reitit. Virheet (Hylatty) muuttuu statukseksi palvelin.mjs:ssä.
// kopio: scopes/palvelu/palvelin.mjs:244-247, :321-325 (21.10.2026)
export const REITIT = [
  { metodi: 'POST', kuvio: '/api/chat', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    vastaa(res, 200, await luoChat(ymp).chat(await lueRunko(req, 32_768)));
  } },
  { metodi: 'POST', kuvio: '/api/chat/virta', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    await virtaa(res, await lueRunko(req, 32_768), ymp);
  } },
  { metodi: 'GET', kuvio: '/api/chat/kaynnissa', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    liity(res, ymp);
  } },
  // Stop-nappi (CHAT-STOP): chat-vastaus katkeaa ja valmis-rivi tuo osittaisen vastauksen.
  { metodi: 'POST', kuvio: '/api/chat/stop', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    vastaa(res, 200, luoChat(ymp).pysaytaChat());
  } },
  { metodi: 'GET', kuvio: '/api/chat/keskustelut', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    vastaa(res, 200, luoChat(ymp).keskustelut());
  } },
  { metodi: 'GET', kuvio: '/api/chat/keskustelut/*', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    vastaa(res, 200, luoChat(ymp).keskustelunViestit(osat[0]));
  } },
];
