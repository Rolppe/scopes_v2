"""T-51-vertailut: lista (nimi, tila, seuraava) ja viestit (aikaleimat, liukuva ikkuna). Exit 0 = sama."""
import json
import sys


def lue(p):
    with open(p) as f:
        return json.load(f)


def lista(vanha1, v2, vanha2):
    def kartta(d):
        return {s["nimi"]: (s.get("tila"), s.get("seuraava")) for s in d}
    a, b, c = kartta(lue(vanha1)), kartta(lue(v2)), kartta(lue(vanha2))
    puuttuvat = [k for k in ("tila", "seuraava") if any(k not in s for s in lue(v2))]
    if puuttuvat:
        print(f"  koeytimen listasta puuttuu kenttä: {puuttuvat}")
    ero = [n for n in set(a) | set(b) if b.get(n) != a.get(n) and b.get(n) != c.get(n)]
    print(f"  8787 {len(a)} skooppia, koeydin {len(b)}; eroja {len(ero)}" + (f": {sorted(ero)[:5]}" if ero else ""))
    for n in sorted(ero)[:5]:
        print(f"    {n}: 8787 {a.get(n)} / {c.get(n)}, koeydin {b.get(n)}")
    return 0 if not ero and not puuttuvat else 1


def valitse(vanha):
    d = lue(vanha)
    nimet = [s["nimi"] for s in d]
    for n in ["infra expresso"] + [n for n in nimet if n != "infra expresso"][:1]:
        if n in nimet:
            print(n)
    return 0


def viestit(vanha1, v2, vanha2):
    def rivit(p):
        d = lue(p)
        return [(v.get("aika"), v.get("rooli"), v.get("teksti")) for v in d.get("viestit", [])]
    a, b, c = rivit(vanha1), rivit(v2), rivit(vanha2)
    raja = a[-1][0] if a else ""
    yhd = a + [r for r in c if (r[0] or "") > raja]
    if not b:
        ok = not a and not c
        print(f"  koeydin 0 viestiä, 8787 {len(a)}/{len(c)}")
        return 0 if ok else 1
    try:
        i = yhd.index(b[0])
    except ValueError:
        print(f"  koeytimen ensimmäinen viesti {b[0][0]} puuttuu 8787:n yhdistetystä listasta ({len(yhd)})")
        return 1
    sama = yhd[i:i + len(b)] == b
    print(f"  koeydin {len(b)} viestiä ({b[0][0]} … {b[-1][0]}), 8787 ennen {len(a)}, jälkeen {len(c)}, yhdistetty {len(yhd)}; "
          f"{'sama jakso' if sama else 'JAKSO EROAA'}")
    return 0 if sama else 1


if __name__ == "__main__":
    sys.exit({"lista": lista, "valitse": valitse, "viestit": viestit}[sys.argv[1]](*sys.argv[2:]))
