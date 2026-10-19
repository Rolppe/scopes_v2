// Infra-näkymä: kontekstitiedostojen (rekisterit) taulukko, osat esimuotoiltuina ja LR-ristiriidat.
import { AvainPuuttuu } from '../api.ts';
import type { Lahde } from '../api.ts';
import type { Sovellus } from '../sovellus.ts';

interface Rekisteri {
  polku: string;
  laji: string;
  skoopit: string[];
  tavut: number;
  raja: number | null;
  tokenit: number;
}

interface Osa {
  otsikko: string | null;
  teksti: string;
}

function el<K extends keyof HTMLElementTagNameMap>(nimi: K, luokka?: string, testid?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(nimi);
  if (luokka) e.className = luokka;
  if (testid) e.setAttribute('data-testid', testid);
  return e;
}

// "/" säilyy polun erottimena, muut merkit koodataan.
export const rekisteriPolku = (polku: string): string => `/api/rekisterit/${polku.split('/').map(encodeURIComponent).join('/')}`;

function ristiriidanTeksti(r: unknown): string {
  if (typeof r === 'string') return r;
  if (r !== null && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    for (const k of ['kuvaus', 'viesti', 'virhe', 'polku']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return JSON.stringify(r);
}

export function kiinnita(juuri: HTMLElement, s: Sovellus): () => void {
  const kuori = el('div', 'infra');
  const otsikko = el('h2', undefined, 'nakyma-infra');
  otsikko.textContent = 'infra';
  const paivita = el('button', 'infra-paivita', 'infra-paivita');
  paivita.type = 'button';
  paivita.textContent = 'Päivitä';

  const virhe = el('div', 'infra-virhe', 'infra-virhe');
  virhe.hidden = true;

  const rekisteriOtsikko = el('h3');
  rekisteriOtsikko.textContent = 'Rekisterit';
  const taulukko = el('table', 'infra-taulukko', 'rekisterit');
  const kaulus = el('thead');
  const kaulusRivi = el('tr');
  for (const n of ['polku', 'laji', 'skoopit', 'tavut / raja', 'tokenit']) {
    const th = el('th');
    th.textContent = n;
    kaulusRivi.append(th);
  }
  kaulus.append(kaulusRivi);
  const runko = el('tbody');
  taulukko.append(kaulus, runko);
  const osat = el('div', 'infra-osat', 'rekisteri-osat');
  osat.hidden = true;

  const lrOtsikko = el('h3');
  lrOtsikko.textContent = 'LR-ristiriidat';
  const lr = el('div', 'infra-lr', 'lr-ristiriidat');
  const lrMaara = el('p', 'infra-lr-maara', 'lr-maara');
  const lrLista = el('ul');
  const lahde = el('small', 'lahde', 'lr-lahde');
  lr.append(lrMaara, lrLista, lahde);

  kuori.append(otsikko, paivita, virhe, rekisteriOtsikko, taulukko, osat, lrOtsikko, lr);
  juuri.append(kuori);

  let elossa = true;
  let avattu: string | null = null;
  let osaPyynto = 0;

  const nayta = (teksti: string | null): void => {
    virhe.textContent = teksti ?? '';
    virhe.hidden = teksti === null;
  };
  const virheTeksti = (e: unknown): string => {
    if (e instanceof AvainPuuttuu) {
      s.tila.asetaYhteys('avain');
      return 'avain puuttuu tai on väärä';
    }
    return e instanceof Error ? e.message : String(e);
  };
  const lahdeTeksti = (l: Lahde): string => (l === null ? '' : `lähde: ${l}`);

  function piirraRivit(lista: Rekisteri[]): void {
    runko.replaceChildren();
    for (const r of lista) {
      const rivi = el('tr', r.raja !== null && r.tavut > r.raja ? 'yli' : undefined, `rekisteri-${r.polku}`);
      rivi.tabIndex = 0;
      rivi.setAttribute('role', 'button');
      const solut: string[] = [r.polku, r.laji, String(r.skoopit.length), r.raja === null ? String(r.tavut) : `${r.tavut} / ${r.raja}`, String(r.tokenit)];
      solut.forEach((teksti, i) => {
        const td = el('td');
        td.textContent = teksti;
        if (i === 2) td.title = r.skoopit.join(', ');
        rivi.append(td);
      });
      const avaa = (): void => { void naytaOsat(r.polku); };
      rivi.addEventListener('click', avaa);
      rivi.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); avaa(); }
      });
      runko.append(rivi);
    }
  }

  async function naytaOsat(polku: string): Promise<void> {
    const oma = ++osaPyynto;
    avattu = polku;
    nayta(null);
    try {
      const { data } = await s.api.hae<{ polku: string; osat: Osa[] }>(rekisteriPolku(polku));
      if (!elossa || oma !== osaPyynto) return;
      osat.replaceChildren();
      const nimi = el('h4');
      nimi.textContent = data.polku;
      osat.append(nimi);
      for (const o of data.osat) {
        const osa = el('section', 'osa');
        if (o.otsikko !== null) {
          const h = el('h5');
          h.textContent = o.otsikko;
          osa.append(h);
        }
        const pre = el('pre');
        pre.textContent = o.teksti;
        osa.append(pre);
        osat.append(osa);
      }
      osat.hidden = false;
      for (const rivi of runko.children) rivi.classList.toggle('valittu', rivi.getAttribute('data-testid') === `rekisteri-${avattu}`);
    } catch (e) {
      if (elossa && oma === osaPyynto) nayta(virheTeksti(e));
    }
  }

  async function lataaRekisterit(): Promise<void> {
    try {
      const { data } = await s.api.hae<Rekisteri[]>('/api/rekisterit');
      if (elossa) piirraRivit(Array.isArray(data) ? data : []);
    } catch (e) {
      if (elossa) nayta(virheTeksti(e));
    }
  }

  async function lataaLr(): Promise<void> {
    try {
      const { data, lahde: l } = await s.api.hae<unknown>('/api/lr/ristiriidat');
      if (!elossa) return;
      const lista = Array.isArray(data) ? data : data !== null && typeof data === 'object' && Array.isArray((data as { ristiriidat?: unknown }).ristiriidat) ? (data as { ristiriidat: unknown[] }).ristiriidat : [];
      lrMaara.textContent = `${lista.length} ristiriitaa`;
      lrLista.replaceChildren();
      for (const r of lista) {
        const li = el('li');
        li.textContent = ristiriidanTeksti(r);
        lrLista.append(li);
      }
      lahde.textContent = lahdeTeksti(l);
    } catch (e) {
      if (elossa) nayta(virheTeksti(e));
    }
  }

  const lataa = (): void => { void lataaRekisterit(); void lataaLr(); };
  paivita.addEventListener('click', lataa);
  lataa();
  return () => {
    elossa = false;
    kuori.remove();
  };
}
