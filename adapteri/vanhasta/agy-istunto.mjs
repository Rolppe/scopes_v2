// kopio: scopes/palvelu/agy-istunto.mjs @ 47b8ccaf (28.10.2026, uudelleensynkka: a85e3c0b oli muuttanut kopiota osittain); muuttuneet vain import-rivit
// Agy-istunnon näkyvyys äpille (AGY-PRE-ISTUNTO 16.10.2026, käyttäjä: "purku ei ala ... skooppi ei ole auki").
// Claude Code kirjoittaa keskustelun jsonl-transkriptiin, jonka lahteet.mjs ja viestit.mjs lukevat. Agy ei kirjoita sitä:
// istunto on tmux-ruudussa (`siirto-<slug>-<hhmmss>`, komento agy) ja keskustelu SQLite-tiedostossa
// ~/.gemini/antigravity-cli/conversations/<id>.db, jonka `steps`-taulun step_payload on protobuf ilman skeemaa.
// Todennettu 16.10.2026 agy 1.2.15:llä: step_type 14 = käyttäjän viesti (kenttä 19.2 teksti), 15 = agentin vastaus
// (kenttä 20.1 teksti; 20.3 on ajatteluteksti, jätetään pois), 132 = työkalukutsu (JSON-kenttä "toolAction"), aika
// kentässä 5.1.1 (sekunnit). Muut step_typet ohitetaan. Muoto on agy:n sisäinen: tuntematon rakenne antaa vähemmän viestejä,
// ei virhettä.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile, execFileSync } from 'node:child_process';

export const AGY_KESKUSTELUT = join(homedir(), '.gemini/antigravity-cli/conversations');
export const BRAIN_HAKEMISTO = join(homedir(), '.gemini/antigravity-cli/brain');

// Protobuf-langat: [{ f, w, v }] (varint → numero, pituuskenttä → Buffer). Katkennut tai tuntematon data lopettaa lukemisen.
export function pb(buf) {
  const kentat = [];
  let i = 0;
  const varint = () => {
    let r = 0, kerroin = 1;
    for (;;) {
      if (i >= buf.length) throw new RangeError('varint');
      const x = buf[i++];
      r += (x & 0x7f) * kerroin;
      if (x < 0x80) return r;
      kerroin *= 128;
    }
  };
  try {
    while (i < buf.length) {
      const k = varint();
      const f = Math.floor(k / 8), w = k % 8;
      if (w === 0) kentat.push({ f, w, v: varint() });
      else if (w === 2) { const l = varint(); if (i + l > buf.length) break; kentat.push({ f, w, v: buf.subarray(i, i + l) }); i += l; }
      else if (w === 1) i += 8;
      else if (w === 5) i += 4;
      else break;
    }
  } catch { /* katkennut loppu */ }
  return kentat;
}
const onTavut = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array;
const kentta = (kentat, f) => kentat.find((k) => k.f === f);
const alikentat = (kentat, f) => { const k = kentta(kentat, f); return k && onTavut(k.v) ? pb(k.v) : []; };
const teksti = (k) => (k && onTavut(k.v) ? Buffer.from(k.v).toString('utf8') : '');

// Työkalukutsun purku step_payloadista (f=5 -> f=4 -> f=2 nimi, f=3 args).
export function tyokaluKutsu(ylin) {
  for (const item of ylin) {
    if (item.f !== 5 || !onTavut(item.v)) continue;
    const f4 = kentta(pb(item.v), 4);
    if (!f4 || !onTavut(f4.v)) continue;
    const f4inner = pb(f4.v);
    const nimi = teksti(kentta(f4inner, 2));
    const argsStr = teksti(kentta(f4inner, 3));
    let args = null;
    if (argsStr) {
      try { args = JSON.parse(argsStr); } catch { /* ei json */ }
    }
    return { nimi, args };
  }
  return null;
}

// Kysymyksen vastauksen purku kentästä 147 (f=147 -> f=2 -> f=22 -> [0] -> f=4 vastaus).
export function poimiAgyVastaus(ylin) {
  const f147 = kentta(ylin, 147);
  if (!f147 || !onTavut(f147.v)) return null;
  const f2 = kentta(pb(f147.v), 2);
  if (!f2 || !onTavut(f2.v)) return null;
  const f22 = kentta(pb(f2.v), 22);
  if (!f22 || !onTavut(f22.v)) return null;
  const f22inner = pb(f22.v);
  if (!f22inner.length || !onTavut(f22inner[0].v)) return null;
  const ansObj = pb(f22inner[0].v);
  return teksti(kentta(ansObj, 4)) || null;
}

