// kopio: scopes/palvelu/android.mjs @ e83f1152 (21.10.2026); muuttuneet import-rivit ja T-88:n tietoinen ero (android.mjs.ero)
// Android-puolen Gemini-äpin etäkäyttö Scopes-äpistä (SCOPES-ANDROID-GEMINI 15.10.2026, käyttäjän pyyntö: ruudun luku,
// ohjaus, tiedostojen syöttö ja tuotosten talteenotto). Puhelimen oma root-adbd (127.0.0.1:5555) ajaa kaiken. Turvamalli
// kuten palvelin.mjs:ssä: kiinteät komentopohjat execFilellä ilman paikallista kuorta; puhelimelta tulee vain numerot
// (0–1-osuudet ruudusta), nappien nimet listalta, Geminin kenttään menevä teksti (lainattu laitteen kuorelle q():lla) ja
// tiedostot, joiden nimi siistitään. Toiminnot kirjataan toimintolokiin; ruutukaappauksia ja lukuja ei.
//
// Reitit todennettiin laitteella 15.10.2026 (scopes/agy/android HISTORIA):
//   teksti   SEND text/plain BardEntryPointActivitylle → teksti Geminin kenttään (ääkköset toimivat, `input text` ei)
//   lähetys  uiautomator-dumpista content-desc "Send" → napautus keskelle
//   tiedosto SEND + EXTRA_STREAM ei käy: MediaStore-URI kaataa Geminin (SecurityException, shell ei myönnä URIa) ja
//            Termuxin providerin URI ohitetaan hiljaa. Siksi push /sdcard/Download/Scopes/, mediaskannaus ja
//            järjestelmän tiedostovalitsin: "Add attachments" → "Files" → tiedoston nimi Recent-listasta.
//   vastaus  resource-id assistant_robin_text (Gemini) ja assistant_robin_user_message_text (käyttäjä); generointi
//            käynnissä, kun content-desc "Stop generating response" näkyy.
//
// Ruutu (käyttäjän päätös 15.10.2026): palvelin herättää ruudun ensimmäisestä toiminnosta ja nukuttaa sen, kun
// toimintoja ei ole tullut minuuttiin. Vain itse herätetty ruutu nukutetaan: HDMI-tila (oneplus-ha.py) pitää ruudun
// hereillä TV:tä varten, eikä sitä saa sammuttaa tästä. uiautomator-dump kirjoitetaan joka kerta uuteen tiedostoon,
// koska vanha /data/local/tmp/*.xml johti aiemmin 76 väärään napautukseen (Infra/linux/palvelin/README.md).
// kuiva (SCOPES_ANDROID_KUIVA=1, :8788-koepalvelu): luku ajetaan, mutta herätys, napautus, intentti ja push eivät.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { siistiNimi } from './liitteet.mjs';
import { Hylatty } from '../toiminnot/aja.mjs';

export const GEMINI = 'com.google.android.apps.bard/.shellapp.BardEntryPointActivity';
export const LAITE_TALLENNUS = '/sdcard/Download/Scopes';
export const TUOTOSKANSIOT = Object.freeze(['/sdcard/Download', '/sdcard/Pictures', '/sdcard/Movies', '/sdcard/Documents', '/sdcard/DCIM']);
export const NAPIT = Object.freeze({
  takaisin: 'KEYCODE_BACK', koti: 'KEYCODE_HOME', enter: 'KEYCODE_ENTER', poista: 'KEYCODE_DEL',
  herata: 'KEYCODE_WAKEUP', nukuta: 'KEYCODE_SLEEP', sovellukset: 'KEYCODE_APP_SWITCH',
});
export const TEKSTIN_MAKSIMI = 8000;
// T-88, tietoinen ero vanhaan (android.mjs.ero): laitteen toinen näyttö (TV) tuottaa screencapin alkuun varoitustekstin ennen PNG:tä; hylätään PNG-allekirjoitusta edeltävät tavut (ei allekirjoitusta = ennallaan → vanha 500).
export const pngAlusta = (tavut) => { const i = tavut.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])); return i > 0 ? tavut.subarray(i) : tavut; };
const TUOTOKSEN_MAKSIMI = 60 << 20;
const JPEG = String.raw`import sys,io
from PIL import Image
im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')
w=int(sys.argv[1])
if w<im.width: im=im.resize((w,round(im.height*w/im.width)))
im.save(sys.stdout.buffer,'JPEG',quality=int(sys.argv[2]))`;
const TYYPIT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
};
export const tyyppi = (polku) => TYYPIT[extname(polku).toLowerCase()] ?? 'application/octet-stream';

