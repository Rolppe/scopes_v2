#!/usr/bin/env bash
# T-51 tarkistus 4 (Mac-rinnakkain, ARK-08:n viimeinen osa), scopes2 ios -istunto 20.10.2026: koeydin + V2 Mac + vanha Mac
# yhtä aikaa. Sama koeydin, silta ja lukko kuin t51.sh:ssa (gate.sh:n funktiot); ei UI-testejä, ei simulaattoria.
# Käyttö Macilla: VANHA_MAC=<ScopesMac.app d14a726e:stä tai uudemmasta> bash scopes2/ios/testit/t51/t51-mac.sh > loki 2>&1
S=$(cd "$(dirname "$0")" && pwd)
T=${T51_ULOS:-$(mktemp -d /tmp/t51mac.XXXXXX)}
echo "TULOKSET: $T"
J="${MAC_PROJ:-$HOME/Projects}/claude/sessions-repo"
[ -n "${VANHA_MAC:-}" ] && [ -x "$VANHA_MAC/Contents/MacOS/ScopesMac" ] || { echo "T51: VANHA_MAC puuttuu"; exit 3; }
sed -e "s|^tama=.*|tama='$J/scopes2/shared'|" -e '/^id=\${1:-}$/,$d' "$J/scopes2/shared/gate.sh" > "$T/gate-funktiot.sh"
# shellcheck disable=SC1091
source "$T/gate-funktiot.sh"
set +e
tulos=0
tark() { # <nimi> <0|muu> <selite>
  if [ "$2" = 0 ]; then echo "T51 $1: OK — $3"; else echo "T51 $1: PUNAINEN — $3"; tulos=1; fi
}
# Palvelimen paikallinen vasteaika (s): "<http-koodi> <time_total>"
terveys_8787() { ssh -o BatchMode=yes -o ConnectTimeout=10 palvelin 'curl -s -m 5 -o /dev/null -w "%{http_code} %{time_total}" 127.0.0.1:8787/api/terveys' </dev/null; }
terveys_3() { # <nimi>
  local i r ok=0 rivit=""
  for i in 1 2 3; do
    r=$(terveys_8787); rivit="$rivit${rivit:+, }$r"
    awk -v r="$r" 'BEGIN{split(r,a," "); exit !(a[1]==200 && a[2]+0<1)}' || ok=1
  done
  tark "$1" $ok "3 × /api/terveys (HTTP aika_s): $rivit; raja 200 ja < 1 s"
}

naytteet_pid=""; vanha_mac_pid=""; v2_mac_pid=""
siivoa() {
  [ -n "$naytteet_pid" ] && kill "$naytteet_pid" 2>/dev/null
  [ -n "$v2_mac_pid" ] && kill "$v2_mac_pid" 2>/dev/null
  [ -n "$vanha_mac_pid" ] && kill "$vanha_mac_pid" 2>/dev/null
  puhdista
  naytteet_pid=""; v2_mac_pid=""; vanha_mac_pid=""
}

echo "=== T-51 Mac-rinnakkain alku $(date '+%d.%m.%Y %H:%M:%S'), HEAD $(git -C "$J" rev-parse --short HEAD)"
git -C "$J" status --porcelain -- scopes/ | LC_ALL=C sort > "$T/scopes-ennen.txt"
touch "$T/alku"
terveys_3 "8787-ennen"
[ "$tulos" = 0 ] || { echo "=== T-51 Mac-rinnakkain: 8787 ei terve, ei ajeta"; exit 1; }

lukko || { echo "T51: lukko varattu"; exit 3; }
trap siivoa EXIT
trap 'siivoa; exit 130' INT TERM
mac_lukko_ota || { echo "T51: Mac-lukko ei vapaa"; exit 3; }
koeydin_alku || { echo "T51: koeydin ei käynnistynyt"; exit 1; }
echo "KOEDATA: $koe_dir"

( while kill -0 "$koe_pid" 2>/dev/null; do echo "$(date +%H:%M:%S) $(ps -o rss= -p "$koe_pid" | tr -d ' ')"; sleep 0.5; done ) > "$T/rss.txt" &
naytteet_pid=$!

