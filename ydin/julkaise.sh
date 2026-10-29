#!/usr/bin/env bash
# julkaise.sh - scopes2/ydin tuotantobinäärin ristikäännös Macilla palvelimelle (T-78, T-44:n esiehto).
# Käyttö:
#   bash scopes2/ydin/julkaise.sh --koe            käännä, siirrä palvelimelle ja savutesti koeportissa 18850-18869
#   bash scopes2/ydin/julkaise.sh --asenna <sha8>  varmuuskopioi tuotantobinääri ja vaihda julkaisu tilalle (ei käynnistä uudelleen)
# Ympäristö: CARGO_TARGET_DIR (oletus <ydin>/target/julkaisu; ei koskaan pääkloonin target/release), PALVELIN (oletus palvelin).
# Exit: 0 ok, 1 virheellinen käyttö, 2 puu likainen tai tarkistus epäonnistui, muu = komennon koodi.
# --koe ei koske tuotannon 8797:ään eikä sen tiedostoihin. --asenna ei käynnistä mitään uudelleen.
set -euo pipefail

kansio="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
juuri="$(git -C "$kansio" rev-parse --show-toplevel)"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
palvelin="${PALVELIN:-palvelin}"
kohde=aarch64-unknown-linux-gnu
glibc=2.36
ssh_valit=(-o ConnectTimeout=10 -o BatchMode=yes)

kaytto() {
  echo "Käyttö: bash scopes2/ydin/julkaise.sh --koe | --asenna <sha8>" >&2
  exit 1
}

# Macin rakennuslukko kuten gate.sh:ssa (P-14, P-18, V-623); lockf -t: 75, jos lukko on varattu yli 30 min.
cargo_lukossa() {
  [ "$(uname)" = Darwin ] || { echo "VIRHE: julkaise.sh --koe ajetaan Macilla" >&2; exit 2; }
  mkdir -p ${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus
  perl -e 'alarm shift; exec @ARGV' 2400 lockf -t 1800 ${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus/.lukko cargo "$@"
}

koe() {
  # lähde = kloonin HEAD: puu puhdas scopes2/ydin/-polussa
  local likaiset head koodi bin sha sha8 tavut
  likaiset="$(git -C "$juuri" status --porcelain -- scopes2/ydin)"
  if [ -n "$likaiset" ]; then
    echo "VIRHE: scopes2/ydin/ ei ole puhdas (committoi ensin):" >&2
    echo "$likaiset" >&2
    exit 2
  fi
  head="$(git -C "$juuri" rev-parse --short=8 HEAD)"

  # oma kohdehakemisto: tuotannon target/release ei kosketa
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$kansio/target/julkaisu}"
  export CARGO_NET_OFFLINE="${CARGO_NET_OFFLINE:-true}"
  cd "$kansio"
  koodi=0
  cargo_lukossa zigbuild --release --locked --target "$kohde.$glibc" --bin scopes-solmu || koodi=$?
  [ "$koodi" = 0 ] || { echo "VIRHE: cargo zigbuild ($koodi)" >&2; exit "$koodi"; }

  [ "$(git -C "$juuri" rev-parse --short=8 HEAD)" = "$head" ] || { echo "VIRHE: HEAD vaihtui käännöksen aikana" >&2; exit 2; }
  bin="$CARGO_TARGET_DIR/$kohde/release/scopes-solmu"
  [ -f "$bin" ] || { echo "VIRHE: $bin puuttuu" >&2; exit 2; }
  sha="$(shasum -a 256 "$bin" | cut -d' ' -f1)"
  sha8="${sha:0:8}"
  tavut="$(wc -c < "$bin" | tr -d ' ')"
  echo "JULKAISU $sha8 $head $tavut"

  # siirto: osatiedostoon, sha256 palvelimella, sitten atominen mv
  ssh "${ssh_valit[@]}" "$palvelin" "set -e; d=\$HOME/.local/share/scopes2-julkaisu; mkdir -p \"\$d\"; chmod 700 \"\$d\"; \
    trap 'rm -f \"\$d/scopes-solmu.$sha8.osa\"' EXIT; \
    cat > \"\$d/scopes-solmu.$sha8.osa\"; chmod 700 \"\$d/scopes-solmu.$sha8.osa\"; \
    [ \"\$(sha256sum \"\$d/scopes-solmu.$sha8.osa\" | cut -d' ' -f1)\" = '$sha' ] || { echo 'VIRHE: sha256 ei täsmää palvelimella' >&2; exit 2; }; \
    mv -f \"\$d/scopes-solmu.$sha8.osa\" \"\$d/scopes-solmu.$sha8\"" < "$bin"
  echo "SIIRTO OK $palvelin:~/.local/share/scopes2-julkaisu/scopes-solmu.$sha8"

  savutesti "$sha8"
  echo "KOE OK $sha8 $head $tavut"
}

# Savutesti palvelimella: koeydin vapaassa portissa 18850-18869 tyhjällä väliaikaiskannalla. Ei koskaan 8797:ää.
savutesti() {
  ssh "${ssh_valit[@]}" "$palvelin" bash -s -- "$1" <<'KOE'
set -euo pipefail
bin="$HOME/.local/share/scopes2-julkaisu/scopes-solmu.$1"
[ -x "$bin" ] || { echo "VIRHE: $bin puuttuu" >&2; exit 2; }
"$bin" --help > /dev/null || { echo "VIRHE: --help ei exit 0" >&2; exit 2; }
echo "SAVU --help OK"
if ldd "$bin" | grep -E 'libssl|libcrypto'; then
  echo "VIRHE: binääri linkittää libssl/libcryptoon" >&2
  exit 2
fi
echo "SAVU ldd OK (ei libssl/libcrypto)"
tmp="$(mktemp -d)"
pid=""
siivoa() {
  if [ -n "$pid" ]; then kill "$pid" 2> /dev/null || true; wait "$pid" 2> /dev/null || true; fi
  rm -rf "$tmp"
}
trap siivoa EXIT
portti=""
for p in $(seq 18850 18869); do
  if ! ss -ltn | grep -qE ":$p( |$)"; then portti=$p; break; fi
done
[ -n "$portti" ] || { echo "VIRHE: ei vapaata koeporttia 18850-18869" >&2; exit 2; }
# --data: väliaikaishakemisto; --avain: polku sen sisällä (olematon tiedosto, ydin luo avaimen itse)
"$bin" --portti "$portti" --data "$tmp/data" --avain "$tmp/avain" --vanha-avain "$tmp/vanha-avain" > "$tmp/ulos" 2>&1 &
pid=$!
tila=""
for _ in $(seq 1 50); do
  kill -0 "$pid" 2> /dev/null || { echo "VIRHE: koeydin kaatui:" >&2; cat "$tmp/ulos" >&2; exit 2; }
  if { exec 3<> "/dev/tcp/127.0.0.1/$portti"; } 2> /dev/null; then
    printf 'GET /api/terveys HTTP/1.0\r\nHost: koe\r\n\r\n' >&3
    read -r -t 5 tila <&3 || true
    exec 3<&- 3>&-
    break
  fi
  sleep 0.2
done
case "$tila" in
  HTTP/1.*" 200"*) echo "SAVU /api/terveys 200 portissa $portti" ;;
  *) echo "VIRHE: /api/terveys vastasi '$tila' portissa $portti" >&2; cat "$tmp/ulos" >&2; exit 2 ;;