// Laitteen kuoren lainaus: adb shell liittää argumentit yhdeksi riviksi, jonka laitteen sh jäsentää.
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Oletusajaja: execFile-tapaan ilman kuorta, mutta stdout tavuina (screencap, tiedostot).
export function ajaTavut(komento, argumentit, { aikaraja = 30_000, syote = null, puskuri = TUOTOKSEN_MAKSIMI } = {}) {
  return new Promise((ok) => {
    const lapsi = spawn(komento, argumentit, { stdio: ['pipe', 'pipe', 'pipe'] });
    const palat = []; let koko = 0; let stderr = ''; let ylitys = false;
    const ajastin = setTimeout(() => lapsi.kill('SIGKILL'), aikaraja);
    lapsi.stdout.on('data', (p) => { koko += p.length; if (koko <= puskuri) palat.push(p); else if (!ylitys) { ylitys = true; lapsi.kill('SIGKILL'); } });
    lapsi.stderr.on('data', (p) => { if (stderr.length < 4096) stderr += p; });
    lapsi.on('error', (e) => { clearTimeout(ajastin); ok({ koodi: -1, stdout: Buffer.alloc(0), stderr: e.message }); });
    lapsi.on('close', (koodi) => { clearTimeout(ajastin); ok({ koodi: ylitys ? -2 : (koodi ?? -1), stdout: Buffer.concat(palat), stderr }); });
    lapsi.stdin.on('error', () => {});
    lapsi.stdin.end(syote ?? undefined);
  });
}

const XML_MERKIT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const pura = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, k) =>
  k[0] === '#' ? String.fromCodePoint(k[1].toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1))) : XML_MERKIT[k] ?? m);

// uiautomator-dumpin solmut: { teksti, kuvaus, id, luokka, napautettava, alue: [x1, y1, x2, y2] }; näkymättömät pois.
export function jasennaUi(xml) {
  const solmut = [];
  for (const [, attr] of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a = {};
    // Lainausmerkin sisältävä arvo tulee heittomerkeissä (Geminin koodilohko 15.10.2026: text='…"…"…').
    for (const [, k, v, h] of attr.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) a[k] = pura(v ?? h);
    const alue = (a.bounds ?? '').match(/\d+/g)?.map(Number);
    if (!alue || alue.length !== 4 || alue[2] <= alue[0] || alue[3] <= alue[1]) continue;
    solmut.push({ teksti: a.text ?? '', kuvaus: a['content-desc'] ?? '', id: (a['resource-id'] ?? '').split('/').pop(),
      luokka: (a.class ?? '').split('.').pop(), napautettava: a.clickable === 'true', alue });
  }
  return solmut;
}

// Geminin keskustelu näkyvistä solmuista ylhäältä alas.
export function geminiKeskustelu(solmut) {
  const viestit = solmut
    .filter((s) => s.teksti && (s.id === 'assistant_robin_text' || s.id === 'assistant_robin_user_message_text'))
    .sort((a, b) => a.alue[1] - b.alue[1])
    .map((s) => ({ rooli: s.id === 'assistant_robin_text' ? 'gemini' : 'kayttaja', teksti: s.teksti }));
  return { viestit, kaynnissa: solmut.some((s) => s.kuvaus === 'Stop generating response') };
}

