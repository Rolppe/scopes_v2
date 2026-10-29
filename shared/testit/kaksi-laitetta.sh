#!/usr/bin/env bash
# kaksi-laitetta.sh (T-52, ARK-09): macOS-äppi ja iOS-simulaattoriäppi yhtä aikaa omilla datahakemistoillaan, molemmat vertaisena
# koeytimeen (SCOPES2_VERTAINEN, oletus tunneli 127.0.0.1:18797); testiparit koordinoivat koeytimen avaimilla koe/kl-*. Ajetaan Macilla portin (gate.sh T-52) kautta: tunneli ja
# kertakäyttöavain SCOPES2_AVAIN ovat valmiina, rakennuslukko on portilla. Tulostaa per tarkistus
#   KAKSI-LAITETTA: <nimi> <ms> ok|virhe
# ja lopuksi "KAKSI-LAITETTA: 5/5". Raja 2 000 ms kaikille paitsi headlessille (siinä ms = havaintoikkuna).
# Tarkistukset: valinta (mac → sim), luonnos (sim → mac), vierityskohta (mac → sim), kuittaus (sim → mac), headless (mac headless → sim).
# Solmut ovat toistensa vertaisia (SCOPES2_PORTTI/SCOPES2_VERTAISET, Macin loopback 18861/18862): replikointi vetää vain vertaisen virrasta,
# eikä koeydin tunne äppien osoitteita, joten pelkkä koeydin-vertainen ei välitä äpiltä toiselle.
# Ympäristö: SCOPES2_SIM (oletus "iPhone 15 Pro"), KL_RAJA_MS, KL_AIKARAJA (s per xcodebuild, oletus 420), KL_VAIN (esim. "valinta luonnos").
set -uo pipefail

RAK=${RAK:-$(cd "$(dirname "$0")/../.." && pwd)}
SIM=${SCOPES2_SIM:-iPhone 15 Pro}
OSOITE=${SCOPES2_VERTAINEN:-http://127.0.0.1:18797}
RAJA_MS=${KL_RAJA_MS:-2000}
AIKARAJA=${KL_AIKARAJA:-720}
: "${SCOPES2_AVAIN:?SCOPES2_AVAIN puuttuu (portti antaa sen)}"

KL=$(mktemp -d /tmp/scopes2-kl.XXXXXX)   # vain xcodebuild-lokit
export TEST_RUNNER_SCOPES2_VERTAINEN="$OSOITE" KL_OSOITE="$OSOITE" TEST_RUNNER_KL_AJO=1
export TEST_RUNNER_SCOPES2_AVAIN="${TEST_RUNNER_SCOPES2_AVAIN:-$SCOPES2_AVAIN}"
export TEST_RUNNER_SCOPES2_NAYTTO_HEREILLA=YES   # T-71: äppi pitää näytön hereillä itse (-scopes2.naytto-hereilla), ei ssh-kofeiinia
trap 'siivoa >/dev/null 2>&1; rm -rf "$KL"' EXIT

# Testin omat tila-avaimet palvelimelta pois (PUT arvo null): luonnokset, vierityskohdat, valinta, suodatin, piilotukset, koe/kl-*.
siivoa() {
  /usr/bin/python3 - <<'PY'
import json, os, sys, urllib.parse, urllib.request
o, k = os.environ["KL_OSOITE"], os.environ["SCOPES2_AVAIN"]
def pyyda(polku, metodi="GET", runko=None):
    r = urllib.request.Request(o + polku, method=metodi, data=None if runko is None else json.dumps(runko).encode())
    r.add_header("Authorization", "Bearer " + k)
    if runko is not None:
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=10) as v:
        return json.load(v)
avaimet = ["valittu-skooppi", "suodatin", "piilotukset"]
for e in ("luonnos/", "vierityskohta/", "koe/kl-"):
    avaimet += [t["avain"] for t in pyyda("/api/tila?etuliite=" + urllib.parse.quote(e, safe=""))["tilat"]]
for a in avaimet:
    pyyda("/api/tila/" + urllib.parse.quote(a, safe="/"), "PUT", {"arvo": None})
PY
}

# koe_arvo <nimi> : koe/kl-<nimi> palvelimelta (tyhjä jos ei ole)
koe_arvo() {
  KL_AVAIN="koe/kl-$1" /usr/bin/python3 - <<'PY' 2>/dev/null
import json, os, urllib.parse, urllib.request
r = urllib.request.Request(os.environ["KL_OSOITE"] + "/api/tila/" + urllib.parse.quote(os.environ["KL_AVAIN"], safe="/"))
r.add_header("Authorization", "Bearer " + os.environ["SCOPES2_AVAIN"])
try:
    with urllib.request.urlopen(r, timeout=10) as v:
        a = json.load(v).get("arvo")
        print("" if a is None else a)
except Exception:
    print("")
PY
}

