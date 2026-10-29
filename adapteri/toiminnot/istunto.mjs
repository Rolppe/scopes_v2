// Istuntotoiminnot (T-67, ARK-16, S-10): pakkaa, automaattisiirto, herata ja herata-pois. Käytös = vanhan 8787:n
// (scopes/palvelu/toiminnot.mjs:75-236 ja :301-305, palvelin.mjs:270-277), kopioitu kopioriveineen.
// Sovitus: aja, loki, kello, tila ja juuri tulevat ymp:stä (palvelin.mjs).
//   ymp.tila            jonotiedosto = <tila>/toiminnot-jono.json (oletus ~/.local/state/scopes2); vanhan
//                       ~/.local/state/scopes-toiminnot-jono.json -tiedostoa ei lueta eikä kirjoiteta
//   ymp.jonoVali        jonon purkuajastimen väli ms (oletus 5000; 0 = ei ajastinta); ajastin on unref
//   ymp.odota(ms)       valinnainen (testit): 800 ms:n Escape-tauko; oletus setTimeout
//   ymp.escapeTauko     valinnainen Escape-tauon pituus (oletus 800)
//   ymp.istunnotDir, projektitDir, agyHakemisto, brainHakemisto   valinnaiset (kuten viestit.mjs)
// Jonoajastin käynnistyy moduulikoukulla kaynnista(ymp) → { pysayta() } (palvelin.mjs kutsuu sen kuuntele():n alussa
// ja pysayta():n sulje():ssa): koukku lukee jonon tiedostosta ja purkaa sen, kun ruutu vapautuu.
// Tuonnit vain ./aja.mjs, ./runko.mjs, ./viestit.mjs (keskustelu), ../vanhasta/* ja node:-moduulit (gate.sh tuontitarkistus).
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { agyRuudut } from '../vanhasta/agy-istunto.mjs';
import { istunnotAsync, lueSkoopit } from '../vanhasta/lahteet.mjs';
import { Hylatty, toimintoKaynnissa, varaaToiminto, yksiToiminto } from './aja.mjs';
import { vastaa } from './runko.mjs';
import { keskustelu } from './viestit.mjs';

// kopio: scopes/palvelu/toiminnot.mjs:75-77 (21.10.2026)
// Jonotettavat komennot ryhmittäin: ryhmän uusin korvaa vanhemman (kytkin pois ja päälle → vain /sa), ja herätys lähtee
// ennen siirtoa, koska /automaattisiirto päättää istunnon.
export const JONO_RYHMA = { '/sa': 'herätys', '/sa pois': 'herätys', '/automaattisiirto': 'siirto' };

// Adapterin oma jonotiedosto (S-10): ymp.tila + 'toiminnot-jono.json'.
export const JONOTIEDOSTO = 'toiminnot-jono.json';
export const jonotiedostonPolku = (ymp) => join(ymp.tila ?? join(homedir(), '.local/state/scopes2'), JONOTIEDOSTO);

// kopio: scopes/palvelu/toiminnot.mjs:83-86 (21.10.2026)
// Levyltä luettu jonorivi kelpaa vain jonotettavalla komennolla ja merkkijonokentillä: tiedosto ei saa tuoda
// komentoriville mitään, mitä puhelin ei olisi voinut jonottaa.
const kelpaaJonoon = (j) => j && typeof j.nimi === 'string' && typeof j.istunto === 'string' &&
  typeof j.toiminto === 'string' && Object.hasOwn(JONO_RYHMA, j.komento) && Number.isFinite(j.aika);

// Jonon tila jonotiedostoa kohden (vanhassa luoToiminnot-sulkeuman muuttujat jono ja ajastin; kaynnissa on aja.mjs:n yhteinen
// toimintolukko, T-68). Pyynnöittäin
// luotu ymp (palvelin.mjs / testien lisäykset) päivittyy tilaan, jotta ajastin käyttää tuoreinta ajajaa ja hakemistoja.
const TILAT = new Map();

