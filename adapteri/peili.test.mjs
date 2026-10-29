import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { luoPeili, tiiviste, UUSINTA_MS, JONORAJA, ERARAJA, HYLATTY_TAUKO_MS } from './peili.mjs';

// Mock-ydin: pitää tiedostokohtaista offsetia kuten S-5a. tila.tila = 'ok' | 'poissa' (yhteys katkaistaan); väärä avain → 401, väärä offset → 409.
async function mockYdin() {
  const tila = { tila: 'ok', avain: 'A', offsetit: new Map(), pyynnot: [], raja: Infinity };
  const palvelin = createServer((req, res) => {
    if (tila.tila === 'poissa') { req.socket.destroy(); return; }
    let runko = '';
    req.on('data', (d) => { runko += d; });
    req.on('end', () => {
      const vastaa = (koodi, olio) => { res.writeHead(koodi, { 'content-type': 'application/json' }); res.end(JSON.stringify(olio)); };
      tila.pyynnot.push({ metodi: req.method, url: req.url, auth: req.headers.authorization, runko });
      if (req.headers.authorization !== `Bearer ${tila.avain}`) return vastaa(401, { virhe: 'avain' });
      const m = /^\/api\/peili\/(.+)\/offset$/.exec(req.url);
      if (req.method === 'GET' && m) return vastaa(200, { offset: tila.offsetit.get(decodeURIComponent(m[1])) ?? 0 });
      if (req.method === 'POST' && req.url === '/api/peili' && runko.length > tila.raja) return vastaa(413, { virhe: 'liian suuri' });
      if (req.method === 'POST' && req.url === '/api/peili') {
        const j = JSON.parse(runko);
        assert.equal(j.sha256, tiiviste(j.rivit));
        const nykyinen = tila.offsetit.get(j.tiedosto) ?? 0;
        if (j.offset !== nykyinen) return vastaa(409, { offset: nykyinen });
        const uusi = nykyinen + Buffer.byteLength(j.rivit.map((r) => `${r}\n`).join(''));
        tila.offsetit.set(j.tiedosto, uusi);
        return vastaa(200, { offset: uusi });
      }
      vastaa(404, {});
    });
  });
  await new Promise((r) => palvelin.listen(0, '127.0.0.1', r));
  return { tila, url: `http://127.0.0.1:${palvelin.address().port}`, sulje: () => new Promise((r) => palvelin.close(r)) };
}

function ymparisto() {
  const h = mkdtempSync(join(tmpdir(), 'scopes2-peili-'));
  const projektit = join(h, 'projects');
  mkdirSync(join(projektit, '-home-x'), { recursive: true });
  const avain = join(h, 'avain');
  writeFileSync(avain, 'A\n');
  const polku = join(projektit, '-home-x', 's1.jsonl');
  return { h, projektit, avain, polku, siivoa: () => rmSync(h, { recursive: true, force: true }) };
}

test('200: offset etenee ja loki on yksi rivi per lähetys ilman avainta', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  const lokit = [];
  try {
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: new Map(), loki: (r) => lokit.push(r) });
    writeFileSync(e.polku, '{"a":1}\n{"b":2}\n');
    assert.equal(await peili.alusta(e.polku), 0);
    assert.equal(await peili.kasittele(e.polku), 2);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 16);
    appendFileSync(e.polku, '{"c":3}\n');
    assert.equal(await peili.kasittele(e.polku), 1);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 24);
    assert.equal(await peili.kasittele(e.polku), 0);
    assert.deepEqual(lokit, ['peili -home-x/s1.jsonl +2 → 16', 'peili -home-x/s1.jsonl +1 → 24']);
    assert.ok(lokit.every((r) => !r.includes('A\n') && !/Bearer/.test(r)));
    const post = y.tila.pyynnot.find((p) => p.metodi === 'POST');
    assert.equal(post.auth, 'Bearer A');
    assert.deepEqual(Object.keys(JSON.parse(post.runko)), ['tiedosto', 'offset', 'rivit', 'sha256']);
    peili.sulje();
  } finally { e.siivoa(); await y.sulje(); }
});

