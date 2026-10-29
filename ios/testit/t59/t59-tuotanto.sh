#!/bin/bash
# T-59 (4)(5) (T-57:n siirretyt, poikkeamapäätös 21.10.2026; käyttäjän lupa vain luku -ajoon 21.10.2026, overseer 5f1d29eb):
# A = tuotannon ydin 8797 ssh-tunnelin kautta (vain luku), B = simulaattorin scopes-V2 ikkunalla 7 vrk / 38 Mt, headless (ei
# UI-tilan synkkaa eikä näkymäpyyntöjä ennen katkaisua). B:n vertainen on lukuvälitys (lukuvalitys.mjs: vain GET ja POST
# /api/hae; muut 403), joten B ei kirjoita tuotantoon. (5) välitys pois tasauksen jälkeen → B:n /viestit = A:n tilannekuva
# jokaiselle ikkunan sisäiselle skoopille; (4) välitys takaisin → B = A (myös työkalu-, kysymys- ja vastausrivit).
# Käyttö: bash t59-tuotanto.sh <ScopesV2.app (iphonesimulator)>   Tuloste: T59 (5) …, T59 (4) …, T59-TUOTANTO VIHREÄ|PUNAINEN.
set -u
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
T=$(cd "$(dirname "$0")" && pwd)
APP=${1:?ScopesV2.app puuttuu}
SIM=${T59_SIM:-iPhone 15 Pro}
VRK=7 MAX_SKOOPIT=${T59_MAX:-25}
S=$(mktemp -d /tmp/t59-tuotanto.XXXXXX); chmod 700 "$S"
vapaa() { local p=$1; while lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 || [ "$p" = 8797 ] || [ "$p" = 18797 ]; do p=$((p+1)); done; echo $p; }
MP=$(vapaa 18860); LP=$(vapaa $((MP+1))); AP=$(vapaa $((LP+1)))
TP="" VP=""
siivous() {
  xcrun simctl terminate "$SIM" com.example.scopes-v2 >/dev/null 2>&1
  [ -n "$VP" ] && kill "$VP" 2>/dev/null; [ -n "$TP" ] && kill "$TP" 2>/dev/null
  rm -f "$S/avain" "$S/otsikko"; rm -rf "$S/b-data"
  echo "SIIVOUS: tunneli ja välitys pois, avain poistettu (loki $S)"
}
trap siivous EXIT
(umask 077; ssh -o BatchMode=yes -o ConnectTimeout=10 palvelin 'cat ~/.config/scopes2/avain' > "$S/avain") || { echo "VIRHE: avain"; exit 1; }
(umask 077; printf 'Authorization: Bearer %s\n' "$(cat "$S/avain")" > "$S/otsikko")
k() { curl -fsS -m 30 -H "@$S/otsikko" "$@"; }
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L "127.0.0.1:$MP:127.0.0.1:8797" palvelin & TP=$!
for _ in $(seq 1 20); do k "http://127.0.0.1:$MP/api/terveys" >/dev/null 2>&1 && break; sleep 1; done
k "http://127.0.0.1:$MP/api/terveys" >/dev/null || { echo "VIRHE: tunneli 8797 ei vastaa"; exit 1; }
valitys() { node "$T/lukuvalitys.mjs" "$LP" "$MP" "$S/valitys.loki" & VP=$!; sleep 1; }
valitys
echo "T59-TUOTANTO: tunneli $MP → 8797, välitys $LP, B-portti $AP, ikkuna $VRK vrk"
xcrun simctl boot "$SIM" >/dev/null 2>&1; xcrun simctl bootstatus "$SIM" -b >/dev/null 2>&1
xcrun simctl install "$SIM" "$APP" || { echo "VIRHE: asennus simulaattoriin"; exit 1; }
SIMCTL_CHILD_SCOPES2_AVAIN="$(cat "$S/avain")" SIMCTL_CHILD_SCOPES2_VERTAINEN="http://127.0.0.1:$LP" SIMCTL_CHILD_SCOPES2_PORTTI="$AP" \
  SIMCTL_CHILD_SCOPES2_DATA="$S/b-data" SIMCTL_CHILD_SCOPES2_KUITTAUS=pois \
  xcrun simctl launch --terminate-running-process "$SIM" com.example.scopes-v2 -scopes2.peili-ikkuna-vrk 7 -scopes2.headless YES >/dev/null \
  || { echo "VIRHE: käynnistys"; exit 1; }
B="http://127.0.0.1:$AP" A="http://127.0.0.1:$MP"
for _ in $(seq 1 60); do k "$B/api/terveys" >/dev/null 2>&1 && break; sleep 1; done
k "$B/api/terveys" >/dev/null || { echo "VIRHE: B ei vastaa"; exit 1; }
# Tasaus ilman näkymäpyyntöjä: /api/peili/koko (ei näkymä) vakaa 3 peräkkäistä kertaa 5 s välein, enintään 600 s
ed="" sama=0 alku=$SECONDS
while [ $((SECONDS - alku)) -lt 600 ]; do
  nyt=$(k "$B/api/peili/koko" 2>/dev/null)
  if [ -n "$nyt" ] && [ "$nyt" = "$ed" ] && ! printf '%s' "$nyt" | grep -q '"yksikot":0'; then sama=$((sama+1)); else sama=0; fi
  [ "$sama" -ge 3 ] && break; ed=$nyt; sleep 5