// ask_question-työkalukutsun jäsennys monivalintakysymykseksi ({ rooli: 'kysymys', ... }).
export function jasennaAgyKysymys(args, payloadStr, aika, ylin = null) {
  let kysymysLista = [];
  if (args && Array.isArray(args.questions)) {
    kysymysLista = args.questions;
  } else if (args && args.question) {
    kysymysLista = [args];
  } else if (payloadStr) {
    const m = /"questions"\s*:\s*(\[[\s\S]*?\])\s*,\s*"toolAction"/.exec(payloadStr)
      ?? /"questions"\s*:\s*(\[[\s\S]*?\])/.exec(payloadStr);
    if (m) {
      try { kysymysLista = JSON.parse(m[1]); } catch { /* ei json */ }
    }
  }
  if (!kysymysLista.length) return null;
  const kysymykset = kysymysLista.map((q) => {
    const otsikko = q?.header ? String(q.header) : null;
    const monivalinta = q?.is_multi_select === true || q?.multiSelect === true;
    const vaihtoehdot = (Array.isArray(q?.options) ? q.options : []).map((v) => {
      if (typeof v === 'string') return { nimi: v, kuvaus: null };
      return {
        nimi: String(v?.label ?? v?.name ?? v?.option ?? ''),
        kuvaus: v?.description ? String(v.description) : null,
      };
    });
    return { kysymys: String(q?.question ?? ''), otsikko, monivalinta, vaihtoehdot };
  });
  const teksti = kysymykset.map((q) => [q.kysymys, ...q.vaihtoehdot.map((v, i) => `${i + 1}. ${v.nimi}`)].join('\n')).join('\n\n');
  const vastausVal = ylin ? poimiAgyVastaus(ylin) : null;
  let vastausTeksti = null;
  if (vastausVal) {
    const num = Number(vastausVal);
    if (Number.isFinite(num) && num >= 1 && num <= (kysymykset[0]?.vaihtoehdot?.length ?? 0)) {
      vastausTeksti = kysymykset[0].vaihtoehdot[num - 1].nimi;
    } else {
      vastausTeksti = vastausVal;
    }
  }
  return {
    rooli: 'kysymys',
    teksti,
    aika,
    kysymykset,
    vastattu: Boolean(vastausVal),
    vastaus: vastausTeksti,
  };
}

// Askeleen viesti tai null: { rooli: 'kayttaja'|'agentti'|'tyokalu'|'kysymys', teksti, aika }.
export function askel(tyyppi, payload) {
  if (!payload) return null;
  const ylin = pb(Buffer.from(payload));
  const sek = kentta(alikentat(alikentat(ylin, 5), 1), 1)?.v;
  const aika = Number.isFinite(sek) ? new Date(sek * 1000).toISOString() : null;
  if (tyyppi === 14) {
    const t = teksti(kentta(alikentat(ylin, 19), 2)).trim();
    return t ? { rooli: 'kayttaja', teksti: t, aika } : null;
  }
  if (tyyppi === 15) {
    const t = teksti(kentta(alikentat(ylin, 20), 1)).trim();
    return t ? { rooli: 'agentti', teksti: t, aika } : null;
  }
  if (tyyppi === 132) {
    const tk = tyokaluKutsu(ylin);
    const pStr = Buffer.from(payload).toString('utf8');
    if (tk?.nimi === 'ask_question' || pStr.includes('"ask_question"')) {
      const qm = jasennaAgyKysymys(tk?.args, pStr, aika, ylin);
      if (qm) return qm;
    }
    const m = /"toolAction":"((?:[^"\\]|\\.)*)"/.exec(pStr);
    return { rooli: 'tyokalu', teksti: m ? m[1].replace(/\\"/g, '"').slice(0, 120) : 'työkalu', aika };
  }
  return null;
}

const avaa = (polku) => new DatabaseSync(polku, { readOnly: true });

// Keskustelun viestit järjestyksessä (viimeiset `maara`).
export function agyViestit(polku, maara = 120) {
  let db;
  try {
    db = avaa(polku);
    const rivit = db.prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx').all();
    const tulos = [];
    for (let i = 0; i < rivit.length; i++) {
      const v = askel(rivit[i].step_type, rivit[i].step_payload);
      if (!v) continue;
      if (v.rooli === 'kysymys') {
        if (i < rivit.length - 1) v.vastattu = true;
        const vastaus = v.vastaus;
        delete v.vastaus;
        tulos.push(v);
        if (v.vastattu && vastaus) {
          tulos.push({ rooli: 'kayttaja', teksti: vastaus, aika: v.aika });
        }
      } else {
        tulos.push(v);
      }
    }
    return tulos.slice(-maara);
  } catch { return []; } finally { try { db?.close(); } catch { /* ei auki */ } }
}

// Keskustelun ensimmäinen käyttäjän viesti (kevyt kysely; koko tiedostoa ei pureta). Tunnisteena käytetään sitä, koska viimeisten
// viestien joukosta alkuviesti putoaa pois keskustelun kasvaessa (test 2, 16.10.2026: haku katsoi vain kolme viimeistä viestiä).
export function ensimmainenKayttaja(polku) {
  let db;
  try {
    db = avaa(polku);
    const r = db.prepare('SELECT idx, step_type, step_payload FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1').get();
    return r ? askel(r.step_type, r.step_payload)?.teksti ?? null : null;
  } catch { return null; } finally { try { db?.close(); } catch { /* ei auki */ } }
}

