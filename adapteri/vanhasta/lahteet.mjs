// kopio: scopes/palvelu/lahteet.mjs @ 507a61f1 (21.10.2026); muuttuneet vain import-rivit
// Skooppien lukulähteet (DEMO-SCOPES-PALVELU 13.10.2026): skooppilista, rekisterin jäsennys ja elävien
// Claude-istuntojen kontekstikoko. Vain luku: mikään funktio ei kirjoita levylle.
//
// Lähteet (kaikki polut tulevat kutsujalta tai ympäristöstä, ei koneen kiinteitä polkuja):
//   juuri/claude/siirto/state/skoopit.json   skooppi → rekisteritiedostot (ensimmäinen on päärekisteri)
//   istunnot/<pid>.json                      Claude Coden elävät istunnot (sessionId, name, cwd, procStart)
//   projektit/<cwd, jossa / _ . → ->/<id>.jsonl   istunnon transkripti (konteksti ja /pura-argumentti)
//   juuri/<rekisterit, HISTORIA, ARKISTO>, juuri/Infra/skills/keskustelun-siirto/references, juuri/claude/TYOTAVAT.md
//                                             skoopin kontekstitiedostot (skoopinKonteksti)
//   transkriptin liitteet ja viestit            istunnon ladatut osat tekstinä (istunnonLadatut, V-400)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { agyIstunnot, agyIstunnotSync } from './agy-istunto.mjs';

// "SEURAAVA PAKETTI[ [tunniste]]: ID — kuvaus — polut: … — aloitus: …" → { id, kuvaus, polut, aloitus, teksti }.
export function jasennaSeuraava(teksti) {
  const osat = teksti.split(' — ');
  const tulos = { id: osat[0].trim(), kuvaus: '', polut: [], aloitus: null, teksti };
  const kuvaus = [];
  for (const osa of osat.slice(1)) {
    if (osa.startsWith('polut:')) tulos.polut = osa.slice(6).split(',').map((p) => p.trim()).filter(Boolean);
    else if (osa.startsWith('aloitus:')) tulos.aloitus = osa.slice(8).trim();
    else if (!/^automaattinen:/.test(osa)) kuvaus.push(osa);
  }
  tulos.kuvaus = kuvaus.join(' — ');
  if (/^ei mitään$/i.test(tulos.id)) tulos.id = null;
  return tulos;
}

// Rekisterin SEURAAVA PAKETTI -rivi skoopille: jaetussa rekisterissä rivit on leimattu [skooppi], muuten leimaton.
export function seuraavaRivi(rekisteri, skooppi) {
  let leimaton = null;
  for (const rivi of rekisteri.split('\n')) {
    const m = rivi.match(/^\**SEURAAVA PAKETTI(?: \[([^\]]+)\])?:\**\s*(.+)$/);
    if (!m) continue;
    if (m[1] === skooppi) return jasennaSeuraava(m[2]);
    if (!m[1] && !leimaton) leimaton = jasennaSeuraava(m[2]);
  }
  return leimaton;
}

const solut = (rivi) => rivi.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());

