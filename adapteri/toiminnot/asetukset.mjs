// Pakkauskytkimet (T-83, ARK-16:n loput, S-10): yhteiset ja istuntokohtaiset kytkimet sekä agy-luvat-taustasilmukka.
// Käytös = vanhan 8787:n (scopes/palvelu/palvelin.mjs:206-218 ja :284-290, :365-370): tallennus tiedostoihin
// toiminnot-asetukset.mjs:n (vanhasta/) kautta, istunnon valinta istunto-asetukset.mjs:n (vanhasta/) kautta.
// GET /api/asetukset ja GET /api/skoopit/*/asetukset eivät ole adapterin reittejä: ydin vastaa niihin lähdetilan
// laji-asetukset-peilistä (lahde.mjs, S-5b; T-84).
//   POST /api/asetukset/<nimi>/<paalle|pois>
//   POST /api/skoopit/<n>/asetukset/<nimi>/<paalle|pois>[?istunto=<tunnus>]   (409 ilman istuntoa ja usealla istunnolla)
// Sovitus: aja, loki, juuri ja kello tulevat ymp:stä (palvelin.mjs); lisäksi valinnaiset ymp-kentät:
//   ymp.asetusHakemisto   kytkinten tilahakemisto (oletus ~/.claude/skills/keskustelun-siirto/state; testit: koe-hakemisto)
//   ymp.lahdeKierros      () → Promise, adapteri.mjs: lähdekierros heti onnistuneen muutoksen jälkeen (ytimen luku päivittyy
//                         odottamatta 5 s:n väliä); ajetaan ennen vastausta, enintään ymp.lahdeAikaraja ms (oletus 3000)
//   ymp.agyLuvat          lippu --agy-luvat: moduulin kaynnista-koukku käynnistää agy-luvat-silmukan vain, kun tämä on tosi
//   ymp.agyLuvatVali      silmukan kierrosväli ms (oletus 3000)
//   ymp.istunnotDir, projektitDir, agyHakemisto, brainHakemisto   valinnaiset (kuten istunto.mjs)
// Tuonnit vain ./aja.mjs, ./runko.mjs, ../vanhasta/* ja node:-moduulit (gate.sh tuontitarkistus).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { luoAgyLuvat } from '../vanhasta/agy-luvat.mjs';
import { luoIstuntoValinta } from '../vanhasta/istunto-asetukset.mjs';
import { istunnotAsync, lueSkoopit } from '../vanhasta/lahteet.mjs';
import { OLETUS_HAKEMISTO, luoAsetukset } from '../vanhasta/toiminnot-asetukset.mjs';
import { Hylatty } from './aja.mjs';
import { vastaa } from './runko.mjs';

const hakemisto = (ymp) => ymp.asetusHakemisto ?? OLETUS_HAKEMISTO;
const kirjaaYmp = (ymp) => (rivi) => { try { ymp.loki?.(rivi); } catch { /* loki ei estä toimintoa */ } };

// Kytkimet ilman omaa lokia: onnistumis- ja hylkäysrivit kirjataan ymp.loki:in (vanha kirjoitti omaan tiedostoonsa).
const kytkimet = (ymp) => luoAsetukset({ hakemisto: hakemisto(ymp) });

// Muutoksen jälkeen ytimen luku päivitetään heti; hidas tai poissa oleva ydin ei viivytä vastausta yli aikarajan.
async function paivitaPeili(ymp) {
  if (typeof ymp.lahdeKierros !== 'function') return;
  let ajastin;
  try {
    await Promise.race([
      Promise.resolve().then(() => ymp.lahdeKierros()),
      new Promise((ok) => { ajastin = setTimeout(ok, ymp.lahdeAikaraja ?? 3000); }),
    ]);
  } catch { /* peilin päivitys ei kaada onnistunutta muutosta; seuraava kierros korjaa */ } finally { clearTimeout(ajastin); }
}

// Kirjaa kuten vanha (toiminnot-asetukset.mjs:aseta / asetaIstunto): ok-rivi tai hylätty-rivi syyn kanssa.
function kirjattuna(ymp, rivi, nimi, tee) {
  const kirjaa = kirjaaYmp(ymp);
  try {
    const tulos = tee();
    kirjaa({ ...rivi, tulos: 'ok' });
    return tulos;
  } catch (e) {
    kirjaa({ toiminto: rivi.toiminto, nimi: String(nimi).slice(0, 40), tulos: 'hylätty', syy: e.message });
    throw e;
  }
}