done
echo "T59 tasaus: $((SECONDS - alku)) s, B /api/peili/koko $nyt"
# Ikkunan sisäiset skoopit A:sta (A:n /viestit on täyden solmun luku, ei B:n näkymäpyyntö)
k "$A/api/skoopit" > "$S/a-skoopit.json" || { echo "VIRHE: A /api/skoopit"; exit 1; }
python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));d=d.get('skoopit',d) if isinstance(d,dict) else d;print('\n'.join(x['nimi'] for x in d))" "$S/a-skoopit.json" > "$S/nimet.txt"
: > "$S/valitut.txt"
while IFS= read -r n; do
  f="$S/a-$(printf '%s' "$n" | tr -c 'A-Za-z0-9' '_').json"
  k "$A/api/skoopit/$(python3 -I -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$n")/viestit" > "$f" 2>/dev/null || continue
  python3 -I -c "
import json,sys,datetime as dt
v=json.load(open(sys.argv[1])).get('viestit',[]);r=dt.datetime.now(dt.timezone.utc)-dt.timedelta(days=7)
ok=any(x.get('aika') and dt.datetime.fromisoformat(x['aika'].replace('Z','+00:00'))>=r for x in v);sys.exit(0 if ok else 1)" "$f" && echo "$n" >> "$S/valitut.txt"
  [ "$(wc -l < "$S/valitut.txt")" -ge "$MAX_SKOOPIT" ] && break
done < "$S/nimet.txt"
echo "T59 ikkunan sisäiset skoopit: $(wc -l < "$S/valitut.txt" | tr -d ' ') / $(wc -l < "$S/nimet.txt" | tr -d ' ')"
tarkista() { # <vaihe> <a-tiedostojen etuliite>: B:n /viestit jokaiselle valitulle skoopille vs A:n tiedosto
  local vaihe=$1 ok=0 ero=0 n f q
  while IFS= read -r n; do
    q=$(python3 -I -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$n"); f=$(printf '%s' "$n" | tr -c 'A-Za-z0-9' '_')
    [ "$vaihe" = 4 ] && k "$A/api/skoopit/$q/viestit" > "$S/a-$f.json" 2>/dev/null
    k "$B/api/skoopit/$q/viestit" > "$S/b$vaihe-$f.json" 2>/dev/null || echo '{}' > "$S/b$vaihe-$f.json"
    tapa=""; [ "$vaihe" = 5 ] && tapa=sisaltaa
    if ! r=$(python3 -I "$T/vertaa-tuotanto.py" "$S/a-$f.json" "$S/b$vaihe-$f.json" "$VRK" $tapa) && [ "$vaihe" = 4 ]; then
      sleep 10; k "$A/api/skoopit/$q/viestit" > "$S/a-$f.json" 2>/dev/null; k "$B/api/skoopit/$q/viestit" > "$S/b$vaihe-$f.json" 2>/dev/null
      r=$(python3 -I "$T/vertaa-tuotanto.py" "$S/a-$f.json" "$S/b$vaihe-$f.json" "$VRK")
    fi
    case "$r" in SAMA*) ok=$((ok+1)) ;; *) ero=$((ero+1)); echo "  ($vaihe) $n: $r" ;; esac
  done < "$S/valitut.txt"
  echo "$ok $ero"
}
# (5) A tavoittamattomissa: välitys pois (B:n vertainen evää yhteyden)
kill "$VP"; VP=""; sleep 1
curl -s -m 3 "http://127.0.0.1:$LP/api/terveys" >/dev/null 2>&1; rc=$?
tulos5=$(tarkista 5); echo "$tulos5" | sed '$d'
set -- $(echo "$tulos5" | tail -1)
echo "T59 (5) A tavoittamattomissa (curl välitykseen exit $rc): sama $1, ero $2 / $(wc -l < "$S/valitut.txt" | tr -d ' ') skooppia"
v5=$2
# (4) välitys takaisin; S-9e-haku käynnistyy näkymäpyynnöstä (HAKUVALI 60 s) → kaksi kierrosta 70 s välein, viimeinen ratkaisee
valitys; sleep 5; tarkista 4 >/dev/null; sleep 70
tulos4=$(tarkista 4); echo "$tulos4" | sed '$d'
set -- $(echo "$tulos4" | tail -1)
echo "T59 (4) A tavoitettavissa: sama $1, ero $2 / $(wc -l < "$S/valitut.txt" | tr -d ' ') skooppia"
v4=$2
grep -c ESTETTY "$S/valitys.loki" | sed 's/^/T59 lukuvälitys esti kirjoituksia: /'
[ "$(wc -l < "$S/valitut.txt" | tr -d ' ')" -gt 0 ] || { echo "T59-TUOTANTO TYHJÄ: ikkunan sisällä ei yhtään skooppia (ei todiste; tuotannossa ei skoopillista istuntoa)"; exit 2; }
[ "$v4" = 0 ] && [ "$v5" = 0 ] && { echo "T59-TUOTANTO VIHREÄ"; exit 0; }
echo "T59-TUOTANTO PUNAINEN"; exit 1
