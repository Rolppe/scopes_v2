#!/usr/bin/env bash
# T-51 valvojan ajo (ARK-08 hyväksyntä), scopes2 ios -istunto 20.10.2026. Käyttää gate.sh:n koeydin-, silta-, lukko- ja
# UI-testifunktioita (lähdekoodattuna ilman pääosaa); koeydin, silta ja käynnistetyt äpit suljetaan trapilla.
# Käyttö Macilla: bash scopes2/ios/testit/t51/t51.sh > loki 2>&1 (tulostiedostot hakemistoon $T51_ULOS, oletus mktemp).
# Ensimmäinen ajo 20.10.2026 21.28: 8/9 OK, Mac-rinnakkain punainen (vanha ScopesMac kaatuu, V-628).
S=$(cd "$(dirname "$0")" && pwd)
T=${T51_ULOS:-$(mktemp -d /tmp/t51.XXXXXX)}
echo "TULOKSET: $T"
J="${MAC_PROJ:-$HOME/Projects}/claude/sessions-repo"
SIM=ACB1207B-69AA-48FA-98A6-3001A9D1F91D
sed -e "s|^tama=.*|tama='$J/scopes2/shared'|" -e '/^id=\${1:-}$/,$d' "$J/scopes2/shared/gate.sh" > "$T/gate-funktiot.sh"
# shellcheck disable=SC1091
source "$T/gate-funktiot.sh"
set +e
tulos=0
tark() { # <nimi> <0|muu> <selite>
  if [ "$2" = 0 ]; then echo "T51 $1: OK — $3"; else echo "T51 $1: PUNAINEN — $3"; tulos=1; fi
}
terveys_8787() { ssh -o BatchMode=yes -o ConnectTimeout=10 palvelin 'curl -s -m 5 -o /dev/null -w "%{http_code}" 127.0.0.1:8787/api/terveys' </dev/null; }

naytteet_pid=""; vanha_mac_pid=""; v2_mac_pid=""
siivoa() {
  [ -n "$naytteet_pid" ] && kill "$naytteet_pid" 2>/dev/null
  [ -n "$v2_mac_pid" ] && kill "$v2_mac_pid" 2>/dev/null
  [ -n "$vanha_mac_pid" ] && kill "$vanha_mac_pid" 2>/dev/null
  xcrun simctl terminate "$SIM" com.example.scopes-v2 >/dev/null 2>&1
  puhdista
  naytteet_pid=""; v2_mac_pid=""; vanha_mac_pid=""
}

echo "=== T-51 alku $(date '+%d.%m.%Y %H:%M:%S')"
git -C "$J" status --porcelain -- scopes/ | LC_ALL=C sort > "$T/scopes-ennen.txt"
e=$(terveys_8787); [ "$e" = 200 ]; tark "8787-ennen" $? "HTTP $e"

lukko || { echo "T51: lukko varattu"; exit 3; }
trap siivoa EXIT
trap 'siivoa; exit 130' INT TERM
mac_lukko_ota || { echo "T51: Mac-lukko ei vapaa"; exit 3; }
koeydin_alku || { echo "T51: koeydin ei käynnistynyt"; exit 1; }
echo "KOEDATA: $koe_dir"

# Muistihuippu: Macissa ei /proc/<pid>/status VmHWM:ää; ps -o rss= (KiB) 0,5 s välein koko ajon ajan, huippu = maksimi.
( while kill -0 "$koe_pid" 2>/dev/null; do echo "$(date +%H:%M:%S) $(ps -o rss= -p "$koe_pid" | tr -d ' ')"; sleep 0.5; done ) > "$T/rss.txt" &
naytteet_pid=$!

