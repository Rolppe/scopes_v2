#!/usr/bin/env bash
# T-59 simulaattoriosa (SUUNNITELMA.md T-59): ikkunoitu iOS-solmu (7 vrk) koeydintä vasten TCP-välityksen P kautta.
#   (a) asetusnäkymän peili-koko ≤ katto pakotetulla ikkunalla, (b) tunneli suljettuna: 7 vrk:n viestit näkyvät, S2:n vanha
#   osa ei, (c) tunnelin palattua S2 hakee vanhat viestit. (d) "toinen simulaattori ilman ikkunaa" = gate T-49 (ei tässä).
# Käyttö Macilla: bash scopes2/ios/testit/t59/t59.sh > loki 2>&1   (tulostiedostot $T59_ULOS, oletus mktemp /tmp)
# Koeydin A (täysi solmu), siemen S1 (testidata/siemen-*, skooppi "test") + S2 (sekaistunto: vanha yksikkö ~23 vrk, tuore ~1 vrk sitten;
# S2:n skooppi = sillan listan viimeinen), P = valitys.mjs (Macin 127.0.0.1:<Mac-portti + 200> → A). Ei 8797/18797, ei target/release.
# Käyttää gate.sh:n koeydin-, silta- ja lukkofunktioita (lähdekoodattuna ilman pääosaa). Koeytimen avain vain tiedostossa/ympäristössä.
# Exit: 0 vihreä, 1 punainen, 3 lukko varattu.
set -u
S=$(cd "$(dirname "$0")" && pwd)
J=$(git -C "$S" rev-parse --show-toplevel)

