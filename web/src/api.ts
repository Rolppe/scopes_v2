// API-asiakas: Bearer-avain joka pyynnössä, runko JSONina, virheet tyypitettyinä (S-6, S-7).
export type Lahde = 'ydin' | 'silta' | null;

export class ApiVirhe extends Error {
  tila: number;
  runko: unknown;
  lahde: Lahde;
  constructor(tila: number, runko: unknown, lahde: Lahde) {
    const virhe = runko !== null && typeof runko === 'object' && 'virhe' in runko ? String((runko as { virhe: unknown }).virhe) : '';
    super(`API ${tila}${virhe ? `: ${virhe}` : ''}`);
    this.name = 'ApiVirhe';
    this.tila = tila;
    this.runko = runko;
    this.lahde = lahde;
  }
}

// 401 tai avainta ei ole: asiakas näyttää avainnäkymän.
export class AvainPuuttuu extends Error {
  constructor(viesti = 'avain puuttuu tai on väärä') {
    super(viesti);
    this.name = 'AvainPuuttuu';
  }
}

export interface HaeAsetukset {
  metodi?: string;
  runko?: unknown;
  signaali?: AbortSignal;
}

export interface VirtaAsetukset extends HaeAsetukset {
  otsakkeet?: Record<string, string>;
}

export interface Api {
  hae<T>(polku: string, init?: HaeAsetukset): Promise<{ data: T; lahde: Lahde }>;
  virta(polku: string, init: VirtaAsetukset): Promise<ReadableStream<Uint8Array>>;
}

export interface ApiAsetukset {
  avain: () => string | null;
  fetch?: typeof fetch;
  perus?: string;
}

// Skoopin nimessä on välilyöntejä ("scopes macos"): jokainen polun osa koodataan.
export function skooppiPolku(nimi: string, ...loput: string[]): string {
  return ['/api/skoopit', nimi, ...loput].map((o, i) => (i === 0 ? o : encodeURIComponent(o))).join('/');
}

function lahdeOtsakkeesta(v: Response): Lahde {
  const l = v.headers.get('x-lahde');
  return l === 'ydin' || l === 'silta' ? l : null;
}

async function rungonJson(v: Response): Promise<unknown> {
  const teksti = await v.text();
  if (teksti === '') return undefined;
  try { return JSON.parse(teksti); } catch { return teksti; }
}

export function luoApi(o: ApiAsetukset): Api {
  const perus = o.perus ?? '';

  async function laheta(polku: string, init: VirtaAsetukset, accept?: string): Promise<Response> {
    const avain = o.avain();
    if (!avain) throw new AvainPuuttuu();
    const otsakkeet: Record<string, string> = { ...(init.otsakkeet ?? {}), Authorization: `Bearer ${avain}` };
    if (accept) otsakkeet['Accept'] ??= accept;
    const pyynto: RequestInit = { method: init.metodi ?? (init.runko !== undefined ? 'POST' : 'GET'), headers: otsakkeet };
    if (init.runko !== undefined) {
      otsakkeet['Content-Type'] = 'application/json';
      pyynto.body = JSON.stringify(init.runko);
    }
    if (init.signaali) pyynto.signal = init.signaali;
    const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    const vastaus = await f(perus + polku, pyynto);
    if (vastaus.status === 401) {
      await vastaus.body?.cancel().catch(() => undefined);
      throw new AvainPuuttuu();
    }
    if (vastaus.status >= 400) throw new ApiVirhe(vastaus.status, await rungonJson(vastaus), lahdeOtsakkeesta(vastaus));
    return vastaus;
  }

  return {
    async hae<T>(polku: string, init: HaeAsetukset = {}) {
      const vastaus = await laheta(polku, init);
      return { data: (await rungonJson(vastaus)) as T, lahde: lahdeOtsakkeesta(vastaus) };
    },
    async virta(polku, init) {
      const vastaus = await laheta(polku, init);
      if (!vastaus.body) throw new ApiVirhe(vastaus.status, 'ei runkoa', lahdeOtsakkeesta(vastaus));
      return vastaus.body;
    },
  };
}
