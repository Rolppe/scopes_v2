// Testiapu: mock-ytimen käynnistys ja Chromium (järjestelmän /usr/bin/chromium, ei Playwrightin omaa latausta).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';

const kansio = dirname(fileURLToPath(import.meta.url));
export const WEB = join(kansio, '..');
export const AVAIN = 'testiavain';

export interface Mock {
  osoite: string;
  sulje(): Promise<void>;
}

export async function kaynnistaMock(portti: number, dist: string = join(WEB, 'dist'), lisa: string[] = []): Promise<Mock> {
  const lapsi = spawn(process.execPath, [join(kansio, 'mock-ydin.mjs'), '--portti', String(portti), '--dist', dist, ...lisa], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const osoite = `http://127.0.0.1:${portti}`;
  let kuollut = false;
  lapsi.once('exit', () => { kuollut = true; });
  for (let i = 0; i < 50; i++) {
    if (kuollut) throw new Error('mock-ydin päättyi ennen valmistumista');
    try {
      if ((await fetch(`${osoite}/api/terveys`)).ok) {
        return {
          osoite,
          sulje: () => new Promise<void>((ok) => {
            if (kuollut) return ok();
            lapsi.once('exit', () => ok());
            lapsi.kill('SIGTERM');
          }),
        };
      }
    } catch { /* ei vielä */ }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  lapsi.kill('SIGKILL');
  throw new Error(`mock-ydin ei vastannut portissa ${portti}`);
}

export interface Selain {
  sivu: Page;
  konsolivirheet: string[];
  sulje(): Promise<void>;
}

export async function avaaSelain(): Promise<Selain> {
  const selain = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const konteksti = await selain.newContext({ viewport: { width: 1280, height: 800 } });
  const sivu = await konteksti.newPage();
  const konsolivirheet: string[] = [];
  sivu.on('console', (m) => { if (m.type() === 'error') konsolivirheet.push(m.text()); });
  sivu.on('pageerror', (e) => { konsolivirheet.push(String(e)); });
  return { sivu, konsolivirheet, sulje: () => selain.close() };
}
