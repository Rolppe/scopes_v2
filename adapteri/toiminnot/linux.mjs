// palvelimen tila, käynnistys ja sammutus (T-86, ARK-19, S-10): GET /api/palvelin ja POST /api/palvelin/<kaynnista|sammuta>.
// Käytös = vanhan 8787:n (scopes/palvelu/palvelin.mjs = vanhasta/palvelin.mjs, palvelin.mjs:220-221 ja :298), kopioitu.
// Sovitus: aja, juuri ja tila tulevat ymp:stä (palvelin.mjs); herata-pc.py ratkaistaan ymp.juuri:sta, koska kopion HERATA-polku
// lasketaan import.meta.url:sta ja kopio on eri syvyydellä.
//   SCOPES2_LINUX_KUIVA=1 (tai ymp.linuxKuiva, testit)   kuiva: tila luetaan, mutta herätys-, kertaboot- ja sammutuskomentoa ei ajeta
// Linux-toiminnoilla on oma lukkonsa (kuten vanhassa luoLinuxServerissä: 429 "<toiminto> on jo käynnissä"), eri kuin aja.mjs:n yhteinen
// toimintolukko. Tuonnit vain ./aja.mjs, ./runko.mjs, ../vanhasta/* ja node:-moduulit (gate.sh tuontitarkistus).
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HERATA, luoLinuxServer } from '../vanhasta/palvelin.mjs';
import { vastaa } from './runko.mjs';

// Yksi olio tilahakemistoa ja juurta kohden: `kaynnissa`-lukko säilyy pyyntöjen yli kuten vanhassa yhdessä luoLinuxServer-oliossa.
const OLIOT = new Map();
export function linuxServer(ymp) {
  const tila = ymp.tila ?? join(homedir(), '.local/state/scopes2');
  const kuiva = ymp.linuxKuiva ?? process.env.SCOPES2_LINUX_KUIVA === '1';
  const avain = `${tila}\n${ymp.juuri}\n${kuiva}`;
  let t = OLIOT.get(avain);
  if (t) { t.ymp = ymp; return t.olio; }
  t = { ymp };
  const herata = join(ymp.juuri, 'Infra/linux/palvelin/herata-pc.py');
  const vanha = luoLinuxServer({
    aja: (komento, argv, valinnat) => t.ymp.aja(komento, komento === 'python3' && argv[0] === HERATA ? [herata, ...argv.slice(1)] : argv, valinnat),
    loki: null,
    kuiva,
  });
  const loki = join(tila, 'toiminnot.loki');
  const kirjaa = (rivi) => {
    try { mkdirSync(dirname(loki), { recursive: true }); appendFileSync(loki, JSON.stringify({ aika: new Date().toISOString(), ...rivi }) + '\n'); } catch { /* loki ei estä toimintoa */ }
  };
  // Kuivatilan `kuiva`-teksti kootaan kopion KOMENNOT:sta ilman ajaa, joten siihen korjataan sama herata-pc.py-polku.
  t.olio = {
    tila: vanha.tila,
    suorita: async (toiminto) => {
      let tulos;
      try {
        tulos = await vanha.suorita(toiminto);
      } catch (e) {
        kirjaa({ toiminto: `palvelin ${String(toiminto).slice(0, 40)}`, tulos: 'hylätty', syy: e.message });
        throw e;
      }
      const korjattu = typeof tulos.kuiva === 'string' ? { ...tulos, kuiva: tulos.kuiva.replace(HERATA, herata) } : tulos;
      kirjaa({ toiminto: `palvelin ${toiminto}`, tulos: 'ok', ...korjattu });
      return korjattu;
    },
  };
  OLIOT.set(avain, t);
  return t.olio;
}

// Reitit. Virheet (Hylatty) muuttuvat statukseksi palvelin.mjs:ssä.
// kopio: scopes/palvelu/palvelin.mjs:220-221 ja :298 (21.10.2026); tuntematon toiminto → vanhan 404-runko (suorita)
export const REITIT = [
  { metodi: 'GET', kuvio: '/api/palvelin', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    req.resume();
    vastaa(res, 200, await linuxServer(ymp).tila());
  } },
  { metodi: 'POST', kuvio: '/api/palvelin/*', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    req.resume();
    vastaa(res, 200, await linuxServer(ymp).suorita(osat[0]));
  } },
];
