// Viestit tmuxiin (T-66, ARK-16, S-10): viesti, stream, stop ja kysymys-pois. Käytös = vanhan 8787:n (scopes/palvelu/viestit.mjs,
// palvelin.mjs:248-261), kopioitu kopioriveineen. Sovitus: aja, loki, kello ja istuntohakemistot tulevat ymp:stä (palvelin.mjs).
//   ymp.odota(ms) → Promise    valinnainen (testit): 800 ms:n Escape-tauko, transkriptin odotusväli ja agy-tauot; oletus setTimeout
//   ymp.istunnotDir, projektitDir, agyHakemisto, brainHakemisto   valinnaiset; oletus CLAUDE_ISTUNNOT_DIR / ~/.claude/sessions,
//                              CLAUDE_PROJEKTIT_DIR / ~/.claude/projects ja vanhasta/agy-istunto.mjs:n oletukset
//   ymp.escapeTauko, perillaRaja, perillaVali, kirjoitaTauko   valinnaiset viiveet (kuten vanhan asetukset)
// Tuonnit vain ./aja.mjs, ./runko.mjs, ../vanhasta/* ja node:-moduulit (gate.sh tuontitarkistus).
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { agyRuudut, agyViestit, haeMacAgyKeskustelu, jasennaAgyRuutu, loydaKeskustelu, tyhjennaMacAgyValimuisti } from '../vanhasta/agy-istunto.mjs';
import { istunnotAsync, lueSkoopit } from '../vanhasta/lahteet.mjs';
import { Hylatty, mallitonSlug } from './aja.mjs';
import { NDJSON, kirjoitaNdjson, lueRunko, vastaa } from './runko.mjs';

// kopio: scopes/palvelu/viestit.mjs:44-44 (21.10.2026)
export const VIESTIN_MAKSIMI = 8000;

// kopio: scopes/palvelu/viestit.mjs:141-236 (21.10.2026)
// Työkalukutsu yhdeksi lyhyeksi riviksi (DEMO-SCOPES-PARANNUKSET 13.10.2026): komento tai muokattu tiedosto.
const lyhenna = (t, n = 120) => { const r = String(t ?? '').split('\n')[0].trim(); return r.length > n ? `${r.slice(0, n - 1)}…` : r; };
export function tyokaluRivi(o) {
  const s = o.input ?? {};
  const tiedosto = s.file_path ?? s.notebook_path ?? s.path;
  // Alun `cd <hakemisto> &&` on pelkkää hälyä: rivillä näkyy itse komento.
  if (o.name === 'Bash' && s.command) return `$ ${lyhenna(s.command.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, ''))}`;
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(o.name) && tiedosto) return `✎ ${lyhenna(tiedosto)}`;
  if (o.name === 'Read' && tiedosto) return `luki ${lyhenna(basename(tiedosto))}`;
  if (['Grep', 'Glob'].includes(o.name) && s.pattern) return `haki ${lyhenna(s.pattern)}`;
  const kuvaus = s.description ?? s.subagent_type;
  if (['Agent', 'Task'].includes(o.name) && kuvaus) return `ali-agentti: ${lyhenna(kuvaus)}`;
  return lyhenna(o.name ?? 'työkalu');
}

// Monivalinta (AskUserQuestion, DEMO-SCOPES-LISTA 13.10.2026): kysymykset vaihtoehtoineen äpin korttia varten ja
// sama tekstinä vanhalle äpille. Vastaus tulee myöhemmin työkalutuloksena (vastaukset).
export function kysymysViesti(o, aika) {
  const kysymykset = (Array.isArray(o.input?.questions) ? o.input.questions : []).map((q) => ({
    kysymys: String(q?.question ?? ''),
    otsikko: q?.header ? String(q.header) : null,
    monivalinta: q?.multiSelect === true,
    vaihtoehdot: (Array.isArray(q?.options) ? q.options : []).map((v) => ({ nimi: String(v?.label ?? ''), kuvaus: v?.description ? String(v.description) : null })),
  }));
  const teksti = kysymykset.map((q) => [q.kysymys, ...q.vaihtoehdot.map((v, i) => `${i + 1}. ${v.nimi}`)].join('\n')).join('\n\n');
  return { rooli: 'kysymys', teksti, aika, kysymykset, vastattu: false };
}

