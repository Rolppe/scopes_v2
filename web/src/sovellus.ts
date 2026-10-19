// Sovelluksen jaettu tila näkymille. T-40 tarkentaa api- ja tila-tyypit.
export interface Sovellus {
  api: unknown;
  tila: unknown;
  valittu(): string | null;
  valitse(nimi: string | null): void;
  tilaa(kuuntelija: () => void): () => void;
}

export function luoSovellus(): Sovellus {
  let valittu: string | null = null;
  const kuuntelijat = new Set<() => void>();
  return {
    api: null,
    tila: null,
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
  };
}
