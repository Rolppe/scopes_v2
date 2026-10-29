#!/usr/bin/env node
// Deterministinen fixture T-25:lle: 6 Claude-istuntoa muodossa, jonka transkriptit.mjs lukee.
//   node scopes2/adapteri/testidata/luo-istunnot6.mjs [kohde=<tämä hakemisto>/istunnot6]
// Tuottaa kohde/istunnot/<pid>.json (istuntotiedosto) ja kohde/projektit/<projektiNimi(cwd)>/<sessionId>.jsonl.
// Sama syöte → samat tavut. Istunto 6 päättyy vajaaseen riviin (ei rivinvaihtoa), jota peilin ei kuulu lähettää.

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tama = dirname(fileURLToPath(import.meta.url));
const kohde = resolve(process.argv[2] ?? join(tama, 'istunnot6'));
const projektiNimi = (cwd) => cwd.replace(/[/_.]/g, '-'); // kuten scopes/palvelu/lahteet.mjs

const uuid = (n) => {
  const h = createHash('sha1').update(`scopes2-istunnot6-${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

rmSync(kohde, { recursive: true, force: true });
mkdirSync(join(kohde, 'istunnot'), { recursive: true });
const KANTA = Date.UTC(2026, 9, 1, 12, 0, 0);

for (let n = 1; n <= 6; n++) {
  const id = uuid(n);
  const cwd = `/koe/projekti_${(n % 3) + 1}/alue.${n}`;
  const pid = 910000 + n;
  writeFileSync(join(kohde, 'istunnot', `${pid}.json`), `${JSON.stringify({
    pid, sessionId: id, cwd, startedAt: KANTA + n * 60000, procStart: 1000 + n, status: 'idle', name: `koe-${n}`, entrypoint: 'cli',
  })}\n`);
  const rivit = [];
  for (let k = 0; k < 3 + n * 2; k++) {
    const aika = new Date(KANTA + n * 60000 + k * 1000).toISOString();
    if (k % 2 === 0) {
      rivit.push(JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: aika, message: { role: 'user', content: `kysymys ${n}.${k} ääkköset åäö ✓` } }));
    } else {
      rivit.push(JSON.stringify({
        type: 'assistant', sessionId: id, cwd, timestamp: aika,
        message: { role: 'assistant', content: [{ type: 'text', text: `vastaus ${n}.${k}` }], usage: { input_tokens: 10 * n + k, output_tokens: 5 + k } },
      }));
    }
  }
  let teksti = rivit.join('\n') + '\n';
  if (n === 6) teksti += '{"type":"assistant","vajaa":'; // kesken kirjoitettu rivi
  const hakemisto = join(kohde, 'projektit', projektiNimi(cwd));
  mkdirSync(hakemisto, { recursive: true });
  writeFileSync(join(hakemisto, `${id}.jsonl`), teksti);
}
console.log(`fixture: ${kohde}`);