// Transkriptin keskustelu: [{ rooli: 'kayttaja'|'agentti'|'tyokalu'|'kysymys', teksti, aika }], viimeiset `maara`.
// Agentin työkalukutsut lyhyinä riveinä (tyokaluRivi), monivalinnat kysymyksinä ja niiden vastaukset käyttäjän
// viesteinä; muut työkalutulokset, meta-rivit ja ali-agenttien rivit ohitetaan; komentokääre näytetään komentona.
export function keskustelu(transkripti, maara = 120) {
  const tulos = [];
  const kysymykset = new Map();
  for (const rivi of transkripti.split('\n')) {
    let j;
    try { j = JSON.parse(rivi); } catch { continue; }
    if (j.isSidechain || j.isMeta || (j.type !== 'user' && j.type !== 'assistant')) continue;
    const c = j.message?.content;
    const aika = j.timestamp ?? null;
    if (j.type === 'assistant' && Array.isArray(c)) {
      let teksti = [];
      const tyhjenna = () => { const t = teksti.join('\n').trim(); if (t) tulos.push({ rooli: 'agentti', teksti: t, aika }); teksti = []; };
      for (const o of c) {
        if (o?.type === 'text') teksti.push(o.text);
        else if (o?.type === 'tool_use' && o.name === 'AskUserQuestion') {
          tyhjenna();
          const k = kysymysViesti(o, aika);
          kysymykset.set(o.id, k);
          tulos.push(k);
        } else if (o?.type === 'tool_use') { tyhjenna(); tulos.push({ rooli: 'tyokalu', teksti: tyokaluRivi(o), aika }); }
      }
      tyhjenna();
      continue;
    }
    if (j.type === 'user' && Array.isArray(c)) {
      for (const o of c) {
        const k = o?.type === 'tool_result' && kysymykset.get(o.tool_use_id);
        if (!k) continue;
        k.vastattu = true;
        const vastaukset = j.toolUseResult?.answers;
        const teksti = vastaukset && typeof vastaukset === 'object' ? Object.values(vastaukset).map(String).join('\n') : '';
        if (teksti.trim()) tulos.push({ rooli: 'kayttaja', teksti: teksti.trim(), aika });
      }
    }
    const osat = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((o) => o?.type === 'text').map((o) => o.text) : [];
    let teksti = osat.join('\n').trim();
    if (!teksti) continue;
    if (j.type === 'user') {
      const komento = /<command-name>([^<]*)<\/command-name>[\s\S]*?<command-args>([^<]*)<\/command-args>/.exec(teksti);
      if (komento) teksti = `${komento[1]} ${komento[2]}`.trim();
      else if (/^<(local-command|command-message|system-reminder|task-notification)/.test(teksti)) continue;
    }
    tulos.push({ rooli: j.type === 'user' ? 'kayttaja' : 'agentti', teksti, aika });
  }
  // Kysymys, jonka perässä on mitä tahansa, ei ole enää auki (keskeytys tai vastaus toiselta laitteelta).
  tulos.forEach((v, i) => { if (v.rooli === 'kysymys' && i < tulos.length - 1) v.vastattu = true; });
  return tulos.slice(-maara);
}