// Skoopin purkutiedosto `<slug>.md` on keskustelun ensimmäisen viestin sisältö (autovaihto.sh: "Malliton purku: lue …").
// Etsitään tmux-istunnon alun jälkeen muuttuneista tiedostoista uusin, jonka alkuviestissä se on. Löydetty tiedosto muistetaan,
// ettei jokainen kysely avaa ehdokkaita uudelleen. Kaikki ehdokkaat käydään läpi (ISTUNNOT-SUORITUSKYKY 18.10.2026): joutilaan
// istunnon tiedosto jäi 12 uusimman ulkopuolelle, kun muut agy-istunnot olivat työssä, eikä Macin ssh-haku (uusi node joka
// kerta) hyödy muistista.
const loydetyt = new Map();
export function loydaKeskustelu(slug, alkoiMs, hakemisto = AGY_KESKUSTELUT) {
  if (!existsSync(hakemisto)) return null;
  const avain = `${hakemisto}|${slug}|${alkoiMs}`;
  const muistettu = loydetyt.get(avain);
  if (muistettu && existsSync(muistettu)) return muistettu;
  const ehdokkaat = [];
  for (const f of readdirSync(hakemisto)) {
    if (!f.endsWith('.db')) continue;
    const polku = join(hakemisto, f);
    let m;
    try { m = statSync(polku).mtimeMs; } catch { continue; }
    if (m >= alkoiMs - 5000) ehdokkaat.push({ polku, m });
  }
  ehdokkaat.sort((a, b) => b.m - a.m);
  for (const { polku } of ehdokkaat) {
    if ((ensimmainenKayttaja(polku) ?? '').includes(`${slug}.md`)) { loydetyt.set(avain, polku); return polku; }
  }
  return null;
}

// Skoopin käynnissä olevat agy-ruudut: tmux-istunto siirto-<slug>-<hhmmss>, ruudun komento agy. Uusin ensin.
export async function agyRuudut(aja, nimi) {
  const t = await aja('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_current_command} #{session_created} #{pane_pid}']);
  if (t.koodi !== 0) return [];
  const slug = String(nimi).toLowerCase().replace(/[^a-z0-9]/g, '-');
  const re = new RegExp(`^(siirto-${slug}-\\d{6}) (agy|ssh)(?:\\s+(\\d+))?(?:\\s+(\\d+))?$`);
  return t.stdout.split('\n').map((r) => re.exec(r.trim())).filter(Boolean)
    .map((m) => ({
      ruutu: m[1],
      ...(m[2] === 'ssh' ? { onMac: true } : {}),
      alkoi: m[3] ? Number(m[3]) * 1000 : 0,
      ...(m[4] ? { pid: Number(m[4]) } : {}),
    })).sort((a, b) => b.alkoi - a.alkoi);
}

// Ruudun tilan ja kyselykortin jäsennys (AGY-COMPATIBILITY-ISTUNNOT 16.10.2026).
// - idle: alariveillä "? for shortcuts" (vapaa odottamaan syötettä)
// - waiting + kysely: true: auki oleva monivalinta (ask_question: Navigate · enter Select / Question 1/1)
// - waiting + kysely: false: lupakysely (Run this command? / Allow access to this file?)
// - busy: työssä (ajattelu, työkalut, käynnissä oleva komento)
// - idle: syötekehote avoinna käyttäjälle (? for shortcuts / prompt >)
export function jasennaAgyRuutu(stdout) {
  const teksti = String(stdout ?? '');
  const rivit = teksti.split('\n').map((r) => r.trim()).filter(Boolean);
  if (/Navigate\s*·\s*enter\s*Select|enter\s+Select|Question\s+\d+\/\d+|\bWrite-in\.\.\./.test(teksti)) {
    return { tila: 'waiting', kysely: true };
  }
  if (/Run this command\?|Allow access to this file\?|Allow\s+.*?to\s+execute|Do you want to run\?|^\s*(?:>\s*)?1\.\s+(?:Yes|Kyllä|Always allow)\b/m.test(teksti)) {
    return { tila: 'waiting', kysely: false };
  }
  if (/Thinking|esc to cancel|Esc to cancel|Cancel\s*\(esc\)|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(teksti)) {
    return { tila: 'busy', kysely: false };
  }
  const alarivit = rivit.slice(-4);
  if (alarivit.some((r) => r.includes('? for shortcuts') || r.startsWith('>'))) {
    return { tila: 'idle', kysely: false };
  }
  return { tila: 'busy', kysely: false };
}

