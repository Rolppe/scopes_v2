import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { luoApi } from '../src/api.ts';
import { luoTila, yhdista } from '../src/tila.ts';
import type { SinceVastaus } from '../src/tila.ts';
import type { Muutos } from '../src/virta.ts';
import { kaynnistaMock } from './apu.ts';
import type { Mock } from './apu.ts';

interface Rivi { id: string; v: number }
const id = (x: Rivi): string => x.id;
const vastaus = (v: Partial<SinceVastaus<Rivi>>): SinceVastaus<Rivi> => ({ seq: 1, muuttuneet: [], poistetut: [], ...v });

describe('yhdista', () => {
  const nyt: Rivi[] = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];

  it('nollaus korvaa kaiken', () => {
    assert.deepEqual(yhdista(nyt, vastaus({ nollaus: true, muuttuneet: [{ id: 'x', v: 9 }] }), id), [{ id: 'x', v: 9 }]);
  });
  it('korvaa id:n mukaan paikallaan, uudet loppuun', () => {
    const u = yhdista(nyt, vastaus({ muuttuneet: [{ id: 'b', v: 2 }, { id: 'd', v: 1 }] }), id);
    assert.deepEqual(u, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 1 }, { id: 'd', v: 1 }]);
  });
  it('poistetut pois', () => {
    assert.deepEqual(yhdista(nyt, vastaus({ poistetut: ['a', 'c'] }), id), [{ id: 'b', v: 1 }]);
  });
  it('sama id sekä muuttuneissa että poistetuissa → poistettu', () => {
    assert.deepEqual(yhdista(nyt, vastaus({ muuttuneet: [{ id: 'b', v: 2 }], poistetut: ['b'] }), id), [{ id: 'a', v: 1 }, { id: 'c', v: 1 }]);
  });
  it('ei muuta alkuperäistä listaa; tyhjä vastaus palauttaa saman sisällön', () => {
    const kopio = structuredClone(nyt);
    const u = yhdista(nyt, vastaus({ muuttuneet: [{ id: 'a', v: 5 }] }), id);
    assert.deepEqual(nyt, kopio);
    assert.deepEqual(yhdista(nyt, vastaus({}), id), nyt);
    assert.notEqual(u, nyt);
  });
});

const PORTTI = 18793;
let mock: Mock;
before(async () => { mock = await kaynnistaMock(PORTTI); });
after(() => mock.sulje());

const tapahtuma = (polku: string, id: string, lisa: object = {}): Promise<Response> =>
  fetch(`${mock.osoite}/__testi/tapahtuma`, { method: 'POST', body: JSON.stringify({ polku, id, ...lisa }) });
const muutos = (polku: string, id: string): Muutos => ({ seq: 0, polku, id, versio: {}, aika: '' });
const odotaMs = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

function tilaJaLoki(valittu: string | null = null) {
  const urlit: string[] = [];
  const f = ((url: string, init?: RequestInit) => { urlit.push(url.slice(mock.osoite.length)); return fetch(url, init); }) as typeof fetch;
  const api = luoApi({ avain: () => 'testiavain', fetch: f, perus: mock.osoite });
  const t = luoTila({ api, valittu: () => valittu });
  const haut = (alku: string): string[] => urlit.filter((u) => u.startsWith(alku));
  return { t, urlit, haut };
}

