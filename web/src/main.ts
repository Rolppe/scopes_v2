import { luoSovellus } from './sovellus.ts';
import { kiinnita as sivupalkki } from './nakymat/sivupalkki.ts';
import { kiinnita as viestit } from './nakymat/viestit.ts';
import { kiinnita as lahetys } from './nakymat/lahetys.ts';
import { kiinnita as chat } from './nakymat/chat.ts';
import { kiinnita as infra } from './nakymat/infra.ts';
import { kiinnita as asetukset } from './nakymat/asetukset.ts';

type Kiinnita = (juuri: HTMLElement, s: ReturnType<typeof luoSovellus>) => () => void;

function elementti(nimi: string, luokka?: string): HTMLElement {
  const e = document.createElement(nimi);
  if (luokka) e.className = luokka;
  return e;
}

const juuri = document.getElementById('juuri');
if (!juuri) throw new Error('#juuri puuttuu');
const s = luoSovellus();

const palkki = elementti('aside', 'sivupalkki');
sivupalkki(palkki, s);
const paa = elementti('main', 'paa');
const valilehdet = elementti('div', 'valilehdet');
valilehdet.setAttribute('role', 'tablist');
paa.append(valilehdet);

// Lähetys-näkymä kuuluu viestit-välilehteen (T-41).
const lehdet: { nimi: string; kiinnitykset: Kiinnita[] }[] = [
  { nimi: 'viestit', kiinnitykset: [viestit, lahetys] },
  { nimi: 'chat', kiinnitykset: [chat] },
  { nimi: 'infra', kiinnitykset: [infra] },
  { nimi: 'asetukset', kiinnitykset: [asetukset] },
];

const napit = new Map<string, HTMLButtonElement>();
const alueet = new Map<string, HTMLElement>();

function nayta(nimi: string): void {
  for (const [n, nappi] of napit) {
    nappi.setAttribute('aria-selected', String(n === nimi));
    const alue = alueet.get(n);
    if (alue) alue.hidden = n !== nimi;
  }
}

for (const l of lehdet) {
  const nappi = document.createElement('button');
  nappi.type = 'button';
  nappi.setAttribute('role', 'tab');
  nappi.setAttribute('data-testid', `valilehti-${l.nimi}`);
  nappi.textContent = l.nimi;
  nappi.addEventListener('click', () => nayta(l.nimi));
  valilehdet.append(nappi);
  napit.set(l.nimi, nappi);

  const alue = elementti('section', 'alue');
  alue.setAttribute('role', 'tabpanel');
  for (const k of l.kiinnitykset) k(alue, s);
  paa.append(alue);
  alueet.set(l.nimi, alue);
}

juuri.append(palkki, paa);
nayta('viestit');
