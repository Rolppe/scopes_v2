// Mallinappi (T-80, ARK-16, S-10): /model ja /effort vapaan istunnon tmux-ruutuun. Käytös = vanhan 8787:n
// (scopes/palvelu/viestit.mjs:833-897, palvelin.mjs:262), kopioitu kopioriveineen.
// Sovitus: aja, loki, kello ja istuntohakemistot tulevat ymp:stä (palvelin.mjs).
//   ymp.odota(ms) → Promise    valinnainen (testit): malliTauko; oletus setTimeout
//   ymp.malliTauko             valinnainen tauon pituus ms (oletus 1000, kuten vanhan asetukset.malliTauko)
//   ymp.istunnotDir, projektitDir   valinnaiset (kuten viestit.mjs)
// viestit.mjs ei vie tmuxIstunto-apureita (ne ovat luoViestit-sulkeuman sisällä), joten ne kopioidaan tähän.
// Tuonnit vain ./aja.mjs, ./runko.mjs, ./viestit.mjs (keskustelu), ../vanhasta/* ja node:-moduulit (gate.sh tuontitarkistus).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { istunnotAsync, lueSkoopit } from '../vanhasta/lahteet.mjs';
import { Hylatty } from './aja.mjs';
import { lueRunko, vastaa } from './runko.mjs';
import { keskustelu } from './viestit.mjs';

// kopio: scopes/palvelu/viestit.mjs:26-31 (21.10.2026)
export const MALLIT = [
  { nimi: 'claude-fable-5-1', kuvaus: 'Fable 5.1', tyyppi: 'malli' },
  { nimi: 'claude-opus-5-5', kuvaus: 'Opus 5.5', tyyppi: 'malli' },
  { nimi: 'claude-sonnet-5-5', kuvaus: 'Sonnet 5.5', tyyppi: 'malli' },
  { nimi: 'claude-haiku-5-5', kuvaus: 'Haiku 5.5', tyyppi: 'malli' },
];
// kopio: scopes/palvelu/viestit.mjs:45-46 (21.10.2026)
// Istunnon effort-tasot (/effort); sama joukko kuin claude/siirto/tools/autovaihto.sh:ssa.
export const EFFORTIT = ['low', 'medium', 'high', 'xhigh', 'max'];