describe('luoTila mock-ytimeä vasten', () => {
  it('ensimmäinen haku ilman since-parametria, seuraava ?since=<seq> ja yhdistäminen', async () => {
    const { t, haut } = tilaJaLoki();
    await t.paivitaSkoopit();
    assert.equal(t.tila().skoopit.length, 92);
    assert.deepEqual(haut('/api/skoopit'), ['/api/skoopit']);
    const alku = t.tila().seq;
    assert.ok(alku >= 10);
    const ennen = t.tila().skoopit.map((s) => s.nimi);
    await tapahtuma('skoopit', 'test');
    await tapahtuma('skoopit', 'claude', { poistettu: true });
    await t.paivitaSkoopit();
    assert.deepEqual(haut('/api/skoopit'), ['/api/skoopit', `/api/skoopit?since=${alku}`]);
    assert.equal(t.tila().seq, alku + 2);
    assert.deepEqual(t.tila().skoopit.map((s) => s.nimi), ennen.filter((n) => n !== 'claude'));
    await t.paivitaSkoopit();
    assert.equal(haut('/api/skoopit').at(-1), `/api/skoopit?since=${alku + 2}`);
  });

  it('muutokset yhdistyvät yhdeksi hauksi 200 ms:n sisällä', async () => {
    const { t, haut } = tilaJaLoki();
    await t.paivitaSkoopit();
    const ennen = haut('/api/skoopit').length;
    for (const p of ['skoopit', 'lahde', 'rekisterit']) t.kasitteleMuutos(muutos(p, 'x'));
    t.kasitteleMuutos(muutos('agentit', 'y')); // ei vaikuta skoopteihin
    await odotaMs(500);
    assert.equal(haut('/api/skoopit').length - ennen, 1);
  });

  it('peili-muutos päivittää vain valitun skoopin viestit', async () => {
    const { t, urlit, haut } = tilaJaLoki('scopes macos');
    await t.paivitaViestit('scopes macos');
    await t.paivitaViestit('test');
    const v0 = t.tila().viestit.get('scopes macos')!;
    assert.ok(v0.lista.length > 0);
    assert.match(v0.lista[0]!.id, /:1$/);
    assert.equal(t.tila().viestit.get('test')!.lista.length, 0);
    urlit.length = 0;
    t.kasitteleMuutos(muutos('peili', 'tiedosto:100'));
    await odotaMs(500);
    assert.equal(urlit.length, 1);
    assert.match(urlit[0]!, /^\/api\/skoopit\/scopes%20macos\/viestit\?since=\d+$/);
    assert.equal(haut('/api/skoopit/test').length, 0);
  });

  it('viestien since-ketju lisää uuden viestin loppuun', async () => {
    const { t } = tilaJaLoki('scopes macos');
    await t.paivitaViestit('scopes macos');
    const n = t.tila().viestit.get('scopes macos')!.lista.length;
    await tapahtuma('viestit', 'koe:99', { skooppi: 'scopes macos', viesti: { id: 'koe:99', rooli: 'agentti', teksti: 'uusi' } });
    await t.paivitaViestit('scopes macos');
    const lista = t.tila().viestit.get('scopes macos')!.lista;
    assert.equal(lista.length, n + 1);
    assert.equal(lista.at(-1)!.teksti, 'uusi');
  });

  it('ilman valittua skooppia peili-muutos ei hae viestejä', async () => {
    const { t, urlit } = tilaJaLoki(null);
    t.kasitteleMuutos(muutos('peili', 'x'));
    await odotaMs(400);
    assert.equal(urlit.length, 0);
  });

  it('nollaa hakee kaiken uudelleen ilman since-parametria', async () => {
    const { t, urlit } = tilaJaLoki('scopes macos');
    await t.paivitaSkoopit();
    await t.paivitaViestit('scopes macos');
    await t.paivitaSkoopit(); // since-haku
    urlit.length = 0;
    await t.nollaa();
    assert.deepEqual(urlit.filter((u) => !u.startsWith('/api/terveys')), ['/api/skoopit', '/api/skoopit/scopes%20macos/viestit']);
    assert.equal(t.tila().skoopit.length, 92);
  });

  it('tilaajat saavat ilmoituksen; väärä avain → yhteys "avain"', async () => {
    const { t } = tilaJaLoki();
    let n = 0;
    const pois = t.tilaa(() => { n += 1; });
    await t.paivitaSkoopit();
    assert.ok(n >= 1);
    pois();
    const vaara = luoTila({ api: luoApi({ avain: () => 'väärä', perus: mock.osoite }) });
    await assert.rejects(vaara.paivitaSkoopit());
    assert.equal(vaara.tila().yhteys, 'avain');
  });
});