test('alusta: käynnistyksessä jatketaan ytimen offsetista', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  try {
    writeFileSync(e.polku, '{"a":1}\n{"b":2}\n');
    y.tila.offsetit.set('-home-x/s1.jsonl', 8);
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: new Map(), loki: () => {} });
    assert.equal(await peili.alusta(e.polku), 8);
    assert.equal(await peili.kasittele(e.polku), 1);
    const post = JSON.parse(y.tila.pyynnot.find((p) => p.metodi === 'POST').runko);
    assert.deepEqual(post.rivit, ['{"b":2}']);
    assert.equal(post.offset, 8);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 16);
  } finally { e.siivoa(); await y.sulje(); }
});

test('409-toipuminen: lähetetään uudelleen ytimen offsetista', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  try {
    writeFileSync(e.polku, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const v = new Map();
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: v, loki: () => {} });
    // Adapteri luulee olevansa alussa, ydin on jo saanut kaksi riviä.
    y.tila.offsetit.set('-home-x/s1.jsonl', 16);
    v.set(e.polku, { koko: -1, mtimeMs: -1, offset: 0 });
    assert.equal(await peili.kasittele(e.polku), 1);
    const postit = y.tila.pyynnot.filter((p) => p.metodi === 'POST').map((p) => JSON.parse(p.runko));
    assert.equal(postit.length, 2);
    assert.equal(postit[0].offset, 0);
    assert.equal(postit[1].offset, 16);
    assert.deepEqual(postit[1].rivit, ['{"c":3}']);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 24);
    assert.equal(v.get(e.polku).offset, 24);
  } finally { e.siivoa(); await y.sulje(); }
});

test('jono ytimen poissa ollessa, purku 5 s uusinnalla (injektoitu kello)', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  let kello = 1_000_000;
  try {
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: new Map(), nyt: () => kello, loki: () => {} });
    writeFileSync(e.polku, '');
    await peili.alusta(e.polku);
    y.tila.tila = 'poissa';
    appendFileSync(e.polku, '{"a":1}\n');
    assert.equal(await peili.kasittele(e.polku), 0);
    appendFileSync(e.polku, '{"b":2}\n');
    assert.equal(await peili.kasittele(e.polku), 0);
    assert.deepEqual(peili.jono(), [
      { tiedosto: '-home-x/s1.jsonl', offset: 0, rivit: ['{"a":1}'] },
      { tiedosto: '-home-x/s1.jsonl', offset: 8, rivit: ['{"b":2}'] },
    ]);
    y.tila.tila = 'ok';
    const ennen = y.tila.pyynnot.length;
    kello += UUSINTA_MS - 1;
    assert.equal(await peili.pura(), false);
    assert.equal(y.tila.pyynnot.length, ennen, 'ei yritystä ennen 5 s');
    kello += 1;
    assert.equal(await peili.pura(), true);
    assert.deepEqual(peili.jono(), []);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 16);
    // Ydin poissa uudelleen purun aikana: uusi yritys taas 5 s päästä.
    y.tila.tila = 'poissa';
    appendFileSync(e.polku, '{"c":3}\n');
    await peili.kasittele(e.polku);
    y.tila.tila = 'ok';
    kello += UUSINTA_MS;
    assert.equal(await peili.pura(), true);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 24);
  } finally { e.siivoa(); await y.sulje(); }
});

test('401 → avain luetaan tiedostosta uudelleen', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  try {
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: new Map(), loki: () => {} });
    y.tila.avain = 'B';
    writeFileSync(e.avain, 'B\n');
    writeFileSync(e.polku, '{"a":1}\n');
    assert.equal(await peili.kasittele(e.polku), 1);
    const auth = y.tila.pyynnot.map((p) => p.auth);
    assert.deepEqual(auth, ['Bearer A', 'Bearer B']);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 8);
  } finally { e.siivoa(); await y.sulje(); }
});

