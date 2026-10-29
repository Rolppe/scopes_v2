// Purku (T-68, ARK-16, S-10): POST /api/skoopit/*/pura ja GET /api/purkajat. Käytös = vanhan 8787:n (scopes/palvelu/toiminnot.mjs
// pura :275-300, puraMallitta :238-254, avaaIstunto :136-146, palvelin.mjs:272-274 ja :297; purkajat.mjs = vanhasta/purkajat.mjs),
// kopioitu kopioriveineen. Yksi toiminto kerrallaan: aja.mjs:n yhteinen toimintolukko (yksiToiminto), jonka myös istunto.mjs
// (pakkaa, automaattisiirto, herata, herata-pois ja jono) ja uusi.mjs (T-81) jakavat; varattu lukko = 429 kuten vanhassa :340-354.
// Sovitus: aja, juuri, tila, loki ja kello tulevat ymp:stä (palvelin.mjs).
//   ymp.istunnotDir, projektitDir, agyHakemisto, brainHakemisto   valinnaiset (kuten istunto.mjs)
//   ymp.paikalliset() → [{ nimi, kuvaus, tyyppi }]   valinnainen: purkajalistan palvelimen LM Studio -mallit (vanhassa
//                       viestit.agentit()); oletus tyhjä lista, kunnes agentit-reitti kytketään tähän
//   ymp.nebiusTiedosto  valinnainen Nebius-avaintiedosto (oletus purkajat.mjs:n ~/.config/scopes/nebius-avain)
//   ymp.alusta          valinnainen (testit): process.platform; Mac-agy-purku kopioi purkutiedoston scp:llä Macille, kun alusta ei ole darwin
// /exit kirjoitetaan vain skoopin omiin, pakattuihin ja vapaisiin (idle) istuntoihin, joilla on tmux-ruutu, ja vain kun ruudun
// pane_pid on istunnon claude tai sen vanhempi (tarkistaRuutu). Pakkaamaton istunto, pakkaamaton agy-ruutu tai varattu pakattu
// istunto estää purun (409) ennen yhtään näppäilyä.
// Tuonnit vain ./aja.mjs, ./runko.mjs, ../vanhasta/* ja node:-moduulit (gate.sh tuontitarkistus).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agyRuudut } from '../vanhasta/agy-istunto.mjs';
import { istunnotAsync, lueSkoopit } from '../vanhasta/lahteet.mjs';
import { luoPurkajat } from '../vanhasta/purkajat.mjs';
import { AGY_MALLI, Hylatty, MAC_AGY_MALLI, istuntoOsoite, mallitonSlug, paikallinenTmux, yksiToiminto } from './aja.mjs';
import { lueRunko, vastaa } from './runko.mjs';

// Purkajalista tilahakemistoa ja juurta kohden: agy-mallien välimuisti (10 min) säilyy pyyntöjen yli kuten vanhassa yhdessä
// luoPurkajat-oliossa. Pyynnöittäin luotu ymp päivittyy tilaan, jotta haku käyttää tuoreinta ajajaa.
const PURKAJAT = new Map();
export function purkajat(ymp) {
  const avain = `${ymp.tila ?? join(homedir(), '.local/state/scopes2')}\n${ymp.juuri}\n${ymp.nebiusTiedosto ?? ''}`;
  let t = PURKAJAT.get(avain);
  if (t) { t.ymp = ymp; return t.purkajat; }
  t = { ymp };
  t.purkajat = luoPurkajat({
    juuri: ymp.juuri,
    paikalliset: async () => (t.ymp.paikalliset ? t.ymp.paikalliset() : []),
    aja: (komento, argv, valinnat) => t.ymp.aja(komento, argv, valinnat),
    nyt: () => (t.ymp.kello ?? Date.now)(),
    nebiusTiedosto: ymp.nebiusTiedosto,
  });
  PURKAJAT.set(avain, t);
  return t.purkajat;
}

