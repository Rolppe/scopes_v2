// Adapterin toimintakuuntelija (S-10, T-63-G): 127.0.0.1:<portti>, Bearer = V2-avain, reitit moduulien REITIT-taulukoista.
//   GET /api/terveys (ilman avainta) → {"ok":true,"adapteri":true,"reitit":[…toteutetut…]}
//   väärä avain 401, toteuttamaton (ARK-16- tai lisä-)reitti 501 {"virhe":"ei siirretty"}, muu polku 404 {"virhe":"tuntematon polku"}.
//   Moduulin valinnainen koukku kaynnista(ymp) → { pysayta() } (taustasilmukat): kutsutaan kuuntele():n alussa, pysayta sulje():ssa.
import { timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Hylatty, ajaKomento } from './aja.mjs';
import { KAIKKI, KOUKUT, etsi, toteutetut } from './reitit.mjs';
import { vastaa } from './runko.mjs';

const kotiin = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);

// Vakioaikainen vertailu, ettei vastausaika paljasta avaimen alkua (kuten vanha palvelin.mjs).
export function avainKelpaa(otsake, avain) {
  const annettu = Buffer.from(/^Bearer (.+)$/.exec(otsake ?? '')?.[1] ?? '');
  const oikea = Buffer.from(avain);
  return annettu.length === oikea.length && timingSafeEqual(annettu, oikea);
}

export function luoToimintopalvelin({
  portti,
  osoite = '127.0.0.1',
  reitit = KAIKKI,
  koukut = KOUKUT,
  avainTiedosto = '~/.config/scopes2/avain',
  juuri,
  tila = join(homedir(), '.local/state/scopes2'),
  aja = ajaKomento,
  kello = Date.now,
  loki = (rivi) => {
    try { mkdirSync(tila, { recursive: true }); appendFileSync(join(tila, 'toiminnot.loki'), `${JSON.stringify({ aika: new Date(kello()).toISOString(), ...rivi })}\n`); } catch { /* loki ei estä vastausta */ }
  },
} = {}) {
  const ymp = { aja, juuri, tila, loki, kello };
  // Luetaan joka pyynnöllä: avaimen vaihto ei vaadi uudelleenkäynnistystä. Alle 32 merkin avain = ei yhtään kelpaavaa (kuten vanha).
  const lueAvain = () => { try { const a = readFileSync(kotiin(avainTiedosto), 'utf8').trim(); return a.length >= 32 ? a : ''; } catch { return ''; } };

  const kasittelija = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'POST') return vastaa(res, 405, { virhe: 'vain GET ja POST' });
      const polku = new URL(req.url, 'http://x').pathname;
      if (req.method === 'GET' && polku === '/api/terveys') return vastaa(res, 200, { ok: true, adapteri: true, reitit: toteutetut(reitit) });
      const avain = lueAvain();
      if (!avain || !avainKelpaa(req.headers.authorization, avain)) return vastaa(res, 401, { virhe: 'avain puuttuu tai väärä' });
      let osuma;
      try { osuma = etsi(reitit, req.method, polku); } catch (e) { return vastaa(res, 500, { virhe: e.message }); } // T-111: rikkinäinen %-koodaus = vanha (decodeURIComponent → yleinen catch): 500 {virhe:'URI malformed'}
      if (!osuma) return vastaa(res, 404, { virhe: 'tuntematon polku' });
      if (!osuma.reitti.toteutettu) { req.resume(); return vastaa(res, 501, { virhe: 'ei siirretty' }); }
      await osuma.reitti.kasittele(req, res, osuma.osat, ymp);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      vastaa(res, e instanceof Hylatty ? e.koodi : 500, { virhe: e.message });
    }
  };

  const palvelin = createServer(kasittelija);
  // Moduulikoukut (T-79-G): kaynnista(ymp) → { pysayta() } kutsutaan kuuntelun alussa, pysayta suljettaessa (käänteisessä järjestyksessä).
  let kaynnissa = [];
  const pysayta = async () => {
    const lista = kaynnissa.reverse();
    kaynnissa = [];
    for (const k of lista) { try { await k?.pysayta?.(); } catch { /* yhden koukun pysäytys ei estä muita */ } }
  };
  return {
    palvelin,
    kuuntele: async () => {
      try { for (const { kaynnista } of koukut) kaynnissa.push(await kaynnista(ymp)); } catch (e) { await pysayta(); throw e; }
      try {
        return await new Promise((ok, ei) => {
          palvelin.once('error', ei);
          palvelin.listen(portti, osoite, () => { palvelin.off('error', ei); ok(palvelin.address().port); });
        });
      } catch (e) { await pysayta(); throw e; }
    },
    sulje: async () => {
      await new Promise((ok) => { palvelin.closeAllConnections?.(); palvelin.close(() => ok()); });
      await pysayta();
    },
  };
}
