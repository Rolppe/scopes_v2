#!/usr/bin/env bash
# gate.sh - scopes2-web-asiakkaan verifiointiportti (T-38-G, ARK-10).
#   bash scopes2/web/gate.sh <ID>          ajaa ID:n testit ja aidat (ID ∈ T-38, T-40, T-41, T-42, T-43, T-44-koe)
#   bash scopes2/web/gate.sh --itsetesti   todistaa, että portti kaatuu oikein
#   bash scopes2/web/gate.sh --kohde       tulostaa Rust-käännöksen kohdehakemiston (oletus scopes2/ydin/target/web-koe)
# Exit: 0 vihreä, 1 tuntematon ID, puuttuva testitiedosto, muisti, kielletty DOM-kutsu tai testi punainen,
#       2 aita (puu muuttui ajon aikana sallitun alueen ulkopuolella).
#
# Aidat kuten scopes2/adapteri/gate.sh: lähtötila ajon alussa (`git status --porcelain` + tiiviste), ja portti kaatuu vain
# riveistä, jotka ilmestyivät tai muuttuivat ajon aikana. scopes/-rivi → "VANHA PUU MUUTTUNUT", exit 2 (K-9);
# GATE_MAY-etuliitteiden (oletus scopes2/web/) ulkopuolinen rivi → exit 2.
#
# Jokaisen tapauksen alussa: npm ci (vain jos node_modules puuttuu tai package-lock.json on uudempi), tsc, build.mjs ja
# kielletyt DOM-kutsut (S-7). Playwright-tapauksissa lisäksi vapaa muisti ≥ 1536 Mt ja flock /tmp/scopes2-cargo.lock
# Chromium-ajon ympärillä: ydin kääntää Rustia saman lukon alla, eikä Rust-käännös ja Chromium ole käynnissä yhtä aikaa.
set -uo pipefail

tama="$(cd "$(dirname "$0")" && pwd)"
juuri="$(git -C "$tama" rev-parse --show-toplevel)" || { echo "VIRHE: ei git-puuta" >&2; exit 1; }
GATE_MAY=${GATE_MAY:-scopes2/web/}
web=scopes2/web
LUKKO=${GATE_LUKKO:-/tmp/scopes2-cargo.lock}
MUISTIRAJA=1536
# Node 22: järjestelmän node 20 ei riisu tyyppejä. PATHin kärkeen, jotta node, npm ja npx ovat samaa asennusta.
node22=$HOME/.local/opt/node-v22.23.3-linux-arm64/bin/node
if [ -x "$node22" ] && [ "$("${NODE:-node}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  export NODE=$node22
  export PATH="$(dirname "$node22"):$PATH"
fi
export NODE=${NODE:-node}

# Rust-käännös (T-43): kuten ytimen gate (cargo ~/.cargo/bin:ssa, OpenSSL ilman pkg-config-työkalua). Kohde on aina erillinen
# hakemisto, ei koskaan tuotannon scopes2/ydin/target/release (cron käynnistää V2:n siitä; päivitys kuuluu T-44:ään).
export PATH="$HOME/.cargo/bin:$PATH"
if [ "$(uname -s)" = Darwin ]; then
  ossl=${OPENSSL_DIR:-/opt/homebrew/opt/openssl@3}
  export OPENSSL_LIB_DIR="${OPENSSL_LIB_DIR:-$ossl/lib}"
  export OPENSSL_INCLUDE_DIR="${OPENSSL_INCLUDE_DIR:-$ossl/include}"
else
  export OPENSSL_LIB_DIR="${OPENSSL_LIB_DIR:-/usr/lib/aarch64-linux-gnu}"
  export OPENSSL_INCLUDE_DIR="${OPENSSL_INCLUDE_DIR:-/usr/include}"
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$juuri/scopes2/ydin/target/web-koe}"

