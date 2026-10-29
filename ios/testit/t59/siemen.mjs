// T-59: koeytimen siemen (S1 + S2) POST-runkoina. Käyttö:
//   node siemen.mjs <ulos-hakemisto> <S2:n skooppi> <S1-testidata-hakemisto>
// Tuottaa: istunnot.json (lahde/istunnot, laite koe-siemen, S1 + S2), agy.json, peili-s1.json, peili-s2a.json (VANHA yksikkö,
// offset 0, ~23 vrk sitten) ja peili-s2b.json (TUORE yksikkö, offset = a:n tavukoko, ~1 vrk sitten), sekä
// tiedot.json (tunnisteet, tavukoot). Peilirungon sha256 ja offset kuten ytimen peili.rs (rivi + "\n").
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [ulos, skooppi2, s1hak] = process.argv.slice(2);
if (!ulos || !skooppi2 || !s1hak) { console.error('käyttö: siemen.mjs <ulos> <S2-skooppi> <S1-testidata>'); process.exit(2); }

const S1 = '62e0a5e1-0000-4000-8000-000000000062';
const S2 = '59e0a5e1-0000-4000-8000-000000000059';
const tiedosto = (id) => `koe-siemen/${id}.jsonl`;
const tiiviste = (rivit) => { const h = createHash('sha256'); for (const r of rivit) { h.update(r); h.update('\n'); } return h.digest('hex'); };
const tavut = (rivit) => rivit.reduce((a, r) => a + Buffer.byteLength(r) + 1, 0);
const runko = (id, offset, rivit) => ({ tiedosto: tiedosto(id), offset, rivit, sha256: tiiviste(rivit) });

// Ajat suhteessa ajohetkeen (7 vrk:n ikkuna): S1 ja TUORE päättyvät ~1 vrk sitten, VANHA ~23 vrk sitten. Kiinteät päivät
// (S1 19.10., TUORE 20.10.) putosivat ikkunasta 27.10.2026 alkaen.
const H = 3600e3, nyt = Math.floor(Date.now() / H) * H;
const s1raaka = readFileSync(join(s1hak, 'siemen-transkripti.jsonl'), 'utf8').split('\n').filter((r) => r.length > 0);
const aikaRe = /"timestamp":"([^"]+)"/;
const s1siirto = (nyt - 24 * H) - Math.max(...s1raaka.map((r) => Date.parse((r.match(aikaRe) ?? [])[1]) || 0));
const s1rivit = s1raaka.map((r) => r.replace(aikaRe, (_, t) => `"timestamp":"${new Date(Date.parse(t) + s1siirto).toISOString()}"`));

// 2 user + 2 assistant -riviä per yksikkö, tunnin välein alkaen hetkestä `alku` (ms).
const yksikko = (alku, merkki) => {
  const rivi = (i, tyyppi, sisalto) => JSON.stringify({
    sessionId: S2, timestamp: new Date(alku + i * H).toISOString(), type: tyyppi,
    message: { role: tyyppi, ...(tyyppi === 'assistant' ? { model: 'claude-opus-5-5' } : {}), content: sisalto },
  });
  return [
    rivi(0, 'user', `${merkki} käyttäjä yksi`),
    rivi(1, 'assistant', [{ type: 'text', text: `${merkki} vastaus yksi` }]),
    rivi(2, 'user', `${merkki} käyttäjä kaksi`),
    rivi(3, 'assistant', [{ type: 'text', text: `${merkki} vastaus kaksi` }]),
  ];
};
const vanhaAlku = nyt - 23 * 24 * H, tuoreAlku = nyt - 27 * H;
const vanha = yksikko(vanhaAlku, 'T59-VANHA');
const tuore = yksikko(tuoreAlku, 'T59-TUORE');
const offsetB = tavut(vanha);

const istunnot = JSON.parse(readFileSync(join(s1hak, 'siemen-istunnot.json'), 'utf8'));
const s1 = istunnot.sisalto[0];
const s2loppu = new Date(tuoreAlku + 3 * H + 60e3).toISOString();
const s2 = { ...s1, istunto: S2, skooppi: skooppi2, transkripti: tiedosto(S2),
  konteksti: { tokenit: 1000, aika: s2loppu }, pysahdys: s2loppu, alkoi: new Date(vanhaAlku - H).toISOString() };
istunnot.sisalto = [s1, s2];

const kirjoita = (nimi, arvo) => writeFileSync(join(ulos, nimi), typeof arvo === 'string' ? arvo : JSON.stringify(arvo) + '\n');
kirjoita('istunnot.json', istunnot);
kirjoita('agy.json', JSON.parse(readFileSync(join(s1hak, 'siemen-agy.json'), 'utf8')));
kirjoita('peili-s1.json', runko(S1, 0, s1rivit));
kirjoita('peili-s2a.json', runko(S2, 0, vanha));
kirjoita('peili-s2b.json', runko(S2, offsetB, tuore));
kirjoita('tiedot.json', { s1: S1, s2: S2, skooppi2, offsetB, rivejaS1: s1rivit.length });
console.log(`SIEMEN: S1 ${s1rivit.length} riviä, S2 (${skooppi2}) vanha 4 riviä offset 0, tuore 4 riviä offset ${offsetB}`);
