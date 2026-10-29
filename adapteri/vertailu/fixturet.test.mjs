// node --test --test-timeout=60000 scopes2/adapteri/vertailu/fixturet.test.mjs
// Vanhan käytöksen fixturet (testidata/toiminnot/*.json, tallenna-vanha.mjs): muoto, yksilölliset nimet ja kattavuus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HAKEMISTO = fileURLToPath(new URL('../testidata/toiminnot/', import.meta.url));
const tiedostot = readdirSync(HAKEMISTO).filter((f) => f.endsWith('.json')).sort();
const fixturet = tiedostot.map((f) => ({ f, teksti: readFileSync(join(HAKEMISTO, f), 'utf8') }));
const jasennetyt = fixturet.map(({ f, teksti }) => ({ f, teksti, o: JSON.parse(teksti) }));

// Pakolliset tapaukset (T-63-G Do 5), nimi = tiedoston nimi ilman .json-päätettä.
const PAKOLLISET = [
  'viesti-ok', 'viesti-kysymys-auki', 'viesti-vaara-ruutu', 'viesti-ei-istuntoa', 'viesti-liian-pitka',
  'stop-kiireinen', 'stop-vapaa',
  'kysymys-pois-ok', 'kysymys-pois-ei-kysymysta',
  ...['pakkaa', 'automaattisiirto', 'herata', 'herata-pois'].flatMap((r) => ['vapaa', 'kiireinen', 'kysymys-auki'].map((t) => `${r}-${t}`)),
  'pura-perhe', 'pura-ei-perhe', 'pura-toinen-toiminto-kaynnissa',
  'chat-ok', 'chat-virta', 'chat-keskustelut-lista', 'chat-keskustelut-yksi',
];
// Reittiryhmät, joiden jokaiselta on oltava vähintään yksi fixture.
const RYHMAT = ['viesti', 'stop', 'kysymys-pois', 'pakkaa', 'automaattisiirto', 'herata', 'herata-pois', 'pura', 'chat'];

test('fixturet: hakemistossa on fixtureja ja jokainen parsiutuu', () => {
  assert.ok(tiedostot.length >= PAKOLLISET.length, `fixtureja ${tiedostot.length}`);
  assert.equal(jasennetyt.length, tiedostot.length);
});