// Transkriptin kohdasta `koko` eteenpäin kirjoitetut rivit sisältävät tekstin `teksti`: käyttäjän viestinä, jonoon
// menneenä komentona (queued_command) tai jono-operaationa. Haku alun 60 merkin perusteella, koska Claude voi
// yhdistää jonossa olleet viestit.
export function transkriptissa(transkripti, teksti) {
  const haku = teksti.replace(/\s+/g, ' ').slice(0, 60);
  for (const r of transkripti.split('\n')) {
    let j;
    try { j = JSON.parse(r); } catch { continue; }
    if (j.isSidechain) continue;
    const c = j.message?.content;
    const osat = j.type === 'user' ? (typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((o) => o?.type === 'text').map((o) => o.text) : [])
      : j.type === 'attachment' ? [j.attachment?.prompt] : j.type === 'queue-operation' ? [j.content] : [];
    if (osat.some((o) => typeof o === 'string' && o.replace(/\s+/g, ' ').includes(haku))) return true;
  }
  return false;
}

// luoViestit(ymp): skoopin viestit tmuxiin (vanha luoViestit, vain viesti-, stop- ja kysymys-pois-osat). Ei tilaa: luodaan pyynnöittäin.
export function luoViestit(ymp) {
  const aja = ymp.aja;
  const kello = ymp.kello ?? Date.now;
  const odota = ymp.odota ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const asetukset = {
    juuri: ymp.juuri,
    istunnotDir: ymp.istunnotDir ?? process.env.CLAUDE_ISTUNNOT_DIR ?? join(homedir(), '.claude/sessions'),
    projektitDir: ymp.projektitDir ?? process.env.CLAUDE_PROJEKTIT_DIR ?? join(homedir(), '.claude/projects'),
    agyHakemisto: ymp.agyHakemisto,
    brainHakemisto: ymp.brainHakemisto,
    escapeTauko: ymp.escapeTauko,
    perillaRaja: ymp.perillaRaja,
    perillaVali: ymp.perillaVali,
    kirjoitaTauko: ymp.kirjoitaTauko,
  };
  const kirjaa = (rivi) => { try { ymp.loki?.(rivi); } catch { /* loki ei estä lähetystä */ } };

// kopio: scopes/palvelu/viestit.mjs:248-258 (21.10.2026)
  // Odottaa, että lähetetty teksti ilmestyy transkriptiin (V-305); raja ja väli asetuksista testejä varten.
  async function odotaTranskriptiin(polku, koko, teksti) {
    const raja = kello() + (asetukset.perillaRaja ?? 10_000);
    for (;;) {
      let uusi = '';
      try { uusi = readFileSync(polku).subarray(koko).toString('utf8'); } catch { /* transkripti ei vielä syntynyt */ }
      if (transkriptissa(uusi, teksti)) return true;
      if (kello() >= raja) return false;
      await odota(asetukset.perillaVali ?? 500);
    }
  }

// kopio: scopes/palvelu/viestit.mjs:260-394 (21.10.2026)
  // Viesti agy-ruutuun:
  // - Jos ruudussa on monivalinta (kysely: true): valitaan haluttu vaihtoehto Down-näppäimillä + Enter (tai Write-in)
  // - Tavallinen syöte: C-u tyhjentää kentän, teksti kirjaimellisesti, Enter.
  // Perillä vasta, kun kysely poistuu ruudulta tai agy:n keskustelutiedostossa on uusi käyttäjän viesti.
  async function lahetaAgyyn(nimi, r, teksti) {
    const rivi = teksti.replace(/\s*\n\s*/g, ' ').trim();
    const alku = kello();
    const slug = mallitonSlug(nimi);
    const onMac = r.onMac || (r.ruutu && (await aja('tmux', ['display-message', '-p', '-t', r.ruutu, '#{pane_current_command}'])).stdout.trim() === 'ssh');
    let db = null;
    let ennen = 0;
    if (onMac) {
      tyhjennaMacAgyValimuisti(slug);
      const mt = await haeMacAgyKeskustelu({ slug, alkoi: r.alkoi, aja });
      if (mt?.loytyi) {
        db = mt.dbPolku;
        ennen = (mt.viestit ?? []).filter((v) => v.rooli === 'kayttaja').length;
      }
    } else {
      db = loydaKeskustelu(slug, r.alkoi, asetukset.agyHakemisto);
      ennen = db ? agyViestit(db, Infinity).filter((v) => v.rooli === 'kayttaja').length : 0;
    }

    let onkoKysely = false;
    const capt = await aja('tmux', ['capture-pane', '-p', '-t', r.ruutu]);
    if (capt.koodi === 0) {
      onkoKysely = jasennaAgyRuutu(capt.stdout).kysely;
    } else if (r.kysely != null) {
      onkoKysely = r.kysely === true;
    }

    if (onkoKysely) {
      let vaihtoehdot = [];
      if (db) {
        let viestit = [];
        if (onMac) {
          const mt = await haeMacAgyKeskustelu({ slug, alkoi: r.alkoi, aja });
          viestit = mt?.viestit ?? [];
        } else {
          viestit = agyViestit(db, 10);
        }
        const viimKysymys = [...viestit].reverse().find((v) => v.rooli === 'kysymys');
        vaihtoehdot = viimKysymys?.kysymykset?.[0]?.vaihtoehdot ?? [];
      }
      let valittuIdx = -1;
      const siivottu = rivi.toLowerCase().trim();
      const numMatch = /^(\d+)[\.\)]?$/.exec(siivottu);
      if (numMatch) {
        const n = Number(numMatch[1]) - 1;
        if (n >= 0 && n < vaihtoehdot.length) valittuIdx = n;
      }
      if (valittuIdx < 0 && vaihtoehdot.length) {
        const ilmanNumeroa = siivottu.replace(/^\d+[\.\)]\s*/, '');
        valittuIdx = vaihtoehdot.findIndex((v) => {
          const vn = v.nimi.toLowerCase().trim();
          const vnIlman = vn.replace(/^\d+[\.\)]\s*/, '');
          return vn === siivottu || vn === ilmanNumeroa || vnIlman === siivottu || vnIlman === ilmanNumeroa;
        });
      }
      if (valittuIdx >= 0) {
        const painallukset = [];
        for (let i = 0; i < valittuIdx; i++) painallukset.push('Down');
        painallukset.push('Enter');
        for (const p of painallukset) {
          const t = await aja('tmux', ['send-keys', '-t', r.ruutu, p]);
          if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
        }
      } else {
        // Custom write-in: mennään Write-in... -kohtaan (vaihtoehdot.length), painetaan Enter, kirjoitetaan teksti
        const painallukset = [];
        for (let i = 0; i < (vaihtoehdot.length || 1); i++) painallukset.push('Down');
        painallukset.push('Enter');
        for (const p of painallukset) {
          const t = await aja('tmux', ['send-keys', '-t', r.ruutu, p]);
          if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
        }
        await odota(asetukset.kirjoitaTauko ?? 300);
        for (const a of [['C-u'], ['-l', rivi], ['Enter']]) {
          const t = await aja('tmux', ['send-keys', '-t', r.ruutu, ...a]);
          if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
        }
      }
    } else {
      for (const a of [['C-u'], ['-l', rivi], ['Enter']]) {
        const t = await aja('tmux', ['send-keys', '-t', r.ruutu, ...a]);
        if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
      }
    }

    const raja = kello() + (asetukset.perillaRaja ?? 10_000);
    let perilla = false;
    while (!perilla) {
      if (onkoKysely) {
        const capt = await aja('tmux', ['capture-pane', '-p', '-t', r.ruutu]);
        if (capt.koodi === 0 && !jasennaAgyRuutu(capt.stdout).kysely) {
          perilla = true;
          break;
        }
      }
      if (onMac) {
        tyhjennaMacAgyValimuisti(slug);
        const mt = await haeMacAgyKeskustelu({ slug, alkoi: r.alkoi, aja });
        const nytMaara = (mt?.viestit ?? []).filter((v) => v.rooli === 'kayttaja').length;
        if (nytMaara > ennen) {
          perilla = true;
          break;
        }
      } else {
        const d = db ?? loydaKeskustelu(slug, r.alkoi, asetukset.agyHakemisto);
        const maara = (x) => (x ? agyViestit(x, Infinity).filter((v) => v.rooli === 'kayttaja').length : 0);
        if (maara(d) > ennen) {
          perilla = true;
          break;
        }
      }
      const capt = await aja('tmux', ['capture-pane', '-p', '-t', r.ruutu]);
      if (capt.koodi === 0) {
        const j = jasennaAgyRuutu(capt.stdout);
        if (capt.stdout.includes(`> ${rivi}`) && (j.tila === 'busy' || !capt.stdout.trim().endsWith(`> ${rivi}`))) {
          perilla = true;
          break;
        }
      }
      if (kello() >= raja) break;
      await odota(asetukset.perillaVali ?? 500);
    }
    const kirjaus = { toiminto: 'viesti', nimi, istunto: r.ruutu, merkkeja: rivi.length, alku: rivi.slice(0, 40), kesto: kello() - alku, agy: true };
    if (!perilla) {
      const ruutu = await aja('tmux', ['capture-pane', '-p', '-t', r.ruutu]);
      kirjaa({ ...kirjaus, tulos: 'ei näkynyt', ruutu: ruutu.stdout.split('\n').filter((x) => x.trim()).slice(-8) });
      throw new Hylatty(504, 'viesti ei näkynyt agy-istunnossa — se voi odottaa istunnon syöttökentässä tai kysymyksen takana; tarkista ennen uudelleenlähetystä');
    }
    kirjaa({ ...kirjaus, tulos: 'ok' });
    return { ok: true, istunto: r.ruutu };
  }

