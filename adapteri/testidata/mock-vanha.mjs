#!/usr/bin/env node
// Koe-"vanha palvelu" T-25:n gatelle: minimaalinen lukurajapinta ilman avainta ja ilman tilaa.
//   node scopes2/adapteri/testidata/mock-vanha.mjs <portti>
// Vastaa /api/terveys, /api/skoopit, /api/skoopit/<nimi>, /api/skoopit/<nimi>/viestit ja /api/agentit kiinteällä sisällöllä.
import { createServer } from 'node:http';

const portti = Number(process.argv[2]);
if (!Number.isInteger(portti) || portti < 1) { console.error('käyttö: mock-vanha.mjs <portti>'); process.exit(2); }
const NIMET = ['koe-a', 'koe-b', 'koe-c'];
const json = (res, koodi, runko) => { res.writeHead(koodi, { 'content-type': 'application/json' }); res.end(JSON.stringify(runko)); };

createServer((req, res) => {
  const polku = new URL(req.url, 'http://x').pathname;
  if (polku === '/api/terveys') return json(res, 200, { ok: true });
  if (polku === '/api/skoopit') return json(res, 200, NIMET.map((nimi) => ({ nimi, jonossa: 0 })));
  if (polku === '/api/agentit') return json(res, 200, []);
  const m = /^\/api\/skoopit\/([^/]+)(\/viestit)?$/.exec(polku);
  if (m && NIMET.includes(decodeURIComponent(m[1]))) return json(res, 200, m[2] ? [] : { nimi: decodeURIComponent(m[1]), jonossa: 0 });
  return json(res, 404, { virhe: 'ei löydy' });
}).listen(portti, '127.0.0.1');
