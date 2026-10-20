// T-44 hyväksyntäajo: kuusi tarkistusta ARK-10-asiakkaalle ytimen /web/-osoitteessa (SUUNNITELMA luku 11.1 T-44).
//   node test/hyvaksynta.ts --osoite http://127.0.0.1:18797 [--avain-tiedosto <polku>] [--vanha <osoite>] [--pid <n>] [--git-scopes]
// Avain: ympäristömuuttuja SCOPES2_AVAIN tai --avain-tiedosto (ei komentorivillä, ei lokiin). Oletusosoite on koeportti, ei 8797:
// tuotantoajossa osoite annetaan itse. Valinnaiset ehdot: --vanha (vanhan palvelun /api/terveys 200 ennen ja jälkeen),
// --pid (ytimen VmHWM < 512 MiB), --git-scopes (`git status -- scopes/` ei uusia rivejä).
// Exit: 0 kaikki vihreää, 1 jokin tarkistus tai ehto punainen, 2 käyttövirhe.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { avaaSelain, WEB } from './apu.ts';

const KOEPORTTI_OLETUS = 'http://127.0.0.1:18797';
const CHAT_VIESTI = 'Vastaa vain sanalla ok.';
const CHAT_AIKARAJA_MS = 120000;
const HWM_RAJA_KIB = 512 * 1024;

