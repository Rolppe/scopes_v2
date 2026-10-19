// Sivupalkki: skooppilista virrasta päivittyvänä, nimisuodatin ja valinta tilavarastoon (S-4 `valittu-skooppi`).
import { AvainPuuttuu } from '../api.ts';
import type { Sovellus } from '../sovellus.ts';
import type { SkooppiYhteenveto } from '../tila.ts';

const VALINTA_AVAIN = 'valittu-skooppi';

function elementti<K extends keyof HTMLElementTagNameMap>(nimi: K, luokka?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(nimi);
  if (luokka) e.className = luokka;
  return e;
}

// Avain puuttuu -tilan näyttää sivupalkin tilarivi; muut virheet kirjataan konsoliin.
function kirjaa(selite: string): (e: unknown) => void {
  return (e) => { if (!(e instanceof AvainPuuttuu)) console.error(selite, e); };
}

export function kiinnita(juuri: HTMLElement, s: Sovellus): () => void {
  const kuori = elementti('div', 'sivupalkki-sisalto');
  kuori.setAttribute('data-testid', 'nakyma-sivupalkki');

  const suodatin = elementti('input', 'sivupalkki-suodatin');
  suodatin.type = 'search';
  suodatin.placeholder = 'Suodata skoopit';
  suodatin.setAttribute('aria-label', 'Suodata skoopit');
  suodatin.setAttribute('data-testid', 'suodatin');
  suodatin.autocomplete = 'off';

  const yhteys = elementti('p', 'sivupalkki-yhteys');
  yhteys.setAttribute('data-testid', 'sivupalkki-yhteys');
  yhteys.hidden = true;

  const lista = elementti('div', 'sivupalkki-lista');

  kuori.append(suodatin, yhteys, lista);
  juuri.append(kuori);

  function rivi(k: SkooppiYhteenveto, valittu: string | null): HTMLButtonElement {
    const nappi = elementti('button', 'skooppi-rivi');
    nappi.type = 'button';
    nappi.setAttribute('data-testid', `skooppi-${k.nimi}`);
    if (k.nimi === valittu) nappi.setAttribute('aria-current', 'true');

    const ylempi = elementti('span', 'skooppi-ylempi');
    const nimi = elementti('span', 'skooppi-nimi');
    nimi.textContent = k.nimi;
    ylempi.append(nimi);
    if (k.avoimia > 0) {
      const merkki = elementti('span', 'skooppi-merkki');
      merkki.setAttribute('data-testid', 'avoimia');
      merkki.setAttribute('aria-label', `${k.avoimia} avointa`);
      merkki.textContent = String(k.avoimia);
      ylempi.append(merkki);
    }
    const tila = elementti('span', `skooppi-tila tila-${k.tila}`);
    tila.textContent = k.tila;
    ylempi.append(tila);
    nappi.append(ylempi);

    if (k.seuraava) {
      const seuraava = elementti('span', 'skooppi-seuraava');
      seuraava.textContent = k.seuraava;
      nappi.append(seuraava);
    }
    nappi.addEventListener('click', () => valitse(k.nimi));
    return nappi;
  }

  function piirra(): void {
    const t = s.tila.tila();
    const hakusana = suodatin.value.trim().toLowerCase();
    const valittu = s.valittu();
    const rivit = t.skoopit
      .filter((k) => hakusana === '' || k.nimi.toLowerCase().includes(hakusana))
      .map((k) => rivi(k, valittu));
    lista.replaceChildren(...rivit);
    yhteys.hidden = t.yhteys !== 'avain';
    yhteys.textContent = t.yhteys === 'avain' ? 'Avain puuttuu tai on väärä' : '';
  }

  function valitse(nimi: string): void {
    s.valitse(nimi);
    s.tilaAvain(VALINTA_AVAIN, nimi).catch(kirjaa('sivupalkki: valinnan tallennus epäonnistui'));
    s.tila.paivitaViestit(nimi).catch(kirjaa('sivupalkki: viestien haku epäonnistui'));
  }

  // Tallennettu valinta luetaan listauksena (S-4 `?etuliite=`): puuttuva avain ei tuota 404:ää konsoliin.
  async function palautaValinta(): Promise<void> {
    const { data } = await s.api.hae<{ tilat?: { avain: string; arvo: unknown }[] }>(`/api/tila?etuliite=${encodeURIComponent(VALINTA_AVAIN)}`);
    const nimi = data.tilat?.find((x) => x.avain === VALINTA_AVAIN)?.arvo;
    if (typeof nimi !== 'string' || nimi === '' || s.valittu() !== null) return;
    s.valitse(nimi);
    await s.tila.paivitaViestit(nimi);
  }

  suodatin.addEventListener('input', piirra);
  const perua = [s.tila.tilaa(piirra), s.tilaa(piirra)];
  piirra();

  s.virta.aloita();
  s.tila.paivitaSkoopit().catch(kirjaa('sivupalkki: skooppien haku epäonnistui'));
  palautaValinta().catch(kirjaa('sivupalkki: valinnan palautus epäonnistui'));

  return () => {
    for (const p of perua) p();
    kuori.remove();
  };
}
