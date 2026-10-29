// Skriptimockien yhteinen runko (T-63-G): mock-skripti.mjs <avain> <argv…>. Kirjaa kutsun (komento = avain ilman -perhe-päätettä)
// ja vastaa datahakemistosta avaimella. Oletusvastaukset: kts. autovaihto.sh-, pura-malliton.mjs- ja arkistoi-skooppi.mjs-mockit.
import { kirjaa, vastaa } from './mock-lib.mjs';

const [avain, ...argv] = process.argv.slice(2);
const OLETUS = {
  autovaihto: { stdout: 'OK: https://claude.ai/code/session_REDACTED\n' },
  'pura-malliton-perhe': { stdout: 'PERHE: ei\n', koodi: 1 },
  'pura-malliton': { stdout: 'KIRJOITETTU: mock\n' },
  'arkistoi-skooppi': { stdout: 'POISTETTU: mock\n' },
};
kirjaa(avain.replace(/-perhe$/, ''), argv);
process.exitCode = vastaa(avain, OLETUS[avain] ?? {});