// kopio: scopes/palvelu/viestit.mjs:396-416 (21.10.2026)
  // Skoopin pakkaamattomat istunnot uusin ensin: pakattu istunto ei ole enää skoopin keskustelu (käyttäjä 13.10.2026),
  // ja automaattisiirron jälkeen uusi istunto korvaa vanhan samassa näkymässä.
  // Asynkroninen (ISTUNNOT-SUORITUSKYKY): äppi kyselee viestejä jatkuvasti, eikä tmux-haku saa pysäyttää palvelua.
  const skoopinIstunnot = async (nimi) => {
    const skoopit = lueSkoopit(asetukset.juuri);
    if (!skoopit[nimi]) throw new Hylatty(404, 'tuntematon skooppi');
    return (await istunnotAsync({ ...asetukset, aja, skooppiNimet: Object.keys(skoopit) })).filter((i) => i.skooppi === nimi);
  };
  const avoinna = (lista) => lista.filter((i) => !i.pakattu).sort((a, b) => b.alkoi - a.alkoi);
  const avoimet = async (nimi) => avoinna(await skoopinIstunnot(nimi));

  // Ainoa tmux-istunto, jonka ruudun prosessi on istunnon claude tai sen vanhempi (sama sääntö kuin pakkaa).
  async function tmuxIstunto(nimi) {
    const omat = (await avoimet(nimi)).filter((i) => i.ruutu);
    if (omat.length !== 1) throw new Hylatty(409, omat.length ? 'skoopissa on useita tmux-istuntoja' : 'skooppi ei ole auki tmuxissa');
    const [i] = omat;
    const r = await aja('tmux', ['display-message', '-p', '-t', i.ruutu, '#{pane_pid}']);
    const ruudunPid = Number(r.stdout.trim());
    if (r.koodi !== 0 || !(ruudunPid === i.pid || ruudunPid === i.vanhempi || (i.tyyppi === 'agy' && i.pid == null))) throw new Hylatty(409, 'istunnon tmux-ruutu ei täsmää');
    return i;
  }

  return {
// kopio: scopes/palvelu/viestit.mjs:758-805 (21.10.2026)
    // Viesti skoopin istuntoon: kirjoitetaan ruutuun kirjaimellisesti, rivinvaihdot välilyönneiksi (Enter lähettäisi).
    async lahetaSkooppiin(nimi, teksti) {
      if (typeof teksti !== 'string' || !teksti.trim()) throw new Hylatty(400, 'viesti puuttuu');
      if (teksti.length > VIESTIN_MAKSIMI) throw new Hylatty(413, `viesti yli ${VIESTIN_MAKSIMI} merkkiä`);
      const omat = await avoimet(nimi);
      if (omat.length === 1 && omat[0].tyyppi === 'agy') {
        return lahetaAgyyn(nimi, omat[0], teksti);
      }
      if (!omat.length) {
        const [r] = await agyRuudut(aja, nimi);
        if (r) return lahetaAgyyn(nimi, r, teksti);
      }
      const i = await tmuxIstunto(nimi);
      if (i.tyyppi === 'agy') {
        return lahetaAgyyn(nimi, i, teksti);
      }
      // Auki oleva monivalinta valitsisi Enterillä korostetun vaihtoehdon (käyttäjä 13.10.2026): Escape sulkee sen
      // ensin, jolloin teksti menee istuntoon vastauksena. Tauko, ettei Escape + kirjain tulkitu Alt-näppäimeksi.
      let transkripti = '';
      try { transkripti = readFileSync(i.polku, 'utf8'); } catch { /* ei transkriptia */ }
      const viimeinen = keskustelu(transkripti, 1)[0];
      if (viimeinen?.rooli === 'kysymys' && !viimeinen.vastattu) {
        const t = await aja('tmux', ['send-keys', '-t', i.ruutu, 'Escape']);
        if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
        await odota(asetukset.escapeTauko ?? 800);
      }
      const rivi = teksti.replace(/\s*\n\s*/g, ' ').trim();
      const alku = kello();
      let koko = 0;
      try { koko = statSync(i.polku).size; } catch { /* uusi istunto ilman transkriptia */ }
      // V-515 (16.10.2026): Claude Code palauttaa perutun vuoron (sa-tick, API-virhe, keskeytys) viestin syöttökenttään,
      // ja uusi teksti liimautui sen perään. C-u tyhjentää kentän ensin (tyhjässä kentässä ei tee mitään).
      for (const a of [['C-u'], ['-l', rivi], ['Enter']]) {
        const t = await aja('tmux', ['send-keys', '-t', i.ruutu, ...a]);
        if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
      }
      // V-305 (14.10.2026): kolme viestiä jäi istunnon syöttökenttään ja lähti myöhemmin yhtenä, eikä äppi tiennyt
      // siitä. Lähetys on perillä vasta, kun teksti näkyy transkriptissa (käyttäjän viesti tai jonoon mennyt komento).
      const perilla = await odotaTranskriptiin(i.polku, koko, rivi);
      const kirjaus = { toiminto: 'viesti', nimi, istunto: i.id, merkkeja: rivi.length, alku: rivi.slice(0, 40), kesto: kello() - alku };
      if (!perilla) {
        const ruutu = await aja('tmux', ['capture-pane', '-p', '-t', i.ruutu]);
        kirjaa({ ...kirjaus, tulos: 'ei näkynyt', ruutu: ruutu.stdout.split('\n').filter((r) => r.trim()).slice(-8) });
        throw new Hylatty(504, 'viesti ei näkynyt istunnossa — se voi odottaa istunnon syöttökentässä; tarkista ennen uudelleenlähetystä');
      }
      kirjaa({ ...kirjaus, tulos: 'ok' });
      return { ok: true, istunto: i.id };
    },

// kopio: scopes/palvelu/viestit.mjs:807-827 (21.10.2026)
    // Skoopin stop-nappi (CHAT-STOP): Escape keskeyttää työskentelevän istunnon kuten Claude Coden näppäimistöllä.
    // Vain työn aikana: vapaassa istunnossa Escape tyhjentäisi kirjoitetun syötteen, kysymyksessä sulkisi kortin.
    async pysaytaSkooppi(nimi) {
      let i;
      try {
        i = await tmuxIstunto(nimi);
      } catch (e) {
        const [r] = await agyRuudut(aja, nimi);
        if (r) {
          const ruutu = await aja('tmux', ['capture-pane', '-p', '-t', r.ruutu]);
          i = { id: r.ruutu, ruutu: r.ruutu, tila: jasennaAgyRuutu(ruutu.stdout).tila };
        } else {
          throw e;
        }
      }
      if (i.tila !== 'busy' && i.tila !== 'shell') throw new Hylatty(409, 'istunto ei ole työssä');
      const t = await aja('tmux', ['send-keys', '-t', i.ruutu, 'Escape']);
      if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
      kirjaa({ toiminto: 'stop', nimi, istunto: i.id });
      return { ok: true, istunto: i.id };
    },

// kopio: scopes/palvelu/viestit.mjs:899-935 (21.10.2026)
    // Kortin X (käyttäjä 13.10.2026, kuten Claude-äpissä): Escape sulkee auki olevan monivalinnan vastaamatta.
    async suljeKysymys(nimi) {
      const omat = await avoimet(nimi);
      let i;
      if (omat.length === 1 && omat[0].tyyppi === 'agy') {
        i = omat[0];
      } else {
        try {
          i = await tmuxIstunto(nimi);
        } catch (e) {
          const [r] = await agyRuudut(aja, nimi);
          if (r) i = { id: r.ruutu, ruutu: r.ruutu, alkoi: r.alkoi, tyyppi: 'agy' };
          else throw e;
        }
      }
      if (i.tyyppi === 'agy') {
        let onkoKysely = false;
        const capt = await aja('tmux', ['capture-pane', '-p', '-t', i.ruutu]);
        if (capt.koodi === 0) {
          onkoKysely = jasennaAgyRuutu(capt.stdout).kysely;
        } else if (i.kysely != null) {
          onkoKysely = i.kysely === true;
        }
        if (!onkoKysely) throw new Hylatty(409, 'ei auki olevaa kysymystä');
        const t = await aja('tmux', ['send-keys', '-t', i.ruutu, 'Escape']);
        if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
        kirjaa({ toiminto: 'sulje-kysymys', nimi, istunto: i.id, agy: true });
        return { ok: true, istunto: i.id };
      }
      let transkripti = '';
      try { transkripti = readFileSync(i.polku, 'utf8'); } catch { /* ei transkriptia */ }
      const viimeinen = keskustelu(transkripti, 1)[0];
      if (viimeinen?.rooli !== 'kysymys' || viimeinen.vastattu) throw new Hylatty(409, 'ei auki olevaa kysymystä');
      const t = await aja('tmux', ['send-keys', '-t', i.ruutu, 'Escape']);
      if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
      return { ok: true, istunto: i.id };
    },
  };
}

