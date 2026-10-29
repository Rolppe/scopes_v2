#!/usr/bin/env bash
# T-88 kohta (6) (ARK-19 hyväksyntäajo, Mac): T-87:n UI-testit (gate.sh T-87) koeydintä vastaan, jonka --adapteri on välittäjä (t88-valitys.mjs) →
# ssh-tunneli → koeadapteri palvelimella (kuivatila, oma HOME, portti 18822). 8787:ää ei käytetä (--vanha = välittäjä), tuotannon 8797/8798/7903
# ei kosketa eikä target/releaseen käännetä (gate.sh koe_polku_ok). Aja omasta git-worktreestä (committoitu ja pushattu HEAD):
#   bash scopes2/adapteri/vertailu/t88-mac.sh
# Tuloste: gate-lokin loppu, välittäjän todiste (mitkä pyynnöt kulkivat oikealle adapterille) ja koeadapterin mock-loki. Exit = gate.sh T-87:n exit.
set -u
tama=$(cd "$(dirname "$0")" && pwd)
juuri=$(git -C "$tama" rev-parse --show-toplevel)
sha=$(git -C "$juuri" rev-parse HEAD)
haara=${T88_HAARA:-claude/charming-brahmagupta-p9hmm7}
lp=${T88_TUNNELIPORTTI:-18822}
lokihak=$(mktemp -d /tmp/t88-mac.XXXXXX); chmod 700 "$lokihak"
tunneli_pid=""; palvelu_pid=""
siivoa() {
  [ -n "$tunneli_pid" ] && { kill "$tunneli_pid" 2>/dev/null; wait "$tunneli_pid" 2>/dev/null; }
  if [ -n "$palvelu_pid" ]; then
    ssh -o BatchMode=yes palvelin "bash /tmp/t88-klooni/scopes2/adapteri/vertailu/t88-koe-palvelu.sh sammuta $palvelu_pid; rm -rf /tmp/t88-klooni" 2>&1 | sed 's/^/PALVELU: /'
  fi
  rm -rf "$lokihak"
}
trap siivoa EXIT

lsof -nP -iTCP:"$lp" -sTCP:LISTEN >/dev/null 2>&1 && { echo "VIRHE: Macin portti $lp on jo käytössä" >&2; exit 1; }
[ -z "$(git -C "$juuri" status --porcelain -- scopes2/ scopes/)" ] || { echo "VIRHE: työpuu ei ole puhdas (aja committoidusta worktreestä)" >&2; exit 1; }

echo "== koeadapteri palvelimelle ($sha)"
ssh -o BatchMode=yes palvelin "rm -rf /tmp/t88-klooni; git clone -q -b $haara github-claude-project:Rolppe/claude_project.git /tmp/t88-klooni && git -C /tmp/t88-klooni checkout -q $sha && bash /tmp/t88-klooni/scopes2/adapteri/vertailu/t88-koe-palvelu.sh kaynnista" > "$lokihak/palvelu.out" 2>&1
cat "$lokihak/palvelu.out" | grep -v '^AVAIN' | sed 's/^/PALVELU: /'
palvelu_pid=$(sed -n 's/^PID //p' "$lokihak/palvelu.out")
avain_etela=$(sed -n 's/^AVAIN //p' "$lokihak/palvelu.out")
[ -n "$palvelu_pid" ] && [ -n "$avain_etela" ] || { echo "VIRHE: koeadapteri ei käynnistynyt" >&2; palvelu_pid=""; exit 1; }
( umask 077; ssh -o BatchMode=yes palvelin "cat $avain_etela" > "$lokihak/yla-avain" )

echo "== ssh-tunneli Mac:$lp → koeadapteri 18822"
ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -o ServerAliveInterval=30 -L "127.0.0.1:$lp:127.0.0.1:18822" palvelin &
tunneli_pid=$!
for _ in $(seq 1 20); do curl -fsS -m 1 "http://127.0.0.1:$lp/api/terveys" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS -m 2 "http://127.0.0.1:$lp/api/terveys" >/dev/null 2>&1 || { echo "VIRHE: tunneli ei toimi" >&2; exit 1; }

echo "== gate.sh T-87 (välittäjä koeadapterille)"
export GATE_OHJAUS_MOCK="$tama/t88-valitys.mjs"
export GATE_OHJAUS_LISA="--ylavirta http://127.0.0.1:$lp --ylavirta-avain $lokihak/yla-avain --todiste $lokihak/todiste.jsonl"
bash "$juuri/scopes2/shared/gate.sh" T-87 > "$lokihak/gate.out" 2>&1
rc=$?
cp "$lokihak/gate.out" "${T88_GATE_LOKI:-/tmp/t88-mac-gate.out}"   # koko gate-loki säilyy siivouksen yli
grep -E "^(==|OK|FAIL|VAIHE|PORTTI|OHJAUS|Test Case|Executed|\*\* TEST)|error:|Unable to|SIMULAATTORI" "$lokihak/gate.out" | cut -c1-240 | tail -60
echo "== välittäjän todiste: pyynnöt, jotka kulkivat oikealle koeadapterille"
[ -f "$lokihak/todiste.jsonl" ] && cut -c1-260 "$lokihak/todiste.jsonl" | sed -E 's/"aika":"[^"]*",//' | sort | uniq -c | sort -rn | head -30 || echo "(ei yhtään)"
echo "T-88-MAC (6): exit $rc"
exit $rc
