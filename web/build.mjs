// Web-asiakkaan käännös: esbuild src/main.ts → dist/app.js; src/index.html ja src/app.css kopioidaan dist/:iin.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  // PWA (T-43): manifest, kuvakkeet ja service worker, jonka välimuistin nimeen tulee app.js:n tiiviste.
  await cp(join(juuri, 'manifest.webmanifest'), join(dist, 'manifest.webmanifest'));
  await cp(join(juuri, 'kuvakkeet'), join(dist, 'kuvakkeet'), { recursive: true });
  const tiiviste = createHash('sha256').update(await readFile(join(dist, 'app.js'))).digest('hex').slice(0, 8);
  await writeFile(join(dist, 'sw.js'), (await readFile(join(juuri, 'sw.js'), 'utf8')).replaceAll('__TIIVISTE__', tiiviste));
} catch (e) {
  console.error('BUILD: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
