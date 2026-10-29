# T-59 (4)(5): vertaa täyden solmun (A = tuotanto 8797 tunnelin kautta) ja ikkunoidun solmun (B = simulaattorin äppi)
# /api/skoopit/<nimi>/viestit -vastaukset. Käyttö: python3 -I vertaa-tuotanto.py <A.json> <B.json> <vrk> [sisaltaa]  (sisaltaa: B:llä saa olla A:n tilannekuvaa uudempia viestejä)
# Vertailu: viestit kokonaisina objekteina (id, rooli, teksti, aika, kysymykset, vastattu, työkalukentät), vain ne A:n viestit,
# joiden aika on ikkunan sisällä (≥ nyt − vrk); B:n pitää sisältää täsmälleen samat. Tuloste yksi rivi, exit 0 = sama.
import json, sys, datetime as dt

a, b = (json.load(open(p)) for p in sys.argv[1:3])
vrk = int(sys.argv[3])
sisaltaa = len(sys.argv) > 4 and sys.argv[4] == "sisaltaa"
raja = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=vrk)

def aika(v):
    s = v.get("aika")
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None

def avain(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)

av = [v for v in a.get("viestit", []) if (aika(v) or raja) >= raja]
bv = b.get("viestit", [])
# B voi näyttää A:n 120:n ikkunaa vanhempia vain, jos se on hakenut ne (S-9e); verrataan A:n ikkunan aikavälillä.
alku = min((aika(v) for v in av if aika(v)), default=None)
bv = [v for v in bv if alku is None or (aika(v) or alku) >= alku]
aset, bset = [avain(v) for v in av], [avain(v) for v in bv]
lajit = lambda vs: {k: sum(1 for v in vs if v.get(k)) for k in ("kysymykset", "vastattu")} | {"tyokalu": sum(1 for v in vs if v.get("rooli") not in ("user", "assistant"))}
if aset == bset or (sisaltaa and set(aset) <= set(bset)):
    print(f"SAMA {len(av)} viestiä (lajit {lajit(av)}), haettavissa B={b.get('haettavissa')}")
    sys.exit(0)
puuttuu = [json.loads(x).get("id") for x in aset if x not in set(bset)][:5]
ylim = [json.loads(x).get("id") for x in bset if x not in set(aset)][:5]
print(f"ERO A={len(av)} B={len(bv)} puuttuu B:ltä {puuttuu} ylimääräiset {ylim} haettavissa B={b.get('haettavissa')}")
sys.exit(1)
