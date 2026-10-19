// S-1-virta fetch-virtana (P-12: EventSource ei lähetä otsakkeita): jäsennin ja uudelleenyhdistävä asiakas.
import { AvainPuuttuu } from './api.ts';
import type { Api } from './api.ts';

export interface Muutos {
  seq: number;
  polku: string;
  id: string;
  versio: Record<string, number>;
  aika: string;
}

export interface SseKehys {
  id?: string;
  event: string;
  data: string;
}

// Kehykset päättyvät tyhjään riviin; ":"-alkuiset kommenttirivit (": ka") ohitetaan; \r\n sallitaan.
export function jasennaSse(): { syota(pala: string): SseKehys[] } {
  let puskuri = '';
  return {
    syota(pala) {
      puskuri += pala;
      // Pätkän lopussa oleva \r voi olla \r\n:n alku: odota seuraavaa pätkää.
      const loppuCr = puskuri.endsWith('\r');
      const kasiteltava = (loppuCr ? puskuri.slice(0, -1) : puskuri).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      puskuri = kasiteltava + (loppuCr ? '\r' : '');
      const ulos: SseKehys[] = [];
      let i: number;
      while ((i = puskuri.indexOf('\n\n')) >= 0) {
        const lohko = puskuri.slice(0, i);
        puskuri = puskuri.slice(i + 2);
        let id: string | undefined;
        let event = 'message';
        const data: string[] = [];
        let sisaltoa = false;
        for (const rivi of lohko.split('\n')) {
          if (rivi === '' || rivi.startsWith(':')) continue;
          sisaltoa = true;
          const kaksoispiste = rivi.indexOf(':');
          const kentta = kaksoispiste < 0 ? rivi : rivi.slice(0, kaksoispiste);
          let arvo = kaksoispiste < 0 ? '' : rivi.slice(kaksoispiste + 1);
          if (arvo.startsWith(' ')) arvo = arvo.slice(1);
          if (kentta === 'id') id = arvo;
          else if (kentta === 'event') event = arvo;
          else if (kentta === 'data') data.push(arvo);
        }
        if (sisaltoa) ulos.push(id === undefined ? { event, data: data.join('\n') } : { id, event, data: data.join('\n') });
      }
      return ulos;
    },
  };
}

export interface VirtaAsetukset {
  api: Api;
  muutos: (m: Muutos) => void;
  nollaus: (seq: number) => void;
  tila?: (t: 'auki' | 'katki') => void;
  viive?: (yritys: number) => number;
  ajastin?: (f: () => void, ms: number) => unknown;
}

const oletusViive = (yritys: number): number => Math.min(30000, 1000 * 2 ** (yritys - 1));

export function luoVirta(o: VirtaAsetukset): { aloita(since?: number): void; sulje(): void; seq(): number } {
  const viive = o.viive ?? oletusViive;
  const ajastin = o.ajastin ?? ((f, ms) => setTimeout(f, ms));
  let viimeinen: number | null = null;
  let kaynnissa = false;
  let ac: AbortController | null = null;
  let herata: (() => void) | null = null;
  let sukupolvi = 0; // sulje() ja uusi aloita() eivät saa elvyttää vanhaa silmukkaa

  function kasittele(k: SseKehys): void {
    try {
      if (k.event === 'muutos') {
        const m = JSON.parse(k.data) as Muutos;
        viimeinen = k.id !== undefined && /^\d+$/.test(k.id) ? Number(k.id) : m.seq;
        o.muutos(m);
      } else if (k.event === 'nollaus') {
        const seq = (JSON.parse(k.data) as { seq: number }).seq;
        viimeinen = seq;
        o.nollaus(seq);
      }
    } catch (e) {
      console.error('virta: kehyksen käsittely epäonnistui', e);
    }
  }

  async function silmukka(oma: number): Promise<void> {
    const voimassa = (): boolean => kaynnissa && oma === sukupolvi;
    let yritys = 0;
    while (voimassa()) {
      ac = new AbortController();
      try {
        const otsakkeet: Record<string, string> = { Accept: 'text/event-stream' };
        if (viimeinen !== null) otsakkeet['Last-Event-ID'] = String(viimeinen);
        const virta = await o.api.virta('/api/virta', { otsakkeet, signaali: ac.signal });
        o.tila?.('auki');
        const lukija = virta.getReader();
        const dekoodi = new TextDecoder();
        const jasennin = jasennaSse();
        try {
          while (voimassa()) {
            const { value, done } = await lukija.read();
            if (done) break;
            for (const k of jasennin.syota(dekoodi.decode(value, { stream: true }))) {
              yritys = 0;
              kasittele(k);
            }
          }
        } finally {
          await lukija.cancel().catch(() => undefined);
        }
      } catch (e) {
        if (!voimassa()) return;
        if (e instanceof AvainPuuttuu) {
          kaynnissa = false;
          o.tila?.('katki');
          return;
        }
      }
      if (!voimassa()) return;
      o.tila?.('katki');
      yritys += 1;
      await new Promise<void>((ok) => {
        herata = ok;
        ajastin(ok, viive(yritys));
      });
      herata = null;
    }
  }

  return {
    aloita(since) {
      if (kaynnissa) return;
      kaynnissa = true;
      viimeinen = since ?? null;
      void silmukka(++sukupolvi);
    },
    sulje() {
      kaynnissa = false;
      sukupolvi += 1;
      ac?.abort();
      herata?.();
    },
    seq: () => viimeinen ?? 0,
  };
}