export const ruudunTila = (ruutu) => {
  const rivit = String(ruutu ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  return rivit.slice(-2).some((r) => r.startsWith('? for shortcuts')) ? 'idle' : 'busy';
};

// Poimii AGY-ruudun alareunasta aktiivisen mallin ja effort-tason (esim. "? for shortcuts ... · Gemini 3.8 Flash · medium").
export function poimiAgyRuudunAsetukset(ruutuTeksti) {
  if (!ruutuTeksti) return { malli: null, effort: null };
  const rivit = String(ruutuTeksti).split('\n').map((r) => r.trim()).filter(Boolean);
  const tilarivi = rivit.slice(-4).find((r) => r.includes('? for shortcuts')) ?? rivit.at(-1);
  if (!tilarivi || !tilarivi.includes('·')) return { malli: null, effort: null };
  const osat = tilarivi.split(/\s*·\s*/);
  let effort = null;
  let malli = null;
  for (const osa of osat.slice(1)) {
    const o = osa.toLowerCase().trim();
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(o)) effort = o;
    else if (osa.trim()) malli = osa.trim();
  }
  return { malli, effort };
}

export const mallitonSlug = (nimi) => String(nimi).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Viimeisimmän agenttivastauksen (step_type 15) tokenimäärä metadatan kentästä 9 (input + output).
export function agyTokenit(db) {
  try {
    const row = db.prepare('SELECT metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL ORDER BY idx DESC LIMIT 1').get();
    if (!row?.metadata) return null;
    const parsed = pb(Buffer.from(row.metadata));
    const f9 = parsed.find((k) => k.f === 9);
    if (!f9 || !Buffer.isBuffer(f9.v)) return null;
    const inner = pb(f9.v);
    const out = inner.find((x) => x.f === 1)?.v ?? 0;
    const inp = inner.find((x) => x.f === 2)?.v ?? 0;
    const summa = inp + out;
    return summa > 0 ? summa : null;
  } catch { return null; }
}

const PAKKAUSRIVI = /^[\s*`>]*(PAKKAUS:[*`\s]*vahvistettu|PAKATTU:|PAKKAUS:[*`\s]*epäselvä.*\bcommit(it)?[\s`]+[0-9a-f]{7,})/m;
export function agyPakattu(viestit) {
  let tulos = false;
  for (const v of viestit) {
    if (v.rooli === 'agentti' && PAKKAUSRIVI.test(v.teksti)) tulos = true;
    else if (v.rooli === 'kayttaja') tulos = false;
  }
  return tulos;
}

// Onko SQLite-kannan viimeisin askel avoin monivalintakysely (ask_question) odottamassa vastausta (status 9).
export function agyKyselyAuki(db) {
  try {
    const row = db.prepare('SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx DESC LIMIT 1').get();
    if (!row) return false;
    if (row.step_type === 132 && row.status === 9) {
      const s = Buffer.from(row.step_payload).toString('utf8');
      if (s.includes('ask_question') || s.includes('AskUserQuestion')) return true;
    }
    return false;
  } catch { return false; }
}

// AGY-transkriptin lukeminen (transcript.jsonl / transcript_full.jsonl): tokenit, viimeisin pysähdys ja avoin kyselytila.
export function lueAgyTranskripti(convId, brainHakemisto = BRAIN_HAKEMISTO) {
  const perus = convId.endsWith('.jsonl') ? convId : join(brainHakemisto, convId, '.system_generated/logs/transcript.jsonl');
  const fullPolku = convId.endsWith('.jsonl') ? null : join(brainHakemisto, convId, '.system_generated/logs/transcript_full.jsonl');
  const polku = fullPolku && existsSync(fullPolku) ? fullPolku : perus;
  if (!existsSync(polku)) return null;
  try {
    const koko = statSync(polku).size;
    if (koko === 0) return { tokenit: null, aika: null, pysahdys: null, kysely: false, polku };
    const lueKoko = Math.min(koko, 65536);
    const puskuri = Buffer.alloc(lueKoko);
    const fd = openSync(polku, 'r');
    try {
      readSync(fd, puskuri, 0, lueKoko, koko - lueKoko);
    } finally {
      closeSync(fd);
    }
    const teksti = puskuri.toString('utf8');
    const rivit = teksti.split('\n');
    let tokenit = null;
    let viimeisinAika = null;
    let pysahdysAika = null;
    let kysely = false;
    let pakattu = false;
    let pakattuLoytyi = false;
    let viimeisinStep = null;
    for (let i = rivit.length - 1; i >= 0; i--) {
      const rivi = rivit[i].trim();
      if (!rivi) continue;
      let j;
      try { j = JSON.parse(rivi); } catch { continue; }
      if (!viimeisinStep) {
        viimeisinStep = j;
        if (j.type === 'PLANNER_RESPONSE' && Array.isArray(j.tool_calls) && j.tool_calls.some((tc) => tc?.name === 'ask_question')) {
          kysely = true;
        }
      }
      if (!pakattuLoytyi) {
        if ((j.type === 'PLANNER_RESPONSE' || j.type === 'GENERIC') && typeof j.content === 'string') {
          if (PAKKAUSRIVI.test(j.content)) {
            pakattu = true;
            pakattuLoytyi = true;
          }
        } else if (j.type === 'USER_INPUT' && j.source !== 'SYSTEM') {
          pakattu = false;
          pakattuLoytyi = true;
        }
      }
      const t = j.created_at ?? j.timestamp ?? null;
      if (!viimeisinAika && t) viimeisinAika = t;
      if (!pysahdysAika && t) {
        const onKysely = j.type === 'PLANNER_RESPONSE' && Array.isArray(j.tool_calls) && j.tool_calls.some((tc) => tc?.name === 'ask_question');
        const onVastaus = j.type === 'PLANNER_RESPONSE' && Boolean(j.content);
        if (onKysely || onVastaus) pysahdysAika = t;
      }
      if (tokenit == null && (j.input_tokens != null || j.cache_read_tokens != null)) {
        tokenit = (j.input_tokens || 0) + (j.cache_read_tokens || 0);
      }
      if (tokenit != null && viimeisinAika && pysahdysAika) break;
    }
    return { tokenit, aika: viimeisinAika, pysahdys: pysahdysAika ?? viimeisinAika, kysely, pakattu, polku };
  } catch {
    return null;
  }
}