# 1) macOS UI-testit koeydintä vasten (lista, viestit, liite, bundle-id); LIITE-rivi xcresultin action-lokista
vaihe "macOS UI-testit"
mac_avain "cd \"\$RAK/macos\" && $(xtesti xmac)" > "$T/xmac.log" 2>&1; rc=$?
tark "macOS-UI" $rc "xcodebuild test exit $rc ($(xcrun xcresulttool get test-results summary --path "$J/scopes2/macos/build/viimeisin-testi.xcresult" 2>/dev/null | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("pass",d.get("passedTests"),"fail",d.get("failedTests"),"skip",d.get("skippedTests"))'))"
liite=$(xcrun xcresulttool get log --path "$J/scopes2/macos/build/viimeisin-testi.xcresult" --type action 2>/dev/null | grep -oE 'LIITE: [0-9a-f]{64} [^ "\\]+' | tail -1)
echo "$liite"
lsha=$(echo "$liite" | awk '{print $2}'); lpolku=$(echo "$liite" | awk '{print $3}')
case "$lpolku" in "$koe_dir"/data/liitteet/*|/private"$koe_dir"/data/liitteet/*) polku_ok=0 ;; *) polku_ok=1 ;; esac
tiedosto="$koe_dir/data/liitteet/${lpolku##*/data/liitteet/}"
if [ -n "$lsha" ] && [ "$polku_ok" = 0 ] && [ -f "$tiedosto" ]; then
  fsha=$(shasum -a 256 "$tiedosto" | awk '{print $1}')
  [ "$fsha" = "$lsha" ]; tark "liite-sha256" $? "LIITE $lsha, tiedosto koeytimen datassa $fsha (${tiedosto#$koe_dir/})"
else
  tark "liite-sha256" 1 "LIITE-rivi '${liite:-puuttuu}', polku koeytimen datassa: $([ "$polku_ok" = 0 ] && echo kyllä || echo ei), tiedosto: $([ -f "$tiedosto" ] && echo on || echo puuttuu)"
fi
find "$koe_dir/data/liitteet" -type f 2>/dev/null | sed "s|^$koe_dir/||" > "$T/liitteet.txt"

# 2) Neljä äppiä yhtä aikaa: vanha Mac (DerivedData, ad-hoc) ja V2 Mac koeytimeen; vanha ja V2 simulaattorissa
VANHA_MAC=$(ls -td ~/Library/Developer/Xcode/DerivedData/ScopesMac-*/Build/Products/Debug/ScopesMac.app | head -1)
V2_MAC="$J/scopes2/macos/build/Build/Products/Debug/ScopesV2Mac.app"
echo "VANHA MAC: $VANHA_MAC (käännetty $(stat -f '%Sm' "$VANHA_MAC/Contents/MacOS/ScopesMac"), $(codesign -dv "$VANHA_MAC" 2>&1 | grep -E '^Signature' ))"
echo "V2 MAC: $V2_MAC ($(codesign -dv "$V2_MAC" 2>&1 | grep -E '^Signature'))"
mkdir -p "$koe_dir/mac-data" "$koe_dir/ios-data"
K=$(cat "$avain_tiedosto")
"$VANHA_MAC/Contents/MacOS/ScopesMac" >/dev/null 2>&1 & vanha_mac_pid=$!
SCOPES2_AVAIN="$K" SCOPES2_VERTAINEN=http://127.0.0.1:18797 SCOPES2_DATA="$koe_dir/mac-data" \
  "$V2_MAC/Contents/MacOS/ScopesV2Mac" >/dev/null 2>&1 & v2_mac_pid=$!
xcrun simctl launch "$SIM" com.example.skoopit >/dev/null 2>&1
SIMCTL_CHILD_SCOPES2_AVAIN="$K" SIMCTL_CHILD_SCOPES2_VERTAINEN=http://127.0.0.1:18797 SIMCTL_CHILD_SCOPES2_DATA="$koe_dir/ios-data" \
  xcrun simctl launch "$SIM" com.example.scopes-v2 >/dev/null 2>&1
unset K
sleep 25
v2_ios_pid=$(pgrep -f 'ScopesV2.app/ScopesV2$' | head -1); vanha_ios_pid=$(pgrep -f 'Skoopit.app/Skoopit$' | head -1)
kaynnissa=0; for p in "$vanha_mac_pid" "$v2_mac_pid" "$vanha_ios_pid" "$v2_ios_pid"; do [ -n "$p" ] && kill -0 "$p" 2>/dev/null || kaynnissa=1; done
yhteys_mac=$(lsof -nP -a -p "$v2_mac_pid" -iTCP:18797 2>/dev/null | grep -c ESTABLISHED)
yhteys_ios=$( [ -n "$v2_ios_pid" ] && lsof -nP -a -p "$v2_ios_pid" -iTCP:18797 2>/dev/null | grep -c ESTABLISHED)
tark "rinnakkain" $kaynnissa "vanha Mac pid ${vanha_mac_pid:-?}, V2 Mac pid ${v2_mac_pid:-?} (18797-yhteyksiä $yhteys_mac), vanha iOS pid ${vanha_ios_pid:-?}, V2 iOS pid ${v2_ios_pid:-?} (18797-yhteyksiä ${yhteys_ios:-0})"