test('401 uudelleenluvun jälkeenkin: rivit eivät katoa, vaan luetaan uudelleen', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  try {
    const v = new Map();
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: v, loki: () => {} });
    y.tila.avain = 'C';
    writeFileSync(e.polku, '{"a":1}\n');
    assert.equal(await peili.kasittele(e.polku), 0);
    assert.equal(v.get(e.polku).offset, 0);
    assert.deepEqual(peili.jono(), []);
    writeFileSync(e.avain, 'C\n');
    assert.equal(await peili.kasittele(e.polku), 1);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 8);
  } finally { e.siivoa(); await y.sulje(); }
});

test('erät: iso lisäys pilkotaan, jokainen runko alle ERARAJA:n ja offset täsmää', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  try {
    y.tila.raja = 2_000_000;
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: new Map(), loki: () => {} });
    // Lainausmerkit kaksinkertaistuvat JSON-koodauksessa: 1 MiB:n luku ylittäisi 2 MB:n rungon yhtenä eränä.
    const rivi = JSON.stringify({ t: '"'.repeat(300_000) });
    writeFileSync(e.polku, `${rivi}\n`.repeat(6));
    await peili.alusta(e.polku);
    assert.equal(await peili.kasittele(e.polku), 6);
    const postit = y.tila.pyynnot.filter((p) => p.metodi === 'POST');
    assert.ok(postit.length > 2, `${postit.length} POSTia`);
    assert.ok(postit.every((p) => p.runko.length <= ERARAJA + 1000), 'runko yli ERARAJA:n');
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 6 * (Buffer.byteLength(rivi) + 1));
    assert.equal(peili.hylatyt(), 0);
  } finally { e.siivoa(); await y.sulje(); }
});

test('413: tiedosto tauolle, rivit eivät katoa, uusi yritys tauon jälkeen', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  let kello = 1_000_000;
  try {
    const v = new Map();
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: v, nyt: () => kello, loki: () => {} });
    writeFileSync(e.polku, '{"a":1}\n');
    await peili.alusta(e.polku);
    y.tila.raja = 10;
    assert.equal(await peili.kasittele(e.polku), 0);
    assert.equal(peili.hylatyt(), 1);
    assert.equal(v.get(e.polku).offset, 0);
    const ennen = y.tila.pyynnot.length;
    assert.equal(await peili.kasittele(e.polku), 0);
    assert.equal(y.tila.pyynnot.length, ennen, 'ei yritystä tauon aikana');
    y.tila.raja = Infinity;
    kello += HYLATTY_TAUKO_MS;
    assert.equal(await peili.kasittele(e.polku), 1);
    assert.equal(y.tila.offsetit.get('-home-x/s1.jsonl'), 8);
  } finally { e.siivoa(); await y.sulje(); }
});

test('jono rajattu JONORAJA:an ytimen poissa ollessa; ylijäämä luetaan levyltä myöhemmin', async () => {
  const y = await mockYdin();
  const e = ymparisto();
  let kello = 1_000_000;
  try {
    const peili = luoPeili({ ydin: y.url, avainTiedosto: e.avain, projektitDir: e.projektit, valimuisti: new Map(), nyt: () => kello, loki: () => {} });
    const rivi = JSON.stringify({ t: 'x'.repeat(100_000) });
    const sisalto = `${rivi}\n`.repeat(10); // ~1 MB per tiedosto
    const polut = Array.from({ length: 12 }, (_, i) => join(e.projektit, '-home-x', `t${i}.jsonl`));
    for (const p of polut) { writeFileSync(p, sisalto); await peili.alusta(p); }
    y.tila.tila = 'poissa';
    for (const p of polut) await peili.kasittele(p);
    assert.ok(peili.jonoTavut() > 0 && peili.jonoTavut() <= JONORAJA, `jono ${peili.jonoTavut()}`);
    y.tila.tila = 'ok';
    kello += UUSINTA_MS;
    assert.equal(await peili.pura(), true);
    for (const p of polut) await peili.kasittele(p);
    assert.equal(peili.jonoTavut(), 0);
    for (let i = 0; i < 12; i++) assert.equal(y.tila.offsetit.get(`-home-x/t${i}.jsonl`), Buffer.byteLength(sisalto));
  } finally { e.siivoa(); await y.sulje(); }
});