V2_MAC="$J/scopes2/macos/build/Build/Products/Debug/ScopesV2Mac.app"
echo "VANHA MAC: $VANHA_MAC (käännetty $(stat -f '%Sm' "$VANHA_MAC/Contents/MacOS/ScopesMac"), $(codesign -dv "$VANHA_MAC" 2>&1 | grep -E '^Signature'))"
echo "V2 MAC: $V2_MAC (käännetty $(stat -f '%Sm' "$V2_MAC/Contents/MacOS/ScopesV2Mac"), $(codesign -dv "$V2_MAC" 2>&1 | grep -E '^Signature'))"
mkdir -p "$koe_dir/mac-data"
K=$(cat "$avain_tiedosto")
"$VANHA_MAC/Contents/MacOS/ScopesMac" > "$T/vanha-mac.log" 2>&1 & vanha_mac_pid=$!
SCOPES2_AVAIN="$K" SCOPES2_VERTAINEN=http://127.0.0.1:18797 SCOPES2_DATA="$koe_dir/mac-data" \
  "$V2_MAC/Contents/MacOS/ScopesV2Mac" > "$T/v2-mac.log" 2>&1 & v2_mac_pid=$!
unset K
# 25 s kuten t51.sh; vanha kaatui V-628:ssa 4 s:ssa. Toinen näyte 60 s:ssa.
for s in 25 60; do
  sleep $((s == 25 ? 25 : 35))
  kaynnissa=0
  kill -0 "$vanha_mac_pid" 2>/dev/null || kaynnissa=1
  kill -0 "$v2_mac_pid" 2>/dev/null || kaynnissa=1
  yhteys_mac=$(lsof -nP -a -p "$v2_mac_pid" -iTCP:18797 2>/dev/null | grep -c ESTABLISHED)
  [ "$yhteys_mac" -gt 0 ] || kaynnissa=1
  tark "rinnakkain-${s}s" $kaynnissa "vanha Mac pid $vanha_mac_pid $(kill -0 "$vanha_mac_pid" 2>/dev/null && echo käynnissä || echo KUOLLUT), V2 Mac pid $v2_mac_pid $(kill -0 "$v2_mac_pid" 2>/dev/null && echo käynnissä || echo KUOLLUT) (18797-yhteyksiä $yhteys_mac), koeydin pid $koe_pid"
done
kaatumat=$(find "$HOME/Library/Logs/DiagnosticReports" -newer "$T/alku" \( -name 'ScopesMac*' -o -name 'ScopesV2Mac*' \) 2>/dev/null)
[ -z "$kaatumat" ]; tark "kaatumisraportit" $? "${kaatumat:-ei uusia ScopesMac- eikä ScopesV2Mac-raportteja}"

terveys_3 "8787-jälkeen"
kill "$naytteet_pid" 2>/dev/null; naytteet_pid=""
huippu=$(awk '$2>m{m=$2} END{print m+0}' "$T/rss.txt"); n=$(wc -l < "$T/rss.txt" | tr -d ' ')
[ "$huippu" -gt 0 ] && [ "$huippu" -lt 524288 ]; tark "muistihuippu" $? "koeytimen RSS-huippu $((huippu / 1024)) MiB, $n näytettä 0,5 s välein, raja 512 MiB"
git -C "$J" status --porcelain -- scopes/ | LC_ALL=C sort > "$T/scopes-jalkeen.txt"
uudet=$(LC_ALL=C comm -13 "$T/scopes-ennen.txt" "$T/scopes-jalkeen.txt")
[ -z "$uudet" ]; tark "scopes-puu" $? "git status -- scopes/: ${uudet:-ei uusia rivejä}"

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
echo "=== T-51 Mac-rinnakkain loppu $(date '+%d.%m.%Y %H:%M:%S'): $([ $tulos = 0 ] && echo VIHREÄ || echo PUNAINEN)"
exit $tulos
