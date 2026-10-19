// Asetukset-näkymä: avain (arvoa ei näytetä eikä lokiteta), yhteyden tila ja vanhan palvelun kytkimet (S-6 silta).
import { ApiVirhe, AvainPuuttuu } from '../api.ts';
import { AVAIN_KEY, asetaAvain } from '../avain.ts';
import type { Sovellus } from '../sovellus.ts';

type Kytkimet = Record<string, boolean>;

const KYTKIMET: { nimi: string; otsikko: string }[] = [
  { nimi: 'automaattijatko', otsikko: 'Automaattijatko' },
  { nimi: 'autopack', otsikko: 'Autopack' },
];

function el<K extends keyof HTMLElementTagNameMap>(nimi: K, luokka?: string, testid?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(nimi);
  if (luokka) e.className = luokka;
  if (testid) e.setAttribute('data-testid', testid);
  return e;
}

function varasto(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function avainOlemassa(): boolean {
  try { return !!varasto()?.getItem(AVAIN_KEY); } catch { return false; }
}

export function kiinnita(juuri: HTMLElement, s: Sovellus): () => void {
  const kuori = el('div', 'asetukset');
  const otsikko = el('h2', undefined, 'nakyma-asetukset');
  otsikko.textContent = 'asetukset';

  // avain
  const avainOsa = el('section', 'asetukset-osa');
  const avainOtsikko = el('h3');
  avainOtsikko.textContent = 'Avain';
  const avainKentta = el('input', undefined, 'avain-kentta');
  avainKentta.type = 'password';
  avainKentta.autocomplete = 'off';
  avainKentta.setAttribute('aria-label', 'avain');
  const tallenna = el('button', undefined, 'avain-tallenna');
  tallenna.type = 'button';
  tallenna.textContent = 'Tallenna';
  const poista = el('button', undefined, 'avain-poista');
  poista.type = 'button';
  poista.textContent = 'Poista';
  const avainTila = el('p', 'avain-tila', 'avain-tila');
  avainOsa.append(avainOtsikko, avainKentta, tallenna, poista, avainTila);

  // yhteys
  const yhteysOsa = el('section', 'asetukset-osa');
  const yhteysOtsikko = el('h3');
  yhteysOtsikko.textContent = 'Yhteys';
  const yhteys = el('p', 'yhteys', 'yhteys');
  const terveys = el('p', 'terveys', 'terveys');
  yhteysOsa.append(yhteysOtsikko, yhteys, terveys);

  // kytkimet
  const kytkinOsa = el('section', 'asetukset-osa');
  const kytkinOtsikko = el('h3');
  kytkinOtsikko.textContent = 'Kytkimet';
  const kytkinLista = el('div', 'kytkimet');
  const asetusVirhe = el('div', 'asetus-virhe', 'asetus-virhe');
  asetusVirhe.hidden = true;
  const ruudut = new Map<string, HTMLInputElement>();
  for (const k of KYTKIMET) {
    const rivi = el('label', 'kytkin');
    const ruutu = el('input', undefined, `asetus-${k.nimi}`);
    ruutu.type = 'checkbox';
    ruutu.disabled = true;
    const nimi = el('span');
    nimi.textContent = k.otsikko;
    rivi.append(ruutu, nimi);
    kytkinLista.append(rivi);
    ruudut.set(k.nimi, ruutu);
    ruutu.addEventListener('change', () => { void vaihda(k.nimi, ruutu); });
  }
  kytkinOsa.append(kytkinOtsikko, kytkinLista, asetusVirhe);

  kuori.append(otsikko, avainOsa, yhteysOsa, kytkinOsa);
  juuri.append(kuori);

  let elossa = true;

  const piirraYhteys = (): void => { yhteys.textContent = s.tila.tila().yhteys; };
  const piirraAvain = (): void => { avainTila.textContent = avainOlemassa() ? 'avain tallennettu' : 'avainta ei ole'; };
  const naytaVirhe = (teksti: string | null): void => {
    asetusVirhe.textContent = teksti ?? '';
    asetusVirhe.hidden = teksti === null;
  };
  const kytkinVirhe = (e: unknown): string => {
    if (e instanceof AvainPuuttuu) { s.tila.asetaYhteys('avain'); return 'avain puuttuu tai on väärä'; }
    if (e instanceof ApiVirhe && e.tila === 503) return 'vanha palvelu ei vastaa';
    return e instanceof Error ? e.message : String(e);
  };
  const asetaKytkimet = (k: Kytkimet): void => {
    for (const [nimi, ruutu] of ruudut) {
      if (typeof k[nimi] === 'boolean') ruutu.checked = k[nimi] as boolean;
      ruutu.disabled = false;
    }
  };

  async function lataaTerveys(): Promise<void> {
    try {
      const { data } = await s.api.hae<{ seq?: number; v2?: boolean }>('/api/terveys');
      if (elossa) terveys.textContent = `seq ${data.seq ?? '-'}, v2 ${data.v2 ? 'kyllä' : 'ei'}`;
    } catch (e) {
      if (!elossa) return;
      terveys.textContent = e instanceof AvainPuuttuu ? 'avain puuttuu' : 'ei vastaa';
      if (e instanceof AvainPuuttuu) s.tila.asetaYhteys('avain');
    }
  }

  async function lataaKytkimet(): Promise<void> {
    try {
      const { data } = await s.api.hae<Kytkimet>('/api/asetukset');
      if (!elossa) return;
      naytaVirhe(null);
      asetaKytkimet(data);
    } catch (e) {
      if (elossa) naytaVirhe(kytkinVirhe(e));
    }
  }

  async function vaihda(nimi: string, ruutu: HTMLInputElement): Promise<void> {
    const haluttu = ruutu.checked;
    ruutu.disabled = true;
    naytaVirhe(null);
    try {
      const { data } = await s.api.hae<Kytkimet>(`/api/asetukset/${encodeURIComponent(nimi)}/${haluttu ? 'paalle' : 'pois'}`, { metodi: 'POST', runko: {} });
      if (elossa) asetaKytkimet(data);
    } catch (e) {
      if (!elossa) return;
      ruutu.checked = !haluttu;
      ruutu.disabled = false;
      naytaVirhe(kytkinVirhe(e));
    }
  }

  function lataa(): void {
    void lataaTerveys();
    void lataaKytkimet();
  }

  tallenna.addEventListener('click', () => {
    const v = avainKentta.value.trim();
    avainKentta.value = '';
    const va = varasto();
    if (v === '' || va === null) return;
    asetaAvain(va, v);
    piirraAvain();
    s.tila.asetaYhteys('katki');
    s.virta.aloita();
    lataa();
  });
  poista.addEventListener('click', () => {
    const va = varasto();
    if (va !== null) asetaAvain(va, null);
    avainKentta.value = '';
    piirraAvain();
    s.virta.sulje();
    s.tila.asetaYhteys('avain');
    lataa();
  });

  const lopeta = s.tila.tilaa(piirraYhteys);
  piirraYhteys();
  piirraAvain();
  lataa();
  return () => {
    elossa = false;
    lopeta();
    kuori.remove();
  };
}
