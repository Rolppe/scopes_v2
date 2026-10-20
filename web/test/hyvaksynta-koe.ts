// T-44-koe: ajaa hyvaksynta.ts:n koeytimelle (koeportti 18797, mock-vanha 18796, tilapäinen --data, kertakäyttöavain).
// Ei kosketa tuotannon 8797:ää, 8787:ää eikä target/release-binääriä. Binääri: $CARGO_TARGET_DIR/release/scopes-solmu (gate: rust).
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { kaynnistaMock, WEB } from './apu.ts';
import type { Mock } from './apu.ts';

const YDIN_PORTTI = 18797;
const VANHA_PORTTI = 18796;
const KOE = '/tmp/scopes2-web-hyvaksynta-koe';
const YDIN = `http://127.0.0.1:${YDIN_PORTTI}`;
const DIST = join(WEB, 'dist');
const BINAARI = join(process.env['CARGO_TARGET_DIR'] ?? join(WEB, '../ydin/target/web-koe'), 'release/scopes-solmu');

const MUISTIRAJA_KIB = 1572864;
const MAC = process.platform === 'darwin';
// Vahdin todennus: SCOPES2_KOE_RSS_RAJA_KIB (esim. 1) laskee vain macOS-vahdin rajaa; Linuxin ulimit pysyy ennallaan.
const VAHTIRAJA_KIB = Number(process.env['SCOPES2_KOE_RSS_RAJA_KIB'] ?? '') || MUISTIRAJA_KIB;

let ydin: ChildProcess | null = null;
let mock: Mock | null = null;
let vahti: ReturnType<typeof setInterval> | undefined;
let rssHuippu = -1;
let ylitys = false;

function rssVahti(): void {
  const pid = ydin?.pid;
  if (pid === undefined || ydin?.exitCode !== null) return;
  const kib = Number(spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim());
  if (!(kib > 0)) return;
  rssHuippu = Math.max(rssHuippu, kib);
  if (kib > VAHTIRAJA_KIB && !ylitys) {
    ylitys = true;
    console.error(`VIRHE: ytimen RSS ${kib} kB > ${VAHTIRAJA_KIB} kB, ydin tapetaan`);
    try { process.kill(-pid, 'SIGKILL'); } catch { /* jo poissa */ }
  }
}

function portinVaraus(portti: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createConnection({ host: '127.0.0.1', port: portti });
    s.once('connect', () => { s.destroy(); ok(true); });
    s.once('error', () => ok(false));
  });
}

async function siivoa(): Promise<void> {
  clearInterval(vahti);
  if (ydin?.pid !== undefined && ydin.exitCode === null) {
    const valmis = new Promise<void>((ok) => ydin!.once('exit', () => ok()));
    try { process.kill(-ydin.pid, 'SIGTERM'); } catch { /* jo poissa */ }
    await Promise.race([valmis, new Promise((ok) => setTimeout(ok, 5000))]);
    try { process.kill(-ydin.pid, 'SIGKILL'); } catch { /* jo poissa */ }
  }
  ydin = null;
  await mock?.sulje().catch(() => undefined);
  mock = null;
  rmSync(KOE, { recursive: true, force: true });
}
for (const s of ['SIGINT', 'SIGTERM'] as const) {
  process.on(s, () => { void siivoa().finally(() => process.exit(143)); });
}

async function main(): Promise<number> {
  for (const [nimi, polku] of [['ydinbinääri', BINAARI], ['dist', join(DIST, 'index.html')]] as const) {
    if (!existsSync(polku)) { console.error(`PUUTTUU: ${nimi} ${polku}`); return 1; }
  }
  if ((await portinVaraus(YDIN_PORTTI)) || (await portinVaraus(VANHA_PORTTI))) {
    console.error('VIRHE: koeportti käytössä');
    return 1;
  }
  const avain = randomBytes(24).toString('hex');
  rmSync(KOE, { recursive: true, force: true });
  mkdirSync(join(KOE, 'data'), { recursive: true });
  writeFileSync(join(KOE, 'avain'), avain, { mode: 0o600 });
  writeFileSync(join(KOE, 'vanha-avain'), randomBytes(24).toString('hex'), { mode: 0o600 });

  mock = await kaynnistaMock(VANHA_PORTTI, DIST, ['--rooli', 'vanha']);
  // RLIMIT_DATA kuten kaynnista.sh (T-37); oma prosessiryhmä, jotta siivoa sammuttaa koko ryhmän. exec → pid = ytimen pid.
  // macOS (27) hylkää RLIMIT_DATA:n ja RLIMIT_AS:n (EINVAL): raja korvataan RSS-vahdilla, joka tappaa ytimen rajan ylittyessä.
  const rajoitus = MAC ? '' : `ulimit -d ${MUISTIRAJA_KIB} || { echo 'VIRHE: ulimit -d epäonnistui' >&2; exit 97; }; `;
  ydin = spawn('bash', ['-c', `${rajoitus}exec "$@"`, 'ydin', BINAARI,
    '--portti', String(YDIN_PORTTI), '--data', join(KOE, 'data'), '--avain', join(KOE, 'avain'), '--web', DIST,
    '--vanha', `http://127.0.0.1:${VANHA_PORTTI}`, '--vanha-avain', join(KOE, 'vanha-avain')], {
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let kuollut = false;
  ydin.once('exit', () => { kuollut = true; });
  if (MAC) vahti = setInterval(rssVahti, 500);
  for (let i = 0; ; i++) {
    if (kuollut) { console.error('VIRHE: ydin päättyi ennen valmistumista'); return 1; }
    try { if ((await fetch(`${YDIN}/api/terveys`)).ok) break; } catch { /* ei vielä */ }
    if (i >= 300) { console.error('VIRHE: ydin ei vastannut 30 s:ssa'); return 1; }
    await new Promise((ok) => setTimeout(ok, 100));
  }

  // Avain välitetään ympäristössä, ei komentorivillä.
  const lapsi = spawn(process.execPath, [join(WEB, 'test/hyvaksynta.ts'),
    '--osoite', YDIN, '--vanha', `http://127.0.0.1:${VANHA_PORTTI}`, '--pid', String(ydin.pid), '--git-scopes'], {
    stdio: 'inherit',
    env: { ...process.env, SCOPES2_AVAIN: avain },
  });
  const koodi = await new Promise<number>((ok) => lapsi.once('exit', (k) => ok(k ?? 1)));
  if (MAC) console.log(`ytimen RSS-huippu (vahti 0,5 s): ${rssHuippu} kB, raja ${VAHTIRAJA_KIB} kB`);
  return ylitys ? 1 : koodi;
}

let rc = 1;
try {
  rc = await main();
} catch (e) {
  console.error('T-44-koe: virhe ' + (e instanceof Error ? e.stack : String(e)));
} finally {
  await siivoa();
}
process.exit(rc);
