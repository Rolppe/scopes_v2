import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiVirhe, AvainPuuttuu, luoApi, skooppiPolku } from '../src/api.ts';

interface Kutsu { url: string; init: RequestInit }

function feikki(vastaus: () => Response): { fetch: typeof fetch; kutsut: Kutsu[] } {
  const kutsut: Kutsu[] = [];
  const f = (async (url: string, init: RequestInit) => { kutsut.push({ url, init }); return vastaus(); }) as unknown as typeof fetch;
  return { fetch: f, kutsut };
}
const json = (o: unknown, tila = 200, otsakkeet: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(o), { status: tila, headers: { 'content-type': 'application/json', ...otsakkeet } });
const otsake = (k: Kutsu, nimi: string): string | undefined => (k.init.headers as Record<string, string>)[nimi];

describe('luoApi', () => {
  it('lähettää Bearer-avaimen ja palauttaa datan ja lähteen', async () => {
    const { fetch, kutsut } = feikki(() => json([{ nimi: 'a' }], 200, { 'x-lahde': 'ydin' }));
    const api = luoApi({ avain: () => 'testiavain', fetch, perus: 'http://x' });
    const v = await api.hae<{ nimi: string }[]>('/api/skoopit');
    assert.deepEqual(v, { data: [{ nimi: 'a' }], lahde: 'ydin' });
    assert.equal(kutsut[0]!.url, 'http://x/api/skoopit');
    assert.equal(kutsut[0]!.init.method, 'GET');
    assert.equal(otsake(kutsut[0]!, 'Authorization'), 'Bearer testiavain');
    assert.equal(kutsut[0]!.init.body, undefined);
  });

  it('runko lähtee JSONina Content-Type-otsakkeella, oletusmetodi POST', async () => {
    const { fetch, kutsut } = feikki(() => json({ ok: true }));
    const api = luoApi({ avain: () => 'k', fetch });
    await api.hae('/api/skoopit/a/viesti', { runko: { teksti: 'hei ä' } });
    assert.equal(kutsut[0]!.init.method, 'POST');
    assert.equal(otsake(kutsut[0]!, 'Content-Type'), 'application/json');
    assert.equal(kutsut[0]!.init.body, '{"teksti":"hei ä"}');
    await api.hae('/api/tila/x', { metodi: 'PUT', runko: { arvo: 1 } });
    assert.equal(kutsut[1]!.init.method, 'PUT');
  });

  it('avain luetaan joka pyynnöllä; puuttuva avain → AvainPuuttuu ilman verkkokutsua', async () => {
    let avain: string | null = null;
    const { fetch, kutsut } = feikki(() => json({}));
    const api = luoApi({ avain: () => avain, fetch });
    await assert.rejects(api.hae('/api/x'), AvainPuuttuu);
    assert.equal(kutsut.length, 0);
    avain = 'uusi';
    await api.hae('/api/x');
    assert.equal(otsake(kutsut[0]!, 'Authorization'), 'Bearer uusi');
  });

  it('401 → AvainPuuttuu (hae ja virta)', async () => {
    const { fetch } = feikki(() => json({ virhe: 'avain' }, 401));
    const api = luoApi({ avain: () => 'väärä', fetch });
    await assert.rejects(api.hae('/api/x'), AvainPuuttuu);
    await assert.rejects(api.virta('/api/virta', {}), AvainPuuttuu);
  });

  it('503 silta → ApiVirhe, lahde silta; muu ≥ 400 → ApiVirhe rungon kanssa', async () => {
    const silta = feikki(() => json({ virhe: 'silta', kohde: '8787' }, 503, { 'x-lahde': 'silta' }));
    const e = await luoApi({ avain: () => 'k', fetch: silta.fetch }).hae('/api/chat/virta').catch((x: unknown) => x);
    assert.ok(e instanceof ApiVirhe);
    assert.equal(e.tila, 503);
    assert.equal(e.lahde, 'silta');
    assert.deepEqual(e.runko, { virhe: 'silta', kohde: '8787' });
    const muu = feikki(() => json({ virhe: 'tuntematon skooppi: x' }, 404));
    const e2 = await luoApi({ avain: () => 'k', fetch: muu.fetch }).hae('/api/skoopit/x').catch((x: unknown) => x);
    assert.ok(e2 instanceof ApiVirhe);
    assert.equal(e2.tila, 404);
    assert.equal(e2.lahde, null);
    assert.match(e2.message, /tuntematon skooppi/);
  });

  it('virta palauttaa vastausrungon ja lisää otsakkeet ja Accept-oletuksen', async () => {
    const { fetch, kutsut } = feikki(() => new Response('data: 1\n\n', { status: 200 }));
    const api = luoApi({ avain: () => 'k', fetch });
    const virta = await api.virta('/api/virta', { otsakkeet: { 'Last-Event-ID': '7', Accept: 'text/event-stream' } });
    assert.equal(await new Response(virta).text(), 'data: 1\n\n');
    assert.equal(otsake(kutsut[0]!, 'Last-Event-ID'), '7');
    assert.equal(otsake(kutsut[0]!, 'Authorization'), 'Bearer k');
  });
});

describe('skooppiPolku', () => {
  it('koodaa nimen (välilyönnit, &, /)', () => {
    assert.equal(skooppiPolku('scopes macos', 'viestit'), '/api/skoopit/scopes%20macos/viestit');
    assert.equal(skooppiPolku('claude r&d'), '/api/skoopit/claude%20r%26d');
    assert.equal(skooppiPolku('a/b', 'viesti'), '/api/skoopit/a%2Fb/viesti');
  });
});