// Otsikon (esim. "Avoimet asiat", myös numeroitu "## 6. Avoimet asiat") alla oleva ensimmäinen markdown-taulukko
// riveinä { <otsikkosolu>: arvo }. Puuttuva luku tai taulukko → [].
export function taulukko(rekisteri, otsikko) {
  const rivit = rekisteri.split('\n');
  const alku = rivit.findIndex((r) => new RegExp(`^##\\s+(\\d+\\.\\s*)?${otsikko}\\s*$`, 'i').test(r));
  if (alku < 0) return [];
  const tulos = [];
  let avaimet = null;
  for (const rivi of rivit.slice(alku + 1)) {
    if (/^##\s/.test(rivi)) break;
    if (!rivi.trim().startsWith('|')) { if (avaimet) break; continue; }
    const s = solut(rivi);
    if (!avaimet) { avaimet = s; continue; }
    if (s.every((x) => /^:?-+:?$/.test(x))) continue;
    tulos.push(Object.fromEntries(avaimet.map((a, i) => [a, s[i] ?? ''])));
  }
  return tulos;
}

export const lueSkoopit = (juuri) =>
  JSON.parse(readFileSync(join(juuri, 'claude/siirto/state/skoopit.json'), 'utf8'));

// Claude Coden projektihakemiston nimi: cwd, jossa / _ . ovat -.
export const projektiNimi = (cwd) => cwd.replace(/[/_.]/g, '-');

// Transkriptin viimeinen pääketjun usage-rivi → { tokenit, aika } tai null (ali-agenttien sidechain-rivit ohitetaan).
export function konteksti(transkripti) {
  const rivit = transkripti.split('\n');
  for (let i = rivit.length - 1; i >= 0; i--) {
    let j;
    try { j = JSON.parse(rivit[i]); } catch { continue; }
    const u = j?.message?.usage;
    if (!u || j.isSidechain) continue;
    return {
      tokenit: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      aika: j.timestamp ?? null,
    };
  }
  return null;
}

// Viimeisin kohta, jossa agentti pysähtyi käyttäjän varaan (DEMO-SCOPES-LISTA 13.10.2026): vuoro päättyi tai agentti
// kysyi monivalinnalla (AskUserQuestion). Työn aikaiset välivaiheet eivät nosta keskustelua listan huipulle.
const LOPPU = new Set(['end_turn', 'stop_sequence', 'max_tokens']);
export function pysahdys(transkripti) {
  const rivit = transkripti.split('\n');
  for (let i = rivit.length - 1; i >= 0; i--) {
    let j;
    try { j = JSON.parse(rivit[i]); } catch { continue; }
    if (j.type !== 'assistant' || j.isSidechain || !j.timestamp) continue;
    const kysyy = Array.isArray(j.message?.content) && j.message.content.some((o) => o?.type === 'tool_use' && o.name === 'AskUserQuestion');
    if (kysyy || LOPPU.has(j.message?.stop_reason)) return j.timestamp;
  }
  return null;
}

// Onko istunto pakattu (käyttäjä 13.10.2026: pakkauksen jälkeen äppi tyhjentää skoopin keskustelun ja tarjoaa
// purun): agentin viimeinen pakkausrivi on viimeisen käyttäjän viestin jälkeen. Työkalutulokset,
// meta-rivit, komentokääreen tulosteet ja /sa-herätykset eivät ole käyttäjän viestejä.
// Pakkausrivi (V-284 14.10.2026): `PAKKAUS: vahvistettu`, `PAKATTU:` (kirjoitetaan vasta commitin ja pushin jälkeen)
// tai `PAKKAUS: epäselvä`, jonka rivillä on commitin sha — esim. salaisuusgrepin vanha osuma ei peru pakkausta.
const EI_KAYTTAJAN = /^(<(local-command|system-reminder|task-notification)|sa-tick:|sa-uusinta:)/;
const PAKKAUSRIVI = /^[\s*`>]*(PAKKAUS:[*`\s]*vahvistettu|PAKATTU:|PAKKAUS:[*`\s]*epäselvä.*\bcommit(it)?[\s`]+[0-9a-f]{7,})/m;
export function pakattu(transkripti) {
  let tulos = false;
  for (const rivi of transkripti.split('\n')) {
    let j;
    try { j = JSON.parse(rivi); } catch { continue; }
    if (j.isSidechain || j.isMeta) continue;
    const c = j.message?.content;
    const teksti = (typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((o) => o?.type === 'text').map((o) => o.text) : []).join('\n').trim();
    if (!teksti) continue;
    if (j.type === 'assistant' && PAKKAUSRIVI.test(teksti)) tulos = true;
    else if (j.type === 'user' && !EI_KAYTTAJAN.test(teksti)) tulos = false;
  }
  return tulos;
}