// Prosessin cmdlinestä malli ja effort (--model <malli>-<effort> tai pelkkä malli).
export function lueAgyMalliEffort(pid, proc = '/proc') {
  if (!pid) return { malli: null, effort: null };
  try {
    const raw = readFileSync(join(proc, String(pid), 'cmdline'), 'utf8');
    const osat = raw.split('\0').filter(Boolean);
    let malliStr = null;
    for (let i = 0; i < osat.length; i++) {
      if ((osat[i] === '--model' || osat[i] === '-m') && osat[i + 1]) {
        malliStr = osat[i + 1];
        break;
      }
    }
    if (!malliStr) {
      const mMatch = /--model[=\s]+["']?([^"'\s]+)["']?/.exec(raw)
        ?? /-m[=\s]+["']?([^"'\s]+)["']?/.exec(raw);
      if (mMatch) malliStr = mMatch[1];
    }
    if (!malliStr) return { malli: null, effort: null };
    const onMac = raw.includes('mac') || osat[0] === 'ssh';
    if (onMac) {
      const m = /^(gemini-[\w\.-]+)-(low|medium|high|xhigh|max)$/.exec(malliStr);
      return { malli: `mac-agy/${malliStr}`, effort: m ? m[2] : null };
    }
    const m = /^(gemini-[\w\.-]+)-(low|medium|high|xhigh|max)$/.exec(malliStr);
    if (m) {
      return { malli: m[1], effort: m[2] };
    }
    return { malli: malliStr, effort: null };
  } catch {
    return { malli: null, effort: null };
  }
}

export function poimiMacAgyTiedot(slug, alkoiMs, maara = 120, hakemisto = AGY_KESKUSTELUT, brainHakemisto = BRAIN_HAKEMISTO) {
  const dbPolku = loydaKeskustelu(slug, alkoiMs, hakemisto);
  if (!dbPolku) return { loytyi: false };
  const convId = basename(dbPolku, '.db');
  const transkripti = lueAgyTranskripti(convId, brainHakemisto);
  const viestit = agyViestit(dbPolku, maara);
  let tokenit = transkripti?.tokenit ?? null;
  let kysely = transkripti?.kysely ?? false;
  let pakattu = agyPakattu(viestit);
  let aika = transkripti?.aika ?? (viestit.at(-1)?.aika ?? null);
  let pysahdys = transkripti?.pysahdys ?? (viestit.filter((v) => v.rooli === 'agentti').at(-1)?.aika ?? aika);

  let db;
  try {
    db = new DatabaseSync(dbPolku, { readOnly: true });
    if (agyKyselyAuki(db)) kysely = true;
    if (!tokenit) tokenit = agyTokenit(db);
  } catch { /* ei kantaa */ } finally {
    try { db?.close(); } catch {}
  }

  return {
    loytyi: true,
    convId,
    dbPolku,
    viestit,
    tokenit,
    kysely,
    pakattu,
    aika,
    pysahdys,
  };
}