function luoTila(ymp, jonoTiedosto) {
  const t = { ymp, ajastin: null, pysayta() { if (t.ajastin) { clearInterval(t.ajastin); t.ajastin = null; } } };
  const aja = (komento, argv, valinnat) => t.ymp.aja(komento, argv, valinnat);
  const kello = () => (t.ymp.kello ?? Date.now)();
  const odota = (ms) => (t.ymp.odota ?? ((m) => new Promise((ok) => setTimeout(ok, m))))(ms);
  const asetukset = () => ({
    juuri: t.ymp.juuri,
    istunnotDir: t.ymp.istunnotDir ?? process.env.CLAUDE_ISTUNNOT_DIR ?? join(homedir(), '.claude/sessions'),
    projektitDir: t.ymp.projektitDir ?? process.env.CLAUDE_PROJEKTIT_DIR ?? join(homedir(), '.claude/projects'),
    agyHakemisto: t.ymp.agyHakemisto,
    brainHakemisto: t.ymp.brainHakemisto,
  });
  const escapeTauko = () => t.ymp.escapeTauko ?? 800;
  const jono = new Map(); // `${skooppi}\n${ryhmä}` → { nimi, istunto, komento, toiminto, aika }
  t.jono = jono;

// kopio: scopes/palvelu/toiminnot.mjs:96-113 (21.10.2026)
  // Tallennus kirjoittaa väliaikaiseen ja nimeää sen, ettei kesken katkennut kirjoitus jätä rikkinäistä tiedostoa.
  const tallennaJono = () => {
    if (jonoTiedosto) {
      try {
        mkdirSync(dirname(jonoTiedosto), { recursive: true });
        writeFileSync(`${jonoTiedosto}.tmp`, JSON.stringify([...jono.values()]) + '\n');
        renameSync(`${jonoTiedosto}.tmp`, jonoTiedosto);
      } catch { /* tallennus ei estä toimintoa */ }
    }
    // T-109: jono julkaistaan S-5b-lajina; muutos (lisäys, poisto, purku) käynnistää heti-kierroksen, ei odoteta.
    try { Promise.resolve(t.ymp.lahdeKierros?.()).catch(() => {}); } catch { /* kierros ei estä toimintoa */ }
  };
  const kaynnistaAjastin = () => {
    const jonoVali = t.ymp.jonoVali ?? 5_000;
    if (jonoVali && !t.ajastin) { t.ajastin = setInterval(() => { puraJono().catch(() => {}); }, jonoVali); t.ajastin.unref(); }
  };
  if (jonoTiedosto) {
    let rivit = [];
    try { rivit = JSON.parse(readFileSync(jonoTiedosto, 'utf8')); } catch { /* ei jonoa tai rikki: tyhjä */ }
    for (const j of Array.isArray(rivit) ? rivit : []) if (kelpaaJonoon(j)) jono.set(`${j.nimi}\n${JONO_RYHMA[j.komento]}`, j);
    if (jono.size) kaynnistaAjastin();
  }

// kopio: scopes/palvelu/toiminnot.mjs:115-118 (21.10.2026); sovitus: loki tulee ymp:stä (aikaleiman lisää palvelin.mjs)
  const kirjaa = (rivi) => { try { t.ymp.loki?.(rivi); } catch { /* loki ei estä toimintoa */ } };

// kopio: scopes/palvelu/toiminnot.mjs:120-121 (21.10.2026); sovitus: asynkroninen kuten viestit.mjs (istunnotAsync)
  const skoopinIstunnot = async (nimi, skoopit) =>
    (await istunnotAsync({ ...asetukset(), aja, skooppiNimet: Object.keys(skoopit) })).filter((i) => i.skooppi === nimi);

// kopio: scopes/palvelu/toiminnot.mjs:123-134 (21.10.2026)
  // Ruudun prosessin on oltava istunnon claude tai sen vanhempi, ettei näppäily osu väärään ruutuun.
  async function tarkistaRuutu(i) {
    const r = await aja('tmux', ['display-message', '-p', '-t', i.ruutu, '#{pane_pid}']);
    const ruudunPid = Number(r.stdout.trim());
    if (r.koodi !== 0 || !(ruudunPid === i.pid || ruudunPid === i.vanhempi)) throw new Hylatty(409, 'istunnon tmux-ruutu ei täsmää');
  }
  async function kirjoita(i, teksti) {
    for (const a of [['-l', teksti], ['Enter']]) {
      const r = await aja('tmux', ['send-keys', '-t', i.ruutu, ...a]);
      if (r.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
    }
  }

// kopio: scopes/palvelu/toiminnot.mjs:148-154 (21.10.2026)
  // Istunnon viimeinen viesti on vastaamaton monivalinta (AskUserQuestion).
  function kysymysAuki(i) {
    let transkripti = '';
    try { transkripti = readFileSync(i.polku, 'utf8'); } catch { return false; }
    const viimeinen = keskustelu(transkripti, 1)[0];
    return viimeinen?.rooli === 'kysymys' && !viimeinen.vastattu;
  }

// kopio: scopes/palvelu/toiminnot.mjs:156-199 (21.10.2026); sovitus: skoopinIstunnot odotetaan, odotus ja kello ymp:stä
  // Valmis komento skoopin ainoaan vapaaseen tmux-istuntoon, kun sen vuoro on valmis; jonotettava komento odottaa
  // varatun istunnon vapautumista.
  async function istuntoon(nimi, komento, toiminto) {
    const skoopit = lueSkoopit(t.ymp.juuri);
    if (!skoopit[nimi]) throw new Hylatty(404, 'tuntematon skooppi');
    const omat = (await skoopinIstunnot(nimi, skoopit)).filter((i) => i.ruutu && !i.pakattu);
    if (omat.length !== 1) {
      if (omat.length === 0) {
        const agy = await agyRuudut(aja, nimi);
        if (agy.length === 1) {
          const [r] = agy;
          for (const a of [['-l', komento], ['Enter']]) {
            const k = await aja('tmux', ['send-keys', '-t', r.ruutu, ...a]);
            if (k.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
          }
          return { istunto: r.ruutu, komento };
        }
      }
      throw new Hylatty(409, omat.length ? 'skoopissa on useita tmux-istuntoja' : `skoopilla ei ole tmux-istuntoa, johon ${komento} voi lähettää`);
    }
    const [i] = omat;
    const ryhma = JONO_RYHMA[komento];
    if (ryhma && jono.delete(`${nimi}\n${ryhma}`)) tallennaJono();
    if (i.tila === 'waiting' && (komento === '/pakkaa' || komento === '/automaattisiirto') && (i.kysely || kysymysAuki(i))) {
      // Kuten viestin lähetys (viestit.mjs): Enter valitsisi korostetun vaihtoehdon, joten Escape ensin ja tauko,
      // ettei Escape + kirjain tulkitu Alt-näppäimeksi.
      await tarkistaRuutu(i);
      const k = await aja('tmux', ['send-keys', '-t', i.ruutu, 'Escape']);
      if (k.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
      await odota(escapeTauko());
      await kirjoita(i, komento);
      return { istunto: i.id, komento, kysymysSuljettiin: true };
    }
    if (i.tila !== 'idle') {
      if (!ryhma) throw new Hylatty(409, `istunto on varattu (${i.tila ?? 'tila tuntematon'}); yritä vuoron jälkeen`);
      jono.set(`${nimi}\n${ryhma}`, { nimi, istunto: i.id, komento, toiminto, aika: kello() });
      tallennaJono();
      kaynnistaAjastin();
      return { istunto: i.id, komento, jonossa: true };
    }
    await tarkistaRuutu(i);
    await kirjoita(i, komento);
    return { istunto: i.id, komento };
  }

// kopio: scopes/palvelu/toiminnot.mjs:201-236 (21.10.2026); sovitus: skoopinIstunnot odotetaan, odotus ymp:stä; kaynnissa = yhteinen
// toimintolukko (aja.mjs, T-68), joka varataan ennen kuin komento poistetaan jonosta (pura voi ottaa lukon välissä)
  // Lähettää jonosta yhden komennon kerrallaan istuntoon, joka on taas vapaa; komento putoaa, jos istunto päättyi
  // tai pakattiin. Yksi lähetys kierrosta kohden, koska komento varaa istunnon ennen seuraavaa.
  // T-107: skoopinIstunnot on asynkroninen (vanha oli synkroninen), joten kierrokset eivät aja päällekkäin (t.purkaa), ja
  // odotuksen ja lukon jälkeen alkion on oltava yhä jonossa (jono.get(avain) === j): ei tuplalähetystä eikä poistettua komentoa.
  async function puraJono() {
    if (t.purkaa || toimintoKaynnissa(t.ymp)) return;
    t.purkaa = true;
    try { await puraJonoKerran(); } finally { t.purkaa = false; }
    if (!jono.size && t.ajastin) { clearInterval(t.ajastin); t.ajastin = null; }
  }
  async function puraJonoKerran() {
    const jarjestys = [...jono].sort(([, a], [, b]) => (a.komento === '/automaattisiirto') - (b.komento === '/automaattisiirto'));
    for (const [avain, j] of jarjestys) {
      const i = (await skoopinIstunnot(j.nimi, lueSkoopit(t.ymp.juuri))).find((x) => x.id === j.istunto);
      if (jono.get(avain) !== j) continue;
      if (!i || i.pakattu || !i.ruutu) {
        jono.delete(avain);
        tallennaJono();
        kirjaa({ toiminto: j.toiminto, nimi: j.nimi, tulos: 'hylätty', syy: 'jonossa ollut istunto päättyi', istunto: j.istunto });
        continue;
      }
      const kysymys = (j.komento === '/pakkaa' || j.komento === '/automaattisiirto') && i.tila === 'waiting' && (i.kysely || kysymysAuki(i));
      if (i.tila !== 'idle' && !kysymys) continue;
      const vapauta = varaaToiminto(t.ymp, j.toiminto);
      if (!vapauta) break;
      if (jono.get(avain) !== j) { vapauta(); continue; }
      jono.delete(avain);
      tallennaJono();
      try {
        await tarkistaRuutu(i);
        if (kysymys) {
          const k = await aja('tmux', ['send-keys', '-t', i.ruutu, 'Escape']);
          if (k.koodi !== 0) throw new Hylatty(502, 'tmux send-keys epäonnistui');
          await odota(escapeTauko());
        }
        await kirjoita(i, j.komento);
        kirjaa({ toiminto: j.toiminto, nimi: j.nimi, tulos: 'ok', istunto: i.id, komento: j.komento, jonosta: true });
      } catch (e) {
        kirjaa({ toiminto: j.toiminto, nimi: j.nimi, tulos: 'hylätty', syy: e.message, jonosta: true });
      } finally {
        vapauta();
      }
      break;
    }
  }

// kopio: scopes/palvelu/toiminnot.mjs:301-304 (21.10.2026)
  const toteutus = {
    pakkaa: (nimi) => istuntoon(nimi, '/pakkaa', 'pakkaa'),
    automaattisiirto: (nimi) => istuntoon(nimi, '/automaattisiirto', 'automaattisiirto'),
    herata: (nimi) => istuntoon(nimi, '/sa', 'herata'),
    'herata-pois': (nimi) => istuntoon(nimi, '/sa pois', 'herata-pois'),
  };

// kopio: scopes/palvelu/toiminnot.mjs:340-354 (21.10.2026); sovitus: lukko, lokirivit ja vastaus = aja.mjs:n yhteinen yksiToiminto
// (T-68: pura, uusi ja istuntotoiminnot jakavat yhden lukon kuten vanhan yksi kaynnissa)
  async function suorita(toiminto, nimi) {
    if (!Object.hasOwn(toteutus, toiminto)) throw new Hylatty(404, 'tuntematon toiminto');
    return yksiToiminto(t.ymp, toiminto, nimi, () => toteutus[toiminto](nimi));
  }
  t.suorita = suorita;
  t.puraJono = puraJono;
  return t;
}

// Tila jonotiedostoa kohden: luodaan (ja jono luetaan tiedostosta) ensimmäisellä käytöllä.
function haeTila(ymp) {
  const polku = jonotiedostonPolku(ymp);
  let t = TILAT.get(polku);
  if (t) t.ymp = ymp;
  else TILAT.set(polku, t = luoTila(ymp, polku));
  return t;
}

// Moduulikoukku (palvelin.mjs): lukee jonon tiedostosta uudelleen (uudelleenkäynnistys) ja käynnistää purkuajastimen,
// jos jonossa on komentoja; pysayta() pysäyttää ajastimen.
export function kaynnista(ymp) {
  const polku = jonotiedostonPolku(ymp);
  TILAT.get(polku)?.pysayta();
  const t = luoTila(ymp, polku);
  TILAT.set(polku, t);
  return { pysayta() { t.pysayta(); if (TILAT.get(polku) === t) TILAT.delete(polku); } };
}

// kopio: scopes/palvelu/toiminnot.mjs:355-356 (21.10.2026)
// Skoopin jonossa odottavat komennot näkymää varten (GET /api/skoopit/<nimi> → jonossa).
export const jonossa = (ymp, nimi) => [...haeTila(ymp).jono.values()].filter((j) => j.nimi === nimi).map(({ komento, aika }) => ({ komento, aika }));

// T-109: koko jono skoopeittain S-5b-lajia `jono` varten (vain ei-tyhjät skoopit; {} kun jono on tyhjä). Ei luo eikä päivitä tilaa
// (haeTila vaihtaisi t.ymp:n): ennen kaynnista(ymp)-koukkua tai sen jälkeen pysayta():a jono on {}.
export const jonoKaikki = (ymp = {}) => {
  const tulos = {};
  const t = TILAT.get(jonotiedostonPolku(ymp));
  if (t) for (const { nimi, komento, aika } of t.jono.values()) (tulos[nimi] ??= []).push({ komento, aika });
  return tulos;
};

// Reitit. Käsittelijä hakee jonotiedoston tilan ymp:stä. Virheet (Hylatty) muuttuu statukseksi palvelin.mjs:ssä.
// kopio: scopes/palvelu/palvelin.mjs:275-276 (21.10.2026)
const reitti = (toiminto) => ({ metodi: 'POST', kuvio: `/api/skoopit/*/${toiminto}`, toteutettu: true, kasittele: async (req, res, osat, ymp) => {
  req.resume();
  vastaa(res, 200, await haeTila(ymp).suorita(toiminto, osat[0]));
} });
export const REITIT = ['pakkaa', 'automaattisiirto', 'herata', 'herata-pois'].map(reitti);
