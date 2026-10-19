// mock-ydin.mjs:n sopimus: S-1 virta, S-4 tila, S-6 since-muoto, S-7 tarjoilu, chat-virta.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kaynnistaMock } from './apu.ts';
import type { Mock } from './apu.ts';

const PORTTI = 18795;
const A = { authorization: 'Bearer testiavain' };
const fixtuuri = (n: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../ydin/tests/fixture/${n}`, import.meta.url)), 'utf8'));

let mock: Mock;
let tmp: string;
let os: string;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mock-ydin-'));
  mkdirSync(join(tmp, 'dist'));
  writeFileSync(join(tmp, 'dist/index.html'), '<title>x</title>');
  writeFileSync(join(tmp, 'dist/app.js'), 'export {}');
  writeFileSync(join(tmp, 'package.json'), '{"salaisuus":true}');
  mock = await kaynnistaMock(PORTTI, join(tmp, 'dist'), ['--ka', '300']);
  os = mock.osoite;
});
after(async () => {
  await mock.sulje();
  rmSync(tmp, { recursive: true, force: true });
});

const hae = (polku: string, init: RequestInit = {}): Promise<Response> =>
  fetch(os + polku, { ...init, headers: { ...A, ...(init.headers as Record<string, string> | undefined) } });
const lahetaJson = (metodi: string, polku: string, runko: unknown): Promise<Response> =>
  hae(polku, { method: metodi, body: JSON.stringify(runko), headers: { 'content-type': 'application/json' } });
const testiTapahtuma = (polku: string, id: string, lisa: object = {}): Promise<Response> =>
  fetch(`${os}/__testi/tapahtuma`, { method: 'POST', body: JSON.stringify({ polku, id, ...lisa }) });

// Lukee virtaa, kunnes ehto täyttyy tai aika loppuu; palauttaa luetun tekstin.
async function lue(polku: string, otsakkeet: Record<string, string>, riittaa: (teksti: string) => boolean, enintaan = 4000): Promise<string> {
  const ac = new AbortController();
  const ajastin = setTimeout(() => ac.abort(), enintaan);
  let teksti = '';
  try {
    const r = await hae(polku, { headers: { accept: 'text/event-stream', ...otsakkeet }, signal: ac.signal });
    assert.equal(r.status, 200);
    const lukija = r.body!.getReader();
    const dekoodi = new TextDecoder();
    while (!riittaa(teksti)) {
      const { value, done } = await lukija.read();
      if (done) break;
      teksti += dekoodi.decode(value, { stream: true });
    }
    await lukija.cancel();
  } catch (e) {
    if (!(e instanceof Error && e.name === 'AbortError')) throw e;
  } finally {
    clearTimeout(ajastin);
  }
  return teksti;
}

describe('tunnistus ja perusreitit', () => {
  it('401 ilman avainta, terveys ilman', async () => {
    assert.equal((await fetch(`${os}/api/skoopit`)).status, 401);
    assert.equal((await fetch(`${os}/api/skoopit`, { headers: { authorization: 'Bearer väärä' } })).status, 401);
    const t = await fetch(`${os}/api/terveys`);
    assert.equal(t.status, 200);
    assert.equal(((await t.json()) as { v2: boolean }).v2, true);
  });

  it('/api/skoopit = fixture, X-Lahde: ydin', async () => {
    const r = await hae('/api/skoopit');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-lahde'), 'ydin');
    assert.deepEqual(await r.json(), fixtuuri('skoopit.json'));
  });

  it('tuntematon polku 404', async () => {
    const r = await hae('/api/ei-ole');
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { virhe: 'tuntematon polku' });
  });
});

describe('since-muoto (S-6)', () => {
  it('nollaus kun since < lokin alku', async () => {
    const o = (await (await hae('/api/skoopit?since=0')).json()) as { seq: number; muuttuneet: unknown[]; poistetut: unknown[]; nollaus?: boolean };
    assert.equal(o.nollaus, true);
    assert.deepEqual(o.muuttuneet, fixtuuri('skoopit.json'));
    assert.deepEqual(o.poistetut, []);
    assert.equal(typeof o.seq, 'number');
  });

  it('muuttuneet ja poistetut tapahtumista', async () => {
    const alku = ((await (await fetch(`${os}/api/terveys`)).json()) as { seq: number }).seq;
    await testiTapahtuma('skoopit', 'test');
    await testiTapahtuma('skoopit', 'claude', { poistettu: true });
    const o = (await (await hae(`/api/skoopit?since=${alku}`)).json()) as { seq: number; muuttuneet: { nimi: string }[]; poistetut: string[]; nollaus?: boolean };
    assert.equal(o.nollaus, undefined);
    assert.equal(o.seq, alku + 2);
    assert.deepEqual(o.muuttuneet.map((s) => s.nimi), ['test']);
    assert.deepEqual(o.poistetut, ['claude']);
    const tyhja = (await (await hae(`/api/skoopit?since=${o.seq}`)).json()) as { muuttuneet: unknown[]; poistetut: unknown[] };
    assert.deepEqual(tyhja, { seq: o.seq, muuttuneet: [], poistetut: [] });
  });
});

describe('viestit', () => {
  it('POST viesti kirjautuu, tuntematon skooppi 404', async () => {
    const r = await lahetaJson('POST', '/api/skoopit/test/viesti', { teksti: 'hei' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    const k = (await (await fetch(`${os}/__testi/kirjatut`)).json()) as { viestit: { skooppi: string; teksti: string }[] };
    assert.deepEqual(k.viestit.at(-1), { skooppi: 'test', teksti: 'hei' });
    const e = await lahetaJson('POST', '/api/skoopit/ei-ole-olemassa/viesti', { teksti: 'hei' });
    assert.equal(e.status, 404);
    assert.ok(((await e.json()) as { virhe: string }).virhe);
  });

  it('viestit-lista fixturesta, viesteillä vakaa id', async () => {
    const v = (await (await hae('/api/skoopit/scopes%20macos/viestit')).json()) as { viestit: { id: string; teksti: string }[] };
    assert.ok(v.viestit.length > 0);
    assert.match(v.viestit[0]!.id, /:1$/);
  });

  it('tuntematon testiohjauspolku 404', async () => {
    assert.equal((await fetch(`${os}/__testi/ei-ole`)).status, 404);
  });
});

describe('tila (S-4)', () => {
  it('PUT, GET, etuliite, kuittaus suurin voittaa', async () => {
    const p = await lahetaJson('PUT', '/api/tila/luonnos/scopes%20macos', { arvo: 'kesken' });
    assert.equal(p.status, 200);
    const g = (await (await hae('/api/tila/luonnos/scopes%20macos')).json()) as { avain: string; arvo: string; aika: string; laite: string };
    assert.equal(g.avain, 'luonnos/scopes macos');
    assert.equal(g.arvo, 'kesken');
    assert.match(g.aika, /^\d{4}-\d\d-\d\dT.*Z-\d{4}-/);
    assert.equal((await hae('/api/tila/ei/ole')).status, 404);
    const l = (await (await hae('/api/tila?etuliite=luonnos/')).json()) as { tilat: { avain: string }[] };
    assert.deepEqual(l.tilat.map((t) => t.avain), ['luonnos/scopes macos']);
    await lahetaJson('PUT', '/api/tila/kuittaus/test', { arvo: 5 });
    await lahetaJson('PUT', '/api/tila/kuittaus/test', { arvo: 3 });
    assert.equal(((await (await hae('/api/tila/kuittaus/test')).json()) as { arvo: number }).arvo, 5);
  });
});

describe('virta (S-1)', () => {
  it('tapahtuma tulee id/event-kehyksenä ja ": ka" -rivi 300 ms välein', async () => {
    const odotus = lue('/api/virta', {}, (t) => t.includes('event: muutos') && t.includes(': ka'));
    await new Promise((ok) => setTimeout(ok, 150));
    await testiTapahtuma('agentit', 'a-1');
    const t = await odotus;
    assert.match(t, /id: \d+\nevent: muutos\ndata: \{"seq":\d+,"polku":"agentit","id":"a-1","versio":\{[^}]*\},"aika":"[^"]+"\}\n\n/);
    assert.match(t, /: ka\n\n/);
  });

  it('Last-Event-ID jatkaa oikeasta seq:stä, otsake voittaa since-parametrin', async () => {
    const a = (await (await testiTapahtuma('rekisterit', 'x/1')).json()) as { seq: number };
    const b = (await (await testiTapahtuma('rekisterit', 'x/2')).json()) as { seq: number };
    const t = await lue(`/api/virta?since=0`, { 'last-event-id': String(a.seq) }, (s) => s.includes(`id: ${b.seq}\n`));
    assert.ok(!t.includes('nollaus'));
    assert.ok(!t.includes(`id: ${a.seq}\n`));
    assert.ok(t.includes(`id: ${b.seq}\n`));
  });

  it('event: nollaus kun since on lokin alkua vanhempi', async () => {
    const t = await lue('/api/virta?since=1', {}, (s) => s.includes('event: nollaus'));
    assert.match(t, /^event: nollaus\ndata: \{"seq":\d+\}\n\n/);
  });

  it('katko sulkee virran', async () => {
    const r = await hae('/api/virta', { headers: { accept: 'text/event-stream' } });
    const lukija = r.body!.getReader();
    await fetch(`${os}/__testi/katko`, { method: 'POST' });
    await assert.rejects(async () => {
      for (;;) { const { done } = await lukija.read(); if (done) throw new Error('päättyi'); }
    });
  });
});

describe('chat', () => {
  it('virta tuottaa 3 palaa ja valmis; kaynnissa liittyy uudelleen; ei ajoa → 404', async () => {
    assert.equal((await hae('/api/chat/kaynnissa')).status, 404);
    const r = await lahetaJson('POST', '/api/chat/virta', { agentti: 'claude-sonnet-5-5', viesti: 'moi' });
    assert.equal(r.status, 200);
    const rivit = (await r.text()).trim().split('\n').map((l) => JSON.parse(l) as { tyyppi: string; teksti?: string; vastaus?: string; keskustelu?: string });
    assert.deepEqual(rivit.map((x) => x.tyyppi), ['pala', 'pala', 'pala', 'valmis']);
    assert.equal(rivit[3]!.keskustelu, 'k-1');
    assert.equal(rivit[3]!.vastaus, rivit.slice(0, 3).map((x) => x.teksti).join(''));
    const k = (await (await fetch(`${os}/__testi/kirjatut`)).json()) as { chatit: { viesti: string }[] };
    assert.equal(k.chatit.at(-1)!.viesti, 'moi');
  });

  it('katkon jälkeen kaynnissa antaa kirjoitetun tekstin yhtenä palana ja loput', async () => {
    const r = await lahetaJson('POST', '/api/chat/virta', { agentti: 'claude-sonnet-5-5', viesti: 'toinen' });
    const lukija = r.body!.getReader();
    await lukija.read();
    await new Promise((ok) => setTimeout(ok, 350));
    await fetch(`${os}/__testi/katko`, { method: 'POST' });
    await lukija.read().catch(() => undefined);
    const j = await hae('/api/chat/kaynnissa');
    assert.equal(j.status, 200);
    const rivit = (await j.text()).trim().split('\n').map((l) => JSON.parse(l) as { tyyppi: string; teksti?: string; vastaus?: string });
    assert.equal(rivit[0]!.tyyppi, 'pala');
    assert.equal(rivit.at(-1)!.tyyppi, 'valmis');
    assert.equal(rivit.slice(0, -1).map((x) => x.teksti).join(''), rivit.at(-1)!.vastaus);
  });
});

describe('/web/* (S-7)', () => {
  it('GET / → 302 /web/, /web/ → index.html otsakkeineen', async () => {
    const y = await fetch(`${os}/`, { redirect: 'manual' });
    assert.equal(y.status, 302);
    assert.equal(y.headers.get('location'), '/web/');
    const w = await fetch(`${os}/web/`);
    assert.equal(w.status, 200);
    assert.equal(w.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(w.headers.get('cache-control'), 'no-cache');
    assert.match(w.headers.get('content-security-policy') ?? '', /^default-src 'self'; script-src 'self'; style-src 'self'/);
    assert.equal(w.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(w.headers.get('x-lahde'), 'ydin');
    const j = await fetch(`${os}/web/app.js`);
    assert.equal(j.headers.get('cache-control'), 'max-age=300');
    assert.equal(j.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });

  it('/web/../package.json → 404 (raaka polku), HEAD ilman runkoa, POST 405', async () => {
    const tila = await new Promise<number>((ok, virhe) => {
      const r = request({ host: '127.0.0.1', port: PORTTI, path: '/web/../package.json', method: 'GET' }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
      r.on('error', virhe);
      r.end();
    });
    assert.equal(tila, 404);
    assert.equal((await fetch(`${os}/web/%2e%2e/package.json`)).status, 404);
    const h = await fetch(`${os}/web/`, { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal(await h.text(), '');
    assert.equal((await fetch(`${os}/web/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${os}/web/puuttuu.js`)).status, 404);
  });
});
