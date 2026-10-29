// T-59 (4)(5): vain luku -välitys äpin solmun ja tuotannon ytimen (tunnelin) välissä. Päästää GET/HEAD-pyynnöt ja
// POST /api/hae:n (luku); kaikki muut (POST /api/laheta, PUT /api/tila, POST /api/peili …) → 403, jotta tuotantoon ei kirjoiteta.
// Käyttö: node lukuvalitys.mjs <kuunteluportti> <kohdeportti> <lokitiedosto>. Loki: rivi per estetty pyyntö + laskurit SIGTERMissä.
import http from 'node:http';
import fs from 'node:fs';

const [kuuntelu, kohde, lokipolku] = process.argv.slice(2);
if (!kuuntelu || !kohde || !lokipolku) { console.error('käyttö: lukuvalitys.mjs <portti> <kohdeportti> <loki>'); process.exit(2); }
const laskurit = { paastetty: 0, estetty: 0 };
const loki = (r) => fs.appendFileSync(lokipolku, `${new Date().toISOString()} ${r}\n`);
const sallittu = (m, p) => m === 'GET' || m === 'HEAD' || (m === 'POST' && p.split('?')[0] === '/api/hae');

const palvelin = http.createServer((pyynto, vastaus) => {
  if (!sallittu(pyynto.method, pyynto.url)) {
    laskurit.estetty++;
    loki(`ESTETTY ${pyynto.method} ${pyynto.url.split('?')[0]}`);
    pyynto.resume();
    vastaus.writeHead(403, { 'content-type': 'application/json' }).end('{"virhe":"T-59 lukuvalitys: vain luku"}');
    return;
  }
  laskurit.paastetty++;
  const eteenpain = http.request({ host: '127.0.0.1', port: Number(kohde), method: pyynto.method, path: pyynto.url, headers: pyynto.headers }, (v) => {
    vastaus.writeHead(v.statusCode ?? 502, v.headers);
    v.pipe(vastaus);
  });
  eteenpain.on('error', () => { if (!vastaus.headersSent) vastaus.writeHead(502).end(); else vastaus.destroy(); });
  pyynto.pipe(eteenpain);
});
palvelin.listen(Number(kuuntelu), '127.0.0.1', () => loki(`KUUNTELEE 127.0.0.1:${kuuntelu} → 127.0.0.1:${kohde}`));
const lopeta = () => { loki(`LOPPU paastetty=${laskurit.paastetty} estetty=${laskurit.estetty}`); process.exit(0); };
process.on('SIGTERM', lopeta);
process.on('SIGINT', lopeta);