// Mac-agy-istuntojen tiedot haetaan Macilta ssh:lla (ISTUNNOT-SUORITUSKYKY 18.10.2026). Haku ei saa jumittaa palvelun
// tapahtumasilmukkaa eikä /api/skoopit-vastausta: samassa tikissä pyydetyt slugit kulkevat yhdessä ssh-kutsussa, tuore
// tieto (alle MAC_AGY_TTL) palautetaan suoraan, vanhentunut (alle MAC_AGY_MAKSIMI) palautetaan heti ja päivitetään
// taustalla, ja synkroninen haku lukee vain välimuistia. Mitätöity tieto (viestin lähetys) odottaa uuden haun.
const macAgyValimuisti = new Map();
const keskenMacHaut = new Map();
const MAC_AGY_TTL = 30_000;
const MAC_AGY_MAKSIMI = 300_000;
const MAC_AGY_AIKARAJA = 10_000;
// MAC_PROJ laajenee Macin kuoressa (PARAMETRISOINTI-3): yksöislainaus katkaistaan juuren kohdalla.
const MAC_AGY_MODUULI = `'"\${MAC_PROJ:-$HOME/Projects}"'/claude/sessions-repo/scopes/palvelu/agy-istunto.mjs`;
// Slug kulkee etäkuoren lainausmerkeissä, joten vain mallitonSlug-muoto kelpaa.
const MAC_SLUG = /^[a-z0-9-]+$/;
let macAgyEra = null;

// Slugilla mitätöi (data jää varatiedoksi); ilman slugia tyhjentää kaiken.
export function tyhjennaMacAgyValimuisti(slug) {
  if (!slug) return macAgyValimuisti.clear();
  const e = macAgyValimuisti.get(slug);
  if (e) e.aika = 0;
}

export function asetaMacAgyValimuisti(slug, data) {
  macAgyValimuisti.set(slug, { aika: Date.now(), data });
}

const oletusAja = (komento, argumentit, { aikaraja } = {}) => new Promise((ok) => {
  execFile(komento, argumentit, { timeout: aikaraja, maxBuffer: 8 << 20 }, (virhe, stdout) =>
    ok({ koodi: virhe ? (typeof virhe.code === 'number' ? virhe.code : -1) : 0, stdout: String(stdout) }));
});

// [[slug, alkoi, maara], …] yhdellä ssh-kutsulla → { slug: poimiMacAgyTiedot(…) }.
async function ajaMacAgyHaku(kohteet, aja) {
  const koodi = `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; node -e 'import { poimiMacAgyTiedot } from "${MAC_AGY_MODUULI}"; const o = {}; for (const [s, a, m] of ${JSON.stringify(kohteet)}) { try { o[s] = poimiMacAgyTiedot(s, a, m); } catch { o[s] = { loytyi: false }; } } console.log(JSON.stringify(o));'`;
  const res = await aja('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', 'mac', koodi], { aikaraja: MAC_AGY_AIKARAJA });
  if (res.koodi !== 0) throw new Error(`ssh dev-host: koodi ${res.koodi}`);
  return JSON.parse(res.stdout.trim());
}

// Kokoaa saman tikin pyynnöt yhteen eräksi; ensimmäisen pyytäjän ajaja ajaa erän.
function macAgyErassa(slug, alkoi, maara, aja) {
  if (!macAgyEra) {
    const era = { kohteet: [], aja };
    era.tulos = new Promise((ok) => setImmediate(ok)).then(() => {
      macAgyEra = null;
      return ajaMacAgyHaku(era.kohteet, era.aja);
    });
    macAgyEra = era;
  }
  macAgyEra.kohteet.push([slug, alkoi ?? 0, maara]);
  return macAgyEra.tulos.then((o) => o[slug] ?? { loytyi: false });
}

// Ei koskaan hylkää: epäonnistunut haku pitää edellisen tiedon ja merkitsee sen tuoreeksi, jotta Macin ollessa poissa
// jokainen pyyntö ei odota ssh:n aikarajaa.
function paivitaMacAgy(slug, alkoi, maara, aja) {
  if (keskenMacHaut.has(slug)) return keskenMacHaut.get(slug);
  const lupaus = macAgyErassa(slug, alkoi, maara, aja)
    .catch(() => macAgyValimuisti.get(slug)?.data ?? { loytyi: false })
    .then((data) => { asetaMacAgyValimuisti(slug, data); return data; })
    .finally(() => keskenMacHaut.delete(slug));
  keskenMacHaut.set(slug, lupaus);
  return lupaus;
}

const paikallinenMac = (aja = null) => platform() === 'darwin' && !process.env.SCOPES_TEST_REMOTE && !aja;

export async function haeMacAgyKeskustelu({ slug, alkoi, maara = 120, aja = null }) {
  const e = macAgyValimuisti.get(slug);
  const ika = e ? Date.now() - e.aika : Infinity;
  if (ika < MAC_AGY_TTL) return e.data;
  if (paikallinenMac(aja)) {
    const data = poimiMacAgyTiedot(slug, alkoi, maara);
    asetaMacAgyValimuisti(slug, data);
    return data;
  }
  if (!MAC_SLUG.test(slug)) return { loytyi: false };
  const haku = paivitaMacAgy(slug, alkoi, maara, aja ?? oletusAja);
  return ika < MAC_AGY_MAKSIMI ? e.data : haku;
}

