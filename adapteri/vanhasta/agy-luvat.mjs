// kopio: scopes/palvelu/agy-luvat.mjs @ f5fc3d36 (21.10.2026); muuttuneet vain import-rivit
// "Always allow" -kytkin agy-istunnoille (käyttäjä 16.10.2026: "tee scopes asetuksiin toggle joka pitää sitä always allow
// moodissa kaikille skoopeille"). Kun asetus `agyluvat` on päällä, palvelin katsoo kaikkien agy-ruutujen (tmux siirto-*,
// komento agy) lupakyselyt ja vastaa niihin samalla numerolla kuin käyttäjä: agy ei kirjoita kyselyä keskustelutiedostoon,
// joten äppi ei näe sitä, ja jokainen komento tai tiedosto työkansion ulkopuolelta jäi odottamaan.
// Valinta on rajattu: ensisijaisesti "always allow in this conversation", muuten pelkkä "Yes". Pysyvää
// ("Persist to settings.json") tai työkansion ulkopuolista yleislupaa ("non-workspace") ei koskaan valita, eikä mitään "No"-vaihtoehtoa.
// Claude Code -istuntoja tämä ei koske, eikä chat (claude -p ilman työkaluja) kysy lupia.

export const LUPAKYSELYT = ['Run this command?', 'Allow access to this file?'];
const RUOUTU = /^siirto-[a-z0-9-]+-\d{6} (agy|ssh)$/;

// Ruudun teksti → { numero, nimi } tai null, kun ruudulla ei ole tunnettua lupakyselyä tai turvallista vaihtoehtoa.
export function valitseVastaus(ruutu) {
  const teksti = String(ruutu ?? '');
  if (!LUPAKYSELYT.some((k) => teksti.includes(k))) return null;
  const vaihtoehdot = [];
  for (const rivi of teksti.split('\n')) {
    const m = /^\s*(?:>\s*)?(\d+)\.\s+(.+?)\s*$/.exec(rivi);
    if (m) vaihtoehdot.push({ numero: m[1], nimi: m[2] });
  }
  const sallittu = (v) => /^Yes\b/.test(v.nimi) && !/Persist|non-workspace|deny/i.test(v.nimi);
  const valinta = vaihtoehdot.find((v) => sallittu(v) && /always allow in this conversation/i.test(v.nimi))
    ?? vaihtoehdot.find((v) => sallittu(v) && /^Yes, (run command|allow access)\b/.test(v.nimi));
  return valinta ?? null;
}

export function luoAgyLuvat({ aja, paalla, kirjaa = () => {}, vali = 3000 }) {
  let ajastin = null;
  const viimeksi = new Map(); // ruutu → viimeisen vastauksen aika; sama kysely ei saa saada kahta painallusta
  async function kierros() {
    if (!paalla()) return [];
    const t = await aja('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_current_command}']);
    if (t.koodi !== 0) return [];
    const vastatut = [];
    for (const rivi of t.stdout.split('\n').map((r) => r.trim()).filter((r) => RUOUTU.test(r))) {
      const ruutu = rivi.split(' ')[0];
      if (Date.now() - (viimeksi.get(ruutu) ?? 0) < 2 * vali) continue;
      const kuva = await aja('tmux', ['capture-pane', '-p', '-t', ruutu]);
      if (kuva.koodi !== 0) continue;
      const v = valitseVastaus(kuva.stdout);
      if (!v) continue;
      viimeksi.set(ruutu, Date.now());
      const n = await aja('tmux', ['send-keys', '-t', ruutu, v.numero]);
      kirjaa({ toiminto: 'agy-lupa', istunto: ruutu, valinta: v.nimi.slice(0, 80), tulos: n.koodi === 0 ? 'ok' : 'epäonnistui' });
      if (n.koodi === 0) vastatut.push({ ruutu, ...v });
    }
    return vastatut;
  }
  return {
    kierros,
    kaynnista() {
      if (ajastin) return;
      ajastin = setInterval(() => { kierros().catch(() => {}); }, vali);
      ajastin.unref();
    },
    pysayta() { if (ajastin) clearInterval(ajastin); ajastin = null; },
  };
}
