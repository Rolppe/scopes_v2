#!/usr/bin/env node
// scopes2-adapteri (T-24): peilaa Claude Coden transkriptit (*.jsonl) ytimeen S-5a:lla.
//   node scopes2/adapteri/adapteri.mjs [--ydin url] [--projektit ~/.claude/projects] [--istunnot <istunnotDir>] [--kerran]
// Muutokset: fs.watch(projektitDir, recursive) + 2 s kierros (mtime-vertailu lueLisays-funktiossa).
// --istunnot: kierros seuraa elävien istuntojen transkripteja (ja watchin ilmoittamia); ilman sitä kaikkia *.jsonl-tiedostoja.
// --kerran: yksi kierros ja poistuminen (exit 0 = kaikki lähetetty, 1 = rivejä jäi jonoon tai ydin ei vastannut).
// Lähdetila (T-29, S-5b): lahde.mjs lähettää istunnot (vaatii --istunnot), agy (--agy), android (--adb) ja kayttoraja
// vain muutoksesta, vähintään 60 s välein. --agy <keskustelut>, --brain <brain>, --adb <laite>, --agy-ruudut (capture-pane), --laite <id>.
// --toiminnot <portti> (T-63-G, S-10): kuuntelee lisäksi 127.0.0.1:<portti> ARK-16:n toimintoreiteille (V2-avain); ilman lippua ei kuuntele.
// --chat <hakemisto> (T-95, T-70 poikkeama A): chatin työhakemisto ja historia (ymp.chatDir); ilman lippua toiminnot/chat.mjs:n oletus <tila>/chat.
// --agy-luvat (T-83): käynnistää agy-luvat-taustasilmukan (vastaa agy-ruutujen lupakyselyihin, kun asetus agyluvat on päällä); vaatii --toiminnot.
//   Oletuksena pois, koska vanha 8787 ajaa omaa silmukkaansa eikä kaksi silmukkaa saa vastata samaan kehotteeseen; kytketään vanhan alasajossa.
// --adb (T-85): adapteri luo yhden luoAndroid-olion (vanhasta/android.mjs), jonka lähdetila (android-laji) ja toiminnot/android.mjs jakavat
//   (yksi sarjaan-lukko, yksi herätystila, yksi nukutusajastin). --android-kuiva tai SCOPES2_ANDROID_KUIVA=1: tilaa muuttavat adb-komennot ohitetaan,
//   vastauksessa kuiva (kuten vanhan SCOPES_ANDROID_KUIVA). Liitteet ~/.local/state/scopes2/liitteet/android/, tuotokset ~/.local/state/scopes2/android/.
// Lähdetilan laji asetukset (T-83): lukee kytkinten tilahakemiston (~/.claude/skills/keskustelun-siirto/state) ja lähetetään kuten muut lajit;
//   --toiminnot-reitit ajavat heti onnistuneen muutoksen jälkeen lähdekierroksen (ymp.lahdeKierros).
// Loki stderr:iin: yksi rivi per lähetys "peili <tiedosto> +<rivit> → <offset>". Avainta ei lokiteta.

import { readdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { luoLahde, oletusAja } from './lahde.mjs';
import { istuntotiedostot, lueSkoopit } from './transkriptit.mjs';
import { luoPeili } from './peili.mjs';
import { ajaTavut, luoAndroid } from './vanhasta/android.mjs';
import { luoToimintopalvelin } from './toiminnot/palvelin.mjs';
import { haePaikalliset } from './toiminnot/agentit.mjs';
import { KAIKKI, KOUKUT } from './toiminnot/reitit.mjs';
import { jonoKaikki } from './toiminnot/istunto.mjs';
import { OLETUS_HAKEMISTO as ASETUSTEN_HAKEMISTO } from './vanhasta/toiminnot-asetukset.mjs';

const KIERROS_MS = 2000;
// Kierroksen rinnakkaisuus: tuotannossa 3476 transkriptia (2,4 GB) yhtä aikaa ajoi V8-keon täyteen (T-34 ajo 1).
const RINNAKKAIN = Number(process.env.SCOPES2_RINNAKKAIN) || 4;
const kotiin = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);

function argumentit(argv) {
  const a = { ydin: undefined, projektit: '~/.claude/projects', istunnot: null, kerran: false, agy: null, brain: null, adb: null, laite: null, toiminnot: null, chat: null, 'agy-ruudut': false, 'agy-luvat': false, 'android-kuiva': false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--kerran') a.kerran = true;
    else if (k === '--agy-ruudut') a['agy-ruudut'] = true;
    else if (k === '--agy-luvat') a['agy-luvat'] = true;
    else if (k === '--android-kuiva') a['android-kuiva'] = true;
    else if (['--ydin', '--projektit', '--istunnot', '--agy', '--brain', '--adb', '--laite', '--toiminnot', '--chat'].includes(k)) {
      if (argv[i + 1] == null) throw new Error(`${k} vaatii arvon`);
      a[k.slice(2)] = argv[++i];
      if (k === '--toiminnot' && !(Number.isInteger(Number(a.toiminnot)) && Number(a.toiminnot) >= 0 && Number(a.toiminnot) <= 65535)) throw new Error('--toiminnot vaatii portin 0–65535');
    } else throw new Error(`tuntematon argumentti ${k}`);
  }
  return a;
}

