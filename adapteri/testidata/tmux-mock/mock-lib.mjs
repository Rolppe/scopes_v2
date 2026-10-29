// Yhteinen apu tmux-mockille ja skriptimockeille (T-63-G, ARK-16). Ei tuo mitään scopes/-polusta.
//   TMUX_MOCK_LOKI   tiedosto, johon jokainen kutsu kirjataan yhtenä JSON-rivinä {"komento","argv"[,"syote"]}
//   TMUX_MOCK_DATA   hakemisto, josta vastaukset luetaan: <avain>.txt = stdout, <avain>.stderr = stderr,
//                    <avain>.koodi = exit-koodi (oletus 0). Puuttuva tiedosto = oletusvastaus (kts. kunkin mockin alkukommentti).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function kirjaa(komento, argv, syote) {
  const loki = process.env.TMUX_MOCK_LOKI;
  if (!loki) { process.stderr.write('mock: TMUX_MOCK_LOKI puuttuu\n'); process.exit(97); }
  appendFileSync(loki, `${JSON.stringify({ komento, argv, ...(syote ? { syote } : {}) })}\n`);
}

const tiedosto = (avain, pääte) => (process.env.TMUX_MOCK_DATA ? join(process.env.TMUX_MOCK_DATA, `${avain}.${pääte}`) : null);
export const onData = (avain, pääte) => { const t = tiedosto(avain, pääte); return t !== null && existsSync(t); };
export const lueData = (avain, pääte, oletus = null) => (onData(avain, pääte) ? readFileSync(tiedosto(avain, pääte), 'utf8') : oletus);

// Vastaa avaimella: stdout, stderr ja koodi datahakemistosta, muuten annetuilla oletuksilla; palauttaa exit-koodin.
export function vastaa(avain, { stdout = '', stderr = '', koodi = 0 } = {}) {
  process.stdout.write(lueData(avain, 'txt', stdout));
  process.stderr.write(lueData(avain, 'stderr', stderr));
  return Number(lueData(avain, 'koodi', String(koodi)).trim());
}

export const lueStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