// Viimeisimmän vastauksen osat ruudulla ylhäältä alas (CHAT-GEMINI 15.10.2026, laitteella todennettu): vastaus on
// RecyclerView, jonka osat ovat tekstikappaleita (assistant_robin_text) ja koodilohkoja (code_info = kieli,
// code_impl = koodi). Osittain näkyvän osan solmussa on koko teksti; kokonaan ruudun ulkopuolella oleva osa puuttuu
// dumpista. Ruudun viimeistä käyttäjän viestiä ylempänä olevat osat kuuluvat aiempiin vastauksiin.
const NOLLALEVEYS = /[​‌‍﻿]/g;
export function vastauksenOsat(solmut) {
  const jarj = [...solmut].sort((a, b) => a.alue[1] - b.alue[1] || a.alue[0] - b.alue[0]);
  const kayttaja = jarj.findLast((s) => s.id === 'assistant_robin_user_message_text');
  const raja = kayttaja ? kayttaja.alue[3] : -1;
  const osat = [];
  let kieli = '';
  for (const s of jarj) {
    if (s.alue[1] < raja) continue;
    const t = s.teksti.replace(NOLLALEVEYS, '');
    if (s.id === 'assistant_robin_code_info') kieli = t.trim();
    else if (s.id === 'assistant_robin_code_impl' && t.trim()) { osat.push({ laji: 'koodi', teksti: t.replace(/\n+$/, ''), kieli }); kieli = ''; }
    else if (s.id === 'assistant_robin_text' && t.trim()) osat.push({ laji: 'teksti', teksti: t.trim() });
  }
  return osat;
}

// Ylöspäin vieritettäessä uusi ruudullinen (ylhäältä alas) liitetään kertyneiden alkuun päällekkäisen osan kohdalta;
// koodilohkon kieli täydentyy, jos otsake oli aiemmin ruudun ulkopuolella.
export function liitaAlkuun(kertyneet, uudet) {
  if (!kertyneet.length) return [...uudet];
  const avain = (o) => `${o.laji}\n${o.teksti}`;
  const i = uudet.findIndex((o) => avain(o) === avain(kertyneet[0]));
  if (i < 0) return [...uudet, ...kertyneet];
  const tulos = [...uudet.slice(0, i), ...kertyneet];
  uudet.slice(i).forEach((o, k) => { const v = tulos[i + k]; if (v && o.kieli && !v.kieli && avain(o) === avain(v)) tulos[i + k] = { ...v, kieli: o.kieli }; });
  return tulos;
}

export const osatTekstiksi = (osat) => osat.map((o) => (o.laji === 'koodi' ? `\`\`\`${o.kieli ?? ''}\n${o.teksti}\n\`\`\`` : o.teksti)).join('\n\n');

// Sama viesti ruudulla: välilyönnit tasattuina alun 60 merkin perusteella (pitkä viesti voi näkyä lyhennettynä).
const tasaa = (s) => String(s ?? '').replace(NOLLALEVEYS, '').replace(/\s+/g, ' ').trim();
export const samaViesti = (a, b) => { const x = tasaa(a).slice(0, 60), y = tasaa(b).slice(0, 60); return x.length > 0 && x === y; };

const keski = ({ alue: [x1, y1, x2, y2] }) => [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
const osuus = (v, nimi) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Hylatty(400, `${nimi} pitää olla luku 0–1`);
  return v;
};