// Synkroninen (lahteet.mjs:istunnot(), viestit.mjs): ei ssh:ta. Palauttaa välimuistin ja käynnistää taustahaun, kun
// tieto puuttuu tai on vanha; seuraava kysely saa tuoreen tiedon.
export function haeMacAgyKeskusteluSync({ slug, alkoi, maara = 120, aja = oletusAja }) {
  const e = macAgyValimuisti.get(slug);
  if (e && Date.now() - e.aika < MAC_AGY_TTL) return e.data;
  if (paikallinenMac(aja === oletusAja ? null : aja)) {
    const data = poimiMacAgyTiedot(slug, alkoi, maara);
    asetaMacAgyValimuisti(slug, data);
    return data;
  }
  if (MAC_SLUG.test(slug)) paivitaMacAgy(slug, alkoi, maara, aja);
  return e?.data ?? { loytyi: false };
}

function rakennaAgyIstunto({ slug, skooppi, ruutu, alkoi, pid, ruutuTeksti, proc, agyHakemisto, brainHakemisto, onMac = false, macTiedot = null }) {
  let { tila, kysely } = jasennaAgyRuutu(ruutuTeksti);
  let dbPolku = null;
  let viestit = [];
  let tokenit = null;
  let viimeisinAika = alkoi ? new Date(alkoi).toISOString() : null;
  let pysahdysAika = null;
  let onkoPakattu = false;
  let polku = null;

  if (onMac && macTiedot?.loytyi) {
    dbPolku = macTiedot.dbPolku;
    polku = dbPolku;
    viestit = macTiedot.viestit ?? [];
    tokenit = macTiedot.tokenit ?? null;
    if (macTiedot.aika) viimeisinAika = macTiedot.aika;
    pysahdysAika = macTiedot.pysahdys ?? viimeisinAika;
    onkoPakattu = macTiedot.pakattu ?? false;
    if (macTiedot.kysely) {
      kysely = true;
      tila = 'waiting';
    }
  } else if (!onMac) {
    dbPolku = loydaKeskustelu(slug, alkoi, agyHakemisto);
    polku = dbPolku;
    if (dbPolku) {
      const convId = basename(dbPolku, '.db');
      const transkriptiTiedot = lueAgyTranskripti(convId, brainHakemisto);
      if (transkriptiTiedot?.polku) polku = transkriptiTiedot.polku;
      if (transkriptiTiedot?.pakattu != null) onkoPakattu = transkriptiTiedot.pakattu;
      if (transkriptiTiedot?.tokenit) tokenit = transkriptiTiedot.tokenit;
      if (transkriptiTiedot?.kysely) {
        kysely = true;
        tila = 'waiting';
      }
      if (transkriptiTiedot?.aika) viimeisinAika = transkriptiTiedot.aika;
      if (transkriptiTiedot?.pysahdys) pysahdysAika = transkriptiTiedot.pysahdys;

      if (!transkriptiTiedot || !tokenit) {
        let db;
        try {
          db = new DatabaseSync(dbPolku, { readOnly: true });
          if (agyKyselyAuki(db)) {
            kysely = true;
            tila = 'waiting';
          }
          if (!tokenit) {
            tokenit = agyTokenit(db);
          }
        } catch { /* ei kantaa */ } finally {
          try { db?.close(); } catch { /* ei auki */ }
        }
      }

      if (!transkriptiTiedot) {
        viestit = agyViestit(dbPolku);
        if (viestit.length) {
          const viim = viestit.at(-1);
          if (viim?.aika) viimeisinAika = viim.aika;
          const viimAgentti = viestit.filter((v) => v.rooli === 'agentti').at(-1);
          if (viimAgentti?.aika) pysahdysAika = viimAgentti.aika;
          onkoPakattu = agyPakattu(viestit);
        }
      }
    }
  }
  let { malli, effort } = lueAgyMalliEffort(pid, proc);
  const ruutuAsetukset = poimiAgyRuudunAsetukset(ruutuTeksti);
  if (ruutuAsetukset.effort) effort = ruutuAsetukset.effort;
  if (ruutuAsetukset.malli && !malli) malli = ruutuAsetukset.malli;
  if (effort && malli && /-(low|medium|high|xhigh|max)$/.test(malli)) {
    malli = malli.replace(/-(low|medium|high|xhigh|max)$/, `-${effort}`);
  }
  return {
    id: ruutu,
    nimi: ruutu,
    tila,
    kysely,
    skooppi,
    konteksti: tokenit ? { tokenit, aika: viimeisinAika } : null,
    pysahdys: pysahdysAika ?? viimeisinAika,
    pakattu: onkoPakattu,
    hereilla: false,
    alkoi,
    pid,
    vanhempi: null,
    ruutu,
    polku,
    dbPolku,
    tyyppi: 'agy',
    malli,
    effort,
    onMac,
    viestit,
  };
}

