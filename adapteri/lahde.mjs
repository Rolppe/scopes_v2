// Adapterin lähdetila (T-29, S-5b): istunnot, agy, android, kayttoraja ja (T-83, asetusHakemisto annettu) asetukset kootaan välimuisteilla ja lähetetään ytimeen
// POST <ydin>/api/lahde/<laji> {"laite","sisalto"} vain, kun sisällön sha256 muuttui; vähintään elossaMs (60 s) välein.
// Vain luku lähteisiin: ei kirjoita levylle, ei screencapia, ei synkronisia alikomentoja (kaikki `aja`-funktion kautta).
//
// Jäsennys ja lukijat tuodaan kopioista vanhasta/*.mjs (T-65, SUUNNITELMA luku 11.6): kopio = scopes/palvelu/<nimi>.mjs tavulleen paitsi kopiorivi ja import-rivit; alkuperäisiä ei muuteta (K-9).
//   P-9: agy-istunto.mjs loydaKeskustelu ei ole injektoitavissa (readdir+stat) → välimuisti kääreessä (agyKaare).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, relative } from 'node:path';
import { agyIstunnot as vanhaAgyIstunnot } from './vanhasta/agy-istunto.mjs';
import { luoAndroid as vanhaLuoAndroid } from './vanhasta/android.mjs';
import { luoKayttoraja as vanhaLuoKayttoraja } from './vanhasta/kayttoraja.mjs';
import { luoAgyKayttoraja as vanhaLuoAgyKayttoraja } from './vanhasta/agy-kayttoraja.mjs';
import { istunnonLadatut } from './vanhasta/lahteet.mjs';
import { luoAsetukset } from './vanhasta/toiminnot-asetukset.mjs';
import {
  istuntotiedostot, lueLisays, konteksti, pysahdys, pakattu, hereilla, istunnonSkooppi,
} from './transkriptit.mjs';

export const LAJIT = Object.freeze(['istunnot', 'agy', 'android', 'kayttoraja', 'asetukset', 'jono']);
export const AGY_TTL_MS = 5000;
export const ADB_TTL_MS = 1000;
export const KAYTTORAJA_TTL_MS = 60000;
const AIKARAJA_MS = 15000;

const kotiin = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);
const sha256 = (teksti) => createHash('sha256').update(teksti).digest('hex');

// Oletus-`aja`: async (komento, args, { aikaraja }) → { koodi, stdout (merkkijono) }. Ei koskaan hylkää.
export const oletusAja = (komento, args, { aikaraja = 30000 } = {}) => new Promise((ok) => {
  execFile(komento, args, { timeout: aikaraja, maxBuffer: 8 << 20 }, (virhe, stdout) =>
    ok({ koodi: virhe ? (typeof virhe.code === 'number' ? virhe.code : -1) : 0, stdout: String(stdout ?? '') }));
});

// Ladatut osat tiivistettynä (otsikko + tokenit, ilman tekstiä): koko teksti olisi satoja kilotavuja joka muutoksella.
const ladatutTiivis = (l) => {
  const ryhma = (r) => ({ laji: r.laji, tokenit: r.tokenit, osat: r.osat.map((o) => ({ otsikko: o.otsikko, tokenit: o.tokenit })) });
  return { alku: l.alku.map(ryhma), kertynyt: l.kertynyt.map(ryhma) };
};

