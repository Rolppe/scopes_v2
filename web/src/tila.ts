// Tilavarasto: S-6:n since-vastaukset yhdistetään listoiksi; S-1:n muutokset käynnistävät päivityksen.
import { AvainPuuttuu, skooppiPolku } from './api.ts';
import type { Api } from './api.ts';
import type { Muutos } from './virta.ts';

export interface SinceVastaus<T> {
  seq: number;
  muuttuneet: T[];
  poistetut: string[];
  nollaus?: boolean;
}

export interface SkooppiYhteenveto {
  nimi: string;
  seuraava: string | null;
  avoimia: number;
  vikoja: number;
  istuntoja: number;
  suurinKonteksti: number | null;
  aika: string | null;
  tila: string;
}

export interface Viesti {
  id: string;
  rooli: string;
  teksti: string;
  aika?: string;
}

export interface ViestiTila {
  seq: number;
  lista: Viesti[];
  auki: boolean;
  voiLahettaa: boolean;
}

export interface Tila {
  skoopit: SkooppiYhteenveto[];
  viestit: Map<string, ViestiTila>;
  seq: number;
  yhteys: 'auki' | 'katki' | 'avain';
}

// nollaus → v.muuttuneet; muuten korvaa id:n mukaan paikallaan, uudet loppuun, poistetut pois.
export function yhdista<T>(nyt: T[], v: SinceVastaus<T>, tunniste: (x: T) => string): T[] {
  if (v.nollaus) return [...v.muuttuneet];
  const poistetut = new Set(v.poistetut);
  const uudet = new Map(v.muuttuneet.map((x) => [tunniste(x), x]));
  const ulos: T[] = [];
  for (const x of nyt) {
    const id = tunniste(x);
    if (poistetut.has(id)) continue;
    const korvaava = uudet.get(id);
    if (korvaava !== undefined) { ulos.push(korvaava); uudet.delete(id); } else ulos.push(x);
  }
  for (const [id, x] of uudet) if (!poistetut.has(id)) ulos.push(x);
  return ulos;
}

export interface TilaAsetukset {
  api: Api;
  valittu?: () => string | null;
  ajastin?: (f: () => void, ms: number) => unknown;
}

export interface TilaVarasto {
  tila(): Tila;
  tilaa(f: () => void): () => void;
  paivitaSkoopit(): Promise<void>;
  paivitaViestit(nimi: string): Promise<void>;
  kasitteleMuutos(m: Muutos): void;
  nollaa(): Promise<void>;
  asetaYhteys(y: Tila['yhteys']): void;
}

const YHDISTA_MS = 200;
const SKOOPPI_POLUT = new Set(['skoopit', 'lahde', 'rekisterit']);
const VIESTI_POLUT = new Set(['peili', 'viestit']);

interface ViestitVastaus {
  nimi?: string;
  auki?: boolean;
  voiLahettaa?: boolean;
  viestit?: Partial<Viesti>[];
}

const viestinTunniste = (v: Viesti): string => v.id;
const nimeaIdt = (lista: Partial<Viesti>[]): Viesti[] =>
  lista.map((v, i) => ({ rooli: '', teksti: '', ...v, id: v.id ?? String(i) }));

