// arkistoi-skooppi.mjs-mock (T-63-G): `node <juuri>/claude/siirto/tools/arkistoi-skooppi.mjs <skooppi>`.
// Kirjaa argv lokiin. Vastaus: arkistoi-skooppi.{txt,stderr,koodi} (oletus exit 0, "POISTETTU: mock").
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../../../mock-skripti.mjs', import.meta.url)), 'arkistoi-skooppi', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