# --- sisävaihe: simulaattorilukon alla (käännös + kolme vaihetta); ympäristön antaa ulkoinen osa ---
if [ "${1:-}" = "--sim-sisalla" ]; then
  set +e
  cd "$J/scopes2/ios" || exit 1
  raja() { perl -e 'alarm shift; exec @ARGV' "$@"; }
  p_alku() { # P taustalle
    node "$S/valitys.mjs" "$P_PORTTI" "$koe_portti" >> "$T/valitys.log" 2>&1 &
    echo $! > "$T/p.pid"
    local i; for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -m 2 "http://127.0.0.1:$P_PORTTI/api/terveys" >/dev/null 2>&1 && return 0; sleep 0.5; done
    return 1
  }
  p_loppu() {
    local pid; pid=$(cat "$T/p.pid" 2>/dev/null)
    [ -n "$pid" ] && { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; }
    rm -f "$T/p.pid"
  }
  vaihe_aja() { # <n> <aikaraja s> [lisä-env...]
    local n=$1 tmo=$2; shift 2
    : > "$T/vaihe$n.txt"
    echo "--- vaihe $n alku $(date '+%H:%M:%S')"
    ( export TEST_RUNNER_T59_VAIHE=$n TEST_RUNNER_T59_DATA="$T/data" TEST_RUNNER_T59_ULOS="$T" TEST_RUNNER_T59_S2="$S2_SKOOPPI" \
             TEST_RUNNER_SCOPES2_VERTAINEN="http://127.0.0.1:$P_PORTTI" "$@"
      TEST_RUNNER_SCOPES2_AVAIN=$(cat "$avain_tiedosto"); export TEST_RUNNER_SCOPES2_AVAIN
      rm -rf "build/t59-vaihe$n.xcresult"
      raja "$tmo" xcodebuild test-without-building -project ScopesV2.xcodeproj -scheme ScopesV2 \
        -destination "platform=iOS Simulator,name=$SIM" CODE_SIGNING_ALLOWED=NO -derivedDataPath build \
        -only-testing:"ScopesV2UITests/T59UITests/testVaihe$n" -collect-test-diagnostics never \
        -resultBundlePath "build/t59-vaihe$n.xcresult" ) > "$T/xcodebuild-vaihe$n.log" 2>&1
    local rc=$?
    echo "--- vaihe $n loppu $(date '+%H:%M:%S') exit $rc"
    xcrun xcresulttool get test-results summary --path "build/t59-vaihe$n.xcresult" --compact 2>/dev/null | head -c 3000 > "$T/yhteenveto-vaihe$n.json"
    xcrun xcresulttool get test-results tests --path "build/t59-vaihe$n.xcresult" --compact 2>/dev/null | head -c 6000 > "$T/testit-vaihe$n.json"
    xcrun simctl terminate "$SIM" com.example.scopes-v2 >/dev/null 2>&1
    return $rc
  }
  echo "SIMULAATTORI: $SIM"
  vaihe_nimi="xcodegen + build-for-testing (rakennuslukko)"; echo "--- $vaihe_nimi $(date '+%H:%M:%S')"
  xcodegen -q > "$T/xcodegen.log" 2>&1 || { echo "FAIL: xcodegen (loki $T/xcodegen.log)"; exit 1; }
  lockf -t 1800 "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus/.lukko" perl -e 'alarm shift; exec @ARGV' 1500 \
    xcodebuild build-for-testing -project ScopesV2.xcodeproj -scheme ScopesV2 -destination "platform=iOS Simulator,name=$SIM" \
    CODE_SIGNING_ALLOWED=NO -derivedDataPath build > "$T/build.log" 2>&1
  rc=$?; echo "build exit $rc ($(tail -1 "$T/build.log" | head -c 120))"
  [ $rc = 0 ] || exit 1
  rm -rf "$T/data"; mkdir -p "$T/data"

  # vaihe 1: P auki
  p_alku || { echo "FAIL: P ei käynnisty"; exit 1; }
  vaihe_aja 1 900; r1=$?
  maara1=$(sed -n 's/^test_viesteja=//p' "$T/vaihe1.txt" | tail -1)
  # P pois: todistus
  p_loppu; sleep 1
  curl -sS -m 3 -o /dev/null "http://127.0.0.1:$P_PORTTI/api/terveys" 2>/dev/null; echo "$?" > "$T/curl-p-kiinni.txt"
  echo "P kiinni: curl exit $(cat "$T/curl-p-kiinni.txt") (odotus 7)"
  # vaihe 2: P kiinni jo käynnistyessä
  vaihe_aja 2 900 TEST_RUNNER_T59_TEST_MAARA="${maara1:-}"; r2=$?
  # vaihe 3: P auki käynnistyessä; testi pyytää sulkemaan sen kesken ajon (tiedostokättely)
  p_alku
  rm -f "$T/p-kiinni.pyynto" "$T/p-kiinni.valmis"
  ( while [ ! -e "$T/vaihe3-valmis" ]; do
      if [ -e "$T/p-kiinni.pyynto" ] && [ ! -e "$T/p-kiinni.valmis" ]; then p_loppu; sleep 1; curl -sS -m 3 -o /dev/null "http://127.0.0.1:$P_PORTTI/api/terveys" 2>/dev/null; echo "$?" > "$T/curl-p-kiinni3.txt"; touch "$T/p-kiinni.valmis"; fi
      sleep 0.5
    done ) &
  vahti3=$!
  vaihe_aja 3 900; r3=$?
  touch "$T/vaihe3-valmis"; wait "$vahti3" 2>/dev/null
  echo "P kiinni vaiheessa 3: curl exit $(cat "$T/curl-p-kiinni3.txt" 2>/dev/null) (odotus 7)"
  # vaihe 4: P takaisin, kylmäkäynnistys (vanha P pois, jos vaihe 3 kaatui ennen sulkemista)
  p_loppu; sleep 1; p_alku; curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$P_PORTTI/api/terveys" 2>/dev/null; echo "$?" > "$T/curl-p-auki.txt"
  echo "P auki: curl exit $(cat "$T/curl-p-auki.txt") (odotus 0)"
  vaihe_aja 4 900; r4=$?
  p_loppu
  echo "$r1 $r2 $r3 $r4" > "$T/vaiheiden-exit.txt"
  exit 0
fi

# --- ulompi osa ---
T=${T59_ULOS:-$(mktemp -d /tmp/t59.XXXXXX)}
mkdir -p "$T"
echo "TULOKSET: $T"
echo "=== T-59 alku $(date '+%d.%m.%Y %H:%M:%S') (työpuu $J)"
GATE_AJO=T-59-sim
sed -e "s|^tama=.*|tama='$J/scopes2/shared'|" -e '/^id=\${1:-}$/,$d' "$J/scopes2/shared/gate.sh" > "$T/gate-funktiot.sh"
# shellcheck disable=SC1091
source "$T/gate-funktiot.sh"
set +e +u
tulos=0
alkusekunnit=$SECONDS

