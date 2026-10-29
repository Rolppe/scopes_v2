// pura-malliton.mjs-mock (T-63-G): `node <juuri>/claude/siirto/tools/pura-malliton.mjs --perhe <skooppi>` tai `<skooppi> --kohde … [--suljettavat …]`.
// Kirjaa argv lokiin. Vastaus: --perhe → pura-malliton-perhe.{txt,stderr,koodi} (oletus exit 1, "PERHE: ei");
// muuten pura-malliton.{txt,stderr,koodi} (oletus exit 0, "KIRJOITETTU: mock").
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../../../mock-skripti.mjs', import.meta.url)),
  process.argv[2] === '--perhe' ? 'pura-malliton-perhe' : 'pura-malliton', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
