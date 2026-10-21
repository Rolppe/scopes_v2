#!/usr/bin/env node
// mock-ohjaus.mjs (T-87, ARK-19): mock-adapteri Android-etäohjauksen ja palvelimen UI-testeille. Ei koske oikeaan Androidiin eikä
// palvelimeen (ei adb:tä, ei ssh:ta, ei WoL:ia): vastaa kiinteästi T-79-G:n fixtureista (fixture/ohjaus/, kopio vanhan 8787:n
// käytöksestä) ja kirjaa saamansa pyynnöt UI-testin tarkistettavaksi.
//
//   node mock-ohjaus.mjs --avain-tiedosto <koeytimen avain> [--portti 0] [--portti-tiedosto <polku>] [--ydin <url>] [--elinkaari <polku>]
//
// Koeydin käynnistetään `--adapteri http://127.0.0.1:<portti>` -lipulla (S-10, T-64), joten ydin hakee tämän GET /api/terveys -reitit ja
// välittää ne tänne V2-avaimella (Bearer = koeytimen avain). Reitit, jotka ovat sekä S-6:n siltalistalla että julkaistuina tässä:
//   GET /api/android, /ruutu, /tuotokset, /tuotos, POST /api/android/*, GET/POST /api/palvelin[/*]
// (GET /api/android on oikeassa adapterissa ytimen lähdetilasta, T-84; mock julkaisee sen, jotta testi toimii myös ennen T-84:ää.)
// Testiohjaus (siltalistan /api/android-etuliitteen alla, joten ydin välittää nämä ilman muutoksia):
//   GET  /api/android/koe-loki    → {"pyynnot":[{aika,metodi,polku,runko}…],"ruutuHaut":<n>}  (POST-toiminnot; GET ruutu vain laskuri)
//   POST /api/android/koe-nollaa  → tyhjentää lokin ja palauttaa palvelimen tilaan "linux"
// Vanhan 8787:n rooli: koeydin saa myös `--vanha http://127.0.0.1:<portti> --vanha-avain <avain>`, jolloin oikeaa 8787:ää ei tarvita; mock vastaa
// silloin ytimen siltaamiin listoihin GET /api/skoopit (yksi skooppi "t87", jotta iPhonen NavigationSplitView pääsee detailiin) ja GET /api/rekisterit.
// Lähdetila (S-5b): --ydin <url> → POST /api/lahde/android {"laite":"koe-ohjaus","sisalto":<GET /api/android>} heti ja 30 s välein.
// Lopetus: SIGTERM/SIGINT tai kun --elinkaari-tiedosto häviää (portti poistaa koeytimen hakemiston).
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tassa = dirname(fileURLToPath(import.meta.url));
const HAKEMISTO = join(tassa, '../ScopesCore2/Tests/ScopesCore2Tests/fixture/ohjaus');

// Kelvollinen 108×240 JPEG (suhde kuten 1080×2400-ruudun): tilapalkki ylhäällä, keltainen palkki keskellä.
const JPEG_BASE64 = [
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAbK',
  'ADAAQAAAABAAAA8AAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgA8ABs',
  'AwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicR',
  'QygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SV',
  'lpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAA',
  'ABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJico',
  'KSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8',
  'jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMACQkJCQkJEAkJEBYQEBAWHhYWFhYeJh4eHh4eJi4mJiYmJiYuLi4uLi4uLjc3Nzc3',
  'N0BAQEBASEhISEhISEhISP/bAEMBCwwMEhESHxERH0szKjNLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0',
  'tLS//dAAQAB//aAAwDAQACEQMRAD8A5gVKK9P/AOEH0n/nrP8A99L/APE07/hCdKH/AC0n/wC+l/8Aia995hSPPeHkeZCpRXpI8F6WP+Wk3/fS',
  '/wDxNOHg3Sx/y0m/Nf8A4mpeOpEPCzPORUgr0QeD9MH/AC0m/Nf/AImnDwjpo/5aTfmv/wATUPG0zN4OoefCpBXfDwnpw/5aS/mv/wATTh4V08',
  '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',
].join('');

const REITIT = [
  'GET /api/android',
  'GET /api/android/ruutu',
  'GET /api/android/tuotokset',
  'GET /api/android/tuotos',
  'GET /api/android/koe-loki',
  'POST /api/android/*',
  'GET /api/palvelin',
  'POST /api/palvelin/*',
];

// Vanhan 8787:n skooppilistan rivi (sillan kautta ytimen /api/skoopit, kun ytimellä ei ole omia lähteitä).
const SKOOPPI = { nimi: 't87', seuraava: null, avoimia: 0, vikoja: 0, istuntoja: 0, suurinKonteksti: null, aika: null, tila: 'pakattu' };

const NAPIT = ['takaisin', 'koti', 'enter', 'poista', 'herata', 'nukuta', 'sovellukset'];
const KOKO = [1080, 2400];

