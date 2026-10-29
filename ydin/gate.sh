#!/usr/bin/env bash
# gate.sh - scopes2/ydin verifiointiportti.
# Käyttö: bash scopes2/ydin/gate.sh <T-ID|R-ID> | --pohja | --itsetesti
# Exit: 0 ok, 1 virheellinen käyttö/tuntematon ID, 2 aita tai pohja, muu = cargon koodi.
set -uo pipefail

kansio="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
juuri="$(git -C "$kansio" rev-parse --show-toplevel)"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_NET_OFFLINE=true

arg="${1:-}"

# Rivi: "<porcelain-rivi> <hash|poistettu>" jokaisesta muuttuneesta polusta.
tila_rivit() {
  local rivi polku h
  while IFS= read -r rivi; do
    [ -z "$rivi" ] && continue
    polku="${rivi:3}"
    case "$polku" in *" -> "*) polku="${polku##* -> }" ;; esac
    polku="${polku#\"}"; polku="${polku%\"}"
    if [ -e "$juuri/$polku" ] || [ -L "$juuri/$polku" ]; then
      h="$(git -C "$juuri" hash-object -- "$polku" 2>/dev/null || echo virhe)"
    else
      h="poistettu"
    fi
    printf '%s %s\n' "$rivi" "$h"
  done < <(git -C "$juuri" status --porcelain --untracked-files=all)
}

pohja_tiedosto() { printf '%s' "${GATE_POHJA:-/tmp/scopes2-ydin-gate-pohja.txt}"; }

kirjoita_pohja() {
  tila_rivit > "$(pohja_tiedosto)"
}

