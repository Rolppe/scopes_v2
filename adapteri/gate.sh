#!/usr/bin/env bash
# gate.sh - scopes2-adapterin verifiointiportti (T-24).
#   bash scopes2/adapteri/gate.sh <ID>          ajaa ID:n testit ja aidat
#   bash scopes2/adapteri/gate.sh --itsetesti   todistaa, että portti kaatuu oikein
# Exit: 0 vihreä, 1 tuntematon ID tai testi punainen, 2 aita (puu muuttui ajon aikana sallitun alueen ulkopuolella).
#
# Aidat vertaavat lähtötilaan (käyttäjän päätös T-24): ajon alussa tallennetaan `git status --porcelain` riveinä
# "XY polku tiiviste", ja portti kaatuu vain riveistä, jotka ilmestyivät tai muuttuivat ajon aikana. Päätyöpuussa voi
# olla muiden keskustelujen keskeneräisiä muutoksia, myös scopes/-alla; ne eivät punaa porttia.
#   scopes/-aita: uusi tai muuttunut rivi scopes/-alla → "VANHA PUU MUUTTUNUT", exit 2 (K-9).
#   GATE_MAY-aita: uusi tai muuttunut rivi muualla kuin GATE_MAY-etuliitteissä (välilyönnein erotettu,
#   oletus scopes2/adapteri/) → exit 2.
set -uo pipefail

tama="$(cd "$(dirname "$0")" && pwd)"
juuri="$(git -C "$tama" rev-parse --show-toplevel)" || { echo "VIRHE: ei git-puuta" >&2; exit 1; }
GATE_MAY=${GATE_MAY:-scopes2/adapteri/}
# Node 22 kuten kaynnista.sh: PATHin /usr/bin/node 20 (ssh-kuori) ei tunne node:sqlite-moduulia, jota adapteri tarvitsee.
node22=$HOME/.local/opt/node-v22.23.3-linux-arm64/bin/node
if [ -x "$node22" ] && [ "$("${NODE:-node}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then NODE=$node22; fi
export NODE=${NODE:-node}
adapteri=scopes2/adapteri

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

# T-63-G: toimintoportin tapaukset. T-66…T-69 kirjattu valmiiksi (portti punainen, kunnes tehtävä tuo oman testitiedostonsa).
# Testien toimintoportti (P-6) 18822; GATE_TOIMINTOPORTTI ohittaa. Testit lukevat sen ympäristöstä.
export GATE_TOIMINTOPORTTI=${GATE_TOIMINTOPORTTI:-18822}
T63_TESTIT="$adapteri/toiminnot/palvelin.test.mjs $adapteri/vertailu/fixturet.test.mjs"

# Tuontitarkistus (ARK-16): adapterin ajonaikainen koodi ei tuo mitään scopes/-polusta; vertailu/ on rajattu pois (tallenna-vanha.mjs).
# Kommentit (rivin loppu // …) eivät ole tuonteja. Sallitut tiedosto:rivit-alku-loppu. T-65 tyhjensi transkriptit/lahde-poikkeukset;
# jäljellä vain vanhasta/agy-istunto.mjs:470 (synkka 47b8ccaf 28.10.2026): kopion merkkijonovakio (Macin vanhan moduulin polku, jonka ssh-komento ajaa Macilla),
# ei tuonti; kopion pitää säilyä tavulleen alkuperäisenä (t65-diff), joten riviä ei voi muuttaa.
SALLITUT_TUONNIT="scopes2/adapteri/vanhasta/agy-istunto.mjs:470-470"
tuontitarkistus() {
  local hakemisto="${1:-$juuri}" osuma rivi p r teksti sallittu e alku loppu rc=0
  osuma=$(cd "$hakemisto" && grep -rnE "from ['\"][./]*scopes/|scopes/palvelu" scopes2/adapteri --include='*.mjs' --exclude-dir=vertailu | awk -F: '{
    p=$1; r=$2; t=substr($0, length(p)+length(r)+3); sub(/\/\/.*$/, "", t)
    if (t ~ /from [\047"][.\/]*scopes\/|scopes\/palvelu/) print p ":" r ":" t }')
  while IFS= read -r rivi; do
    [ -n "$rivi" ] || continue
    p=${rivi%%:*}; r=${rivi#*:}; r=${r%%:*}; teksti=${rivi#*:*:}
    sallittu=0
    for e in $SALLITUT_TUONNIT; do
      alku=${e##*:}; alku=${alku%-*}; loppu=${e##*-}
      [ "${e%%:*}" = "$p" ] && [ "$r" -ge "$alku" ] && [ "$r" -le "$loppu" ] && sallittu=1
    done
    [ $sallittu = 1 ] || { echo "TUONTI: $p:$r:$teksti" >&2; rc=1; }
  done <<< "$osuma"
  return $rc
}

testit() {
  case "$1" in
    T-24) echo "$adapteri/transkriptit.test.mjs $adapteri/peili.test.mjs $adapteri/kuorma.test.mjs $adapteri/siltavertailu.test.mjs $adapteri/peilivertailu.test.mjs" ;;
    T-29) echo "$adapteri/lahde.test.mjs" ;;
    T-25) echo "" ;; # T-25 ei aja node --test -tiedostoja vaan koeinstanssin (t25)
    T-37) echo "" ;; # T-37 ajaa koeinstanssin eri muistirajoilla (t37)
    T-63) echo "$T63_TESTIT" ;;
    T-65) echo "$T63_TESTIT $adapteri/transkriptit.test.mjs $adapteri/peili.test.mjs $adapteri/kuorma.test.mjs $adapteri/siltavertailu.test.mjs $adapteri/peilivertailu.test.mjs $adapteri/lahde.test.mjs" ;; # T-111: + T-24:n ja T-29:n testit; + vanhasta-kopioiden diff (t65)
    T-66) echo "$T63_TESTIT $adapteri/toiminnot/viestit.test.mjs" ;;
    T-67) echo "$T63_TESTIT $adapteri/toiminnot/istunto.test.mjs" ;;
    T-68) echo "$T63_TESTIT $adapteri/toiminnot/pura.test.mjs" ;;
    T-69) echo "$T63_TESTIT $adapteri/toiminnot/chat.test.mjs" ;;
    T-95) echo "$T63_TESTIT $adapteri/toiminnot/chat.test.mjs" ;; # T-95: chatDir-testi chat.test.mjs:n lopussa (adapteri.mjs --chat)
    T-79) echo "$T63_TESTIT" ;; # T-79-G: palvelin- ja reittitestit lisäkuvioilla, koukku ja lisäfixturet (palvelin.test.mjs, fixturet.test.mjs)
    T-80) echo "$T63_TESTIT $adapteri/toiminnot/malli.test.mjs" ;;
    T-81) echo "$T63_TESTIT $adapteri/toiminnot/uusi.test.mjs" ;;
    T-82) echo "$T63_TESTIT $adapteri/toiminnot/agentit.test.mjs" ;;
    T-83) echo "$T63_TESTIT $adapteri/toiminnot/asetukset.test.mjs" ;;
    T-85) echo "$T63_TESTIT $adapteri/toiminnot/android.test.mjs" ;;
    T-86) echo "$T63_TESTIT $adapteri/toiminnot/linux.test.mjs" ;;
    T-89) echo "$adapteri/watch.test.mjs" ;; # T-89: watch-yksikkötestit + koeinstanssi, jossa adapteri tapetaan ja käynnistetään uudelleen (t89)
    T-94) echo "" ;; # T-94 ajaa koeinstanssin hitaalla ydinkääreellä (t94), vaatii GATE_SOLMU:n
    T-103) echo "" ;; # T-103 ajaa koeinstanssin (vertailu/t103-koe.sh), vaatii GATE_SOLMU:n
    T-92) echo "" ;; # T-92 ajaa koeinstanssin, joka vaatii GATE_SOLMU:n (t92)
    *) return 1 ;;
  esac
}