// Onko välimuistin herätys (/sa) päällä (käyttäjä 13.10.2026: kytkin pakkausnapin alle). Viimeinen merkki ratkaisee:
// sa-tick-ajastimen CronCreate (päällä), käyttäjän `/sa pois` (pois) tai agentin rivin alun `sa päällä` / `sa pois`.
// Teksti ei yksin riitä (V-294): työkalukutsun kanssa samassa viestissä ollut tekstilohko ei aina tallennu transkriptiin.
// Herätykset ovat istunnon muistissa, joten uusi istunto alkaa pois päältä.
export function hereilla(transkripti) {
  let tulos = false;
  for (const rivi of transkripti.split('\n')) {
    let j;
    try { j = JSON.parse(rivi); } catch { continue; }
    if (j.isSidechain) continue;
    const c = j.message?.content;
    const osat = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const teksti = osat.filter((o) => o?.type === 'text').map((o) => o.text).join('\n');
    if (j.type === 'user') {
      const k = /<command-name>\/sa<\/command-name>\s*<command-args>([^<]*)<\/command-args>/.exec(teksti);
      if (k && k[1].trim() === 'pois') tulos = false;
      continue;
    }
    if (j.type !== 'assistant') continue;
    for (const o of osat) {
      if (o?.type === 'tool_use' && o.name === 'CronCreate' && String(o.input?.prompt ?? '').startsWith('sa-tick')) tulos = true;
    }
    for (const m of teksti.matchAll(/^[\s*`>]*sa (päällä|pois)(?![\p{L}\p{N}])/gmu)) tulos = m[1] === 'päällä';
  }
  return tulos;
}

// Istunnon skooppi: nimi, joka on skooppi, tai transkriptin viimeisin purku: /pura-argumentti ("uusi" ja --liput pois)
// tai mallittoman purun aloitusviesti (V-508): äpin Pura (toiminnot.mjs) ja autovaihto.sh avaavat scopes-perheen
// istunnon viestillä `Malliton purku: lue …/<slug>.md ja noudata sitä.` tai `Malliton purku epäonnistui (<skooppi>): …`
// ilman /pura-komentoa, ja istunnon nimeksi jää koneen nimi. slug = skooppi, välit viivoiksi (toiminnot.mjs mallitonSlug).
// Vain käyttäjän viestit (ei sivuketjua, työkalutuloksia eikä agentin tekstiä): purkuohjetta lainaava tuloste ei vaihda skooppia.
const PURKU = /<command-name>\/pura<\/command-name>\s*<command-args>([^<]*)<\/command-args>|^Malliton purku: lue \S*\/([^/\s]+)\.md ja noudata|^Malliton purku epäonnistui \(([^)]+)\)/g;
export function istunnonSkooppi(nimi, transkripti, skooppiNimet) {
  if (skooppiNimet.includes(nimi)) return nimi;
  let viimeisin = null;
  for (const rivi of transkripti.split('\n')) {
    let j;
    try { j = JSON.parse(rivi); } catch { continue; }
    if (j?.type !== 'user' || j.isSidechain) continue;
    const c = j.message?.content;
    const teksti = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((o) => o?.type === 'text').map((o) => o.text).join('\n') : '';
    for (const m of teksti.trim().matchAll(PURKU)) viimeisin = m;
  }
  if (viimeisin === null) return null;
  if (viimeisin[2] !== undefined) return skooppiNimet.find((s) => s.trim().replace(/\s+/g, '-') === viimeisin[2]) ?? null;
  const arg = (viimeisin[1] ?? viimeisin[3]).replace(/\s--\S+/g, '').replace(/^\s*uusi\s+/, '').split(' — ')[0].trim();
  return skooppiNimet.includes(arg) ? arg : null;
}

// Elääkö pid samana prosessina: /proc/<pid>/stat kenttä 22 = procStart (kierrätetty pid ei kelpaa).
// Elossa → vanhemman pid (kenttä 4), muuten null.
function elossa(pid, procStart, proc) {
  try {
    const stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8');
    const kentat = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return procStart == null || kentat[19] === String(procStart) ? Number(kentat[1]) : null;
  } catch {
    try {
      process.kill(pid, 0);
      try {
        const ppidStr = execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const ppid = Number(ppidStr);
        return Number.isFinite(ppid) ? ppid : 1;
      } catch {
        return 1;
      }
    } catch {
      return null;
    }
  }
}

// Elävät istunnot (Claude ja AGY): [{ id, nimi, tila, kysely, skooppi, konteksti, pysahdys, pakattu, hereilla, alkoi, pid, vanhempi, ruutu, polku }].
// polku = transkripti (viestit.mjs); alkoi = startedAt (ms). ruutu = tmux-ruutu (%26 tai siirto-*) tai null;
// pid, vanhempi ja ruutu ovat hallintatoimintoja varten (toiminnot.mjs: /pakkaa oikeaan ruutuun).
export function istunnot({ istunnotDir, projektitDir, skooppiNimet, proc = '/proc', agyHakemisto, brainHakemisto, listPanes, capturePane, ohitaAgy = false }) {
  const tulos = [];
  if (existsSync(istunnotDir)) {
    for (const tiedosto of readdirSync(istunnotDir).filter((f) => /^\d+\.json$/.test(f))) {
      let s;
      try { s = JSON.parse(readFileSync(join(istunnotDir, tiedosto), 'utf8')); } catch { continue; }
      const vanhempi = s.sessionId ? elossa(s.pid, s.procStart, proc) : null;
      if (vanhempi == null) continue;
      const polku = join(projektitDir, projektiNimi(s.cwd ?? ''), `${s.sessionId}.jsonl`);
      let transkripti = '';
      try { transkripti = readFileSync(polku, 'utf8'); } catch { /* uusi istunto ilman transkriptia */ }
      tulos.push({
        id: s.sessionId,
        nimi: s.name ?? null,
        tila: s.status ?? null,
        // Kyselykortti (AskUserQuestion) auki: waiting + waitingFor "input needed"; lupakysely on "permission prompt".
        kysely: s.status === 'waiting' && s.waitingFor === 'input needed',
        skooppi: istunnonSkooppi(s.name ?? '', transkripti, skooppiNimet),
        konteksti: konteksti(transkripti),
        pysahdys: pysahdys(transkripti),
        pakattu: pakattu(transkripti),
        hereilla: hereilla(transkripti),
        alkoi: s.startedAt ?? 0,
        pid: s.pid,
        vanhempi,
        // Remote Controlin SDK-ajo (entrypoint sdk-cli) perii daemonin tmux-ruudun, joten ruutu vain CLI-istunnoille.
        ruutu: (s.entrypoint ?? 'cli') === 'cli' ? /\.(%\d+)$/.exec(s.tmux ?? '')?.[1] ?? null : null,
        polku,
      });
    }
  }
  if (!ohitaAgy) {
    const agy = agyIstunnotSync({ skooppiNimet, proc, agyHakemisto, brainHakemisto, listPanes, capturePane });
    tulos.push(...agy);
  }
  return tulos;
}

// Yhden skoopin näkymä: rekisteri jäsennettynä ja skoopin istunnot.
export function skooppi(nimi, { juuri, skoopit, kaikkiIstunnot }) {
  const rekisterit = skoopit[nimi];
  if (!rekisterit) return null;
  let teksti = '';
  try { teksti = readFileSync(join(juuri, rekisterit[0]), 'utf8'); } catch { /* puuttuva rekisteri näkyy tyhjänä */ }
  return {
    nimi,
    rekisterit,
    seuraava: seuraavaRivi(teksti, nimi),
    avoimet: taulukko(teksti, 'Avoimet asiat'),
    viat: taulukko(teksti, 'Viat'),
    istunnot: kaikkiIstunnot.filter((i) => i.skooppi === nimi),
  };
}

// Skoopin viimeisin muutos (ISO): rekisterin muokkaus tai istunnon viimeisin pysähdys (valmis vuoro tai kysymys),
// kumpi uudempi. Äpin sivupalkki järjestää skoopit ja chatit tällä yhdeksi listaksi.
function viimeisinMuutos(juuri, rekisteri, istunnot) {
  let ms = 0;
  try { ms = statSync(join(juuri, rekisteri)).mtimeMs; } catch { /* puuttuva rekisteri */ }
  for (const i of istunnot) ms = Math.max(ms, Date.parse(i.pysahdys ?? '') || 0);
  return ms ? new Date(ms).toISOString() : null;
}

// Skoopin tila listan kansioikonia varten (SCOPES-LISTA-TILAVARIT, käyttäjä 13.10.2026): kasittely, jos jokin
// pakkaamaton istunto on busy tai shell (taustakomento käynnissä, vuoro odottaa sen ilmoitusta; Claude Code näyttää
// kummankin tilana working, käyttäjä 14.10.2026); odottaa, jos pakkaamaton istunto odottaa käyttäjää (waiting = kysymys
// tai lupa, idle = vuoro valmis); muuten pakattu, myös ilman istuntoja. Pakatun istunnon /sa-herätys ei tee siitä
// käsittelyä; automaattisiirron uusi istunto on pakkaamaton, joten skooppi pysyy aktiivisena siirron yli.
// kysely (SCOPES-LISTA-KYSELYVARI, käyttäjä 14.10.2026): pakkaamattomassa istunnossa on kyselykortti auki; voittaa
// käsittelyn, koska kortti pysyy auki vain käyttäjän vastaukseen asti. Muu odotus (vuoro valmis, lupakysely) on odottaa.
const TYOSKENTELEE = new Set(['busy', 'shell']);
export function skooppiTila(istunnot) {
  const auki = istunnot.filter((i) => !i.pakattu);
  if (auki.some((i) => i.kysely)) return 'kysely';
  if (auki.some((i) => TYOSKENTELEE.has(i.tila))) return 'kasittely';
  return auki.length ? 'odottaa' : 'pakattu';
}

// Kuten istunnot(), mutta agy-ruudut ja Mac-tiedot haetaan asynkronisesti (ISTUNNOT-SUORITUSKYKY 18.10.2026): tmux- ja
// ssh-kutsut eivät pysäytä palvelun tapahtumasilmukkaa. aja = toiminnot.mjs:n ajaKomento tai testin väärennös.
export async function istunnotAsync({ aja, ...asetukset }) {
  const { skooppiNimet, proc, agyHakemisto, brainHakemisto, listPanes, capturePane } = asetukset;
  const agy = await agyIstunnot({ skooppiNimet, aja, proc, agyHakemisto, brainHakemisto, listPanes, capturePane });
  return [...istunnot({ ...asetukset, ohitaAgy: true }), ...agy];
}

// Skooppilista tiivistettynä: nimi, seuraava paketti, avoimien ja vikojen määrä, istuntojen suurin konteksti, aika, tila.
export function lista(asetukset, lisaIstunnot = []) {
  const skoopit = lueSkoopit(asetukset.juuri);
  const ohitaAgy = asetukset.ohitaAgy ?? (lisaIstunnot != null && lisaIstunnot.length > 0);
  const loydetyt = istunnot({ ...asetukset, skooppiNimet: Object.keys(skoopit), ohitaAgy });
  const lisaNahdyt = new Set(lisaIstunnot.map((i) => i.id));
  const kaikkiIstunnot = [...lisaIstunnot, ...loydetyt.filter((i) => !lisaNahdyt.has(i.id))];
  return Object.keys(skoopit).map((nimi) => {
    const s = skooppi(nimi, { juuri: asetukset.juuri, skoopit, kaikkiIstunnot });
    const tokenit = s.istunnot.map((i) => i.konteksti?.tokenit ?? 0);
    return {
      nimi,
      seuraava: s.seuraava?.id ?? null,
      avoimia: s.avoimet.filter((r) => !/^(valmis|todennettu|korjattu)$/i.test(r.Tila ?? '')).length,
      vikoja: s.viat.filter((r) => !/^(valmis|todennettu|korjattu)$/i.test(r.Tila ?? '')).length,
      istuntoja: s.istunnot.length,
      suurinKonteksti: tokenit.length ? Math.max(...tokenit) : null,
      aika: viimeisinMuutos(asetukset.juuri, skoopit[nimi][0], s.istunnot),
      tila: skooppiTila(s.istunnot),
    };
  });
}

// Skoopin konteksti (SCOPES-INFRA-KONTEKSTI 13.10.2026): kaikki tiedostot, jotka skoopin purku ja työ lataavat,
// otsikoittain osina tokeniarvioineen, sekä elävien istuntojen mitattu konteksti osa-alueittain.
// Tokenit arvioidaan merkkimäärästä, ei tokenisoijalla: 1,8 merkkiä/token on mitattu 13.10.2026 kymmenen
// työkalutuloksen (suomenkielinen markdown, Swift, JSON) usage-kasvusta, vaihteluväli 1,5–2,2.
const MERKKIA_TOKENIIN = 1.8;
export const tokeneiksi = (merkit) => Math.ceil(merkit / MERKKIA_TOKENIIN);

// Markdown `##`-otsikoittain: [{ otsikko, teksti, tokenit }]. Ensimmäistä otsikkoa edeltävä osa on "Alku";
// koodiaidan sisällä oleva otsikko ei aloita osaa. Yli ISO_OSA tokenin luku pilkotaan vielä `###`-otsikoittain
// ("Luku › Alaluku"), jotta esim. HISTORIA.md:n yksi pitkä luku ei näy yhtenä möhkäleenä.
const ISO_OSA = 3000;
function otsikoittain(teksti, taso, alkuOtsikko) {
  const osat = [];
  let nykyinen = { otsikko: alkuOtsikko, rivit: [] };
  let aidattu = false;
  const kuvio = new RegExp(`^#{${taso}}\\s+(.+?)\\s*#*\\s*$`);
  for (const rivi of teksti.split('\n')) {
    if (/^\s*(```|~~~)/.test(rivi)) aidattu = !aidattu;
    const m = !aidattu && rivi.match(kuvio);
    if (m) { osat.push(nykyinen); nykyinen = { otsikko: m[1], rivit: [rivi] }; } else nykyinen.rivit.push(rivi);
  }
  osat.push(nykyinen);
  return osat
    .map(({ otsikko, rivit }) => ({ otsikko, teksti: rivit.join('\n').trim() }))
    .filter((o) => o.teksti)
    .map((o) => ({ ...o, tokenit: tokeneiksi(o.teksti.length) }));
}

export function osiin(teksti) {
  return otsikoittain(teksti, 2, 'Alku').flatMap((o) => {
    if (o.tokenit <= ISO_OSA) return [o];
    const ala = otsikoittain(o.teksti, 3, o.otsikko);
    return ala.length > 1 ? ala.map((a, i) => (i === 0 ? a : { ...a, otsikko: `${o.otsikko} › ${a.otsikko}` })) : [o];
  });
}

// Skoopin kontekstitiedostot järjestyksessä: rekisterit (skoopit.json), päärekisterin viereiset HISTORIA.md ja
// ARKISTO.md, viitetiedosto (pisin sanaetuliite: "infra iot" → infra-iot.md, muuten infra.md) ja kaikille yhteiset.
// Vain olemassa olevat, kukin kerran.
const VIITTEET = 'Infra/skills/keskustelun-siirto/references';
export function kontekstiTiedostot(nimi, rekisterit, juuri) {
  const tulos = rekisterit.map((polku) => ({ laji: 'rekisteri', polku }));
  const hakemisto = dirname(rekisterit[0] ?? '');
  tulos.push({ laji: 'historia', polku: join(hakemisto, 'HISTORIA.md') }, { laji: 'arkisto', polku: join(hakemisto, 'ARKISTO.md') });
  const sanat = nimi.split(' ');
  for (let n = sanat.length; n > 0; n--) {
    const polku = `${VIITTEET}/${sanat.slice(0, n).join('-')}.md`;
    if (existsSync(join(juuri, polku))) { tulos.push({ laji: 'viite', polku }); break; }
  }
  tulos.push({ laji: 'yhteinen', polku: `${VIITTEET}/yhteiset.md` }, { laji: 'yhteinen', polku: 'claude/TYOTAVAT.md' });
  const nahty = new Set();
  return tulos.filter((t) => !nahty.has(t.polku) && nahty.add(t.polku) && existsSync(join(juuri, t.polku)));
}

// Istunnon konteksti osa-alueittain viimeisimmästä tiivistyksestä (compact_boundary) alkaen. Osat arvioidaan
// transkriptin tekstistä: viestit, työkalukutsut ja -tulokset, Claude Coden liitteet (CLAUDE.md ja muisti, taito- ja
// työkalulistat, muistutukset) ja viimeisin järjestelmäkehote (prompt_snapshot). Mitatusta kokonaismäärästä
// (viimeisin usage) jäävä osa on jäännös: työkalumääritykset ja agentin ajattelu, joita transkripti ei sisällä
// tekstinä. Jos arvio ylittää mitatun, osat skaalataan mitattuun.
const JARJESTELMAN = /^\s*(<(system-reminder|local-command|task-notification|command-)|sa-tick:|sa-uusinta:)/;
const KUVA_MERKKEINA = 1500 * MERKKIA_TOKENIIN;
const ISTUNNON_OSAT = [
  ['kehote', 'Järjestelmäkehote'],
  ['ohjeet', 'Ohjeet: CLAUDE.md ja muisti'],
  ['listat', 'Taito-, agentti- ja työkalulistat'],
  ['muistutukset', 'Muistutukset, komennot ja tiivistelmä'],
  ['kayttaja', 'Käyttäjän viestit'],
  ['agentti', 'Agentin vastaukset'],
  ['kutsut', 'Työkalukutsut'],
  ['tulokset', 'Työkalutulokset'],
];
// Liitteet, joilla ei ole mallille näkyvää tekstiä (tila- ja kirjanpitorivejä), ohitetaan.
const EI_MALLILLE = new Set(['prompt_snapshot', 'deferred_tools_record', 'credential_org', 'command_permissions', 'auto_mode', 'queued_command']);
const LISTAT = {
  skill_listing: (a) => a.content,
  agent_listing_delta: (a) => a.addedLines,
  deferred_tools_delta: (a) => a.addedLines,
  mcp_instructions_delta: (a) => a.addedBlocks,
};
const pituus = (x) => (typeof x === 'string' ? x.length : Array.isArray(x) ? x.reduce((s, y) => s + pituus(y), 0) : 0);
const sisaltoMerkit = (c) => (typeof c === 'string' ? c.length
  : Array.isArray(c) ? c.reduce((s, o) => s + (o?.type === 'text' ? o.text.length : o?.type === 'image' ? KUVA_MERKKEINA : 0), 0) : 0);

export function kontekstinOsat(transkripti, mitattu) {
  const merkit = Object.fromEntries(ISTUNNON_OSAT.map(([k]) => [k, 0]));
  const rivit = transkripti.split('\n');
  const alku = rivit.findLastIndex((r) => r.includes('"compact_boundary"')) + 1;
  rivit.forEach((rivi, n) => {
    let j;
    try { j = JSON.parse(rivi); } catch { return; }
    if (j.isSidechain) return;
    // Järjestelmäkehote on istunnon nykyinen, joten viimeisin tilannekuva kelpaa myös ennen tiivistystä.
    if (j.attachment?.type === 'prompt_snapshot') { merkit.kehote = pituus(j.attachment.systemPrompt); return; }
    if (n < alku) return;
    const c = j.message?.content;
    if (j.type === 'attachment') {
      const a = j.attachment ?? {};
      if (a.type === 'instructions') merkit.ohjeet += (a.files ?? []).reduce((s, f) => s + pituus(f.content), 0);
      else if (LISTAT[a.type]) merkit.listat += pituus(LISTAT[a.type](a));
      else if (!EI_MALLILLE.has(a.type)) merkit.muistutukset += JSON.stringify(a).length;
    } else if (j.type === 'user') {
      for (const o of typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []) {
        if (o?.type === 'tool_result') merkit.tulokset += sisaltoMerkit(o.content);
        else if (o?.type === 'text') merkit[j.isMeta || j.isCompactSummary || JARJESTELMAN.test(o.text) ? 'muistutukset' : 'kayttaja'] += o.text.length;
        else if (o?.type === 'image') merkit.kayttaja += KUVA_MERKKEINA;
      }
    } else if (j.type === 'assistant' && Array.isArray(c)) {
      for (const o of c) {
        if (o?.type === 'text') merkit.agentti += o.text.length;
        else if (o?.type === 'tool_use') merkit.kutsut += (o.name ?? '').length + JSON.stringify(o.input ?? {}).length;
      }
    }
  });
  let osat = ISTUNNON_OSAT.map(([k, nimi]) => ({ nimi, tokenit: tokeneiksi(merkit[k]) }));
  if (mitattu == null) return osat;
  const summa = osat.reduce((s, o) => s + o.tokenit, 0);
  if (summa > mitattu) osat = osat.map((o) => ({ ...o, tokenit: Math.round((o.tokenit * mitattu) / summa) }));
  return [...osat, { nimi: 'Työkalumääritykset ja ajattelu (jäännös)', tokenit: Math.max(0, mitattu - summa) }];
}

// Istunnon ladatut osat tekstinä (SCOPES-KONTEKSTI-LADATUT V-400, 15.10.2026, käyttäjä: "kaikki mitä skoopissa
// ladataan muistiin pitää näkyä konteksti välilehdellä"): samat transkriptin lähteet kuin kontekstinOsat, mutta
// ryhminä, joiden osat avautuvat tekstinä kuten tiedostojen osat. Muistutukset jaetaan alkuun (ennen agentin
// ensimmäistä vastausta) ja kertyneisiin; osa per liitelaji. Purun runko on /pura-taidon teksti ja siirtäjän raportti
// (aja-siirtaja.sh pura tai Agent-reitin "pura …"-ali-agentti). Tyhjät ryhmät jätetään pois.
const LISTAN_NIMI = { skill_listing: 'Taitolista', agent_listing_delta: 'Agenttilista', deferred_tools_delta: 'Viivästetyt työkalut', mcp_instructions_delta: 'MCP-ohjeet' };
const liitteenTeksti = (a) => (typeof a.text === 'string' ? a.text : typeof a.content === 'string' ? a.content
  : typeof a.turnReminder === 'string' ? a.turnReminder : typeof a.style?.prompt === 'string' ? a.style.prompt : JSON.stringify(a, null, 1));
const tekstina = (x) => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(tekstina).filter(Boolean).join('\n\n') : '');
const sisaltoTekstina = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((o) => (o?.type === 'text' ? o.text : o?.type === 'image' ? '[kuva]' : '')).join('\n') : '');
const purunKutsu = (o) => (o.name === 'Bash' && /(^|&&|;)\s*bash\s+\S*aja-siirtaja\.sh\s+pura\b/.test(o.input?.command ?? ''))
  || (o.name === 'Agent' && /^pura\s/.test(o.input?.description ?? ''));

export function istunnonLadatut(transkripti) {
  const rivit = transkripti.split('\n');
  const alku = rivit.findLastIndex((r) => r.includes('"compact_boundary"')) + 1;
  let kehote = [];
  let ohjeet = [];
  const listat = [];
  const taidot = [];
  const muistutukset = { alku: new Map(), kertynyt: new Map() };
  const purunKutsut = new Set();
  let vastattu = false;
  const muista = (lohko, otsikko, teksti) => {
    if (!teksti) return;
    const m = muistutukset[lohko];
    m.set(otsikko, [...(m.get(otsikko) ?? []), teksti]);
  };
  rivit.forEach((rivi, n) => {
    let j;
    try { j = JSON.parse(rivi); } catch { return; }
    if (j.isSidechain) return;
    if (j.attachment?.type === 'prompt_snapshot') {
      kehote = (Array.isArray(j.attachment.systemPrompt) ? j.attachment.systemPrompt : [j.attachment.systemPrompt])
        .map(tekstina).filter((t) => t && !/^__[A-Z_]+__$/.test(t.trim()));
      return;
    }
    if (n < alku) return;
    const lohko = vastattu ? 'kertynyt' : 'alku';
    const c = j.message?.content;
    if (j.type === 'attachment') {
      const a = j.attachment ?? {};
      if (a.type === 'instructions') ohjeet = (a.files ?? []).map((f) => ({ otsikko: f.path ?? f.type ?? 'ohje', teksti: tekstina(f.content) }));
      else if (LISTAT[a.type]) listat.push({ otsikko: LISTAN_NIMI[a.type], teksti: tekstina(LISTAT[a.type](a)) });
      else if (!EI_MALLILLE.has(a.type)) muista(lohko, a.type, liitteenTeksti(a));
    } else if (j.type === 'user') {
      for (const o of typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []) {
        if (o?.type === 'tool_result' && purunKutsut.has(o.tool_use_id)) taidot.push({ otsikko: 'Purun raportti', teksti: sisaltoTekstina(o.content) });
        if (o?.type !== 'text') continue;
        const taito = j.isMeta && o.text.match(/^Base directory for this skill: \S*?([^/\s]+)\s/);
        if (taito) taidot.push({ otsikko: `Taito ${taito[1]}`, teksti: o.text });
        else if (/^\s*<command-(message|name)>/.test(o.text)) taidot.push({ otsikko: 'Komento', teksti: o.text });
        else if (j.isCompactSummary) muista(lohko, 'Tiivistelmä', o.text);
        else if (j.isMeta || JARJESTELMAN.test(o.text)) muista(lohko, 'Järjestelmäviestit', o.text);
      }
    } else if (j.type === 'assistant' && Array.isArray(c)) {
      vastattu = true;
      for (const o of c) if (o?.type === 'tool_use' && purunKutsu(o)) purunKutsut.add(o.id);
    }
  });
  const ryhma = (laji, osat) => {
    const o = osat.filter((x) => x.teksti).map((x) => ({ ...x, tokenit: tokeneiksi(x.teksti.length) }));
    return o.length ? { laji, osat: o, tokenit: o.reduce((s, x) => s + x.tokenit, 0) } : null;
  };
  const muistutusOsat = (m) => [...m].map(([laji, tekstit]) => ({ otsikko: tekstit.length > 1 ? `${laji} ×${tekstit.length}` : laji, teksti: tekstit.join('\n\n') }));
  const otsikoitu = (t) => t.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 60);
  return {
    alku: [
      ryhma('kehote', kehote.map((t) => ({ otsikko: otsikoitu(t), teksti: t }))),
      ryhma('ohjeet', ohjeet),
      ryhma('listat', listat),
      ryhma('muistutukset-alku', muistutusOsat(muistutukset.alku)),
      ryhma('purku', taidot),
    ].filter(Boolean),
    kertynyt: [ryhma('muistutukset-kertynyt', muistutusOsat(muistutukset.kertynyt))].filter(Boolean),
  };
}

// Rekisterikatto (SCOPES-INFRA-REKISTERIT 14.10.2026) samalla mitalla kuin claude/siirto/tools/check-rekisteri.mjs,
// jotta äpin täyttöaste ja pakkauksen portti täsmäävät: tavut ilman pakollisia lukuja (state/rekisteri-pakolliset.json,
// otsikko tai otsikko + tarkenne); raja rekisterille 40 000 tai suurempi lähtötaso (state/rekisteri-katto.json), muulle
// tiedostolle vain kirjattu lähtötaso, muuten null. Työkalu on skripti eikä kirjasto, joten mitta toistetaan tässä.
const KATTO = 40000;
const STATE = 'claude/siirto/state';
const lueJson = (juuri, polku) => { try { return JSON.parse(readFileSync(join(juuri, polku), 'utf8')); } catch { return {}; } };
export function katonTavut(teksti, pakolliset = []) {
  const rivit = teksti.split('\n');
  const otsikot = rivit.flatMap((r, i) => (/^## /.test(r) ? [{ otsikko: r.trim(), alku: i }] : []));
  let pois = 0;
  otsikot.forEach(({ otsikko, alku }, n) => {
    if (!pakolliset.some((p) => otsikko === p.trim() || otsikko.startsWith(`${p.trim()} `))) return;
    pois += Buffer.byteLength(rivit.slice(alku, otsikot[n + 1]?.alku ?? rivit.length).join('\n') + '\n');
  });
  return Buffer.byteLength(teksti) - pois;
}
function katto(juuri) {
  const tasot = lueJson(juuri, `${STATE}/rekisteri-katto.json`);
  const pakolliset = lueJson(juuri, `${STATE}/rekisteri-pakolliset.json`);
  return (laji, polku, teksti) => {
    const taso = Number(tasot[polku]);
    const raja = laji === 'rekisteri' ? Math.max(KATTO, Number.isFinite(taso) ? taso : 0) : Number.isFinite(taso) ? taso : null;
    return { tavut: katonTavut(teksti, Object.keys(pakolliset[polku] ?? {})), raja };
  };
}
const lueTeksti = (juuri, polku) => { try { return readFileSync(join(juuri, polku), 'utf8'); } catch { return ''; } };

// Kaikkien skooppien kontekstitiedostot kerran (SCOPES-INFRA-REKISTERIT): polku, laji, skoopit, jotka sen lataavat,
// katon tavut ja raja sekä tokenit. Osat haetaan erikseen (rekisterinOsat), koska kaikki tekstit yhdessä ovat megatavuja.
function kaikkiTiedostot(juuri) {
  const tiedostot = new Map();
  for (const [nimi, rs] of Object.entries(lueSkoopit(juuri))) {
    for (const { laji, polku } of kontekstiTiedostot(nimi, rs, juuri)) {
      if (tiedostot.has(polku)) tiedostot.get(polku).skoopit.push(nimi);
      else tiedostot.set(polku, { polku, laji, skoopit: [nimi] });
    }
  }
  return tiedostot;
}
export function rekisterit(asetukset) {
  const mitta = katto(asetukset.juuri);
  return [...kaikkiTiedostot(asetukset.juuri).values()].map((t) => {
    const teksti = lueTeksti(asetukset.juuri, t.polku);
    return { ...t, ...mitta(t.laji, t.polku, teksti), tokenit: osiin(teksti).reduce((s, o) => s + o.tokenit, 0) };
  });
}
// Yhden tiedoston osat; vain kontekstitiedostot, ei mielivaltaista polkua → null.
export function rekisterinOsat(polku, asetukset) {
  if (!kaikkiTiedostot(asetukset.juuri).has(polku)) return null;
  return { polku, osat: osiin(lueTeksti(asetukset.juuri, polku)) };
}

// HISTORIA.md ja ARKISTO.md eivät kuulu skoopin kontekstilukuun: pura ei lue niitä (V-399, 15.10.2026). Rekisterien
// kattosivulla (rekisterit) ne pysyvät, koska niillä on kirjattu lähtötaso.
const EI_LADATA = new Set(['historia', 'arkisto']);
export function skoopinKonteksti(nimi, { juuri, rekisterit, istunnot: skoopinIstunnot }) {
  const mitta = katto(juuri);
  const tiedostot = kontekstiTiedostot(nimi, rekisterit, juuri).filter(({ laji }) => !EI_LADATA.has(laji)).map(({ laji, polku }) => {
    const teksti = lueTeksti(juuri, polku);
    const osat = osiin(teksti);
    return { laji, polku, tokenit: osat.reduce((s, o) => s + o.tokenit, 0), ...mitta(laji, polku, teksti), osat };
  });
  const transkriptit = skoopinIstunnot.map((i) => {
    try { return readFileSync(i.polku, 'utf8'); } catch { return ''; /* uusi istunto ilman transkriptia */ }
  });
  // Ladatut osat (V-400) uusimmasta istunnosta latausjärjestyksessä: kehote, ohjeet, listat, alun muistutukset ja
  // purku ennen tiedostoja, kertyneet muistutukset niiden jälkeen. Ilman elävää istuntoa vain tiedostot.
  const uusin = skoopinIstunnot.reduce((p, i, n) => (p < 0 || (i.alkoi ?? 0) > (skoopinIstunnot[p].alkoi ?? 0) ? n : p), -1);
  const ladatut = uusin < 0 ? { alku: [], kertynyt: [] } : istunnonLadatut(transkriptit[uusin]);
  const lahde = uusin < 0 ? '' : `istunto ${skoopinIstunnot[uusin].nimi ?? skoopinIstunnot[uusin].id.slice(0, 8)}`;
  // polku on äpissä ryhmän tunniste, joten laji mukaan: "istunto x/kehote".
  const istunnosta = (r) => ({ ...r, polku: `${lahde}/${r.laji}` });
  const ryhmat = [...ladatut.alku.map(istunnosta), ...tiedostot, ...ladatut.kertynyt.map(istunnosta)];
  return {
    tokenit: ryhmat.reduce((s, r) => s + r.tokenit, 0),
    ryhmat,
    istunnot: skoopinIstunnot.map((i, n) => {
      const mitattu = i.konteksti?.tokenit ?? null;
      return { id: i.id, nimi: i.nimi, mitattu, osat: kontekstinOsat(transkriptit[n], mitattu) };
    }),
  };
}

export function yksi(nimi, asetukset, lisaIstunnot = []) {
  const skoopit = lueSkoopit(asetukset.juuri);
  const ohitaAgy = asetukset.ohitaAgy ?? (lisaIstunnot != null && lisaIstunnot.length > 0);
  const loydetyt = istunnot({ ...asetukset, skooppiNimet: Object.keys(skoopit), ohitaAgy });
  const lisaNahdyt = new Set(lisaIstunnot.map((i) => i.id));
  const kaikkiIstunnot = [...lisaIstunnot, ...loydetyt.filter((i) => !lisaNahdyt.has(i.id))];
  const s = skooppi(nimi, { juuri: asetukset.juuri, skoopit, kaikkiIstunnot });
  return s && { ...s, konteksti: skoopinKonteksti(nimi, { juuri: asetukset.juuri, rekisterit: s.rekisterit, istunnot: s.istunnot }) };
}

export function lueViat(juuri) {
  const polku = join(juuri, "scopes/viat/REKISTERI.md");
  if (!existsSync(polku)) return { viat: [] };
  const lines = readFileSync(polku, "utf8").split("\n");
  const viat = [];
  let inViat = false;
  for (const line of lines) {
    if (line.trim().startsWith("## Viat")) { inViat = true; continue; }
    if (inViat && line.trim().startsWith("## ")) break;
    if (inViat && line.startsWith("|")) {
      const parts = line.split("|").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2 && parts[0] !== "Vika" && !parts[0].startsWith("---")) {
        viat.push({ vika: parts[0], tila: parts[1] });
      }
    }
  }
  return { viat };
}
