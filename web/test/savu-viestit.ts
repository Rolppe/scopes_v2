// T-41 savutesti: sivupalkki, skoopin viestit, kysymyskortit, luonnos ja lähetys mock-ytimellä (18796) ja Chromiumilla.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { avaaSelain, AVAIN, kaynnistaMock, WEB } from './apu.ts';

const FIX = join(WEB, '../ydin/tests/fixture');
const lueFixture = (nimi: string): any => JSON.parse(readFileSync(join(FIX, nimi), 'utf8'));
const SKOOPPI = 'scopes macos';
const TYHJA = 'test';

interface Kirjatut {
  viestit: { skooppi: string; teksti: string }[];
  tilat: { avain: string; arvo: unknown }[];
}

function varmista(ehto: boolean, viesti: string): void {
  if (!ehto) throw new Error(viesti);
}

const rakennus = spawnSync(process.execPath, [join(WEB, 'build.mjs')], { stdio: 'inherit' });
varmista(rakennus.status === 0, 'build.mjs epäonnistui');

const skoopit: { nimi: string; avoimia: number; seuraava: string | null }[] = lueFixture('skoopit.json');
const fixtureViestit: { rooli: string; vastattu?: boolean }[] = lueFixture(`viestit-${SKOOPPI}.json`).viestit;

const mock = await kaynnistaMock(18796, join(WEB, 'dist'));
const kirjatut = async (): Promise<Kirjatut> => (await fetch(`${mock.osoite}/__testi/kirjatut`)).json() as Promise<Kirjatut>;

async function odota(ehto: () => Promise<boolean>, ms: number, viesti: string): Promise<void> {
  const raja = Date.now() + ms;
  while (Date.now() < raja) {
    if (await ehto()) return;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`aikakatkaisu (${ms} ms): ${viesti}`);
}

const tid = (sivu: Page, id: string) => sivu.locator(`[data-testid="${id}"]`);

async function alhaalla(sivu: Page): Promise<boolean> {
  return sivu.locator('.viestit').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight <= 24);
}

