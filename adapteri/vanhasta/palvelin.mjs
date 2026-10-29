// kopio: scopes/palvelu/palvelin.mjs @ e1d1ad03 (21.10.2026); muuttuneet vain import-rivit
// palvelimen käynnistys ja sammutus Infra-sivulta (SCOPES-LINUX-NAPIT 15.10.2026, käyttäjän pyyntö palvelinkatkon
// jälkeen). Turvamalli kuten toiminnot.mjs:ssä ("vain valmiit toiminnot"): kaksi kiinteää toimintoa ilman runkoa, eikä
// puhelimelta tule komentoa, osoitetta tai tekstiä. Kaikki ajetaan execFilellä ilman kuorta ja kirjataan toimintolokiin.
//
// PC on dual boot samassa osoitteessa (.20.10; WiFi-Windows .20.11), joten tila päätellään pingin TTL:stä kuten
// herata-pc.py:ssä (Linux 64, Windows 128) eikä ssh:lla: Windowsin ollessa päällä `ssh palvelin` saa Windowsin
// host keyn ja kaatuu BatchModessa (osa-4-laitteet.md, Sudenkuopat).
//   käynnistä: Linux päällä → ei mitään; Windows → `ssh pc linux` (kertaboot, ~45 s); sammuksissa →
//              herata-pc.py --odota (WoL; GRUBin oletus on Windows, joten Windows vaihdetaan samoin Linuxiin).
//   sammuta:   vain kun Linux vastaa: `ssh palvelin sudo -n /usr/sbin/poweroff` (sudo-listalla 26.9.2026).
//              Windowsia ei sammuteta tästä: nappi koskee palvelinta.
// kuiva (SCOPES_LINUX_KUIVA=1, :8788-koepalvelu ja UI-testit): tila luetaan oikeasti, mutta herätys-, kertaboot- ja
// sammutuskomentoa ei ajeta; vastaus kertoo, mitä olisi ajettu.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ajaKomento, Hylatty } from '../toiminnot/aja.mjs';

const tama = dirname(fileURLToPath(import.meta.url));
export const HERATA = join(tama, '../../Infra/linux/palvelin/herata-pc.py');
export const OSOITTEET = Object.freeze(['192.0.2.99', '192.0.2.99']);
const SSH = ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes'];
export const KOMENNOT = Object.freeze({
  herata: (odota) => ['python3', [HERATA, '--odota', String(odota)]],
  linuxiin: () => ['ssh', [...SSH, 'pc', 'linux']],
  sammuta: () => ['ssh', [...SSH, 'palvelin', 'sudo -n /usr/sbin/poweroff']],
});

// Pingin tuloste → 'linux' | 'windows' | null.
export const jarjestelma = ({ koodi, stdout }) => {
  if (koodi !== 0) return null;
  const ttl = /ttl=(\d+)/i.exec(stdout);
  return ttl && Number(ttl[1]) > 64 ? 'windows' : 'linux';
};