siivoa() {
  local pid
  pid=$(cat "$T/p.pid" 2>/dev/null); [ -n "$pid" ] && kill "$pid" 2>/dev/null
  xcrun simctl terminate "${SIM_NIMI:-iPhone 15 Pro}" com.example.scopes-v2 >/dev/null 2>&1
  [ -n "${vahti_pid:-}" ] && kill "$vahti_pid" 2>/dev/null
  koeydin_loppu
  rm -rf "$T/data" "$T/siemen-otsikko"
  mac_lukko_vapauta
}
trap siivoa EXIT
trap 'siivoa; exit 130' INT TERM
# kokonaisaikaraja 30 min
( sleep 1800; echo "T59: kokonaisaikaraja 30 min täyttyi" >&2; kill -TERM $$ ) &
vahti_pid=$!

lukko || { echo "T59: lukko varattu"; exit 3; }
mac_lukko_ota || { echo "T59: Mac-lukko ei vapaa"; exit 3; }
case "$mac_portti" in 8797|18797) echo "T59: kielletty portti $mac_portti"; exit 1 ;; esac
koeydin_rakenna || { echo "T59: koeytimen käännös epäonnistui"; exit 1; }
# Äpin sisäinen ydin = ydin/apple/ScopesSolmu.xcframework; vanhentunut XCFramework antoi ajossa 8 koon "–" ja VANHAn tunneli kiinni.
xcframework_varmista || { echo "T59: XCFrameworkin käännös epäonnistui"; exit 1; }
echo "XCFRAMEWORK: $(stat -f '%Sm' -t '%d.%m. %H.%M' "$J/scopes2/ydin/apple/ScopesSolmu.xcframework")"
koeydin_kaynnista || { echo "T59: koeydin ei käynnistynyt"; exit 1; }
echo "KOEDATA: $koe_dir"
P_PORTTI=$((mac_portti + 200))
case "$P_PORTTI" in 8797|18797) echo "T59: kielletty portti"; exit 1 ;; esac
portti_kuuntelee "$P_PORTTI" && { echo "T59: P-portti $P_PORTTI varattu"; exit 1; }

# --- siemen ---
(umask 077; printf 'Authorization: Bearer %s\n' "$(cat "$avain_tiedosto")" > "$T/siemen-otsikko")
kcurl() { curl -fsS -m 30 -H "@$T/siemen-otsikko" "$@"; }
lista=""; ok=0; loppu=$((SECONDS + 120))
while [ "$SECONDS" -lt "$loppu" ]; do
  if lista=$(kcurl "http://127.0.0.1:$koe_portti/api/skoopit" 2>/dev/null) && [ -n "$(printf '%s' "$lista" | jq -r '.[0].nimi // empty' 2>/dev/null)" ]; then ok=1; break; fi
  sleep 3
done
[ "$ok" = 1 ] || { echo "T59: sillan skooppilista ei vastaa"; exit 1; }
# S2:n skooppi: listan viimeinen, jonka nimessä ei ole "test" eikä erikoismerkkejä (S2 ei saa näkyä listan alussa vaiheessa 1)
S2_SKOOPPI=$(printf '%s' "$lista" | jq -r '.[].nimi' | grep -Ev 'test' | grep -E '^[A-Za-z0-9._-]+$' | tail -1)
[ -n "$S2_SKOOPPI" ] || { echo "T59: S2:lle ei löytynyt skooppia"; exit 1; }
echo "S2-SKOOPPI: $S2_SKOOPPI (sillan listalla $(printf '%s' "$lista" | jq 'length') skooppia)"
node "$S/siemen.mjs" "$T" "$S2_SKOOPPI" "$J/scopes2/shared/testidata" || { echo "T59: siemen.mjs epäonnistui"; exit 1; }
posti() { kcurl -o /dev/null -H 'Content-Type: application/json' --data-binary "@$T/$2" "http://127.0.0.1:$koe_portti$1"; }
posti /api/lahde/istunnot istunnot.json && posti /api/lahde/agy agy.json \
  && posti /api/peili peili-s1.json && posti /api/peili peili-s2a.json && posti /api/peili peili-s2b.json \
  || { echo "T59: siemenen POST epäonnistui"; exit 1; }
n_viestit() { kcurl "http://127.0.0.1:$koe_portti/api/skoopit/$1/viestit" 2>/dev/null | jq '.viestit | length' 2>/dev/null; }
for _i in 1 2 3 4 5 6 7 8 9 10; do
  nt=$(n_viestit test); n2=$(n_viestit "$S2_SKOOPPI"); [ "${nt:-0}" -ge 1 ] && [ "${n2:-0}" -ge 8 ] && break; sleep 2
done
echo "SIEMEN (A): test $nt viestiä, $S2_SKOOPPI $n2 viestiä (odotus S2: 8)"
[ "${n2:-0}" -ge 8 ] || { echo "T59: S2 ei näy koeytimessä 8 viestinä"; exit 1; }