// Purkutoiminnot yhdelle pyynnölle (vanhan luoToiminnot-sulkeuman osat).
function purkaja(ymp) {
  const aja = (komento, argv, valinnat) => ymp.aja(komento, argv, valinnat);
  const autovaihto = join(ymp.juuri, 'claude/siirto/tools/autovaihto.sh');
  const malliton = join(ymp.juuri, 'claude/siirto/tools/pura-malliton.mjs');
  const alusta = ymp.alusta ?? process.platform;
  const asetukset = {
    juuri: ymp.juuri,
    istunnotDir: ymp.istunnotDir ?? process.env.CLAUDE_ISTUNNOT_DIR ?? join(homedir(), '.claude/sessions'),
    projektitDir: ymp.projektitDir ?? process.env.CLAUDE_PROJEKTIT_DIR ?? join(homedir(), '.claude/projects'),
    agyHakemisto: ymp.agyHakemisto,
    brainHakemisto: ymp.brainHakemisto,
  };

// kopio: scopes/palvelu/toiminnot.mjs:120-121 (21.10.2026); sovitus: asynkroninen kuten istunto.mjs (istunnotAsync)
  const skoopinIstunnot = async (nimi, skoopit) =>
    (await istunnotAsync({ ...asetukset, aja, skooppiNimet: Object.keys(skoopit) })).filter((i) => i.skooppi === nimi);

// kopio: scopes/palvelu/toiminnot.mjs:123-146 (21.10.2026)
  // Ruudun prosessin on oltava istunnon claude tai sen vanhempi, ettei näppäily osu väärään ruutuun.
  async function tarkistaRuutu(i) {
    const r = await aja('tmux', ['display-message', '-p', '-t', i.ruutu, '#{pane_pid}']);
    const ruudunPid = Number(r.stdout.trim());
    if (r.koodi !== 0 || !(ruudunPid === i.pid || ruudunPid === i.vanhempi)) throw new Hylatty(409, 'istunnon tmux-ruutu ei täsmää');
  }
  async function kirjoita(i, teksti) {
    for (const a of [['-l', teksti], ['Enter']]) {
      const t = await aja('tmux', ['send-keys', '-t', i.ruutu, ...a]);
      if (t.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
    }
  }

  async function avaaIstunto(skooppi, viesti, malli = null) {
    // viesti null = autovaihto.sh kirjoittaa purkutiedoston itse (agy-uusi skooppi).
    const t = await aja('bash', [autovaihto, 'vaihda', skooppi, '--ei-sulje', ...(malli ? ['--model', malli] : []), ...(viesti ? ['--viesti', viesti] : [])]);
    const osoite = istuntoOsoite(t.stdout);
    const tmux = paikallinenTmux(t.stdout);
    if (t.koodi !== 0 || !(osoite || tmux)) {
      const syy = (t.stderr.trim().split('\n').filter(Boolean).pop() ?? `autovaihto exit ${t.koodi}`).slice(0, 300);
      throw new Hylatty(502, `istunto ei käynnistynyt: ${syy}`);
    }
    return osoite ? { osoite } : { tmux };
  }

// kopio: scopes/palvelu/toiminnot.mjs:238-254 (21.10.2026); sovitus: process.platform = alusta (ymp.alusta, testit)
  // Mallivapaa purku (PURA-MALLITON T6b): purkutiedosto kirjoitetaan ennen kuin mitään suljetaan, joten skriptin virhe ei
  // jätä skooppia ilman istuntoa eikä vaihdu mallireittiin. Suljettavat pois tiedoston ISTUNNOT-riviltä (PURASCRIPT-ISTUNNOT).
  async function puraMallitta(nimi, suljettavat, malli) {
    const r = await aja('node', [malliton, nimi, '--kohde', (malli?.startsWith(AGY_MALLI) || malli?.startsWith(MAC_AGY_MALLI)) ? 'neutraali' : 'claude', ...(suljettavat.length ? ['--suljettavat', suljettavat.map((i) => i.id).join(',')] : [])]);
    if (r.koodi !== 0 && r.koodi !== 4) {
      throw new Hylatty(500, (r.stderr.trim().split('\n').filter(Boolean).pop() ?? `pura-malliton exit ${r.koodi}`).slice(0, 300));
    }
    const tiedosto = join(homedir(), '.local/state/pura', `${mallitonSlug(nimi)}.md`);
    if (malli?.startsWith(MAC_AGY_MALLI) && alusta !== 'darwin') {
      const json = join(homedir(), '.local/state/pura', `${mallitonSlug(nimi)}.json`);
      await aja('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', tiedosto, json, 'mac:~/.local/state/pura/']).catch(() => {});
    }
    const viestiTiedosto = malli?.startsWith(MAC_AGY_MALLI) ? `~/.local/state/pura/${mallitonSlug(nimi)}.md` : tiedosto;
    for (const i of suljettavat) { await tarkistaRuutu(i); await kirjoita(i, '/exit'); }
    const tulos = await avaaIstunto(nimi, `Malliton purku: lue ${viestiTiedosto} ja noudata sitä.`, malli);
    return { ...tulos, suljettiin: suljettavat.map((i) => i.id), tiedosto: viestiTiedosto, ...(malli ? { malli } : {}), ...(r.koodi === 4 ? { varoitus: true } : {}) };
  }

// kopio: scopes/palvelu/toiminnot.mjs:275-300 (21.10.2026); sovitus: toteutus.pura-metodi funktioksi, juuri ymp:stä, skoopinIstunnot odotetaan
  // valinta = purkajat.mjs:n tarkistama { ajaja, malli } (SCOPES-PURA-MALLI); ajaja kulkee /pura-lippuna aja-siirtaja.sh:lle.
  async function pura(nimi, { ajaja = null, malli = null } = {}) {
    const skoopit = lueSkoopit(ymp.juuri);
    if (!Object.hasOwn(skoopit, nimi)) throw new Hylatty(404, 'tuntematon skooppi');
    const omat = await skoopinIstunnot(nimi, skoopit);
    if (omat.some((i) => !i.pakattu)) throw new Hylatty(409, 'skoopissa on jo käynnissä oleva istunto');
    const agyTmux = await agyRuudut(aja, nimi);
    if (agyTmux.some((r) => !omat.some((i) => i.ruutu === r.ruutu && i.pakattu))) {
      throw new Hylatty(409, 'skoopissa on jo käynnissä oleva agy-istunto');
    }
    // Pakattu istunto suljetaan ennen uutta (käyttäjä 13.10.2026): äpissä skoopin keskustelu jatkuu samassa
    // näkymässä uudella istunnolla. Remote Control -istuntoa ilman ruutua ei voi sulkea; se jää piiloon.
    // Varattu estää myös ilman ruutua (SIIRTO-PURA-PAINIKE 14.10.2026): puhelimesta avattu istunto voi olla pakattu,
    // mutta yhä autovaihdossa, ja uusi istunto ei ehkä vielä näy skoopissa; Pura avaisi silloin toisen istunnon.
    const suljettavat = omat.filter((i) => i.ruutu);
    const varattu = omat.find((i) => i.tila !== 'idle');
    if (varattu) throw new Hylatty(409, `pakattu istunto on vielä varattu (${varattu.tila ?? 'tila tuntematon'}); yritä vuoron jälkeen`);
    // Perhetunnistus on yksi kaikille reiteille (T6): 0 = scopes-perhe, 1 = ei; muu exit ei saa pudottaa perhettä mallireittiin.
    const p = await aja('node', [malliton, '--perhe', nimi]);
    if (p.koodi === 0) return puraMallitta(nimi, suljettavat, malli);
    if ((malli?.startsWith(AGY_MALLI) || malli?.startsWith(MAC_AGY_MALLI)) && p.koodi === 1) throw new Hylatty(400, 'agy-istunto kuuluu vain scopes-perheen skoopeille');
    if (p.koodi !== 1) throw new Hylatty(500, (p.stderr.trim().split('\n').filter(Boolean).pop() ?? `pura-malliton --perhe exit ${p.koodi}`).slice(0, 300));
    for (const i of suljettavat) { await tarkistaRuutu(i); await kirjoita(i, '/exit'); }
    const tulos = await avaaIstunto(nimi, `/pura ${nimi}${ajaja ? ` --ajaja=${ajaja}` : ''}`, malli);
    return { ...tulos, suljettiin: suljettavat.map((i) => i.id), ...(ajaja ? { purkaja: ajaja } : {}), ...(malli ? { malli } : {}) };
  }

  return { pura };
}

// Reitit. Virheet (Hylatty) muuttuvat statukseksi palvelin.mjs:ssä.
// kopio: scopes/palvelu/palvelin.mjs:272-274 ja :297 (21.10.2026); sovitus: suorita('pura', …) = yhteinen yksiToiminto
export const REITIT = [
  { metodi: 'POST', kuvio: '/api/skoopit/*/pura', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    // Purun valinnat (SCOPES-PURA-MALLI): runko {purkaja?, malli?} tarkistetaan purkajat.mjs:n listaa vasten; tyhjä = oletus.
    const valinta = await purkajat(ymp).tarkista(await lueRunko(req));
    vastaa(res, 200, await yksiToiminto(ymp, 'pura', osat[0], () => purkaja(ymp).pura(osat[0], valinta)));
  } },
  { metodi: 'GET', kuvio: '/api/purkajat', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    req.resume();
    vastaa(res, 200, await purkajat(ymp).lista());
  } },
];
