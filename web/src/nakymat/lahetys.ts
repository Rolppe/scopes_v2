// Lähetys: viestikenttä valitulle skoopille ja luonnos tilavarastoon (S-4 `luonnos/<skooppi>`, 1 s viive).
import { ApiVirhe, AvainPuuttuu, skooppiPolku } from '../api.ts';
import type { Sovellus } from '../sovellus.ts';

const LUONNOS_VIIVE_MS = 1000;

function elementti<K extends keyof HTMLElementTagNameMap>(nimi: K, luokka?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(nimi);
  if (luokka) e.className = luokka;
  return e;
}

function virheTeksti(e: unknown): string {
  if (e instanceof AvainPuuttuu) return 'Avain puuttuu tai on väärä';
  if (e instanceof ApiVirhe) {
    const r = e.runko;
    const virhe = r !== null && typeof r === 'object' && 'virhe' in r ? String((r as { virhe: unknown }).virhe) : '';
    return virhe !== '' ? virhe : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function kiinnita(juuri: HTMLElement, s: Sovellus): () => void {
  const kuori = elementti('div', 'lahetys');
  kuori.setAttribute('data-testid', 'nakyma-lahetys');

  const kentta = elementti('textarea', 'lahetys-kentta');
  kentta.setAttribute('data-testid', 'lahetys-kentta');
  kentta.setAttribute('aria-label', 'Viesti');
  kentta.placeholder = 'Kirjoita viesti… (Enter lähettää, Shift+Enter rivinvaihto)';
  kentta.rows = 3;

  const laheta = elementti('button', 'lahetys-laheta');
  laheta.type = 'button';
  laheta.setAttribute('data-testid', 'laheta');
  laheta.textContent = 'Lähetä';

  const rivi = elementti('div', 'lahetys-rivi');
  rivi.append(kentta, laheta);
  const virhe = elementti('p', 'lahetys-virhe');
  virhe.setAttribute('data-testid', 'lahetys-virhe');
  virhe.setAttribute('role', 'alert');
  virhe.hidden = true;
  kuori.append(rivi, virhe);
  juuri.append(kuori);

  let skooppi: string | null = null;
  let lahettaa = false;
  let ajastin: ReturnType<typeof setTimeout> | null = null;
  let ajastinSkooppi: string | null = null;
  // Luonnoksen haku ei saa ylikirjoittaa tekstiä, jota käyttäjä ehti kirjoittaa vaihdon jälkeen.
  let sukupolvi = 0;
  // Kesken olevat luonnos-PUT:it skoopeittain: haku odottaa oman skoopin kirjoitusta.
  const kirjoitukset = new Map<string, Promise<unknown>>();
  let suljettu = false;

  const naytaVirhe = (teksti: string | null): void => {
    virhe.hidden = teksti === null;
    virhe.textContent = teksti ?? '';
  };

  function tallennaLuonnos(nimi: string, teksti: string): Promise<unknown> {
    // Peräkkäin, jotta uusin teksti jää viimeiseksi.
    const jono = (kirjoitukset.get(nimi) ?? Promise.resolve()).then(() =>
      s.tilaAvain(`luonnos/${nimi}`, teksti === '' ? null : teksti).catch((e: unknown) => {
        if (!(e instanceof AvainPuuttuu)) console.error('lahetys: luonnoksen tallennus epäonnistui', e);
      }));
    kirjoitukset.set(nimi, jono);
    void jono.then(() => { if (kirjoitukset.get(nimi) === jono) kirjoitukset.delete(nimi); });
    return jono;
  }

  function peruAjastin(): void {
    if (ajastin !== null) clearTimeout(ajastin);
    ajastin = null;
    ajastinSkooppi = null;
  }

  // Odottava luonnos tallennetaan heti, kun skooppi vaihtuu tai näkymä suljetaan.
  function tyhjennaAjastin(teksti: string): void {
    if (ajastin === null || ajastinSkooppi === null) return;
    const nimi = ajastinSkooppi;
    peruAjastin();
    void tallennaLuonnos(nimi, teksti);
  }

  function paivitaTila(): void {
    const t = skooppi === null ? undefined : s.tila.tila().viestit.get(skooppi);
    const voi = t?.voiLahettaa === true;
    kentta.disabled = !voi;
    laheta.disabled = !voi || lahettaa;
  }

  async function lataaLuonnos(nimi: string, ver: number): Promise<void> {
    await kirjoitukset.get(nimi);
    const avain = `luonnos/${nimi}`;
    const { data } = await s.api.hae<{ tilat?: { avain: string; arvo: unknown }[] }>(`/api/tila?etuliite=${encodeURIComponent(avain)}`);
    if (suljettu || ver !== sukupolvi) return;
    const arvo = data.tilat?.find((x) => x.avain === avain)?.arvo;
    kentta.value = typeof arvo === 'string' ? arvo : '';
  }

  function vaihda(): void {
    const nimi = s.valittu();
    if (nimi === skooppi) { paivitaTila(); return; }
    tyhjennaAjastin(kentta.value);
    skooppi = nimi;
    sukupolvi += 1;
    naytaVirhe(null);
    kentta.value = '';
    paivitaTila();
    if (nimi !== null) {
      lataaLuonnos(nimi, sukupolvi).catch((e: unknown) => {
        if (!(e instanceof AvainPuuttuu)) console.error('lahetys: luonnoksen haku epäonnistui', e);
      });
    }
  }

  async function lahetaViesti(): Promise<void> {
    const nimi = skooppi;
    const teksti = kentta.value.trim();
    if (nimi === null || teksti === '' || lahettaa || kentta.disabled) return;
    lahettaa = true;
    paivitaTila();
    try {
      await s.api.hae(skooppiPolku(nimi, 'viesti'), { runko: { teksti } });
    } catch (e) {
      lahettaa = false;
      if (skooppi === nimi) naytaVirhe(virheTeksti(e));
      paivitaTila();
      return;
    }
    lahettaa = false;
    // Luonnos poistetaan, ja odottava luonnos-PUT mitätöidään: se palauttaisi juuri lähetetyn tekstin.
    if (ajastinSkooppi === nimi) peruAjastin();
    void tallennaLuonnos(nimi, '');
    if (skooppi === nimi) {
      sukupolvi += 1;
      naytaVirhe(null);
      if (kentta.value.trim() === teksti) kentta.value = '';
    }
    paivitaTila();
  }

  kentta.addEventListener('input', () => {
    sukupolvi += 1;
    naytaVirhe(null);
    if (skooppi === null) return;
    peruAjastin();
    const nimi = skooppi;
    ajastinSkooppi = nimi;
    ajastin = setTimeout(() => {
      ajastin = null;
      ajastinSkooppi = null;
      void tallennaLuonnos(nimi, kentta.value);
    }, LUONNOS_VIIVE_MS);
  });
  kentta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void lahetaViesti();
  });
  laheta.addEventListener('click', () => { void lahetaViesti(); });

  const perua = [s.tila.tilaa(paivitaTila), s.tilaa(vaihda)];
  vaihda();
  paivitaTila();

  return () => {
    suljettu = true;
    for (const p of perua) p();
    tyhjennaAjastin(kentta.value);
    kuori.remove();
  };
}
