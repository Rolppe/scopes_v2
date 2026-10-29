// Kuormatesti (T-24-G-jatko, T-34 ajo 1): adapteri --kerran satoja transkripteja vasten rajatulla V8-keolla.
// Tuotannossa 3476 tiedostoa (2,4 GB) yhtä aikaa ajoi keon täyteen; tässä 300 × 512 KiB = 150 MiB 96 MB:n keolla.
// Muisti mitataan lapsiprosessin /proc/<pid>/status VmHWM:stä (/usr/bin/time puuttuu koneelta).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTERI = join(dirname(fileURLToPath(import.meta.url)), 'adapteri.mjs');
const TIEDOSTOJA = 300;
const KOKO = 512 * 1024;
const KEKO_MB = 96;
const HWM_RAJA_KB = 250 * 1024;

function fixture() {
  const h = mkdtempSync(join(tmpdir(), 'scopes2-kuorma-'));
  const projektit = join(h, 'projektit', '-koe');
  mkdirSync(projektit, { recursive: true });
  mkdirSync(join(h, 'koti', '.config', 'scopes2'), { recursive: true });
  writeFileSync(join(h, 'koti', '.config', 'scopes2', 'avain'), 'K');
  const rivi = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } })}\n`;
  const sisalto = rivi.repeat(Math.floor(KOKO / rivi.length));
  for (let i = 0; i < TIEDOSTOJA; i++) writeFileSync(join(projektit, `${String(i).padStart(4, '0')}.jsonl`), sisalto);
  return { h, projektit: join(h, 'projektit'), tavut: TIEDOSTOJA * Buffer.byteLength(sisalto) };
}

// Mock-ydin: GET offset → 404 (uusi tiedosto), POST /api/peili → 200 { offset + rivien tavut }.
function mockYdin({ katkaiseEnsimmainen = false } = {}) {
  const saadut = new Map();
  let katkaistu = false;
  const palvelin = createServer((req, res) => {
    let runko = '';
    req.on('data', (c) => { runko += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/peili' && katkaiseEnsimmainen && !katkaistu) { katkaistu = true; req.socket.destroy(); return; }
      if (req.method === 'POST' && req.url === '/api/peili' && runko.length > 2_000_000) { res.statusCode = 413; res.end('{}'); return; }
      if (req.method === 'POST' && req.url === '/api/peili') {
        const { tiedosto, offset, rivit } = JSON.parse(runko);
        const tavut = rivit.reduce((s, r) => s + Buffer.byteLength(r) + 1, 0);
        saadut.set(tiedosto, offset + tavut);
        res.end(JSON.stringify({ offset: offset + tavut }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  return new Promise((ok) => palvelin.listen(0, '127.0.0.1', () => ok({ palvelin, saadut, url: `http://127.0.0.1:${palvelin.address().port}` })));
}

function ajaAdapteri({ h, projektit }, url, env = {}) {
  return new Promise((ok) => {
    const lapsi = spawn(process.execPath, [`--max-old-space-size=${KEKO_MB}`, ADAPTERI, '--ydin', url, '--projektit', projektit, '--kerran'], {
      env: { ...process.env, HOME: join(h, 'koti'), ...env }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let hwm = 0;
    let virhe = '';
    lapsi.stderr.on('data', (c) => { virhe = (virhe + c).slice(-2000); });
    const mittaa = () => {
      try { hwm = Math.max(hwm, Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${lapsi.pid}/status`, 'utf8'))?.[1] ?? 0)); } catch { /* päättyi */ }
    };
    const ajastin = setInterval(mittaa, 20);
    lapsi.on('exit', (koodi) => { clearInterval(ajastin); ok({ koodi, hwm, virhe }); });
  });
}

test('300 transkriptia (150 MiB) 96 MB:n keolla: kaikki peilattu, VmHWM rajassa', { timeout: 180_000 }, async () => {
  const f = fixture();
  const y = await mockYdin();
  try {
    const t = await ajaAdapteri(f, y.url);
    assert.equal(t.koodi, 0, `adapteri exit ${t.koodi}: ${t.virhe.split('\n').filter((r) => !r.startsWith('peili ')).slice(-5).join(' | ')}`);
    assert.equal(y.saadut.size, TIEDOSTOJA);
    assert.equal([...y.saadut.values()].reduce((s, v) => s + v, 0), f.tavut);
    assert.ok(t.hwm > 0 && t.hwm < HWM_RAJA_KB, `VmHWM ${t.hwm} kB ≥ ${HWM_RAJA_KB} kB`);
    process.stderr.write(`kuorma: ${TIEDOSTOJA} tiedostoa, ${(f.tavut / 1048576).toFixed(0)} MiB, VmHWM ${t.hwm} kB\n`);
  } finally {
    y.palvelin.close();
    rmSync(f.h, { recursive: true, force: true });
  }
});

test('ensimmäinen POST katkaistaan: jono pysyy rajattuna eikä keko täyty', { timeout: 180_000 }, async () => {
  const f = fixture();
  const y = await mockYdin({ katkaiseEnsimmainen: true });
  try {
    const t = await ajaAdapteri(f, y.url);
    // --kerran: yksi kierros; jonoon jääneet ja levylle palautetut erät → exit 1, mutta ei OOM:ia (exit null).
    assert.ok(t.koodi === 0 || t.koodi === 1, `adapteri exit ${t.koodi}: ${t.virhe.split('\n').filter((r) => !r.startsWith('peili ')).slice(-5).join(' | ')}`);
    assert.ok(t.hwm > 0 && t.hwm < HWM_RAJA_KB, `VmHWM ${t.hwm} kB ≥ ${HWM_RAJA_KB} kB`);
    assert.ok(!/hylätty 413/.test(t.virhe), '413 mock-ytimeltä');
    process.stderr.write(`kuorma katkolla: exit ${t.koodi}, VmHWM ${t.hwm} kB, ${y.saadut.size} tiedostoa perillä\n`);
  } finally {
    y.palvelin.close();
    rmSync(f.h, { recursive: true, force: true });
  }
});