function argumentit(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return a;
}

export function luoMock({ avainTiedosto, hakemisto = HAKEMISTO } = {}) {
  let loki = [];
  let ruutuHaut = 0;
  let linuxTila = 'linux';
  const lueAvain = () => { try { return readFileSync(avainTiedosto, 'utf8').trim(); } catch { return ''; } };
  const fx = (nimi) => JSON.parse(readFileSync(join(hakemisto, `${nimi}.json`), 'utf8'));

  const json = (res, status, kohde) => {
    const data = Buffer.from(JSON.stringify(kohde));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
    res.end(data);
  };
  const raaka = (res, status, tyyppi, data) => {
    res.writeHead(status, { 'Content-Type': tyyppi, 'Content-Length': data.length });
    res.end(data);
  };
  const lue = async (req) => {
    const palat = [];
    let koko = 0;
    for await (const p of req) {
      koko += p.length;
      if (koko > 2 << 20) break;
      palat.push(p);
    }
    return Buffer.concat(palat);
  };
  const kirjaa = (metodi, polku, runkoArvo) => {
    loki.push({ aika: new Date().toISOString(), metodi, polku, runko: runkoArvo });
    if (loki.length > 500) loki.shift();
  };

  const linuxVastaus = (toiminto) => {
    if (toiminto === 'kaynnista') {
      const f = linuxTila === 'windows' ? 'linux-kaynnista-windows' : linuxTila === 'sammuksissa' ? 'linux-kaynnista-sammuksissa' : 'linux-kaynnista-linux';
      const v = fx(f);
      linuxTila = v.runko.tila === 'vaihtaa' || v.runko.tila === 'linux' ? 'linux' : linuxTila;
      return v;
    }
    if (toiminto === 'sammuta') {
      const v = fx(linuxTila === 'linux' ? 'linux-sammuta-linux' : linuxTila === 'windows' ? 'linux-sammuta-windows' : 'linux-sammuta-sammuksissa');
      if (v.status === 200) linuxTila = 'sammuksissa';
      return v;
    }
    return fx('linux-tuntematon-toiminto');
  };

  const androidToiminto = (nimi, body) => {
    const o = body && typeof body === 'object' ? body : {};
    switch (nimi) {
      case 'napauta': {
        for (const k of ['x', 'y']) {
          if (typeof o[k] !== 'number' || !(o[k] >= 0 && o[k] <= 1)) return [400, { virhe: `${k} pitää olla luku 0–1` }];
        }
        return [200, { ok: true, piste: [Math.round(o.x * (KOKO[0] - 1)), Math.round(o.y * (KOKO[1] - 1))] }];
      }
      case 'pyyhkaise': return [200, { ok: true }];
      case 'nappi':
        return NAPIT.includes(o.nimi) ? [200, { ok: true }] : [400, fx('android-nappi-tuntematon').runko];
      case 'avaa': case 'uusi': case 'laheta': return [200, { ok: true }];
      case 'kirjoita':
        if (typeof o.teksti !== 'string' || !o.teksti.trim()) return [400, { virhe: 'teksti puuttuu' }];
        if (o.teksti.length > 8000) return [413, { virhe: 'teksti yli 8000 merkkiä' }];
        return [200, { ok: true }];
      case 'talteen': return [200, fx('android-talteen').runko];
      default: return [404, { virhe: 'tuntematon toiminto' }];
    }
  };

  const kasittelija = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const polku = url.pathname;
      if (req.method === 'GET' && polku === '/api/terveys') return json(res, 200, { ok: true, adapteri: true, mock: 'ohjaus', reitit: REITIT });
      const avain = lueAvain();
      if (!avain || req.headers.authorization !== `Bearer ${avain}`) return json(res, 401, { virhe: 'avain puuttuu tai väärä' });

      if (req.method === 'GET' && polku === '/api/android/koe-loki') return json(res, 200, { pyynnot: loki, ruutuHaut });
      if (req.method === 'POST' && polku === '/api/android/koe-nollaa') {
        await lue(req);
        loki = [];
        linuxTila = 'linux';
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && polku === '/api/skoopit') return json(res, 200, [SKOOPPI]);
      if (req.method === 'GET' && polku === '/api/rekisterit') return json(res, 200, []);
      if (req.method === 'GET' && polku === '/api/android') return json(res, 200, fx('android-tila').runko);
      if (req.method === 'GET' && polku === '/api/android/ruutu') {
        ruutuHaut++;
        return raaka(res, 200, 'image/jpeg', Buffer.from(JPEG_BASE64, 'base64'));
      }
      if (req.method === 'GET' && polku === '/api/android/tuotokset') return json(res, 200, fx('android-tuotokset').runko);
      if (req.method === 'GET' && polku === '/api/android/tuotos') {
        kirjaa('GET', url.pathname + url.search, null);
        const f = fx('android-tuotos');
        if (url.searchParams.get('polku') !== '/sdcard/Download/raportti.txt') return json(res, 404, { virhe: 'tiedostoa ei saatu: cat: No such file' });
        return raaka(res, 200, f.runko.tyyppi, Buffer.from(f.runko.base64, 'base64'));
      }
      if (req.method === 'GET' && polku === '/api/palvelin') return json(res, 200, linuxTila === 'sammuksissa' ? { tila: 'sammuksissa' } : { tila: linuxTila, osoite: '192.0.2.99' });

      if (req.method === 'POST' && polku === '/api/android/liite') {
        const data = await lue(req);
        kirjaa('POST', url.pathname + url.search, data.toString('utf8'));
        if (data.length === 0) return json(res, 400, { virhe: 'liite on tyhjä' });
        const nimi = `scopes-080000-${url.searchParams.get('nimi') ?? 'liite'}`;
        return json(res, 200, { ok: true, nimi, liitetty: true, lahetetty: Boolean(url.searchParams.get('teksti')) });
      }
      const android = /^\/api\/android\/([^/]+)$/.exec(polku);
      if (req.method === 'POST' && android) {
        const data = await lue(req);
        let body = null;
        try { body = data.length ? JSON.parse(data.toString('utf8')) : null; } catch { body = data.toString('utf8'); }
        kirjaa('POST', url.pathname + url.search, body);
        const [status, vastaus] = androidToiminto(decodeURIComponent(android[1]), body);
        return json(res, status, vastaus);
      }
      const linux = /^\/api\/palvelin\/([^/]+)$/.exec(polku);
      if (req.method === 'POST' && linux) {
        const data = await lue(req);
        let body = null;
        try { body = data.length ? JSON.parse(data.toString('utf8')) : null; } catch { body = data.toString('utf8'); }
        kirjaa('POST', url.pathname + url.search, body);
        const v = linuxVastaus(decodeURIComponent(linux[1]));
        return json(res, v.status, v.runko);
      }
      req.resume();
      return json(res, 404, { virhe: 'tuntematon polku' });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      json(res, 500, { virhe: String(e.message ?? e) });
    }
  };

  return { palvelin: createServer(kasittelija), tila: () => ({ loki, ruutuHaut, linuxTila }), sisalto: () => fx('android-tila').runko };
}