// Kaikkien skooppien aktiiviset AGY-istunnot synkronisesti (lahteet.mjs:istunnot()).
export function agyIstunnotSync({
  skooppiNimet = [],
  proc = '/proc',
  agyHakemisto = AGY_KESKUSTELUT,
  brainHakemisto = BRAIN_HAKEMISTO,
  listPanes = null,
  capturePane = null,
} = {}) {
  let stdout = '';
  if (typeof listPanes === 'function') {
    stdout = listPanes();
  } else if (typeof listPanes === 'string') {
    stdout = listPanes;
  } else {
    try {
      stdout = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_current_command} #{session_created} #{pane_pid}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return []; }
  }
  if (!stdout) return [];
  const captureFn = typeof capturePane === 'function' ? capturePane : (ruutu) => {
    try {
      return execFileSync('tmux', ['capture-pane', '-p', '-t', ruutu], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return ''; }
  };
  const slugit = new Map(skooppiNimet.map((n) => [mallitonSlug(n), n]));
  const re = /^siirto-(.+)-(\d{6})\s+(agy|ssh)(?:\s+(\d+))?(?:\s+(\d+))?$/;
  const tulos = [];
  for (const rivi of stdout.split('\n')) {
    const m = re.exec(rivi.trim());
    if (!m) continue;
    const slug = m[1];
    const skooppi = slugit.get(slug);
    if (!skooppi) continue;
    const ruutu = `siirto-${slug}-${m[2]}`;
    const onMac = m[3] === 'ssh';
    const alkoi = m[4] ? Number(m[4]) * 1000 : 0;
    const pid = m[5] ? Number(m[5]) : null;
    const ruutuTeksti = captureFn(ruutu);
    let macTiedot = null;
    if (onMac) {
      macTiedot = haeMacAgyKeskusteluSync({ slug, alkoi });
    }
    tulos.push(rakennaAgyIstunto({ slug, skooppi, ruutu, alkoi, pid, ruutuTeksti, proc, agyHakemisto, brainHakemisto, onMac, macTiedot }));
  }
  return tulos;
}

// Kaikkien skooppien aktiiviset AGY-istunnot asynkronisesti (palvelin.mjs GET /api/skoopit).
export async function agyIstunnot({
  skooppiNimet = [],
  aja,
  agyHakemisto = AGY_KESKUSTELUT,
  brainHakemisto = BRAIN_HAKEMISTO,
  proc = '/proc',
  listPanes = null,
  capturePane = null,
} = {}) {
  let stdout = '';
  if (typeof listPanes === 'function') {
    stdout = listPanes();
  } else if (typeof listPanes === 'string') {
    stdout = listPanes;
  } else if (aja) {
    const t = await aja('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_current_command} #{session_created} #{pane_pid}']);
    if (t.koodi === 0) stdout = t.stdout;
  } else {
    try {
      stdout = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_current_command} #{session_created} #{pane_pid}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return []; }
  }
  if (!stdout) return [];
  const captureFn = typeof capturePane === 'function' ? capturePane : aja
    ? async (ruutu) => {
        const c = await aja('tmux', ['capture-pane', '-p', '-t', ruutu]);
        return c.koodi === 0 ? c.stdout : '';
      }
    : (ruutu) => {
        try {
          return execFileSync('tmux', ['capture-pane', '-p', '-t', ruutu], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch { return ''; }
      };
  const slugit = new Map(skooppiNimet.map((n) => [mallitonSlug(n), n]));
  const re = /^siirto-(.+)-(\d{6})\s+(agy|ssh)(?:\s+(\d+))?(?:\s+(\d+))?$/;
  const kohteet = [];
  for (const rivi of stdout.split('\n')) {
    const m = re.exec(rivi.trim());
    if (!m) continue;
    const slug = m[1];
    const skooppi = slugit.get(slug);
    if (!skooppi) continue;
    const ruutu = `siirto-${slug}-${m[2]}`;
    const onMac = m[3] === 'ssh';
    const alkoi = m[4] ? Number(m[4]) * 1000 : 0;
    const pid = m[5] ? Number(m[5]) : null;
    kohteet.push({ slug, skooppi, ruutu, onMac, alkoi, pid });
  }

  const tulos = await Promise.all(
    kohteet.map(async ({ slug, skooppi, ruutu, onMac, alkoi, pid }) => {
      const [ruutuTeksti, macTiedot] = await Promise.all([
        captureFn(ruutu),
        onMac ? haeMacAgyKeskustelu({ slug, alkoi, aja }) : Promise.resolve(null),
      ]);
      return rakennaAgyIstunto({ slug, skooppi, ruutu, alkoi, pid, ruutuTeksti, proc, agyHakemisto, brainHakemisto, onMac, macTiedot });
    })
  );
  return tulos;
}

