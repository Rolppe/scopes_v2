#!/usr/bin/env bash
# T-88 kohta (5) (ARK-19 hyväksyntäajo, EI tuotantoa): koeadapteri kuivatilassa portissa 18822 omalla HOMElla ja tilahakemistolla.
#   bash scopes2/adapteri/vertailu/t88-koe.sh
# Vain adapteri: --ydin osoittaa suljettuun porttiin 18829 (ei kirjoita ytimeen), ei portteja 8787/8797/8798. adb, ssh, ping, python3 ja tmux ovat
# mockeja (testidata/tmux-mock), joten laitteeseen, palvelimeen ja WoL:iin ei koske; mockin loki todistaa, ettei tilaa muuttavaa komentoa ajettu.
# SCOPES2_ANDROID_KUIVA=1 ja SCOPES2_LINUX_KUIVA=1. Siivous tarkoilla pid-numeroilla (ei pkill -f). Exit 0 = kaikki OK.
set -u
tama=$(cd "$(dirname "$0")" && pwd)
juuri=$(git -C "$tama" rev-parse --show-toplevel)
node22=$HOME/.local/opt/node-v22.23.3-linux-arm64/bin/node
NODE=${NODE:-node}; [ -x "$node22" ] && NODE=$node22
pT=18822 pY=18829
for p in $pT $pY; do curl -fsS -m 1 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1 && { echo "VIRHE: portti $p on jo käytössä" >&2; exit 1; }; done

koe=/tmp/t88-koe; koti=$koe/koti
rm -rf "$koe"; mkdir -p "$koti/.config/scopes2" "$koti/istunnot" "$koti/projektit" "$koti/.claude/skills/keskustelun-siirto/state" "$koe/agy" "$koe/mockdata"
head -c 48 /dev/urandom | base64 | tr -d '=+/\n' > "$koti/.config/scopes2/avain"
chmod 600 "$koti/.config/scopes2/avain"
mock=$juuri/scopes2/adapteri/testidata/tmux-mock
printf '%s' '[{"sisaltaa":"dumpsys power","stdout":"mWakefulness=Awake\n"},{"sisaltaa":"wm size","stdout":"Physical size: 1080x2400\n"},{"sisaltaa":"uiautomator dump","stdout":"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\" ?><hierarchy rotation=\"0\"><node index=\"0\" text=\"\" resource-id=\"\" class=\"android.widget.Button\" content-desc=\"Send\" clickable=\"true\" bounds=\"[100][2000][300][2100]\" /><node index=\"1\" text=\"\" resource-id=\"\" class=\"android.widget.Button\" content-desc=\"New chat\" clickable=\"true\" bounds=\"[400][100][600][200]\" /></hierarchy>"}]' > "$koe/mockdata/adb.json"
pidit=""
siivoa() { for p in $pidit; do kill "$p" 2>/dev/null; done; for p in $pidit; do wait "$p" 2>/dev/null; done; rm -rf "$koe"; }
trap siivoa EXIT
status0=$(git -C "$juuri" status --porcelain -- scopes/ | md5sum)

env HOME="$koti" PATH="$mock:$(dirname "$NODE"):/usr/bin:/bin" TMUX_MOCK_LOKI="$koe/mock.loki" TMUX_MOCK_DATA="$koe/mockdata" \
  SCOPES_JUURI="$juuri" SCOPES2_ANDROID_KUIVA=1 SCOPES2_LINUX_KUIVA=1 \
  "$NODE" --max-old-space-size=256 "$juuri/scopes2/adapteri/adapteri.mjs" --ydin "http://127.0.0.1:$pY" --projektit "$koti/projektit" \
  --istunnot "$koti/istunnot" --agy "$koe/agy" --adb koe-laite:1 --toiminnot $pT >"$koe/adapteri.loki" 2>&1 & pidit="$pidit $!"; adapteri_pid=$!

for _ in $(seq 1 60); do curl -fsS -m 1 "http://127.0.0.1:$pT/api/terveys" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS -m 2 "http://127.0.0.1:$pT/api/terveys" >/dev/null 2>&1 || { echo "FAIL: portti $pT ei vastaa"; tail -5 "$koe/adapteri.loki"; exit 1; }

rc=0
"$NODE" "$tama/t88-tarkista.mjs" --adapteri "http://127.0.0.1:$pT" --avain "$koti/.config/scopes2/avain" --mockdata "$koe/mockdata" \
  --mockloki "$koe/mock.loki" --toimintoloki "$koti/.local/state/scopes2/toiminnot.loki" || rc=1
kb=$(awk '/^VmHWM/{print $2}' "/proc/$adapteri_pid/status" 2>/dev/null)
if [ -n "$kb" ] && [ "$kb" -lt 524288 ]; then echo "OK 5: adapteri VmHWM $((kb / 1024)) MiB < 512"; else echo "FAIL 5: adapteri VmHWM ${kb:-?} kB"; rc=1; fi
[ "$status0" = "$(git -C "$juuri" status --porcelain -- scopes/ | md5sum)" ] && echo "OK 5: git status -- scopes/ ennallaan" || { echo "FAIL 5: git status -- scopes/ muuttui"; rc=1; }
echo "T-88-KOE (5): $([ $rc = 0 ] && echo VIHREÄ || echo PUNAINEN)"
exit $rc
