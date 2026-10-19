// Web-asiakkaan käännös: esbuild src/main.ts → dist/app.js; src/index.html ja src/app.css kopioidaan dist/:iin.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const juuri = dirname(fileURLToPath(import.meta.url));
const dist = join(juuri, 'dist');

try {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await build({
    entryPoints: [join(juuri, 'src/main.ts')],
    outfile: join(dist, 'app.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: 'linked',
    minify: false,
    logLevel: 'warning',
  });
  await cp(join(juuri, 'src/index.html'), join(dist, 'index.html'));
  await cp(join(juuri, 'src/app.css'), join(dist, 'app.css'));
} catch (e) {
  console.error('BUILD: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
