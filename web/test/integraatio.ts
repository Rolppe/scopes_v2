// T-43 integraatio: oikea ydin (koeinstanssi 18797) tarjoilee dist/:n ja välittää vanhan API:n siltana mock-vanhaan (18796).
// Gate ajaa tämän build → cargo build --release -jälkeen. Binääri: $CARGO_TARGET_DIR/release/scopes-solmu tai scopes2/ydin/target/release/.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { avaaSelain, kaynnistaMock, WEB } from './apu.ts';
import type { Mock, Selain } from './apu.ts';

const YDIN_PORTTI = 18797;
const VANHA_PORTTI = 18796;
const KOE = '/tmp/scopes2-web-koe';
const KOE_AVAIN = 'koe-web-avain-0123456789';
const YDIN = `http://127.0.0.1:${YDIN_PORTTI}`;
const DIST = join(WEB, 'dist');
const BINAARI = join(process.env['CARGO_TARGET_DIR'] ?? join(WEB, '../ydin/target'), 'release/scopes-solmu');
// S-7: sama otsake kuin ytimen web.rs.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const KUORIPOLUT = ['/web/', '/web/index.html', '/web/app.js', '/web/app.css', '/web/manifest.webmanifest', '/web/kuvakkeet/scopes-v2.svg'];

let ydinProsessi: ChildProcess | null = null;
let mock: Mock | null = null;
let selain: Selain | null = null;

function portinVaraus(portti: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createConnection({ host: '127.0.0.1', port: portti });
    s.once('connect', () => { s.destroy(); ok(true); });
    s.once('error', () => ok(false));
  });
}

async function siivoa(): Promise<void> {
  await selain?.sulje().catch(() => undefined);
  selain = null;
  if (ydinProsessi?.pid !== undefined && ydinProsessi.exitCode === null) {
    const valmis = new Promise<void>((ok) => ydinProsessi!.once('exit', () => ok()));
    try { process.kill(-ydinProsessi.pid, 'SIGTERM'); } catch { /* jo poissa */ }
    await Promise.race([valmis, new Promise((ok) => setTimeout(ok, 5000))]);
    try { process.kill(-ydinProsessi.pid, 'SIGKILL'); } catch { /* jo poissa */ }
  }
  ydinProsessi = null;
  await mock?.sulje().catch(() => undefined);
  mock = null;
  rmSync(KOE, { recursive: true, force: true });
}

for (const s of ['SIGINT', 'SIGTERM'] as const) {
  process.on(s, () => { void siivoa().finally(() => process.exit(143)); });
}

const tulokset: { nimi: string; ok: boolean; syy?: string }[] = [];
async function tarkistus(nimi: string, f: () => Promise<void>): Promise<void> {
  try {
    await f();
    tulokset.push({ nimi, ok: true });
    console.log(`ok   ${nimi}`);
  } catch (e) {
    const syy = e instanceof Error ? e.message : String(e);
    tulokset.push({ nimi, ok: false, syy });
    console.error(`FAIL ${nimi}: ${syy}`);
  }
}
function varmista(ehto: boolean, viesti: string): void {
  if (!ehto) throw new Error(viesti);
}
async function odota(ehto: () => Promise<boolean>, ms: number, viesti: string): Promise<void> {
  const raja = Date.now() + ms;
  while (Date.now() < raja) {
    if (await ehto()) return;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`aikakatkaisu (${ms} ms): ${viesti}`);
}
const A = { authorization: `Bearer ${KOE_AVAIN}` };