# 3) API: koeytimen lista = 8787:n lista (nimi, tila, seuraava); kahden skoopin viestit (liukuva 120:n ikkuna)
(umask 077; printf 'Authorization: Bearer %s\n' "$(cat "$avain_tiedosto")" > "$koe_dir/h-koe"; printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$koe_dir/vanha-avain")" > "$koe_dir/h-vanha")
hae() { curl -s -m 60 -H @"$koe_dir/$1" "http://127.0.0.1:$2$3"; }
hae h-vanha 18787 /api/skoopit > "$T/vanha-skoopit.json"
hae h-koe 18797 /api/skoopit > "$T/v2-skoopit.json"
hae h-vanha 18787 /api/skoopit > "$T/vanha-skoopit-2.json"
python3 -I "$S/vertaa.py" lista "$T/vanha-skoopit.json" "$T/v2-skoopit.json" "$T/vanha-skoopit-2.json"; tark "lista (API)" $? "koeydin /api/skoopit vs 8787 (nimi, tila, seuraava)"
kaksi=$(python3 -I "$S/vertaa.py" valitse "$T/vanha-skoopit.json" | head -2)
i=0
while IFS= read -r s; do
  i=$((i + 1)); k=$(python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$s")
  hae h-vanha 18787 "/api/skoopit/$k/viestit" > "$T/viestit-$i-vanha-1.json"
  hae h-koe 18797 "/api/skoopit/$k/viestit" > "$T/viestit-$i-v2.json"
  hae h-vanha 18787 "/api/skoopit/$k/viestit" > "$T/viestit-$i-vanha-2.json"
  python3 -I "$S/vertaa.py" viestit "$T/viestit-$i-vanha-1.json" "$T/viestit-$i-v2.json" "$T/viestit-$i-vanha-2.json"; tark "viestit $s" $? "koeydin vs 8787 ennen+jälkeen"
done <<< "$kaksi"

# 4) 8787 jälkeen, muistihuippu, scopes/-puu
e=$(terveys_8787); [ "$e" = 200 ]; tark "8787-jälkeen" $? "HTTP $e"
kill "$naytteet_pid" 2>/dev/null; naytteet_pid=""
huippu=$(awk '$2>m{m=$2} END{print m+0}' "$T/rss.txt"); n=$(wc -l < "$T/rss.txt" | tr -d ' ')
[ "$huippu" -gt 0 ] && [ "$huippu" -lt 524288 ]; tark "muistihuippu" $? "koeytimen RSS-huippu $((huippu / 1024)) MiB ($huippu KiB), $n näytettä 0,5 s välein (ps -o rss=), raja 512 MiB"
git -C "$J" status --porcelain -- scopes/ | LC_ALL=C sort > "$T/scopes-jalkeen.txt"
uudet=$(LC_ALL=C comm -13 "$T/scopes-ennen.txt" "$T/scopes-jalkeen.txt")
[ -z "$uudet" ]; tark "scopes-puu" $? "git status -- scopes/: ${uudet:-ei uusia rivejä}"

# 5) siivous ja jälkitarkistus
kd="$koe_dir"; kp="$koe_pid"
siivoa; trap - EXIT INT TERM
sleep 2
jalki=0
lsof -nP -iTCP:18797 -sTCP:LISTEN >/dev/null 2>&1 && jalki=1
lsof -nP -iTCP:18787 -sTCP:LISTEN >/dev/null 2>&1 && jalki=1
[ -e "$kd" ] && jalki=1
kill -0 "$kp" 2>/dev/null && jalki=1
pgrep -f 'ScopesV2Mac.app/Contents/MacOS' >/dev/null && jalki=1
tark "jälkitila" $jalki "18797 ja 18787 eivät kuuntele, koedata poistettu ($kd), koeydin pid $kp ei käynnissä, V2 Mac suljettu"
echo "=== T-51 loppu $(date '+%d.%m.%Y %H:%M:%S'): $([ $tulos = 0 ] && echo VIHREÄ || echo PUNAINEN)"
exit $tulos
