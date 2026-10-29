// kopio: scopes/palvelu/kayttoraja.mjs @ 977b5f45 (21.10.2026); muuttuneet vain import-rivit
// Clauden käyttörajat äpin renkaille (CHAT-KAYTTORAJA 13.10.2026): 5 h raja ja viikkoraja prosentteina.
//
// Lähde on sama `/api/oauth/usage`, jota Claude Code ja Infra/hooks/kayttoraja-vahti.py kutsuvat koneen
// OAuth-tunnuksella. Päätepiste vastaa kroonisesti 429:llä (noin puolet hauista 25.9. alkaen), joten tämä ei
// hae joka pyynnöllä: 5 h lukema otetaan vahdin välimuistista (vahti hakee 60 s välein, kun jokin istunto
// työskentelee), ja oma haku tehdään enintään HAE_MS välein, virheen jälkeen aikaisintaan VIRHE_MS päästä.
// Viikkoraja liikkuu hitaasti, joten 15 min vanha lukema riittää renkaalle.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URL = 'https://api.anthropic.com/api/oauth/usage';
const HAE_MS = 15 * 60_000;
const VIRHE_MS = 5 * 60_000;
const VAHTI_TUORE_MS = 10 * 60_000;

// Nollautumishetki ISO-muotoon millisekunnein: päätepisteen mikrosekunnit eivät jäsenny iOS:n ISO8601DateFormatterilla.
const iso = (t) => (Number.isFinite(Date.parse(t)) ? new Date(t).toISOString() : null);

function raja(o) {
  const kaytto = Number(o?.utilization);
  return Number.isFinite(kaytto) ? { kaytto, nollautuu: iso(o.resets_at) } : null;
}

export function luoKayttoraja({
  tunnusTiedosto = join(homedir(), '.claude/.credentials.json'),
  vahtiTiedosto = join(homedir(), '.claude/hooks/state/kayttoraja-vahti/kaytto.json'),
  hae = fetch,
  nyt = Date.now,
} = {}) {
  let oma = null; // { haettu, viikko, viisiTuntia }
  let seuraava = 0;
  let kesken = null;

  async function haeItse() {
    try {
      const token = JSON.parse(readFileSync(tunnusTiedosto, 'utf8')).claudeAiOauth.accessToken;
      const r = await hae(URL, {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'scopes-palvelu' },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        const odota = Number(r.headers?.get?.('retry-after')) * 1000;
        seuraava = nyt() + Math.max(VIRHE_MS, Number.isFinite(odota) ? odota : 0);
        return;
      }
      const d = await r.json();
      oma = { haettu: nyt(), viikko: raja(d.seven_day), viisiTuntia: raja(d.five_hour) };
      seuraava = nyt() + HAE_MS;
    } catch {
      seuraava = nyt() + VIRHE_MS;
    }
  }

  // Vahdin lukema { haettu (s), kaytto, nollautuu }, jos se on tuoreempi kuin VAHTI_TUORE_MS.
  function vahti() {
    try {
      const v = JSON.parse(readFileSync(vahtiTiedosto, 'utf8'));
      const haettu = Number(v.haettu) * 1000;
      if (!(nyt() - haettu < VAHTI_TUORE_MS) || !Number.isFinite(Number(v.kaytto))) return null;
      return { haettu, raja: { kaytto: Number(v.kaytto), nollautuu: iso(v.nollautuu) } };
    } catch {
      return null;
    }
  }

  // Nollautumishetken ohittanut lukema on vanha: raja on silloin tyhjä, kunnes uusi haku onnistuu.
  const voimassa = (r) => (r && r.nollautuu && Date.parse(r.nollautuu) <= nyt() ? { kaytto: 0, nollautuu: null } : r ?? null);

  return async function kayttoraja() {
    if (nyt() >= seuraava) {
      kesken ??= haeItse().finally(() => { kesken = null; });
      await kesken;
    }
    const v = vahti();
    const viisiTuntia = v && (!oma || v.haettu > oma.haettu) ? v.raja : oma?.viisiTuntia ?? null;
    return { viikko: voimassa(oma?.viikko), viisiTuntia: voimassa(viisiTuntia), haettu: oma ? new Date(oma.haettu).toISOString() : null };
  };
}
