// Chat-virran NDJSON (POST /api/chat/virta, GET /api/chat/kaynnissa): yksi JSON-olio per rivi.
export type ChatTapahtuma =
  | { tyyppi: 'pala'; teksti: string }
  | { tyyppi: 'valmis'; vastaus: string; keskustelu?: string }
  | { tyyppi: 'virhe'; virhe: string };

function tapahtuma(rivi: string): ChatTapahtuma | null {
  if (rivi.trim() === '') return null;
  let o: unknown;
  try { o = JSON.parse(rivi); } catch { return null; }
  if (o === null || typeof o !== 'object') return null;
  const t = (o as { tyyppi?: unknown }).tyyppi;
  return t === 'pala' || t === 'valmis' || t === 'virhe' ? (o as ChatTapahtuma) : null;
}

export async function* lueNdjson(virta: ReadableStream<Uint8Array>): AsyncGenerator<ChatTapahtuma> {
  const lukija = virta.getReader();
  const dekoodi = new TextDecoder('utf-8');
  let puskuri = '';
  try {
    for (;;) {
      const { value, done } = await lukija.read();
      if (done) break;
      puskuri += dekoodi.decode(value, { stream: true });
      let i: number;
      while ((i = puskuri.indexOf('\n')) >= 0) {
        const t = tapahtuma(puskuri.slice(0, i));
        puskuri = puskuri.slice(i + 1);
        if (t) yield t;
      }
    }
    puskuri += dekoodi.decode();
    const loppu = tapahtuma(puskuri);
    if (loppu) yield loppu;
  } finally {
    await lukija.cancel().catch(() => undefined);
  }
}