// luoMalli(ymp): mallin ja effortin vaihto (vanha luoViestit.vaihdaMalli). Ei tilaa: luodaan pyynnöittäin.
export function luoMalli(ymp) {
  const aja = ymp.aja;
  const odota = ymp.odota ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const asetukset = {
    juuri: ymp.juuri,
    istunnotDir: ymp.istunnotDir ?? process.env.CLAUDE_ISTUNNOT_DIR ?? join(homedir(), '.claude/sessions'),
    projektitDir: ymp.projektitDir ?? process.env.CLAUDE_PROJEKTIT_DIR ?? join(homedir(), '.claude/projects'),
    agyHakemisto: ymp.agyHakemisto,
    brainHakemisto: ymp.brainHakemisto,
    malliTauko: ymp.malliTauko,
  };
  const kirjaa = (rivi) => { try { ymp.loki?.(rivi); } catch { /* loki ei estä vaihtoa */ } };

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
// kopio: scopes/palvelu/viestit.mjs:829-897 (21.10.2026); sovitus: tauko käyttää ymp.odota:a, kirjaus ymp.loki:a
    // Mallinappi (MALLINAPPI 16.10.2026): /model ja /effort istunnon omasta valitsimesta, kuten käyttäjä käyttäisi ne.
    // Suora `/model <id>` ja `/effort <taso>` tallentavat globaalin oletuksen settings.json:iin (todettu 16.10.2026); valitsimen
    // `s`-näppäin vaihtaa vain tälle istunnolle, joten kumpikin kulkee valitsimen kautta ja tulos tarkistetaan ruudusta.
    // Vain vapaassa istunnossa: työn aikana komento jäisi jonoon, ja kysymyskortti söisi sen. Arvot tarkistetaan listoilta.
    async vaihdaMalli(nimi, { malli, effort } = {}) {
      if (malli == null && effort == null) throw new Hylatty(400, 'malli tai effort puuttuu');
      const valittuMalli = malli != null ? MALLIT.find((m) => m.nimi === malli) : null;
      if (malli != null && !valittuMalli) throw new Hylatty(400, 'tuntematon malli');
      if (effort != null && !EFFORTIT.includes(effort)) throw new Hylatty(400, 'tuntematon effort');
      const i = await tmuxIstunto(nimi);
      if (i.tila !== 'idle') throw new Hylatty(409, 'istunto ei ole vapaa');
      let transkripti = '';
      try { transkripti = readFileSync(i.polku, 'utf8'); } catch { /* ei transkriptia */ }
      const viimeinen = keskustelu(transkripti, 1)[0];
      if (viimeinen?.rooli === 'kysymys' && !viimeinen.vastattu) throw new Hylatty(409, 'kysymys odottaa vastausta');
      const tauko = () => odota(asetukset.malliTauko ?? 1000);
      const nappaimet = async (...a) => {
        const t = await aja('tmux', ['send-keys', '-t', i.ruutu, ...a]);
        if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
      };
      const ruutu = async () => (await aja('tmux', ['capture-pane', '-p', '-t', i.ruutu])).stdout ?? '';
      const avaa = async (komento) => { await nappaimet('C-u'); await nappaimet('-l', komento); await nappaimet('Enter'); await tauko(); };
      // Välimuistivaroituksen "Change effort level?" Yes-vaihtoehto tallentaa globaalin oletuksen (V-525, 16.10.2026), joten
      // sitä ei koskaan vahvisteta: Escape, ja jos ikkuna jäi auki, numero 2 ("No, go back"). Auki jäänyt ikkuna sanotaan virheessä.
      const VAHVISTUS = /Change effort level\?/;
      const suljeVahvistus = async () => {
        await nappaimet('Escape').catch(() => {});
        await tauko();
        if (VAHVISTUS.test(await ruutu())) { await nappaimet('-l', '2').catch(() => {}); await tauko(); }
        return !VAHVISTUS.test(await ruutu());
      };
      const peru = async (syy) => {
        const suljettu = VAHVISTUS.test(await ruutu()) ? await suljeVahvistus() : (await nappaimet('Escape').catch(() => {}), true);
        throw new Hylatty(502, suljettu ? syy : `${syy}; vahvistusikkuna jäi auki ruutuun`);
      };
      const vahvista = async (odotus, syy) => {
        await nappaimet('-l', 's');
        await tauko();
        const nyt = await ruutu();
        if (VAHVISTUS.test(nyt)) {
          const suljettu = await suljeVahvistus();
          throw new Hylatty(409, suljettu ? 'vaihto vaatii välimuistivahvistuksen, jota ei hyväksytä (tallentaisi globaalin oletuksen); ei vaihdettu' : 'vahvistusikkuna jäi auki ruutuun');
        }
        if (!odotus.test(nyt)) await peru(syy);
      };
      const komennot = [];
      if (valittuMalli) {
        await avaa('/model');
        const rivit = (await ruutu()).split('\n');
        const kohde = new RegExp(`^\\s*❯?\\s*(\\d+)\\.\\s+${valittuMalli.kuvaus.replace(/\./g, '\\.')}(\\s|$)`);
        const nyt = rivit.map((r) => /^\s*❯\s*(\d+)\./.exec(r)?.[1]).find(Boolean);
        const haluttu = rivit.map((r) => kohde.exec(r)?.[1]).find(Boolean);
        if (!nyt || !haluttu) await peru('mallivalitsin ei auennut tai mallia ei löydy');
        const ero = Number(haluttu) - Number(nyt);
        if (ero) await nappaimet(...Array(Math.abs(ero)).fill(ero > 0 ? 'Down' : 'Up'));
        await vahvista(/for this session only/, 'mallin vaihto tälle istunnolle ei vahvistunut');
        komennot.push(`model ${malli}`);
      }
      if (effort != null) {
        await avaa('/effort');
        // Liukusäätimen reunat pysäyttävät: vasempaan reunaan (low) ja sieltä oikealle tasoon.
        await nappaimet(...Array(EFFORTIT.length - 1).fill('Left'));
        if (EFFORTIT.indexOf(effort)) await nappaimet(...Array(EFFORTIT.indexOf(effort)).fill('Right'));
        await vahvista(new RegExp(`effort level to ${effort} \\(this session only\\)`), 'effortin vaihto tälle istunnolle ei vahvistunut');
        komennot.push(`effort ${effort}`);
      }
      kirjaa({ toiminto: 'malli', nimi, istunto: i.id, komennot });
      return { ok: true, istunto: i.id };
    },
  };
}

// Reitti. Käsittelijä luo mallin pyynnöittäin (ei jaettua tilaa). Virheet (Hylatty) muuttuu statukseksi palvelin.mjs:ssä.
// kopio: scopes/palvelu/palvelin.mjs:262-263 (21.10.2026); runko enintään 1 kt (lueRunko-oletus = vanhan runko(req, 1024))
export const REITIT = [
  { metodi: 'POST', kuvio: '/api/skoopit/*/malli', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    vastaa(res, 200, await luoMalli(ymp).vaihdaMalli(osat[0], await lueRunko(req)));
  } },
];