# Palauttaa 0 tai 2. Tulostaa muuttuneet polut pohjaan verrattuna.
aidat() {
  local pohja nyt muutokset p koodi=0 ulko="" vanha="" sallittu m
  pohja="$(pohja_tiedosto)"
  if [ ! -f "$pohja" ]; then
    echo "EI POHJAA: aja gate.sh --pohja"
    return 2
  fi
  nyt="$(mktemp)"
  tila_rivit > "$nyt"
  # rivit, joita pohjassa ei ole -> polut. Case-kuvio alkaa sulkeella ja kommentteja ei ole alla:
  # macOS:n bash 3.2 ei jäsennä komentokorvauksen sisällä kumpaakaan muuten.
  muutokset="$(grep -Fxv -f "$pohja" "$nyt" | while IFS= read -r r; do
    r="${r% *}"; p="${r:3}"
    case "$p" in (*" -> "*) p="${p##* -> }" ;; esac
    p="${p#\"}"; p="${p%\"}"
    printf '%s\n' "$p"
  done | sort -u)"
  rm -f "$nyt"
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$p" in scopes/*) vanha="$vanha $p"; continue ;; esac
    sallittu=0
    for m in ${GATE_MAY:-}; do
      m="${m%/\*\*}"; m="${m%/}"
      if [ "$p" = "$m" ] || [[ "$p" == "$m"/* ]]; then sallittu=1; break; fi
    done
    [ "$sallittu" = 1 ] || ulko="$ulko $p"
  done <<< "$muutokset"
  if [ -n "$ulko" ]; then echo "MAY-ULKOPUOLELLA:$ulko"; koodi=2; fi
  if [ -n "$vanha" ]; then echo "VANHA PUU MUUTTUNUT:$vanha"; koodi=2; fi
  return "$koodi"
}

itsetesti() {
  local tulos virhe=0
  # globaaleja, koska EXIT-trap ajetaan funktion jälkeen
  koe="$juuri/scopes/KOE.tmp"
  tmp="$(mktemp)"
  readme="$kansio/README.md"
  varmuus="$(mktemp)"
  cp -p "$readme" "$varmuus"
  trap 'cp -p "$varmuus" "$readme"; rm -f "$koe" "$tmp" "$varmuus"' EXIT
  export GATE_POHJA="$tmp"
  kirjoita_pohja

  bash "${BASH_SOURCE[0]}" T-99 >/dev/null 2>&1; tulos=$?
  [ "$tulos" = 1 ] || { echo "ITSETESTI VIRHE: tuntematon ID -> $tulos (odotettu 1)"; virhe=1; }

  bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; tulos=$?
  [ "$tulos" = 1 ] || { echo "ITSETESTI VIRHE: tyhjä argumentti -> $tulos (odotettu 1)"; virhe=1; }

  GATE_MAY="" aidat >/dev/null; tulos=$?
  [ "$tulos" = 0 ] || { echo "ITSETESTI VIRHE: koskematon puu -> $tulos (odotettu 0)"; virhe=1; }

  echo "itsetesti" >> "$readme"
  GATE_MAY="" aidat >/dev/null; tulos=$?
  cp -p "$varmuus" "$readme"
  [ "$tulos" = 2 ] || { echo "ITSETESTI VIRHE: README muutettu -> $tulos (odotettu 2)"; virhe=1; }

  : > "$koe"
  GATE_MAY="" aidat >/dev/null; tulos=$?
  rm -f "$koe"
  [ "$tulos" = 2 ] || { echo "ITSETESTI VIRHE: scopes/KOE.tmp -> $tulos (odotettu 2)"; virhe=1; }

  GATE_MAY="" aidat >/dev/null; tulos=$?
  [ "$tulos" = 0 ] || { echo "ITSETESTI VIRHE: palautuksen jälkeen -> $tulos (odotettu 0)"; virhe=1; }

  [ "$virhe" = 0 ] && echo "ITSETESTI OK"
  return "$virhe"
}

# macOS:ssa ei ole flockia: Darwinilla lockf ja sama Macin rakennuslukko kuin Apple-porteilla (P-14, P-18, V-623),
# jotta ydin- ja Apple-käännökset eivät mene päällekkäin. lockf -t: 75 (EX_TEMPFAIL), jos lukko on varattu yli 30 min.
cargo_aja() {
  if [ "$(uname)" = Darwin ]; then
    mkdir -p ${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus && lockf -t 1800 ${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus/.lukko cargo "$@"
  else
    flock /tmp/scopes2-cargo.lock cargo "$@"
  fi
}

case "$arg" in
  "")
    echo "Käyttö: bash scopes2/ydin/gate.sh <T-ID|R-ID> | --pohja | --itsetesti" >&2
    exit 1 ;;
  --pohja)
    kirjoita_pohja
    exit $? ;;
  --itsetesti)
    itsetesti
    exit $? ;;
esac

# suodatin: rust-testitiedostot (cargo test --test) tai mjs-ajo (node)
rust_testit=""; lib_rakenna=""; mjs=""; rakenna=""; rakenna_args=""; mjs_args=""; testi_args=""; kielletyt=()
case "$arg" in
  T-17) rust_testit="lr_pariteetti" ;;
  T-18) rust_testit="varasto" ;;
  T-19) rust_testit="api" ;;
  T-20) rakenna="lr-pariteetti"; mjs="pariteetti.mjs"; mjs_args="--otos 50" ;;
  T-21) rust_testit="replikointi" ;;
  T-22) rust_testit="kaksi_solmua"; testi_args="-- --test-threads=1 --nocapture" ;;
  T-23) rust_testit="silta" ;;
  T-64) rust_testit="silta_adapteri silta" ;;
  T-91) rust_testit="silta_adapteri silta nakymat lahdetila" ;;
  T-84) rust_testit="lahdetila lahde nakymat silta" ;;
  T-27) rust_testit="tila" ;;
  T-28) rust_testit="tila_kaksi_solmua"; testi_args="-- --test-threads=1 --nocapture" ;;
  T-30) rust_testit="peili lahde" ;;
  T-31) rust_testit="lr_protokolla" ;;
  T-32) rust_testit="lr lr_protokolla" ;;
  T-33) rakenna="scopes-solmu"; rakenna_args="--release"; mjs="lr-pariteetti.mjs" ;;
  T-35) rust_testit="nakymat" ;;
  T-36) rust_testit="varasto peili nakymat replikointi"
        # koko polun tai kannan lataus ei saa palata
        kielletyt=("listaa(POLKU)|src/peili.rs" 'listaa_etuliite("")|src/replikointi.rs' "listaa(&p)|src/replikointi.rs" ".listaa(p)|src/replikointi.rs") ;;
  T-39) rust_testit="web api silta" ;;
  T-50) rust_testit="liite silta"; testi_args="-- --test-threads=1 --nocapture" ;;
  T-46) rust_testit="ffi api kaksi_solmua web"; testi_args="-- --test-threads=1 --nocapture"; lib_rakenna=1 ;;
  # kaksi_solmua vaatii T-22:n argumentit; samat kaikille (portin silmukka antaa yhdet argumentit)
  T-54) rust_testit="peili_ikkuna peili" ;;
  T-55) rust_testit="replikointi_ikkuna kaksi_solmua_ikkuna replikointi"; testi_args="-- --test-threads=1 --nocapture" ;;
  T-56) rust_testit="peili_pohja nakymat peili" ;;
  T-60) rust_testit="peili_raaka peili_pohja peili" ;;
  T-61) rust_testit="virta_sisainen api replikointi_ikkuna" ;;
  T-73) rust_testit="peili_sisaltoaika peili_ikkuna replikointi_ikkuna kaksi_solmua_ikkuna varasto"; testi_args="-- --test-threads=1 --nocapture" ;;
  T-74) rust_testit="peili_riisunta peili_ikkuna peili" ;;
  T-75) rust_testit="peili_pohja_heti peili_pohja kaksi_solmua_ikkuna"; testi_args="-- --test-threads=1 --nocapture" ;;
  T-76) rust_testit="muisti_taysi nakymat peili_pohja"; testi_args="-- --test-threads=1 --nocapture" ;;
  T-78) rust_testit="api replikointi kaksi_solmua"; testi_args="-- --test-threads=1 --nocapture" ;;
  R-1) rust_testit="nakymat replikointi api kaksi_solmua"; testi_args="-- --test-threads=1 --nocapture" ;;
  R-2) rust_testit="varasto replikointi kaksi_solmua"; testi_args="-- --test-threads=1 --nocapture" ;;
  R-3) rust_testit="peili nakymat varasto" ;;
  *) echo "Tuntematon tehtävä-ID: $arg" >&2; exit 1 ;;
esac

echo "=== PORTTI: scopes2/ydin $arg ==="

aidat; koodi=$?
[ "$koodi" = 0 ] || exit "$koodi"

cd "$kansio" || exit 1

# tyhjä taulukko + set -u kaatuu macOS:n bash 3.2:ssa ilman +-muotoa
for k in ${kielletyt[@]+"${kielletyt[@]}"}; do
  n="$(grep -cF -- "${k%%|*}" "${k#*|}")"
  [ "$n" = 0 ] || { echo "VIRHE: ${k#*|} sisältää '${k%%|*}' ($n kertaa)" >&2; exit 2; }
done

cargo_aja fmt --check; koodi=$?
[ "$koodi" = 0 ] || { echo "VIRHE: cargo fmt --check ($koodi)" >&2; exit "$koodi"; }

cargo_aja clippy --all-targets -- -D warnings; koodi=$?
[ "$koodi" = 0 ] || { echo "VIRHE: cargo clippy ($koodi)" >&2; exit "$koodi"; }

for t in $rust_testit; do
  # shellcheck disable=SC2086
  cargo_aja test --test "$t" $testi_args; koodi=$?
  [ "$koodi" = 0 ] || { echo "VIRHE: cargo test --test $t ($koodi)" >&2; exit "$koodi"; }
done
for b in $rakenna; do
  # shellcheck disable=SC2086
  cargo_aja build $rakenna_args --bin "$b"; koodi=$?
  [ "$koodi" = 0 ] || { echo "VIRHE: cargo build --bin $b ($koodi)" >&2; exit "$koodi"; }
done
if [ -n "$lib_rakenna" ]; then
  # staticlib omaan kohdehakemistoon: tuotannon target/release (scopes-solmu 8797) ei kosketa
  cargo_aja build --lib --release --target-dir target/lib-release; koodi=$?
  [ "$koodi" = 0 ] || { echo "VIRHE: cargo build --lib --release ($koodi)" >&2; exit "$koodi"; }
  [ -f target/lib-release/release/libscopes_ydin.a ] || { echo "VIRHE: libscopes_ydin.a puuttuu" >&2; exit 2; }
fi
if [ -n "$mjs" ]; then
  # shellcheck disable=SC2086
  node "$mjs" $mjs_args; koodi=$?
  [ "$koodi" = 0 ] || { echo "VIRHE: node $mjs ($koodi)" >&2; exit "$koodi"; }
fi

echo "=== PORTTI OK: $arg ==="
exit 0