# T-25 (kaynnista.sh + vertailut): koeinstanssi porteissa 18820 (ydin) ja 18821 (mock-vanha), tila /tmp/scopes2-koe. Toisen istunnon varaamat portit: GATE_KOEPORTTI ja GATE_KOEVANHA.
# HOME ohjataan koehakemistoon, joten avain (~/.config/scopes2/avain, jonka myös adapteri lukee) ja pid/loki eivät
# osu tuotannon tilaan; NODE kiinnitetään ennen HOME-vaihtoa. Ei portteja 8797 eikä 8787.
t25() {
  local koe=/tmp/scopes2-koe koti=/tmp/scopes2-koe/koti portti=${GATE_KOEPORTTI:-18820} vanha=${GATE_KOEVANHA:-18821} rc=0 mockpid=""
  local fix="$juuri/$adapteri/testidata/istunnot6/projektit" node_bin
  node_bin=$(command -v "${NODE:-node}") || { echo "VIRHE: node puuttuu" >&2; return 1; }
  [ -x "$juuri/scopes2/ydin/target/release/scopes-solmu" ] || { echo "KÄÄNNÄ: cargo build --release" >&2; return 1; }
  if curl -fsS -m 2 "http://127.0.0.1:$portti/api/terveys" >/dev/null 2>&1 || curl -fsS -m 2 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1; then
    echo "VIRHE: koeportti $portti tai $vanha on jo käytössä" >&2; return 1
  fi
  [ -d "$fix" ] || "$node_bin" "$juuri/$adapteri/testidata/luo-istunnot6.mjs" >/dev/null || return 1
  # Ydin vastaa itse vasta, kun sekä lahde/istunnot että lahde/agy ovat ytimessä (nakymat.rs lahteet_ytimessa): tyhjä agy-hakemisto.
  rm -rf "$koe"; mkdir -p "$koti/.config/scopes" "$koe/agy"
  # Ytimen silta lukee vanhan avaimen joka pyynnöllä; mock-vanha ei tarkista sitä, mutta puuttuva tiedosto antaisi 503.
  echo koe-vanha-avain > "$koti/.config/scopes/avain"
  env() { command env HOME="$koti" NODE="$node_bin" SCOPES2_TILA="$koe/tila" SCOPES2_AVAIN="$koti/.config/scopes2/avain" "$@"; }
  "$node_bin" "$juuri/$adapteri/testidata/mock-vanha.mjs" "$vanha" & mockpid=$!
  for _ in $(seq 1 30); do curl -fsS -m 1 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1 && break; sleep 0.2; done
  env bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --data "$koe/data" --projektit "$fix" --vanha "http://127.0.0.1:$vanha" \
    --istunnot "$(dirname "$fix")/istunnot" --agy "$koe/agy" --brain "" --adb "" || rc=1
  if [ $rc = 0 ]; then
    # Lähdetila ytimessä → johdetut reitit vastaavat ytimestä (T-34 ajo 3: ilman lähdettä kaikki tuli sillasta).
    local lahde=""
    for _ in $(seq 1 20); do
      lahde=$(curl -sS -m 3 -o /dev/null -D - -H "Authorization: Bearer $(cat "$koti/.config/scopes2/avain")" \
        "http://127.0.0.1:$portti/api/skoopit" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-lahde"{print $2}')
      [ "$lahde" = ydin ] && break
      sleep 0.5
    done
    echo "X-LAHDE /api/skoopit: ${lahde:-puuttuu}"
    [ "$lahde" = ydin ] || { echo "FAIL: /api/skoopit ei vastaa ytimestä (X-Lahde: ${lahde:-puuttuu})" >&2; rc=1; }
  fi
  if [ $rc = 0 ]; then
    curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$portti/api/terveys" || { echo "FAIL: terveys" >&2; rc=1; }
  fi
  if [ $rc = 0 ]; then
    env "$node_bin" "$juuri/$adapteri/adapteri.mjs" --ydin "http://127.0.0.1:$portti" --projektit "$fix" --kerran || { echo "FAIL: adapteri --kerran" >&2; rc=1; }
  fi
  if [ $rc = 0 ]; then
    env "$node_bin" "$juuri/$adapteri/peilivertailu.mjs" --ydin "http://127.0.0.1:$portti" --projektit "$fix" | tee "$koe/peili.ulos" || rc=1
    grep -qE '^PEILI: 6/6( |$)' "$koe/peili.ulos" || { echo "FAIL: PEILI: 6/6 puuttuu" >&2; rc=1; }
  fi
  if [ $rc = 0 ]; then
    env "$node_bin" "$juuri/$adapteri/mittaa-latenssi.mjs" --ydin "http://127.0.0.1:$portti" --kierrokset 10 || { echo "FAIL: mittaa-latenssi" >&2; rc=1; }
  fi
  env bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --sammuta || rc=1
  if curl -fsS -m 2 "http://127.0.0.1:$portti/api/terveys" >/dev/null 2>&1; then echo "FAIL: ydin vastaa sammutuksen jälkeen" >&2; rc=1; fi
  kill "$mockpid" 2>/dev/null; wait "$mockpid" 2>/dev/null
  return $rc
}

# T-37 (kaynnista.sh datamuistirajat): koeinstanssi kuten t25, neljä ajoa: oletusrajat, ydin ilman rajaa, adapterin liian pieni raja
# (adapteri kuolee, käynnistys raportoi sen), virheellinen raja (RAJA: ei asetettu, käynnistys jatkuu). Portit kuten t25.
t37() {
  local koe=/tmp/scopes2-koe37 koti=/tmp/scopes2-koe37/koti portti=${GATE_KOEPORTTI:-18820} vanha=${GATE_KOEVANHA:-18821} rc=0 mockpid=""
  local fix="$juuri/$adapteri/testidata/istunnot6/projektit" node_bin
  node_bin=$(command -v "${NODE:-node}") || { echo "VIRHE: node puuttuu" >&2; return 1; }
  [ -x "$juuri/scopes2/ydin/target/release/scopes-solmu" ] || { echo "KÄÄNNÄ: cargo build --release" >&2; return 1; }
  if curl -fsS -m 2 "http://127.0.0.1:$portti/api/terveys" >/dev/null 2>&1 || curl -fsS -m 2 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1; then
    echo "VIRHE: koeportti $portti tai $vanha on jo käytössä" >&2; return 1
  fi
  [ -d "$fix" ] || "$node_bin" "$juuri/$adapteri/testidata/luo-istunnot6.mjs" >/dev/null || return 1
  rm -rf "$koe"; mkdir -p "$koti/.config/scopes" "$koe/agy" "$koti/.local/opt"
  echo koe-vanha-avain > "$koti/.config/scopes/avain"
  # kaynnista.sh tunnistaa Node 22:n HOME:n alta; koe-HOME:ssa sama asennus linkkinä.
  [ -x "$node22" ] && ln -s "$(dirname "$(dirname "$node22")")" "$koti/.local/opt/"
  "$node_bin" "$juuri/$adapteri/testidata/mock-vanha.mjs" "$vanha" & mockpid=$!
  for _ in $(seq 1 30); do curl -fsS -m 1 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1 && break; sleep 0.2; done
  # <nimi> <odotettu exit> <odotettu RAJA-rivi> <odotettu pid-rajat "ydin adapteri" tai "-"> <odotettu stderr-osuma tai -> [ENV=arvo ...]
  ajo() {
    local nimi="$1" odotettu_rc="$2" odotettu_raja="$3" odotettu_pid="$4" odotettu_err="$5" ulos="$koe/ulos" err="$koe/err" krc ydin_pid adapteri_pid y a
    shift 5
    local ymp=(command env HOME="$koti" NODE="$node_bin")
    # MINIMI: cronin kaltainen ympäristö (env -i, PATH=/usr/bin:/bin, ei NODE:a); NODE20=<polku>: periytynyt vanha node.
    case "${1-}" in
      MINIMI) ymp=(command env -i HOME="$koti" PATH=/usr/bin:/bin); shift ;;
      NODE20=*) ymp=(command env HOME="$koti" NODE="${1#NODE20=}"); shift ;;
    esac
    "${ymp[@]}" SCOPES2_TILA="$koe/tila" SCOPES2_AVAIN="$koti/.config/scopes2/avain" "$@" \
      bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --data "$koe/data" --projektit "$fix" --vanha "http://127.0.0.1:$vanha" \
      --istunnot "$(dirname "$fix")/istunnot" --agy "$koe/agy" --brain "" --adb "" >"$ulos" 2>"$err"
    krc=$?
    echo "--- $nimi (exit $krc)"; cat "$ulos" "$err"
    [ "$krc" = "$odotettu_rc" ] || { echo "FAIL $nimi: exit $krc, odotettu $odotettu_rc" >&2; rc=1; }
    if [ "$odotettu_raja" != - ]; then
      grep -qx "RAJA: $odotettu_raja" "$ulos" || { echo "FAIL $nimi: rivi 'RAJA: $odotettu_raja' puuttuu" >&2; rc=1; }
    fi
    if [ "$odotettu_err" != - ]; then
      grep -q -- "$odotettu_err" "$err" || { echo "FAIL $nimi: stderr ei sisällä '$odotettu_err'" >&2; rc=1; }
    fi
    if [ "$odotettu_pid" != - ]; then
      ydin_pid=$(awk '$1=="ydin"{print $2}' "$koe/tila/pidit"); adapteri_pid=$(awk '$1=="adapteri"{print $2}' "$koe/tila/pidit")
      y=$(awk '/^Max data size/{print $4}' "/proc/$ydin_pid/limits" 2>/dev/null)
      a=$(awk '/^Max data size/{print $4}' "/proc/$adapteri_pid/limits" 2>/dev/null)
      set -- $odotettu_pid
      [ "$y" = "$1" ] || { echo "FAIL $nimi: ytimen /proc/$ydin_pid/limits Max data size '$y', odotettu '$1'" >&2; rc=1; }
      [ "$a" = "$2" ] || { echo "FAIL $nimi: adapterin /proc/$adapteri_pid/limits Max data size '$a', odotettu '$2'" >&2; rc=1; }
      # Adapteri ajaa Node 22:lla (node:sqlite) riippumatta PATHista ja periytyvästä NODE:sta.
      local versio
      versio=$("$(readlink "/proc/$adapteri_pid/exe")" -p 'process.versions.node.split(".")[0]' 2>/dev/null)
      [ "$versio" = 22 ] || { echo "FAIL $nimi: adapterin node v${versio:-?}, odotettu 22" >&2; rc=1; }
    fi
    command env HOME="$koti" SCOPES2_TILA="$koe/tila" bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --sammuta || rc=1
    if curl -fsS -m 2 "http://127.0.0.1:$portti/api/terveys" >/dev/null 2>&1; then echo "FAIL $nimi: ydin vastaa sammutuksen jälkeen" >&2; rc=1; fi
    [ ! -e "$koe/tila/pidit" ] || { echo "FAIL $nimi: pid-tiedosto jäi" >&2; rc=1; }
  }
  ajo "oletusrajat" 0 "ydin 1572864 adapteri 1048576" "1610612736 1073741824" - SCOPES2_ADAPTERI_DATARAJA=1048576
  ajo "ydin ilman rajaa" 0 "ydin unlimited adapteri 1048576" "unlimited 1073741824" - SCOPES2_YDIN_DATARAJA=
  ajo "adapteri liian pieni raja" 1 - - "ADAPTERI: kuoli" SCOPES2_ADAPTERI_DATARAJA=65536
  ajo "virheellinen raja" 0 - - "RAJA: ei asetettu" SCOPES2_YDIN_DATARAJA=abc
  ajo "minimaalinen PATH (cron)" 0 "ydin 1572864 adapteri 1048576" "1610612736 1073741824" - MINIMI
  if [ -x /usr/bin/node ] && [ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    ajo "periytynyt NODE=/usr/bin/node" 0 "ydin 1572864 adapteri 1048576" "1610612736 1073741824" "käytetään $koti/.local/opt/node-v22.23.3-linux-arm64/bin/node" NODE20=/usr/bin/node
  fi
  kill "$mockpid" 2>/dev/null; wait "$mockpid" 2>/dev/null
  return $rc
}

