#!/usr/bin/env bash
# rakenna-xcframework.sh - rakentaa apple/ScopesSolmu.xcframework:n kolmelle kohteelle (T-46).
# Ajetaan Macilla ytimen juuressa ($MAC_PROJ/scopes_2/scopes2-rakennus/ydin). Kayttö: bash apple/rakenna-xcframework.sh
# Exit: 0 ok, 1 jokin kohde tai xcodebuild kaatui.
set -uo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
# rusqlite bundled kaantaa C-koodia: tarvitsee Xcoden clangin.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"

kansio="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$kansio" || exit 1

kohteet="aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin"
ulos="apple/ScopesSolmu.xcframework"
argit=()
for k in $kohteet; do
  echo "=== cargo build --release --lib --target $k ==="
  if ! cargo build --release --lib --target "$k"; then
    echo "VIRHE: kohde $k kaatui" >&2
    exit 1
  fi
  [ -f "target/$k/release/libscopes_ydin.a" ] || { echo "VIRHE: target/$k/release/libscopes_ydin.a puuttuu" >&2; exit 1; }
  argit+=(-library "target/$k/release/libscopes_ydin.a" -headers include)
done

rm -rf "$ulos"
if ! xcodebuild -create-xcframework "${argit[@]}" -output "$ulos"; then
  echo "VIRHE: xcodebuild -create-xcframework kaatui" >&2
  exit 1
fi
koko="$(du -sm "$ulos" | cut -f1)"
echo "XCFRAMEWORK: $kansio/$ulos $koko Mt"
