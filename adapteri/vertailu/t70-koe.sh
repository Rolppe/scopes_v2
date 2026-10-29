#!/usr/bin/env bash
# T-70-koe (ARK-16 hyväksyntäajon harjoitus, EI tuotantoa): vanha palvelu, ydin ja adapteri testiporteissa eristetyssä HOMEssa.
#   bash scopes2/adapteri/vertailu/t70-koe.sh
# Portit: ydin 18830, vanha 18831, adapterin toiminnot 18832 (GATE_*-portit 18820-18822 jäävät vapaiksi). Ei portteja 8787/8797/8798.
# Vaiheet: (1)(2)(7) vertailu, (5) VmHWM < 512 MiB ja vanhan terveys, (3) adapteri kiinni → 503 ja vanhan toimintoloki ei kasva,
# git status -- scopes/ ennallaan. Adb, tmux ja ssh ovat tmux-mockeja (testidata/tmux-mock), linux/android kuivana.
# SOLMU = ydinbinääri (oletus scopes2/ydin/target/release/scopes-solmu; T-84:n jälkeen julkaise.sh --koe:n binääri).
# Siivous tarkoilla pid-numeroilla (ei pkill -f). Exit 0 = kaikki OK.
set -u
tama=$(cd "$(dirname "$0")" && pwd)
juuri=$(git -C "$tama" rev-parse --show-toplevel)
node22=$HOME/.local/opt/node-v22.23.3-linux-arm64/bin/node
NODE=${NODE:-node}; [ -x "$node22" ] && NODE=$node22
solmu=${SOLMU:-$juuri/scopes2/ydin/target/release/scopes-solmu}
[ -x "$solmu" ] || { echo "KÄÄNNÄ: $solmu puuttuu" >&2; exit 3; }
pY=18830 pV=18831 pT=18832
for p in $pY $pV $pT; do curl -fsS -m 1 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1 && { echo "VIRHE: portti $p on jo käytössä" >&2; exit 1; }; done

koe=/tmp/t70-koe; koti=$koe/koti
rm -rf "$koe"; mkdir -p "$koti/.config/scopes" "$koti/.config/scopes2" "$koti/istunnot" "$koti/projektit" "$koti/.claude/skills/keskustelun-siirto/state" "$koe/agy" "$koe/data" "$koe/mockdata"
head -c 48 /dev/urandom | base64 | tr -d '=+/\n' > "$koti/.config/scopes/avain"
head -c 48 /dev/urandom | base64 | tr -d '=+/\n' > "$koti/.config/scopes2/avain"
chmod 600 "$koti/.config/scopes/avain" "$koti/.config/scopes2/avain"
mock=$juuri/scopes2/adapteri/testidata/tmux-mock
pidit=""
siivoa() { for p in $pidit; do kill "$p" 2>/dev/null; done; for p in $pidit; do wait "$p" 2>/dev/null; done; rm -rf "$koe"; }
trap siivoa EXIT

# env-etuliite taulukkona: taustalle ajettu funktio forkkaisi aliprosessin (pid ≠ ajettava), env sen sijaan exec:aa ajettavan samaan pid:hen.
ymp=(env HOME="$koti" PATH="$mock:$(dirname "$NODE"):/usr/bin:/bin" TMUX_MOCK_LOKI="$koe/mock.loki" TMUX_MOCK_DATA="$koe/mockdata")
status0=$(git -C "$juuri" status --porcelain -- scopes/ | md5sum)

# vanha palvelu (8787:n koodi) eristettynä
toimintoloki=$koti/toiminnot-vanha.loki
"${ymp[@]}" SCOPES_PORTTI=$pV SCOPES_JUURI="$juuri" CLAUDE_ISTUNNOT_DIR="$koti/istunnot" CLAUDE_PROJEKTIT_DIR="$koti/projektit" \
  SCOPES_CHAT_DIR="$koti/chat" SCOPES_LIITTEET_DIR="$koti/liitteet" SCOPES_AVAIN_TIEDOSTO="$koti/.config/scopes/avain" \
  SCOPES_TILA_DIR="$koti/.claude/skills/keskustelun-siirto/state" SCOPES_TOIMINTOLOKI="$toimintoloki" SCOPES_PYYNTOLOKI="$koti/pyynnot.loki" \
  SCOPES_APPILOKI="$koti/app.loki" SCOPES_LINUX_KUIVA=1 SCOPES_ANDROID_KUIVA=1 SCOPES_ANDROID_LAITE=koe-laite:1 SCOPES_ANDROID_DIR="$koti/android" \
  SCOPES_WG_TIEDOSTO="$koti/wg.conf" SCOPES_NEBIUS_TIEDOSTO="$koti/ei-nebius" \
  "$NODE" "$juuri/scopes/palvelu/palvelin.mjs" >"$koe/vanha.loki" 2>&1 & pidit="$pidit $!"; vanha_pid=$!