const TILA = { paalle: true, pois: false };

// kopio: scopes/palvelu/palvelin.mjs:206-208 (21.10.2026); sovitus: tila ei täsmää → 404 kuten vanhassa (reitti jäi täsmäämättä)
const yhteinen = {
  metodi: 'POST',
  kuvio: '/api/asetukset/*/*',
  toteutettu: true,
  kasittele: async (req, res, osat, ymp) => {
    req.resume();
    const [nimi, tila] = osat;
    if (!Object.hasOwn(TILA, tila)) throw new Hylatty(404, 'tuntematon toiminto');
    const arvo = TILA[tila];
    const tulos = kirjattuna(ymp, { toiminto: 'asetus', nimi, arvo }, nimi, () => kytkimet(ymp).aseta(nimi, arvo));
    await paivitaPeili(ymp);
    vastaa(res, 200, tulos);
  },
};

// Avoimet istunnot asynkronisesti (tmux ja ssh `aja`-funktion kautta), jotta vanha synkroninen valitsin saa valmiin listan.
async function istuntoValinta(ymp, skooppi, haluttu) {
  const asetukset = {
    juuri: ymp.juuri,
    istunnotDir: ymp.istunnotDir ?? process.env.CLAUDE_ISTUNNOT_DIR ?? join(homedir(), '.claude/sessions'),
    projektitDir: ymp.projektitDir ?? process.env.CLAUDE_PROJEKTIT_DIR ?? join(homedir(), '.claude/projects'),
    agyHakemisto: ymp.agyHakemisto,
    brainHakemisto: ymp.brainHakemisto,
  };
  const skoopit = lueSkoopit(ymp.juuri);
  // Tuntematon skooppi vastaa 404:n ennen kuin istuntoja haetaan (vanha: sama järjestys, valitse tarkistaa ensin).
  const lista = Object.hasOwn(skoopit, skooppi) ? await istunnotAsync({ ...asetukset, aja: ymp.aja, skooppiNimet: Object.keys(skoopit) }) : [];
  return luoIstuntoValinta({ ...asetukset, istunnotHaku: () => lista })(skooppi, haluttu);
}

// kopio: scopes/palvelu/palvelin.mjs:214-218 (21.10.2026); sovitus: istuntolista haetaan asynkronisesti ennen valintaa
const istuntokohtainen = {
  metodi: 'POST',
  kuvio: '/api/skoopit/*/asetukset/*/*',
  toteutettu: true,
  kasittele: async (req, res, osat, ymp) => {
    req.resume();
    const [skooppi, nimi, tila] = osat;
    if (!Object.hasOwn(TILA, tila)) throw new Hylatty(404, 'tuntematon toiminto');
    const arvo = TILA[tila];
    const haluttu = new URL(req.url, 'http://x').searchParams.get('istunto');
    const v = await istuntoValinta(ymp, skooppi, haluttu);
    if (!v.istunto) throw new Hylatty(409, v.istuntoja ? 'skoopissa on useita istuntoja; anna ?istunto=<tunnus>' : 'skoopilla ei ole avointa istuntoa');
    const tulos = kirjattuna(ymp, { toiminto: 'asetus-istunto', nimi, istunto: v.istunto, arvo }, nimi, () => kytkimet(ymp).asetaIstunto(nimi, v.istunto, arvo));
    await paivitaPeili(ymp);
    vastaa(res, 200, { ...v, ...tulos });
  },
};

export const REITIT = [yhteinen, istuntokohtainen];

// Moduulikoukku (palvelin.mjs kutsuu kuuntele():n alussa): agy-luvat-silmukka vain lipulla --agy-luvat (ymp.agyLuvat).
// Oletuksena pois: niin kauan kuin vanha 8787 ajaa omaa silmukkaansa, kaksi silmukkaa vastaisi samaan kehotteeseen.
// Silmukka lukee agyluvat-arvon joka kierroksella tiedostosta (kuten vanha, palvelin.mjs:365-370).
export function kaynnista(ymp) {
  if (!ymp.agyLuvat) return { pysayta() {} };
  const luvat = luoAgyLuvat({
    aja: (...a) => ymp.aja(...a),
    paalla: () => luoAsetukset({ hakemisto: hakemisto(ymp) }).lue().agyluvat,
    kirjaa: kirjaaYmp(ymp),
    ...(ymp.agyLuvatVali ? { vali: ymp.agyLuvatVali } : {}),
  });
  luvat.kaynnista();
  return { pysayta() { luvat.pysayta(); }, luvat };
}