test('fixturet: pakolliset kentät', () => {
  for (const { f, o } of jasennetyt) {
    assert.equal(typeof o.tapaus, 'string', f);
    assert.equal(o.tapaus, f.slice(0, -5), `${f}: tapaus = tiedostonimi`);
    assert.ok(['GET', 'POST'].includes(o.pyynto?.metodi), `${f}: metodi`);
    assert.match(o.pyynto?.polku ?? '', /^\/api\//, `${f}: polku`);
    assert.ok('runko' in o.pyynto, `${f}: pyynto.runko`);
    for (const k of ['skooppitiedot', 'istunnot', 'transkriptit', 'tmux', 'komennot']) assert.ok(o.ymparisto?.[k] !== undefined, `${f}: ymparisto.${k}`);
    assert.ok(Number.isInteger(o.odotus?.status), `${f}: odotus.status`);
    assert.ok(('runko' in o.odotus) !== ('ndjson' in o.odotus), `${f}: täsmälleen yksi kentistä runko ja ndjson`);
    if ('ndjson' in o.odotus) assert.ok(Array.isArray(o.odotus.ndjson) && o.odotus.ndjson.length > 0, `${f}: ndjson`);
    assert.ok(Array.isArray(o.odotus.aja), `${f}: odotus.aja`);
    for (const k of o.odotus.aja) assert.ok(Array.isArray(k) && k.length > 0 && k.every((x) => typeof x === 'string'), `${f}: aja-rivi [komento, ...argv]`);
  }
});

test('fixturet: tapausnimet ovat yksilöllisiä', () => {
  const nimet = jasennetyt.map(({ o }) => o.tapaus);
  assert.equal(new Set(nimet).size, nimet.length);
});

test('fixturet: tapauslista kattaa pakolliset tapaukset ja reittiryhmät', () => {
  const nimet = new Set(jasennetyt.map(({ o }) => o.tapaus));
  for (const p of PAKOLLISET) assert.ok(nimet.has(p), `puuttuu: ${p}`);
  for (const r of RYHMAT) assert.ok([...nimet].some((n) => n === r || n.startsWith(`${r}-`)), `reittiryhmä puuttuu: ${r}`);
});

test('fixturet: deterministiset (ei absoluuttisia väliaikaispolkuja eikä käyttäjäkohtaisia polkuja)', () => {
  for (const { f, teksti } of fixturet) {
    assert.doesNotMatch(teksti, /\/Users\/|\/home\/|\/var\/folders|\/private\/|tallenna-vanha-/, f);
  }
});

test('fixturet: odotetut tilat vastaavat vanhaa käytöstä (otos)', () => {
  const tapaus = (n) => jasennetyt.find(({ o }) => o.tapaus === n).o;
  assert.equal(tapaus('stop-vapaa').odotus.status, 409);
  assert.equal(tapaus('kysymys-pois-ei-kysymysta').odotus.status, 409);
  assert.equal(tapaus('pura-toinen-toiminto-kaynnissa').odotus.status, 429);
  assert.equal(tapaus('viesti-liian-pitka').odotus.status, 413);
  assert.deepEqual(tapaus('viesti-kysymys-auki').odotus.viiveet, [800]);
  assert.equal(tapaus('herata-kiireinen').odotus.runko.jonossa, true);
  assert.equal(tapaus('pakkaa-kiireinen').odotus.status, 409);
  assert.equal(tapaus('chat-virta').odotus.ndjson.at(-1).tyyppi, 'valmis');
});

// ---------- T-79-G: lisäreittien fixturet (tallenna-lisa.mjs) ja mockit ----------
// Pakolliset lisätapaukset (T-79-G Do 2), nimi = tiedoston nimi ilman .json-päätettä.
const LISA_PAKOLLISET = {
  malli: ['malli-ok', 'effort-ok', 'ei-vapaa', 'kysymys-auki', 'effort-vahvistusdialogi', 'tuntematon-malli'],
  uusi: ['ok', 'skooppi-on-jo', 'agy', 'toinen-toiminto-kaynnissa', 'virheellinen-nimi'],
  agentit: ['android-mukana', 'android-pois', 'nebius-avain-on', 'nebius-avain-ei', 'lmstudio-vastaa', 'lmstudio-ei-vastaa'],
  asetukset: ['yhteinen-paalle', 'yhteinen-pois', 'tuntematon-nimi', 'istunto-paalle', 'istunto-ilman-istuntoa', 'istunto-useita-ilman-valintaa', 'istunto-useita-valinta', 'istunto-tuntematon', 'istunto-agyluvat-hylatty'],
  android: ['napauta', 'pyyhkaise', 'nappi', 'avaa', 'uusi', 'kirjoita', 'laheta', 'talteen', 'ruutu', 'ui', 'tuotokset', 'tuotos', 'liite', 'napauta-kuiva', 'liite-kuiva', 'kirjoita-liite-odottaa', 'heratys', 'nukutus'],
  linux: ['tila-linux', 'tila-windows', 'tila-sammuksissa', 'kaynnista-linux', 'kaynnista-windows', 'kaynnista-sammuksissa', 'sammuta-linux', 'sammuta-sammuksissa', 'sammuta-windows', 'kaynnista-toinen-toiminto-kaynnissa', 'kaynnista-sammuksissa-kuiva'],
};
const lisaNimet = new Set(jasennetyt.map(({ o }) => o.tapaus));
const lisaTapaus = (n) => jasennetyt.find(({ o }) => o.tapaus === n).o;

test('lisäfixturet: pakolliset tapaukset jokaiselle lisämoduulille', () => {
  for (const [moduuli, tapaukset] of Object.entries(LISA_PAKOLLISET)) {
    for (const t of tapaukset) {
      const nimi = t === 'malli-ok' ? 'malli-malli-ok' : `${moduuli}-${t}`;
      assert.ok(lisaNimet.has(nimi), `puuttuu: ${nimi}`);
    }
  }
});

test('lisäfixturet: binäärivastaus on { tyyppi, base64 } ja paikkamerkit ovat sovitut', () => {
  for (const n of ['android-ruutu', 'android-ruutu-leveys', 'android-tuotos']) {
    const r = lisaTapaus(n).odotus.runko;
    assert.match(r.tyyppi, /^(image|text)\//, n);
    assert.ok(Buffer.from(r.base64, 'base64').length > 0, n);
  }
  assert.equal(Buffer.from(lisaTapaus('android-ruutu').odotus.runko.base64, 'base64').subarray(0, 2).toString('hex'), 'ffd8'); // JPEG
  assert.match(lisaTapaus('android-talteen').odotus.runko.polku, /^<ANDROID>\//);
  assert.ok(lisaTapaus('linux-kaynnista-sammuksissa-kuiva').odotus.runko.kuiva.includes('<REPO>/Infra/linux/palvelin/herata-pc.py'));
  assert.ok(lisaTapaus('android-liite').odotus.aja.some((k) => k.includes('push') && k.some((x) => x.startsWith('<LIITTEET>/'))));
});

test('lisäfixturet: odotetut tilat vastaavat vanhaa käytöstä (otos)', () => {
  const st = (n) => lisaTapaus(n).odotus.status;
  assert.deepEqual(['malli-malli-ok', 'malli-ei-vapaa', 'malli-kysymys-auki', 'malli-effort-vahvistusdialogi', 'malli-tuntematon-malli'].map(st), [200, 409, 409, 409, 400]);
  assert.deepEqual(['uusi-ok', 'uusi-skooppi-on-jo', 'uusi-agy', 'uusi-toinen-toiminto-kaynnissa', 'uusi-virheellinen-nimi'].map(st), [200, 409, 200, 429, 400]);
  assert.deepEqual(['asetukset-yhteinen-paalle', 'asetukset-tuntematon-nimi', 'asetukset-istunto-ilman-istuntoa', 'asetukset-istunto-useita-ilman-valintaa', 'asetukset-istunto-tuntematon', 'asetukset-istunto-agyluvat-hylatty'].map(st), [200, 404, 409, 409, 404, 404]);
  assert.deepEqual(['linux-kaynnista-linux', 'linux-sammuta-sammuksissa', 'linux-sammuta-windows', 'linux-kaynnista-toinen-toiminto-kaynnissa'].map(st), [200, 409, 409, 429]);
  assert.equal(st('android-kirjoita-liite-odottaa'), 409);
  assert.deepEqual(lisaTapaus('malli-effort-vahvistusdialogi').odotus.viiveet, [1000, 1000, 1000, 1000]); // avaa, vahvista, Escape, numero 2
  assert.deepEqual(lisaTapaus('asetukset-istunto-paalle').odotus.asetuksetTila, [{ tiedosto: 'istunnot/sessio-a-0001/automaattivalinta.txt', sisalto: 'true\n' }]);
  assert.ok(lisaTapaus('agentit-android-mukana').odotus.runko.some((m) => m.nimi === 'android/gemini'));
  assert.ok(!lisaTapaus('agentit-android-pois').odotus.runko.some((m) => m.nimi === 'android/gemini'));
  assert.ok(lisaTapaus('agentit-nebius-avain-on').odotus.runko.some((m) => m.nimi.startsWith('nebius/')));
  assert.ok(!lisaTapaus('agentit-nebius-avain-ei').odotus.runko.some((m) => m.nimi.startsWith('nebius/')));
  assert.ok(lisaTapaus('agentit-lmstudio-vastaa').odotus.runko.some((m) => m.nimi.startsWith('palvelin/')));
  assert.ok(!lisaTapaus('agentit-lmstudio-ei-vastaa').odotus.runko.some((m) => m.nimi.startsWith('palvelin/')));
  assert.equal(lisaTapaus('android-nukutus').odotus.myohemmin.nukutettu, true);
  assert.equal(lisaTapaus('android-nukutus-ei-viela').odotus.myohemmin.nukutettu, false);
  assert.ok(lisaTapaus('uusi-agy').odotus.aja.every((k) => !(k[0] === 'bash' && k.includes('--viesti')))); // autovaihto ilman viestiä
});

test('lisämockit: adb, ping, python3 ja ssh kirjaavat argv:n ja vastaavat sääntöjen mukaan', () => {
  const MOCK = fileURLToPath(new URL('../testidata/tmux-mock/', import.meta.url));
  const d = mkdtempSync(join(tmpdir(), 'mock-lisa-'));
  try {
    const loki = join(d, 'loki');
    const data = join(d, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'adb.json'), JSON.stringify([{ sisaltaa: 'screencap', stdoutBase64: Buffer.from([0xff, 0xd8]).toString('base64') }, { sisaltaa: 'wm size', stdout: 'Physical size: 1080x2400\n' }, { koodi: 3, stderr: 'muu' }]));
    writeFileSync(join(data, 'ping.json'), JSON.stringify([{ sisaltaa: '192.0.2.99', stdout: 'ttl=64\n' }]));
    writeFileSync(join(data, 'python3.json'), JSON.stringify([{ sisaltaa: 'herata-pc.py', stdout: 'Linux vastaa\n' }]));
    writeFileSync(join(data, 'ssh.json'), JSON.stringify([{ sisaltaa: 'pc', koodi: 0 }, { sisaltaa: 'curl', stdout: '{"data":[]}' }, { sisaltaa: 'poweroff', koodi: 255, stderr: 'closed' }]));
    const env = { ...process.env, TMUX_MOCK_LOKI: loki, TMUX_MOCK_DATA: data };
    const aja = (komento, ...argv) => spawnSync(join(MOCK, komento), argv, { env, input: komento === 'python3' ? 'png' : '' });
    const a1 = aja('adb', '-s', '127.0.0.1:5555', 'exec-out', 'screencap', '-p');
    assert.deepEqual([a1.status, [...a1.stdout]], [0, [0xff, 0xd8]]);
    assert.equal(aja('adb', '-s', 'x', 'shell', 'wm size').stdout.toString(), 'Physical size: 1080x2400\n');
    const a3 = aja('adb', '-s', 'x', 'shell', 'input tap 1 2');
    assert.deepEqual([a3.status, a3.stderr.toString()], [3, 'muu']);
    assert.deepEqual([aja('ping', '-c', '1', '-W', '2', '192.0.2.99').status, aja('ping', '-c', '1', '-W', '2', '192.0.2.99').stdout.toString()], [0, 'ttl=64\n']);
    assert.equal(aja('ping', '-c', '1', '-W', '2', '192.0.2.99').status, 1); // ei vastaa
    assert.equal(aja('python3', '/x/herata-pc.py', '--odota', '90').stdout.toString(), 'Linux vastaa\n');
    assert.equal(aja('ssh', '-o', 'BatchMode=yes', 'pc', 'linux').status, 0);
    assert.equal(aja('ssh', 'palvelin', 'curl -s http://127.0.0.1:1234/v1/models').stdout.toString(), '{"data":[]}');
    assert.deepEqual([aja('ssh', 'palvelin', 'sudo -n /usr/sbin/poweroff').status], [255]);
    const rivit = readFileSync(loki, 'utf8').trim().split('\n').map((r) => JSON.parse(r));
    assert.equal(rivit[0].komento, 'adb');
    assert.deepEqual(rivit[0].argv, ['-s', '127.0.0.1:5555', 'exec-out', 'screencap', '-p']);
    assert.ok(rivit.some((r) => r.komento === 'python3' && r.syote === '<stdin 3 tavua>'));
    assert.equal(rivit.filter((r) => r.komento === 'ssh').length, 3);
    // T-63-G:n ssh-käytös säilyy: ilman ssh.json:ia vastaus tulee ssh.txt:stä ja koodi ssh.koodi:sta.
    rmSync(join(data, 'ssh.json'));
    writeFileSync(join(data, 'ssh.txt'), 'vanha vastaus\n');
    writeFileSync(join(data, 'ssh.koodi'), '7');
    const s = aja('ssh', 'palvelin', 'x');
    assert.deepEqual([s.status, s.stdout.toString()], [7, 'vanha vastaus\n']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