# Kylmä koeydin hakee skooppilistan sillan kautta vanhasta palvelimesta: lämmitä ennen kuin äpit käynnistyvät.
lammita() {
  curl -fsS -m 240 -H "Authorization: Bearer $SCOPES2_AVAIN" "$OSOITE/api/skoopit" >/dev/null 2>&1 || echo "KAKSI-LAITETTA: varoitus, koeytimen skooppilistaa ei saatu 240 s:ssa" >&2
  # myös avoimien istuntojen viestit (sillan kautta 5–13 s per skooppi kylmällä koeytimellä)
  /usr/bin/python3 - <<'PY' 2>/dev/null
import json, os, urllib.parse, urllib.request
o, k = os.environ["KL_OSOITE"], os.environ["SCOPES2_AVAIN"]
def hae(polku):
    r = urllib.request.Request(o + polku); r.add_header("Authorization", "Bearer " + k)
    with urllib.request.urlopen(r, timeout=240) as v:
        return json.load(v)
for s in hae("/api/skoopit"):
    if (s.get("istuntoja") or 0) > 0:
        try: hae("/api/skoopit/" + urllib.parse.quote(s["nimi"], safe="") + "/viestit")
        except Exception: pass
PY
}

xb_mac() { # <only-testing> <loki>
  xcodebuild test -project "$RAK/macos/ScopesV2Mac.xcodeproj" -scheme ScopesV2Mac -destination "platform=macOS" \
    CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= -derivedDataPath "$RAK/macos/build" \
    -collect-test-diagnostics never -only-testing:"ScopesV2MacUITests/KaksiLaitettaUITests/$1" >"$2" 2>&1
}

xb_sim() {
  xcodebuild test -project "$RAK/ios/ScopesV2.xcodeproj" -scheme ScopesV2 -destination "platform=iOS Simulator,name=$SIM" \
    CODE_SIGNING_ALLOWED=NO -derivedDataPath "$RAK/ios/build" \
    -collect-test-diagnostics never -only-testing:"ScopesV2UITests/KaksiLaitettaUITests/$1" >"$2" 2>&1
}

# ajo <nimi> <mac-testi> [<sim-testi>]; ilman sim-testiä vain mac. Palauttaa 0 vain jos ok.
ajo() {
  local nimi=$1 mac_t=$2 sim_t=${3:-} pm ps=0 vahti rm=0 rs=0 ms syy="" raja=$RAJA_MS
  [ "$nimi" = headless ] && raja=0   # headlessissa ms = havaintoikkuna, ei viive
  siivoa || { echo "KAKSI-LAITETTA: $nimi 0 virhe"; echo "  syy: palvelimen tilan siivous epäonnistui" >&2; return 1; }
  xb_mac "$mac_t" "$KL/$nimi.mac.loki" & pm=$!
  if [ -n "$sim_t" ]; then xb_sim "$sim_t" "$KL/$nimi.sim.loki" & ps=$!; fi
  ( sleep "$AIKARAJA"; kill -TERM "$pm" ${ps#0} 2>/dev/null ) >/dev/null 2>&1 & vahti=$!
  wait "$pm"; rm=$?
  [ "$ps" != 0 ] && { wait "$ps"; rs=$?; }
  kill "$vahti" 2>/dev/null; wait "$vahti" 2>/dev/null
  mkdir -p /tmp/scopes2-kl-lokit && cp "$KL"/*.loki /tmp/scopes2-kl-lokit/ 2>/dev/null
  ms=$(koe_arvo "$nimi.tulos")
  case "$ms" in
    ''|virhe*) syy="${ms:-ei tulosta} (mac exit $rm, sim exit $rs)"; ms=0 ;;
    *[!0-9]*) syy="tulos ei ole luku: $ms"; ms=0 ;;
    *)
      if [ "$rm" != 0 ] || [ "$rs" != 0 ]; then syy="xcodebuild epäonnistui (mac exit $rm, sim exit $rs)"
      elif [ "$raja" != 0 ] && [ "$ms" -gt "$raja" ]; then syy="$ms ms ylittää rajan $raja ms"
      fi ;;
  esac
  if [ -z "$syy" ]; then
    echo "KAKSI-LAITETTA: $nimi $ms ok"
    return 0
  fi
  echo "KAKSI-LAITETTA: $nimi $ms virhe"
  echo "  syy: $syy"
  for l in mac sim; do
    [ -s "$KL/$nimi.$l.loki" ] && { echo "  --- $nimi.$l.loki (loppu)"; grep -E "error|failed|Test Case|XCTAssert|virhe" "$KL/$nimi.$l.loki" | tail -15; }
  done
  return 1
}

valittu() { [ -z "${KL_VAIN:-}" ] && return 0; case " $KL_VAIN " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

lammita
kaikki=0; ok=0
tarkista() { # <nimi> <mac-testi> [<sim-testi>]
  valittu "$1" || return 0
  kaikki=$((kaikki + 1))
  ajo "$@" && ok=$((ok + 1))
}

tarkista valinta        testValintaKirjoittaja        testValintaLukija
tarkista luonnos        testLuonnosLukija             testLuonnosKirjoittaja
tarkista vierityskohta  testVierityskohtaKirjoittaja  testVierityskohtaLukija
tarkista kuittaus       testKuittausLukija            testKuittausKirjoittaja
tarkista headless       testHeadlessKirjoittaja       testHeadlessLukija

siivoa >/dev/null 2>&1 || true
echo "KAKSI-LAITETTA: $ok/$kaikki"
[ "$ok" = "$kaikki" ] && [ "$kaikki" -gt 0 ]
