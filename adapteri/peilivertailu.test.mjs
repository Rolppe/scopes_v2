import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haeKaikki, vertaileUusinnalla } from './peilivertailu.mjs';

// pyynto-mock: palauttaa enintään `kerralla` pyydettyä yksikköä ja loput jatkossa (ytimen /api/hae, T-36 ajo 3).
const mock = (kerralla, { lyhene = true } = {}) => {
  const kutsut = [];
  const pyynto = async (polku, asetukset) => {
    const { idt } = JSON.parse(asetukset.body);
    kutsut.push({ polku, idt });
    const n = Math.max(1, kerralla);
    return { yksikot: idt.slice(0, n).map((id) => ({ id, sisalto: [] })), jatko: lyhene ? idt.slice(n) : idt };
  };
  return { pyynto, kutsut };
};

test('jatko: kutsu toistetaan, kunnes jatko on tyhjä, ja kaikki yksiköt palautetaan', async () => {
  const m = mock(2);
  const idt = ['a:0', 'a:10', 'a:20', 'a:30', 'a:40'];
  const y = await haeKaikki(m.pyynto, idt);
  assert.deepEqual([...y.keys()], idt);
  assert.deepEqual(m.kutsut.map((k) => k.idt.length), [5, 3, 1]);
  assert.ok(m.kutsut.every((k) => k.polku === '/api/hae'));
});

test('ilman jatkoa yksi kutsu; jatko, joka ei lyhene, on virhe', async () => {
  const m = mock(10);
  assert.equal((await haeKaikki(m.pyynto, ['a:0', 'a:1'])).size, 2);
  assert.equal(m.kutsut.length, 1);
  await assert.rejects(haeKaikki(mock(1, { lyhene: false }).pyynto, ['a:0', 'a:1']), /jatko ei lyhene/);
});

test('puuttuva jatko-kenttä (ydin ae622c1c: kaikki palautettu) = tyhjä lista', async () => {
  let kutsuja = 0;
  const pyynto = async (_polku, asetukset) => {
    kutsuja++;
    return { yksikot: JSON.parse(asetukset.body).idt.map((id) => ({ id, sisalto: [] })) };
  };
  assert.equal((await haeKaikki(pyynto, ['a:0', 'a:1', 'a:2'])).size, 3);
  assert.equal(kutsuja, 1);
});

test('uusinta: elävän tiedoston ohimenevä ero ei laske, pysyvä laskee; uusinta vain eronneille', async () => {
  const uusitut = [];
  const t = await vertaileUusinnalla(
    ['a.jsonl', 'b.jsonl', 'c.jsonl'],
    async (f) => (f === 'c.jsonl' ? [] : ['tiiviste x ≠ levy y']),
    async (f) => { uusitut.push(f); return f === 'b.jsonl' ? ['uusinta: tiiviste x ≠ levyn alku y'] : []; },
  );
  assert.deepEqual(uusitut, ['a.jsonl', 'b.jsonl']);
  assert.equal(t.ok, 2);
  assert.equal(t.n, 3);
  assert.equal(t.uusittu, 2);
  assert.equal(t.korjaantui, 1);
  assert.deepEqual(t.eroavat, ['b.jsonl: uusinta: tiiviste x ≠ levyn alku y']);
});

test('ei eroja → ei uusintaa', async () => {
  let uusittiin = false;
  const t = await vertaileUusinnalla(['a.jsonl'], async () => [], async () => { uusittiin = true; return []; });
  assert.equal(t.ok, 1);
  assert.equal(uusittiin, false);
});