export function luoLahde({
  ydin = process.env.SCOPES2_YDIN ?? 'http://127.0.0.1:8797',
  avainTiedosto = '~/.config/scopes2/avain',
  aja = oletusAja,
  istunnotDir = null,
  projektitDir = '',
  skooppiNimet = () => [],
  agyHakemisto = null,
  brainHakemisto = undefined,
  asetusHakemisto = null, // T-83: kytkinten tilahakemisto; null = laji asetukset pois (adapteri.mjs antaa tuotannossa vanhan oletuksen)
  jono = null, // T-109: () => { skooppi: [{komento, aika}] } adapterin jonosta; null = laji jono pois (vain --toiminnot)
  adb = null,
  valiMs = 5000,
  elossaMs = 60000,
  fetch = globalThis.fetch,
  nyt = Date.now,
  laite = hostname(),
  agyRuudut = false,
  proc = '/proc',
  loki = (rivi) => process.stderr.write(`${rivi}\n`),
  // Testejä varten korvattavat vanhan puolen tehtaat ja funktiot (oletus: vanhat moduulit sellaisenaan).
  agyIstunnot = vanhaAgyIstunnot,
  luoAndroid = vanhaLuoAndroid,
  luoKayttoraja = vanhaLuoKayttoraja,
  luoAgyKayttoraja = vanhaLuoAgyKayttoraja,
} = {}) {
  const pohja = ydin.replace(/\/+$/, '');
  const lueAvain = () => { try { return readFileSync(kotiin(avainTiedosto), 'utf8').trim(); } catch { return ''; } };
  let avain = lueAvain();
  let suljettu = false;
  let ajastin = null;
  let kaynnissa = false;

  // ---- istunnot ----------------------------------------------------------------------------------------------------
  // Transkriptit lueLisays-välimuistista (oma Map, ettei peili.mjs:n offsetit sekoitu): polku → kertynyt teksti ja
  // siitä lasketut kentät, uudelleen vain kun teksti, nimi tai skooppilista muuttui.
  const offsetit = new Map();
  const tilat = new Map(); // polku → { teksti, avain, kentat }

  function lueTranskripti(polku, t) {
    let muuttui = false;
    for (let i = 0; i < 1000; i++) { // kesken-lukuraja: jatketaan kunnes loppu
      let r;
      try { r = lueLisays(polku, offsetit); } catch {
        if (t.teksti) { t.teksti = ''; muuttui = true; } // tiedosto poistui tai puuttuu (uusi istunto ilman transkriptia)
        break;
      }
      if (r.nollattu) { t.teksti = ''; muuttui = true; }
      if (r.rivit.length) { t.teksti += `${r.rivit.join('\n')}\n`; muuttui = true; }
      if (!r.kesken) break;
    }
    return muuttui;
  }

  // Vanhan lahteet.istunnot()-funktion vanhempi: /proc/<pid>/stat:n ppid (istuntotiedostot on jo todennut prosessin elossa).
  const vanhempi = (pid) => {
    try {
      const stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { return null; }
  };

  function istunnotSisalto() {
    const nimet = skooppiNimet();
    const elavat = istuntotiedostot(istunnotDir, proc, projektitDir);
    const polut = new Set(elavat.map((s) => s.polku));
    for (const p of [...tilat.keys()]) if (!polut.has(p)) { tilat.delete(p); offsetit.delete(p); }
    const tulos = elavat.map((s) => {
      let t = tilat.get(s.polku);
      if (!t) { t = { teksti: '', avain: null, kentat: null }; tilat.set(s.polku, t); }
      const muuttui = lueTranskripti(s.polku, t);
      const avain = `${s.nimi ?? ''}\u0000${nimet.join('\u0000')}`;
      if (muuttui || t.kentat == null || t.avain !== avain) {
        t.avain = avain;
        t.kentat = {
          skooppi: istunnonSkooppi(s.nimi ?? '', t.teksti, nimet),
          konteksti: konteksti(t.teksti),
          pysahdys: pysahdys(t.teksti),
          pakattu: pakattu(t.teksti),
          hereilla: hereilla(t.teksti),
          ladatut: ladatutTiivis(istunnonLadatut(t.teksti)),
        };
      }
      return {
        istunto: s.id,
        skooppi: t.kentat.skooppi,
        tila: s.tila,
        kysely: s.kysely,
        konteksti: t.kentat.konteksti,
        pysahdys: t.kentat.pysahdys,
        pakattu: t.kentat.pakattu,
        hereilla: t.kentat.hereilla,
        ladatut: t.kentat.ladatut,
        transkripti: relative(projektitDir, s.polku).split('\\').join('/'),
        alkoi: s.alkoi ? new Date(s.alkoi).toISOString() : null, // S-5b: ISO (käyttäjä 19.10.2026)
        ruutu: s.ruutu,
        // S-5b:n lisäkentät vanhan istunnot()-funktion arvoina (ytimen T-35 /api/skoopit/<nimi> ja /viestit; käyttäjä 19.10.2026).
        nimi: s.nimi,
        pid: s.pid,
        vanhempi: vanhempi(s.pid),
        polku: s.polku,
      };
    });
    return tulos.sort((a, b) => (a.istunto < b.istunto ? -1 : a.istunto > b.istunto ? 1 : 0));
  }

  // ---- agy ---------------------------------------------------------------------------------------------------------
  // list-panes joka kierros; capture-pane vain agyRuudut-lipulla (E-25). Tulos välimuistiin AGY_TTL_MS:ksi, jos
  // list-panes-tuloste on sama (keskusteluhakemiston readdir+stat, E-22).
  let agyVm = null; // { aika, panes, sisalto }
  const capturePane = agyRuudut
    ? async (ruutu) => { const c = await aja('tmux', ['capture-pane', '-p', '-t', ruutu]); return c.koodi === 0 ? c.stdout : ''; }
    : async () => '';

  async function agySisalto() {
    const t = await aja('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_current_command} #{session_created} #{pane_pid}']);
    const panes = t.koodi === 0 ? String(t.stdout) : '';
    if (!panes) { agyVm = null; return []; }
    if (agyVm && agyVm.panes === panes && nyt() - agyVm.aika < AGY_TTL_MS) return agyVm.sisalto;
    const sisalto = await agyIstunnot({
      skooppiNimet: skooppiNimet(), aja, agyHakemisto, ...(brainHakemisto ? { brainHakemisto } : {}), proc, listPanes: panes, capturePane,
    });
    agyVm = { aika: nyt(), panes, sisalto };
    return sisalto;
  }

  // ---- android (vain tila(), ei screencapia) -----------------------------------------------------------------------
  let androidVm = null; // { aika, sisalto }
  let androidOlio = null;
  async function androidSisalto() {
    if (androidVm && nyt() - androidVm.aika < ADB_TTL_MS) return androidVm.sisalto;
    androidOlio ??= luoAndroid({ ...(typeof adb === 'string' ? { laite: adb } : {}), aja, nyt });
    const sisalto = await androidOlio.tila();
    androidVm = { aika: nyt(), sisalto };
    return sisalto;
  }

  // ---- kayttoraja --------------------------------------------------------------------------------------------------
  let rajaVm = null; // { aika, sisalto }
  let claudeRaja = null;
  let agyRaja = null;
  async function kayttorajaSisalto() {
    if (rajaVm && nyt() - rajaVm.aika < KAYTTORAJA_TTL_MS) return rajaVm.sisalto;
    claudeRaja ??= luoKayttoraja();
    agyRaja ??= luoAgyKayttoraja(brainHakemisto ? { brainDir: brainHakemisto } : {});
    const [claude, agy] = await Promise.all([
      Promise.resolve().then(() => claudeRaja()).catch(() => null),
      Promise.resolve().then(() => agyRaja({ ryhma: 'gemini' })).catch(() => null),
    ]);
    const sisalto = { claude, agy };
    rajaVm = { aika: nyt(), sisalto };
    return sisalto;
  }

  // ---- asetukset (T-83, S-5b) --------------------------------------------------------------------------------------
  // Kytkinten tila ytimen luettavaksi (ydin ei lue tiedostoja): yhteiset arvot, avointen (pakkaamattomien) istuntojen omat
  // arvot ja skoopeittain avointen istuntojen tunnukset kuten vanha istunto-asetukset.mjs. Ei välimuistia: tiedostot luetaan
  // joka kierroksella, jotta S-10-muutoksen jälkeinen heti-kierros näkee uuden arvon. Istuntolista kuten vanha istunnot():
  // Claude-istunnot ja niiden perään agy-istunnot (tunnus = id). Agy-lista agySisalto-välimuistista (T-106): saman
  // kierroksen agy-laji ja asetukset jakavat yhden keskeneräisen haun, joten uutta readdir-/SQLite-lukua ei tule.
  let agyKesken = null;
  const agyJaettu = () => (agyKesken ??= agySisalto().finally(() => { agyKesken = null; }));
  async function asetuksetSisalto() {
    const kytkimet = luoAsetukset({ hakemisto: asetusHakemisto });
    const claude = istunnotDir ? istunnotSisalto().map((i) => ({ ...i, tunnus: i.istunto })) : [];
    const agy = agyHakemisto ? (await agyJaettu()).map((i) => ({ ...i, tunnus: i.id })) : [];
    const avoimet = [...claude, ...agy].filter((i) => !i.pakattu && i.tunnus);
    const istunnot = {};
    for (const i of avoimet) istunnot[i.tunnus] = kytkimet.lueIstunto(i.tunnus);
    const skoopit = {};
    for (const nimi of skooppiNimet()) skoopit[nimi] = avoimet.filter((i) => i.skooppi === nimi).map((i) => i.tunnus);
    return { yhteiset: kytkimet.lue(), istunnot, skoopit };
  }

  const keraajat = {};
  if (istunnotDir) keraajat.istunnot = async () => istunnotSisalto();
  if (agyHakemisto) keraajat.agy = agyJaettu;
  if (adb) keraajat.android = androidSisalto;
  if (istunnotDir || agyHakemisto) keraajat.kayttoraja = kayttorajaSisalto;
  if (asetusHakemisto) keraajat.asetukset = asetuksetSisalto;
  if (jono) keraajat.jono = async () => jono();

  // ---- lähetys -----------------------------------------------------------------------------------------------------
  const lahetetyt = new Map(); // laji → { tiiviste, aika }
  const virheet = new Map(); // laji → viimeksi lokitettu keruuvirhe (ei toisteta joka kierros)

  async function laheta(laji, sisalto) {
    const runko = JSON.stringify({ laite, sisalto });
    for (let kerta = 0; kerta < 2; kerta++) {
      let vastaus;
      try {
        vastaus = await fetch(`${pohja}/api/lahde/${laji}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${avain}`, 'content-type': 'application/json' },
          body: runko,
          signal: AbortSignal.timeout(AIKARAJA_MS),
        });
      } catch (e) {
        loki(`lahde ${laji} ei lähtenyt: ${e?.message ?? e}`);
        return false;
      }
      if (vastaus.status === 401 && kerta === 0) { avain = lueAvain(); continue; }
      if (vastaus.status === 200 || vastaus.ok === true) return true;
      loki(`lahde ${laji} hylättiin: HTTP ${vastaus.status}`);
      return false;
    }
    return false;
  }

  async function kierrosAjo() {
    const lahetetty = [];
    const nytMs = nyt();
    await Promise.all(Object.entries(keraajat).map(async ([laji, kerää]) => {
      let sisalto;
      try { sisalto = await kerää(); } catch (e) {
        const viesti = String(e?.message ?? e);
        if (virheet.get(laji) !== viesti) { virheet.set(laji, viesti); loki(`lahde ${laji} keruu epäonnistui: ${viesti}`); }
        return;
      }
      virheet.delete(laji);
      if (sisalto == null) return;
      const runkoTeksti = JSON.stringify(sisalto);
      const tiiviste = sha256(runkoTeksti);
      const edellinen = lahetetyt.get(laji);
      if (edellinen && edellinen.tiiviste === tiiviste && nytMs - edellinen.aika < elossaMs) return;
      if (await laheta(laji, sisalto)) {
        lahetetyt.set(laji, { tiiviste, aika: nytMs });
        lahetetty.push(laji);
        loki(`lahde ${laji} → ${runkoTeksti.length} merkkiä`);
      }
    }));
    return { lahetetty: LAJIT.filter((l) => lahetetty.includes(l)) };
  }

  // T-111: päällekkäinen kierros liittyy käynnissä olevaan (ei kaksoislähetystä).
  let kierrosKesken = null;
  const kierros = () => (kierrosKesken ??= kierrosAjo().finally(() => { kierrosKesken = null; }));

  async function ajastettu() {
    if (kaynnissa || suljettu) return;
    kaynnissa = true;
    try { await kierros(); } catch (e) { loki(`lahde kierros epäonnistui: ${e?.message ?? e}`); } finally { kaynnissa = false; }
  }

  function kaynnista() {
    if (ajastin || suljettu) return;
    ajastettu();
    ajastin = setInterval(ajastettu, valiMs);
  }

  function sulje() {
    suljettu = true;
    if (ajastin) clearInterval(ajastin);
    ajastin = null;
  }

  return { kierros, kaynnista, sulje };
}