esac
KOE
}

asenna() {
  local sha8="$1"
  case "$sha8" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) echo "VIRHE: sha8 on 8 heksamerkkiä" >&2; exit 1 ;;
  esac
  ssh "${ssh_valit[@]}" "$palvelin" bash -s -- "$sha8" "$palvelin" <<'ASENNA'
set -euo pipefail
sha8="$1"
palvelin="$2"
jul="$HOME/.local/share/scopes2-julkaisu/scopes-solmu.$sha8"
tuot="$HOME/palvelin/scopes2/ydin/target/release/scopes-solmu"
varm="$HOME/.local/share/scopes2-varmuus"
[ -x "$jul" ] || { echo "VIRHE: $jul puuttuu (aja --koe ensin)" >&2; exit 2; }
[ -f "$tuot" ] || { echo "VIRHE: $tuot puuttuu" >&2; exit 2; }
[ "$(sha256sum "$jul" | cut -c1-8)" = "$sha8" ] || { echo "VIRHE: julkaisun sha256 ei täsmää $sha8:aan" >&2; exit 2; }
vanha="$(sha256sum "$tuot" | cut -c1-8)"
if [ "$vanha" = "$sha8" ]; then echo "ASENNETTU JO $sha8"; exit 0; fi
mkdir -p "$varm"
chmod 700 "$varm"
cp -p "$tuot" "$varm/scopes-solmu.$vanha"
cmp -s "$tuot" "$varm/scopes-solmu.$vanha" || { echo "VIRHE: varmuuskopio ei täsmää" >&2; exit 2; }
# sama tiedostojärjestelmä -> mv on atominen; käynnissä oleva prosessi pitää vanhan inodin
uusi="$tuot.uusi.$$"
trap 'rm -f "$uusi"' EXIT
cp "$jul" "$uusi"
chmod 700 "$uusi"
mv -f "$uusi" "$tuot"
echo "ASENNETTU $sha8 (vanha $vanha varmuuskopioitu: $varm/scopes-solmu.$vanha); ei käynnistetty uudelleen"
echo "PALAUTUS: ssh $palvelin 'cp $varm/scopes-solmu.$vanha $tuot.pal && chmod 700 $tuot.pal && mv -f $tuot.pal $tuot'"
ASENNA
}

case "${1:-}" in
  --koe) [ "$#" = 1 ] || kaytto; koe ;;
  --asenna) [ "$#" = 2 ] || kaytto; asenna "$2" ;;
  *) kaytto ;;
esac
