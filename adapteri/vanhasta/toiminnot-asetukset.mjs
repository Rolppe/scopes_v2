// kopio: scopes/palvelu/toiminnot-asetukset.mjs @ 47b8ccaf (28.10.2026); muuttuneet import-rivit ja T-104:n tietoinen ero (toiminnot-asetukset.mjs.ero)
// Globaalit pakkauskytkimet puhelimesta (käyttäjä 14.10.2026): Automaattijatko ja Autopack. Kumpikin on yksi
// tilatiedosto (`true`/`false`), jonka pakkaus- ja purkutaidot lukevat; kytkimet koskevat kaikkia skooppeja eivätkä
// riipu avoimesta istunnosta. Turvamalli kuten toiminnot.mjs:ssä ("vain valmiit toiminnot"): vain kaksi kiinteää
// nimeä, joilla kummallakin kiinteä tiedostonimi, ja arvo on vain boolean; puhelimelta ei tule polkua eikä tekstiä.
// Puuttuva tai lukukelvoton tiedosto tarkoittaa pois päältä.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hylatty } from '../toiminnot/aja.mjs';
import { aseta as asetaIstuntoon, kelvollinenTunnus, lueKaikki as lueIstunnolle } from '../../../claude/siirto/tools/asetus-tila.mjs';

export const OLETUS_HAKEMISTO = join(homedir(), '.claude/skills/keskustelun-siirto/state');

// Julkinen nimi → kiinteä tiedostonimi.
export const ASETUKSET = Object.freeze({
  automaattijatko: 'automaattivalinta.txt',
  autopack: 'autopack.txt',
  automaattisiirto: 'automaattisiirto.txt',
  // Agy-istuntojen lupakyselyihin vastaaminen (agy-luvat.mjs); globaali, ei keskustelukohtainen.
  agyluvat: 'agy-luvat.txt',
});

export function luoAsetukset({ hakemisto = OLETUS_HAKEMISTO, loki = null } = {}) {
  const kirjaa = (rivi) => {
    if (!loki) return;
    try { mkdirSync(dirname(loki), { recursive: true }); appendFileSync(loki, JSON.stringify({ aika: new Date().toISOString(), ...rivi }) + '\n'); } catch { /* loki ei estä toimintoa */ }
  };

  // Vain täsmälleen `true` (rivinvaihtoa ja välilyöntejä lukuun ottamatta) on päällä.
  const lueYksi = (nimi) => {
    try { return readFileSync(join(hakemisto, ASETUKSET[nimi]), 'utf8').trim() === 'true'; } catch { return false; }
  };

  const lue = () => Object.fromEntries(Object.keys(ASETUKSET).map((n) => [n, lueYksi(n)]));

  // Kirjoitus väliaikaiseen ja nimeäminen, ettei lukija näe keskeneräistä tiedostoa.
  function aseta(nimi, arvo) {
    try {
      if (typeof nimi !== 'string' || !Object.hasOwn(ASETUKSET, nimi)) throw new Hylatty(404, 'tuntematon asetus');
      if (typeof arvo !== 'boolean') throw new Hylatty(400, 'arvo: vain päällä tai pois');
      const tiedosto = join(hakemisto, ASETUKSET[nimi]);
      try {
        mkdirSync(hakemisto, { recursive: true });
        writeFileSync(`${tiedosto}.tmp`, arvo ? 'true\n' : 'false\n');
        renameSync(`${tiedosto}.tmp`, tiedosto);
      } catch { throw new Hylatty(500, 'asetuksen tallennus epäonnistui'); }
      kirjaa({ toiminto: 'asetus', nimi, arvo, tulos: 'ok' });
      return lue();
    } catch (e) {
      kirjaa({ toiminto: 'asetus', nimi: String(nimi).slice(0, 40), tulos: 'hylätty', syy: e.message });
      throw e;
    }
  }

  // Keskustelukohtaiset arvot (scopes infra setting 16.10.2026): sama tallennus kuin pakkaus- ja purkutyökaluilla
  // (claude/siirto/tools/asetus-tila.mjs), avaimena istunnon tunnus; istunto ilman omaa arvoa näyttää yhteisen oletuksen.
  const lueIstunto = (tunnus) => lueIstunnolle(tunnus, hakemisto);

  function asetaIstunto(nimi, tunnus, arvo) {
    try {
      if (typeof nimi !== 'string' || !Object.hasOwn(ASETUKSET, nimi) || nimi === 'agyluvat') throw new Hylatty(404, 'tuntematon asetus');
      if (typeof arvo !== 'boolean') throw new Hylatty(400, 'arvo: vain päällä tai pois');
      if (!kelvollinenTunnus(tunnus)) throw new Hylatty(409, 'istunnon tunnus puuttuu');
      try { asetaIstuntoon(nimi, tunnus, arvo, hakemisto); } catch { throw new Hylatty(500, 'asetuksen tallennus epäonnistui'); }
      kirjaa({ toiminto: 'asetus-istunto', nimi, istunto: tunnus, arvo, tulos: 'ok' });
      return lueIstunto(tunnus);
    } catch (e) {
      kirjaa({ toiminto: 'asetus-istunto', nimi: String(nimi).slice(0, 40), tulos: 'hylätty', syy: e.message });
      throw e;
    }
  }

  return { lue, aseta, lueIstunto, asetaIstunto };
}
