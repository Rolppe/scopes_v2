// Takes the README screenshots: mock node (real fixtures from ydin/tests/fixture) -> Chrome -> PNGs in docs/images/.
// Usage: SCOPES2_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node test/kuvakaappaus.ts
import { join } from 'node:path';
import { avaaSelain, AVAIN, kaynnistaMock, WEB } from './apu.ts';

const UT = join(WEB, '..', 'docs', 'images');
const mock = await kaynnistaMock(18796, join(WEB, 'dist'));
const selain = await avaaSelain();
let rc = 0;
try {
  const { sivu } = selain;
  await sivu.setViewportSize({ width: 1280, height: 800 });
  await sivu.goto(`${mock.osoite}/web/#avain=${AVAIN}`);
  await sivu.waitForTimeout(1500);
  // open the scope that has a message history in the fixtures
  await sivu.getByText('scopes macos', { exact: true }).first().click();
  await sivu.waitForTimeout(1500);
  await sivu.screenshot({ path: join(UT, 'web-desktop.png') });
  await sivu.setViewportSize({ width: 390, height: 844 });
  await sivu.waitForTimeout(800);
  await sivu.screenshot({ path: join(UT, 'web-phone.png') });
  console.log('ok');
} catch (e) {
  console.error('FAIL ' + (e instanceof Error ? e.message : String(e)));
  rc = 1;
} finally {
  await selain.sulje();
  await mock.sulje();
}
process.exit(rc);
