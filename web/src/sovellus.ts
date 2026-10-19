// Sovelluksen jaettu tila näkymille: API-asiakas, tilavarasto, S-1-virta, valittu skooppi ja tilavarasto-PUT (S-4).
import { luoApi } from './api.ts';
import type { Api } from './api.ts';
import { AVAIN_KEY, lueAvainFragmentista } from './avain.ts';
import { luoTila } from './tila.ts';
import { luoVirta } from './virta.ts';

export interface Sovellus {
  api: Api;
  tila: ReturnType<typeof luoTila>;
  virta: ReturnType<typeof luoVirta>;
  valittu(): string | null;
  valitse(nimi: string | null): void;
  tilaa(kuuntelija: () => void): () => void;
  tilaAvain(avain: string, arvo: unknown): Promise<void>;
}

export interface SovellusAsetukset {
  avain?: () => string | null;
  fetch?: typeof fetch;
  perus?: string;
}

// Selain: #avain=… luetaan ja poistetaan osoitteesta kerran; avain haetaan sen jälkeen varastosta joka pyynnöllä.
function selaimenAvain(): () => string | null {
  if (typeof location === 'undefined' || typeof localStorage === 'undefined') return () => null;
  lueAvainFragmentista(location, localStorage, history, location.pathname + location.search);
  return () => { try { return localStorage.getItem(AVAIN_KEY) || null; } catch { return null; } };
}

export function luoSovellus(a: SovellusAsetukset = {}): Sovellus {
  let valittu: string | null = null;
  const kuuntelijat = new Set<() => void>();
  const api = luoApi({ avain: a.avain ?? selaimenAvain(), ...(a.fetch ? { fetch: a.fetch } : {}), ...(a.perus !== undefined ? { perus: a.perus } : {}) });
  const tila = luoTila({ api, valittu: () => valittu });
  // Virtaa ei käynnistetä täällä: näkymät kutsuvat virta.aloita(), kun ne tarvitsevat sitä (T-41).
  const virta = luoVirta({
    api,
    muutos: (m) => tila.kasitteleMuutos(m),
    nollaus: () => { void tila.nollaa().catch((e) => console.error('nollaus epäonnistui', e)); },
    tila: (t) => tila.asetaYhteys(t),
  });
  return {
    api,
    tila,
    virta,
    valittu: () => valittu,
    valitse(nimi) {
      if (nimi === valittu) return;
      valittu = nimi;
      for (const k of [...kuuntelijat]) k();
    },
    tilaa(kuuntelija) {
      kuuntelijat.add(kuuntelija);
      return () => { kuuntelijat.delete(kuuntelija); };
    },
    async tilaAvain(avain, arvo) {
      await api.hae(`/api/tila/${avain.split('/').map(encodeURIComponent).join('/')}`, { metodi: 'PUT', runko: { arvo } });
    },
  };
}