# ydin --vanha --adapteri
"${ymp[@]}" "$solmu" --portti $pY --data "$koe/data" --avain "$koti/.config/scopes2/avain" --vanha "http://127.0.0.1:$pV" \
  --vanha-avain "$koti/.config/scopes/avain" --adapteri "http://127.0.0.1:$pT" >"$koe/ydin.loki" 2>&1 & pidit="$pidit $!"; ydin_pid=$!
sleep 1
# adapteri
"${ymp[@]}" SCOPES_JUURI="$juuri" "$NODE" --max-old-space-size=512 "$juuri/scopes2/adapteri/adapteri.mjs" --ydin "http://127.0.0.1:$pY" --projektit "$koti/projektit" \
  --istunnot "$koti/istunnot" --agy "$koe/agy" --adb koe-laite:1 --android-kuiva --chat "$koti/chat" --toiminnot $pT >"$koe/adapteri.loki" 2>&1 & pidit="$pidit $!"; adapteri_pid=$!

for _ in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$pV/api/terveys" >/dev/null 2>&1 && curl -fsS -m 1 "http://127.0.0.1:$pY/api/terveys" >/dev/null 2>&1 \
    && curl -fsS -m 1 "http://127.0.0.1:$pT/api/terveys" >/dev/null 2>&1 && break
  sleep 0.5
done
for p in $pY $pV $pT; do curl -fsS -m 2 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1 || { echo "FAIL: portti $p ei vastaa"; tail -5 "$koe"/*.loki; exit 1; }; done
# ydin oppii adapterin reitit (5 s:n haku, kun lista tuntematon)
a2=$(cat "$koti/.config/scopes2/avain")
for _ in $(seq 1 40); do
  h=$(curl -sS -m 3 -o /dev/null -D - -H "Authorization: Bearer $a2" "http://127.0.0.1:$pY/api/purkajat" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-lahde"{print $2}')
  [ "$h" = adapteri ] && break; sleep 0.5
done
echo "ADAPTERIN REITIT YDIN TUNTEE: X-Lahde=${h:-puuttuu}"
rc=0
"$NODE" "$tama/t70-tarkista.mjs" vertailu --ydin "http://127.0.0.1:$pY" --vanha "http://127.0.0.1:$pV" --adapteri "http://127.0.0.1:$pT" \
  --avain2 "$koti/.config/scopes2/avain" --avain1 "$koti/.config/scopes/avain" || rc=1

# (5) vanhan terveys, VmHWM
curl -fsS -m 3 "http://127.0.0.1:$pV/api/terveys" >/dev/null && echo "OK 5: vanha terveys 200 ennen" || { echo "FAIL 5: vanha terveys"; rc=1; }
for n in "ydin $ydin_pid" "adapteri $adapteri_pid"; do
  set -- $n; kb=$(awk '/^VmHWM/{print $2}' "/proc/$2/status" 2>/dev/null)
  if [ -n "$kb" ] && [ "$kb" -lt 524288 ]; then echo "OK 5: $1 VmHWM $((kb / 1024)) MiB < 512"; else echo "FAIL 5: $1 VmHWM ${kb:-?} kB"; rc=1; fi
done
# (3) adapteri kiinni → 503; vanhan toimintoloki ei kasva ajon (3) aikana
kill "$adapteri_pid" 2>/dev/null; wait "$adapteri_pid" 2>/dev/null
loki1=$( [ -f "$toimintoloki" ] && wc -c < "$toimintoloki" || echo 0 )
"$NODE" "$tama/t70-tarkista.mjs" pysaytetty --ydin "http://127.0.0.1:$pY" --vanha "http://127.0.0.1:$pV" --avain2 "$koti/.config/scopes2/avain" --avain1 "$koti/.config/scopes/avain" || rc=1
loki2=$( [ -f "$toimintoloki" ] && wc -c < "$toimintoloki" || echo 0 )
[ "$loki1" = "$loki2" ] && echo "OK 3: vanhan toimintoloki ei kasvanut adapterin ollessa kiinni ($loki1 tavua)" || { echo "FAIL 3: vanhan toimintoloki kasvoi $loki1 → $loki2"; rc=1; }
curl -fsS -m 3 "http://127.0.0.1:$pV/api/terveys" >/dev/null && echo "OK 5: vanha terveys 200 jälkeen" || { echo "FAIL 5: vanha terveys jälkeen"; rc=1; }
[ "$status0" = "$(git -C "$juuri" status --porcelain -- scopes/ | md5sum)" ] && echo "OK 5: git status -- scopes/ ennallaan" || { echo "FAIL 5: git status -- scopes/ muuttui"; rc=1; }
echo "T-70-KOE: $([ $rc = 0 ] && echo VIHREÄ || echo PUNAINEN)"
exit $rc
