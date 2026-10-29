// Toimintoreittien yhteiset apurit (T-63-G): JSON-vastaus, JSON-runko ja NDJSON-virta kuten vanhassa palvelin.mjs:ssä.
import { Hylatty } from './aja.mjs';

export const NDJSON = { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' };

export function vastaa(res, koodi, data) {
  res.writeHead(koodi, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export const kirjoitaNdjson = (res, o) => { if (!res.destroyed) res.write(`${JSON.stringify(o)}\n`); };

// Pyynnön runko JSON-oliona, enintään `raja` tavua (oletus 1 kt; viestit 32 kt). Ylisuuri runko luetaan loppuun talteen
// ottamatta, jotta 413-vastaus ehtii perille. Tyhjä runko = {}.
export function lueRunko(req, raja = 1024) {
  return new Promise((ok, ei) => {
    let data = '';
    let liian = false;
    req.setEncoding('utf8');
    req.on('data', (pala) => { if (!liian) data += pala; if (data.length > raja) liian = true; });
    req.on('end', () => {
      if (liian) return ei(new Hylatty(413, 'runko liian suuri'));
      try { ok(data ? JSON.parse(data) : {}); } catch { ei(new Hylatty(400, 'runko ei ole JSONia')); }
    });
    req.on('error', ei);
  });
}

// Reitti, jota ei ole vielä siirretty: ei terveyslistalla, ja pyyntö saa 501 {"virhe":"ei siirretty"} (palvelin.mjs).
export const tyhja = (metodi, kuvio) => ({ metodi, kuvio, toteutettu: false, kasittele: async () => { throw new Hylatty(501, 'ei siirretty'); } });
