// Android-ohjaus (T-85, ARK-19, S-10): GET /api/android/<ruutu|ui|tuotokset|tuotos>, POST /api/android/liite ja POST /api/android/<toiminto>.
// Käytös = vanhan 8787:n (scopes/palvelu/palvelin.mjs:223-225 ja :300-303, android.mjs = vanhasta/android.mjs), kopioitu kopioriveineen.
// GET /api/android (tila) ei ole adapterin reitti: ydin vastaa siihen lähdetilasta (T-84).
// Laiteolio: tämä moduuli ei luo omaa oliota vaan käyttää vain ymp.android-oliota. adapteri.mjs luo yhden luoAndroid-olion
// (--adb annettu) ja antaa saman olion lähdetilalle (luoLahde luoAndroid-injektio) ja tälle moduulille, joten laitteella on
// yksi sarjaan-lukko, yksi herätystila ja yksi nukutusajastin (15 s, nyt = ymp.kello) adapterin prosessissa.
// Ilman ymp.android-oliota (adapteri ilman --adb) laitetta ei ole: reitit vastaavat täsmälleen kuten vanha 8787, kun adb ei vastaa
// (ruutu, ui, liite ja toiminnot 502 "adb ei vastaa", tuotokset 200 {tiedostot:[]}, tuotos ja tuntematon toiminto 404): käytetään
// vanhasta/android.mjs:n luoAndroidia, jonka adb-ajaja epäonnistuu aina eikä koske mihinkään laitteeseen (iOS/macOS-asiakkaat ja T-70).
// Tallennus: liitteet <ymp.tila>/liitteet/android/ (oletus ~/.local/state/scopes2/liitteet/android/); tuotokset ja talteen-tiedostot
// kirjoittaa laiteolio omaan tuotoksetDir-hakemistoonsa (adapteri.mjs: ~/.local/state/scopes2/android/).
// Tuonnit vain ./aja.mjs, ./runko.mjs, ../vanhasta/* ja node:-moduulit (gate.sh tuontitarkistus).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { luoAndroid } from '../vanhasta/android.mjs';
import { luoLiitteet } from '../vanhasta/liitteet.mjs';
import { lueRunko, vastaa } from './runko.mjs';

// Laiteton olio: jokainen adb-kutsu päättyy koodiin 1 (vanhan "adb ei vastaa" -polku), ei komentoja ja ei tallennusta tuotoksetDiriin.
const POISSA = luoAndroid({
  aja: async () => ({ koodi: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('laitetta ei ole määritetty (adapteri ilman --adb)') }),
});
const laite = (ymp) => ymp.android ?? POISSA;

// kopio: scopes/palvelu/palvelin.mjs:196-200 (vastaaTavut, 21.10.2026)
function vastaaTavut(res, { tyyppi, data, nimi }) {
  res.writeHead(200, { 'content-type': tyyppi, 'content-length': data.length, 'cache-control': 'no-store',
    ...(nimi && { 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(nimi)}` }) });
  res.end(data);
}

const kysely = (req) => new URL(req.url, 'http://x').searchParams;

// Reitit. Virheet (Hylatty) muuttuvat statukseksi palvelin.mjs:ssä.
export const REITIT = [
// kopio: scopes/palvelu/palvelin.mjs:300 (21.10.2026)
  { metodi: 'GET', kuvio: '/api/android/ruutu', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    req.resume();
    vastaaTavut(res, await laite(ymp).ruutu(kysely(req).get('leveys') ?? 720));
  } },
// kopio: scopes/palvelu/palvelin.mjs:301 (21.10.2026)
  { metodi: 'GET', kuvio: '/api/android/ui', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    req.resume();
    vastaa(res, 200, await laite(ymp).ui());
  } },
// kopio: scopes/palvelu/palvelin.mjs:302 (21.10.2026)
  { metodi: 'GET', kuvio: '/api/android/tuotokset', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    req.resume();
    vastaa(res, 200, await laite(ymp).tuotokset());
  } },
// kopio: scopes/palvelu/palvelin.mjs:303 (21.10.2026)
  { metodi: 'GET', kuvio: '/api/android/tuotos', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    req.resume();
    vastaaTavut(res, await laite(ymp).tuotos(kysely(req).get('polku')));
  } },
// kopio: scopes/palvelu/palvelin.mjs:223 (21.10.2026); sovitus: liite tallennetaan ensin (luoLiitteet, kuten vanha liitteet('android', …)) hakemistoon
// <ymp.tila>/liitteet/android/ ja sitten laitteelle; aikaleima ymp.kellosta
  { metodi: 'POST', kuvio: '/api/android/liite', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    const olio = laite(ymp);
    const tallenna = luoLiitteet({ liitteetDir: join(ymp.tila ?? join(homedir(), '.local/state/scopes2'), 'liitteet') }, { nyt: () => new Date((ymp.kello ?? Date.now)()) });
    const haku = kysely(req);
    const { polku } = await tallenna('android', haku.get('nimi'), req);
    vastaa(res, 200, await olio.liita(polku, haku.get('teksti')));
  } },
// kopio: scopes/palvelu/palvelin.mjs:224-225 (21.10.2026); tuntematon toiminto → 404 "tuntematon toiminto" (olion suorita)
  { metodi: 'POST', kuvio: '/api/android/*', toteutettu: true, kasittele: async (req, res, osat, ymp) => {
    const olio = laite(ymp);
    vastaa(res, 200, await olio.suorita(osat[0], await lueRunko(req, 32_768)));
  } },
];
