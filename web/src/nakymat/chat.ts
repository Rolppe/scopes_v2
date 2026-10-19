// Chat-näkymä: agenttivalinta, NDJSON-vastaus palana kerrallaan ja katkosta toipuminen (GET /api/chat/kaynnissa).
import { ApiVirhe, AvainPuuttuu } from '../api.ts';
import { lueNdjson } from '../ndjson.ts';
import type { Sovellus } from '../sovellus.ts';

interface Agentti {
  nimi: string;
  kuvaus?: string;
}

type Loppu = 'valmis' | 'virhe' | 'katkesi';

const TOIPUMISYRITYKSIA = 6;
const TOIPUMISVIIVE_MS = 300;

function el<K extends keyof HTMLElementTagNameMap>(nimi: K, luokka?: string, testid?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(nimi);
  if (luokka) e.className = luokka;
  if (testid) e.setAttribute('data-testid', testid);
  return e;
}

const odota = (ms: number): Promise<void> => new Promise((ok) => { setTimeout(ok, ms); });

export function kiinnita(juuri: HTMLElement, s: Sovellus): () => void {
  const kuori = el('div', 'chat');
  const otsikko = el('h2', undefined, 'nakyma-chat');
  otsikko.textContent = 'chat';

  const palkki = el('div', 'chat-palkki');
  const valinta = el('select', undefined, 'agentti');
  valinta.setAttribute('aria-label', 'agentti');
  const uusi = el('button', undefined, 'chat-uusi');
  uusi.type = 'button';
  uusi.textContent = 'Uusi keskustelu';
  const stop = el('button', undefined, 'chat-stop');
  stop.type = 'button';
  stop.textContent = 'Pysäytä';
  stop.disabled = true;
  palkki.append(valinta, uusi, stop);

  const lista = el('div', 'chat-lista', 'chat-lista');
  const virhe = el('div', 'chat-virhe', 'chat-virhe');
  virhe.hidden = true;

  const lomake = el('div', 'chat-lomake');
  const syote = el('textarea', undefined, 'chat-syote');
  syote.rows = 2;
  syote.setAttribute('aria-label', 'viesti');
  const laheta = el('button', undefined, 'chat-laheta');
  laheta.type = 'button';
  laheta.textContent = 'Lähetä';
  lomake.append(syote, laheta);

  kuori.append(otsikko, palkki, lista, virhe, lomake);
  juuri.append(kuori);

  let keskustelu: string | null = null;
  let ajaa = false;
  let elossa = true;

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
  const paivitaTila = (): void => {
    stop.disabled = !ajaa;
    laheta.disabled = ajaa;
    uusi.disabled = ajaa;
    valinta.disabled = ajaa;
  };
  const vieritaLoppuun = (): void => { lista.scrollTop = lista.scrollHeight; };

  function viesti(rooli: 'kayttaja' | 'agentti', teksti: string): HTMLElement {
    const v = el('div', `chat-viesti ${rooli}`, 'chat-viesti');
    v.textContent = teksti;
    lista.append(v);
    vieritaLoppuun();
    return v;
  }

  async function lataaAgentit(): Promise<void> {
    try {
      const { data } = await s.api.hae<Agentti[]>('/api/agentit');
      if (!elossa) return;
      const agentit = Array.isArray(data) ? data : [];
      valinta.replaceChildren();
      for (const a of agentit) {
        const o = el('option');
        o.value = a.nimi;
        o.textContent = a.kuvaus ?? a.nimi;
        valinta.append(o);
      }
    } catch (e) {
      if (elossa) nayta(virheTeksti(e));
    }
  }

  // Lukee yhden NDJSON-virran loppuun. korvaaEnsimmainen: kaynnissa-virran ensimmäinen pala on koko tähän asti kirjoitettu teksti.
  async function lue(virta: ReadableStream<Uint8Array>, kupla: HTMLElement, teksti: { arvo: string }, korvaaEnsimmainen: boolean): Promise<Loppu> {
    let ensimmainen = korvaaEnsimmainen;
    try {
      for await (const t of lueNdjson(virta)) {
        if (t.tyyppi === 'pala') {
          teksti.arvo = ensimmainen ? t.teksti : teksti.arvo + t.teksti;
          ensimmainen = false;
          kupla.textContent = teksti.arvo;
          vieritaLoppuun();
        } else if (t.tyyppi === 'valmis') {
          if (t.vastaus) { teksti.arvo = t.vastaus; kupla.textContent = t.vastaus; }
          if (t.keskustelu) keskustelu = t.keskustelu;
          return 'valmis';
        } else {
          nayta(t.virhe);
          return 'virhe';
        }
      }
    } catch {
      return 'katkesi';
    }
    return 'katkesi';
  }

  async function toivu(kupla: HTMLElement, teksti: { arvo: string }): Promise<Loppu> {
    for (let yritys = 0; yritys < TOIPUMISYRITYKSIA && elossa; yritys++) {
      await odota(TOIPUMISVIIVE_MS);
      try {
        const virta = await s.api.virta('/api/chat/kaynnissa', {});
        const tulos = await lue(virta, kupla, teksti, true);
        if (tulos !== 'katkesi') return tulos;
      } catch (e) {
        if (e instanceof ApiVirhe && e.tila === 404) { nayta('yhteys katkesi eikä vastausta löydy'); return 'virhe'; }
        if (e instanceof AvainPuuttuu) { nayta(virheTeksti(e)); return 'virhe'; }
      }
    }
    nayta('yhteys katkesi');
    return 'virhe';
  }

  async function lahetaViesti(): Promise<void> {
    const teksti = syote.value.trim();
    const agentti = valinta.value;
    if (ajaa || teksti === '') return;
    if (agentti === '') { nayta('valitse agentti'); return; }
    nayta(null);
    syote.value = '';
    ajaa = true;
    paivitaTila();
    viesti('kayttaja', teksti);
    const kupla = viesti('agentti', '');
    const vastaus = { arvo: '' };
    try {
      const runko: Record<string, string> = { agentti, viesti: teksti };
      if (keskustelu !== null) runko['keskustelu'] = keskustelu;
      const virta = await s.api.virta('/api/chat/virta', { runko });
      let tulos = await lue(virta, kupla, vastaus, false);
      if (tulos === 'katkesi') tulos = await toivu(kupla, vastaus);
      if (tulos === 'virhe' && vastaus.arvo === '') kupla.remove();
    } catch (e) {
      kupla.remove();
      nayta(virheTeksti(e));
    } finally {
      ajaa = false;
      if (elossa) paivitaTila();
    }
  }

  laheta.addEventListener('click', () => { void lahetaViesti(); });
  syote.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void lahetaViesti(); }
  });
  stop.addEventListener('click', () => {
    s.api.hae('/api/chat/stop', { metodi: 'POST', runko: {} }).catch((e: unknown) => nayta(virheTeksti(e)));
  });
  uusi.addEventListener('click', () => {
    keskustelu = null;
    lista.replaceChildren();
    nayta(null);
  });

  void lataaAgentit();
  return () => {
    elossa = false;
    kuori.remove();
  };
}