# macOS:ssa ei ole flockia, setsidiä eikä timeoutia: perl (lukon kahva periytyy exec-komennolle, $^F) ja Homebrew'n gtimeout.
if command -v flock >/dev/null 2>&1; then LUKITSE=(flock); else
  LUKITSE=(perl -MFcntl=:flock -e '$^F = 255; open(my $f, ">>", shift) or die "lukko: $!\n"; flock($f, LOCK_EX) or die "lukko: $!\n"; exec @ARGV or die "exec: $!\n"')
fi
if command -v setsid >/dev/null 2>&1; then RYHMA=(setsid); else
  RYHMA=(perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!\n"')
fi
if command -v timeout >/dev/null 2>&1; then AIKARAJA=(timeout); elif command -v gtimeout >/dev/null 2>&1; then AIKARAJA=(gtimeout); else
  AIKARAJA=(perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"')
fi

LAPSI=""
SIIVOA=()
# Chromium ja mock suljetaan: testin prosessiryhmä päättyy, kun portti päättyy tai saa INT/TERM.
siivoa() {
  if [ -n "$LAPSI" ]; then kill -TERM -- "-$LAPSI" 2>/dev/null; wait "$LAPSI" 2>/dev/null; LAPSI=""; fi
  local f
  for f in "${SIIVOA[@]:-}"; do [ -n "$f" ] && rm -rf -- "$f"; done
  return 0
}
trap siivoa EXIT
trap 'siivoa; exit 143' INT TERM

# Komento omaan prosessiryhmään, jotta siivoa tappaa myös Chromiumin ja mockin.
ryhmassa() {
  "${RYHMA[@]}" "$@" &
  LAPSI=$!
  wait "$LAPSI"
  local rc=$?
  # Ryhmän jäsenet ovat testin päätyttyä orpoja (kaatunut testi jätti mockin porttiin 18796): lopetetaan aina.
  kill -TERM -- "-$LAPSI" 2>/dev/null
  LAPSI=""
  return $rc
}

# Työpuun tila riveinä "XY<TAB>polku<TAB>tiiviste" (tiiviste = git hash-object, "-" puuttuvalle).
tila() {
  local xy polku
  git -C "$juuri" status --porcelain=v1 -z --untracked-files=all | while IFS= read -r -d '' rivi; do
    xy=${rivi:0:2}
    polku=${rivi:3}
    case "$xy" in R*|C*) IFS= read -r -d '' _ ;; esac
    if [ -f "$juuri/$polku" ]; then
      printf '%s\t%s\t%s\n' "$xy" "$polku" "$(git -C "$juuri" hash-object -- "$polku" 2>/dev/null || echo '?')"
    else
      printf '%s\t%s\t-\n' "$xy" "$polku"
    fi
  done | LC_ALL=C sort
}

sallittu() {
  local p
  for p in $GATE_MAY; do
    case "$1" in "$p"*) return 0 ;; esac
  done
  return 1
}