export function luoTila(o: TilaAsetukset): TilaVarasto {
  const ajastin = o.ajastin ?? ((f, ms) => setTimeout(f, ms));
  const t: Tila = { skoopit: [], viestit: new Map(), seq: 0, yhteys: 'katki' };
  const kuuntelijat = new Set<() => void>();
  let skooppiAlustettu = false;
  let ketju: Promise<unknown> = Promise.resolve();
  let odottaa: { skoopit: boolean; viestit: boolean } | null = null;

  const ilmoita = (): void => { for (const k of [...kuuntelijat]) k(); };
  // Haut ajetaan peräkkäin: since-ketju nojaa edelliseen seq:hen.
  const jonoon = <R>(f: () => Promise<R>): Promise<R> => {
    const tulos = ketju.then(f, f);
    ketju = tulos.catch(() => undefined);
    return tulos;
  };
  const avainVirhe = (e: unknown): never => {
    if (e instanceof AvainPuuttuu) { t.yhteys = 'avain'; ilmoita(); }
    throw e;
  };

  // Perus-seq ennen ensimmäistä hakua: muutokset sen jälkeen tulevat since-hauista (päällekkäisyys on idempotenttia).
  async function perusSeq(): Promise<number> {
    try {
      return (await o.api.hae<{ seq?: number }>('/api/terveys')).data.seq ?? 0;
    } catch (e) {
      if (e instanceof AvainPuuttuu) throw e;
      return 0;
    }
  }

  function paivitaSkoopit(): Promise<void> {
    return jonoon(async () => {
      try {
        if (!skooppiAlustettu) {
          const seq = await perusSeq();
          const { data } = await o.api.hae<SkooppiYhteenveto[]>('/api/skoopit');
          t.skoopit = data;
          t.seq = seq;
          skooppiAlustettu = true;
        } else {
          const { data } = await o.api.hae<SinceVastaus<SkooppiYhteenveto> | SkooppiYhteenveto[]>(`/api/skoopit?since=${t.seq}`);
          if (Array.isArray(data)) t.skoopit = data;
          else {
            t.skoopit = yhdista(t.skoopit, data, (s) => s.nimi);
            t.seq = data.seq;
          }
        }
      } catch (e) { return avainVirhe(e); }
      ilmoita();
    });
  }

  function paivitaViestit(nimi: string): Promise<void> {
    return jonoon(async () => {
      const polku = skooppiPolku(nimi, 'viestit');
      try {
        const nyt = t.viestit.get(nimi);
        if (!nyt) {
          const seq = await perusSeq();
          const { data } = await o.api.hae<ViestitVastaus>(polku);
          t.viestit.set(nimi, { seq, lista: nimeaIdt(data.viestit ?? []), auki: data.auki ?? false, voiLahettaa: data.voiLahettaa ?? false });
        } else {
          const { data } = await o.api.hae<SinceVastaus<Partial<Viesti>> | ViestitVastaus>(`${polku}?since=${nyt.seq}`);
          if ('muuttuneet' in data) {
            nyt.lista = yhdista(nyt.lista, { ...data, muuttuneet: nimeaIdt(data.muuttuneet) }, viestinTunniste);
            nyt.seq = data.seq;
          } else {
            nyt.lista = nimeaIdt(data.viestit ?? []);
            nyt.auki = data.auki ?? nyt.auki;
            nyt.voiLahettaa = data.voiLahettaa ?? nyt.voiLahettaa;
          }
        }
      } catch (e) { return avainVirhe(e); }
      ilmoita();
    });
  }

  // Muutokset kerätään 200 ms:n ajan yhdeksi hauksi.
  function kasitteleMuutos(m: Muutos): void {
    const skoopit = SKOOPPI_POLUT.has(m.polku);
    const viestit = VIESTI_POLUT.has(m.polku);
    if (!skoopit && !viestit) return;
    if (odottaa) {
      odottaa.skoopit ||= skoopit;
      odottaa.viestit ||= viestit;
      return;
    }
    odottaa = { skoopit, viestit };
    ajastin(() => {
      const mita = odottaa;
      odottaa = null;
      if (!mita) return;
      const valittu = o.valittu?.() ?? null;
      const haut: Promise<void>[] = [];
      if (mita.skoopit) haut.push(paivitaSkoopit());
      if (mita.viestit && valittu !== null) haut.push(paivitaViestit(valittu));
      for (const h of haut) h.catch((e) => { if (!(e instanceof AvainPuuttuu)) console.error('tila: päivitys epäonnistui', e); });
    }, YHDISTA_MS);
  }

  async function nollaa(): Promise<void> {
    skooppiAlustettu = false;
    const nimet = [...t.viestit.keys()];
    t.viestit.clear();
    await paivitaSkoopit();
    for (const nimi of nimet) await paivitaViestit(nimi);
  }

  return {
    tila: () => t,
    tilaa(f) {
      kuuntelijat.add(f);
      return () => { kuuntelijat.delete(f); };
    },
    paivitaSkoopit,
    paivitaViestit,
    kasitteleMuutos,
    nollaa,
    asetaYhteys(y) {
      if (t.yhteys === y) return;
      t.yhteys = y;
      ilmoita();
    },
  };
}