async function main(): Promise<number> {
  if (!existsSync(BINAARI)) {
    console.error(`PUUTTUU: ${BINAARI}`);
    return 1;
  }
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error(`PUUTTUU: ${join(DIST, 'index.html')} (aja build.mjs)`);
    return 1;
  }
  if ((await portinVaraus(YDIN_PORTTI)) || (await portinVaraus(VANHA_PORTTI))) {
    console.error('VIRHE: koeportti käytössä');
    return 1;
  }
  rmSync(KOE, { recursive: true, force: true });
  mkdirSync(join(KOE, 'data'), { recursive: true });
  writeFileSync(join(KOE, 'avain'), KOE_AVAIN, { mode: 0o600 });
  writeFileSync(join(KOE, 'vanha-avain'), 'koe-vanha-avain', { mode: 0o600 });

  mock = await kaynnistaMock(VANHA_PORTTI, DIST, ['--rooli', 'vanha']);
  // RLIMIT_DATA kuten kaynnista.sh (T-37); oma prosessiryhmä, jotta trap sammuttaa koko ryhmän.
  ydinProsessi = spawn('bash', ['-c', 'ulimit -d 1572864; exec "$@"', 'ydin', BINAARI,
    '--portti', String(YDIN_PORTTI), '--data', join(KOE, 'data'), '--avain', join(KOE, 'avain'), '--web', DIST,
    '--vanha', `http://127.0.0.1:${VANHA_PORTTI}`, '--vanha-avain', join(KOE, 'vanha-avain')], {
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let kuollut = false;
  ydinProsessi.once('exit', () => { kuollut = true; });
  for (let i = 0; i < 300; i++) {
    if (kuollut) { console.error('VIRHE: ydin päättyi ennen valmistumista'); return 1; }
    try { if ((await fetch(`${YDIN}/api/terveys`)).ok) break; } catch { /* ei vielä */ }
    await new Promise((ok) => setTimeout(ok, 100));
    if (i === 299) { console.error('VIRHE: ydin ei vastannut 30 s:ssa'); return 1; }
  }

  selain = await avaaSelain();
  const { sivu, konsolivirheet } = selain;
  // Tallentaa sivun saaman /api/virta-virran tekstin (Playwright ei näe fetch-virran runkoa).
  await sivu.addInitScript(() => {
    const f = window.fetch.bind(window);
    (window as unknown as { __virta: string[] }).__virta = [];
    window.fetch = async (...a: Parameters<typeof fetch>) => {
      const r = await f(...a);
      const u = a[0] instanceof Request ? a[0].url : String(a[0]);
      if (u.includes('/api/virta') && r.body) {
        const [x, y] = r.body.tee();
        void (async () => {
          const lukija = x.getReader();
          const dekoodi = new TextDecoder();
          for (;;) {
            const { value, done } = await lukija.read().catch(() => ({ value: undefined, done: true }));
            if (done) break;
            (window as unknown as { __virta: string[] }).__virta.push(dekoodi.decode(value, { stream: true }));
          }
        })();
        return new Response(y, { status: r.status, headers: r.headers });
      }
      return r;
    };
  });

  const nimet: string[] = (await (await fetch(`http://127.0.0.1:${VANHA_PORTTI}/api/skoopit`, { headers: { authorization: 'Bearer mika-tahansa' } })).json() as { nimi: string }[]).map((s) => s.nimi);
  const SKOOPPI = 'scopes macos';
  varmista(nimet.includes(SKOOPPI), 'mock-vanhan listassa ei ole testiskooppia');

  await tarkistus('1 GET / → 302 /web/, CSP = S-7', async () => {
    const y = await fetch(`${YDIN}/`, { redirect: 'manual' });
    varmista(y.status === 302 && y.headers.get('location') === '/web/', `GET / → ${y.status} ${y.headers.get('location')}`);
    const w = await fetch(`${YDIN}/web/`);
    varmista(w.status === 200, `GET /web/ → ${w.status}`);
    varmista(w.headers.get('content-security-policy') === CSP, `CSP: ${w.headers.get('content-security-policy')}`);
    varmista(w.headers.get('x-lahde') === 'ydin', 'X-Lahde ei ole ydin');
  });

  await tarkistus('2 fragmentti poistuu, lista = mock-vanhan /api/skoopit (X-Lahde: silta)', async () => {
    const listaVastaus = sivu.waitForResponse((r) => new URL(r.url()).pathname === '/api/skoopit' && r.request().method() === 'GET', { timeout: 15000 });
    await sivu.goto(`${YDIN}/web/#avain=${KOE_AVAIN}`);
    const v = await listaVastaus;
    varmista(v.headers()['x-lahde'] === 'silta', `X-Lahde: ${v.headers()['x-lahde']}`);
    await odota(async () => (await sivu.locator('[data-testid^="skooppi-"]').count()) === nimet.length, 10000, 'skooppilista ei täyty');
    const sivunNimet = await sivu.locator('[data-testid^="skooppi-"]').evaluateAll((es) => es.map((e) => (e.getAttribute('data-testid') ?? '').slice('skooppi-'.length)));
    varmista(JSON.stringify(sivunNimet) === JSON.stringify(nimet), 'lista eroaa mock-vanhan listasta');
    const hash = await sivu.evaluate(() => location.hash);
    varmista(hash === '', `fragmentti jäi: ${hash}`);
    varmista((await sivu.evaluate(() => localStorage.getItem('scopes2.avain'))) === KOE_AVAIN, 'avain ei tallentunut');
  });

  await tarkistus('3 viesti kulkee sillan läpi mock-vanhan kirjattuihin', async () => {
    const teksti = `integraatio ${Date.now()}`;
    await sivu.locator(`[data-testid="skooppi-${SKOOPPI}"]`).click();
    await sivu.locator('[data-testid="lahetys-kentta"]').fill(teksti);
    await sivu.locator('[data-testid="laheta"]').click();
    await odota(async () => {
      const k = (await (await fetch(`http://127.0.0.1:${VANHA_PORTTI}/__testi/kirjatut`)).json()) as { viestit: { skooppi: string; teksti: string }[] };
      return k.viestit.some((v) => v.skooppi === SKOOPPI && v.teksti === teksti);
    }, 8000, 'viesti ei päätynyt mock-vanhaan');
  });

  await tarkistus('4 chat: 3 palaa sillan läpi järjestyksessä, puskuroimatta', async () => {
    const r = await fetch(`${YDIN}/api/chat/virta`, { method: 'POST', headers: { ...A, 'content-type': 'application/json' }, body: JSON.stringify({ agentti: 'claude-sonnet-5-5', viesti: 'silta' }) });
    varmista(r.status === 200, `chat/virta → ${r.status}`);
    const lukija = r.body!.getReader();
    const dekoodi = new TextDecoder();
    const ajat: { tyyppi: string; t: number }[] = [];
    let puskuri = '';
    for (;;) {
      const { value, done } = await lukija.read();
      if (done) break;
      puskuri += dekoodi.decode(value, { stream: true });
      let i: number;
      while ((i = puskuri.indexOf('\n')) >= 0) {
        const rivi = puskuri.slice(0, i);
        puskuri = puskuri.slice(i + 1);
        if (rivi.trim()) ajat.push({ tyyppi: (JSON.parse(rivi) as { tyyppi: string }).tyyppi, t: performance.now() });
      }
    }
    varmista(JSON.stringify(ajat.map((a) => a.tyyppi)) === '["pala","pala","pala","valmis"]', `tapahtumat: ${ajat.map((a) => a.tyyppi).join(',')}`);
    const ero = ajat[2]!.t - ajat[0]!.t;
    varmista(ero >= 200 && ero < 1000, `ensimmäinen pala ${ero.toFixed(0)} ms ennen kolmatta (puskurointi?)`);
  });

  await tarkistus('5 PUT /api/tila/koe/web → sivu saa virtatapahtuman < 2 s', async () => {
    await odota(async () => (await sivu.evaluate(() => (window as unknown as { __virta: string[] }).__virta.length)) >= 0, 1000, 'virtaa ei ole');
    // Virta on auki, kun sivun jäsentämä ensimmäinen vastaus on tullut; odotetaan, että asiakas on kytketty (sivupalkki käynnistää sen).
    await odota(async () => (await sivu.locator('[data-testid="sivupalkki-yhteys"]').textContent())?.trim() !== 'katki', 5000, 'virta ei auki').catch(() => undefined);
    await new Promise((ok) => setTimeout(ok, 500));
    const alku = Date.now();
    const p = await fetch(`${YDIN}/api/tila/koe/web`, { method: 'PUT', headers: { ...A, 'content-type': 'application/json' }, body: JSON.stringify({ arvo: alku }) });
    varmista(p.status === 200, `PUT → ${p.status}`);
    await odota(async () => (await sivu.evaluate(() => (window as unknown as { __virta: string[] }).__virta.join(''))).includes('"id":"koe/web"'), 2000, 'virtatapahtumaa ei tullut 2 s:ssa');
  });

  await tarkistus('6 service worker valmis, välimuistissa vain kuoren polut', async () => {
    await sivu.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    const valimuistit = await sivu.evaluate(async () => {
      const ulos: Record<string, string[]> = {};
      for (const n of await caches.keys()) ulos[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
      return ulos;
    });
    const nimetV = Object.keys(valimuistit);
    varmista(nimetV.length === 1 && /^scopes2-kuori-[0-9a-f]{8}$/.test(nimetV[0]!), `välimuistit: ${nimetV.join(',')}`);
    const polut = [...valimuistit[nimetV[0]!]!].sort();
    varmista(JSON.stringify(polut) === JSON.stringify([...KUORIPOLUT].sort()), `välimuistin polut: ${polut.join(',')}`);
    varmista(!polut.some((p) => p.startsWith('/api/')), '/api/ välimuistissa');
  });

  await tarkistus('7 konsolivirheitä 0', async () => {
    varmista(konsolivirheet.length === 0, `konsolivirheitä: ${konsolivirheet.join(' | ')}`);
  });

  const ok = tulokset.filter((t) => t.ok).length;
  console.log(`INTEGRAATIO: ${ok}/7`);
  return ok === 7 ? 0 : 1;
}

let rc = 1;
try {
  rc = await main();
} catch (e) {
  console.error('INTEGRAATIO: virhe ' + (e instanceof Error ? e.stack : String(e)));
} finally {
  await siivoa();
}
process.exit(rc);