aidat() {
  local lahto="$1" uudet tulos=0 xy polku _h
  uudet=$(LC_ALL=C comm -13 <(printf '%s\n' "$lahto") <(tila))
  while IFS=$'\t' read -r xy polku _h; do
    [ -n "$polku" ] || continue
    case "$polku" in
      scopes/*) echo "VANHA PUU MUUTTUNUT: $xy $polku" >&2; tulos=2 ;;
      *) sallittu "$polku" || { echo "AITA: muutos may-listan ulkopuolella: $xy $polku" >&2; tulos=2; } ;;
    esac
  done <<< "$uudet"
  return $tulos
}

# Lähtötila → komento → aidat. Aita (2) voittaa komennon tuloksen.
aja() {
  local lahto rc
  lahto=$(tila)
  "$@"
  rc=$?
  aidat "$lahto" || return 2
  return $rc
}

# npm ci vain jos node_modules puuttuu tai package-lock.json on uudempi; tsc; build; kielletyt DOM-kutsut.
valmistelu() {
  cd "$juuri/$web" || return 1
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund >/dev/null || { echo "FAIL: npm ci" >&2; return 1; }
    touch node_modules
  fi
  "$NODE" node_modules/typescript/bin/tsc -p tsconfig.json || { echo "FAIL: tsc" >&2; return 1; }
  "$NODE" build.mjs || { echo "FAIL: build.mjs" >&2; return 1; }
  if grep -rnE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function' src/; then
    echo "FAIL: kielletty DOM-kutsu (S-7)" >&2
    return 1
  fi
  return 0
}

vapaa_mt() { # Linux: free-sarake available; macOS: vm_statin free + inactive + speculative + purgeable
  if command -v free >/dev/null 2>&1; then free -m | awk '/^Mem:/{print $7}'; return; fi
  vm_stat | awk '/page size of/{s=$8} /^Pages (free|inactive|speculative|purgeable):/{gsub(/\./, "", $NF); n+=$NF} END{if (s) printf "%d\n", n*s/1048576}'
}

muisti() {
  local vapaa
  vapaa=$(vapaa_mt)
  if [ -z "$vapaa" ] || [ "$vapaa" -lt "$MUISTIRAJA" ]; then
    echo "MUISTI: ${vapaa:-?} Mt, ei ajeta" >&2
    return 1
  fi
}

# Testitiedostot: puuttuva → "PUUTTUU: <tiedosto>" exit 1 (ei vihreä).
vaadi() {
  local f
  for f in "$@"; do
    [ -f "$juuri/$web/$f" ] || { echo "PUUTTUU: $f" >&2; return 1; }
  done
}

# Testien kiinteät portit (mock 18793–18796, koeydin 18797) eivät saa olla toisen prosessin varaamia: apu.ts hyväksyisi
# vieraan palvelimen vastauksen omakseen (orpo mock T-43-ajon jäljiltä kaatoi savutestin "title ''"-virheeseen).
kuuntelee() { # <portti>: Linuxissa ss, macOS:ssa lsof (mikä tahansa osoite)
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "127\.0\.0\.1:$1\b|0\.0\.0\.0:$1\b|\[::\]:$1\b"
  else
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  fi
}

portit_vapaat() { # <portti>…
  local p varatut=""
  for p in "$@"; do
    kuuntelee "$p" && varatut="$varatut $p"
  done
  if [ -n "$varatut" ]; then echo "VIRHE: koeportti käytössä:$varatut (ei tapeta vierasta prosessia)" >&2; return 1; fi
}

yksikkotestit() { # <tiedosto>… (node --test)
  vaadi "$@" || return 1
  portit_vapaat 18793 18794 18795 || return 1
  (cd "$juuri/$web" && ryhmassa "${AIKARAJA[@]}" 300 "$NODE" --test "$@")
}

playwright() { # <tiedosto>… peräkkäin Chromiumilla
  local f
  vaadi "$@" || return 1
  muisti || return 1
  portit_vapaat 18796 18797 || return 1
  for f in "$@"; do
    echo "--- $f"
    (cd "$juuri/$web" && ryhmassa "${LUKITSE[@]}" "$LUKKO" "${AIKARAJA[@]}" 300 "$NODE" "$f") || { echo "FAIL: $f" >&2; return 1; }
  done
}

rust() {
  local kohde tuotanto
  mkdir -p "$CARGO_TARGET_DIR" && kohde=$(cd "$CARGO_TARGET_DIR" && pwd -P) || { echo "VIRHE: CARGO_TARGET_DIR ei aukea: $CARGO_TARGET_DIR" >&2; return 1; }
  tuotanto=$(cd "$juuri/scopes2/ydin" && mkdir -p target && cd target && pwd -P)
  if [ "$kohde" = "$tuotanto" ]; then
    echo "VIRHE: CARGO_TARGET_DIR on tuotannon $tuotanto (release-binääri kuuluu T-44:ään); käytä erillistä hakemistoa" >&2
    return 1
  fi
  (cd "$juuri/scopes2/ydin" && ryhmassa "${LUKITSE[@]}" "$LUKKO" cargo build --release --bin scopes-solmu)
}

tapaus() {
  case "$1" in
    T-38) yksikkotestit test/mock-ydin.test.ts && playwright test/savu.ts ;;
    T-40) yksikkotestit test/api.test.ts test/virta.test.ts test/ndjson.test.ts test/tila.test.ts ;;
    T-41) playwright test/savu.ts test/savu-viestit.ts ;;
    T-42) playwright test/savu.ts test/savu-chat.ts ;;
    T-43) playwright test/savu.ts test/savu-viestit.ts test/savu-chat.ts && rust && playwright test/integraatio.ts ;;
    # T-44-koe: hyväksyntätesti (test/hyvaksynta.ts) koeytimelle 18797 + mock-vanha 18796, kertakäyttöavain; ei 8797:ää eikä target/release:ä.
    T-44-koe) rust && playwright test/hyvaksynta-koe.ts ;;
    *) return 1 ;;
  esac
}

tunnettu() {
  case "$1" in T-38|T-40|T-41|T-42|T-43|T-44-koe) return 0 ;; *) return 1 ;; esac
}

aja_tapaus() {
  valmistelu || return 1
  tapaus "$1"
}

itsetesti() {
  local tmp rc virheet=0 f
  local koe_vanha="$juuri/scopes/KOE.tmp" koe_may="$juuri/$web/KOE.tmp" koe_muu="$juuri/scopes2/KOE.tmp"
  local koe_dom="$juuri/$web/src/KOE-kielletty.ts"
  tmp=$(mktemp -d)
  SIIVOA+=("$koe_vanha" "$koe_may" "$koe_muu" "$koe_dom" "$tmp")
  for f in "$koe_vanha" "$koe_may" "$koe_muu" "$koe_dom"; do
    [ -e "$f" ] && { echo "VIRHE: $f on jo olemassa; itsetesti ei aja" >&2; exit 1; }
  done
  odota() { # <nimi> <odotettu exit> <todellinen exit>
    if [ "$2" = "$3" ]; then echo "ok   $1 → $3"; else echo "FAIL $1: odotettu $2, saatiin $3" >&2; virheet=1; fi
  }

  bash "$0" EI-OLE-ID >/dev/null 2>&1; odota "tuntematon ID" 1 $?

  ( aja sh -c "echo koe > '$koe_muu'" ) 2>/dev/null; rc=$?
  odota "ajon aikana luotu tiedosto may-listan ulkopuolella (scopes2/KOE.tmp)" 2 $rc
  ( aja sh -c "echo muutos >> '$koe_muu'" ) 2>/dev/null; rc=$?
  rm -f "$koe_muu"
  odota "ajon aikana muutettu, jo ennestään muuttunut tiedosto may-listan ulkopuolella" 2 $rc

  ( aja sh -c "echo koe > '$koe_vanha'" ) 2>"$tmp/err"; rc=$?
  rm -f "$koe_vanha"
  odota "ajon aikana luotu scopes/KOE.tmp" 2 $rc
  grep -q '^VANHA PUU MUUTTUNUT' "$tmp/err" || { echo "FAIL: rivi VANHA PUU MUUTTUNUT puuttuu" >&2; virheet=1; }

  echo koe > "$koe_vanha"
  ( aja true ) 2>/dev/null; rc=$?
  rm -f "$koe_vanha"
  odota "valmiiksi olemassa oleva scopes/-muutos" 0 $rc

  ( aja sh -c "echo koe > '$koe_may'" ) 2>/dev/null; rc=$?
  rm -f "$koe_may"
  odota "ajon aikana muutos may-polussa" 0 $rc

  ( aja false ) 2>/dev/null; rc=$?
  odota "punainen komento ilman aitaa" 1 $rc

  # Kielletty DOM-kutsu: väliaikainen tiedosto src/:ssä kaataa valmistelun, poisto palauttaa vihreäksi.
  printf 'document.body.innerHTML = "";\n' > "$koe_dom"
  ( aja valmistelu ) >"$tmp/dom" 2>&1; rc=$?
  rm -f "$koe_dom"
  odota "kielletty DOM-kutsu src/-alla" 1 $rc
  grep -q 'kielletty DOM-kutsu' "$tmp/dom" || { echo "FAIL: rivi 'kielletty DOM-kutsu' puuttuu" >&2; sed 's/^/  | /' "$tmp/dom" >&2; virheet=1; }
  ( aja valmistelu ) >"$tmp/dom" 2>&1; rc=$?
  odota "valmistelu ilman kiellettyä kutsua (palautus)" 0 $rc
  [ "$rc" = 0 ] || sed 's/^/  | /' "$tmp/dom" >&2

  # Rust-käännös ei kohdistu tuotannon target-hakemistoon.
  ( CARGO_TARGET_DIR="$juuri/scopes2/ydin/target" rust ) >"$tmp/rust" 2>&1; rc=$?
  odota "CARGO_TARGET_DIR = tuotannon target" 1 $rc
  grep -q '^VIRHE: CARGO_TARGET_DIR on tuotannon' "$tmp/rust" || { echo "FAIL: rivi 'CARGO_TARGET_DIR on tuotannon' puuttuu" >&2; virheet=1; }
  ( cd "$juuri" && env -u CARGO_TARGET_DIR bash -c 'bash scopes2/web/gate.sh --kohde' ) >"$tmp/kohde" 2>&1
  [ "$(cat "$tmp/kohde")" = "$juuri/scopes2/ydin/target/web-koe" ] || { echo "FAIL: oletuskohde '$(cat "$tmp/kohde")'" >&2; virheet=1; }

  # Varattu koeportti pysäyttää ajon ennen testejä.
  node -e 'require("node:net").createServer().listen(18789, "127.0.0.1")' & local varaaja=$!
  for _ in $(seq 1 50); do kuuntelee 18789 && break; sleep 0.1; done
  ( portit_vapaat 18788 18789 ) >"$tmp/portti" 2>&1; rc=$?
  kill "$varaaja" 2>/dev/null; wait "$varaaja" 2>/dev/null
  odota "varattu koeportti" 1 $rc
  grep -q '^VIRHE: koeportti käytössä: 18789' "$tmp/portti" || { echo "FAIL: rivi 'koeportti käytössä: 18789' puuttuu" >&2; virheet=1; }
  ( portit_vapaat 18788 ) >/dev/null 2>&1; odota "vapaa koeportti" 0 $?

  # Hyväksyntätesti ilman avainta on käyttövirhe (exit 2), ei yhteysyritys.
  ( cd "$juuri/$web" && env -u SCOPES2_AVAIN "$NODE" test/hyvaksynta.ts ) >"$tmp/avain" 2>&1; rc=$?
  odota "hyväksyntä ilman avainta" 2 $rc
  grep -q '^KÄYTTÖ: avain puuttuu' "$tmp/avain" || { echo "FAIL: rivi 'KÄYTTÖ: avain puuttuu' puuttuu" >&2; virheet=1; }

  # Puuttuva testitiedosto ei ole vihreä.
  ( aja vaadi test/ei-ole.ts ) >"$tmp/puuttuu" 2>&1; rc=$?
  odota "puuttuva testitiedosto" 1 $rc
  grep -q '^PUUTTUU: test/ei-ole.ts' "$tmp/puuttuu" || { echo "FAIL: rivi PUUTTUU puuttuu" >&2; virheet=1; }

  [ "$virheet" = 0 ] && echo "ITSETESTI VIHREÄ" || echo "ITSETESTI PUNAINEN" >&2
  return $virheet
}

id=${1:-}
if [ -z "$id" ]; then
  echo "Käyttö: bash $web/gate.sh <ID> | --itsetesti" >&2
  exit 1
fi
if [ "$id" = "--kohde" ]; then
  echo "$CARGO_TARGET_DIR"
  exit 0
fi
if [ "$id" = "--itsetesti" ]; then
  itsetesti
  exit $?
fi
if ! tunnettu "$id"; then
  echo "VIRHE: tuntematon ID $id" >&2
  exit 1
fi
echo "=== PORTTI: $id ==="
aja aja_tapaus "$id"
rc=$?
if [ $rc = 0 ]; then echo "PORTTI VIHREÄ: $id"; else echo "PORTTI PUNAINEN: $id (exit $rc)" >&2; fi
exit $rc