export function luoAndroid({
  laite = '127.0.0.1:5555', aja = ajaTavut, loki = null, kuiva = false, tuotoksetDir = join(homedir(), '.local/state/scopes-android'),
  nukutusMs = 60_000, odota = (ms) => new Promise((r) => setTimeout(r, ms)), nyt = () => Date.now(),
} = {}) {
  let heratimme = false;
  let viimeksi = nyt();
  let koko = null; // [leveys, korkeus] wm sizesta
  let jono = Promise.resolve();

  const kirjaa = (rivi) => {
    if (!loki) return;
    try { mkdirSync(dirname(loki), { recursive: true }); appendFileSync(loki, JSON.stringify({ aika: new Date().toISOString(), ...rivi }) + '\n'); } catch { /* loki ei estä toimintoa */ }
  };
  const adb = (argumentit, opt = {}) => aja('adb', ['-s', laite, ...argumentit], opt);
  const kuori = async (rivi, opt = {}) => {
    const t = await adb(['shell', rivi], opt);
    return { ...t, teksti: t.stdout.toString('utf8') };
  };
  // Tilaa muuttava komento: kuivana palautetaan, mitä olisi ajettu.
  const muuta = async (rivi, opt) => (kuiva ? { koodi: 0, teksti: '', kuiva: rivi } : kuori(rivi, opt));
  const virherivi = (t) => (t.stderr || t.teksti || '').toString().trim().split('\n').pop()?.slice(0, 200) || `paluukoodi ${t.koodi}`;
  const sarjaan = (f) => { const p = jono.then(f, f); jono = p.catch(() => {}); return p; };

  async function hereilla() {
    const t = await kuori('dumpsys power | grep mWakefulness=', { aikaraja: 10_000 });
    if (t.koodi !== 0) throw new Hylatty(502, `adb ei vastaa: ${virherivi(t)}`);
    return /mWakefulness=Awake/.test(t.teksti);
  }

  async function heraa() {
    viimeksi = nyt();
    if (await hereilla()) return false;
    await muuta(`input keyevent ${NAPIT.herata}`);
    if (!kuiva) { heratimme = true; kirjaa({ toiminto: 'android herätys', tulos: 'ok' }); await odota(600); }
    return true;
  }

  // Ajastin kutsuu: itse herätetty ruutu nukkumaan minuutin hiljaisuuden jälkeen.
  async function nukutaJosHiljaista() {
    if (!heratimme || nyt() - viimeksi < nukutusMs) return false;
    heratimme = false;
    if (!(await hereilla())) return false;
    await muuta(`input keyevent ${NAPIT.nukuta}`);
    kirjaa({ toiminto: 'android nukutus', tulos: 'ok', syy: `${Math.round(nukutusMs / 1000)} s ilman toimintoa` });
    return true;
  }

  async function ruudunKoko() {
    if (koko) return koko;
    const t = await kuori('wm size', { aikaraja: 10_000 });
    const m = /Override size: (\d+)x(\d+)/.exec(t.teksti) ?? /Physical size: (\d+)x(\d+)/.exec(t.teksti);
    if (!m) throw new Hylatty(502, `ruudun kokoa ei saatu: ${virherivi(t)}`);
    return (koko = [Number(m[1]), Number(m[2])]);
  }

  async function lueUi() {
    const tiedosto = `/data/local/tmp/scopes-ui-${nyt()}-${Math.random().toString(36).slice(2, 8)}.xml`;
    const t = await kuori(`uiautomator dump ${tiedosto} >/dev/null 2>&1; cat ${tiedosto}; rm -f ${tiedosto}`, { aikaraja: 20_000 });
    if (!t.teksti.includes('<hierarchy')) throw new Hylatty(502, 'ruudun luku epäonnistui (uiautomator ei tuottanut dumpia)');
    return jasennaUi(t.teksti);
  }

  // Odottaa, että ehto löytää solmun; palauttaa solmun tai null.
  async function etsi(ehto, kerrat = 4, vali = 1200) {
    for (let i = 0; i < kerrat; i++) {
      const s = (await lueUi()).find(ehto);
      if (s) return s;
      if (i < kerrat - 1) await odota(vali);
    }
    return null;
  }

  // Geminin päälle tulevat kyselyt (15.10.2026 laitetestissä): jaetun tekstin vahvistus "This content was automatically
  // added from another app. Share it with Gemini?" hyväksytään (Share), Play-kaupan arvostelupyyntö ("Reviews are
  // public…") ohitetaan (Not now). Muut dialogit jäävät käyttäjälle ruudulle.
  async function kuittaaJako(solmut) {
    const on = (alku) => solmut.some((n) => n.teksti.startsWith(alku));
    const nappi = on('This content was automatically added') ? solmut.find((n) => n.teksti === 'Share')
      : on('Reviews are public') ? solmut.find((n) => n.teksti === 'Not now') : null;
    if (!nappi) return false;
    await napautaSolmu(nappi);
    await odota(800);
    return true;
  }

  async function napautaSolmu(s) {
    const [x, y] = keski(s);
    return muuta(`input tap ${x} ${y}`);
  }

  // GET /api/android: { hereilla, heratimme, koko }
  async function tila() {
    return { hereilla: await hereilla(), heratimme, koko: await ruudunKoko(), kuiva };
  }

  // GET /api/android/ruutu?leveys=: JPEG; herättää ruudun (musta kuva ei auta ketään).
  async function ruutu(leveys = 720) {
    const w = Math.max(240, Math.min(1440, Math.round(Number(leveys) || 720)));
    await heraa();
    const png = await adb(['exec-out', 'screencap', '-p'], { aikaraja: 15_000 });
    if (png.koodi !== 0 || png.stdout.length < 100) throw new Hylatty(502, `screencap epäonnistui: ${virherivi(png)}`);
    const jpg = await aja('python3', ['-P', '-c', JPEG, String(w), '70'], { syote: pngAlusta(png.stdout), aikaraja: 15_000 });
    if (jpg.koodi !== 0 || jpg.stdout.length === 0) throw new Hylatty(500, `JPEG-muunnos epäonnistui: ${virherivi(jpg)}`);
    return { tyyppi: 'image/jpeg', data: jpg.stdout };
  }

  // GET /api/android/ui: solmut ja Geminin keskustelu.
  const ui = () => sarjaan(async () => {
    await heraa();
    const solmut = await lueUi();
    return { koko: await ruudunKoko(), solmut, gemini: geminiKeskustelu(solmut) };
  });

  const TOIMINNOT = {
    async napauta({ x, y }) {
      const [w, h] = await ruudunKoko();
      const px = Math.round(osuus(x, 'x') * (w - 1)), py = Math.round(osuus(y, 'y') * (h - 1));
      return { ...(await muuta(`input tap ${px} ${py}`)), piste: [px, py] };
    },
    async pyyhkaise({ x1, y1, x2, y2, kesto = 300 }) {
      const [w, h] = await ruudunKoko();
      const p = [osuus(x1, 'x1') * (w - 1), osuus(y1, 'y1') * (h - 1), osuus(x2, 'x2') * (w - 1), osuus(y2, 'y2') * (h - 1)].map(Math.round);
      const ms = Math.max(50, Math.min(3000, Math.round(Number(kesto) || 300)));
      return muuta(`input swipe ${p.join(' ')} ${ms}`);
    },
    async nappi({ nimi }) {
      if (!Object.hasOwn(NAPIT, nimi)) throw new Hylatty(400, `tuntematon nappi (sallitut: ${Object.keys(NAPIT).join(', ')})`);
      if (nimi === 'nukuta') heratimme = false;
      return muuta(`input keyevent ${NAPIT[nimi]}`);
    },
    avaa: () => muuta(`am start -n ${GEMINI}`),
    async uusi() {
      await muuta(`am start -n ${GEMINI}`); await odota(800);
      const s = await etsi((n) => n.kuvaus === 'New chat', 3);
      if (!s) throw new Hylatty(409, 'New chat -painiketta ei näy');
      return napautaSolmu(s);
    },
    // Teksti Geminin kenttään jakointentillä (korvaa kentän sisällön); lähetys erikseen tai `laheta: true`.
    async kirjoita({ teksti, laheta = false }) {
      if (typeof teksti !== 'string' || !teksti.trim()) throw new Hylatty(400, 'teksti puuttuu');
      if (teksti.length > TEKSTIN_MAKSIMI) throw new Hylatty(413, `teksti yli ${TEKSTIN_MAKSIMI} merkkiä`);
      // Jakointentti nollaa kentän ja sen liitteet (laitetesti 15.10.2026): liitteen kanssa teksti kulkee liite?teksti=.
      if (!kuiva && (await lueUi()).some((n) => n.kuvaus === 'List of attachments'))
        throw new Hylatty(409, 'kentässä odottaa liite; jakointentti poistaisi sen — lähetä teksti liitteen kanssa tai poista liite');
      const t = await muuta(`am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT ${q(teksti)} -n ${GEMINI}`);
      if (t.koodi !== 0) throw new Hylatty(502, `tekstin vienti epäonnistui: ${virherivi(t)}`);
      if (!laheta) return t;
      await odota(1500);
      return TOIMINNOT.laheta();
    },
    async laheta() {
      await kuittaaJako(await lueUi());
      const s = await etsi((n) => n.kuvaus === 'Send', 3, 800);
      if (!s) throw new Hylatty(409, 'Send-painiketta ei näy (kenttä tyhjä tai Gemini ei edessä)');
      return napautaSolmu(s);
    },
    // Näkyvä keskustelu talteen palvelimelle markdownina.
    async talteen() {
      const { viestit, kaynnissa } = geminiKeskustelu(await lueUi());
      if (!viestit.length) throw new Hylatty(409, 'ruudulla ei näy Geminin keskustelua');
      const teksti = viestit.map((v) => `## ${v.rooli === 'gemini' ? 'Gemini' : 'Minä'}\n\n${v.teksti}\n`).join('\n');
      mkdirSync(tuotoksetDir, { recursive: true });
      const polku = join(tuotoksetDir, `${new Date(nyt()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-gemini.md`);
      writeFileSync(polku, teksti);
      return { polku, teksti, viestit, kaynnissa };
    },
  };

  // POST /api/android/<toiminto> {…}
  function suorita(toiminto, runko = {}) {
    if (!Object.hasOwn(TOIMINNOT, toiminto)) throw new Hylatty(404, 'tuntematon toiminto');
    return sarjaan(async () => {
      try {
        await heraa();
        const t = await TOIMINNOT[toiminto](runko ?? {});
        viimeksi = nyt();
        const tulos = { ok: true, ...(t?.piste && { piste: t.piste }), ...(t?.kuiva && { kuiva: t.kuiva }), ...(t?.polku && { polku: t.polku, teksti: t.teksti, viestit: t.viestit, kaynnissa: t.kaynnissa }) };
        if (toiminto !== 'napauta' && toiminto !== 'pyyhkaise') kirjaa({ toiminto: `android ${toiminto}`, tulos: 'ok', ...(t?.kuiva && { kuiva: t.kuiva }) });
        return tulos;
      } catch (e) {
        kirjaa({ toiminto: `android ${toiminto}`, tulos: 'hylätty', syy: e.message });
        throw e;
      }
    });
  }

  // POST /api/android/liite?nimi=: tavut (palvelin.mjs lukee rungon liitteet-moduulilla) → laitteelle ja Geminin
  // tiedostovalitsimesta liitteeksi. Jos valitsin ei näytä tiedostoa, se jää auki ruudulle käsin valittavaksi.
  // teksti (valinnainen): viedään kenttään ENNEN liitettä, koska jakointentti nollaa kentän liitteineen, ja
  // valitsimen jälkeen viesti lähetetään (järjestys todennettu laitteella 15.10.2026).
  function liita(paikallinen, teksti = null) {
    if (teksti != null && (typeof teksti !== 'string' || teksti.length > TEKSTIN_MAKSIMI)) throw new Hylatty(400, `teksti puuttuu tai yli ${TEKSTIN_MAKSIMI} merkkiä`);
    const nimi = `scopes-${new Date(nyt()).toISOString().slice(11, 19).replace(/:/g, '')}-${siistiNimi(basename(paikallinen).replace(/^\d{8}T\d{6}-[0-9a-f]{6}-/, ''), 'liite').slice(-60)}`;
    const kohde = `${LAITE_TALLENNUS}/${nimi}`;
    return sarjaan(async () => {
      try {
        await heraa();
        if (kuiva) return { ok: true, nimi, kuiva: `adb push ${paikallinen} ${kohde}; valitsin: Add attachments → Files → ${nimi}` };
        await kuori(`mkdir -p ${LAITE_TALLENNUS}`);
        const p = await adb(['push', paikallinen, kohde], { aikaraja: 120_000 });
        if (p.koodi !== 0) throw new Hylatty(502, `push epäonnistui: ${virherivi({ ...p, teksti: p.stdout.toString() })}`);
        await kuori(`content call --uri content://media --method scan_file --arg ${q(kohde)}`, { aikaraja: 20_000 });
        if (teksti?.trim()) await TOIMINNOT.kirjoita({ teksti });
        else await muuta(`am start -n ${GEMINI}`);
        await odota(1200);
        await kuittaaJako(await lueUi());
        const lisaa = await etsi((n) => n.kuvaus === 'Add attachments');
        if (!lisaa) throw new Hylatty(409, `Geminin liitepainiketta ei näy; tiedosto on laitteella: ${kohde}`);
        await napautaSolmu(lisaa); await odota(1200);
        const files = await etsi((n) => n.teksti === 'Files');
        if (!files) throw new Hylatty(409, `liitevalikossa ei näy Files-kohtaa; tiedosto on laitteella: ${kohde}`);
        await napautaSolmu(files); await odota(2000);
        const rivi = await etsi((n) => n.teksti === nimi, 5);
        if (!rivi) throw new Hylatty(409, `tiedostovalitsin ei näytä tiedostoa ${nimi}; valitse se ruudulta (Download/Scopes)`);
        await napautaSolmu(rivi); await odota(2000);
        const liitetty = await etsi((n) => n.teksti === nimi, 3);
        const lahetetty = Boolean(liitetty && teksti?.trim());
        if (lahetetty) await TOIMINNOT.laheta();
        viimeksi = nyt();
        kirjaa({ toiminto: 'android liite', tulos: liitetty ? 'ok' : 'epävarma', nimi, lahetetty });
        return { ok: true, nimi, liitetty: Boolean(liitetty), lahetetty };
      } catch (e) {
        kirjaa({ toiminto: 'android liite', tulos: 'hylätty', syy: e.message });
        throw e;
      }
    });
  }

  // GET /api/android/tuotokset: laitteen tuotoskansioiden tiedostot 14 vrk ajalta uusin ensin (omat syötteet pois).
  async function tuotokset() {
    const rivi = `for d in ${TUOTOSKANSIOT.join(' ')}; do find "$d" -type f -mtime -14 2>/dev/null; done | grep -v -e '^${LAITE_TALLENNUS}/' -e '/\\.' | while IFS= read -r f; do stat -c '%Y|%s|%n' "$f"; done`;
    const t = await kuori(rivi, { aikaraja: 20_000 });
    const tiedostot = t.teksti.split('\n').map((r) => r.split('|')).filter((o) => o.length >= 3)
      .map(([aika, koko, ...p]) => ({ polku: p.join('|'), nimi: basename(p.join('|')), koko: Number(koko), aika: new Date(Number(aika) * 1000).toISOString() }))
      .sort((a, b) => b.aika.localeCompare(a.aika)).slice(0, 100);
    return { tiedostot };
  }

  // GET /api/android/tuotos?polku=: tiedoston tavut; kopio jää palvelimelle tuotoksetDir/laitteelta/.
  async function tuotos(polku) {
    const p = String(polku ?? '');
    if (!TUOTOSKANSIOT.some((k) => p.startsWith(`${k}/`)) || p.includes('/../') || p.includes('\0') || p.endsWith('/..'))
      throw new Hylatty(400, 'polku ei ole tuotoskansiossa');
    const t = await adb(['exec-out', `cat ${q(p)}`], { aikaraja: 120_000 });
    if (t.koodi === -2) throw new Hylatty(413, 'tiedosto liian suuri');
    if (t.koodi !== 0) throw new Hylatty(404, `tiedostoa ei saatu: ${virherivi({ ...t, teksti: '' })}`);
    try {
      const kopio = join(tuotoksetDir, 'laitteelta', siistiNimi(basename(p), 'tuotos'));
      mkdirSync(dirname(kopio), { recursive: true });
      writeFileSync(kopio, t.stdout);
    } catch { /* kopio ei estä toimitusta */ }
    kirjaa({ toiminto: 'android tuotos', tulos: 'ok', polku: p, koko: t.stdout.length });
    return { tyyppi: tyyppi(p), data: t.stdout, nimi: basename(p) };
  }

  // Gemini chat-moottorina (CHAT-GEMINI 15.10.2026, käyttäjä: Gemini mallivalintana tavallisessa chatissa).
  // Jakointentti avaa aina uuden Gemini-chatin (laitteella todennettu: myös avoimen keskustelun päälle), eikä auki olevaan
  // keskusteluun saa kirjoitettua ääkkösiä (`input text`), joten jokainen kysymys on oma Gemini-chattinsa ja jatkon
  // historia kulkee tekstissä (viestit.mjs). Vastausta seurataan dumpeista: generoinnin aikana dumppi voi epäonnistua tai
  // kestää ~10 s (ruutu ei ole levossa), joten virhe vain ohitetaan. Valmis vastaus kootaan vierittämällä (kokoaVastaus),
  // koska ruudun ulkopuolinen osa puuttuu dumpista. Jokainen vaihe kulkee sarjaan-jonossa erikseen, jottei
  // Android-näkymä jumitu koko vastauksen ajaksi.
  async function kysyGeminilta({ teksti, pala = null, pysaytetty = () => false, aikaraja = 300_000, vali = 1000 } = {}) {
    await suorita('kirjoita', { teksti, laheta: true });
    if (kuiva) return { vastaus: '', kuiva: true };
    let naytetty = '';
    const nayta = (t) => { if (t.length > naytetty.length && t.startsWith(naytetty)) { pala?.(t.slice(naytetty.length)); naytetty = t; } };
    const alku = nyt();
    let nahty = false;
    let edel = null;
    let keskeytetty = false;
    for (;;) {
      if (pysaytetty()) {
        keskeytetty = true;
        await sarjaan(async () => { const s = (await lueUi()).find((n) => n.kuvaus === 'Stop generating response'); if (s) await napautaSolmu(s); }).catch(() => {});
        break;
      }
      if (nyt() - alku > aikaraja) throw new Hylatty(504, `Gemini ei vastannut ${Math.round(aikaraja / 1000)} sekunnissa`);
      let solmut;
      try { solmut = await sarjaan(async () => { await heraa(); return lueUi(); }); } catch { await odota(vali); continue; }
      // Vastaus luetaan vasta, kun lähetetty viesti näkyy: sitä ennen ruudulla on edellinen vastaus.
      nahty ||= solmut.some((n) => n.id === 'assistant_robin_user_message_text' && samaViesti(n.teksti, teksti));
      if (!nahty) {
        if (nyt() - alku > 30_000) throw new Hylatty(502, 'lähetetty viesti ei näy Geminissä 30 sekunnin jälkeen');
        await odota(vali);
        continue;
      }
      const t = osatTekstiksi(vastauksenOsat(solmut));
      nayta(t);
      if (t && t === edel && !solmut.some((n) => n.kuvaus === 'Stop generating response')) break;
      edel = t;
      await odota(vali);
    }
    const vastaus = await kokoaVastaus(teksti).catch(() => edel ?? '');
    nayta(vastaus);
    viimeksi = nyt();
    kirjaa({ toiminto: 'android gemini-chat', tulos: keskeytetty ? 'keskeytetty' : 'ok', merkkeja: vastaus.length, kesto: nyt() - alku });
    return { vastaus, ...(keskeytetty && { keskeytetty: true }) };
  }

  // Koko vastaus: alas, sitten ylös ruudullinen kerrallaan, kunnes lähetetty viesti (chatin ensimmäinen) näkyy.
  // Ruutua korkeampi osa täyttää näkymän samoin rajoin vedosta toiseen, joten "ruutu ei muuttunut" ei kerro yläreunasta
  // (laitteella 15.10.2026 vieritys pysähtyi siihen kesken); raja on vetojen määrä. Hidas veto (800 ms) ei heitä listaa
  // vauhdilla, ja 50 %:n siirtymä jättää ~500 px päällekkäisyyden liitaAlkuun-kutsulle (näkymä ~1760 px, osien väli ~140 px).
  function kokoaVastaus(teksti) {
    return sarjaan(async () => {
      let solmut = await lueUi();
      const alas = solmut.find((n) => n.kuvaus === 'Scroll to bottom');
      if (alas) { await napautaSolmu(alas); await odota(1200); solmut = await lueUi(); }
      const [w, h] = await ruudunKoko();
      const x = Math.round(w / 2);
      let osat = [];
      for (let i = 0; i < 60; i++) {
        osat = liitaAlkuun(osat, vastauksenOsat(solmut));
        if (solmut.some((n) => n.id === 'assistant_robin_user_message_text' && samaViesti(n.teksti, teksti))) break;
        await muuta(`input swipe ${x} ${Math.round(h * 0.25)} ${x} ${Math.round(h * 0.75)} 800`);
        await odota(900);
        solmut = await lueUi();
      }
      return osatTekstiksi(osat);
    });
  }

  const ajastin = setInterval(() => { nukutaJosHiljaista().catch(() => {}); }, 15_000);
  ajastin.unref?.();
  const lopeta = () => clearInterval(ajastin);

  return { tila, ruutu, ui, suorita, liita, tuotokset, tuotos, kysyGeminilta, nukutaJosHiljaista, lopeta };
}