export function luoLinuxServer({ aja = ajaKomento, loki = null, kuiva = false, odota = 90 } = {}) {
  let kaynnissa = null;
  const kirjaa = (rivi) => {
    if (!loki) return;
    try { mkdirSync(dirname(loki), { recursive: true }); appendFileSync(loki, JSON.stringify({ aika: new Date().toISOString(), ...rivi }) + '\n'); } catch { /* loki ei estä toimintoa */ }
  };

  // { tila: 'linux' | 'windows' | 'sammuksissa', osoite? }; ensimmäinen vastaava osoite listan järjestyksessä.
  async function tila() {
    const tulokset = await Promise.all(OSOITTEET.map((ip) => aja('ping', ['-c', '1', '-W', '2', ip], { aikaraja: 5_000 })));
    for (const [i, t] of tulokset.entries()) {
      const j = jarjestelma(t);
      if (j) return { tila: j, osoite: OSOITTEET[i] };
    }
    return { tila: 'sammuksissa' };
  }

  async function ajaKiintea(nimi, aikaraja, ...arg) {
    const [komento, argumentit] = KOMENNOT[nimi](...arg);
    if (kuiva) return { koodi: 0, stdout: '', stderr: '', kuiva: [komento, ...argumentit].join(' ') };
    return aja(komento, argumentit, { aikaraja });
  }

  const virherivi = (t) => (t.stderr || t.stdout).trim().split('\n').pop()?.slice(0, 200) || `paluukoodi ${t.koodi}`;

  async function linuxiin(lahto) {
    const t = await ajaKiintea('linuxiin', 20_000);
    if (t.koodi !== 0) throw new Hylatty(502, `Windowsin vaihto Linuxiin epäonnistui: ${virherivi(t)}`);
    return { tila: 'vaihtaa', lahto, viesti: 'Windows käynnistyy Linuxiin, noin 45 s', ...(t.kuiva && { kuiva: t.kuiva }) };
  }

  async function kaynnista() {
    const alku = await tila();
    if (alku.tila === 'linux') return { tila: 'linux', lahto: 'linux', viesti: 'palvelin on jo päällä' };
    if (alku.tila === 'windows') return linuxiin('windows');
    const t = await ajaKiintea('herata', (odota + 15) * 1000, odota);
    if (t.kuiva) return { tila: 'heratetty', lahto: 'sammuksissa', viesti: 'WoL lähetettäisiin', kuiva: t.kuiva };
    if (t.koodi !== 0) throw new Hylatty(504, `PC ei vastannut ${odota} s kuluessa herätyksestä`);
    if (/^Windows vastaa/m.test(t.stdout)) return linuxiin('sammuksissa');
    return { tila: 'linux', lahto: 'sammuksissa', viesti: t.stdout.trim().split('\n').pop() };
  }

  async function sammuta() {
    const alku = await tila();
    if (alku.tila === 'sammuksissa') throw new Hylatty(409, 'palvelin on jo sammuksissa');
    if (alku.tila === 'windows') throw new Hylatty(409, 'PC:ssä on käynnissä Windows, ei palvelin');
    const t = await ajaKiintea('sammuta', 15_000);
    // poweroff katkaisee yhteyden, jolloin ssh palaa 255:llä; tunnistus- ja host key -virhe on silti virhe.
    const katkesi = t.koodi === 255 && !/Permission denied|Host key|verification failed|Could not resolve|timed out|refused/i.test(t.stderr);
    if (t.koodi !== 0 && !katkesi) throw new Hylatty(502, `sammutus epäonnistui: ${virherivi(t)}`);
    return { tila: 'sammuu', lahto: 'linux', viesti: 'palvelin sammuu', ...(t.kuiva && { kuiva: t.kuiva }) };
  }

  // Yksi toiminto kerrallaan: herätys odottaa jopa minuutteja, eikä toinen painallus saa ajaa rinnalla.
  async function suorita(toiminto) {
    const hylkaa = (koodi, syy) => {
      kirjaa({ toiminto: `palvelin ${String(toiminto).slice(0, 40)}`, tulos: 'hylätty', syy });
      throw new Hylatty(koodi, syy);
    };
    if (toiminto !== 'kaynnista' && toiminto !== 'sammuta') hylkaa(404, 'tuntematon toiminto');
    if (kaynnissa) hylkaa(429, `${kaynnissa} on jo käynnissä`);
    kaynnissa = toiminto;
    try {
      const tulos = await (toiminto === 'kaynnista' ? kaynnista() : sammuta());
      kirjaa({ toiminto: `palvelin ${toiminto}`, tulos: 'ok', ...tulos });
      return tulos;
    } catch (e) {
      kirjaa({ toiminto: `palvelin ${toiminto}`, tulos: 'hylätty', syy: e.message });
      throw e;
    } finally { kaynnissa = null; }
  }

  return { tila, suorita };
}