// Kaikki *.jsonl-tiedostot hakemistopuussa.
function jsonlTiedostot(juuri) {
  const tulos = [];
  const kay = (hak) => {
    let rivit;
    try { rivit = readdirSync(hak, { withFileTypes: true }); } catch { return; }
    for (const e of rivit) {
      const p = join(hak, e.name);
      if (e.isDirectory()) kay(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) tulos.push(p);
    }
  };
  kay(juuri);
  return tulos;
}

async function main() {
  const a = argumentit(process.argv.slice(2));
  const projektitDir = resolve(kotiin(a.projektit));
  const istunnotDir = a.istunnot ? resolve(kotiin(a.istunnot)) : null;
  const peili = luoPeili({ ...(a.ydin ? { ydin: a.ydin } : {}), projektitDir });

  // Skooppien nimet vanhan rekisterin skoopit.json:sta (repon juuri tästä tiedostosta; SCOPES_JUURI ohittaa).
  const juuri = process.env.SCOPES_JUURI ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const skooppiNimet = () => { try { return Object.keys(lueSkoopit(juuri)); } catch { return []; } };
  // Jaettu laiteolio (T-85): ajaTavut, koska screencap ja tiedostot ovat tavuja ja ruutu syöttää PNG:n python3:n stdiniin (oletusAja palauttaisi merkkijonon).
  const tilaHakemisto = join(homedir(), '.local/state/scopes2');
  const androidOlio = a.adb
    ? luoAndroid({
      laite: a.adb,
      aja: ajaTavut,
      kuiva: a['android-kuiva'] || process.env.SCOPES2_ANDROID_KUIVA === '1',
      loki: join(tilaHakemisto, 'toiminnot.loki'),
      tuotoksetDir: join(tilaHakemisto, 'android'),
    })
    : null;
  const lahde = istunnotDir || a.agy || a.adb
    ? luoLahde({
      ...(a.ydin ? { ydin: a.ydin } : {}),
      aja: oletusAja,
      istunnotDir,
      projektitDir,
      skooppiNimet,
      agyHakemisto: a.agy ? resolve(kotiin(a.agy)) : null,
      brainHakemisto: a.brain ? resolve(kotiin(a.brain)) : undefined,
      adb: a.adb,
      asetusHakemisto: ASETUSTEN_HAKEMISTO,
      ...(a.toiminnot != null ? { jono: () => jonoKaikki({ tila: tilaHakemisto }) } : {}),
      agyRuudut: a['agy-ruudut'],
      ...(a.laite ? { laite: a.laite } : {}),
      ...(androidOlio ? { luoAndroid: () => androidOlio } : {}),
    })
    : null;

  const alustetut = new Set();
  const seuratut = new Set();
  const ketjut = new Map(); // polku → Promise: saman tiedoston käsittelyt peräkkäin

  const kasittele = (polku) => {
    const edellinen = ketjut.get(polku) ?? Promise.resolve();
    const seuraava = edellinen.then(async () => {
      if (!alustetut.has(polku)) {
        if ((await peili.alusta(polku)) == null) return; // ydin poissa: yritetään seuraavalla kierroksella
        alustetut.add(polku);
      }
      await peili.kasittele(polku);
    }).catch((e) => process.stderr.write(`peili ${polku} virhe ${e?.message ?? e}\n`));
    ketjut.set(polku, seuraava);
    return seuraava;
  };

  const kierros = async () => {
    const polut = istunnotDir
      ? istuntotiedostot(istunnotDir, '/proc', projektitDir).map((i) => i.polku)
      : jsonlTiedostot(projektitDir);
    for (const p of polut) seuratut.add(p);
    const alku = Date.now();
    const jono = [...seuratut];
    const tyontekija = async () => { while (jono.length) await kasittele(jono.shift()); };
    await Promise.all(Array.from({ length: Math.min(RINNAKKAIN, jono.length) }, tyontekija));
    await peili.pura();
    // Mittarit (T-34-harjoitus): ensimmäinen täysi kierros ja sen jälkeen 30 s välein.
    if (!kierroksia++ || Date.now() - mitattu >= 30_000) {
      mitattu = Date.now();
      const m = process.memoryUsage();
      process.stderr.write(`tila kierros ${kierroksia} ${Date.now() - alku} ms, ${seuratut.size} tiedostoa, jono ${peili.jonoTavut()} tavua, 413 ${peili.hylatyt()}, rss ${Math.round(m.rss / 1048576)} MB, keko ${Math.round(m.heapUsed / 1048576)} MB\n`);
    }
  };
  let kierroksia = 0;
  let mitattu = 0;

  if (a.kerran) {
    await kierros();
    const lahetetty = lahde ? await lahde.kierros() : { lahetetty: [] };
    if (lahde) process.stderr.write(`lahde kerran: ${lahetetty.lahetetty.join(',') || '-'}\n`);
    process.exitCode = peili.jono().length || [...seuratut].some((p) => !alustetut.has(p)) ? 1 : 0;
    peili.sulje();
    lahde?.sulje();
    return;
  }

  // T-89: Linuxilla rekursiivinen watch varaa inotify-paikan jokaiselle hakemistolle (raja 8192) ja ENOSPC kaatoi prosessin → vain kierros.
  // SCOPES2_ALUSTA ohittaa process.platformin (watch.test.mjs).
  if ((process.env.SCOPES2_ALUSTA ?? process.platform) === 'linux') {
    process.stderr.write(`fs.watch: ei Linuxilla (inotify-raja); ${KIERROS_MS} ms kierros\n`);
  } else {
    try {
      const watcher = watch(projektitDir, { recursive: true }, (_tapahtuma, nimi) => {
        if (!nimi || !String(nimi).endsWith('.jsonl')) return;
        const p = join(projektitDir, String(nimi));
        seuratut.add(p);
        kasittele(p);
      });
      watcher.on('error', (e) => {
        try { watcher.close(); } catch { /* jo suljettu */ }
        process.stderr.write(`fs.watch suljettu (${e?.code ?? e?.message}); vain ${KIERROS_MS} ms kierros\n`);
      });
    } catch (e) {
      process.stderr.write(`fs.watch ei käytössä (${e.message}); vain ${KIERROS_MS} ms kierros\n`);
    }
  }
  if (a.toiminnot != null) {
    // Kuuntelijan epäonnistuminen (portti varattu) ei kaada peilausta; ydin jatkaa reittien ohjausta 8787:ään, kun adapteri ei vastaa terveyteen.
    // T-83: moduulit saavat ymp:iin lahdeKierros (heti-kierros asetusmuutoksen jälkeen) ja agyLuvat (lippu); palvelin.mjs ei välitä lisäkenttiä.
    // adb: tosi, kun --adb on annettu → GET /api/agentit listaa android/gemini (T-82; kuten lahde.mjs:n adb-ehto).
    // T-111: --projektit/--istunnot/--agy/--brain-polut myös toimintoreiteille (muuten reitit käyttäisivät oletuspolkuja).
    const lisaYmp = { agyLuvat: a['agy-luvat'], adb: Boolean(a.adb), projektitDir, ...(istunnotDir ? { istunnotDir } : {}), ...(a.agy ? { agyHakemisto: resolve(kotiin(a.agy)) } : {}), ...(a.brain ? { brainHakemisto: resolve(kotiin(a.brain)) } : {}), ...(a.chat ? { chatDir: kotiin(a.chat) } : {}), ...(androidOlio ? { android: androidOlio } : {}), ...(lahde ? { lahdeKierros: () => lahde.kierros() } : {}) };
    // paikalliset: purkajalistan palvelimen LM Studio -mallit (T-68) vanhan viestit.agentit()-haun mukaan (agentit.mjs haePaikalliset,
    // 20 s välimuisti); ssh kulkee ymp.aja:n kautta. Ilman tätä purkajalista ja malli-valinta eivät tuntisi palvelin/<id>-malleja.
    const reitit = KAIKKI.map((r) => ({ ...r, kasittele: (req, res, osat, ymp) => r.kasittele(req, res, osat, { paikalliset: () => haePaikalliset(ymp), ...ymp, ...lisaYmp }) }));
    const koukut = KOUKUT.map((q) => ({ ...q, kaynnista: (ymp) => q.kaynnista({ ...ymp, ...lisaYmp }) }));
    luoToimintopalvelin({ portti: Number(a.toiminnot), juuri, reitit, koukut }).kuuntele()
      .then((p) => process.stderr.write(`toiminnot: kuuntelee 127.0.0.1:${p}\n`))
      .catch((e) => process.stderr.write(`toiminnot: ei kuuntele (${e.code ?? e.message})\n`));
  }
  let kaynnissa = false;
  const ajastettu = async () => {
    if (kaynnissa) return;
    kaynnissa = true;
    try { await kierros(); } finally { kaynnissa = false; }
  };
  await ajastettu();
  setInterval(ajastettu, KIERROS_MS);
  lahde?.kaynnista();
}

main().catch((e) => { process.stderr.write(`adapteri: ${e.message}\n`); process.exit(1); });