# T-89 (kaynnista.sh adapterin uudelleenkäynnistys): koeinstanssi kuten t25 (portit, mock-vanha, oma HOME ja SCOPES2_TILA /tmp/scopes2-koe89).
# (a) käynnistys, (b) adapterin kill -9 + uusi ajo → "ADAPTERI: uudelleen", ytimen pid ennallaan, (c) uusi ajo → "jo käynnissä",
# (d) kill -9 + --vain-tarkista → exit 1 eikä käynnistystä, (e) --sammuta siivoaa. Ei portteja 8797 eikä 8787.
t89() {
  local koe=/tmp/scopes2-koe89 koti=/tmp/scopes2-koe89/koti portti=${GATE_KOEPORTTI:-18820} vanha=${GATE_KOEVANHA:-18821} rc=0 mockpid=""
  local fix="$juuri/$adapteri/testidata/istunnot6/projektit" node_bin krc ydin0 adapteri0 ydin1 adapteri1
  node_bin=$(command -v "${NODE:-node}") || { echo "VIRHE: node puuttuu" >&2; return 1; }
  [ -x "$juuri/scopes2/ydin/target/release/scopes-solmu" ] || { echo "KÄÄNNÄ: cargo build --release" >&2; return 1; }
  (cd "$juuri" && timeout 300 "$node_bin" --test "$adapteri/watch.test.mjs") || return 1
  if curl -fsS -m 2 "http://127.0.0.1:$portti/api/terveys" >/dev/null 2>&1 || curl -fsS -m 2 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1; then
    echo "VIRHE: koeportti $portti tai $vanha on jo käytössä" >&2; return 1
  fi
  [ -d "$fix" ] || "$node_bin" "$juuri/$adapteri/testidata/luo-istunnot6.mjs" >/dev/null || return 1
  rm -rf "$koe"; mkdir -p "$koti/.config/scopes" "$koe/agy"
  echo koe-vanha-avain > "$koti/.config/scopes/avain"
  "$node_bin" "$juuri/$adapteri/testidata/mock-vanha.mjs" "$vanha" & mockpid=$!
  for _ in $(seq 1 30); do curl -fsS -m 1 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1 && break; sleep 0.2; done
  # <nimi> [kaynnista.sh-liput] → exit $krc, ulostulo $koe/ulos ja $koe/err
  kaynnista() {
    local nimi="$1"; shift
    command env HOME="$koti" NODE="$node_bin" SCOPES2_TILA="$koe/tila" SCOPES2_AVAIN="$koti/.config/scopes2/avain" \
      bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --data "$koe/data" --projektit "$fix" --vanha "http://127.0.0.1:$vanha" \
      --istunnot "$(dirname "$fix")/istunnot" --agy "$koe/agy" --brain "" --adb "" "$@" >"$koe/ulos" 2>"$koe/err"
    krc=$?
    echo "--- $nimi (exit $krc)"; cat "$koe/ulos" "$koe/err"
  }
  pidista() { awk -v n="$1" '$1==n{print $2}' "$koe/tila/pidit" 2>/dev/null; } # ydin | adapteri
  tapa_adapteri() { # kill -9 ja odotus, että prosessi on poissa
    kill -9 "$1" 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done
    echo "FAIL: adapteri $1 elää kill -9:n jälkeen" >&2; return 1
  }
  vaadi() { # <nimi> <odotettu exit> [<ulostulomalli>]
    [ "$krc" = "$2" ] || { echo "FAIL $1: exit $krc, odotettu $2" >&2; rc=1; }
    [ -z "${3-}" ] || grep -q -- "$3" "$koe/ulos" || { echo "FAIL $1: ulostulosta puuttuu '$3'" >&2; rc=1; }
  }

  kaynnista "(a) käynnistys"
  vaadi "(a)" 0 "^VALMIS: portti $portti"
  ydin0=$(pidista ydin); adapteri0=$(pidista adapteri)
  { kill -0 "$ydin0" 2>/dev/null && kill -0 "$adapteri0" 2>/dev/null; } || { echo "FAIL (a): ydin tai adapteri ei elä (ydin '$ydin0', adapteri '$adapteri0')" >&2; rc=1; }

  if [ $rc = 0 ]; then
    tapa_adapteri "$adapteri0" || rc=1
    kaynnista "(b) uusi ajo adapterin kuoltua"
    vaadi "(b)" 0 "^ADAPTERI: uudelleen "
    ydin1=$(pidista ydin); adapteri1=$(pidista adapteri)
    [ "$ydin1" = "$ydin0" ] || { echo "FAIL (b): ytimen pid muuttui $ydin0 → $ydin1" >&2; rc=1; }
    { [ -n "$adapteri1" ] && [ "$adapteri1" != "$adapteri0" ] && kill -0 "$adapteri1" 2>/dev/null; } || { echo "FAIL (b): uusi adapteri ei elä tai pid ei vaihtunut ($adapteri0 → ${adapteri1:-puuttuu})" >&2; rc=1; }
    grep -q "^ADAPTERI: uudelleen $adapteri1\$" "$koe/ulos" || { echo "FAIL (b): ulostulon pid ei vastaa pidit-tiedostoa ($adapteri1)" >&2; rc=1; }
    kill -0 "$ydin0" 2>/dev/null || { echo "FAIL (b): ydin ei elä" >&2; rc=1; }
  fi

  if [ $rc = 0 ]; then
    kaynnista "(c) uusi ajo, kaikki elää"
    vaadi "(c)" 0 "jo käynnissä"
    grep -q "uudelleen" "$koe/ulos" && { echo "FAIL (c): turha uudelleenkäynnistys" >&2; rc=1; }
    [ "$(pidista adapteri)" = "$adapteri1" ] && [ "$(pidista ydin)" = "$ydin0" ] || { echo "FAIL (c): pidit muuttui" >&2; rc=1; }
  fi

  if [ $rc = 0 ]; then
    tapa_adapteri "$adapteri1" || rc=1
    kaynnista "(d) --vain-tarkista adapterin kuoltua" --vain-tarkista
    vaadi "(d)" 1
    grep -q "uudelleen" "$koe/ulos" && { echo "FAIL (d): --vain-tarkista käynnisti adapterin" >&2; rc=1; }
    [ "$(pidista adapteri)" = "$adapteri1" ] || { echo "FAIL (d): pidit-tiedoston adapteri-rivi muuttui" >&2; rc=1; }
    ! kill -0 "$adapteri1" 2>/dev/null || { echo "FAIL (d): adapteri elää --vain-tarkista-ajon jälkeen" >&2; rc=1; }
  fi

  command env HOME="$koti" SCOPES2_TILA="$koe/tila" bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --sammuta || rc=1
  for p in "$ydin0" "$adapteri0" "$adapteri1"; do
    [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null || { echo "FAIL (e): prosessi $p elää --sammuta-ajon jälkeen" >&2; rc=1; }
  done
  [ ! -e "$koe/tila/pidit" ] || { echo "FAIL (e): pid-tiedosto jäi" >&2; rc=1; }
  if curl -fsS -m 2 "http://127.0.0.1:$portti/api/terveys" >/dev/null 2>&1; then echo "FAIL (e): ydin vastaa sammutuksen jälkeen" >&2; rc=1; fi
  kill "$mockpid" 2>/dev/null; wait "$mockpid" 2>/dev/null
  return $rc
}

# T-92 (kaynnista.sh --adapteri, V-637): koeinstanssi kuten t89 (oma HOME ja SCOPES2_TILA /tmp/scopes2-koe92), toimintoportti GATE_KOETOIMINNOT (oletus 18822).
# GATE_SOLMU = T-93:n julkaisu (lipun tunteva ydinbinääri; pakollinen). (a) SCOPES2_TOIMINNOT asettamatta → ei lippua, X-Lahde: silta,
# (b) asetettu → lippu ytimen cmdlinessä, adapterin terveys toimintoportissa, X-Lahde: adapteri, (c) vanha binääri (SCOPES2_SOLMU) → lippu pois, terveys 200.
# Ei portteja 8797, 8787 eikä 8798.
t92() {
  local koe=/tmp/scopes2-koe92 koti=/tmp/scopes2-koe92/koti portti=${GATE_KOEPORTTI:-18820} vanha=${GATE_KOEVANHA:-18821} toim=${GATE_KOETOIMINNOT:-18822} rc=0 mockpid=""
  local fix="$juuri/$adapteri/testidata/istunnot6/projektit" node_bin krc vanha_solmu="$juuri/scopes2/ydin/target/release/scopes-solmu" p
  [ -n "${GATE_SOLMU:-}" ] || { echo "VIRHE: GATE_SOLMU puuttuu (T-93:n julkaisu)" >&2; return 1; }
  [ -x "$GATE_SOLMU" ] || { echo "VIRHE: GATE_SOLMU ei ole ajettava ($GATE_SOLMU)" >&2; return 1; }
  "$GATE_SOLMU" --help 2>&1 | grep -q -- '--adapteri' || { echo "VIRHE: GATE_SOLMU ei tunne --adapteri-lippua ($GATE_SOLMU)" >&2; return 1; }
  node_bin=$(command -v "${NODE:-node}") || { echo "VIRHE: node puuttuu" >&2; return 1; }
  for p in "$portti" "$vanha" "$toim"; do
    if curl -fsS -m 2 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1; then echo "VIRHE: koeportti $p on jo käytössä" >&2; return 1; fi
  done
  [ -d "$fix" ] || "$node_bin" "$juuri/$adapteri/testidata/luo-istunnot6.mjs" >/dev/null || return 1
  rm -rf "$koe"; mkdir -p "$koti/.config/scopes" "$koe/agy"
  echo koe-vanha-avain > "$koti/.config/scopes/avain"
  "$node_bin" "$juuri/$adapteri/testidata/mock-vanha.mjs" "$vanha" & mockpid=$!
  for _ in $(seq 1 30); do curl -fsS -m 1 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1 && break; sleep 0.2; done
  kaynnista() { # <nimi> <ydinbinääri> <toimintoportti tai tyhjä> → exit $krc, ulostulo $koe/ulos ja $koe/err
    local nimi="$1" solmu="$2" toiminnot="${3-}"
    command env HOME="$koti" NODE="$node_bin" SCOPES2_TILA="$koe/tila" SCOPES2_AVAIN="$koti/.config/scopes2/avain" SCOPES2_SOLMU="$solmu" SCOPES2_TOIMINNOT="$toiminnot" \
      bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --data "$koe/data" --projektit "$fix" --vanha "http://127.0.0.1:$vanha" \
      --istunnot "$(dirname "$fix")/istunnot" --agy "$koe/agy" --brain "" --adb "" >"$koe/ulos" 2>"$koe/err"
    krc=$?
    echo "--- $nimi (exit $krc)"; cat "$koe/ulos" "$koe/err"
  }
  ydin_cmdline() { tr '\0' ' ' < "/proc/$(awk '$1=="ydin"{print $2}' "$koe/tila/pidit")/cmdline" 2>/dev/null; }
  x_lahde() { # <polku> → X-Lahde-otsake (tyhjä, jos puuttuu)
    curl -sS -m 3 -o /dev/null -D - -H "Authorization: Bearer $(cat "$koti/.config/scopes2/avain")" "http://127.0.0.1:$portti$1" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-lahde"{print $2}'
  }
  vaadi() { # <nimi> <rivi sellaisenaan>
    [ "$krc" = 0 ] || { echo "FAIL $1: exit $krc, odotettu 0" >&2; rc=1; }
    grep -qxF -- "$2" "$koe/ulos" || { echo "FAIL $1: ulostulosta puuttuu rivi '$2'" >&2; rc=1; }
  }
  sammuta() { # <nimi>
    command env HOME="$koti" SCOPES2_TILA="$koe/tila" bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --sammuta || { echo "FAIL $1: --sammuta" >&2; rc=1; }
    if curl -fsS -m 2 "http://127.0.0.1:$portti/api/terveys" >/dev/null 2>&1; then echo "FAIL $1: ydin vastaa sammutuksen jälkeen" >&2; rc=1; fi
  }
  local cmd lahde

  kaynnista "(a) SCOPES2_TOIMINNOT asettamatta" "$GATE_SOLMU" ""
  vaadi "(a)" "ADAPTERI-LIPPU: ei (SCOPES2_TOIMINNOT tyhjä)"
  cmd=$(ydin_cmdline)
  case " $cmd " in *" --adapteri "*) echo "FAIL (a): ytimen cmdline sisältää --adapteri: $cmd" >&2; rc=1 ;; esac
  lahde=$(x_lahde /api/agentit)
  [ "$lahde" = silta ] || { echo "FAIL (a): /api/agentit X-Lahde '${lahde:-puuttuu}', odotettu silta" >&2; rc=1; }
  sammuta "(a)"

  kaynnista "(b) SCOPES2_TOIMINNOT=$toim" "$GATE_SOLMU" "$toim"
  vaadi "(b)" "ADAPTERI-LIPPU: http://127.0.0.1:$toim"
  cmd=$(ydin_cmdline)
  case " $cmd " in *" --adapteri http://127.0.0.1:$toim "*) ;; *) echo "FAIL (b): ytimen cmdlinessä ei ole --adapteri http://127.0.0.1:$toim: $cmd" >&2; rc=1 ;; esac
  curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$toim/api/terveys" || { echo "FAIL (b): adapterin terveys toimintoportissa $toim" >&2; rc=1; }
  lahde=""
  for _ in $(seq 1 30); do lahde=$(x_lahde /api/agentit); [ "$lahde" = adapteri ] && break; sleep 0.5; done
  [ "$lahde" = adapteri ] || { echo "FAIL (b): /api/agentit X-Lahde '${lahde:-puuttuu}', odotettu adapteri (T-91)" >&2; rc=1; }
  sammuta "(b)"

  if "$vanha_solmu" --help 2>&1 | grep -q -- '--adapteri'; then
    echo "OHITETTU (c): binääri tuntee lipun"
  elif [ ! -x "$vanha_solmu" ]; then
    echo "OHITETTU (c): vanhaa binääriä ei ole ($vanha_solmu)"
  else
    rm -rf "$koe/data" # (a)-(b) loivat datan uudella binäärillä; vanha ei avaa uutta skeemaa
    kaynnista "(c) vanha binääri" "$vanha_solmu" "$toim"
    vaadi "(c)" "ADAPTERI-LIPPU: ei (ydinbinääri ei tunne --adapteri-lippua)"
    grep -qxF "TERVEYS: 200" "$koe/ulos" || { echo "FAIL (c): TERVEYS: 200 puuttuu" >&2; rc=1; }
    sammuta "(c)"
  fi

  kill "$mockpid" 2>/dev/null; wait "$mockpid" 2>/dev/null
  for p in "$portti" "$vanha" "$toim"; do
    if curl -fsS -m 2 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1; then echo "FAIL: koeportti $p kuuntelee ajon jälkeen" >&2; rc=1; fi
  done
  [ $rc = 0 ] && rm -rf "$koe" || echo "T-92: koehakemisto jätetty tutkittavaksi: $koe" >&2
  return $rc
}

