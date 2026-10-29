#!/usr/bin/env bash
# muisti-koe.sh - täyden solmun huippumuisti synteettisellä täydellä peilillä (T-76, S-9, T-57 (6)).
#
# Luo synteettisen peilin (>= 2,5 Gt, >= 14 000 yksikköä, elävä >= 150 Mt:n transkripti ja 5 muuta elävää
# istuntoa; tests/muisti_taysi.rs luo_koepeili) väliaikaishakemistoon, käynnistää täyden A:n ja ikkunoidun B:n
# (--peili-ikkuna-vrk 7 --peili-katto-mt 38 --vertainen A) /usr/bin/time -l:llä, ajaa kuorman (A:n käynnistys,
# B:n täysi tasaus A:ta vasten, 10 /api/skoopit/<nimi>/viestit -pyyntöä A:lle) ja tulostaa molempien
# "maximum resident set size" -arvon sekä A:n MUISTI-rivit (SCOPES2_MUISTILOKI=1).
# Exit 0 vain, jos A < 512 MiB ja B < 512 MiB; 2 = esiehto (levytila, portit, käännös), 1 = raja ylittyi.
#
# Ympäristö: CARGO_TARGET_DIR (oletus <ydin>/target/muisti-koe; ei tuotannon target/release),
#   MUISTI_KOE_JUURI (väliaikaishakemiston juuri, oletus $TMPDIR), MUISTI_KOE_LOKIT (A:n ja B:n lokit talteen),
#   MUISTI_KOE_PORTTI (ensimmäinen koeportti, oletus 18800; varatut ohitetaan, 8797 ei koskaan).
# Data poistetaan lopuksi (trap).
set -uo pipefail

kansio="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$kansio/target/muisti-koe}"
RAJA=$((512 * 1024 * 1024))
KOKO=2600000000
juuri="${MUISTI_KOE_JUURI:-${TMPDIR:-/tmp}}"

case "$CARGO_TARGET_DIR" in
  "$kansio/target"|"$kansio/target/") echo "VIRHE: CARGO_TARGET_DIR ei saa olla tuotannon target-hakemisto" >&2; exit 2 ;;
esac