async function siemenna(ydin, avain, sisalto) {
  const r = await fetch(`${ydin}/api/lahde/android`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${avain}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ laite: 'koe-ohjaus', sisalto }),
    signal: AbortSignal.timeout(5000),
  });
  return r.ok;
}

async function main() {
  const a = argumentit(process.argv.slice(2));
  if (!a['avain-tiedosto']) { console.error('käyttö: mock-ohjaus.mjs --avain-tiedosto <polku> [--portti 0] [--portti-tiedosto <polku>] [--ydin <url>] [--elinkaari <polku>]'); process.exit(2); }
  for (const f of ['android-tila', 'android-tuotokset', 'android-tuotos', 'android-talteen', 'linux-kaynnista-linux', 'linux-sammuta-linux']) {
    if (!existsSync(join(HAKEMISTO, `${f}.json`))) { console.error(`MOCK-OHJAUS: fixture puuttuu: ${f}`); process.exit(2); }
  }
  const mock = luoMock({ avainTiedosto: a['avain-tiedosto'] });
  await new Promise((ok, virhe) => { mock.palvelin.once('error', virhe); mock.palvelin.listen(Number(a.portti ?? 0), '127.0.0.1', ok); });
  const portti = mock.palvelin.address().port;
  if (a['portti-tiedosto']) writeFileSync(a['portti-tiedosto'], `${portti}\n`);
  console.log(`MOCK-OHJAUS: portti ${portti}`);

  const sulje = () => { mock.palvelin.close(); process.exit(0); };
  process.on('SIGTERM', sulje);
  process.on('SIGINT', sulje);
  if (a.elinkaari) setInterval(() => { if (!existsSync(a.elinkaari)) sulje(); }, 2000).unref?.();

  if (a.ydin) {
    // Lähdetila koeytimeen (S-5b): ydin voi olla vielä käynnistymässä, joten yritetään kunnes onnistuu; sen jälkeen elossaolo 30 s välein.
    const avain = () => { try { return readFileSync(a['avain-tiedosto'], 'utf8').trim(); } catch { return ''; } };
    let onnistui = false;
    for (let i = 0; i < 90 && !onnistui; i++) {
      try { onnistui = await siemenna(a.ydin, avain(), mock.sisalto()); } catch { /* ydin ei vastaa vielä */ }
      if (!onnistui) await new Promise((v) => setTimeout(v, 1000));
    }
    console.log(onnistui ? 'MOCK-OHJAUS: lähdetila android siemennetty' : 'MOCK-OHJAUS: lähdetilan siemennys epäonnistui');
    setInterval(() => { siemenna(a.ydin, avain(), mock.sisalto()).catch(() => {}); }, 30_000);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