# T-94 (kaynnista.sh odottaa skeemasiirtymän, ei toista ydintä): koeinstanssi kuten t92 (SCOPES2_TILA /tmp/scopes2-koe94, koeportit kuten t92).
# GATE_SOLMU = lipun tunteva ydinbinääri (T-93:n julkaisu; pakollinen). SCOPES2_SOLMU = $koe/hidas-scopes-solmu: --help heti, muuten sleep $HIDAS ja exec GATE_SOLMU
# (nimessä scopes-solmu, jotta ydin_elaa tunnistaa kääreen cmdlinen siirtymän aikana). (a) odotus riittää → odotetaan, 200, (b) odotus ei riitä → exit 1,
# (c) toinen ajo ydintä odottaessa ei käynnistä toista ydintä, (d) --sammuta siivoaa. Ei portteja 8797, 8787 eikä 8798.
t94() {
  local koe=/tmp/scopes2-koe94 koti=/tmp/scopes2-koe94/koti portti=${GATE_KOEPORTTI:-18820} vanha=${GATE_KOEVANHA:-18821} rc=0 mockpid="" krc p1 n
  local fix="$juuri/$adapteri/testidata/istunnot6/projektit" node_bin
  [ -n "${GATE_SOLMU:-}" ] || { echo "VIRHE: GATE_SOLMU puuttuu (T-93:n julkaisu)" >&2; return 1; }
  [ -x "$GATE_SOLMU" ] || { echo "VIRHE: GATE_SOLMU ei ole ajettava ($GATE_SOLMU)" >&2; return 1; }
  node_bin=$(command -v "${NODE:-node}") || { echo "VIRHE: node puuttuu" >&2; return 1; }
  for p in "$portti" "$vanha"; do
    if curl -fsS -m 2 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1; then echo "VIRHE: koeportti $p on jo käytössä" >&2; return 1; fi
  done
  [ -d "$fix" ] || "$node_bin" "$juuri/$adapteri/testidata/luo-istunnot6.mjs" >/dev/null || return 1
  rm -rf "$koe"; mkdir -p "$koti/.config/scopes" "$koe/agy"
  echo koe-vanha-avain > "$koti/.config/scopes/avain"
  printf '#!/usr/bin/env bash\ncase " $* " in *" --help "*) exec "%s" "$@" ;; esac\nsleep "${HIDAS:-0}"\nexec "%s" "$@"\n' "$GATE_SOLMU" "$GATE_SOLMU" > "$koe/hidas-scopes-solmu"
  chmod +x "$koe/hidas-scopes-solmu"
  "$node_bin" "$juuri/$adapteri/testidata/mock-vanha.mjs" "$vanha" & mockpid=$!
  for _ in $(seq 1 30); do curl -fsS -m 1 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1 && break; sleep 0.2; done
  kaynnista() { # <ulostulotiedosto> <HIDAS> <SCOPES2_TERVEYS_ODOTUS> → exit stdoutiin $koe/<tiedosto>.rc
    command env HOME="$koti" NODE="$node_bin" SCOPES2_TILA="$koe/tila" SCOPES2_AVAIN="$koti/.config/scopes2/avain" SCOPES2_SOLMU="$koe/hidas-scopes-solmu" SCOPES2_TOIMINNOT= \
      HIDAS="$2" SCOPES2_TERVEYS_ODOTUS="$3" \
      bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --data "$koe/data" --projektit "$fix" --vanha "http://127.0.0.1:$vanha" \
      --istunnot "$(dirname "$fix")/istunnot" --agy "$koe/agy" --brain "" --adb "" >"$koe/$1" 2>&1
    echo $? > "$koe/$1.rc"
  }
  sammuta() { # <nimi>
    command env HOME="$koti" SCOPES2_TILA="$koe/tila" bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --sammuta || { echo "FAIL $1: --sammuta" >&2; rc=1; }
    [ ! -e "$koe/tila/pidit" ] || { echo "FAIL $1: pid-tiedosto jäi" >&2; rc=1; }
    rm -rf "$koe/data"
  }
  vaadi() { # <nimi> <tiedosto> <odotettu exit> <rivi-osa>...
    local nimi="$1" f="$2" odotettu="$3"; shift 3
    krc=$(cat "$koe/$f.rc" 2>/dev/null || echo "?")
    echo "--- $nimi (exit $krc)"; cat "$koe/$f"
    [ "$krc" = "$odotettu" ] || { echo "FAIL $nimi: exit $krc, odotettu $odotettu" >&2; rc=1; }
    for osa in "$@"; do grep -qF -- "$osa" "$koe/$f" || { echo "FAIL $nimi: ulostulosta puuttuu '$osa'" >&2; rc=1; }; done
  }

  kaynnista a.ulos 40 90
  vaadi "(a) hidas ydin, odotus 90 s" a.ulos 0 "TERVEYS: odotetaan (ydin " "TERVEYS: 200"
  sammuta "(a)"

  kaynnista b.ulos 40 10
  vaadi "(b) hidas ydin, odotus 10 s" b.ulos 1 "ei vastaa 10 s:ssa"
  sammuta "(b)"

  ( kaynnista c1.ulos 40 90 ) & p1=$!
  sleep 5
  kaynnista c2.ulos 40 90
  wait "$p1"
  vaadi "(c) ensimmäinen ajo" c1.ulos 0 "TERVEYS: 200"
  vaadi "(c) toinen ajo ydintä odottaessa" c2.ulos 0 "LUKKO: toinen kaynnista.sh käynnissä" # T-103: lukko korvaa "jo käynnissä"-odotuksen
  grep -q '^YDIN: [0-9]' "$koe/c2.ulos" && { echo "FAIL (c): toinen ajo käynnisti ytimen" >&2; rc=1; }
  n=$(pgrep -f "scopes-solmu.*--data $koe/data" | wc -l)
  [ "$n" = 1 ] || { echo "FAIL (c): ytimiä $n, odotettu 1" >&2; rc=1; }
  sammuta "(c)"

  kill "$mockpid" 2>/dev/null; wait "$mockpid" 2>/dev/null
  for p in "$portti" "$vanha"; do
    if curl -fsS -m 2 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1; then echo "FAIL (d): koeportti $p kuuntelee ajon jälkeen" >&2; rc=1; fi
  done
  n=$(pgrep -f "scopes-solmu.*--data $koe/data" | wc -l)
  [ "$n" = 0 ] || { echo "FAIL (d): ytimiä $n sammutuksen jälkeen" >&2; rc=1; }
  [ $rc = 0 ] && rm -rf "$koe" || echo "T-94: koehakemisto jätetty tutkittavaksi: $koe" >&2
  return $rc
}

