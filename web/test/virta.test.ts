import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { luoApi } from '../src/api.ts';
import type { Api } from '../src/api.ts';
import { jasennaSse, luoVirta } from '../src/virta.ts';
import type { Muutos } from '../src/virta.ts';
import { kaynnistaMock } from './apu.ts';
import type { Mock } from './apu.ts';

const PORTTI = 18794;
let mock: Mock;
let api: Api;
before(async () => {
  mock = await kaynnistaMock(PORTTI, undefined, ['--ka', '300']);
  api = luoApi({ avain: () => 'testiavain', perus: mock.osoite });
});
after(() => mock.sulje());

const tapahtuma = (polku: string, id: string): Promise<Response> => fetch(`${mock.osoite}/__testi/tapahtuma`, { method: 'POST', body: JSON.stringify({ polku, id }) });
const katko = (): Promise<Response> => fetch(`${mock.osoite}/__testi/katko`, { method: 'POST' });
async function odota(ehto: () => boolean, ms = 4000): Promise<void> {
  const loppu = Date.now() + ms;
  while (!ehto()) {
    if (Date.now() > loppu) throw new Error('odotus aikakatkaistiin');
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

describe('jasennaSse', () => {
  it('jäsentää kehyksen, id ja event', () => {
    const j = jasennaSse();
    assert.deepEqual(j.syota('id: 12\nevent: muutos\ndata: {"seq":12}\n\n'), [{ id: '12', event: 'muutos', data: '{"seq":12}' }]);
  });

  it('pätkitty syöte: kehys valmistuu vasta tyhjän rivin jälkeen, mistä tahansa kohdasta katkaistuna', () => {
    const koko = 'id: 3\nevent: muutos\ndata: {"a":1}\n\nid: 4\nevent: muutos\ndata: {"a":2}\n\n';
    for (let i = 1; i < koko.length; i++) {
      const j = jasennaSse();
      const ulos = [...j.syota(koko.slice(0, i)), ...j.syota(koko.slice(i))];
      assert.deepEqual(ulos.map((k) => k.id), ['3', '4'], `katkaisu kohdassa ${i}`);
    }
  });

  it('": ka" -kommentit ohitetaan', () => {
    const j = jasennaSse();
    assert.deepEqual(j.syota(': ka\n\n: ka\n\n'), []);
    assert.deepEqual(j.syota(': ka\n\nevent: nollaus\ndata: {"seq":5}\n\n'), [{ event: 'nollaus', data: '{"seq":5}' }]);
  });

  it('\\r\\n-rivinvaihdot, myös pätkän rajalla', () => {
    const j = jasennaSse();
    const ulos = [...j.syota('id: 1\r\nevent: muutos\r\ndata: x\r'), ...j.syota('\n\r\n')];
    assert.deepEqual(ulos, [{ id: '1', event: 'muutos', data: 'x' }]);
  });

  it('monirivinen data yhdistetään rivinvaihdolla', () => {
    const j = jasennaSse();
    assert.deepEqual(j.syota('event: muutos\ndata: a\ndata: b\ndata:c\n\n'), [{ event: 'muutos', data: 'a\nb\nc' }]);
  });
});

describe('luoVirta mock-ytimeä vasten', () => {
  it('muutos tulee perille ja seq päivittyy', async () => {
    const saadut: Muutos[] = [];
    const tilat: string[] = [];
    const v = luoVirta({ api, muutos: (m) => saadut.push(m), nollaus: () => undefined, tila: (t) => tilat.push(t) });
    const alku = ((await (await fetch(`${mock.osoite}/api/terveys`)).json()) as { seq: number }).seq;
    v.aloita(alku);
    await odota(() => tilat.includes('auki'));
    await tapahtuma('agentit', 'a-1');
    await odota(() => saadut.length === 1);
    assert.equal(saadut[0]!.polku, 'agentit');
    assert.equal(saadut[0]!.id, 'a-1');
    assert.equal(v.seq(), saadut[0]!.seq);
    v.sulje();
  });

  it('katko → uusinta Last-Event-ID:llä ilman aukkoa tai kaksoiskappaleita', async () => {
    const saadut: Muutos[] = [];
    const tilat: string[] = [];
    const v = luoVirta({ api, muutos: (m) => saadut.push(m), nollaus: () => undefined, tila: (t) => tilat.push(t), viive: () => 30 });
    const alku = ((await (await fetch(`${mock.osoite}/api/terveys`)).json()) as { seq: number }).seq;
    v.aloita(alku);
    await odota(() => tilat.includes('auki'));
    await tapahtuma('agentit', 'e1');
    await odota(() => saadut.length === 1);
    await katko();
    await tapahtuma('agentit', 'e2'); // virran ollessa poikki
    await tapahtuma('agentit', 'e3');
    await odota(() => saadut.length === 3);
    await tapahtuma('agentit', 'e4'); // uudelleenyhdistetyssä virrassa
    await odota(() => saadut.length === 4);
    assert.deepEqual(saadut.map((m) => m.id), ['e1', 'e2', 'e3', 'e4']);
    for (let i = 1; i < saadut.length; i++) assert.equal(saadut[i]!.seq, saadut[i - 1]!.seq + 1);
    assert.deepEqual(tilat.slice(0, 3), ['auki', 'katki', 'auki']);
    v.sulje();
  });

  it('injektoitu viive ja ajastin: uusinta vasta kun ajastin laukeaa; onnistunut kehys nollaa laskurin', async () => {
    const viiveet: number[] = [];
    const ajastukset: { f: () => void; ms: number }[] = [];
    const tilat: string[] = [];
    const saadut: Muutos[] = [];
    const v = luoVirta({
      api, muutos: (m) => saadut.push(m), nollaus: () => undefined, tila: (t) => tilat.push(t),
      viive: (y) => { viiveet.push(y); return y * 111; },
      ajastin: (f, ms) => { ajastukset.push({ f, ms }); return null; },
    });
    const alku = ((await (await fetch(`${mock.osoite}/api/terveys`)).json()) as { seq: number }).seq;
    v.aloita(alku);
    await odota(() => tilat.length === 1);
    await katko();
    await odota(() => ajastukset.length === 1);
    assert.deepEqual(viiveet, [1]);
    assert.equal(ajastukset[0]!.ms, 111);
    await new Promise((ok) => setTimeout(ok, 150));
    assert.deepEqual(tilat, ['auki', 'katki']); // ei uusintaa ennen ajastinta
    ajastukset[0]!.f();
    await odota(() => tilat.length === 3);
    await tapahtuma('agentit', 'n1'); // onnistunut kehys → laskuri nollaan
    await odota(() => saadut.length === 1);
    await katko();
    await odota(() => ajastukset.length === 2);
    assert.deepEqual(viiveet, [1, 1]);
    v.sulje();
  });

  it('palvelin alhaalla: viive kasvaa yrityksittäin', async () => {
    const viiveet: number[] = [];
    const ajastukset: (() => void)[] = [];
    const kuollut = luoApi({ avain: () => 'k', perus: 'http://127.0.0.1:1' });
    const v = luoVirta({ api: kuollut, muutos: () => undefined, nollaus: () => undefined, viive: (y) => { viiveet.push(y); return 0; }, ajastin: (f) => { ajastukset.push(f); return null; } });
    v.aloita();
    await odota(() => ajastukset.length === 1);
    ajastukset[0]!();
    await odota(() => ajastukset.length === 2);
    ajastukset[1]!();
    await odota(() => ajastukset.length === 3);
    assert.deepEqual(viiveet, [1, 2, 3]);
    v.sulje();
  });

  it('oletusviive: min(30000, 1000 * 2^(yritys-1))', async () => {
    const ms: number[] = [];
    const ajastukset: (() => void)[] = [];
    const kuollut = luoApi({ avain: () => 'k', perus: 'http://127.0.0.1:1' });
    const v = luoVirta({ api: kuollut, muutos: () => undefined, nollaus: () => undefined, ajastin: (f, m) => { ms.push(m); ajastukset.push(f); return null; } });
    v.aloita();
    for (let i = 1; i <= 7; i++) {
      await odota(() => ajastukset.length === i);
      ajastukset[i - 1]!();
    }
    await odota(() => ajastukset.length === 8);
    assert.deepEqual(ms, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    v.sulje();
  });

  it('nollaus-kehys kutsuu nollaus-takaisinkutsua ja asettaa seq:n', async () => {
    const nollaukset: number[] = [];
    const v = luoVirta({ api, muutos: () => undefined, nollaus: (s) => nollaukset.push(s) });
    v.aloita(0); // lokin alkua vanhempi
    await odota(() => nollaukset.length === 1);
    assert.ok(nollaukset[0]! >= 10);
    assert.equal(v.seq(), nollaukset[0]);
    v.sulje();
  });

  it('AvainPuuttuu → ei uusintaa', async () => {
    const ajastukset: unknown[] = [];
    const tilat: string[] = [];
    const v = luoVirta({ api: luoApi({ avain: () => 'väärä', perus: mock.osoite }), muutos: () => undefined, nollaus: () => undefined, tila: (t) => tilat.push(t), ajastin: (f) => { ajastukset.push(f); return null; } });
    v.aloita();
    await odota(() => tilat.includes('katki'));
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal(ajastukset.length, 0);
  });

  it('sulje pysäyttää uusinnat', async () => {
    const tilat: string[] = [];
    const v = luoVirta({ api, muutos: () => undefined, nollaus: () => undefined, tila: (t) => tilat.push(t), viive: () => 20 });
    v.aloita();
    await odota(() => tilat.includes('auki'));
    v.sulje();
    await katko();
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(tilat.filter((t) => t === 'auki').length, 1);
  });
});
