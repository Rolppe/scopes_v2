// T-38 savutesti: build → mock 18796 → Chromium → kuori ja kuusi näkymää olemassa, konsolivirheitä 0.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { avaaSelain, AVAIN, kaynnistaMock, WEB } from './apu.ts';

const NAKYMAT = ['sivupalkki', 'viestit', 'lahetys', 'chat', 'infra', 'asetukset'];
const VALILEHDET = ['viestit', 'chat', 'infra', 'asetukset'];

function varmista(ehto: boolean, viesti: string): void {
  if (!ehto) throw new Error(viesti);
}

const rakennus = spawnSync(process.execPath, [join(WEB, 'build.mjs')], { stdio: 'inherit' });
varmista(rakennus.status === 0, 'build.mjs epäonnistui');

const mock = await kaynnistaMock(18796, join(WEB, 'dist'));
const selain = await avaaSelain();
let rc = 0;
try {
  const { sivu, konsolivirheet } = selain;
  await sivu.goto(`${mock.osoite}/web/#avain=${AVAIN}`);
  varmista((await sivu.title()) === 'scopes-V2', `title ${await sivu.title()}`);
  for (const n of NAKYMAT) {
    varmista((await sivu.locator(`[data-testid="nakyma-${n}"]`).count()) === 1, `nakyma-${n} puuttuu`);
  }
  for (const v of VALILEHDET) {
    await sivu.locator(`[data-testid="valilehti-${v}"]`).click();
    varmista((await sivu.locator(`[data-testid="valilehti-${v}"]`).getAttribute('aria-selected')) === 'true', `valilehti-${v} ei valittu`);
    varmista(await sivu.locator(`[data-testid="nakyma-${v}"]`).isVisible(), `nakyma-${v} ei näy välilehdellä`);
  }
  await sivu.waitForTimeout(300);
  varmista(konsolivirheet.length === 0, `konsolivirheitä: ${konsolivirheet.join(' | ')}`);
  console.log('SAVU: ok');
} catch (e) {
  console.error('SAVU: FAIL ' + (e instanceof Error ? e.message : String(e)));
  rc = 1;
} finally {
  await selain.sulje();
  await mock.sulje();
}
process.exit(rc);