# --- simulaattorivaihe lukon alla ---
export T J S2_SKOOPPI P_PORTTI koe_portti avain_tiedosto
simlukko=$(sim_lukossa "bash '$S/t59.sh' --sim-sisalla")
mac "$simlukko"
rc=$?
echo "simulaattorivaihe exit $rc"

# --- tulokset ---
tark() { # <nimi> <0|muu> <selite>
  if [ "$2" = 0 ]; then echo "T59 $1: OK — $3"; else echo "T59 $1: PUNAINEN — $3"; tulos=1; fi
}
arvo() { sed -n "s/^$2=//p" "$T/vaihe$1.txt" 2>/dev/null | tail -1; }
read -r e1 e2 e3 e4 < "$T/vaiheiden-exit.txt" 2>/dev/null || { e1=?; e2=?; e3=?; e4=?; tulos=1; }
[ "$rc" = 0 ] || tulos=1
a_alku=$(arvo 1 a_alku); a_loppu=$(arvo 1 a_loppu)
koko_mt=$(printf '%s' "$a_loppu" | sed -n 's/.*koko=\([0-9.,]*\) Mt \/ \([0-9.]*\) Mt.*/\1 \2/p' | tr ',' '.')
a_ok=1
if [ -n "$koko_mt" ]; then set -- $koko_mt; awk -v a="$1" -v b="$2" 'BEGIN{exit !(a<=b)}' && a_ok=0; fi
[ "$e1" = 0 ] || a_ok=1
tark "(a) asetusnäkymän koko" $a_ok "alku [$a_alku]; replikoinnin jälkeen [$a_loppu]; vaihe 1 exit $e1"
t1=$(arvo 1 test_viesteja); t2=$(arvo 2 test_viesteja)
b_ok=1
[ "$e2" = 0 ] && [ "$e3" = 0 ] && [ -n "$t1" ] && [ "$t1" = "$t2" ] && [ "$t1" -ge 1 ] 2>/dev/null && [ "$(arvo 3 s2_vanha_nakyy)" = ei ] && b_ok=0
tark "(b) tunneli suljettuna (curl P exit $(cat "$T/curl-p-kiinni.txt" 2>/dev/null) kylmäkäynnistyksessä, $(cat "$T/curl-p-kiinni3.txt" 2>/dev/null) kesken ajon)" $b_ok "test-viestejä vaihe 1: ${t1:-?}, vaihe 2 (P kiinni, palautettu valinta: $(arvo 2 palautettu_valinta)): ${t2:-?}; skooppilista kylmäkäynnistyksessä: $(arvo 2 lista_otsikko | tail -1); S2 ($S2_SKOOPPI) vaihe 3: viestejä $(arvo 3 s2_viesteja), haettavissa-rivi $(arvo 3 s2_haettavissa), VANHA näkyy $(arvo 3 s2_vanha_nakyy), TUORE näkyy $(arvo 3 s2_tuore_nakyy); vaiheet exit $e2 $e3"
c_ok=1
[ "$e4" = 0 ] && [ "$(arvo 4 s2_vanha_nakyy)" = kylla ] && [ "$(arvo 4 s2_tuore_nakyy)" = kylla ] && [ "$(arvo 4 s2_haettavissa)" = ei ] && c_ok=0
tark "(c) tunneli palannut (curl P exit $(cat "$T/curl-p-auki.txt" 2>/dev/null))" $c_ok "S2 ($S2_SKOOPPI) viestejä: $(arvo 4 s2_viesteja), VANHA näkyy $(arvo 4 s2_vanha_kesto_s) s käynnistyksestä: $(arvo 4 s2_vanha_nakyy), TUORE näkyy: $(arvo 4 s2_tuore_nakyy), haettavissa-rivi: $(arvo 4 s2_haettavissa); vaihe 4 exit $e4"
[ "$(cat "$T/curl-p-kiinni.txt" 2>/dev/null)" = 7 ]; tark "P kiinni todistus" $? "curl exit $(cat "$T/curl-p-kiinni.txt" 2>/dev/null), odotus 7"
echo "=== T-59 loppu $(date '+%d.%m.%Y %H:%M:%S'), kesto $((SECONDS - alkusekunnit)) s"
if [ "$tulos" = 0 ]; then echo "T59 VIHREÄ"; exit 0; else echo "T59 PUNAINEN"; exit 1; fi
