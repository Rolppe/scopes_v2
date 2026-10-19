import type { Sovellus } from '../sovellus.ts';

export function kiinnita(juuri: HTMLElement, _s: Sovellus): () => void {
  const otsikko = document.createElement('h2');
  otsikko.setAttribute('data-testid', 'nakyma-asetukset');
  otsikko.textContent = 'asetukset';
  juuri.append(otsikko);
  return () => { otsikko.remove(); };
}
