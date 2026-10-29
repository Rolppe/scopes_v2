// T-89: adapterin watch-osio. Linuxilla fs.watchia ei kutsuta (inotify-raja 8192 kaatoi prosessin ENOSPC:iin), rivit kulkevat
// kierroksella; muilla alustoilla watcherin 'error' sulkee watcherin eikä kaada prosessia. Alusta ohitetaan SCOPES2_ALUSTA:lla ja
// fs.watch korvataan --import-esilatauksella, joka kirjaa kutsun ja nostaa ENOSPC-virheen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTERI = join(dirname(fileURLToPath(import.meta.url)), 'adapteri.mjs');
const rivi = (n) => `${JSON.stringify({ type: 'user', message: { content: `rivi ${n}` } })}\n`;

// fs.watch → kirjaa "WATCH-KUTSUTTU" stderriin ja palauttaa watcherin, joka nostaa ENOSPC-virheen 100 ms kuluttua.
const ESILATAUS = `data:text/javascript,${encodeURIComponent(`
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
fs.watch = () => {
  process.stderr.write('WATCH-KUTSUTTU\\n');
  const w = new EventEmitter();
  w.close = () => process.stderr.write('WATCH-SULJETTU\\n');
  setTimeout(() => w.emit('error', Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' })), 100);
  return w;
};
syncBuiltinESMExports();
`)}`;

function fixture() {
  const h = mkdtempSync(join(tmpdir(), 'scopes2-watch-'));
  const projektit = join(h, 'projektit');
  mkdirSync(join(projektit, '-koe'), { recursive: true });
  mkdirSync(join(h, 'koti', '.config', 'scopes2'), { recursive: true });
  writeFileSync(join(h, 'koti', '.config', 'scopes2', 'avain'), 'K');
  const tiedosto = join(projektit, '-koe', 'a.jsonl');
  writeFileSync(tiedosto, rivi(1));
  return { h, projektit, tiedosto };
}

// Mock-ydin: GET offset → 404 (uusi tiedosto), POST /api/peili → 200 { offset + rivien tavut }; saadut = tiedosto → rivien määrä.
function mockYdin() {
  const saadut = new Map();
  const palvelin = createServer((req, res) => {
    let runko = '';
    req.on('data', (c) => { runko += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/peili') {
        const { tiedosto, offset, rivit } = JSON.parse(runko);
        saadut.set(tiedosto, (saadut.get(tiedosto) ?? 0) + rivit.length);
        res.end(JSON.stringify({ offset: offset + rivit.reduce((s, r) => s + Buffer.byteLength(r) + 1, 0) }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  return new Promise((ok) => palvelin.listen(0, '127.0.0.1', () => ok({ palvelin, saadut, url: `http://127.0.0.1:${palvelin.address().port}` })));
}

async function odota(ehto, ms = 15_000) {
  const raja = Date.now() + ms;
  while (Date.now() < raja) {
    if (ehto()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Käynnistää adapterin (ilman --kerran) valitulla alustalla ja suorittaa tarkistukset; siivoaa lopuksi.
async function kokeile(alusta, tarkista) {
  const f = fixture();
  const ydin = await mockYdin();
  const lapsi = spawn(process.execPath, ['--import', ESILATAUS, ADAPTERI, '--ydin', ydin.url, '--projektit', f.projektit], {
    env: { ...process.env, HOME: join(f.h, 'koti'), SCOPES2_ALUSTA: alusta }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let virhe = '';
  lapsi.stderr.on('data', (c) => { virhe += c; });
  try {
    await tarkista({ f, ydin, lapsi, stderr: () => virhe });
  } finally {
    lapsi.kill('SIGKILL');
    ydin.palvelin.close();
    rmSync(f.h, { recursive: true, force: true });
  }
}

test('Linux: fs.watchia ei kutsuta, rivit kulkevat kierroksella', async () => {
  await kokeile('linux', async ({ f, ydin, lapsi, stderr }) => {
    assert.ok(await odota(() => ydin.saadut.get('-koe/a.jsonl') === 1), `ensimmäinen rivi ei päätynyt ytimeen; stderr: ${stderr()}`);
    appendFileSync(f.tiedosto, rivi(2));
    assert.ok(await odota(() => ydin.saadut.get('-koe/a.jsonl') === 2), `lisätty rivi ei päätynyt ytimeen kierroksella; stderr: ${stderr()}`);
    assert.match(stderr(), /fs\.watch: ei Linuxilla \(inotify-raja\); 2000 ms kierros/);
    assert.doesNotMatch(stderr(), /WATCH-KUTSUTTU/);
    assert.equal(lapsi.exitCode, null, 'prosessi kaatui');
  });
});

test('muu alusta: watcherin error sulkee watcherin, prosessi ja kierros jatkavat', async () => {
  await kokeile('darwin', async ({ f, ydin, lapsi, stderr }) => {
    assert.ok(await odota(() => /fs\.watch suljettu \(ENOSPC\)/.test(stderr())), `watcherin virhettä ei käsitelty; stderr: ${stderr()}`);
    assert.match(stderr(), /WATCH-KUTSUTTU/);
    assert.match(stderr(), /WATCH-SULJETTU/);
    assert.equal(lapsi.exitCode, null, 'prosessi kaatui watcherin virheeseen');
    assert.ok(await odota(() => ydin.saadut.get('-koe/a.jsonl') === 1), `ensimmäinen rivi ei päätynyt ytimeen; stderr: ${stderr()}`);
    appendFileSync(f.tiedosto, rivi(2));
    assert.ok(await odota(() => ydin.saadut.get('-koe/a.jsonl') === 2), `virheen jälkeen kierros ei toimittanut riviä; stderr: ${stderr()}`);
    assert.equal(lapsi.exitCode, null);
  });
});