const selain = await avaaSelain();
let rc = 0;
try {
  const { sivu, konsolivirheet } = selain;
  await sivu.goto(`${mock.osoite}/web/#avain=${AVAIN}`);

  // Lista = fixture-nimet samassa järjestyksessä.
  await odota(async () => (await sivu.locator('[data-testid^="skooppi-"]').count()) === skoopit.length, 5000, 'skooppilista ei täyty');
  const nimet = await sivu.locator('[data-testid^="skooppi-"]').evaluateAll((es) => es.map((e) => (e.getAttribute('data-testid') ?? '').slice('skooppi-'.length)));
  varmista(JSON.stringify(nimet) === JSON.stringify(skoopit.map((s) => s.nimi)), 'skooppilistan nimet tai järjestys eroavat fixturesta');
  const avoimia = skoopit.find((s) => s.avoimia > 0);
  varmista(avoimia !== undefined, 'fixturessa ei avoimia');
  if (avoimia) {
    const merkki = tid(sivu, `skooppi-${avoimia.nimi}`).locator('[data-testid="avoimia"]');
    varmista((await merkki.textContent()) === String(avoimia.avoimia), 'avoimia-merkki puuttuu tai on väärä');
    if (avoimia.seuraava) {
      varmista(((await tid(sivu, `skooppi-${avoimia.nimi}`).locator('.skooppi-seuraava').textContent()) ?? '') === avoimia.seuraava, 'seuraava puuttuu');
    }
  }
  varmista((await tid(sivu, `skooppi-${skoopit.find((s) => s.avoimia === 0)?.nimi}`).locator('[data-testid="avoimia"]').count()) === 0, 'avoimia-merkki nollalla');
  varmista((await sivu.locator('[aria-current="true"]').count()) === 0, 'valintaa ei pitäisi olla ennen napautusta');

  // Suodatin: alimerkkijono nimestä.
  await tid(sivu, 'suodatin').fill('SCOPES MAC');
  const odotetut = skoopit.filter((s) => s.nimi.toLowerCase().includes('scopes mac')).map((s) => s.nimi);
  varmista(odotetut.includes(SKOOPPI), 'fixture ei sisällä suodatettavaa nimeä');
  await odota(async () => (await sivu.locator('[data-testid^="skooppi-"]').count()) === odotetut.length, 3000, 'suodatin ei rajaa');
  await tid(sivu, 'suodatin').fill('');
  await odota(async () => (await sivu.locator('[data-testid^="skooppi-"]').count()) === skoopit.length, 3000, 'tyhjä suodatin ei palauta listaa');

  // Valinta → PUT valittu-skooppi ja viestien haku.
  await tid(sivu, `skooppi-${SKOOPPI}`).click();
  varmista((await tid(sivu, `skooppi-${SKOOPPI}`).getAttribute('aria-current')) === 'true', 'valittu rivi ilman aria-current');
  await odota(async () => (await kirjatut()).tilat.some((t) => t.avain === 'valittu-skooppi' && t.arvo === SKOOPPI), 3000, 'PUT valittu-skooppi puuttuu');
  await odota(async () => (await tid(sivu, 'viesti').count()) === fixtureViestit.length, 5000, `viestejä ei ole ${fixtureViestit.length}`);
  const roolit = await tid(sivu, 'viesti').evaluateAll((es) => es.map((e) => e.classList[1] ?? ''));
  varmista(roolit.every((r) => ['kayttaja', 'agentti', 'kysymys', 'tyokalu', 'muu'].includes(r)), `tuntematon rooliluokka: ${roolit.join(',')}`);
  varmista(roolit.filter((r) => r === 'kayttaja').length === fixtureViestit.filter((v) => v.rooli === 'kayttaja').length, 'kayttaja-viestien määrä');
  varmista(/^\d\d\.\d\d$/.test((await tid(sivu, 'viesti').first().locator('time').textContent()) ?? ''), 'aika ei ole hh.mm');
  varmista((await tid(sivu, 'viesti').first().locator('.viesti-teksti').evaluate((e) => getComputedStyle(e).whiteSpace)) === 'pre-wrap', 'teksti ei ole pre-wrap');
  varmista(await alhaalla(sivu), 'viestilista ei ole vieritetty alas');

  // Kysymyskortit: vain vastaamattomat; yksivalinta lähettää nimen.
  const avoimetKortit = fixtureViestit.filter((v) => v.rooli === 'kysymys' && v.vastattu === false).length;
  varmista((await tid(sivu, 'kysymyskortti').count()) === avoimetKortit, `kysymyskortteja ${await tid(sivu, 'kysymyskortti').count()} ≠ ${avoimetKortit}`);
  await tid(sivu, 'kysymyskortti').first().locator('button', { hasText: 'Kyllä' }).click();
  await odota(async () => (await kirjatut()).viestit.some((v) => v.skooppi === SKOOPPI && v.teksti === 'Kyllä'), 3000, 'yksivalinta ei lähettänyt nimeä');

  // Peili: uusi monivalintakysymys ilman sivun latausta; käyttäjä oli alhaalla → vieritys alas.
  varmista(await alhaalla(sivu), 'ei alhaalla ennen peilin viestiä');
  const peiliViesti = await fetch(`${mock.osoite}/__testi/tapahtuma`, {
    method: 'POST',
    body: JSON.stringify({
      polku: 'viestit',
      id: 'koe:1',
      skooppi: SKOOPPI,
      viesti: {
        rooli: 'kysymys',
        teksti: 'Mitkä?\n1. A\n2. B\n3. C',
        aika: new Date().toISOString(),
        vastattu: false,
        kysymykset: [{ kysymys: 'Mitkä?', otsikko: null, monivalinta: true, vaihtoehdot: [{ nimi: 'A', kuvaus: null }, { nimi: 'B', kuvaus: 'bee' }, { nimi: 'C', kuvaus: null }] }],
      },
    }),
  });
  varmista(peiliViesti.ok, 'testitapahtuma epäonnistui');
  await odota(async () => (await tid(sivu, 'viesti').count()) === fixtureViestit.length + 1, 5000, 'peilin viesti ei näy ilman latausta');
  varmista(await alhaalla(sivu), 'uusi viesti ei vierittänyt alas');

  // Monivalinta: valinnat + vahvistus → "A, B" (vaihtoehtojen järjestyksessä).
  const monikortti = tid(sivu, 'kysymyskortti').last();
  await monikortti.locator('button', { hasText: 'B' }).click();
  await monikortti.locator('button', { hasText: /^A/ }).click();
  varmista(((await tid(sivu, 'kortti-vahvista').textContent()) ?? '') === 'Vahvista valinnat (2)', 'vahvistuspainikkeen teksti');
  await tid(sivu, 'kortti-vahvista').click();
  await odota(async () => (await kirjatut()).viestit.some((v) => v.skooppi === SKOOPPI && v.teksti === 'A, B'), 3000, 'monivalinta ei lähettänyt "A, B"');

  // Käyttäjä on vieritetty ylös → uusi viesti ei vie alas.
  await sivu.locator('.viestit').evaluate((e) => { e.scrollTop = 0; });
  varmista(!(await alhaalla(sivu)), 'viestilista ei ole vieritettävissä (testi ei todista mitään)');
  await fetch(`${mock.osoite}/__testi/tapahtuma`, {
    method: 'POST',
    body: JSON.stringify({ polku: 'viestit', id: 'koe:2', skooppi: SKOOPPI, viesti: { rooli: 'agentti', teksti: 'toinen peilin viesti', aika: new Date().toISOString() } }),
  });
  await odota(async () => (await tid(sivu, 'viesti').count()) === fixtureViestit.length + 2, 5000, 'toinen peilin viesti ei näy');
  varmista(((await sivu.locator('.viestit').evaluate((e) => e.scrollTop)) as number) === 0, 'vieritys siirtyi, vaikka käyttäjä oli ylhäällä');

  // Luonnos: syöte → PUT luonnos/<skooppi> viimeistään 1,5 s.
  await tid(sivu, 'lahetys-kentta').fill('luonnos-koe');
  const t0 = Date.now();
  await odota(async () => (await kirjatut()).tilat.some((t) => t.avain === `luonnos/${SKOOPPI}` && t.arvo === 'luonnos-koe'), 1500, 'luonnos-PUT ei tullut 1,5 s:ssa');
  varmista(Date.now() - t0 >= 700, 'luonnos-PUT ilman viivettä');

  // Vaihto skoopille ilman istuntoa: kenttä tyhjä ja disabled, "Ei avointa istuntoa"; takaisin → luonnos GET:llä.
  await tid(sivu, `skooppi-${TYHJA}`).click();
  await odota(async () => await tid(sivu, 'ei-istuntoa').isVisible(), 5000, 'Ei avointa istuntoa -ilmoitus puuttuu');
  varmista((await tid(sivu, 'viesti').count()) === 0, 'tyhjällä skoopilla on viestejä');
  varmista(await tid(sivu, 'lahetys-kentta').isDisabled(), 'kenttä ei ole disabled, kun voiLahettaa on false');
  varmista((await tid(sivu, 'lahetys-kentta').inputValue()) === '', 'kenttä ei tyhjentynyt skoopin vaihdossa');
  await tid(sivu, `skooppi-${SKOOPPI}`).click();
  await odota(async () => (await tid(sivu, 'lahetys-kentta').inputValue()) === 'luonnos-koe', 3000, 'luonnos ei palautunut kenttään');
  varmista(!(await tid(sivu, 'ei-istuntoa').isVisible()), 'Ei avointa istuntoa näkyy auki olevalla skoopilla');

  // Lähetys: Shift+Enter rivinvaihto, Enter lähettää; kenttä tyhjenee ja luonnos poistuu.
  await tid(sivu, 'lahetys-kentta').fill('rivi1');
  await sivu.keyboard.press('Shift+Enter');
  await sivu.keyboard.type('rivi2');
  varmista((await tid(sivu, 'lahetys-kentta').inputValue()) === 'rivi1\nrivi2', 'Shift+Enter ei tehnyt rivinvaihtoa');
  const ennen = (await kirjatut()).viestit.length;
  await sivu.keyboard.press('Enter');
  await odota(async () => (await kirjatut()).viestit.some((v) => v.skooppi === SKOOPPI && v.teksti === 'rivi1\nrivi2'), 3000, 'Enter ei lähettänyt viestiä');
  await odota(async () => (await tid(sivu, 'lahetys-kentta').inputValue()) === '', 3000, 'kenttä ei tyhjentynyt lähetyksen jälkeen');
  await odota(async () => {
    const tilat = (await kirjatut()).tilat.filter((t) => t.avain === `luonnos/${SKOOPPI}`);
    return tilat.length > 0 && tilat[tilat.length - 1]?.arvo === null;
  }, 3000, 'luonnosta ei poistettu lähetyksen jälkeen');

  // Tyhjä ei lähde (Enter ja painike).
  const lahetetty = (await kirjatut()).viestit.length;
  varmista(lahetetty === ennen + 1, 'viestejä kirjattu odotettua enemmän');
  await tid(sivu, 'lahetys-kentta').fill('   ');
  await tid(sivu, 'lahetys-kentta').press('Enter');
  await tid(sivu, 'laheta').click();
  await sivu.waitForTimeout(300);
  varmista((await kirjatut()).viestit.length === lahetetty, 'tyhjä viesti lähti');
  await tid(sivu, 'lahetys-kentta').fill('');

  // Painike lähettää myös.
  await tid(sivu, 'lahetys-kentta').fill('painikkeella');
  await tid(sivu, 'laheta').click();
  await odota(async () => (await kirjatut()).viestit.some((v) => v.teksti === 'painikkeella'), 3000, 'painike ei lähettänyt');
  // Mock kirjaa ennen vastausta: kenttä tyhjenee vasta vastauksen jälkeen, ja sitä ennen lähetys on kesken eikä Enter lähetä.
  await odota(async () => (await tid(sivu, 'lahetys-kentta').inputValue()) === '', 3000, 'kenttä ei tyhjentynyt painikelähetyksen jälkeen');

  // Tuntematon skooppi → lahetys-virhe, teksti säilyy. Selaimen 404-konsolirivi on odotettu.
  await sivu.route(`**/api/skoopit/${encodeURIComponent(SKOOPPI)}/viesti`, (r) => {
    void r.continue({ url: r.request().url().replace(encodeURIComponent(SKOOPPI), encodeURIComponent('tuntematon skooppi')) });
  });
  const virheitaEnnen = konsolivirheet.length;
  await tid(sivu, 'lahetys-kentta').fill('ei mene perille');
  await tid(sivu, 'lahetys-kentta').press('Enter');
  await odota(async () => await tid(sivu, 'lahetys-virhe').isVisible(), 3000, 'lahetys-virhe ei näy tuntemattomalla skoopilla');
  varmista(((await tid(sivu, 'lahetys-virhe').textContent()) ?? '').includes('tuntematon'), 'virheteksti ei kerro syytä');
  varmista((await tid(sivu, 'lahetys-kentta').inputValue()) === 'ei mene perille', 'teksti ei säilynyt virheessä');
  const odotetut404 = konsolivirheet.splice(virheitaEnnen).filter((v) => !/status of 404/.test(v));
  varmista(odotetut404.length === 0, `odottamattomia konsolivirheitä virhepolulla: ${odotetut404.join(' | ')}`);
  await sivu.unroute(`**/api/skoopit/${encodeURIComponent(SKOOPPI)}/viesti`);

  await sivu.waitForTimeout(300);
  varmista(konsolivirheet.length === 0, `konsolivirheitä: ${konsolivirheet.join(' | ')}`);
  console.log('SAVU-VIESTIT: ok');
} catch (e) {
  console.error('SAVU-VIESTIT: FAIL ' + (e instanceof Error ? e.message : String(e)));
  rc = 1;
} finally {
  await selain.sulje();
  await mock.sulje();
}
process.exit(rc);
