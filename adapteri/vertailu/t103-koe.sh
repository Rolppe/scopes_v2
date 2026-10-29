#!/usr/bin/env bash
# T-103 koeinstanssi (kutsuu gate.sh:n t103): kaynnista.sh:n täyskäynnistys pysäyttää vanhan adapterin, lukko, --sammuta tarkistaa komentorivin.
#   t103-koe.sh <juuri> <GATE_SOLMU> <node>   ympäristö: GATE_KOEPORTTI (18820), GATE_KOEVANHA (18821), GATE_KOETOIMINNOT (18822)
# Oma HOME ja SCOPES2_TILA /tmp/scopes2-koe103. Ei portteja 8797, 8787 eikä 8798. Tulostaa ok/FAIL-rivit; exit 0 vain jos kaikki ok.
set -u
juuri=$1; solmu=$2; node_bin=$3
adapteri=scopes2/adapteri
koe=/tmp/scopes2-koe103; koti=$koe/koti
portti=${GATE_KOEPORTTI:-18820}; vanha=${GATE_KOEVANHA:-18821}; toim=${GATE_KOETOIMINNOT:-18822}
fix="$juuri/$adapteri/testidata/istunnot6/projektit"
rc=0; mockpid=""; valepid=""; sleeppid=""
for p in "$portti" "$vanha" "$toim"; do
  if curl -fsS -m 2 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1; then echo "VIRHE: koeportti $p on jo käytössä" >&2; exit 1; fi
done
[ -d "$fix" ] || "$node_bin" "$juuri/$adapteri/testidata/luo-istunnot6.mjs" >/dev/null || exit 1
rm -rf "$koe"; mkdir -p "$koti/.config/scopes" "$koe/agy" "$koe/tila"
echo koe-vanha-avain > "$koti/.config/scopes/avain"
"$node_bin" "$juuri/$adapteri/testidata/mock-vanha.mjs" "$vanha" & mockpid=$!
for _ in $(seq 1 30); do curl -fsS -m 1 "http://127.0.0.1:$vanha/api/terveys" >/dev/null 2>&1 && break; sleep 0.2; done

kaynnista() { # <ulostulotiedosto> [--sammuta] → exit-koodi tiedostoon <ulostulotiedosto>.rc
  command env HOME="$koti" NODE="$node_bin" SCOPES2_TILA="$koe/tila" SCOPES2_AVAIN="$koti/.config/scopes2/avain" SCOPES2_SOLMU="$solmu" SCOPES2_TOIMINNOT="$toim" \
    bash "$juuri/scopes2/kaynnista.sh" --portti "$portti" --data "$koe/data" --projektit "$fix" --vanha "http://127.0.0.1:$vanha" \
    --istunnot "$(dirname "$fix")/istunnot" --agy "$koe/agy" --brain "" --adb "" "${@:2}" >"$1" 2>&1
  echo $? > "$1.rc"
}
sammuta() { kaynnista "$koe/sammuta.ulos" --sammuta; }
# Kaksoishaarukka: prosessi ei jää tämän kuoren zombiksi (kill -0 näkisi sen elävänä).
valeprosessi() { # <argv0> → pid tiedostoon $koe/vale.pid
  ( ( exec -a "$1" sleep 300 ) >/dev/null 2>&1 & echo $! > "$koe/vale.pid" )
  sleep 0.3; cat "$koe/vale.pid"
}

# (a) kuollut ydin + elävä valeadapteri pidit-tiedostossa
kuollut=$(valeprosessi "scopes-solmu-kuollut"); kill "$kuollut"; sleep 0.3
valepid=$(valeprosessi "node adapteri.mjs")
printf 'ydin %s\nadapteri %s\n' "$kuollut" "$valepid" > "$koe/tila/pidit"
kaynnista "$koe/a.ulos"
uusi=$(awk '$1=="adapteri"{print $2}' "$koe/tila/pidit")
if [ "$(cat "$koe/a.ulos.rc")" = 0 ] && ! kill -0 "$valepid" 2>/dev/null && [ -n "$uusi" ] && [ "$uusi" != "$valepid" ] \
   && kill -0 "$uusi" 2>/dev/null && grep -q "^ADAPTERI: vanha $valepid pysäytetty" "$koe/a.ulos"; then
  echo "ok T-103 (a): vanha adapteri $valepid pysäytetty, uusi $uusi"
else
  echo "FAIL T-103 (a): exit $(cat "$koe/a.ulos.rc"), vale $valepid, uusi '${uusi:-}'" >&2; cat "$koe/a.ulos" >&2; rc=1
fi
sammuta
kill "$valepid" 2>/dev/null

# (b) kaksi ajoa yhtä aikaa (puhdas tila)
rm -f "$koe/tila/pidit"; rm -rf "$koe/data"
kaynnista "$koe/b1.ulos" & b1=$!
kaynnista "$koe/b2.ulos" & b2=$!
wait "$b1" "$b2"
lukkoja=$(cat "$koe/b1.ulos" "$koe/b2.ulos" | grep -c '^LUKKO:')
l1=$(grep -c '^LUKKO:' "$koe/b1.ulos"); l2=$(grep -c '^LUKKO:' "$koe/b2.ulos")
ytimia=$(pgrep -f -- "--portti $portti --data $koe/data" | wc -l | tr -d ' ')
if [ "$lukkoja" = 1 ] && [ $((l1 + l2)) = 1 ] && [ "$ytimia" = 1 ]; then
  echo "ok T-103 (b): täsmälleen yksi LUKKO-rivi, ytimiä $ytimia"
else
  echo "FAIL T-103 (b): LUKKO-rivejä $lukkoja (b1 $l1, b2 $l2), ytimiä $ytimia" >&2; cat "$koe/b1.ulos" "$koe/b2.ulos" >&2; rc=1
fi
sammuta

# (c) --sammuta ei tapa väärää prosessia adapteri-rivillä
sleeppid=$(valeprosessi "sleep")
printf 'adapteri %s\n' "$sleeppid" > "$koe/tila/pidit"
sammuta
if kill -0 "$sleeppid" 2>/dev/null && grep -q 'ohitettu' "$koe/sammuta.ulos"; then
  echo "ok T-103 (c): sleep $sleeppid elää, --sammuta ohitti sen"
else
  echo "FAIL T-103 (c): sleep elää: $(kill -0 "$sleeppid" 2>/dev/null && echo kyllä || echo ei); ulostulo:" >&2; cat "$koe/sammuta.ulos" >&2; rc=1
fi
kill "$sleeppid" 2>/dev/null

kill "$mockpid" 2>/dev/null; wait "$mockpid" 2>/dev/null
for p in "$portti" "$vanha" "$toim"; do
  if curl -fsS -m 2 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1; then echo "FAIL T-103: koeportti $p kuuntelee ajon jälkeen" >&2; rc=1; fi
done
[ $rc = 0 ] && rm -rf "$koe" || echo "T-103: koehakemisto jätetty tutkittavaksi: $koe" >&2
exit $rc