cargo_aja() {
  if [ "$(uname)" = Darwin ]; then
    mkdir -p ${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus && lockf -t 1800 ${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus/.lukko cargo "$@"
  else
    flock /tmp/scopes2-cargo.lock cargo "$@"
  fi
}

mkdir -p "$juuri" || exit 2
koe="$(mktemp -d "$juuri/muisti-koe.XXXXXX")" || exit 2
apid=""; bpid=""
siivoa() {
  local p
  for p in $apid $bpid; do
    pkill -KILL -P "$p" 2>/dev/null
    kill -KILL "$p" 2>/dev/null
  done
  if [ -n "${MUISTI_KOE_LOKIT:-}" ]; then
    mkdir -p "$MUISTI_KOE_LOKIT" && cp -p "$koe"/*.loki "$MUISTI_KOE_LOKIT"/ 2>/dev/null
  fi
  rm -rf "$koe"
}
trap siivoa EXIT
trap 'exit 2' INT TERM

# Levytila: vähintään 3 × peilin koko.
vapaa_kt="$(df -Pk "$koe" | awk 'NR == 2 {print $4}')"
tarve_kt=$((3 * KOKO / 1024))
echo "df $koe: vapaa ${vapaa_kt} kt, tarve ${tarve_kt} kt (3 × $KOKO t)"
[ "$vapaa_kt" -ge "$tarve_kt" ] || { echo "VIRHE: levytila ei riitä" >&2; exit 2; }

cd "$kansio" || exit 2
echo "=== käännös (release, $CARGO_TARGET_DIR) ==="
cargo_aja build --release --bin scopes-solmu > "$koe/kaannos.loki" 2>&1 \
  || { tail -30 "$koe/kaannos.loki"; echo "VIRHE: cargo build" >&2; exit 2; }
cargo_aja test --release --test muisti_taysi --no-run >> "$koe/kaannos.loki" 2>&1 \
  || { tail -30 "$koe/kaannos.loki"; echo "VIRHE: cargo test --no-run" >&2; exit 2; }
bin="$CARGO_TARGET_DIR/release/scopes-solmu"

echo "=== synteettinen peili ==="
alku=$(date +%s)
MUISTI_KOE_DATA="$koe/a" cargo test --release --test muisti_taysi -- --ignored --exact luo_koepeili \
  --nocapture --test-threads=1 > "$koe/luonti.loki" 2>&1 \
  || { tail -30 "$koe/luonti.loki"; echo "VIRHE: peilin luonti" >&2; exit 2; }
grep -o 'KORPUS.*' "$koe/luonti.loki"
# cargo test tulostaa ensimmäisen rivin testinimen perään: SKOOPPI haetaan rivin keskeltäkin.
skoopit="$(awk '{for (i = 1; i < NF; i++) if ($i == "SKOOPPI") print $(i + 1)}' "$koe/luonti.loki")"
echo "skoopit: $(echo $skoopit)"
echo "kanta: $(du -sk "$koe/a" | awk '{print $1}') kt, $(( $(date +%s) - alku )) s"

# Koeportit 18800 alkaen; kuunteleva portti ohitetaan.
vapaa_portti() {
  local p="$1"
  while [ "$p" = 8797 ] || lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p + 1)); done
  printf '%s' "$p"
}
pa="$(vapaa_portti "${MUISTI_KOE_PORTTI:-18800}")"
pb="$(vapaa_portti $((pa + 1)))"
[ "$pa" -ge 18800 ] && [ "$pb" -ge 18800 ] || { echo "VIRHE: koeportti < 18800" >&2; exit 2; }
avain="koe-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$avain" > "$koe/avain"
chmod 600 "$koe/avain"

odota() { # tiedosto, merkkijono, aikaraja s, pid
  local raja=$(( $(date +%s) + $3 ))
  until grep -q -- "$2" "$1" 2>/dev/null; do
    kill -0 "$4" 2>/dev/null || { echo "VIRHE: prosessi päättyi ennen '$2'" >&2; tail -20 "$1"; return 1; }
    [ "$(date +%s)" -lt "$raja" ] || { echo "VIRHE: '$2' ei näkynyt ${3} s:ssa" >&2; tail -20 "$1"; return 1; }
    sleep 1
  done
}

echo "=== A (täysi, portti $pa) ==="
SCOPES2_MUISTILOKI=1 SCOPES_LAITE=koe-a /usr/bin/time -l "$bin" --portti "$pa" --data "$koe/a" \
  --avain "$koe/avain" --vanha-avain "$koe/ei-vanhaa" < /dev/null > /dev/null 2> "$koe/a.loki" &
apid=$!
odota "$koe/a.loki" "MUISTI nakymat_kaynnistetty" 900 "$apid" || exit 2
curl -sf -H "Authorization: Bearer $avain" "http://127.0.0.1:$pa/api/peili/koko"; echo

echo "=== B (ikkunoitu 7 vrk / 38 Mt, portti $pb, vertainen A) ==="
alku=$(date +%s)
SCOPES_LAITE=koe-b /usr/bin/time -l "$bin" --portti "$pb" --data "$koe/b" --avain "$koe/avain" \
  --vanha-avain "$koe/ei-vanhaa" --peili-ikkuna-vrk 7 --peili-katto-mt 38 --vertainen "http://127.0.0.1:$pa" \
  < /dev/null > /dev/null 2> "$koe/b.loki" &
bpid=$!
odota "$koe/b.loki" "PEILI_HAETTU:" 1800 "$bpid" || exit 2
echo "B:n täysi tasaus $(( $(date +%s) - alku )) s: $(grep -m1 'PEILI_HAETTU:' "$koe/b.loki")"
curl -sf -H "Authorization: Bearer $avain" "http://127.0.0.1:$pb/api/peili/koko"; echo

echo "=== 10 viestit-pyyntöä A:lle ==="
set -- $skoopit
[ "$#" -ge 1 ] || { echo "VIRHE: ei skooppeja" >&2; exit 2; }
for i in 0 1 2 3 4 5 6 7 8 9; do
  eval "s=\${$(( i % $# + 1 ))}"
  koodi="$(curl -s -o "$koe/viestit.json" -w '%{http_code}' -H "Authorization: Bearer $avain" \
    "http://127.0.0.1:$pa/api/skoopit/$s/viestit")"
  echo "viestit $s: $koodi, $(wc -c < "$koe/viestit.json" | tr -d ' ') t"
  [ "$koodi" = 200 ] || { echo "VIRHE: viestit $s -> $koodi" >&2; exit 2; }
done
# Yksi 10 s:n ajo-rivi kuorman jälkeen.
sleep 11

lopeta() { # time-pid
  local lapsi
  lapsi="$(pgrep -P "$1")"
  [ -n "$lapsi" ] && kill -TERM "$lapsi"
  wait "$1"
}
lopeta "$bpid"; bpid=""
lopeta "$apid"; apid=""

huippu() { awk '/maximum resident set size/ {print $1}' "$1" | tail -1; }
ha="$(huippu "$koe/a.loki")"; hb="$(huippu "$koe/b.loki")"
echo "=== A:n MUISTI-rivit ==="
grep '^MUISTI' "$koe/a.loki"
echo "=== tulos ==="
echo "A maximum resident set size: ${ha:-?} t ($(( ${ha:-0} / 1048576 )) MiB)"
echo "B maximum resident set size: ${hb:-?} t ($(( ${hb:-0} / 1048576 )) MiB)"
[ -n "$ha" ] && [ -n "$hb" ] || { echo "VIRHE: time -l ei tulostanut huippua" >&2; exit 2; }
if [ "$ha" -lt "$RAJA" ] && [ "$hb" -lt "$RAJA" ]; then
  echo "MUISTIKOE OK: A ja B < 512 MiB"
  exit 0
fi
echo "MUISTIKOE EI: raja 512 MiB ($RAJA t) ylittyi" >&2
exit 1
