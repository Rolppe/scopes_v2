#!/usr/bin/env bash
# gate.sh - scopes2:n Apple-puiden (shared, ios, macos) verifiointiportti (T-45-G, ARK-08 ja ARK-09).
#   bash scopes2/shared/gate.sh <ID>          ajaa ID:n aidat palvelimella ja käännöksen/testit Macilla ssh:n yli
#   bash scopes2/shared/gate.sh --itsetesti   todistaa, että portti kaatuu oikein (ei tarvitse Macia)
#   bash scopes2/shared/gate.sh --tunnelitesti  todistaa, että Macin tilapäinen tunneli syntyy ja sulkeutuu (tarvitsee Macin)
# ID: T-45 (runko), T-46 (XCFramework), T-47 (+ScopesCore2-testit), T-48 (+ScopesUI2, äppien käännös),
#     T-49 (+UI-testit; tunneli ja avain mac_avain:ssa, myös T-47 ja T-52), T-52 (+kaksi laitetta), T-58 (T-48 + iOS-UI-testit: peili-ikkuna ja T-49:n iOS-testit), T-71 (käännös + näyttö hereillä:
#     pmset-väite äpin käynnistyksestä ja lopetuksesta + testKehitysOsio), T-87 (T-48 + OhjausUITests koeytimellä, jonka
#     --adapteri ja --vanha ovat mock-adapteri testit/mock-ohjaus.mjs; ei 8787:ää). Myöhempien tapausten tiedostot tulevat omissa tehtävissään.
# Exit: 0 vihreä, 1 tuntematon ID tai testi punainen, 2 aita (puu muuttui ajon aikana sallitun alueen ulkopuolella).
#
# Aidat kuten scopes2/adapteri/gate.sh: lähtötila ajon alussa, vain ajon aikana ilmestyneet/muuttuneet rivit lasketaan.
#   scopes/-rivi → "VANHA PUU MUUTTUNUT" exit 2 (K-9); GATE_MAY (oletus alla) ulkopuolinen rivi → exit 2.
# Darwinilla ajetaan suoraan (ei ssh:ta, ei siirtoa): juuri on silloin tämä työpuu. Koeydin käännetään ja ajetaan Macilla ja
#   kuuntelee suoraan ajon Mac-portissa (ei tunnelia); Mac-lukot otetaan paikallisesti lockf:llä.
# Rinnakkaiset ajot (V-605): Mac-hakemisto $MAC_PROJ/scopes_2/scopes2-rakennus-<ajo> ja Mac-portti (porttipaikka 18900–18919) ovat ajokohtaisia;
#   XCFramework (cargo) $MAC_PROJ/scopes_2/scopes2-rakennus/.lukko:n (sama kuin ytimen gate.sh), macOS-UI-testit näyttölukon ja iOS-testit
#   simulaattorikohtaisen lukon takana ($MAC_PROJ/scopes_2/scopes2-lukot). Sama <ajo> ei aja päällekkäin. Darwinilla rakennushakemisto on
#   työpuu ja ajon lukko työpuukohtainen: rinnakkaiset Mac-ajot tarvitsevat kukin oman git-worktreen (sama puu sarjoittuu).
# Mac-ympäristö: PATH=$HOME/.cargo/bin:/opt/homebrew/bin, DEVELOPER_DIR Xcode.app. Allekirjoitus P-16:
#   macOS CODE_SIGN_IDENTITY=- (Manual, ei tiimiä), simulaattori CODE_SIGNING_ALLOWED=NO.
# Muuttujat: GATE_MAY, SCOPES2_SIM (oletus "iPhone 15 Pro"), GATE_SIMIT (|-erotettu, oletus "$SCOPES2_SIM|iPhone 17 Pro|iPhone 17"),
#   GATE_AJO (oletus ID), GATE_MAC_TIMEOUT (s, oletus 1800 per ssh-komento), GATE_LUKKO_ODOTUS (s, oletus 2700 per jaettu lukko).
set -uo pipefail

tama="$(cd "$(dirname "$0")" && pwd)"
juuri="$(git -C "$tama" rev-parse --show-toplevel)" || { echo "VIRHE: ei git-puuta" >&2; exit 1; }
GATE_MAY=${GATE_MAY:-scopes2/shared/ scopes2/ios/ scopes2/macos/}
sim=${SCOPES2_SIM:-iPhone 15 Pro}
simit=${GATE_SIMIT:-$sim|iPhone 17 Pro|iPhone 17}
mac_tmo=${GATE_MAC_TIMEOUT:-1800}
lukko_odotus=${GATE_LUKKO_ODOTUS:-2700}
avain_tiedosto=""    # asetetaan koeytimen kertakäyttöavaimeksi (koeydin_alku); tuotannon ~/.config/scopes2/avain ei lähde palvelimelta (P-14)
koe_dir=""; koe_pid=""; koe_portti=""; mac_lukko_pid=""; silta_pid=""; mac_portti=""

if [ "$(uname)" = Darwin ]; then is_local=1; else is_local=0; fi

# Ajon nimi Macin hakemistoon ja palvelimen lukkoon: GATE_AJO tai ID, alun -- pois, muut kuin [A-Za-z0-9._-] → _.
ajo_nimi() {
  local n=${1#--}
  n=$(printf '%s' "$n" | tr -c 'A-Za-z0-9._-' '_')
  [ -n "$n" ] || return 1
  printf '%s\n' "$n"
}
ajo=$(ajo_nimi "${GATE_AJO:-${1:-}}") || ajo=oletus

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

# Lähtötilaan verrattuna uudet tai muuttuneet rivit → aitojen tulos (0 tai 2).
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

# --- Mac ---
mac_ymp="export PATH=\$HOME/.cargo/bin:/opt/homebrew/bin:\$PATH DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer SIM=$(printf %q "$sim")"
rak_mac="\${MAC_PROJ:-\$HOME/Projects}/scopes_2/scopes2-rakennus-$ajo"   # Macin ajokohtainen rakennushakemisto (V-605); $HOME laajenee Macilla
if [ "$is_local" = 1 ]; then rak_ymp="export RAK='$juuri/scopes2'"; else rak_ymp="export RAK=$rak_mac"; fi

# mac '<kuoriskripti>'  (stdin /dev/null). Aikaraja kattaa myös jaetun lukon odotuksen.
mac() {
  if [ "$is_local" = 1 ]; then
    bash -c "$mac_ymp; $rak_ymp; set -e; $1" </dev/null 7>&- 6<&-
  else
    timeout "$((mac_tmo + lukko_odotus))" ssh -o BatchMode=yes mac "$mac_ymp; $rak_ymp; set -e; $1" </dev/null
  fi
}

# --- Jaetut Mac-lukot (V-605) ---
# lukossa <naytto|cargo> '<skripti>': skripti ajetaan Macilla bashilla lukon alla (ympäristö periytyy exportilla). naytto =
# macOS-UI-testit (XCUITest ohjaa oikeaa näyttöä); cargo = XCFramework-käännös, sama $MAC_PROJ/scopes_2/scopes2-rakennus/.lukko kuin ytimen gate.sh.
lukossa() {
  local tiedosto
  case "$1" in
    naytto) tiedosto='${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot/naytto.lukko' ;;
    cargo) tiedosto='${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus/.lukko' ;;
    *) echo "VIRHE: tuntematon lukko $1" >&2; return 1 ;;
  esac
  printf 'mkdir -p "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot" "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus" && lockf -t %s "%s" /bin/bash -c %q' "$lukko_odotus" "$tiedosto" "set -e; $2"
}

# sim_lukossa '<skripti>': iOS-simulaattorin lukko. Ensimmäinen vapaa simulaattori GATE_SIMIT-listasta (lockf -t 0), kaikki
# varattu → odotetaan ensimmäistä. Skripti näkee valitun nimen muuttujassa SIM. lockf:n 75 = varattu (skriptin oma 75 samoin).
sim_lukossa() {
  local s slug eka="" ulos='( set +e; mkdir -p "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot"'
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    slug=$(printf '%s' "$s" | tr -c 'A-Za-z0-9' '_')
    [ -n "$eka" ] || eka=$(printf 'lockf -t %s "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot/sim-%s.lukko" /usr/bin/env SIM=%q /bin/bash -c %q' "$lukko_odotus" "$slug" "$s" "set -e; $1")
    ulos="$ulos; $(printf 'lockf -s -t 0 "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot/sim-%s.lukko" /usr/bin/env SIM=%q /bin/bash -c %q' "$slug" "$s" "set -e; $1"); r=\$?; [ \$r = 75 ] || exit \$r"
  done <<< "$(printf '%s\n' "$simit" | tr '|' '\n')"
  [ -n "$eka" ] || { echo "VIRHE: GATE_SIMIT on tyhjä" >&2; return 1; }
  printf '%s; %s )' "$ulos" "$eka"
}

# --- Koeydin palvelimella (P-14) ---
# Portti käynnistää palvelimelle koeytimen: oma tilapäinen --data, ajon aikana luotu kertakäyttöavain, RLIMIT_DATA (T-37) ja
# --vanha http://127.0.0.1:8787 palvelimen vanhalla avaimella (avain luetaan palvelimella, ei lähde koneelta).
# Koeportti oletus 18800, haku 18800–18819 (P-6); ei 8787, 8797, 18795, 18796 eikä 18797; varattu → seuraava vapaa (ss -ltn, Darwinilla lsof).
# Darwinilla koeydin kuuntelee suoraan ajon Mac-portissa (porttipaikka, mac_lukko_ota); testit saavat sen SCOPES2_VERTAINEN:ssa.
portti_kuuntelee() {
  if [ "$is_local" = 1 ]; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; fi
}

koeportti_valitse() {
  local p=${GATE_KOEPORTTI:-18800}
  if [ "$is_local" = 1 ]; then
    [ -n "$mac_portti" ] || return 1
    portti_kuuntelee "$mac_portti" && return 1
    echo "$mac_portti"; return 0
  fi
  while [ "$p" -le 18819 ]; do
    case "$p" in
      8787|8797|18795|18796|18797) ;;
      *) portti_kuuntelee "$p" || { echo "$p"; return 0; } ;;
    esac
    p=$((p + 1))
  done
  return 1
}