// Reitit. Käsittelijä luo viestit-olion pyynnöittäin (ei jaettua tilaa). Virheet (Hylatty) muuttuu statukseksi palvelin.mjs:ssä.
// kopio: scopes/palvelu/palvelin.mjs:248-261 (21.10.2026)
export const REITIT = [
  { metodi: 'POST', kuvio: '/api/skoopit/*/viesti', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    vastaa(res, 200, await luoViestit(ymp).lahetaSkooppiin(osat[0], (await lueRunko(req, 32_768)).teksti));
  } },
  { metodi: 'POST', kuvio: '/api/skoopit/*/stream', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    const { teksti } = await lueRunko(req, 32_768);
    const tulos = await luoViestit(ymp).lahetaSkooppiin(osat[0], teksti);
    res.writeHead(200, NDJSON);
    kirjoitaNdjson(res, { tyyppi: 'valmis', vastaus: '', istunto: tulos?.istunto ?? null });
    res.end();
  } },
  { metodi: 'POST', kuvio: '/api/skoopit/*/stop', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    vastaa(res, 200, await luoViestit(ymp).pysaytaSkooppi(osat[0]));
  } },
  { metodi: 'POST', kuvio: '/api/skoopit/*/kysymys-pois', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    vastaa(res, 200, await luoViestit(ymp).suljeKysymys(osat[0]));
  } },
];