function arvo(nimi: string): string | undefined {
  const i = process.argv.indexOf(nimi);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const liput = new Set(process.argv.slice(2));

const OSOITE = (arvo('--osoite') ?? KOEPORTTI_OLETUS).replace(/\/+$/, '');
const AVAIN = (() => {
  const tiedosto = arvo('--avain-tiedosto');
  const raaka = tiedosto !== undefined ? readFileSync(tiedosto, 'utf8') : process.env['SCOPES2_AVAIN'];
  return (raaka ?? '').trim();
})();
if (AVAIN === '') {
  console.error('KÄYTTÖ: avain puuttuu (SCOPES2_AVAIN tai --avain-tiedosto)');
  process.exit(2);
}
const VANHA = arvo('--vanha')?.replace(/\/+$/, '');
const PID = arvo('--pid');
const GIT_SCOPES = liput.has('--git-scopes');
const A = { authorization: `Bearer ${AVAIN}` };

const tulokset: { nimi: string; ok: boolean }[] = [];
async function tarkistus(nimi: string, f: () => Promise<void>): Promise<void> {
  try {
    await f();
    tulokset.push({ nimi, ok: true });
    console.log(`ok   ${nimi}`);
  } catch (e) {
    tulokset.push({ nimi, ok: false });
    console.error(`FAIL ${nimi}: ${e instanceof Error ? e.message : String(e)}`);
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
async function api<T>(polku: string, init?: RequestInit): Promise<{ status: number; runko: T }> {
  const r = await fetch(`${OSOITE}${polku}`, { ...init, headers: { ...A, ...(init?.headers ?? {}) } });
  const teksti = await r.text();
  let runko: unknown = null;
  try { runko = JSON.parse(teksti); } catch { runko = teksti; }
  return { status: r.status, runko: runko as T };
}
const koodaa = (s: string): string => s.split('/').map(encodeURIComponent).join('/');
const nimet = (lista: unknown): string[] => (lista as { nimi: string }[]).map((s) => s.nimi);
const viestitLista = (runko: unknown): unknown[] => (Array.isArray(runko) ? runko : (runko as { viestit: unknown[] }).viestit);

async function terveys(osoite: string): Promise<number> {
  try { return (await fetch(`${osoite}/api/terveys`)).status; } catch { return 0; }
}
function gitScopes(): string {
  const r = spawnSync('git', ['-C', WEB, 'status', '--porcelain', '--', '../../scopes/'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : `VIRHE ${r.status}`;
}

async function main(): Promise<number> {
  const ehdot: { nimi: string; ok: boolean }[] = [];
  const ehto = (nimi: string, ok: boolean, selite: string): void => {
    ehdot.push({ nimi, ok });
    if (ok) console.log(`ok   ehto: ${nimi}`); else console.error(`FAIL ehto: ${nimi}: ${selite}`);
  };

  const terveysEnnen = VANHA !== undefined ? await terveys(VANHA) : 0;
  const gitEnnen = GIT_SCOPES ? gitScopes() : '';

  const yht = await api<{ ok: boolean }>('/api/terveys');
  if (yht.status !== 200) { console.error(`VIRHE: ${OSOITE}/api/terveys → ${yht.status}`); return 1; }
  const skoopitAlku = nimet((await api<unknown>('/api/skoopit')).runko);
  if (skoopitAlku.length === 0) { console.error('VIRHE: /api/skoopit tyhjä'); return 1; }

  const selain = await avaaSelain();
  const { sivu } = selain;
  try {
    // Tallennetaan sivun saamat virrat: /api/virta (S-1, SSE) ja /api/chat/virta (NDJSON); Playwright ei näe fetch-virtojen runkoa.
    await sivu.addInitScript(() => {
      const w = window as unknown as { __virta: string[]; __chat: string[] };
      w.__virta = [];
      w.__chat = [];
      const f = window.fetch.bind(window);
      window.fetch = async (...a: Parameters<typeof fetch>) => {
        const r = await f(...a);
        const u = a[0] instanceof Request ? a[0].url : String(a[0]);
        const kohde = u.includes('/api/chat/virta') ? w.__chat : u.includes('/api/virta') ? w.__virta : null;
        if (kohde !== null && r.body) {
          const [x, y] = r.body.tee();
          void (async () => {
            const lukija = x.getReader();
            const dekoodi = new TextDecoder();
            for (;;) {
              const { value, done } = await lukija.read().catch(() => ({ value: undefined, done: true }));
              if (done) break;
              kohde.push(dekoodi.decode(value, { stream: true }));
            }
          })();
          return new Response(y, { status: r.status, headers: r.headers });
        }
        return r;
      };
    });
    await sivu.goto(`${OSOITE}/web/#avain=${AVAIN}`);
    const t = (id: string) => sivu.locator(`[data-testid="${id}"]`);
    const sivunSkoopit = (): Promise<string[]> =>
      sivu.locator('[data-testid^="skooppi-"]').evaluateAll((es) => es.map((e) => (e.getAttribute('data-testid') ?? '').slice('skooppi-'.length)));

    await tarkistus('1 skooppilista = /api/skoopit-nimet', async () => {
      const api1 = nimet((await api<unknown>('/api/skoopit')).runko);
      await odota(async () => (await sivu.locator('[data-testid^="skooppi-"]').count()) === api1.length, 15000, `sivun lista ei täyty (${api1.length} skooppia)`);
      const sivu1 = await sivunSkoopit();
      varmista(JSON.stringify([...sivu1].sort()) === JSON.stringify([...api1].sort()), 'sivun lista eroaa /api/skoopit-nimistä');
    });

    let eniten = { nimi: '', maara: -1 };
    await tarkistus('2 eniten viestejä sisältävän skoopin viestimäärä = API', async () => {
      for (const nimi of skoopitAlku) {
        const v = await api<unknown>(`/api/skoopit/${koodaa(nimi)}/viestit`);
        if (v.status !== 200) continue;
        const n = viestitLista(v.runko).length;
        if (n > eniten.maara) eniten = { nimi, maara: n };
      }
      varmista(eniten.maara >= 0, 'yhdenkään skoopin viestejä ei saatu');
      await t(`skooppi-${eniten.nimi}`).click();
      await odota(async () => (await t('viesti').count()) === eniten.maara, 15000, `sivulla ${await t('viesti').count()} viestiä, API:ssa ${eniten.maara} (${eniten.nimi})`);
    });

    await tarkistus('3 viesti olemattomaan skooppiin → sillan virhe, ei sivuvaikutusta', async () => {
      const olematon = `ei-ole-hyvaksynta-${Date.now()}`;
      const r = await api<{ virhe?: string }>(`/api/skoopit/${koodaa(olematon)}/viesti`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teksti: 'hyväksyntä: ei saa mennä perille' }),
      });
      varmista(r.status === 404, `POST olemattomaan → ${r.status}, odotettu 404`);
      varmista(typeof r.runko === 'object' && typeof r.runko?.virhe === 'string' && r.runko.virhe !== '', `virhettä ei näy rungossa: ${JSON.stringify(r.runko)}`);
      const jalkeen = nimet((await api<unknown>('/api/skoopit')).runko);
      varmista(JSON.stringify(jalkeen) === JSON.stringify(skoopitAlku), 'skooppilista muuttui');
      varmista(!jalkeen.includes(olematon), 'olematon skooppi ilmestyi listaan');
      if (eniten.nimi !== '') {
        const n = viestitLista((await api<unknown>(`/api/skoopit/${koodaa(eniten.nimi)}/viestit`)).runko).length;
        varmista(n === eniten.maara, `${eniten.nimi}: viestimäärä ${eniten.maara} → ${n}`);
      }
    });

    await tarkistus('4 chat: viesti ensimmäiselle Claude-agentille → ≥ 1 pala + valmis', async () => {
      const agentit = nimet((await api<unknown>('/api/agentit')).runko);
      const agentti = agentit.find((n) => n.toLowerCase().startsWith('claude'));
      varmista(agentti !== undefined, `Claude-agenttia ei ole: ${agentit.join(',')}`);
      await t('valilehti-chat').click();
      await sivu.waitForFunction((n) => document.querySelectorAll('[data-testid="agentti"] option').length === n, agentit.length, { timeout: 10000 });
      await t('agentti').selectOption(agentti!);
      await t('chat-syote').fill(CHAT_VIESTI);
      await t('chat-laheta').click();
      await sivu.waitForFunction(() => !(document.querySelector('[data-testid="chat-laheta"]') as HTMLButtonElement).disabled, null, { timeout: CHAT_AIKARAJA_MS });
      const tyypit = (await sivu.evaluate(() => (window as unknown as { __chat: string[] }).__chat.join('')))
        .split('\n').filter((r) => r.trim() !== '').map((r) => (JSON.parse(r) as { tyyppi: string }).tyyppi);
      varmista(tyypit.filter((x) => x === 'pala').length >= 1, `paloja ei tullut: ${tyypit.join(',')}`);
      varmista(tyypit.includes('valmis'), `valmis puuttuu: ${tyypit.join(',')}`);
      varmista(await t('chat-virhe').isHidden(), 'chat-virhe näkyy');
      varmista(((await sivu.locator('[data-testid="chat-viesti"].agentti').last().textContent()) ?? '').trim() !== '', 'agentin vastaus sivulla tyhjä');
    });

    await tarkistus('5 rekisterilista = /api/rekisterit ja yksi osat-näkymä', async () => {
      const rekisterit = (await api<{ polku: string }[]>('/api/rekisterit')).runko;
      varmista(Array.isArray(rekisterit) && rekisterit.length > 0, '/api/rekisterit tyhjä');
      await t('valilehti-infra').click();
      await odota(async () => (await sivu.locator('[data-testid="rekisterit"] tbody tr').count()) === rekisterit.length, 15000,
        `sivulla ${await sivu.locator('[data-testid="rekisterit"] tbody tr').count()} riviä, API:ssa ${rekisterit.length}`);
      // Ensimmäinen rekisteri, jolla on osia (tyhjillä rekistereillä ei ole mitä näyttää).
      let eka = '';
      for (const r of rekisterit) {
        const osat = await api<{ osat?: unknown[] }>(`/api/rekisterit/${koodaa(r.polku)}`);
        if (osat.status === 200 && Array.isArray(osat.runko.osat) && osat.runko.osat.length > 0) { eka = r.polku; break; }
      }
      varmista(eka !== '', 'yhdelläkään rekisterillä ei ole osia /api/rekisterit/<polku>-vastauksessa');
      await t(`rekisteri-${eka}`).click();
      await sivu.waitForFunction(() => !(document.querySelector('[data-testid="rekisteri-osat"]') as HTMLElement).hidden, null, { timeout: 15000 });
      varmista((await t('rekisteri-osat').locator('pre').count()) > 0, 'osat ilman esimuotoiltua tekstiä');
    });

    await tarkistus('6 PUT /api/tila/koe/web → sivu näkee virtatapahtuman < 2 s', async () => {
      await odota(async () => (await t('sivupalkki-yhteys').textContent())?.trim() !== 'katki', 5000, 'virta ei auki').catch(() => undefined);
      await new Promise((ok) => setTimeout(ok, 500));
      const maaraEnnen = await sivu.evaluate(() => (window as unknown as { __virta: string[] }).__virta.length);
      const p = await api<unknown>('/api/tila/koe/web', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arvo: Date.now() }) });
      varmista(p.status === 200, `PUT → ${p.status}`);
      await odota(async () => {
        const uudet = await sivu.evaluate((n) => (window as unknown as { __virta: string[] }).__virta.slice(n).join(''), maaraEnnen);
        return uudet.includes('"id":"koe/web"');
      }, 2000, 'virtatapahtumaa ei tullut 2 s:ssa');
    });
  } finally {
    await selain.sulje().catch(() => undefined);
  }

  // Lisäehdot (valinnaiset): vanha palvelu elää, ytimen muisti, vanha puu koskematon.
  if (VANHA !== undefined) {
    const jalkeen = await terveys(VANHA);
    ehto('vanha /api/terveys 200 ennen ja jälkeen', terveysEnnen === 200 && jalkeen === 200, `ennen ${terveysEnnen}, jälkeen ${jalkeen}`);
  }
  if (PID !== undefined) {
    let hwm = -1;
    try { hwm = Number(/^VmHWM:\s+(\d+) kB/m.exec(readFileSync(`/proc/${PID}/status`, 'utf8'))?.[1] ?? -1); } catch { /* prosessi poissa */ }
    ehto(`ytimen VmHWM < 512 MiB (pid ${PID})`, hwm >= 0 && hwm < HWM_RAJA_KIB, `VmHWM ${hwm} kB`);
  }
  if (GIT_SCOPES) {
    const jalkeen = gitScopes();
    ehto('git status -- scopes/ ei uusia rivejä', jalkeen === gitEnnen, `ennen:\n${gitEnnen}\njälkeen:\n${jalkeen}`);
  }

  const ok = tulokset.filter((x) => x.ok).length;
  console.log(`HYVÄKSYNTÄ: ${ok}/6`);
  if (ehdot.length > 0) console.log(`EHDOT: ${ehdot.filter((e) => e.ok).length}/${ehdot.length}`);
  return ok === 6 && ehdot.every((e) => e.ok) ? 0 : 1;
}

let rc = 1;
try {
  rc = await main();
} catch (e) {
  console.error('HYVÄKSYNTÄ: virhe ' + (e instanceof Error ? e.stack : String(e)));
}
process.exit(rc);
