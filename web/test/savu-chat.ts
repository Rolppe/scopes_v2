// T-42 savutesti: build → mock 18796 → Chromium → chat (virta, katkosta toipuminen, keskustelu-id, stop), infra ja asetukset.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { avaaSelain, AVAIN, kaynnistaMock, WEB } from './apu.ts';

const FIX = join(WEB, '../ydin/tests/fixture');

function varmista(ehto: boolean, viesti: string): void {
  if (!ehto) throw new Error(viesti);
}

const rakennus = spawnSync(process.execPath, [join(WEB, 'build.mjs')], { stdio: 'inherit' });
varmista(rakennus.status === 0, 'build.mjs epäonnistui');

const agentit = JSON.parse(readFileSync(join(FIX, 'agentit.json'), 'utf8')) as { nimi: string }[];
const rekisterit = JSON.parse(readFileSync(join(FIX, 'rekisterit.json'), 'utf8')) as { raja: number | null; tavut: number }[];
const yli = rekisterit.filter((r) => r.raja !== null && r.tavut > r.raja).length;
const testiOtsikko = (readFileSync(join(FIX, 'rekisteri-test.md'), 'utf8').split('\n').find((r) => r.startsWith('## ')) ?? '').slice(3).trim();
varmista(testiOtsikko !== '', 'fixture rekisteri-test.md ilman ## -otsikkoa');

