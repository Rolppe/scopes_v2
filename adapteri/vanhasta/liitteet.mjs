// kopio: scopes/palvelu/liitteet.mjs @ 6338a63f (21.10.2026); muuttuneet vain import-rivit
// Liitteet skoopin viesteihin (CHAT-MEDIA-SKOOPPI 14.10.2026): äppi lähettää tiedoston raakarunkona,
// palvelu tallentaa sen ja palauttaa polun, jonka äppi lisää viestiin. Skoopin istunto ajaa samalla koneella
// ja lukee liitteen Read-työkalulla, joten viestireitti (lahetaSkooppiin) pysyy pelkkänä tekstinä.
//
//   POST /api/skoopit/<nimi>/liite?nimi=<tiedostonimi>   runko = tiedoston tavut → { polku, koko }
//
// Tallennus: <liitteetDir>/<skooppi>/<aika>-<satunnainen>-<nimi>. Skoopin ja tiedoston nimi siistitään
// polkuturvallisiksi, joten kumpikaan ei pääse hakemiston ulkopuolelle.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hylatty } from '../toiminnot/aja.mjs';

export const LIITTEEN_MAKSIMI = 25 * 1024 * 1024;

// Kirjaimet (myös ääkköset), numerot, piste, alaviiva ja viiva säilyvät; muu korvataan viivalla.
export function siistiNimi(nimi, oletus) {
  const s = String(nimi ?? '').normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+/, '').slice(-100);
  return s || oletus;
}

function lueRunko(req, raja) {
  return new Promise((ok, ei) => {
    const palat = [];
    let koko = 0;
    // Ylisuuri runko luetaan loppuun talteen ottamatta, jotta 413-vastaus ehtii perille.
    req.on('data', (pala) => { koko += pala.length; if (koko <= raja) palat.push(pala); });
    req.on('end', () => (koko > raja ? ei(new Hylatty(413, 'liite liian suuri')) : ok(Buffer.concat(palat))));
    req.on('error', ei);
  });
}

export function luoLiitteet(asetukset, { nyt = () => new Date(), raja = LIITTEEN_MAKSIMI } = {}) {
  return async function tallenna(skooppi, tiedostonimi, req) {
    const data = await lueRunko(req, raja);
    if (data.length === 0) throw new Hylatty(400, 'liite on tyhjä');
    const hakemisto = join(asetukset.liitteetDir, siistiNimi(skooppi, 'skooppi'));
    mkdirSync(hakemisto, { recursive: true });
    const aika = nyt().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const polku = join(hakemisto, `${aika}-${randomBytes(3).toString('hex')}-${siistiNimi(tiedostonimi, 'liite')}`);
    writeFileSync(polku, data, { flag: 'wx' });
    return { polku, koko: data.length };
  };
}
