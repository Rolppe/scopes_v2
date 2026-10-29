// Uusi skooppi (T-81, ARK-16, S-10): POST /api/uusi {nimi, purkaja?, malli?}. Käytös = vanhan 8787:n (scopes/palvelu/toiminnot.mjs
// uusi :307-314, uusiAgy :256-272, avaaIstunto :136-146 ja palvelin.mjs:227), kopioitu kopioriveineen. Yksi toiminto kerrallaan:
// aja.mjs:n yhteinen toimintolukko (yksiToiminto), jonka pura.mjs ja istunto.mjs jakavat; varattu lukko = 429.
// Sovitus: aja, juuri, tila, loki ja kello tulevat ymp:stä (palvelin.mjs).
// Tuonnit vain ./aja.mjs, ./runko.mjs, ./pura.mjs, ../vanhasta/* ja node:-moduulit (gate.sh tuontitarkistus).
import { join } from 'node:path';
import { lueSkoopit } from '../vanhasta/lahteet.mjs';
import { AGY_MALLI, Hylatty, MAC_AGY_MALLI, UUSI_NIMI, istuntoOsoite, paikallinenTmux, yksiToiminto } from './aja.mjs';
import { purkajat } from './pura.mjs';
import { lueRunko, vastaa } from './runko.mjs';

// Uuden skoopin toiminnot yhdelle pyynnölle (vanhan luoToiminnot-sulkeuman osat).
function uusija(ymp) {
  const aja = (komento, argv, valinnat) => ymp.aja(komento, argv, valinnat);
  const autovaihto = join(ymp.juuri, 'claude/siirto/tools/autovaihto.sh');

// kopio: scopes/palvelu/toiminnot.mjs:136-146 (21.10.2026); sama kuin pura.mjs:n avaaIstunto
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

// kopio: scopes/palvelu/toiminnot.mjs:256-272 (21.10.2026); sovitus: asetukset.juuri = ymp.juuri
  // Uusi skooppi agy-istunnolla (AGY-PRE-ISTUNTO): /pura uusi on Clauden taito, joten vaiheet 0 (luonti, asennus, commit) tehdään
  // tässä samoin kuin taito ne tekisi, ja autovaihto.sh avaa agy-istunnon neutraalilla purkutiedostolla. Vain scopes-perhe.
  async function uusiAgy(nimi, malli) {
    if (!nimi.startsWith('scopes ')) throw new Hylatty(400, 'agy-istunto kuuluu vain scopes-perheen skoopeille: nimi alkaa sanalla scopes');
    const luonti = await aja('node', [join(ymp.juuri, 'claude/siirto/tools/luo-skooppi.mjs'), nimi], { cwd: ymp.juuri });
    if (luonti.koodi !== 0 && luonti.koodi !== 4) {
      throw new Hylatty(500, (luonti.stderr.trim().split('\n').filter(Boolean).pop() ?? `luo-skooppi exit ${luonti.koodi}`).slice(0, 300));
    }
    const polut = [...luonti.stdout.matchAll(/^KIRJOITETTU: (.+)$/gm)].map((m) => m[1]);
    const asennus = await aja('bash', [join(ymp.juuri, 'Infra/skills/install.sh')], { cwd: ymp.juuri });
    const git = (...a) => aja('git', a, { cwd: ymp.juuri });
    const lisays = await git('add', '--', ...polut);
    const commit = lisays.koodi === 0 ? await git('commit', '-q', '-m', `feat(siirto): uusi skooppi ${nimi} (Scopes-äppi)`, '--', ...polut) : lisays;
    if (commit.koodi !== 0) throw new Hylatty(500, `skooppi luotu, mutta commit epäonnistui: ${(commit.stderr.trim() || commit.stdout.trim()).slice(0, 240)}`);
    const tulos = await avaaIstunto(nimi, null, malli);
    return { ...tulos, malli, luotu: polut, ...(asennus.koodi !== 0 ? { varoitus: true } : {}), ...(luonti.koodi === 4 ? { varoitus: true } : {}) };
  }

// kopio: scopes/palvelu/toiminnot.mjs:305-314 (21.10.2026)
  // Uusi skooppi saa samat valinnat kuin pura (SCOPES-LISTA-UUSI-VALINNAT 15.10.2026): /pura-taito siirtää --ajaja-lipun
  // luonnin ohi purkuvaiheeseen.
  async function uusi(nimi, { ajaja = null, malli = null } = {}) {
    if (typeof nimi !== 'string' || !UUSI_NIMI.test(nimi)) throw new Hylatty(400, 'nimi: 1–4 sanaa pienaakkosia, numeroita tai viivoja');
    const skoopit = lueSkoopit(ymp.juuri);
    if (skoopit[nimi]) throw new Hylatty(409, 'skooppi on jo olemassa');
    if (malli?.startsWith(AGY_MALLI) || malli?.startsWith(MAC_AGY_MALLI)) return uusiAgy(nimi, malli);
    const tulos = await avaaIstunto(nimi, `/pura uusi ${nimi}${ajaja ? ` --ajaja=${ajaja}` : ''}`, malli);
    return { ...tulos, ...(ajaja ? { purkaja: ajaja } : {}), ...(malli ? { malli } : {}) };
  }

  return { uusi };
}

// Reitit. Virheet (Hylatty) muuttuvat statukseksi palvelin.mjs:ssä.
// kopio: scopes/palvelu/palvelin.mjs:227 (21.10.2026); sovitus: suorita('uusi', …) = yhteinen yksiToiminto
export const REITIT = [
  { metodi: 'POST', kuvio: '/api/uusi', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    const runko = await lueRunko(req);
    // Valinnat (SCOPES-PURA-MALLI): runko {purkaja?, malli?} tarkistetaan purkajat.mjs:n listaa vasten; tyhjä = oletus.
    const valinta = await purkajat(ymp).tarkista(runko);
    vastaa(res, 200, await yksiToiminto(ymp, 'uusi', runko.nimi, () => uusija(ymp).uusi(runko.nimi, valinta)));
  } },
];
