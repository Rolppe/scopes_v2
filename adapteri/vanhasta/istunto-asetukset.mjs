// kopio: scopes/palvelu/istunto-asetukset.mjs @ 76760840 (21.10.2026); muuttuneet vain import-rivit
// Skoopin keskustelukohtaisten kytkimien istunnon valinta (scopes infra setting 16.10.2026). Kytkimet kuuluvat
// keskustelulle, ei skoopille: yksi avoin (pakkaamaton) istunto valitaan itsestään, useasta valitaan `?istunto=<tunnus>`.
// Tmux-ruutua ei vaadita, koska kirjoitus on vain tilatiedosto. Ei istuntoa → tunnus null (lukeminen näyttää yhteisen oletuksen).

import { istunnot, lueSkoopit } from './lahteet.mjs';
import { Hylatty } from '../toiminnot/aja.mjs';

export function luoIstuntoValinta(asetukset) {
  const haku = asetukset.istunnotHaku ?? istunnot;
  return function valitse(nimi, haluttu = null) {
    const skoopit = lueSkoopit(asetukset.juuri);
    if (!Object.hasOwn(skoopit, nimi)) throw new Hylatty(404, 'tuntematon skooppi');
    const avoimet = haku({ ...asetukset, skooppiNimet: Object.keys(skoopit) }).filter((i) => i.skooppi === nimi && !i.pakattu);
    if (haluttu) {
      const i = avoimet.find((x) => x.id === haluttu);
      if (!i) throw new Hylatty(404, 'istuntoa ei löydy tästä skoopista');
      return { istunto: i.id, istuntoja: avoimet.length };
    }
    return { istunto: avoimet.length === 1 ? avoimet[0].id : null, istuntoja: avoimet.length };
  };
}
