#!/usr/bin/env bash
# T-88 kohta (6): koeadapteri palvelimella Macin UI-testejä varten (EI tuotantoa). Sama kuin t88-koe.sh, mutta jää taustalle portissa 18822
# kuivatilassa omalla HOMElla, ja mockit vastaavat kuten T-87:n mock-ohjaus (ruutu 1080×2400, linux päällä). Ydin-URL suljettuun 18829:ään.
#   bash scopes2/adapteri/vertailu/t88-koe-palvelu.sh kaynnista   → tulostaa "PID <n>" ja "AVAIN <polku>"
#   bash scopes2/adapteri/vertailu/t88-koe-palvelu.sh sammuta <pid>   → sammuttaa tarkalla pid:llä ja siivoaa /tmp/t88-koe-palvelu
set -u
tama=$(cd "$(dirname "$0")" && pwd)
juuri=$(git -C "$tama" rev-parse --show-toplevel)
koe=/tmp/t88-koe-palvelu
node22=$HOME/.local/opt/node-v22.23.3-linux-arm64/bin/node
NODE=${NODE:-node}; [ -x "$node22" ] && NODE=$node22
case "${1:-}" in
  kaynnista)
    pT=18822 pY=18829
    for p in $pT $pY; do curl -fsS -m 1 "http://127.0.0.1:$p/api/terveys" >/dev/null 2>&1 && { echo "VIRHE: portti $p on jo käytössä" >&2; exit 1; }; done
    rm -rf "$koe"; koti=$koe/koti
    mkdir -p "$koti/.config/scopes2" "$koti/istunnot" "$koti/projektit" "$koe/mockdata" "$koe/bin" "$koe/agy"
    head -c 48 /dev/urandom | base64 | tr -d '=+/\n' > "$koti/.config/scopes2/avain"; chmod 600 "$koti/.config/scopes2/avain"
    mock=$juuri/scopes2/adapteri/testidata/tmux-mock
    for k in adb ping ssh tmux; do ln -s "$mock/$k" "$koe/bin/$k"; done
    png=$(python3 -c 'import io,base64;from PIL import Image;b=io.BytesIO();Image.new("RGB",(108,240),(200,180,40)).save(b,"PNG");print(base64.b64encode(b.getvalue()).decode())') || { echo "VIRHE: PNG-fixturen luonti (PIL)" >&2; exit 1; }
    printf '[{"sisaltaa":"dumpsys power","stdout":"mWakefulness=Awake\\n"},{"sisaltaa":"wm size","stdout":"Physical size: 1080x2400\\n"},{"sisaltaa":"screencap","stdoutBase64":"%s"}]' "$png" > "$koe/mockdata/adb.json"
    printf '[{"sisaltaa":"192.0.2.99","stdout":"64 bytes from 192.0.2.99: icmp_seq=1 ttl=64 time=0.4 ms\\n"}]' > "$koe/mockdata/ping.json"
    ub=$(python3 -c 'import site; print(site.getuserbase())')
    ( env HOME="$koti" PYTHONUSERBASE="$ub" PATH="$koe/bin:$(dirname "$NODE"):/usr/bin:/bin" TMUX_MOCK_LOKI="$koe/mock.loki" TMUX_MOCK_DATA="$koe/mockdata" \
        SCOPES_JUURI="$juuri" SCOPES2_ANDROID_KUIVA=1 SCOPES2_LINUX_KUIVA=1 \
        setsid "$NODE" --max-old-space-size=256 "$juuri/scopes2/adapteri/adapteri.mjs" --ydin "http://127.0.0.1:$pY" --projektit "$koti/projektit" \
        --istunnot "$koti/istunnot" --agy "$koe/agy" --adb koe-laite:1 --toiminnot $pT >"$koe/adapteri.loki" 2>&1 & echo $! > "$koe/pid" )
    # T-111: terveysvirheessä (exit 1) koeadapteri pysäytetään eikä jää orvoksi; onnistuessa trap puretaan ja adapteri jää käyntiin.
    trap 'p=$(cat "$koe/pid" 2>/dev/null); [ -n "$p" ] && kill "$p" 2>/dev/null' EXIT
    for _ in $(seq 1 60); do curl -fsS -m 1 "http://127.0.0.1:$pT/api/terveys" >/dev/null 2>&1 && break; sleep 0.5; done
    curl -fsS -m 2 "http://127.0.0.1:$pT/api/terveys" >/dev/null 2>&1 || { echo "VIRHE: koeadapteri ei vastaa" >&2; tail -5 "$koe/adapteri.loki" >&2; exit 1; }
    trap - EXIT
    echo "PID $(cat "$koe/pid")"
    echo "AVAIN $koti/.config/scopes2/avain"
    ;;
  sammuta)
    pid=${2:?pid puuttuu}
    kill "$pid" 2>/dev/null; sleep 0.5
    echo "mock-loki (adb/ping/ssh/tmux-kutsut):"; [ -f "$koe/mock.loki" ] && sed -E 's/"syote":"[^"]*",?//' "$koe/mock.loki" | cut -c1-200 | tail -40
    rm -rf "$koe"
    curl -fsS -m 1 http://127.0.0.1:18822/api/terveys >/dev/null 2>&1 && echo "VAROITUS: 18822 yhä auki" || echo "18822 vapaa"
    ;;
  *) echo "käyttö: t88-koe-palvelu.sh kaynnista | sammuta <pid>" >&2; exit 2 ;;
esac
