// Viestit: valitun skoopin viestit rooleittain ja kysymyskortit (kuten MacQuestionCard.swift).
import { AvainPuuttuu, skooppiPolku } from '../api.ts';
import type { Sovellus } from '../sovellus.ts';
import type { Viesti } from '../tila.ts';

interface Vaihtoehto {
  nimi: string;
  kuvaus?: string | null;
}

interface Kysymys {
  kysymys: string;
  otsikko?: string | null;
  monivalinta?: boolean;
  vaihtoehdot?: Vaihtoehto[];
}

// S-6:n viesti; kysymysviestissä on lisäksi kysymykset ja vastattu.
type KysymysViesti = Viesti & { kysymykset?: Kysymys[]; vastattu?: boolean };

const ROOLIT = new Set(['kayttaja', 'agentti', 'kysymys', 'tyokalu']);
const VIERITYSRAJA_PX = 24;

function elementti<K extends keyof HTMLElementTagNameMap>(nimi: K, luokka?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(nimi);
  if (luokka) e.className = luokka;
  return e;
}

const kaksi = (n: number): string => String(n).padStart(2, '0');

// Paikallinen hh.mm; puuttuva tai virheellinen aika → tyhjä.
export function kellonaika(aika: string | undefined): string {
  if (!aika) return '';
  const d = new Date(aika);
  return Number.isNaN(d.getTime()) ? '' : `${kaksi(d.getHours())}.${kaksi(d.getMinutes())}`;
}

