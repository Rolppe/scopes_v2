import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erot, vertaileUusinnalla } from './siltavertailu.mjs';

// vertaa-mock: reitti → kierroksittaiset erot; lahde aina ydin.
const mock = (kierrokset) => {
  const laskuri = new Map();
  return async (p) => {
    const i = laskuri.get(p) ?? 0;
    laskuri.set(p, i + 1);
    return { erot: (kierrokset[p] ?? [])[i] ?? [], lahde: 'ydin' };
  };
};

test('uusinta: ohimenevä ero (välimuisti ≤ 15 s) ei laske, pysyvä laskee', async () => {
  const odotetut = [];
  const t = await vertaileUusinnalla(['/a', '/b', '/c'], mock({ '/a': [['.konteksti: 1 ≠ 2'], []], '/b': [['.nimi: x ≠ y'], ['.nimi: x ≠ y']] }), {
    uusintaMs: 20000, odota: async (ms) => { odotetut.push(ms); },
  });
  assert.deepEqual(odotetut, [20000]);
  assert.equal(t.ok, 2);
  assert.equal(t.n, 3);
  assert.equal(t.uusittu, 2);
  assert.equal(t.korjaantui, 1);
  assert.equal(t.ydinta, 3);
  assert.deepEqual(t.eroavat, ['/b .nimi: x ≠ y']);
});

test('ei eroja → ei odotusta; uusintaMs 0 → ensimmäiset erot lasketaan', async () => {
  let odotettiin = false;
  const puhdas = await vertaileUusinnalla(['/a'], mock({}), { odota: async () => { odotettiin = true; } });
  assert.equal(puhdas.ok, 1);
  assert.equal(odotettiin, false);
  const ilman = await vertaileUusinnalla(['/a'], mock({ '/a': [['.konteksti: 1 ≠ 2'], []] }), { uusintaMs: 0, odota: async () => { odotettiin = true; } });
  assert.equal(ilman.ok, 0);
  assert.equal(odotettiin, false);
  assert.equal(ilman.uusittu, 0);
});

test('erot: sallitut avaimet ohitetaan, puuttuvat kentät nimetään', () => {
  assert.deepEqual(erot({ a: 1, jonossa: 3 }, { a: 1, jonossa: 4 }), []);
  assert.deepEqual(erot({ istunto: { id: 'i', transkripti: 'p/u.jsonl' } }, { istunto: { id: 'i' } }), []);
  assert.deepEqual(erot({ a: 1 }, { a: 1, b: 2 }), ['.b: puuttuu ytimestä']);
});