const mock = await kaynnistaMock(18796, join(WEB, 'dist'));
const selain = await avaaSelain();
let rc = 0;
try {
  const { sivu, konsolivirheet } = selain;
  const kaikkiKonsoli: string[] = [];
  sivu.on('console', (m) => { kaikkiKonsoli.push(m.text()); });
  const pyynnot: { url: string; runko: string | null }[] = [];
  sivu.on('request', (p) => { if (p.method() === 'POST') pyynnot.push({ url: new URL(p.url()).pathname, runko: p.postData() }); });

  const kirjatut = async (): Promise<{ chatit: { agentti: string; viesti: string; keskustelu: string }[] }> =>
    (await (await fetch(`${mock.osoite}/__testi/kirjatut`)).json()) as { chatit: { agentti: string; viesti: string; keskustelu: string }[] };
  const t = (id: string) => sivu.locator(`[data-testid="${id}"]`);
  const viimeinenAgentti = () => sivu.locator('[data-testid="chat-viesti"].agentti').last();
  const valmisOdotus = () => sivu.waitForFunction(() => !(document.querySelector('[data-testid="chat-laheta"]') as HTMLButtonElement).disabled, null, { timeout: 15000 });
  const laheta = async (teksti: string): Promise<void> => {
    await t('chat-syote').fill(teksti);
    await t('chat-laheta').click();
  };

  await sivu.goto(`${mock.osoite}/web/#avain=${AVAIN}`);

  // ---- chat ----
  await t('valilehti-chat').click();
  await sivu.waitForFunction((n) => document.querySelectorAll('[data-testid="agentti"] option').length === n, agentit.length, { timeout: 5000 });
  await t('agentti').selectOption('claude-sonnet-5-5');
  varmista(await t('chat-stop').isDisabled(), 'chat-stop käytössä ilman ajoa');

  await laheta('ensimmainen');
  const nahdyt: string[] = [];
  const raja = Date.now() + 8000;
  while (Date.now() < raja) {
    const teksti = (await viimeinenAgentti().textContent()) ?? '';
    if (teksti !== '' && nahdyt[nahdyt.length - 1] !== teksti) nahdyt.push(teksti);
    if (teksti === 'Mock vastaa: ensimmainen') break;
    await sivu.waitForTimeout(30);
  }
  varmista(nahdyt.join('|') === 'Mock |Mock vastaa: |Mock vastaa: ensimmainen', `palat ${JSON.stringify(nahdyt)}`);
  await valmisOdotus();
  varmista((await t('chat-viesti').count()) === 2, 'chat-viesti-määrä 2');
  varmista(((await t('chat-viesti').first().getAttribute('class')) ?? '').split(' ').includes('kayttaja'), 'rooli luokkana (kayttaja)');

  await laheta('toinen');
  await valmisOdotus();
  const chatPost = pyynnot.filter((p) => p.url === '/api/chat/virta').map((p) => JSON.parse(p.runko ?? '{}') as Record<string, string>);
  varmista(chatPost.length === 2, `chat-POSTeja ${chatPost.length}`);
  varmista(chatPost[0] !== undefined && !('keskustelu' in chatPost[0]) && chatPost[0]['agentti'] === 'claude-sonnet-5-5', 'ensimmäinen viesti ilman keskustelua');
  varmista(chatPost[1]?.['keskustelu'] === 'k-1', `toinen viesti ei kantanut keskustelu-id:tä: ${JSON.stringify(chatPost[1])}`);
  let kirjattu = (await kirjatut()).chatit;
  varmista(kirjattu.length === 2 && kirjattu[1]?.keskustelu === 'k-1' && kirjattu[1]?.viesti === 'toinen', `kirjatut ${JSON.stringify(kirjattu)}`);

  // Katko kesken virran: kaynnissa-jatko samaan vastaukseen ilman tuplatekstiä.
  await laheta('kolmas');
  await sivu.waitForFunction(() => (document.querySelector('[data-testid="chat-viesti"].agentti:last-of-type') ?? { textContent: '' }).textContent?.startsWith('Mock'), null, { timeout: 5000 });
  varmista((await (await fetch(`${mock.osoite}/__testi/katko`, { method: 'POST' })).json() as { ok: boolean }).ok, 'katko ei onnistunut');
  await valmisOdotus();
  const lopputeksti = await viimeinenAgentti().textContent();
  varmista(lopputeksti === 'Mock vastaa: kolmas', `katkon jälkeinen teksti ${JSON.stringify(lopputeksti)}`);
  varmista((await t('chat-viesti').count()) === 6, 'chat-viesti-määrä 6 katkon jälkeen');
  varmista(await t('chat-virhe').isHidden(), 'chat-virhe näkyy katkon jälkeen');
  // Selain kirjaa katkaistun virran konsolivirheeksi; se on tässä odotettu.
  for (let i = konsolivirheet.length - 1; i >= 0; i--) if (/net::ERR_INCOMPLETE_CHUNKED_ENCODING|net::ERR_EMPTY_RESPONSE|net::ERR_CONNECTION_RESET/.test(konsolivirheet[i] ?? '')) konsolivirheet.splice(i, 1);

  // Uusi keskustelu tyhjentää keskustelu-id:n.
  await t('chat-uusi').click();
  varmista((await t('chat-viesti').count()) === 0, 'uusi keskustelu ei tyhjentänyt listaa');
  await laheta('neljas');
  await valmisOdotus();
  const neljas = JSON.parse(pyynnot.filter((p) => p.url === '/api/chat/virta').at(-1)?.runko ?? '{}') as Record<string, string>;
  varmista(!('keskustelu' in neljas), 'uusi keskustelu lähetti vanhan keskustelu-id:n');

  // Stop.
  await laheta('viides');
  await sivu.waitForFunction(() => !(document.querySelector('[data-testid="chat-stop"]') as HTMLButtonElement).disabled, null, { timeout: 5000 });
  await t('chat-stop').click();
  await valmisOdotus();
  varmista(pyynnot.some((p) => p.url === '/api/chat/stop'), 'POST /api/chat/stop puuttuu');
  varmista(await t('chat-stop').isDisabled(), 'chat-stop käytössä ajon jälkeen');

  // ---- infra ----
  await t('valilehti-infra').click();
  await sivu.waitForFunction((n) => document.querySelectorAll('[data-testid="rekisterit"] tbody tr').length === n, rekisterit.length, { timeout: 5000 });
  varmista((await sivu.locator('[data-testid="rekisterit"] tbody tr.yli').count()) === yli, `yli-rivejä ei ${yli}`);
  await t('rekisteri-test/REKISTERI.md').click();
  await sivu.waitForFunction(() => !(document.querySelector('[data-testid="rekisteri-osat"]') as HTMLElement).hidden, null, { timeout: 5000 });
  const osatTeksti = (await t('rekisteri-osat').textContent()) ?? '';
  varmista(osatTeksti.includes(testiOtsikko) && osatTeksti.includes('test/REKISTERI.md'), `osat-näkymä ei sisällä otsikkoa ${JSON.stringify(testiOtsikko)}`);
  varmista((await t('rekisteri-osat').locator('pre').count()) > 0, 'osat ilman esimuotoiltua tekstiä');
  await sivu.waitForFunction(() => (document.querySelector('[data-testid="lr-maara"]')?.textContent ?? '') !== '', null, { timeout: 5000 });
  varmista(await t('lr-ristiriidat').isVisible(), 'lr-ristiriidat ei näy');
  varmista((await t('lr-maara').textContent()) === '0 ristiriitaa', `lr-maara ${await t('lr-maara').textContent()}`);
  varmista((await t('lr-lahde').textContent()) === 'lähde: ydin', `lr-lahde ${await t('lr-lahde').textContent()}`);

  // ---- asetukset ----
  await t('valilehti-asetukset').click();
  await sivu.waitForFunction(() => !(document.querySelector('[data-testid="asetus-autopack"]') as HTMLInputElement).disabled, null, { timeout: 5000 });
  await sivu.waitForFunction(() => /^seq \d+, v2 kyllä$/.test(document.querySelector('[data-testid="terveys"]')?.textContent ?? ''), null, { timeout: 5000 });
  const yhteysArvo = (await t('yhteys').textContent()) ?? '';
  varmista(['auki', 'katki', 'avain'].includes(yhteysArvo), `yhteys ${yhteysArvo}`);
  varmista(!(await t('asetus-autopack').isChecked()), 'autopack päällä alussa');
  await t('asetus-autopack').click();
  await sivu.waitForFunction(() => {
    const r = document.querySelector('[data-testid="asetus-autopack"]') as HTMLInputElement;
    return r.checked && !r.disabled;
  }, null, { timeout: 5000 });
  varmista(pyynnot.some((p) => p.url === '/api/asetukset/autopack/paalle'), 'POST /api/asetukset/autopack/paalle puuttuu');
  const palvelimella = (await (await fetch(`${mock.osoite}/api/asetukset`, { headers: { Authorization: `Bearer ${AVAIN}` } })).json()) as { autopack: boolean };
  varmista(palvelimella.autopack === true, 'kytkin ei muuttunut palvelimella');

  // Silta 503 → toiminnon virhe, kytkin palautuu.
  await sivu.route('**/api/asetukset/automaattijatko/*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"virhe":"silta"}' }));
  await t('asetus-automaattijatko').click();
  await sivu.waitForFunction(() => !(document.querySelector('[data-testid="asetus-virhe"]') as HTMLElement).hidden, null, { timeout: 5000 });
  varmista((await t('asetus-virhe').textContent()) === 'vanha palvelu ei vastaa', `asetus-virhe ${await t('asetus-virhe').textContent()}`);
  varmista(!(await t('asetus-automaattijatko').isChecked()), 'kytkin ei palautunut 503:n jälkeen');
  await sivu.unroute('**/api/asetukset/automaattijatko/*');
  // Selain kirjaa 503-vastauksen konsolivirheeksi; se on tässä odotettu.
  for (let i = konsolivirheet.length - 1; i >= 0; i--) if (/status of 503/.test(konsolivirheet[i] ?? '')) konsolivirheet.splice(i, 1);

  // Avaimen poisto → seuraava kutsu näyttää avainnäkymän.
  await t('avain-poista').click();
  await sivu.waitForFunction(() => document.querySelector('[data-testid="yhteys"]')?.textContent === 'avain', null, { timeout: 5000 });
  varmista((await t('avain-tila').textContent()) === 'avainta ei ole', 'avain-tila poiston jälkeen');
  await sivu.waitForFunction(() => /avain/.test(document.querySelector('[data-testid="asetus-virhe"]')?.textContent ?? ''), null, { timeout: 5000 });
  varmista((await sivu.evaluate(() => localStorage.getItem('scopes2.avain'))) === null, 'avain jäi varastoon');

  // Avaimen tallennus: kenttä tyhjenee, virta avautuu, kytkimet latautuvat.
  await t('avain-kentta').fill(AVAIN);
  varmista((await t('avain-kentta').getAttribute('type')) === 'password', 'avainkenttä ei ole password');
  await t('avain-tallenna').click();
  varmista((await t('avain-kentta').inputValue()) === '', 'avainkenttä ei tyhjentynyt');
  await sivu.waitForFunction(() => document.querySelector('[data-testid="yhteys"]')?.textContent === 'auki', null, { timeout: 8000 });
  await sivu.waitForFunction(() => (document.querySelector('[data-testid="asetus-virhe"]') as HTMLElement).hidden, null, { timeout: 5000 });
  varmista((await sivu.evaluate(() => document.body.innerText)).includes(AVAIN) === false, 'avain näkyy sivulla');

  await sivu.waitForTimeout(300);
  varmista(konsolivirheet.length === 0, `konsolivirheitä: ${konsolivirheet.join(' | ')}`);
  varmista(!kaikkiKonsoli.some((r) => r.includes(AVAIN)), 'avain esiintyy konsolilokissa');
  console.log('SAVU-CHAT: ok');
} catch (e) {
  console.error('SAVU-CHAT: FAIL ' + (e instanceof Error ? e.message : String(e)));
  rc = 1;
} finally {
  await selain.sulje();
  await mock.sulje();
}
process.exit(rc);