export function kiinnita(juuri: HTMLElement, s: Sovellus): () => void {
  const kuori = elementti('div', 'viestit');
  kuori.setAttribute('data-testid', 'nakyma-viestit');

  const ilmoitus = elementti('p', 'viestit-ilmoitus');
  const eiIstuntoa = elementti('p', 'viestit-ei-istuntoa');
  eiIstuntoa.setAttribute('data-testid', 'ei-istuntoa');
  eiIstuntoa.textContent = 'Ei avointa istuntoa';
  const rivit = elementti('div', 'viestit-rivit');
  kuori.append(ilmoitus, eiIstuntoa, rivit);
  juuri.append(kuori);

  // Viestin id → piirretty elementti ja sen sormenjälki: muuttumaton viesti jää paikalleen (valinta, kortin tila).
  const piirretyt = new Map<string, { el: HTMLElement; jalki: string }>();
  // Monivalintojen valinnat ja jo lähetetyt vastaukset säilyvät uudelleenpiirrossa.
  const valinnat = new Map<string, Set<string>>();
  const lahetetyt = new Set<string>();
  const virheet = new Map<string, string>();
  let edellinenSkooppi: string | null = null;

  function vastaa(skooppi: string, viestiId: string, vastaus: string): void {
    if (lahetetyt.has(viestiId)) return;
    lahetetyt.add(viestiId);
    virheet.delete(viestiId);
    piirra();
    s.api.hae(skooppiPolku(skooppi, 'viesti'), { runko: { teksti: vastaus } }).then(
      () => { valinnat.delete(viestiId); piirra(); },
      (e: unknown) => {
        lahetetyt.delete(viestiId);
        virheet.set(viestiId, e instanceof AvainPuuttuu ? 'Avain puuttuu' : e instanceof Error ? e.message : String(e));
        piirra();
      },
    );
  }

  function kortti(skooppi: string, v: KysymysViesti, k: Kysymys, indeksi: number): HTMLElement {
    const avain = `${v.id}#${indeksi}`;
    const el = elementti('div', 'kysymyskortti');
    el.setAttribute('data-testid', 'kysymyskortti');
    if (k.otsikko) {
      const otsikko = elementti('div', 'kortti-otsikko');
      otsikko.textContent = k.otsikko;
      el.append(otsikko);
    }
    const kysymys = elementti('div', 'kortti-kysymys');
    kysymys.textContent = k.kysymys;
    el.append(kysymys);

    const monivalinta = k.monivalinta === true;
    const lahetetty = lahetetyt.has(avain);
    const valitut = valinnat.get(avain) ?? new Set<string>();
    for (const vaihtoehto of k.vaihtoehdot ?? []) {
      const nappi = elementti('button', 'kortti-vaihtoehto');
      nappi.type = 'button';
      nappi.setAttribute('data-testid', 'kortti-vaihtoehto');
      nappi.disabled = lahetetty;
      if (monivalinta) {
        nappi.setAttribute('role', 'checkbox');
        nappi.setAttribute('aria-checked', String(valitut.has(vaihtoehto.nimi)));
      }
      const nimi = elementti('span', 'vaihtoehto-nimi');
      nimi.textContent = vaihtoehto.nimi;
      nappi.append(nimi);
      if (vaihtoehto.kuvaus) {
        const kuvaus = elementti('span', 'vaihtoehto-kuvaus');
        kuvaus.textContent = vaihtoehto.kuvaus;
        nappi.append(kuvaus);
      }
      nappi.addEventListener('click', () => {
        if (!monivalinta) { vastaa(skooppi, avain, vaihtoehto.nimi); return; }
        const nyt = valinnat.get(avain) ?? new Set<string>();
        if (!nyt.delete(vaihtoehto.nimi)) nyt.add(vaihtoehto.nimi);
        valinnat.set(avain, nyt);
        piirra();
      });
      el.append(nappi);
    }

    if (monivalinta && valitut.size > 0) {
      const vahvista = elementti('button', 'kortti-vahvista');
      vahvista.type = 'button';
      vahvista.setAttribute('data-testid', 'kortti-vahvista');
      vahvista.disabled = lahetetty;
      vahvista.textContent = `Vahvista valinnat (${valitut.size})`;
      // Järjestys kuten vaihtoehdot ovat, ei klikkausjärjestys.
      vahvista.addEventListener('click', () => {
        const nimet = (k.vaihtoehdot ?? []).map((x) => x.nimi).filter((n) => valitut.has(n));
        vastaa(skooppi, avain, nimet.join(', '));
      });
      el.append(vahvista);
    }
    if (lahetetty) {
      const tila = elementti('p', 'kortti-tila');
      tila.textContent = 'Vastaus lähetetty';
      el.append(tila);
    }
    const virhe = virheet.get(avain);
    if (virhe) {
      const e = elementti('p', 'kortti-virhe');
      e.setAttribute('data-testid', 'kortti-virhe');
      e.textContent = virhe;
      el.append(e);
    }
    return el;
  }

  function viesti(skooppi: string, v: KysymysViesti): HTMLElement {
    const el = elementti('article', `viesti ${ROOLIT.has(v.rooli) ? v.rooli : 'muu'}`);
    el.setAttribute('data-testid', 'viesti');
    const kysymykset = v.kysymykset ?? [];
    if (v.rooli === 'kysymys' && kysymykset.length > 0 && v.vastattu !== true) {
      el.classList.add('kysymykset');
      kysymykset.forEach((k, i) => el.append(kortti(skooppi, v, k, i)));
      return el;
    }
    const meta = elementti('div', 'viesti-meta');
    const rooli = elementti('span', 'viesti-rooli');
    rooli.textContent = v.rooli || 'muu';
    const aika = elementti('time', 'viesti-aika');
    aika.textContent = kellonaika(v.aika);
    meta.append(rooli, aika);
    const teksti = elementti('div', 'viesti-teksti');
    teksti.textContent = v.teksti;
    el.append(meta, teksti);
    return el;
  }

  function piirra(): void {
    const skooppi = s.valittu();
    const alhaalla = kuori.scrollHeight - kuori.scrollTop - kuori.clientHeight <= VIERITYSRAJA_PX;
    const vaihtui = skooppi !== edellinenSkooppi;
    if (vaihtui) {
      piirretyt.clear();
      rivit.replaceChildren();
      edellinenSkooppi = skooppi;
    }
    const tila = skooppi === null ? undefined : s.tila.tila().viestit.get(skooppi);
    ilmoitus.hidden = skooppi !== null && tila !== undefined;
    ilmoitus.textContent = skooppi === null ? 'Valitse skooppi' : 'Ladataan viestejä';
    eiIstuntoa.hidden = tila === undefined || tila.auki;
    if (skooppi === null || tila === undefined) {
      piirretyt.clear();
      rivit.replaceChildren();
      return;
    }

    const kaytetyt = new Set<string>();
    const jarjestys: HTMLElement[] = [];
    tila.lista.forEach((v, i) => {
      let avain = v.id;
      if (kaytetyt.has(avain)) avain = `${v.id}@${i}`;
      kaytetyt.add(avain);
      const kv = v as KysymysViesti;
      const korttiTila = (kv.kysymykset ?? []).map((_, j) => {
        const k = `${v.id}#${j}`;
        return [[...(valinnat.get(k) ?? [])], lahetetyt.has(k), virheet.get(k) ?? null];
      });
      const jalki = JSON.stringify([kv, korttiTila]);
      const olemassa = piirretyt.get(avain);
      if (olemassa && olemassa.jalki === jalki) { jarjestys.push(olemassa.el); return; }
      const el = viesti(skooppi, kv);
      piirretyt.set(avain, { el, jalki });
      jarjestys.push(el);
    });
    for (const avain of [...piirretyt.keys()]) if (!kaytetyt.has(avain)) piirretyt.delete(avain);
    // Vain tarvittavat siirrot: muuttumattomat elementit pysyvät paikoillaan.
    jarjestys.forEach((el, i) => {
      if (rivit.children[i] !== el) rivit.insertBefore(el, rivit.children[i] ?? null);
    });
    while (rivit.children.length > jarjestys.length) rivit.lastElementChild?.remove();

    // Vieritys alas vain, jos käyttäjä oli jo alhaalla (tai skooppi vaihtui).
    if (alhaalla || vaihtui) kuori.scrollTop = kuori.scrollHeight;
  }

  const perua = [s.tila.tilaa(piirra), s.tilaa(piirra)];
  piirra();

  return () => {
    for (const p of perua) p();
    kuori.remove();
  };
}