# T-65 (vanhasta-kopiot): jokainen scopes2/adapteri/vanhasta/<nimi>.mjs = scopes/palvelu/<nimi>.mjs paitsi rivi 1 (kopiorivi) ja import-rivit.
t65() {
  local d="$juuri/$adapteri/vanhasta" f nimi rc=0 kopioita=0 rajaus='^import |^\} from ' kopiocommit alkup t65tmp
  [ -d "$d" ] || { echo "FAIL T-65: $adapteri/vanhasta/ puuttuu" >&2; return 1; }
  t65tmp=$(mktemp -d)
  for f in "$d"/*.mjs; do
    [ -e "$f" ] || break
    nimi=$(basename "$f"); kopioita=$((kopioita + 1))
    # Osakopio (T-68): rivi 1 "// osakopio: scopes/palvelu/<alkup>.mjs:<a>-<b>[,<a>-<b>…] (…)"; rivit 2… = alkuperäisen mainitut rivialueet peräkkäin.
    # Valinnainen " @ <commit>" rivialueiden jälkeen: alueet luetaan sen commitin alkuperäisestä (SCOPES2-PALUU-1735).
    osa=$(head -1 "$f" | sed -nE 's#^// osakopio: scopes/palvelu/([^:]+\.mjs):([0-9]+-[0-9]+(,[0-9]+-[0-9]+)*)( @ ([0-9a-f]{7,40}))? \(.*#\1 \2 \5#p')
    if [ -n "$osa" ]; then
      read -r alkup alueet kopiocommit <<< "$osa"; odotettu=""
      [ -f "$juuri/scopes/palvelu/$alkup" ] || { echo "FAIL T-65: scopes/palvelu/$alkup puuttuu ($nimi)" >&2; rc=1; continue; }
      if [ -n "$kopiocommit" ] && git -C "$juuri" show "$kopiocommit:scopes/palvelu/$alkup" > "$t65tmp/$alkup" 2>/dev/null; then
        cmp -s "$t65tmp/$alkup" "$juuri/scopes/palvelu/$alkup" || echo "TIEDOKSI T-65: scopes/palvelu/$alkup muuttunut osakopion $kopiocommit jälkeen (osakopio ennallaan)"
      else
        cp "$juuri/scopes/palvelu/$alkup" "$t65tmp/$alkup"
      fi
      for a in ${alueet//,/ }; do odotettu+=$(sed -n "${a%-*},${a#*-}p" "$t65tmp/$alkup")$'\n'; done
      if ! diff <(tail -n +2 "$f") <(printf '%s' "$odotettu") >/dev/null; then
        echo "FAIL T-65: osakopio $nimi poikkeaa alkuperäisen riveistä $alueet:" >&2
        diff <(tail -n +2 "$f") <(printf '%s' "$odotettu") | head -10 >&2
        rc=1
      fi
      continue
    fi
    [ -f "$juuri/scopes/palvelu/$nimi" ] || { echo "FAIL T-65: scopes/palvelu/$nimi puuttuu" >&2; rc=1; continue; }
    head -1 "$f" | grep -q "^// kopio: scopes/palvelu/$nimi @ " || { echo "FAIL T-65: $nimi: rivi 1 ei ole kopiorivi" >&2; rc=1; }
    # Vertailu kopiorivin commitin alkuperäiseen (SCOPES2-PALUU-1735, 28.10.2026): vanhan scopes/palvelun myöhempi muutos ei punaa
    # porttia vaan tulostaa TIEDOKSI-rivin; kopion synkka uuteen alkuperäiseen on oma päätöksensä (voi muuttaa S-5b/V2-sopimusta).
    kopiocommit=$(head -1 "$f" | sed -nE 's#^// kopio: scopes/palvelu/[^ ]+ @ ([0-9a-f]{7,40}) .*#\1#p')
    alkup="$t65tmp/$nimi"
    if [ -n "$kopiocommit" ] && git -C "$juuri" show "$kopiocommit:scopes/palvelu/$nimi" > "$alkup" 2>/dev/null; then
      cmp -s "$alkup" "$juuri/scopes/palvelu/$nimi" || echo "TIEDOKSI T-65: scopes/palvelu/$nimi muuttunut kopion $kopiocommit jälkeen (kopio ennallaan)"
    else
      cp "$juuri/scopes/palvelu/$nimi" "$alkup"
    fi
    # Tietoinen ero vanhaan (T-88): <nimi>.ero = odotettu diff (kopio vs alkuperäinen, import-rivit pois); ilman sitä ero on tyhjä.
    todellinen=$(diff <(tail -n +2 "$f" | grep -vE "$rajaus") <(grep -vE "$rajaus" "$alkup"))
    odotettu_ero=""; [ -f "$f.ero" ] && odotettu_ero=$(cat "$f.ero")
    if [ "$todellinen" != "$odotettu_ero" ]; then
      echo "FAIL T-65: $nimi poikkeaa alkuperäisestä ($kopiocommit) muualta kuin import-riveiltä$([ -f "$f.ero" ] && echo " ja sallitusta erosta $nimi.ero"):" >&2
      diff <(tail -n +2 "$f" | grep -vE "$rajaus") <(grep -vE "$rajaus" "$alkup") | head -10 >&2
      rc=1
    fi
  done
  rm -rf "$t65tmp"
  [ $kopioita -gt 0 ] || { echo "FAIL T-65: vanhasta/ on tyhjä" >&2; return 1; }
  echo "T-65: $kopioita kopiota tarkistettu"
  return $rc
}

# T-103 (kaynnista.sh: vanha adapteri pois täyskäynnistyksessä, lukko, --sammuta tarkistaa komentorivin): koeinstanssi vertailu/t103-koe.sh, tila /tmp/scopes2-koe103.
t103() {
  local node_bin
  [ -n "${GATE_SOLMU:-}" ] || { echo "VIRHE: GATE_SOLMU puuttuu (T-93:n julkaisu)" >&2; return 1; }
  [ -x "$GATE_SOLMU" ] || { echo "VIRHE: GATE_SOLMU ei ole ajettava ($GATE_SOLMU)" >&2; return 1; }
  node_bin=$(command -v "${NODE:-node}") || { echo "VIRHE: node puuttuu" >&2; return 1; }
  bash "$juuri/$adapteri/vertailu/t103-koe.sh" "$juuri" "$GATE_SOLMU" "$node_bin"
}

aja_testit() {
  local id="$1" tiedostot rc=0
  tuontitarkistus || return 1
  if [ "$id" = T-65 ]; then t65 || rc=1; fi
  if [ "$id" = T-25 ]; then t25; return $?; fi
  if [ "$id" = T-37 ]; then t37; return $?; fi
  if [ "$id" = T-89 ]; then t89; return $?; fi
  if [ "$id" = T-103 ]; then t103; return $?; fi
  if [ "$id" = T-92 ]; then t92; return $?; fi
  if [ "$id" = T-94 ]; then t94; return $?; fi
  tiedostot=$(testit "$id")
  # shellcheck disable=SC2086
  (cd "$juuri" && timeout 300 "${NODE:-node}" --test $tiedostot) || rc=1
  return $rc
}

itsetesti() {
  local tmp rc virheet=0 f
  local koe_vanha="$juuri/scopes/KOE.tmp" koe_may="$juuri/$adapteri/KOE.tmp" koe_muu="$juuri/scopes2/KOE.tmp"
  tmp=$(mktemp -d)
  # Itsetesti luo vain omat KOE.tmp-tiedostonsa eikä koske seurattuihin tiedostoihin (päätyöpuussa muiden työt).
  # shellcheck disable=SC2064
  trap "rm -f '$koe_vanha' '$koe_may' '$koe_muu'; rm -rf '$tmp'" EXIT
  for f in "$koe_vanha" "$koe_may" "$koe_muu"; do
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

  # T-63-G: tuontitarkistus ajetaan väliaikaisessa hakemistopuussa (ei kirjoiteta päätyöpuuhun).
  local tp="$tmp/tuonti/$adapteri" SALLITUT_TUONNIT=""
  mkdir -p "$tp/vertailu"
  : > "$tp/puhdas.mjs"
  ( tuontitarkistus "$tmp/tuonti" ) 2>/dev/null; rc=$?
  odota "tuontitarkistus: ei tuonteja" 0 $rc
  printf "import { x } from '../../scopes/palvelu/lahteet.mjs';\n" > "$tp/tuonti.mjs"
  ( tuontitarkistus "$tmp/tuonti" ) 2>"$tmp/err"; rc=$?
  odota "tuontitarkistus: tuonti scopes/-polusta kaataa portin" 1 $rc
  grep -q "^TUONTI: $adapteri/tuonti.mjs:1:" "$tmp/err" || { echo "FAIL: rivi 'TUONTI: …tuonti.mjs:1:' puuttuu" >&2; virheet=1; }
  SALLITUT_TUONNIT="$adapteri/tuonti.mjs:1-1"
  ( tuontitarkistus "$tmp/tuonti" ) 2>/dev/null; rc=$?
  odota "tuontitarkistus: sallittu tiedosto:rivit-poikkeus" 0 $rc
  SALLITUT_TUONNIT="$adapteri/tuonti.mjs:2-3"
  ( tuontitarkistus "$tmp/tuonti" ) 2>/dev/null; rc=$?
  odota "tuontitarkistus: poikkeus ei kata riviä" 1 $rc
  SALLITUT_TUONNIT=""
  rm -f "$tp/tuonti.mjs"
  printf "import { x } from '../../../scopes/palvelu/viestit.mjs';\n" > "$tp/vertailu/tallenna.mjs"
  ( tuontitarkistus "$tmp/tuonti" ) 2>/dev/null; rc=$?
  odota "tuontitarkistus: vertailu/-tuonti ei kaada" 0 $rc
  printf "const kopio = 1; // kopio: scopes/palvelu/toiminnot.mjs:32-73\n// import x from 'scopes/palvelu/a.mjs'\n" > "$tp/kommentti.mjs"
  ( tuontitarkistus "$tmp/tuonti" ) 2>/dev/null; rc=$?
  odota "tuontitarkistus: kommenttirivi ei kaada" 0 $rc
  printf "import {\n  a,\n} from '../../scopes/palvelu/lahteet.mjs';\n" > "$tp/monirivi.mjs"
  ( tuontitarkistus "$tmp/tuonti" ) 2>"$tmp/err"; rc=$?
  odota "tuontitarkistus: monirivinen import kaataa portin" 1 $rc
  grep -q "^TUONTI: $adapteri/monirivi.mjs:3:" "$tmp/err" || { echo "FAIL: rivi 'TUONTI: …monirivi.mjs:3:' puuttuu" >&2; virheet=1; }

  [ "$virheet" = 0 ] && echo "ITSETESTI VIHREÄ" || echo "ITSETESTI PUNAINEN" >&2
  return $virheet
}

id=${1:-}
if [ -z "$id" ]; then
  echo "Käyttö: bash $adapteri/gate.sh <ID> | --itsetesti" >&2
  exit 1
fi
if [ "$id" = "--itsetesti" ]; then
  itsetesti
  exit $?
fi
if ! testit "$id" >/dev/null; then
  echo "VIRHE: tuntematon ID $id" >&2
  exit 1
fi
case "$id" in T-25|T-37|T-63|T-89|T-92|T-94|T-95|T-103) GATE_MAY="$GATE_MAY scopes2/kaynnista.sh" ;; esac
echo "=== PORTTI: $id ==="
aja aja_testit "$id"
rc=$?
if [ $rc = 0 ]; then echo "PORTTI VIHREÄ: $id"; else echo "PORTTI PUNAINEN: $id (exit $rc)" >&2; fi
exit $rc