# Vapaa muisti megatavuina: Linux free -m (available), Darwin vm_stat (free + inactive + speculative).
vapaa_muisti() {
  if [ "$is_local" = 1 ]; then
    vm_stat | awk '/page size of/{koko=$8} /^Pages (free|inactive|speculative):/{gsub(/\./,"",$NF); s+=$NF} END{if (koko) print int(s*koko/1048576)}'
  else
    free -m | awk '/^Mem:/{print $7}'
  fi
}

# Koeytimen binääri käännetään omaan target-hakemistoon (V-582): tuotannon scopes2/ydin/target/release:a (cron käynnistää V2:n
# siitä) ei lueta eikä kirjoiteta. Kuten ytimen gate: cargo-flock /tmp/scopes2-cargo.lock ja vapaa muisti > 1,5 Gt.
koe_kohde() { echo "$juuri/scopes2/ydin/target/koe"; }
koe_binaari() { echo "$(koe_kohde)/release/scopes-solmu"; }
koe_polku_ok() { case "$1" in */target/release|*/target/release/*) return 1 ;; *) return 0 ;; esac; }

koeydin_rakenna() {
  local kohde vapaa
  kohde=$(koe_kohde)
  koe_polku_ok "$kohde" || { echo "KOEYDIN: kohde viittaa target/release:iin ($kohde)" >&2; return 1; }
  vapaa=$(vapaa_muisti)
  if [ -z "$vapaa" ] || [ "$vapaa" -le "${GATE_KOEMUISTI:-1536}" ]; then
    echo "KOEYDIN: vapaata muistia ${vapaa:-?} Mt, ei käännetä (raja ${GATE_KOEMUISTI:-1536} Mt)" >&2
    return 1
  fi
  mkdir -p "$kohde" || return 1
  # Darwin: reqwest käyttää Security.frameworkia (ei OpenSSL:ää), ja macOS:n lockf korvaa flockin. Lukko on Macin cargo-lukko
  # $MAC_PROJ/scopes_2/scopes2-rakennus/.lukko (sama kuin ytimen gate.sh:113 ja XCFramework), joten ytimen ja Apple-portin cargo eivät mene päällekkäin.
  if [ "$is_local" = 1 ]; then
    ( cd "$juuri/scopes2/ydin" &&
      PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" CARGO_TARGET_DIR="$kohde" \
        lockf "${GATE_LUKKO:-${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus/.lukko}" cargo build --release --bin scopes-solmu ) >&2 \
      || { echo "KOEYDIN: cargo build epäonnistui" >&2; return 1; }
    return 0
  fi
  ( cd "$juuri/scopes2/ydin" &&
    PATH="$HOME/.cargo/bin:$PATH" OPENSSL_LIB_DIR="${OPENSSL_LIB_DIR:-/usr/lib/aarch64-linux-gnu}" \
      OPENSSL_INCLUDE_DIR="${OPENSSL_INCLUDE_DIR:-/usr/include}" CARGO_TARGET_DIR="$kohde" \
      flock "${GATE_LUKKO:-/tmp/scopes2-cargo.lock}" cargo build --release --bin scopes-solmu ) >&2 \
    || { echo "KOEYDIN: cargo build epäonnistui" >&2; return 1; }
}

koeydin_alku() {
  local ydinbin i
  ydinbin=$(koe_binaari)
  koe_polku_ok "$ydinbin" || { echo "KOEYDIN: binäärin polku viittaa target/release:iin ($ydinbin)" >&2; return 1; }
  koeydin_rakenna || return 1
  [ -x "$ydinbin" ] || { echo "KOEYDIN: ydinbinääri puuttuu ($ydinbin)" >&2; return 1; }
  # Rinnakkaiset ajot (V-605): porttivalinta ja käynnistys yhden lukon alla, jotta kaksi ajoa ei valitse samaa vapaata porttia.
  if [ "$is_local" = 0 ]; then
    exec 8>/tmp/scopes2-koeportti.lock
    flock -w 120 8 || { echo "KOEYDIN: koeporttilukko varattu yli 2 min" >&2; return 1; }
  fi
  koeydin_kaynnista; local rc=$?
  [ "$is_local" = 0 ] && exec 8>&-
  [ "$rc" = 0 ] || return $rc
  koeydin_siemen   # portti on jo sidottu, joten siemen ei pidä koeporttilukkoa
}

# Siemen (T-62): RunkoUITests.testViestitVastaavatPalvelinta tarvitsee skoopin, jolla /viestit palauttaa viestejä, mutta viestit
# tulevat vain palvelimella avoimesta istunnosta (scopes2-istunnot ajetaan Macilla). Siksi koeytimeen kirjoitetaan terveystarkistuksen
# jälkeen yksi avoin istunto kiinteällä transkriptillä (testidata/siemen-*): lahde/istunnot, lahde/agy ja peili samassa järjestyksessä
# kuin ytimen testeissä (ytimen tests/nakymat.rs). Skooppi "test" on sillan (--vanha) listalla, ja /api/skoopit ottaa rivit sieltä;
# kun molemmat lähteet ovat ytimessä, ydin rakentaa /viestit itse, joten muiden skooppien viestit ovat tyhjiä (vakaat() ohittaa ne).
siemen_istunto=62e0a5e1-0000-4000-8000-000000000062
siemen_skooppi=test
siemen_hakemisto="$tama/testidata"

siemen_vika() { echo "SIEMEN: ei ($1)" >&2; return 1; }

# Transkriptin tiiviste kuten ytimessä (peili.rs tiiviste): rivit rivinvaihtoineen = tiedosto, jonka jokainen rivi päättyy \n:ään.
siemen_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1; else shasum -a 256 < "$1" | cut -d' ' -f1; fi
}

# siemen_peili_runko <transkripti> <ulos>: POST /api/peili -runko; rivit JSON-merkkijonoina (jsonl-rivi: vain \ ja " vaativat escapen).
siemen_peili_runko() {
  local sha
  sha=$(siemen_sha256 "$1") && [ -n "$sha" ] || return 1
  {
    printf '{"tiedosto":"koe-siemen/%s.jsonl","offset":0,"rivit":[' "$siemen_istunto"
    LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/"/' "$1" | paste -s -d, -
    printf '],"sha256":"%s"}\n' "$sha"
  } > "$2"
}

# siemen_curl <curl-argumentit>: koeytimen kertakäyttöavain Bearer-otsikkona tiedostosta (curl -H @tiedosto), ei argv:hen.
siemen_curl() { curl -fsS -m 15 -H "@$koe_dir/siemen-otsikko" "$@"; }

siemen_posti() { # <polku> <runkotiedosto>
  siemen_curl -o /dev/null -H 'Content-Type: application/json' --data-binary "@$2" "http://127.0.0.1:$koe_portti$1"
}

# koeydin_siemen: kirjoittaa siemenen, odottaa (enintään GATE_SIEMEN_ODOTUS s, oletus 60) että sillan skooppilistalla on "test"
# ja tarkistaa /viestit-määrän (10–120). Tuloste "SIEMEN: test <n> viestiä"; virhe "SIEMEN: ei (<syy>)" ja paluu 1.
koeydin_siemen() {
  local d="$siemen_hakemisto" lista="" ok=0 loppu n="" vastaus f _i
  for f in siemen-istunnot.json siemen-agy.json siemen-transkripti.jsonl; do
    [ -r "$d/$f" ] || { siemen_vika "testidata puuttuu: $f"; return 1; }
  done
  [ -r "$koe_dir/avain" ] || { siemen_vika "koeytimen avain puuttuu"; return 1; }
  (umask 077; printf 'Authorization: Bearer %s\n' "$(cat "$koe_dir/avain")" > "$koe_dir/siemen-otsikko")
  siemen_peili_runko "$d/siemen-transkripti.jsonl" "$koe_dir/siemen-peili.json" || { siemen_vika "peilirungon teko epäonnistui"; return 1; }
  siemen_posti /api/lahde/istunnot "$d/siemen-istunnot.json" || { siemen_vika "POST lahde/istunnot epäonnistui"; return 1; }
  siemen_posti /api/lahde/agy "$d/siemen-agy.json" || { siemen_vika "POST lahde/agy epäonnistui"; return 1; }
  siemen_posti /api/peili "$koe_dir/siemen-peili.json" || { siemen_vika "POST peili epäonnistui"; return 1; }
  # Sillan ensimmäinen skooppilista: välimuisti täyttyy 8787:stä; odotetaan "test"-riviä (sillan virhe tai tyhjä lista → uusi yritys).
  loppu=$((SECONDS + ${GATE_SIEMEN_ODOTUS:-60}))
  while :; do
    if lista=$(siemen_curl "http://127.0.0.1:$koe_portti/api/skoopit" 2>/dev/null); then
      if printf '%s' "$lista" | grep -Eq "\"nimi\" *: *\"$siemen_skooppi\""; then ok=1; break; fi
    else
      lista=""
    fi
    [ "$SECONDS" -lt "$loppu" ] || break
    sleep 2
  done
  if [ "$ok" != 1 ]; then
    if [ -n "$lista" ]; then siemen_vika "$siemen_skooppi ei sillan listalla"; else siemen_vika "sillan skooppilista ei vastaa"; fi
    return 1
  fi
  # Ydin tasaa näkymän pyynnön yhteydessä; pieni toisto varmuuden vuoksi.
  for _i in 1 2 3 4 5; do
    vastaus=$(siemen_curl "http://127.0.0.1:$koe_portti/api/skoopit/$siemen_skooppi/viestit" 2>/dev/null) \
      && n=$(printf '%s' "$vastaus" | grep -o '"rooli"' | wc -l | tr -d ' ') && [ "${n:-0}" -ge 10 ] && break
    sleep 1
  done
  case "${n:-}" in ''|*[!0-9]*) siemen_vika "viestit-vastaus ei jäsenny"; return 1 ;; esac
  if [ "$n" -lt 10 ] || [ "$n" -gt 120 ]; then siemen_vika "viestimäärä $n ei väliltä 10–120"; return 1; fi
  echo "SIEMEN: $siemen_skooppi $n viestiä"
}

koeydin_kaynnista() {
  local ydinbin i
  ydinbin=$(koe_binaari)
  koe_portti=$(koeportti_valitse) || { echo "KOEYDIN: vapaata koeporttia ei löytynyt" >&2; return 1; }
  koe_dir=$(mktemp -d /tmp/scopes2-koe.XXXXXX) || return 1
  chmod 700 "$koe_dir"; mkdir "$koe_dir/data"
  cp "$ydinbin" "$koe_dir/solmu" || return 1
  (umask 077; head -c 48 /dev/urandom | base64 | tr -d '=+/\n' > "$koe_dir/avain")
  avain_tiedosto="$koe_dir/avain"
  local vanha=http://127.0.0.1:8787 vanha_avain="$HOME/.config/scopes/avain"
  if [ "$is_local" = 1 ]; then
    vanha_silta_alku || return 1
    vanha="http://127.0.0.1:$(silta_portti)" vanha_avain="$koe_dir/vanha-avain"
  fi
  # 9>&- 8>&- 7>&- 6<&-: koeydin ei peri lukkojen fd:itä (jäänyt koeydin piti lukkoa portin kaaduttua)
  ( ulimit -d "${SCOPES2_YDIN_DATARAJA-1572864}" 2>/dev/null
    exec 9>&- 8>&- 7>&- 6<&- "$koe_dir/solmu" --portti "$koe_portti" --data "$koe_dir/data" --avain "$koe_dir/avain" \
      --vanha "$vanha" --vanha-avain "$vanha_avain" ) >"$koe_dir/loki" 2>&1 &
  koe_pid=$!
  for i in $(seq 1 30); do
    curl -fsS -m 2 "http://127.0.0.1:$koe_portti/api/terveys" >/dev/null 2>&1 && { echo "KOEYDIN: portti $koe_portti pid $koe_pid"; return 0; }
    kill -0 "$koe_pid" 2>/dev/null || break
    sleep 1
  done
  echo "KOEYDIN: ei vastaa (portti $koe_portti, loki poistetaan)" >&2
  return 1
}

# Darwin: vanha 8787 on palvelimella. Käyttäjän päätös 20.10.2026 (poikkeus P-14:ään): palvelimen ~/.config/scopes/avain luetaan
# ajon ajaksi koeytimen hakemistoon (0600, poistuu koeydin_loppu:ssa) ja tunneli Macin 127.0.0.1:<silta> → palvelimen 8787.
# Siltaportti on ajon Mac-portti + 100 (19000–19019), joten rinnakkaiset Darwin-ajot eivät törmää (V-605).
silta_portti() { echo $((mac_portti + 100)); }

vanha_silta_alku() {
  local i koko sp
  sp=$(silta_portti)
  portti_kuuntelee "$sp" && { echo "KOEYDIN: $sp on jo käytössä (8787-silta)" >&2; return 1; }
  (umask 077; ssh -o BatchMode=yes -o ConnectTimeout=10 palvelin 'cat ~/.config/scopes/avain' > "$koe_dir/vanha-avain" </dev/null) \
    || { echo "KOEYDIN: 8787-avaimen luku palvelimelta epäonnistui" >&2; return 1; }
  koko=$(tr -d '\n' < "$koe_dir/vanha-avain" | wc -c | tr -d ' ')
  [ "$koko" -ge 32 ] || { echo "KOEYDIN: 8787-avain liian lyhyt ($koko merkkiä)" >&2; return 1; }
  ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L "$sp:127.0.0.1:8787" palvelin \
    </dev/null >/dev/null 2>&1 7>&- 6<&- &
  silta_pid=$!
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS -m 2 "http://127.0.0.1:$sp/api/terveys" >/dev/null 2>&1 && { echo "KOEYDIN: 8787-silta $sp pid $silta_pid"; return 0; }
    kill -0 "$silta_pid" 2>/dev/null || break
    sleep 1
  done
  echo "KOEYDIN: 8787-silta ei vastaa ($sp)" >&2
  return 1
}

koeydin_loppu() {
  local i
  if [ -n "$silta_pid" ]; then
    kill "$silta_pid" 2>/dev/null; wait "$silta_pid" 2>/dev/null
    silta_pid=""
  fi
  if [ -n "$koe_pid" ]; then
    kill -TERM "$koe_pid" 2>/dev/null
    for i in $(seq 1 50); do kill -0 "$koe_pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$koe_pid" 2>/dev/null
    wait "$koe_pid" 2>/dev/null
    koe_pid=""
  fi
  [ -n "$koe_dir" ] && rm -rf "$koe_dir"
  koe_dir=""; avain_tiedosto=""
}

# --- Macin ajolukko ja porttipaikka (P-14, V-605) ---
# Yksi pitkäikäinen ssh pitää ajon lukkoa koko ajon (siirto, rakennus ja testit) ja sen sisällä ensimmäistä vapaata porttipaikkaa
# $MAC_PROJ/scopes_2/scopes2-lukot/portti-<p>.lukko (p = 18900–18919, ei kuuntelijaa); kuittaus "LUKITTU <p>", ja p on ajon Mac-portti.
# Ajon lukko: palvelimelta $MAC_PROJ/scopes_2/scopes2-rakennus-<ajo>/.lukko, Darwinilla työpuukohtainen $MAC_PROJ/scopes_2/scopes2-lukot/puu-<tiiviste>.lukko
# (sama työpuu = samat käännöshakemistot). Lukot vapautuvat, kun portti sulkee putken tai kuolee (cat saa EOF). macOS:ssa ei ole flock.
# Putket ovat FIFOja (fd 7 pito, fd 6 kuittaus), ei coproc: macOS:n bash 3.2 ei tunne coprocia. Lapsiprosessit sulkevat 6 ja 7.
ajolukko_mac() {
  if [ "$is_local" = 1 ]; then
    printf '${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot/puu-%s.lukko\n' "$(printf '%s' "$juuri" | shasum | cut -c1-12)"
  else
    printf '%s/.lukko\n' "$rak_mac"
  fi
}

# ajolukko_skripti <lukkotiedosto>: Macin sh-skripti, joka pitää ajon lukkoa ja porttipaikkaa, kunnes stdin sulkeutuu.
ajolukko_skripti() {
  local p='p=18900; while [ $p -le 18919 ]; do if ! lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then lockf -s -t 0 "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot/portti-$p.lukko" /bin/sh -c "echo LUKITTU $p; cat >/dev/null"; [ $? = 75 ] || exit 0; fi; p=$((p + 1)); done; echo PORTIT-VARATTU'
  printf 'mkdir -p "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot" "%s" && exec lockf -t 1800 "%s" /bin/sh -c %s' "$(dirname "$1")" "$1" "'$p'"
}

mac_lukko_ota() {
  local rivi fifot skripti
  skripti=$(ajolukko_skripti "$(ajolukko_mac)")
  fifot=$(mktemp -d /tmp/scopes2-maclukko.XXXXXX) || return 1
  mkfifo "$fifot/pito" "$fifot/kuittaus" || { rm -rf "$fifot"; return 1; }
  if [ "$is_local" = 1 ]; then
    /bin/sh -c "$skripti" <"$fifot/pito" >"$fifot/kuittaus" 2>/dev/null &
  else
    timeout 3600 ssh -o BatchMode=yes mac "$skripti" <"$fifot/pito" >"$fifot/kuittaus" 2>/dev/null &
  fi
  mac_lukko_pid=$!
  exec 7>"$fifot/pito" 6<"$fifot/kuittaus"
  rm -rf "$fifot"
  if ! read -r -t 1850 -u 6 rivi; then rivi=""; fi
  case "$rivi" in
    "LUKITTU "1[89][0-9][0-9][0-9]) mac_portti=${rivi#LUKITTU } ;;
    PORTIT-VARATTU) echo "MAC-LUKKO: porttipaikat 18900–18919 varattu" >&2; mac_lukko_vapauta; return 1 ;;
    *) echo "MAC-LUKKO: varattu (ajo $ajo)" >&2; mac_lukko_vapauta; return 1 ;;
  esac
  echo "MAC-LUKKO: ajo $ajo, Mac-portti $mac_portti"
}

mac_lukko_vapauta() {
  [ -n "$mac_lukko_pid" ] || return 0
  exec 7>&- 6<&-   # pito sulkeutuu → cat saa EOF → lockf vapauttaa
  wait "$mac_lukko_pid" 2>/dev/null
  mac_lukko_pid=""; mac_portti=""
}

# Tilapäinen tunneli Macilta koeytimeen: Macin 127.0.0.1:<Mac-portti> → palvelimen 127.0.0.1:<koeportti>. Avautuu ssh -N:llä saman
# Mac-istunnon sisällä kuin testit ja sulkeutuu EXIT-trapilla myös virheessä. Ei launchd-agenttia, ei Keychainia.
# Testit ja kaksi-laitetta.sh saavat osoitteen muuttujissa SCOPES2_VERTAINEN ja TEST_RUNNER_SCOPES2_VERTAINEN.
tunneli_koodi() {
  local vert="http://127.0.0.1:$mac_portti"
  [ -n "$mac_portti" ] || { echo "echo 'TUNNELI: Mac-portti puuttuu (mac_lukko_ota ei ajettu)'; exit 1"; return 0; }
  # Darwin: koeydin kuuntelee jo Mac-portissa (koeportti_valitse), joten vain terveystarkistus.
  if [ "$is_local" = 1 ]; then
    printf '%s\n' "export SCOPES2_VERTAINEN=$vert TEST_RUNNER_SCOPES2_VERTAINEN=$vert
curl -fsS -m 5 127.0.0.1:$mac_portti/api/terveys >/dev/null 2>&1 || { echo 'KOEYDIN: $mac_portti ei vastaa'; exit 1; }"
    return 0
  fi
  printf '%s\n' "ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L $mac_portti:127.0.0.1:$koe_portti palvelin </dev/null >/dev/null 2>&1 & TUN=\$!
trap 'kill \$TUN 2>/dev/null; wait \$TUN 2>/dev/null; true' EXIT
export SCOPES2_VERTAINEN=$vert TEST_RUNNER_SCOPES2_VERTAINEN=$vert
for _i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -m 2 127.0.0.1:$mac_portti/api/terveys >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 5 127.0.0.1:$mac_portti/api/terveys >/dev/null 2>&1 || { echo 'TUNNELI: ei avautunut'; exit 1; }"
}

# mac_kuori <stdin-tiedosto> <kuoriskripti>
mac_kuori() {
  if [ "$is_local" = 1 ]; then
    bash -c "$mac_ymp; $rak_ymp; set -e; $2" < "$1" 7>&- 6<&-
  else
    timeout "$((mac_tmo + lukko_odotus))" ssh -o BatchMode=yes mac "$mac_ymp; $rak_ymp; set -e; $2" < "$1"
  fi
}

# mac_tunneli '<kuoriskripti>'  tunneli koeytimeen auki skriptin ajan (ei avainta)
mac_tunneli() { mac_kuori /dev/null "$(tunneli_koodi)
$1"; }

# mac_avain '<kuoriskripti>'  tunneli auki; koeytimen kertakäyttöavain stdinin kautta Macin ympäristömuuttujiin SCOPES2_AVAIN ja
# TEST_RUNNER_SCOPES2_AVAIN (ei komentorivillä, ei lokissa)
mac_avain() {
  [ -n "$avain_tiedosto" ] && [ -r "$avain_tiedosto" ] || { echo "VIRHE: koeytimen avain puuttuu (koeydin_alku ei ajettu)" >&2; return 1; }
  local pre='K=$(cat); export TEST_RUNNER_SCOPES2_AVAIN=$K SCOPES2_AVAIN=$K'
  mac_kuori "$avain_tiedosto" "$pre
$(tunneli_koodi)
$1"
}

vaihe() { echo "--- $1"; }

# siirto <ydin mukaan 0|1>: puut palvelimelta Macin ajokohtaiseen $MAC_PROJ/scopes_2/scopes2-rakennus-<ajo>-hakemistoon (Darwinilla ei siirtoa)
siirto() {
  local puut="shared ios macos" r=$rak_mac
  [ "$is_local" = 1 ] && return 0
  [ "$1" = 1 ] && puut="ydin shared ios macos"
  vaihe "siirto ($puut → ${rak_mac#*Projects\}/})"
  # Poistetut tiedostot: lähdehakemistot tyhjennetään ennen purkua (literaalipolut); ydin/target säilyy.
  mac "mkdir -p $r && rm -rf $r/shared/ScopesCore2 $r/shared/ScopesUI2 $r/ios/Sources $r/ios/UITests $r/macos/Sources $r/macos/UITests" || return 1
  # shellcheck disable=SC2086
  tar -C "$juuri/scopes2" -cf - --exclude=target --exclude=.build --exclude=build --exclude=DerivedData --exclude=node_modules $puut \
    | ssh -o BatchMode=yes mac "tar -C $r -xf -"
  local rcs=("${PIPESTATUS[@]}")
  { [ "${rcs[0]}" = 0 ] && [ "${rcs[1]}" = 0 ]; } || { echo "FAIL: siirto" >&2; return 1; }
}

# Palvelimen ajolukko: sama <ajo> kerrallaan (V-605: eri ajot rinnakkain, Macin jaetut vaiheet omien lukkojensa takana).
lukko() {
  [ "$is_local" = 1 ] && return 0   # Darwin: mac_lukko_ota pitää työpuun lukkoa
  local f="/tmp/scopes2-apple-mac-$ajo.lock"
  exec 9>"$f"
  flock -w 900 9 || { echo "Ajo $ajo varattu yli 15 min (lukko $f)" >&2; return 3; }
}

# Käännösten komennot (P-16). Simulaattori $SIM laajenee Macilla (mac_ymp tai sim_lukossa).
xb_mac='xcodebuild %s -project ScopesV2Mac.xcodeproj -scheme ScopesV2Mac -destination "platform=macOS" CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= -derivedDataPath build -quiet'
xb_ios='xcodebuild %s -project ScopesV2.xcodeproj -scheme ScopesV2 -destination "platform=iOS Simulator,name=$SIM" CODE_SIGNING_ALLOWED=NO -derivedDataPath build -quiet'
# shellcheck disable=SC2059
xmac() { printf "$xb_mac" "$1"; xdiag "$1"; }
# shellcheck disable=SC2059
xios() { printf "$xb_ios" "$1"; xdiag "$1"; }
# Testiajossa ei kerätä simulaattorin sysdiagnoosia virheessä: T-49:n ajossa keruu aikakatkesi 600 s kohdalla ("Failure collecting
# diagnostics from simulator: Timed out after 600.0 seconds") ja söi ~25 % ajosta. Ei muuta tarkistuksia eikä testien tulosta.
xdiag() { [ "$1" = test ] && printf ' -collect-test-diagnostics never'; return 0; }
# xtesti <xmac|xios>: testiajo; punaisena tulostetaan xcresultin yhteenveto (kaatuneet testit ja virheviestit), koska -quiet piilottaa
# ne (T-52:n 2. ajossa iOS:n testViestit kaatui ilman syytä lokissa).
xtulos='build/viimeisin-testi.xcresult'
# Toinen argumentti (valinnainen) lisätään xcodebuild-komennon perään, esim. ' -only-testing:...'.
xtesti() { printf 'rm -rf %s && { %s -resultBundlePath %s || { xcrun xcresulttool get test-results summary --path %s --compact | head -c 8000; echo; exit 1; }; }' "$xtulos" "$($1 test)${2:-}" "$xtulos" "$xtulos"; }

# T-71 (K-11): äppi pitää näytön hereillä itse (-scopes2.naytto-hereilla); XCUITest ei anna portille argumentteja, joten portti vie
# testiajurille TEST_RUNNER_SCOPES2_NAYTTO_HEREILLA=YES ja testit lisäävät argumentin. Etuliite macOS-UI-vaiheiden skripteihin.
naytto_ymp='export TEST_RUNNER_SCOPES2_NAYTTO_HEREILLA=YES; '

swift_paketit() { # <avain stdinissä 0|1> <paketit...>
  local kayttaa_avainta="$1" p; shift
  for p in "$@"; do
    vaihe "swift build + swift test $p"
    if [ "$kayttaa_avainta" = 1 ]; then
      mac_avain "cd \"\$RAK/shared/$p\" && swift build && swift test" || return 1
    else
      mac "cd \"\$RAK/shared/$p\" && swift build && swift test" || return 1
    fi
  done
}

xcodegen_molemmat() {
  vaihe "xcodegen"
  mac 'cd "$RAK/ios" && xcodegen -q && cd "$RAK/macos" && xcodegen -q'
}

lulu() { # LuLu-havainto (P-14): informatiivinen, ei kaada porttia
  vaihe "LuLu-havainto (viimeiset 5 min)"
  local ulos
  if ulos=$(mac '/usr/bin/log show --last 5m --predicate "process == \"LuLu\"" | tail -5' 2>&1); then
    if [ -n "$(printf '%s\n' "$ulos" | grep -v -e '^Timestamp' -e '^Skipping' -e '^---' -e '^$')" ]; then echo "LULU: lokirivejä havaittu"; else echo "LULU: ei kehotetta"; fi
    printf '%s\n' "$ulos"
  else
    echo "LULU: lokin luku epäonnistui"
  fi
}

t45() {
  xcframework_varmista || return 1
  swift_paketit 0 ScopesCore2 ScopesUI2 || return 1
  xcodegen_molemmat || return 1
  vaihe "macOS build"; mac "cd \"\$RAK/macos\" && $(xmac build)" || return 1
  vaihe "macOS UI-testi (näyttölukko)"; mac "$(lukossa naytto "$naytto_ymp cd \"\$RAK/macos\" && $(xmac test)")" || return 1
  lulu
  vaihe "iOS simulaattori build"; mac "cd \"\$RAK/ios\" && $(xios build)" || return 1
  vaihe "iOS simulaattori UI-testi (simulaattorilukko)"; mac "$(sim_lukossa "echo \"SIMULAATTORI: \$SIM\"; cd \"\$RAK/ios\" && $(xios test)")" || return 1
  echo "APPLE-RUNKO: ok"
}

xcframework_tarkistus() {
  mac 'f="$RAK/ydin/apple/ScopesSolmu.xcframework"
       for d in ios-arm64 ios-arm64-simulator macos-arm64; do test -d "$f/$d" || { echo "FAIL: $d puuttuu"; exit 1; }; done
       test -n "$(find "$f" -name scopes_solmu.h -print -quit)" || { echo "FAIL: scopes_solmu.h puuttuu"; exit 1; }'
}

# Uusi ajohakemisto saa ytimen käännösvälimuistin kloonina (cp -c, APFS) $MAC_PROJ/scopes_2/scopes2-rakennus/ydin:stä, jotta riippuvuuksia ei
# käännetä alusta; epäonnistuminen ei kaada (cargo kääntää). Darwinilla RAK on työpuu, ei kloonia.
xcf_siemen='case "$RAK" in "${MAC_PROJ:-$HOME/Projects}"/scopes_2/scopes2-rakennus-*)
  if [ ! -d "$RAK/ydin/target" ] && [ -d "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus/ydin/target" ]; then
    cp -cR "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus/ydin/target" "$RAK/ydin/target" 2>/dev/null || rm -rf "$RAK/ydin/target"; fi ;; esac'

t46() {
  vaihe "XCFramework (cargo-lukko)"
  mac "$(lukossa cargo 'test -f "$RAK/ydin/apple/rakenna-xcframework.sh" || { echo "PUUTTUU: ydin/apple/rakenna-xcframework.sh"; exit 1; }
'"$xcf_siemen"'
bash "$RAK/ydin/apple/rakenna-xcframework.sh"')" || return 1
  xcframework_tarkistus || return 1
  echo "XCFRAMEWORK: ok"
}

# XCFramework rakennetaan, jos puuttuu tai ydin/src on uudempi (ScopesCore2 linkittää sen; T-45:n ScopesUI2 riippuu siitä)
xcframework_varmista() {
  vaihe "XCFramework (rakennetaan, jos puuttuu tai ydin/src on uudempi)"
  if ! mac 'f="$RAK/ydin/apple/ScopesSolmu.xcframework"; test -d "$f" && test -z "$(find "$RAK/ydin/src" -newer "$f" -print -quit)"' >/dev/null 2>&1; then
    t46 || return 1
  fi
}

t47() {
  xcframework_varmista || return 1
  swift_paketit 1 ScopesCore2 || return 1
}

t48() {
  t47 || return 1
  swift_paketit 1 ScopesUI2 || return 1
  xcodegen_molemmat || return 1
  vaihe "macOS build"; mac "cd \"\$RAK/macos\" && $(xmac build)" || return 1
  vaihe "iOS simulaattori build"; mac "cd \"\$RAK/ios\" && $(xios build)" || return 1
}

t49() {
  t48 || return 1
  vaihe "macOS UI-testit (näyttölukko)"; mac_avain "$(lukossa naytto "$naytto_ymp cd \"\$RAK/macos\" && $(xtesti xmac)")" || return 1
  vaihe "iOS UI-testit (simulaattorilukko)"; mac_avain "$(sim_lukossa "echo \"SIMULAATTORI: \$SIM\"; cd \"\$RAK/ios\" && $(xtesti xios)")" || return 1
}

# T-58 (ARK-17, S-9): transkriptipeilin ikkuna iOS-äpissä. Koeydin ja tunneli kuten t49 (koeydin_alku). T-48:n paketit (ScopesCore2-yksikkötestit
# PeiliTests mukana) ja käännökset, sitten koko iOS-UI-testikohde simulaattorilukon alla: PeiliUITests (pakotettu ikkuna ja koko peili)
# sekä T-49:n iOS-testit (RunkoUITests). macOS-UI-testit kuuluvat T-49:ään.
t58() {
  t48 || return 1
  vaihe "iOS UI-testit: PeiliUITests + T-49 (simulaattorilukko)"; mac_avain "$(sim_lukossa "echo \"SIMULAATTORI: \$SIM\"; cd \"\$RAK/ios\" && $(xtesti xios)")" || return 1
}

# Kaksi laitetta: macOS-äppi (näyttö) ja simulaattori yhtä aikaa, lukot järjestyksessä näyttö → simulaattori. Testin vertaisportit
# 18861/18862 ovat kiinteitä (KaksiLaitettaUITests.swift), joten näyttölukko pitää myös ne yhdellä ajolla kerrallaan.
t52() {
  t49 || return 1
  vaihe "kaksi laitetta (näyttö- ja simulaattorilukko)"
  mac 'test -f "$RAK/shared/testit/kaksi-laitetta.sh" || { echo "PUUTTUU: shared/testit/kaksi-laitetta.sh"; exit 1; }' || return 1
  mac_avain "$(lukossa naytto "$(sim_lukossa 'echo "SIMULAATTORI: $SIM"; SCOPES2_SIM="$SIM" bash "$RAK/shared/testit/kaksi-laitetta.sh"')")" || return 1
}

# T-71: näyttö hereillä. Skripti ajetaan Macilla näyttölukon alla (cwd macos/): äppi käynnistetään suoraan argumentilla ja tilapäisellä
# SCOPES2_DATA:lla → pmset -g assertions sisältää väitteen; lopetus (osascript quit bundle-id) → ei sisällä; käynnistys ilman
# argumenttia → ei sisällä. Äppi ei saa jäädä käyntiin (trap). Aitoa lopetusta ei korvata SIGTERMillä: osascript-virhe kaataa vaiheen.
t71_pmset() {
  cat <<'EOS'
app="$RAK/macos/build/Build/Products/Debug/ScopesV2Mac.app"; bin="$app/Contents/MacOS/ScopesV2Mac"
id=com.example.scopes-v2.mac; nimi="scopes-V2 näyttö hereillä"
test -x "$bin" || { echo "FAIL: $bin puuttuu"; exit 1; }
d=$(mktemp -d /tmp/scopes2-t71.XXXXXX); pid=""
trap 'if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; fi; rm -rf "$d"' EXIT
# odota_vaite <1 = väitteen pitää näkyä | 0 = ei saa näkyä> <sekuntia>
odota_vaite() {
  i=0
  while [ "$i" -lt "$2" ]; do
    pmset -g assertions > "$d/pmset.txt" 2>&1 || true
    # pmset tulostaa nimen ääkköset korvausmerkkeinä, joten väite tunnistetaan prosessista ja tyypistä: läsnäolo ajon pid:llä,
    # poissaolo mistä tahansa ScopesV2Mac-prosessista.
    if [ "$1" = 1 ]; then malli="pid $pid\(ScopesV2Mac\):.*PreventUserIdleDisplaySleep"; else malli="\(ScopesV2Mac\):.*PreventUserIdleDisplaySleep"; fi
    if grep -qE "$malli" "$d/pmset.txt"; then
      if [ "$1" = 1 ]; then return 0; fi
    else
      if [ "$1" = 0 ]; then return 0; fi
    fi
    sleep 1; i=$((i + 1))
  done
  return 1
}
lopeta() {
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
    osascript -e "tell application id \"$id\" to quit" >/dev/null 2>"$d/osa.log" || true
    sleep 1; i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then echo "FAIL: äppi ei lopettanut osascript quitilla: $(cat "$d/osa.log")"; exit 1; fi
  wait "$pid" 2>/dev/null || true; pid=""
}
SCOPES2_DATA="$d/data-a" SCOPES2_KUITTAUS=pois "$bin" -scopes2.naytto-hereilla YES >"$d/ulos-a.log" 2>&1 &
pid=$!
odota_vaite 1 30 || { echo "FAIL: argumentilla käynnistetty äppi ei pidä väitettä '$nimi' (pmset -g assertions)"; exit 1; }
echo "ok   väite näkyy, kun äppi käynnistetään argumentilla"
lopeta
odota_vaite 0 10 || { echo "FAIL: väite '$nimi' jäi äpin lopetuksen jälkeen"; exit 1; }
echo "ok   väite poistuu äpin lopetuksessa"
SCOPES2_DATA="$d/data-b" SCOPES2_KUITTAUS=pois "$bin" >"$d/ulos-b.log" 2>&1 &
pid=$!
sleep 10
kill -0 "$pid" 2>/dev/null || { echo "FAIL: äppi ei käynnistynyt ilman argumenttia"; exit 1; }
odota_vaite 0 1 || { echo "FAIL: väite '$nimi' ilman argumenttia (onko tallennettu scopes2.naytto-hereilla päällä?)"; exit 1; }
echo "ok   väitettä ei ole ilman argumenttia"
lopeta
echo "NAYTTO-HEREILLA: ok"
EOS
}

t71() {
  t48 || return 1
  vaihe "näyttö hereillä: pmset-väite (näyttölukko)"; mac_avain "$(lukossa naytto "cd \"\$RAK/macos\" && $(t71_pmset)")" || return 1
  vaihe "macOS UI-testi testKehitysOsio (näyttölukko)"
  mac_avain "$(lukossa naytto "cd \"\$RAK/macos\" && $(xtesti xmac ' -only-testing:ScopesV2MacUITests/RunkoUITests/testKehitysOsio')")" || return 1
  echo "KEHITYS-OSIO: ok"
}

# T-87 (ARK-19): Android-etäohjauksen ja palvelimen paneelit. Koeydin saa mock-adapterin (testit/mock-ohjaus.mjs): `--adapteri` mockiin
# (S-10, T-64) ja `--vanha` samaan mockiin, joten oikeaa 8787:ää, Androidia tai palvelinta ei tarvita eikä kosketa. Mock kirjaa toiminnot,
# UI-testit lukevat kirjan koeytimen kautta (GET /api/android/koe-loki). t87 ajaa T-48:n paketit (ScopesCore2 + OhjausTests, ScopesUI2,
# äppien käännökset) ja vain OhjausUITests-luokan näyttö- ja simulaattorilukossa kuten t49; T-49:n RunkoUITests tarvitsee 8787:n ja ajetaan erikseen.
mock_pid=""

# koeydin_ohjaus_alku: kuten koeydin_alku, mutta mock ensin ja ydin lipuilla --adapteri/--vanha mockiin; ei siementä eikä 8787-siltaa.
koeydin_ohjaus_alku() {
  local ydinbin rc
  ydinbin=$(koe_binaari)
  koe_polku_ok "$ydinbin" || { echo "KOEYDIN: binäärin polku viittaa target/release:iin ($ydinbin)" >&2; return 1; }
  koeydin_rakenna || return 1
  [ -x "$ydinbin" ] || { echo "KOEYDIN: ydinbinääri puuttuu ($ydinbin)" >&2; return 1; }
  PATH="/opt/homebrew/bin:$PATH" command -v node >/dev/null 2>&1 || { echo "MOCK-OHJAUS: node puuttuu" >&2; return 1; }
  if [ "$is_local" = 0 ]; then
    exec 8>/tmp/scopes2-koeportti.lock
    flock -w 120 8 || { echo "KOEYDIN: koeporttilukko varattu yli 2 min" >&2; return 1; }
  fi
  koeydin_ohjaus_kaynnista "$ydinbin"; rc=$?
  [ "$is_local" = 0 ] && exec 8>&-
  return $rc
}

koeydin_ohjaus_kaynnista() {
  local ydinbin="$1" i mock_portti=""
  koe_portti=$(koeportti_valitse) || { echo "KOEYDIN: vapaata koeporttia ei löytynyt" >&2; return 1; }
  koe_dir=$(mktemp -d /tmp/scopes2-koe.XXXXXX) || return 1
  chmod 700 "$koe_dir"; mkdir "$koe_dir/data"
  cp "$ydinbin" "$koe_dir/solmu" || return 1
  (umask 077; head -c 48 /dev/urandom | base64 | tr -d '=+/\n' > "$koe_dir/avain")
  avain_tiedosto="$koe_dir/avain"
  # Mock: oma vapaa portti (--portti 0), sammuu itse, kun koeytimen hakemisto (avain) poistuu; siemennys koeytimeen kun ydin vastaa.
  ( exec 9>&- 8>&- 7>&- 6<&-
    # GATE_OHJAUS_MOCK/GATE_OHJAUS_LISA (T-88 (6), scopes2 adapteri): korvaava välittäjä, joka välittää toiminnot oikealle koeadapterille.
    PATH="/opt/homebrew/bin:$PATH" exec node "${GATE_OHJAUS_MOCK:-$tama/testit/mock-ohjaus.mjs}" --avain-tiedosto "$koe_dir/avain" --portti 0 \
      --portti-tiedosto "$koe_dir/mock-portti" --elinkaari "$koe_dir/avain" --ydin "http://127.0.0.1:$koe_portti" ${GATE_OHJAUS_LISA:-} ) >"$koe_dir/mock-loki" 2>&1 &
  mock_pid=$!
  for i in $(seq 1 30); do
    [ -s "$koe_dir/mock-portti" ] && { mock_portti=$(tr -d '\n' < "$koe_dir/mock-portti"); break; }
    kill -0 "$mock_pid" 2>/dev/null || break
    sleep 0.5
  done
  case "$mock_portti" in ''|*[!0-9]*) echo "MOCK-OHJAUS: ei käynnistynyt ($(head -c 300 "$koe_dir/mock-loki" 2>/dev/null))" >&2; return 1 ;; esac
  case "$mock_portti" in 8787|8797|8798|18795|18796|18797) echo "MOCK-OHJAUS: portti $mock_portti on varattu" >&2; return 1 ;; esac
  ( ulimit -d "${SCOPES2_YDIN_DATARAJA-1572864}" 2>/dev/null
    exec 9>&- 8>&- 7>&- 6<&- "$koe_dir/solmu" --portti "$koe_portti" --data "$koe_dir/data" --avain "$koe_dir/avain" \
      --vanha "http://127.0.0.1:$mock_portti" --vanha-avain "$koe_dir/avain" --adapteri "http://127.0.0.1:$mock_portti" ) >"$koe_dir/loki" 2>&1 &
  koe_pid=$!
  for i in $(seq 1 30); do
    curl -fsS -m 2 "http://127.0.0.1:$koe_portti/api/terveys" >/dev/null 2>&1 && break
    kill -0 "$koe_pid" 2>/dev/null || { echo "KOEYDIN: ydin sammui ($(head -c 300 "$koe_dir/loki" 2>/dev/null))" >&2; return 1; }
    sleep 1
  done
  curl -fsS -m 2 "http://127.0.0.1:$koe_portti/api/terveys" >/dev/null 2>&1 || { echo "KOEYDIN: ei vastaa (portti $koe_portti)" >&2; return 1; }
  # Ydin hakee adapterin reitit käynnistyksessä: odotetaan, että testiohjaus (mockin loki) kulkee ytimen läpi X-Lahde: adapteri.
  (umask 077; printf 'Authorization: Bearer %s\n' "$(cat "$koe_dir/avain")" > "$koe_dir/otsikko")
  for i in $(seq 1 20); do
    curl -fsS -m 3 -D "$koe_dir/vastausotsikot" -o /dev/null -H "@$koe_dir/otsikko" "http://127.0.0.1:$koe_portti/api/android/koe-loki" 2>/dev/null \
      && grep -qi '^x-lahde: *adapteri' "$koe_dir/vastausotsikot" && { echo "KOEYDIN: portti $koe_portti pid $koe_pid, mock-ohjaus portti $mock_portti"; return 0; }
    sleep 1
  done
  echo "KOEYDIN: ydin ei välitä adapterille (portti $koe_portti → mock $mock_portti; --adapteri puuttuu ytimestä, T-64?)" >&2
  return 1
}

# xtesti_vain <xmac|xios> <Kohde/Luokka>: kuten xtesti, mutta vain yksi testiluokka (-only-testing).
xtesti_vain() {
  printf 'rm -rf %s && { %s -only-testing:%s -resultBundlePath %s || { xcrun xcresulttool get test-results summary --path %s --compact | head -c 8000; echo; exit 1; }; }' \
    "$xtulos" "$($1 test)" "$2" "$xtulos" "$xtulos"
}

# OhjausUITests ajetaan vain tällä etuliitteellä; muualla (T-49:n koeydin ilman mockia) ne ohittavat itsensä (XCTSkip).
ohjaus_ymp='export TEST_RUNNER_SCOPES2_OHJAUS=mock; '

t87() {
  t48 || return 1
  vaihe "macOS OhjausUITests (näyttölukko)"
  mac_avain "$(lukossa naytto "$ohjaus_ymp""cd \"\$RAK/macos\" && $(xtesti_vain xmac ScopesV2MacUITests/OhjausUITests)")" || return 1
  vaihe "iOS OhjausUITests (simulaattorilukko)"
  mac_avain "$(sim_lukossa "$ohjaus_ymp""echo \"SIMULAATTORI: \$SIM\"; cd \"\$RAK/ios\" && $(xtesti_vain xios ScopesV2UITests/OhjausUITests)")" || return 1
  [ -n "$mock_pid" ] && { kill "$mock_pid" 2>/dev/null; wait "$mock_pid" 2>/dev/null; mock_pid=""; }
  echo "OHJAUS: ok"
}

# T-97 (S-9f-asiakas): vain ScopesCore2:n swift build + swift test ilman koeydintä ja avainta (SolmuTests ohittaa itsensä); ei UI-lukkoja, ei 8787:ää.
t97() {
  xcframework_varmista || return 1
  swift_paketit 0 ScopesCore2 || return 1
  echo "PEILI-RAAKA: ok"
}

puhdista() { koeydin_loppu; mac_lukko_vapauta; }   # koeydin ensin: Mac-lukon virhe ei jätä sitä käyntiin

aja_testit() {
  local id="$1" ydin=1 rc
  # T-45 siirtää myös ydinlähteet (ScopesCore2/ScopesUI2 linkittävät XCFrameworkin): Mac-lukko estää päällekkäisen rakennuksen.
  lukko || return $?
  trap puhdista EXIT
  trap 'puhdista; exit 130' INT TERM
  mac_lukko_ota || return 1
  case "$id" in T-47|T-48|T-49|T-52|T-58|T-71) koeydin_alku || return 1 ;; esac
  case "$id" in T-87) koeydin_ohjaus_alku || return 1 ;; esac
  siirto "$ydin" || return 1
  case "$id" in
    T-45) t45 ;; T-46) t46 ;; T-47) t47 ;; T-48) t48 ;; T-49) t49 ;; T-52) t52 ;; T-58) t58 ;; T-71) t71 ;; T-87) t87 ;; T-97) t97 ;;
  esac
  rc=$?
  puhdista
  return $rc
}

tunnettu() { case "$1" in T-45|T-46|T-47|T-48|T-49|T-52|T-58|T-71|T-87|T-97) return 0 ;; *) return 1 ;; esac; }

tunnelitesti() { # tarvitsee Macin ja koeytimen: koeydin, tunneli ja Mac-lukot syntyvät ja sulkeutuvat (onnistuminen ja virhe)
  local virheet=0 rc koko ulos portti dir pid mp lk toinen
  odota() { if [ "$2" = "$3" ]; then echo "ok   $1 → $3"; else echo "FAIL $1: odotettu $2, saatiin $3" >&2; virheet=1; fi; }
  lukko || return 3
  trap puhdista EXIT
  mac_lukko_ota >/dev/null; odota "Mac-lukko saatu" 0 $?
  mp=$mac_portti; lk=$(ajolukko_mac)
  case "$mp" in 189[01][0-9]) echo "ok   Mac-portti $mp porttipaikoista 18900–18919" ;; *) echo "FAIL: Mac-portti '$mp' ei ole porttipaikka" >&2; virheet=1 ;; esac
  local terve="curl -fsS -m 3 127.0.0.1:$mp/api/terveys >/dev/null 2>&1"   # exit 7 = yhteys evätty = tunneli kiinni
  local ssh_ajaa="pgrep -f '[${mp:0:1}]${mp:1}:127.0.0.1:' >/dev/null"
  ( ssh -o BatchMode=yes mac "lockf -t 1 $lk true" >/dev/null 2>&1 ); odota "saman ajon toinen lukonottaja saa EX_TEMPFAIL" 75 $?
  # V-605: toinen ajo saa oman lukkonsa ja eri porttipaikan heti (stdin /dev/null → lukot vapautuvat heti kuittauksen jälkeen).
  toinen=$(ssh -o BatchMode=yes mac "$(ajolukko_skripti "\${MAC_PROJ:-\$HOME/Projects}/scopes_2/scopes2-rakennus-tunnelitesti-2/.lukko")" </dev/null 2>/dev/null | head -1)
  case "$toinen" in "LUKITTU $mp"|"") echo "FAIL: rinnakkainen ajo: '${toinen:-ei kuittausta}' (oma $mp)" >&2; virheet=1 ;; "LUKITTU "*) echo "ok   rinnakkainen ajo sai oman lukon ja porttipaikan (${toinen#LUKITTU }, oma $mp)" ;; *) echo "FAIL: rinnakkainen ajo: $toinen" >&2; virheet=1 ;; esac
  # Jaettu näyttölukko: varattuna toinen ottaja saa EX_TEMPFAIL; simulaattorilukko valitsee seuraavan vapaan simulaattorin.
  mac "$(lukossa naytto 'sleep 8')" & local np=$!
  sleep 3
  mac 'lockf -t 1 "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-lukot/naytto.lukko" true' >/dev/null 2>&1; odota "näyttölukko varattuna → EX_TEMPFAIL" 75 $?
  wait "$np"; odota "näyttölukon haltija valmis" 0 $?
  mac "$(sim_lukossa 'sleep 8')" & np=$!
  sleep 3
  ulos=$(mac "$(sim_lukossa 'echo "$SIM"')" 2>&1); rc=$?
  wait "$np"
  if [ "$rc" = 0 ] && [ -n "$ulos" ] && [ "$ulos" != "${simit%%|*}" ]; then echo "ok   simulaattorilukko: ensimmäinen varattu → $ulos"; else echo "FAIL: simulaattorilukko: rc $rc, '$ulos' (ensimmäinen ${simit%%|*})" >&2; virheet=1; fi
  koeydin_alku >/dev/null; odota "koeydin käynnistyy" 0 $?
  portti=$koe_portti; dir=$koe_dir; pid=$koe_pid
  case "$portti" in 8787|8797|18795|18796|18797) echo "FAIL: koeportti $portti on varattu" >&2; virheet=1 ;; *) echo "ok   koeportti $portti ei ole varattu" ;; esac
  curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$portti/api/skoopit" | grep -q '^401$'; odota "koeydin: ei avainta → 401" 0 $?
  koko=$(wc -c < "$koe_dir/avain"); [ "$koko" -gt 30 ] && echo "ok   kertakäyttöavain luotu ($koko tavua)" || { echo "FAIL: avain liian lyhyt" >&2; virheet=1; }
  mac "$terve"; odota "tunneli kiinni ennen" 7 $?
  mac_tunneli "$terve && test \"\$SCOPES2_VERTAINEN\" = http://127.0.0.1:$mp && test \"\$TEST_RUNNER_SCOPES2_VERTAINEN\" = \"\$SCOPES2_VERTAINEN\" && echo TUNNELI-AUKI"; rc=$?
  odota "tunneli auki testin aikana, SCOPES2_VERTAINEN = ajon portti (exit 0)" 0 $rc
  mac "$terve"; odota "tunneli kiinni onnistuneen ajon jälkeen" 7 $?
  mac "$ssh_ajaa"; odota "ssh -L -prosessi poistunut onnistuneen ajon jälkeen" 1 $?
  mac_tunneli "$terve && exit 7" >/dev/null; rc=$?
  odota "virhe välittyy (exit 7)" 7 $rc
  mac "$terve"; odota "tunneli kiinni virheajon jälkeen" 7 $?
  mac "$ssh_ajaa"; odota "ssh -L -prosessi poistunut virheajon jälkeen" 1 $?
  ulos=$(mac_avain 'test -n "$SCOPES2_AVAIN" && test -n "$TEST_RUNNER_SCOPES2_AVAIN" && curl -s -m 5 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $SCOPES2_AVAIN" "$SCOPES2_VERTAINEN/api/skoopit"' 2>&1); rc=$?
  odota "koeytimen kertakäyttöavain ympäristössä ja tunnelin läpi" 0 $rc
  case "$ulos" in 200|502|504) echo "ok   /api/skoopit koeavaimella tunnelin läpi → $ulos" ;; *) echo "FAIL: /api/skoopit tunnelin läpi: ${ulos:0:60}" >&2; virheet=1 ;; esac
  puhdista
  kill -0 "$pid" 2>/dev/null; odota "koeydin sammui" 1 $?
  curl -s -m 2 "http://127.0.0.1:$portti/api/terveys" >/dev/null; odota "koeportti suljettu" 7 $?
  [ -e "$dir" ]; odota "koeytimen data ja avain poistettu" 1 $?
  ( ssh -o BatchMode=yes mac "lockf -t 1 $lk true && lockf -t 1 \${MAC_PROJ:-\$HOME/Projects}/scopes_2/scopes2-lukot/portti-$mp.lukko true" >/dev/null 2>&1 ); odota "Mac-lukko ja porttipaikka vapautuivat" 0 $?
  [ "$virheet" = 0 ] && echo "TUNNELITESTI VIHREÄ" || echo "TUNNELITESTI PUNAINEN" >&2
  return $virheet
}

itsetesti() {
  local tmp rc rc2 virheet=0 f id ulos n i
  local koe_vanha="$juuri/scopes/KOE.tmp" koe_may="$juuri/scopes2/shared/KOE.tmp" koe_muu="$juuri/scopes2/KOE.tmp" koe_ydin="$juuri/scopes2/ydin/KOE.tmp"
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -f '$koe_vanha' '$koe_may' '$koe_muu' '$koe_ydin'; rm -rf '$tmp'" EXIT
  for f in "$koe_vanha" "$koe_may" "$koe_muu" "$koe_ydin"; do
    [ -e "$f" ] && { echo "VIRHE: $f on jo olemassa; itsetesti ei aja" >&2; exit 1; }
  done
  odota() { # <nimi> <odotettu exit> <todellinen exit>
    if [ "$2" = "$3" ]; then echo "ok   $1 → $3"; else echo "FAIL $1: odotettu $2, saatiin $3" >&2; virheet=1; fi
  }

  bash "$0" EI-OLE-ID >/dev/null 2>&1; odota "tuntematon ID" 1 $?

  ( aja sh -c "echo koe > '$koe_muu'" ) 2>/dev/null; rc=$?
  odota "ajon aikana luotu tiedosto Apple-puiden ulkopuolella (scopes2/KOE.tmp)" 2 $rc
  ( aja sh -c "echo muutos >> '$koe_muu'" ) 2>/dev/null; rc=$?
  rm -f "$koe_muu"
  odota "ajon aikana muutettu, jo ennestään muuttunut tiedosto Apple-puiden ulkopuolella" 2 $rc

  ( aja sh -c "echo koe > '$koe_ydin'" ) 2>/dev/null; rc=$?
  rm -f "$koe_ydin"
  odota "ajon aikana luotu scopes2/ydin/KOE.tmp (ei Apple-puu)" 2 $rc

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
  odota "ajon aikana muutos may-polussa (scopes2/shared/)" 0 $rc

  ( aja false ) 2>/dev/null; rc=$?
  odota "punainen komento ilman aitaa" 1 $rc

  koe_polku_ok "$(koe_binaari)" && koe_polku_ok "$(koe_kohde)"; odota "koeytimen polku ei viittaa target/release:iin" 0 $?
  koe_polku_ok "$juuri/scopes2/ydin/target/release/scopes-solmu"; odota "tarkistus kaatuu target/release-polulle" 1 $?
  koe_polku_ok "$juuri/scopes2/ydin/target/release"; odota "tarkistus kaatuu target/release-hakemistolle" 1 $?
  grep -nE 'target/release' "$0" | grep -vE 'koe_polku_ok|^[0-9]+:#|echo |viittaa|case "\$1"' >/dev/null; odota "koeydin_alku ei viittaa target/release:iin" 1 $?

  # V-605: ajon nimi, jaettujen lukkojen lainaus ja simulaattorin valinta (lockf, mkdir ja lsof korvattu funktioilla; ei Macia).
  [ "$(ajo_nimi --tunnelitesti)/$(ajo_nimi T-49)/$(ajo_nimi 'a b/c')" = "tunnelitesti/T-49/a_b_c" ]; odota "ajon nimi" 0 $?
  ajo_nimi "" >/dev/null; odota "tyhjä ajon nimi kaatuu" 1 $?
  [ "$(ajo_nimi '../x')" = ".._x" ] && ! ajo_nimi '../x' | grep -q /; odota "ajon nimessä ei kauttaviivaa" 0 $?
  ulos=$( lockf() { shift 3; "$@"; }; mkdir() { :; }; export RAK=/koe; eval "$(lukossa naytto 'echo "a  b" "$RAK" $((1 + 1))')" )
  [ "$ulos" = "a  b /koe 2" ]; odota "lukossa: skripti lainattu ja RAK periytyy ($ulos)" 0 $?
  ( lockf() { shift 3; "$@"; }; mkdir() { :; }; eval "$(lukossa cargo 'exit 3')" ); odota "lukossa: skriptin exit välittyy" 3 $?
  lukossa tuntematon true >/dev/null 2>&1; odota "lukossa: tuntematon lukko kaatuu" 1 $?
  # shellcheck disable=SC2317
  vale_lockf() { [ "$1" = -s ] && shift; case "$3" in *sim-iPhone_15_Pro*) [ "$2" = 0 ] && [ -z "${KAIKKI_VAPAAT:-}" ] && return 75 ;; *) [ -n "${KAIKKI_VARATTU:-}" ] && [ "$2" = 0 ] && return 75 ;; esac; shift 3; "$@"; }
  ulos=$( simit="iPhone 15 Pro|iPhone 17 Pro|iPhone 17"; lockf() { vale_lockf "$@"; }; mkdir() { :; }; eval "$(sim_lukossa 'echo "$SIM"')" )
  [ "$ulos" = "iPhone 17 Pro" ]; odota "sim_lukossa: ensimmäinen varattu → seuraava ($ulos)" 0 $?
  ulos=$( simit="iPhone 15 Pro|iPhone 17 Pro"; KAIKKI_VAPAAT=1; lockf() { vale_lockf "$@"; }; mkdir() { :; }; eval "$(sim_lukossa 'echo "$SIM"')" )
  [ "$ulos" = "iPhone 15 Pro" ]; odota "sim_lukossa: vapaa ensimmäinen ($ulos)" 0 $?
  ulos=$( simit="iPhone 15 Pro|iPhone 17 Pro"; KAIKKI_VARATTU=1; lockf() { vale_lockf "$@"; }; mkdir() { :; }; eval "$(sim_lukossa 'echo "$SIM"')" )
  [ "$ulos" = "iPhone 15 Pro" ]; odota "sim_lukossa: kaikki varattu → odottaa ensimmäistä ($ulos)" 0 $?
  ( simit="iPhone 15 Pro"; KAIKKI_VAPAAT=1; lockf() { vale_lockf "$@"; }; mkdir() { :; }; eval "$(sim_lukossa 'exit 4')" ); odota "sim_lukossa: skriptin exit välittyy" 4 $?
  ( simit=""; sim_lukossa true ) >/dev/null 2>&1; odota "sim_lukossa: tyhjä GATE_SIMIT kaatuu" 1 $?
  ulos=$(ajolukko_skripti '${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus-T-49/.lukko')
  case "$ulos" in *'lockf -t 1800 "${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus-T-49/.lukko"'*'p=18900;'*'-le 18919'*'portti-$p.lukko'*) rc=0 ;; *) rc=1 ;; esac
  odota "ajolukko: ajon lukko ja porttipaikat 18900–18919" 0 $rc
  ulos=$( is_local=0; mac_portti=18905; koe_portti=18800; tunneli_koodi )
  case "$ulos" in *'-L 18905:127.0.0.1:18800 '*'SCOPES2_VERTAINEN=http://127.0.0.1:18905 TEST_RUNNER_SCOPES2_VERTAINEN=http://127.0.0.1:18905'*) rc=0 ;; *) rc=1 ;; esac
  printf '%s' "$ulos" | grep -q 18797 && rc=1
  odota "tunneli: ajon Mac-portti, ei 18797" 0 $rc
  ulos=$( mac_portti=""; tunneli_koodi ); case "$ulos" in *"exit 1"*) rc=0 ;; *) rc=1 ;; esac; odota "tunneli ilman Mac-porttia kaatuu" 0 $rc
  case "$xb_ios" in *'name=$SIM"'*) rc=0 ;; *) rc=1 ;; esac; odota "iOS-kohde lukee simulaattorin \$SIM:stä" 0 $rc
  [ "$( mac_portti=18903; silta_portti )" = 19003 ]; odota "Darwinin 8787-silta = Mac-portti + 100" 0 $?
  case "$rak_mac" in '${MAC_PROJ:-$HOME/Projects}/scopes_2/scopes2-rakennus-'*) rc=0 ;; *) rc=1 ;; esac; odota "Macin rakennushakemisto ajokohtainen ($rak_mac)" 0 $rc

  # T-62: siemen ilman verkkoa (curl korvattu funktiolla, ei tunnistetietoja): testidata, peilirunko ja koeydin_siemen:n haarat.
  local sd="$siemen_hakemisto" tunnus
  [ -s "$sd/siemen-transkripti.jsonl" ] && [ -z "$(tail -c1 "$sd/siemen-transkripti.jsonl")" ] && ! grep -q $'\r' "$sd/siemen-transkripti.jsonl"
  odota "siemen: transkripti päättyy rivinvaihtoon, ei CR:ää" 0 $?
  tunnus=$(grep -o '"sessionId":"[^"]*"' "$sd/siemen-transkripti.jsonl" | sort -u)
  [ "$tunnus" = "\"sessionId\":\"$siemen_istunto\"" ]; odota "siemen: transkriptin sessionId = kiinteä istunto" 0 $?
  n=$(wc -l < "$sd/siemen-transkripti.jsonl" | tr -d ' '); [ "$n" -ge 10 ] && [ "$n" -le 120 ]; odota "siemen: transkriptin rivejä $n (10–120)" 0 $?
  grep -q "\"transkripti\":\"koe-siemen/$siemen_istunto.jsonl\"" "$sd/siemen-istunnot.json" \
    && grep -q "\"istunto\":\"$siemen_istunto\"" "$sd/siemen-istunnot.json" \
    && grep -q "\"skooppi\":\"$siemen_skooppi\"" "$sd/siemen-istunnot.json" \
    && grep -q '"pakattu":false' "$sd/siemen-istunnot.json" && grep -q '"laite":"koe-siemen"' "$sd/siemen-istunnot.json" \
    && grep -q '"laite":"koe-siemen","sisalto":\[\]' "$sd/siemen-agy.json"
  odota "siemen: istunto- ja agy-runko (test, kiinteä uuid, avoin, laite koe-siemen)" 0 $?
  if command -v jq >/dev/null 2>&1; then
    jq -e . "$sd/siemen-istunnot.json" "$sd/siemen-agy.json" >/dev/null; odota "siemen: runkotiedostot ovat JSONia" 0 $?
    mkdir -p "$tmp/koe"; printf '%s\n' 'a "b" \c' '{"x":"ä\"y"}' > "$tmp/rivit.jsonl"
    siemen_peili_runko "$tmp/rivit.jsonl" "$tmp/peili.json"
    jq -e '.rivit == ["a \"b\" \\c","{\"x\":\"ä\\\"y\"}"] and .offset == 0' "$tmp/peili.json" >/dev/null; odota "siemen: peilirunko escapoi rivit" 0 $?
    siemen_peili_runko "$sd/siemen-transkripti.jsonl" "$tmp/peili.json"
    [ "$(jq -r '.rivit[]' "$tmp/peili.json" | siemen_sha256 /dev/stdin)" = "$(jq -r .sha256 "$tmp/peili.json")" ] \
      && [ "$(jq '.rivit | length' "$tmp/peili.json")" = "$n" ] && [ "$(jq -r .tiedosto "$tmp/peili.json")" = "koe-siemen/$siemen_istunto.jsonl" ]
    odota "siemen: peilirungon sha256 = rivit + \\n, rivimäärä ja tiedosto" 0 $?
  else
    echo "ohi  siemen: jq puuttuu, JSON-tarkistukset ohitettu"
  fi
  mkdir -p "$tmp/koe"; printf 'koeavain-itsetesti-1234567890' > "$tmp/koe/avain"
  siemen_curl_tynka() { # curl-korvike: tallentaa argumentit; vastaus URL:n (viimeinen argumentti) mukaan
    local url="" a
    printf '%s\n' "$*" >> "$tmp/curl-argv"
    for a in "$@"; do url=$a; done
    case "$url" in
      */api/skoopit/test/viestit) i=0; printf '{"viestit":['; while [ "$i" -lt "${TYNKA_VIESTEJA:-12}" ]; do printf '{"rooli":"agentti","teksti":"x"},'; i=$((i + 1)); done; printf '{"rooli":"kayttaja"}]}' ;;
      */api/skoopit) [ -n "${TYNKA_SKOOPIT:-}" ] || return 22; printf '[{"nimi":"%s","aika":null}]' "$TYNKA_SKOOPIT" ;;
    esac
    return 0
  }
  siemen_ajo() { ( curl() { siemen_curl_tynka "$@"; }; koe_dir="$tmp/koe"; koe_portti=1; GATE_SIEMEN_ODOTUS=0; koeydin_siemen ) ; }
  : > "$tmp/curl-argv"
  ulos=$(TYNKA_SKOOPIT=test siemen_ajo 2>&1); rc=$?
  [ "$ulos" = "SIEMEN: test 13 viestiä" ]; odota "siemen: onnistuu ja tulostaa viestimäärän ($ulos)" 0 $?
  odota "siemen: koeydin_siemen exit 0" 0 $rc
  ! grep -q koeavain-itsetesti "$tmp/curl-argv" && grep -q -- '-H @' "$tmp/curl-argv"; odota "siemen: avain ei kulje curlin argv:ssa (otsikko tiedostosta)" 0 $?
  [ "$(grep -c 'api/lahde/istunnot\|api/lahde/agy\|api/peili' "$tmp/curl-argv")" = 3 ]; odota "siemen: kolme POSTia (lahde/istunnot, lahde/agy, peili)" 0 $?
  ulos=$(TYNKA_SKOOPIT=muu siemen_ajo 2>&1); rc=$?
  [ "$ulos" = "SIEMEN: ei (test ei sillan listalla)" ]; odota "siemen: test puuttuu listalta → viesti ($ulos)" 0 $?
  odota "siemen: test puuttuu listalta → exit 1" 1 $rc
  ulos=$(TYNKA_SKOOPIT= siemen_ajo 2>&1); rc=$?
  [ "$ulos" = "SIEMEN: ei (sillan skooppilista ei vastaa)" ]; odota "siemen: silta ei vastaa → viesti ($ulos)" 0 $?
  odota "siemen: silta ei vastaa → exit 1" 1 $rc
  ulos=$(TYNKA_SKOOPIT=test TYNKA_VIESTEJA=130 siemen_ajo 2>&1); rc=$?
  case "$ulos" in "SIEMEN: ei (viestimäärä 131 ei väliltä 10–120)") rc2=0 ;; *) rc2=1 ;; esac
  odota "siemen: liikaa viestejä → ei ($ulos)" 0 $rc2
  odota "siemen: liikaa viestejä → exit 1" 1 $rc

  # T-87: xtesti_vain rajaa testiluokkaan; mock-ohjaus.mjs kuuntelee, julkaisee reitit ja kirjaa toiminnot (node, ei Macia eikä oikeita laitteita).
  ulos=$(xtesti_vain xmac ScopesV2MacUITests/OhjausUITests)
  case "$ulos" in *' -only-testing:ScopesV2MacUITests/OhjausUITests -resultBundlePath '*) rc=0 ;; *) rc=1 ;; esac
  odota "xtesti_vain: vain OhjausUITests ennen resultBundlePath:ia" 0 $rc
  if command -v node >/dev/null 2>&1; then
    local mpid mp2=""
    node --check "$tama/testit/mock-ohjaus.mjs"; odota "mock-ohjaus.mjs on kelvollista JavaScriptia" 0 $?
    printf 'itsetesti-avain-1234567890-1234567890-12' > "$tmp/mock-avain"
    node "$tama/testit/mock-ohjaus.mjs" --avain-tiedosto "$tmp/mock-avain" --portti 0 --portti-tiedosto "$tmp/mock-portti" \
      --elinkaari "$tmp/mock-avain" >"$tmp/mock-loki" 2>&1 &
    mpid=$!
    for i in $(seq 1 40); do [ -s "$tmp/mock-portti" ] && break; sleep 0.25; done
    mp2=$(tr -d '\n' < "$tmp/mock-portti" 2>/dev/null)
    case "$mp2" in ''|*[!0-9]*) rc=1 ;; *) rc=0 ;; esac
    odota "mock-ohjaus: käynnistyy omaan porttiin ($mp2)" 0 $rc
    if [ "$rc" = 0 ]; then
      curl -fsS -m 3 "http://127.0.0.1:$mp2/api/terveys" | grep -q '"POST /api/palvelin/\*"' && curl -fsS -m 3 "http://127.0.0.1:$mp2/api/terveys" | grep -q '"GET /api/android/ruutu"'
      odota "mock-ohjaus: terveys julkaisee android- ja palvelin-reitit" 0 $?
      curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$mp2/api/android" | grep -q '^401$'; odota "mock-ohjaus: ei avainta → 401" 0 $?
      curl -fsS -m 3 -X POST -H 'Authorization: Bearer itsetesti-avain-1234567890-1234567890-12' -d '{"x":0.5,"y":0.25}' "http://127.0.0.1:$mp2/api/android/napauta" >/dev/null
      curl -fsS -m 3 -H 'Authorization: Bearer itsetesti-avain-1234567890-1234567890-12' "http://127.0.0.1:$mp2/api/android/koe-loki" | grep -q '"polku":"/api/android/napauta"'
      odota "mock-ohjaus: kirjaa saamansa toiminnon" 0 $?
    fi
    kill "$mpid" 2>/dev/null; wait "$mpid" 2>/dev/null
  else
    echo "ohi  mock-ohjaus: node puuttuu, mock-tarkistukset ohitettu"
  fi

  for id in T-45 T-46 T-47 T-48 T-49 T-52 T-58 T-71 T-87 T-97; do
    tunnettu "$id" || { echo "FAIL: $id ei tunnettu" >&2; virheet=1; }
  done
  if tunnettu EI-OLE-ID; then echo "FAIL: EI-OLE-ID tunnettu" >&2; virheet=1; fi

  [ "$virheet" = 0 ] && echo "ITSETESTI VIHREÄ" || echo "ITSETESTI PUNAINEN" >&2
  return $virheet
}

id=${1:-}
if [ -z "$id" ]; then
  echo "Käyttö: bash scopes2/shared/gate.sh <ID> | --itsetesti" >&2
  exit 1
fi
if [ "$id" = "--itsetesti" ]; then
  itsetesti
  exit $?
fi
if [ "$id" = "--tunnelitesti" ]; then
  [ "$is_local" = 1 ] && { echo "VIRHE: --tunnelitesti ajetaan palvelimelta (Darwinilla ei tunnelia)" >&2; exit 1; }
  tunnelitesti
  exit $?
fi
if ! tunnettu "$id"; then
  echo "VIRHE: tuntematon ID $id" >&2
  exit 1
fi
echo "=== PORTTI: $id ==="
aja aja_testit "$id"
rc=$?
if [ $rc = 0 ]; then echo "PORTTI VIHREÄ: $id"; else echo "PORTTI PUNAINEN: $id (exit $rc)" >&2; fi
exit $rc
