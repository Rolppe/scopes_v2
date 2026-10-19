// Avain: URL-fragmentti #avain=<arvo> → localStorage → fragmentti pois osoiterivistä (S-7).
export const AVAIN_KEY = 'scopes2.avain';

function luku(varasto: Storage): string | null {
  try { return varasto.getItem(AVAIN_KEY) || null; } catch { return null; }
}

export function lueAvainFragmentista(
  loc: { hash: string },
  varasto: Storage,
  historia: { replaceState(d: unknown, t: string, url: string): void },
  polku: string,
): string | null {
  const osat = loc.hash.replace(/^#/, '').split('&').filter((o) => o !== '');
  const jaljella: string[] = [];
  let arvo: string | null = null;
  for (const osa of osat) {
    const [nimi, ...loput] = osa.split('=');
    if (nimi === 'avain') arvo = decodeURIComponent(loput.join('='));
    else jaljella.push(osa);
  }
  if (osat.length > jaljella.length) {
    if (arvo) { try { varasto.setItem(AVAIN_KEY, arvo); } catch { /* varasto ei käytössä: avain elää vain tämän sivun */ } }
    historia.replaceState(null, '', polku + (jaljella.length ? `#${jaljella.join('&')}` : ''));
  }
  return arvo || luku(varasto);
}

export function asetaAvain(varasto: Storage, avain: string | null): void {
  try {
    if (avain === null || avain === '') varasto.removeItem(AVAIN_KEY);
    else varasto.setItem(AVAIN_KEY, avain);
  } catch { /* ei varastoa */ }
}
