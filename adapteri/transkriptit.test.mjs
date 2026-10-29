import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { istuntotiedostot, lueLisays, konteksti, projektiNimi } from './transkriptit.mjs';

const hakemisto = () => mkdtempSync(join(tmpdir(), 'scopes2-transkriptit-'));
const r1 = '{"type":"user","n":1}';
const r2 = '{"type":"assistant","n":2,"ä":"ö"}';

test('(a) toinen lueLisays-kutsu lukee 0 tavua', () => {
  const h = hakemisto();
  try {
    const p = join(h, 'a.jsonl');
    writeFileSync(p, `${r1}\n${r2}\n`);
    const v = new Map();
    const eka = lueLisays(p, v);
    assert.deepEqual(eka.rivit, [r1, r2]);
    assert.equal(eka.luettu, Buffer.byteLength(`${r1}\n${r2}\n`));
    assert.equal(eka.alku, 0);
    const toka = lueLisays(p, v);
    assert.equal(toka.luettu, 0);
    assert.deepEqual(toka.rivit, []);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('(b) lisätty rivi → luettu = lisäyksen tavut', () => {
  const h = hakemisto();
  try {
    const p = join(h, 'b.jsonl');
    writeFileSync(p, `${r1}\n`);
    const v = new Map();
    lueLisays(p, v);
    appendFileSync(p, `${r2}\n`);
    const r = lueLisays(p, v);
    assert.deepEqual(r.rivit, [r2]);
    assert.equal(r.luettu, Buffer.byteLength(`${r2}\n`));
    assert.equal(r.alku, Buffer.byteLength(`${r1}\n`));
    assert.equal(v.get(p).offset, Buffer.byteLength(`${r1}\n${r2}\n`));
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('(c) vajaa rivi ei etene offsetia', () => {
  const h = hakemisto();
  try {
    const p = join(h, 'c.jsonl');
    writeFileSync(p, `${r1}\n{"type":"assi`);
    const v = new Map();
    const r = lueLisays(p, v);
    assert.deepEqual(r.rivit, [r1]);
    assert.equal(v.get(p).offset, Buffer.byteLength(`${r1}\n`));
    appendFileSync(p, 'stant"}');
    const kesken = lueLisays(p, v);
    assert.equal(kesken.luettu, 0);
    assert.equal(v.get(p).offset, Buffer.byteLength(`${r1}\n`));
    appendFileSync(p, '\n');
    const valmis = lueLisays(p, v);
    assert.deepEqual(valmis.rivit, ['{"type":"assistant"}']);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('(d) lyhyemmäksi korvattu tiedosto → nollattu, luetaan alusta', () => {
  const h = hakemisto();
  try {
    const p = join(h, 'd.jsonl');
    writeFileSync(p, `${r1}\n${r2}\n`);
    const v = new Map();
    lueLisays(p, v);
    writeFileSync(p, '{"x":1}\n');
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    const r = lueLisays(p, v);
    assert.equal(r.nollattu, true);
    assert.equal(r.alku, 0);
    assert.deepEqual(r.rivit, ['{"x":1}']);
    assert.equal(v.get(p).offset, 8);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('lukuraja: iso lisäys luetaan osissa (kesken), kunnes loppu', () => {
  const h = hakemisto();
  try {
    const p = join(h, 'e.jsonl');
    writeFileSync(p, `${r1}\n${r1}\n${r1}\n`);
    const v = new Map();
    const eka = lueLisays(p, v, 30);
    assert.equal(eka.kesken, true);
    assert.deepEqual(eka.rivit, [r1]);
    const toka = lueLisays(p, v, 30);
    assert.deepEqual(toka.rivit, [r1]);
    const kolmas = lueLisays(p, v, 30);
    assert.deepEqual(kolmas.rivit, [r1]);
    assert.equal(kolmas.kesken, undefined);
    assert.equal(lueLisays(p, v, 30).luettu, 0);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('istuntotiedostot: elävä istunto fixturesta, /proc-mock hakemistona', () => {
  const h = hakemisto();
  try {
    const istunnot = join(h, 'sessions');
    const proc = join(h, 'proc');
    mkdirSync(istunnot);
    // Elävä: procStart täsmää kenttään 22.
    const kentat = (ppid, alku) => `S ${ppid} ${Array.from({ length: 17 }, (_, i) => i).join(' ')} ${alku} 0 0`;
    mkdirSync(join(proc, '111'), { recursive: true });
    writeFileSync(join(proc, '111', 'stat'), `111 (claude code) ${kentat(5, 9999)}\n`);
    writeFileSync(join(istunnot, '111.json'), JSON.stringify({
      sessionId: 'abc-1', cwd: '/home/x/proj.a', name: 'scopes2 adapteri', status: 'waiting', waitingFor: 'input needed',
      startedAt: 42, pid: 111, procStart: 9999, tmux: 'main:1.%26', entrypoint: 'cli',
    }));
    // Kierrätetty pid: procStart ei täsmää.
    mkdirSync(join(proc, '222'), { recursive: true });
    writeFileSync(join(proc, '222', 'stat'), `222 (node) ${kentat(1, 1)}\n`);
    writeFileSync(join(istunnot, '222.json'), JSON.stringify({ sessionId: 'vanha', cwd: '/x', pid: 222, procStart: 7 }));
    // Kuollut: ei /proc-merkintää. Rikkinäinen JSON ja väärä nimi ohitetaan.
    writeFileSync(join(istunnot, '333.json'), JSON.stringify({ sessionId: 'kuollut', cwd: '/x', pid: 333, procStart: 1 }));
    writeFileSync(join(istunnot, '444.json'), '{rikki');
    writeFileSync(join(istunnot, 'muu.json'), '{}');

    const tulos = istuntotiedostot(istunnot, proc);
    assert.deepEqual(tulos, [{
      id: 'abc-1', nimi: 'scopes2 adapteri', tila: 'waiting', kysely: true, alkoi: 42, pid: 111, ruutu: '%26',
      polku: join(projektiNimi('/home/x/proj.a'), 'abc-1.jsonl'),
    }]);
    assert.equal(tulos[0].polku, '-home-x-proj-a/abc-1.jsonl');
    assert.equal(istuntotiedostot(istunnot, proc, '/p')[0].polku, '/p/-home-x-proj-a/abc-1.jsonl');
    assert.deepEqual(istuntotiedostot(join(h, 'ei-ole'), proc), []);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('P-9: jäsennys tuodaan vanhasta palvelusta', () => {
  const rivi = JSON.stringify({ type: 'assistant', timestamp: 't', message: { usage: { input_tokens: 1, cache_read_input_tokens: 2 } } });
  assert.deepEqual(konteksti(rivi), { tokenit: 3, aika: 't' });
});
