import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lueNdjson } from '../src/ndjson.ts';
import type { ChatTapahtuma } from '../src/ndjson.ts';

function virta(palat: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) { if (i < palat.length) c.enqueue(palat[i++]!); else c.close(); },
  });
}
const enk = new TextEncoder();
async function kaikki(v: ReadableStream<Uint8Array>): Promise<ChatTapahtuma[]> {
  const ulos: ChatTapahtuma[] = [];
  for await (const t of lueNdjson(v)) ulos.push(t);
  return ulos;
}

describe('lueNdjson', () => {
  it('lukee pala/valmis-tapahtumat', async () => {
    const t = await kaikki(virta([enk.encode('{"tyyppi":"pala","teksti":"a"}\n{"tyyppi":"valmis","vastaus":"a","keskustelu":"k-1"}\n')]));
    assert.deepEqual(t, [{ tyyppi: 'pala', teksti: 'a' }, { tyyppi: 'valmis', vastaus: 'a', keskustelu: 'k-1' }]);
  });

  it('pätkitty UTF-8: "ä" jaettuna kahteen pätkään', async () => {
    const tavut = enk.encode('{"tyyppi":"pala","teksti":"ä"}\n');
    const ala = tavut.indexOf(0xc3);
    const t = await kaikki(virta([tavut.slice(0, ala + 1), tavut.slice(ala + 1)]));
    assert.deepEqual(t, [{ tyyppi: 'pala', teksti: 'ä' }]);
  });

  it('vajaa rivi odottaa loppua; tyhjät rivit ohitetaan', async () => {
    const t = await kaikki(virta([enk.encode('\n{"tyyppi":"pa'), enk.encode('la","teksti":"x"}\n\n\n')]));
    assert.deepEqual(t, [{ tyyppi: 'pala', teksti: 'x' }]);
  });

  it('viimeinen rivi ilman rivinvaihtoa luetaan virran lopussa', async () => {
    const t = await kaikki(virta([enk.encode('{"tyyppi":"valmis","vastaus":"v"}')]));
    assert.deepEqual(t, [{ tyyppi: 'valmis', vastaus: 'v' }]);
  });

  it('virhe-tapahtuma välittyy; tuntematon tyyppi ja rikkinäinen JSON ohitetaan', async () => {
    const t = await kaikki(virta([enk.encode('{"tyyppi":"muu"}\nei json\n{"tyyppi":"virhe","virhe":"kaatui"}\n')]));
    assert.deepEqual(t, [{ tyyppi: 'virhe', virhe: 'kaatui' }]);
  });

  it('kuluttajan keskeytys vapauttaa virran', async () => {
    let peruttu = false;
    const v = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(enk.encode('{"tyyppi":"pala","teksti":"a"}\n')); },
      cancel() { peruttu = true; },
    });
    for await (const _ of lueNdjson(v)) break;
    assert.equal(peruttu, true);
  });
});
