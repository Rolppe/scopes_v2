#!/bin/bash
# scopes-V2: käännä, allekirjoita ja asenna iPhoneen (H-17, IOS-H17 21.10.2026). Sama asennustapa kuin vanhalla Skoopitilla
# (scopes/ios/mac/skoopit-asennus.sh, käyttäjä 21.10.2026: "Samaa asennustapaa käytetään"): xcodegen + xcodebuild
# -allowProvisioningUpdates + devicectl install. 7 pv uusinta GUI-istunnon LaunchAgentissa (com.example.scopes-v2-asennus):
# agentti herää 30 min välein; alle 48 h jäljellä → profiili sivuun, käännös ja asennus, uuden profiilin pitää vanheta myöhemmin.
# Puu on kopio $T:ssä (ios, shared, ydin/apple/ScopesSolmu.xcframework), ei repo: agentti ei koske työpuuhun.
# Käyttö: scopes-v2-asennus.sh --paivita <scopes2-hakemisto>  kopioi puu $T:hen (ilman build-hakemistoja)
#         scopes-v2-asennus.sh --suoraan  käännä ja asenna tässä prosessissa (istunto, jolla on pääsy avainnippuun)
#         scopes-v2-asennus.sh            käynnistä agentti, odota ≤ 540 s, tulosta loki, exit = agentin exit
#         scopes-v2-asennus.sh --uusi     sama, mutta pakota profiilin uusinta (exit 7 = ei uusiutunut, 8 = näyttö lukossa)
#         scopes-v2-asennus.sh --check    preflight-rivi ja H
#         scopes-v2-asennus.sh --agentti  (LaunchAgent) ajastettu päätös tai tilattu käännös ja asennus
set -u
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
T=${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-ios-asennus
LAITE=YOUR_DEVICE_UDID
LABEL=com.example.scopes-v2-asennus
APP=$T/ios/build-laite/Build/Products/Debug-iphoneos/ScopesV2.app
LOKI=$T/asennus.loki
TILA="${1:-}"
mkdir -p "$T"
loki() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOKI"; }
aloki() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$T/ajastus.loki"; }
valmis() { echo "valmis exit=$1" > "$T/tila"; exit "$1"; }
profexp() { security cms -D -i "$1" 2>/dev/null | plutil -extract ExpirationDate raw - 2>/dev/null; }
omapro() { security cms -D -i "$1" 2>/dev/null | plutil -extract Entitlements.application-identifier raw - 2>/dev/null \
  | grep -q '\.com\.example\.scopes-v2$'; }
laitetila() { xcrun devicectl list devices 2>/dev/null | grep "$LAITE" | sed "s/.*$LAITE (UDID) *//; s/  .*//"; }
kaynnissa() { launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -q 'state = running'; }
# Asennetun profiilin jäljellä olevat tunnit (H) ja vanhenemisaika epochina (VANH)
PROF=$T/asennettu.mobileprovision; [ -f "$PROF" ] || PROF=$APP/embedded.mobileprovision
NYT=$(date +%s); VANH=""; E=$(profexp "$PROF")
[ -n "$E" ] && VANH=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$E" +%s 2>/dev/null)
if [ -n "$VANH" ]; then H=$(( (VANH - NYT) / 3600 )); else H=0; VANH=$NYT; fi
ilmoita() {
  [ "$H" -lt 36 ] || return 0
  [ -f "$T/ilmoitus.stamp" ] && [ -n "$(find "$T/ilmoitus.stamp" -mmin -360 2>/dev/null)" ] && return 0
  osascript -e "display notification \"scopes-V2 vanhenee $(date -r "$VANH" '+%d.%m. %H.%M') — ${1:-Mac hereille, iPhone samaan verkkoon}\" with title \"scopes-V2\"" >/dev/null 2>&1
  touch "$T/ilmoitus.stamp"
}

if [ "$TILA" = "--paivita" ]; then
  L="${2:-}"
  [ -d "$L/ios" ] && [ -d "$L/shared" ] && [ -d "$L/ydin/apple/ScopesSolmu.xcframework" ] \
    || { echo "virhe: --paivita <scopes2-hakemisto> (ios, shared, ydin/apple/ScopesSolmu.xcframework)"; exit 3; }
  rm -rf "$T/ios/Sources" "$T/ios/UITests" "$T/shared/ScopesCore2" "$T/shared/ScopesUI2" "$T/ydin/apple"
  tar -C "$L" -cf - --exclude=build --exclude=build-laite --exclude=.build --exclude=DerivedData --exclude=testit/t51 \
    ios shared/ScopesCore2 shared/ScopesUI2 shared/testit ydin/apple | tar -C "$T" -xf - || { echo "virhe: kopio"; exit 3; }
  # LaunchAgent ajaa kopion $T:stä (plist), ei repon polkua
  cp "$L/ios/asennus/scopes-v2-asennus.sh" "$T/scopes-v2-asennus.sh" && chmod 755 "$T/scopes-v2-asennus.sh" || { echo "virhe: skriptin kopio"; exit 3; }
  echo "paivitetty: $T ← $L ($(git -C "$L" rev-parse --short HEAD 2>/dev/null || echo '?'))" | tee -a "$LOKI"
  exit 0
fi

if [ "$TILA" = "--check" ]; then
  XC=ei; [ -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ] && XC=on
  XG=ei; command -v xcodegen >/dev/null 2>&1 && XG=on
  PU=ei; [ -f "$T/ios/project.yml" ] && PU=on
  AG=ei; launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && AG=on
  LT=$(laitetila); [ -n "$LT" ] || LT=ei
  echo "preflight: xcode=$XC xcodegen=$XG puu=$PU agentti=$AG laite=$LT H=$H"
  [ "$XC" = on ] && [ "$XG" = on ] && [ "$PU" = on ]
  exit $?
fi

if [ "$TILA" = "--agentti" ] || [ "$TILA" = "--suoraan" ]; then
  LUKKO=$T/lukko
  [ -d "$LUKKO" ] && [ -n "$(find "$LUKKO" -maxdepth 0 -mmin +120 2>/dev/null)" ] && rmdir "$LUKKO"
  mkdir "$LUKKO" 2>/dev/null || { loki "ohitus: lukko varattu"; exit 0; }
  trap 'rmdir "$LUKKO" 2>/dev/null' EXIT
  LUKITTU=0
  ioreg -n Root -d1 -a 2>/dev/null | grep -A1 CGSSessionScreenIsLocked | grep -q '<true/>' && LUKITTU=1
  TILATTU=0; [ -e "$T/tilaus" ] && { rm -f "$T/tilaus"; TILATTU=1; }
  [ "$TILA" = "--suoraan" ] && TILATTU=1
  vi() { [ "$TILATTU" = 0 ] && ilmoita; return 0; }
  if [ "$TILATTU" = 0 ]; then
    [ "$H" -ge 48 ] && { aloki "ok H=$H"; valmis 0; }
    [ "$LUKITTU" = 1 ] && { ilmoita "avaa Macin näyttö"; aloki "lukittu H=$H"; valmis 0; }
    LT=$(laitetila)
    if [ "$LT" != connected ] && [ "$LT" != "available (paired)" ]; then
      ilmoita; aloki "laite poissa H=$H"; valmis 0
    fi
    aloki "uusinta H=$H"
  fi
  echo kaynnissa > "$T/tila"
  loki "aloitus ($TILA)"
  if [ "$TILATTU" = 1 ] && [ "$LUKITTU" = 1 ] && [ -e "$T/uusi" ]; then
    rm -f "$T/uusi"; loki "virhe: Macin näyttö lukossa"; valmis 8
  fi
  cd "$T/ios" || valmis 3
  A=$(date +%s)
  PP="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; SIVU=$T/vanhat-profiilit
  UUSINTA=0; VANHA=""; SIIRRA=0
  if [ -e "$T/uusi" ]; then
    rm -f "$T/uusi"; SIIRRA=1
    VANHA=$(profexp "$APP/embedded.mobileprovision")
  elif [ "$TILATTU" = 0 ]; then
    # Aiempi uusinta jäi asentamatta, jos PP:ssä on asennettua uudempi scopes-v2-profiili: ei siirretä sivuun
    VANHA=$(profexp "$PROF"); SIIRRA=1
    for p in "$PP"/*.mobileprovision; do
      omapro "$p" && E=$(profexp "$p") && [[ "$E" > "$VANHA" ]] && SIIRRA=0
    done
  fi
  if [ "$SIIRRA" = 1 ]; then
    UUSINTA=1
    rm -rf "$SIVU"; mkdir -p "$SIVU"
    for p in "$PP"/*.mobileprovision; do omapro "$p" && mv "$p" "$SIVU/"; done
  fi
  palauta() { [ "$UUSINTA" = 1 ] && mv -n "$SIVU"/*.mobileprovision "$PP"/ 2>/dev/null; return 0; }
  xcodegen -q > "$T/build.log" 2>&1 || { palauta; vi; loki "virhe: xcodegen"; valmis 1; }
  if ! xcodebuild build -project ScopesV2.xcodeproj -scheme ScopesV2 -destination "id=$LAITE" \
      -derivedDataPath build-laite -allowProvisioningUpdates -quiet >> "$T/build.log" 2>&1; then
    palauta; vi; loki "virhe: build"; valmis 1
  fi
  loki "build ok $(( $(date +%s) - A )) s"
  OK=0
  for n in 1 2 3; do
    if xcrun devicectl device install app --device "$LAITE" "$APP" >> "$T/build.log" 2>&1; then
      OK=1; break
    fi
    loki "install yritys $n epäonnistui"
    [ "$n" -lt 3 ] && sleep 15
  done
  [ "$OK" = 1 ] || { vi; loki "virhe: install"; valmis 2; }
  cp "$APP/embedded.mobileprovision" "$T/asennettu.mobileprovision"; rm -f "$T/ilmoitus.stamp"
  EXP=$(profexp "$APP/embedded.mobileprovision")
  if [ "$UUSINTA" = 1 ]; then
    if [ -z "$EXP" ] || [ -z "$VANHA" ] || ! [[ "$EXP" > "$VANHA" ]]; then
      vi; loki "virhe: profiili ei uusiutunut ($EXP)"; valmis 7
    fi
    loki "uusinta valmis profiili=$EXP"
  else
    loki "asennus valmis profiili=$EXP"
  fi
  valmis 0
fi

# Asiakas: odota, ettei ajastettu ajo ole käynnissä — kickstart ei käynnistä jo ajossa olevaa
i=0
while kaynnissa && [ $i -lt 100 ]; do sleep 3; i=$((i + 1)); done
rm -f "$T/tila"
[ "$TILA" = "--uusi" ] && touch "$T/uusi"
touch "$T/tilaus"
launchctl kickstart "gui/$(id -u)/$LABEL" || { echo "virhe: kickstart"; exit 3; }
i=0
while [ $i -lt 180 ]; do
  [ -f "$T/tila" ] && grep -q '^valmis' "$T/tila" && break
  sleep 3; i=$((i + 1))
done
if [ -f "$T/tila" ] && grep -q '^valmis' "$T/tila"; then
  awk '/ aloitus/ {b=""} {b = b $0 "\n"} END {printf "%s", b}' "$LOKI" 2>/dev/null
  exit "$(sed 's/.*exit=//' "$T/tila")"
fi
echo kesken; exit 4
