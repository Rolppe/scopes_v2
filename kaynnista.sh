#!/usr/bin/env bash
# Käynnistää scopes2-ytimen (portti 8797) ja adapterin vanhan palvelun (8787) rinnalle (T-25).
#   scopes2/kaynnista.sh [--portti 8797] [--vanha http://127.0.0.1:8787] [--data ~/.local/share/scopes2-ydin]
#                        [--projektit ~/.claude/projects] [--sammuta] [--vain-tarkista]
#                        [--istunnot ~/.claude/sessions] [--agy ~/.gemini/antigravity-cli/conversations]
#                        [--brain ~/.gemini/antigravity-cli/brain] [--adb 127.0.0.1:5555]
# Web-asiakas: SCOPES2_WEB = dist-hakemisto (oletus scopes2/web/dist; tyhjä = ei web-tarjoilua), annetaan ytimelle --web:nä.
# Lähdeliput (T-34 ajo 3, briefin T-25 Poikkeama) välitetään adapterille; tyhjä arvo jättää lähteen pois. Ilman
# lähdetilaa ytimen johdetut reitit vastaavat kokonaan sillasta (X-Lahde: silta) vanhan 8787:n viiveellä.
# Idempotentti ja cron-kelpoinen: jos /api/terveys vastaa ja pidit-tiedoston adapteri elää, ei tehdä mitään (exit 0).
# T-89: jos ydin vastaa mutta adapteri on kuollut tai pid puuttuu, käynnistetään vain adapteri uudelleen ("ADAPTERI: uudelleen <pid>",
# pidit-tiedoston adapteri-rivi päivitetään; 1 s jälkeen kuollut → exit 1); --vain-tarkista: kuollut adapteri → exit 1 ilman käynnistystä.
# Ei koske 8787:ään, vanhaan avaimeen (vain luetaan ytimen --vanha-avain) eikä crontabiin.
# Ympäristö (koeajoja varten): SCOPES2_TILA = pid- ja lokitiedoston hakemisto (oletus ~/.local/state),
# SCOPES2_AVAIN = ytimen avaintiedosto (oletus ~/.config/scopes2/avain), NODE = node-binääri,
# SCOPES2_TOIMINNOT = adapterin toimintaportti (T-63-G, S-10; tuotanto 8798, koe 18822): annetaan adapterille --toiminnot:na; tyhjä = ei kuuntelijaa.
# T-92: asetettu portti annetaan myös ytimelle (--adapteri http://127.0.0.1:<portti>), jos ydinbinääri tuntee lipun; muuten lippu jää pois.
# T-95: SCOPES2_CHAT = adapterin chat-hakemisto (oletus ~/.local/state/scopes-chat eli vanhan 8787:n; tyhjä = ei lippua, adapterin oma <tila>/chat): annetaan adapterille --chat:na.
# T-94: SCOPES2_TERVEYS_ODOTUS = terveysodotus sekunteina (oletus 300; tyhjä tai ei-luku = 300): ydin voi ajaa skeemasiirtymän (tuotannossa 51 s) ennen kuin vastaa.
# Ydin, joka elää mutta ei vielä vastaa (siirtymä), odotetaan eikä käynnistetä toista ydintä samaan porttiin ja dataan (cron */5).
# SCOPES2_SOLMU = ydinbinääri (oletus scopes2/ydin/target/release/scopes-solmu; koeajoissa T-93:n julkaisu).
# SCOPES2_ADAPTERI_KEKO = adapterin V8-keon raja megatavuina (oletus 512; T-34 ajo 1 kaatui 2 GB:n kekoon).
# SCOPES2_YDIN_DATARAJA (oletus 1572864) ja SCOPES2_ADAPTERI_DATARAJA (oletus 1048576) = ulimit -d (RLIMIT_DATA, KiB) ytimelle
# ja adapterille (T-37: ylitys kaataa vain sen prosessin, ei OOM-killeriä); tyhjä arvo = ei rajaa.
# Exit: 0 ok, 1 käynnistys epäonnistui tai --vain-tarkista: ei vastaa, 2 virheellinen argumentti, 3 ydinbinääri puuttuu,
# 4 Node 22 puuttuu (NODE tai PATHin node vanhempi kuin 22 eikä ~/.local/opt/node-v22.23.3-linux-arm64 ole).
set -u
node22=$HOME/.local/opt/node-v22.23.3-linux-arm64/bin/node
[ -x "$node22" ] && NODE=${NODE:-$node22}
export PATH="$HOME/.local/bin:${NODE:+$(dirname "$NODE"):}$PATH"
tama=$(cd "$(dirname "$0")" && pwd)

portti=8797
vanha=http://127.0.0.1:8787
data=$HOME/.local/share/scopes2-ydin
projektit=$HOME/.claude/projects
istunnot=$HOME/.claude/sessions
agy=$HOME/.gemini/antigravity-cli/conversations
brain=$HOME/.gemini/antigravity-cli/brain
adb=127.0.0.1:5555
sammuta=0
vain_tarkista=0
while [ $# -gt 0 ]; do
  case "$1" in
    --portti) portti=${2-}; shift 2 || exit 2 ;;
    --vanha) vanha=${2-}; shift 2 || exit 2 ;;
    --data) data=${2-}; shift 2 || exit 2 ;;
    --projektit) projektit=${2-}; shift 2 || exit 2 ;;
    --istunnot) istunnot=${2-}; shift 2 || exit 2 ;;
    --agy) agy=${2-}; shift 2 || exit 2 ;;
    --brain) brain=${2-}; shift 2 || exit 2 ;;
    --adb) adb=${2-}; shift 2 || exit 2 ;;
    --sammuta) sammuta=1; shift ;;
    --vain-tarkista) vain_tarkista=1; shift ;;
    *) echo "tuntematon argumentti $1" >&2; exit 2 ;;
  esac
done
[ -n "$portti" ] || { echo "--portti vaatii arvon" >&2; exit 2; }

if [ -n "${SCOPES2_TILA:-}" ]; then pidit=$SCOPES2_TILA/pidit; else pidit=$HOME/.local/state/scopes2/pidit; fi
if [ -n "${SCOPES2_TILA:-}" ]; then loki=$SCOPES2_TILA/scopes2-palvelu.loki; else loki=$HOME/.local/state/scopes2-palvelu.loki; fi
avain=${SCOPES2_AVAIN:-$HOME/.config/scopes2/avain}
solmu=${SCOPES2_SOLMU:-$tama/ydin/target/release/scopes-solmu}
osoite=http://127.0.0.1:$portti

# T-37: prosessikohtainen datamuistiraja (RLIMIT_DATA, KiB). Tyhjä arvo = ei rajaa. Kutsutaan alikuoressa juuri ennen exec:iä;
# epäonnistuminen ei estä käynnistystä.
ydin_raja=${SCOPES2_YDIN_DATARAJA-1572864}
adapteri_raja=${SCOPES2_ADAPTERI_DATARAJA-1048576}
aseta_raja() { # <nimi> <KiB>
  local syy
  [ -n "$2" ] || return 0
  if syy=$(ulimit -d "$2" 2>&1); then ulimit -d "$2"; else echo "RAJA: ei asetettu ($1: ${syy:-ulimit epäonnistui})" >&2; fi
}
# Luetaan raja takaisin prosessin omasta /proc/<pid>/limits-rivistä "Max data size" (tavut / 1024).
raja_luettu() { # <pid>
  local l
  l=$(awk '/^Max data size/{print $4}' "/proc/$1/limits" 2>/dev/null)
  case "$l" in
    "") echo "?" ;;
    unlimited) echo unlimited ;;
    *) echo $((l / 1024)) ;;
  esac
}

terve() { curl -fsS -m 3 "$osoite/api/terveys" >/dev/null 2>&1; }

# T-103: pid elää ja sen komentorivi sisältää kuvion (/proc/<pid>/cmdline, muuten ps -o args=; pid-uusiokäyttö ei petä).
pid_rooli() { # <pid> <kuvio>
  local args
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/cmdline" ]; then args=$(tr '\0' ' ' < "/proc/$1/cmdline"); else args=$(ps -o args= -p "$1" 2>/dev/null); fi
  printf '%s' "$args" | grep -q -- "$2"
}
# T-89/T-94: pidit-tiedoston <rooli>-rivin pid elää ja komentorivi täsmää kuvioon.
rooli_elaa() { # <rooli> <kuvio>
  local p
  p=$(awk -v r="$1" '$1==r{print $2}' "$pidit" 2>/dev/null)
  [ -n "$p" ] && pid_rooli "$p" "$2"
}
adapteri_elaa() { rooli_elaa adapteri 'adapteri\.mjs'; }
ydin_elaa() { rooli_elaa ydin 'scopes-solmu'; }

# T-103: lukko pidit-tiedoston hakemistoon (cron */5 ei käynnistä kahta ydintä); lapsiprosessit sulkevat fd 9:n (9>&-).
if command -v flock >/dev/null 2>&1; then
  mkdir -p "$(dirname "$pidit")"
  exec 9>"$(dirname "$pidit")/kaynnista.lukko"
  if ! flock -n 9; then echo "LUKKO: toinen kaynnista.sh käynnissä"; exit 0; fi
else
  echo "LUKKO: ei flockia"
fi

if [ "$sammuta" = 1 ]; then
  [ -s "$pidit" ] || { echo "SAMMUTA: ei pid-tiedostoa ($pidit)"; exit 0; }
  lista=""
  while read -r rooli p _; do
    [ -n "${p:-}" ] || continue
    case "$rooli" in ydin) kuvio='scopes-solmu' ;; adapteri) kuvio='adapteri\.mjs' ;; *) kuvio='' ;; esac
    if [ -n "$kuvio" ] && pid_rooli "$p" "$kuvio"; then lista="$p $lista"
    else kill -0 "$p" 2>/dev/null && echo "SAMMUTA: pid $p ei ole $rooli (ohitettu)"; fi
  done < "$pidit"
  for p in $lista; do kill -TERM "$p" 2>/dev/null; done
  for _ in $(seq 1 50); do
    elossa=0
    for p in $lista; do kill -0 "$p" 2>/dev/null && elossa=1; done
    [ "$elossa" = 0 ] && break
    sleep 0.1
  done
  if [ "${elossa:-0}" = 1 ]; then echo "SAMMUTA: prosessi elää vielä 5 s jälkeen ($lista)" >&2; exit 1; fi
  rm -f "$pidit"
  echo "SAMMUTA: ok"
  exit 0
fi

# Adapteri vaatii Node 22:n (node:sqlite). Periytynyt vanhempi NODE tai PATHin /usr/bin/node 20 (ssh-kuori, cron)
# kaatoi adapterin heti (ERR_UNKNOWN_BUILTIN_MODULE): vaihdetaan Node 22:een, tai lopetetaan, jos sitä ei ole.
valitse_node() {
  local node_paa
  NODE=${NODE:-node}
  node_paa=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  if [ "${node_paa:-0}" -lt 22 ] 2>/dev/null || [ -z "$node_paa" ]; then
    if [ -x "$node22" ]; then
      echo "NODE: $NODE on v${node_paa:-?}, käytetään $node22" >&2
      NODE=$node22
    else
      echo "NODE: $NODE on v${node_paa:-?}; adapteri vaatii Node 22:n (node:sqlite)" >&2
      exit 4
    fi
  fi
}

# Käynnistää adapterin taustalle rajoineen ja asettaa adapteri_pid:n (täyskäynnistys ja T-89:n uudelleenkäynnistys).
kaynnista_adapteri() {
  adapteri_args=(--ydin "$osoite" --projektit "$projektit")
  [ -n "$istunnot" ] && adapteri_args+=(--istunnot "$istunnot")
  [ -n "$agy" ] && adapteri_args+=(--agy "$agy")
  [ -n "$brain" ] && adapteri_args+=(--brain "$brain")
  [ -n "$adb" ] && adapteri_args+=(--adb "$adb")
  [ -n "${SCOPES2_TOIMINNOT:-}" ] && adapteri_args+=(--toiminnot "$SCOPES2_TOIMINNOT")
  [ -n "${SCOPES2_CHAT-$HOME/.local/state/scopes-chat}" ] && adapteri_args+=(--chat "${SCOPES2_CHAT-$HOME/.local/state/scopes-chat}")
  ( aseta_raja adapteri "$adapteri_raja"; exec nohup "${NODE:-node}" --max-old-space-size="${SCOPES2_ADAPTERI_KEKO:-512}" "$tama/adapteri/adapteri.mjs" "${adapteri_args[@]}" >>"$loki" 2>&1 9>&- ) &
  adapteri_pid=$!
}

# Ydin vastaa: tarkistetaan adapteri (T-89) ja lopetetaan (exit 0, 1 jos adapterin käynnistys epäonnistuu).
terve_haara() {
  if adapteri_elaa; then
    echo "TERVEYS: 200 (jo käynnissä, portti $portti)"
    exit 0
  fi
  # T-89: ydin vastaa, adapteri ei elä (ENOSPC-kaatuminen tms.): käynnistetään vain adapteri samoilla argumenteilla ja rajoilla.
  [ "$vain_tarkista" = 1 ] && exit 1
  valitse_node
  mkdir -p "$(dirname "$loki")" "$(dirname "$pidit")"
  kaynnista_adapteri
  ydin_rivi=$(awk '$1=="ydin"' "$pidit" 2>/dev/null)
  { [ -n "$ydin_rivi" ] && printf '%s\n' "$ydin_rivi"; printf 'adapteri %s\n' "$adapteri_pid"; } > "$pidit"
  echo "ADAPTERI: uudelleen $adapteri_pid"
  sleep 1
  if ! kill -0 "$adapteri_pid" 2>/dev/null; then
    echo "ADAPTERI: kuoli (loki $loki)" >&2
    exit 1
  fi
  exit 0
}

# T-94: odottaa terveyttä enintään $terveys_odotus s. Paluu: 0 terve, 1 aikakatkaisu, 2 ydin <pid> kuoli. 30 s:n kohdalla kerran ilmoitus (skeemasiirtymä).
terveys_odotus=${SCOPES2_TERVEYS_ODOTUS:-300}
case "$terveys_odotus" in ''|*[!0-9]*|0) terveys_odotus=300 ;; esac
odota_terve() { # <ydin-pid>
  local i ilmoitettu=0
  for ((i = 0; i < terveys_odotus; i++)); do
    terve && return 0
    kill -0 "$1" 2>/dev/null || return 2
    if [ "$i" -ge 30 ] && [ "$ilmoitettu" = 0 ]; then echo "TERVEYS: odotetaan (ydin $1 elää; skeemasiirtymä?)"; ilmoitettu=1; fi
    sleep 1
  done
  return 1
}

if ! terve && ydin_elaa; then
  [ "$vain_tarkista" = 1 ] && exit 1
  odotettava=$(awk '$1=="ydin"{print $2}' "$pidit")
  echo "YDIN: käynnissä $odotettava, ei vastaa; odotetaan"
  odota_terve "$odotettava"
  if [ $? = 1 ]; then
    echo "TERVEYS: ei vastaa $terveys_odotus s:ssa (loki $loki)" >&2
    exit 1
  fi
fi
if terve; then terve_haara; fi
[ "$vain_tarkista" = 1 ] && exit 1

if [ ! -s "$avain" ]; then
  mkdir -p "$(dirname "$avain")" && chmod 700 "$(dirname "$avain")"
  (umask 077 && head -c 48 /dev/urandom | base64 | tr -d '=+/\n' > "$avain")
fi
if [ ! -x "$solmu" ]; then
  echo "KÄÄNNÄ: cargo build --release" >&2
  exit 3
fi
valitse_node
mkdir -p "$(dirname "$loki")" "$(dirname "$pidit")" "$data"

ydin_args=(--portti "$portti" --data "$data" --avain "$avain")
[ -n "$vanha" ] && ydin_args+=(--vanha "$vanha" --vanha-avain "$HOME/.config/scopes/avain")
# T-43: web-asiakas (S-7). Ydinbinääri, joka ei tunne --web-lippua (ennen T-44:n uudelleenkäännöstä), jättää lipun pois,
# jotta cronin käynnistys ei kaadu tuntemattomaan argumenttiin.
web=${SCOPES2_WEB-"$tama/web/dist"}
if [ -z "$web" ]; then echo "WEB: ei (SCOPES2_WEB tyhjä)"
elif [ ! -f "$web/index.html" ]; then echo "WEB: ei ($web/index.html puuttuu)"
elif ! "$solmu" --help 2>&1 | grep -q -- '--web'; then echo "WEB: ei (ydinbinääri ei tunne --web-lippua)"
else ydin_args+=(--web "$web"); echo "WEB: $web"; fi
# T-92 (V-637): toimintoportti ytimelle, jotta se välittää adapterin reitit (T-64). Rollback: käynnistys ilman SCOPES2_TOIMINNOT:ia.
if [ -z "${SCOPES2_TOIMINNOT:-}" ]; then echo "ADAPTERI-LIPPU: ei (SCOPES2_TOIMINNOT tyhjä)"
elif ! "$solmu" --help 2>&1 | grep -q -- '--adapteri'; then echo "ADAPTERI-LIPPU: ei (ydinbinääri ei tunne --adapteri-lippua)"
else ydin_args+=(--adapteri "http://127.0.0.1:$SCOPES2_TOIMINNOT"); echo "ADAPTERI-LIPPU: http://127.0.0.1:$SCOPES2_TOIMINNOT"; fi
# T-103: täyskäynnistys pysäyttää pidit-tiedoston vanhan adapterin (muuten orpo adapteri pitää 8798:aa vanhalla koodilla).
if adapteri_elaa; then
  vanha_pid=$(awk '$1=="adapteri"{print $2}' "$pidit")
  kill -TERM "$vanha_pid" 2>/dev/null
  for _ in $(seq 1 50); do kill -0 "$vanha_pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$vanha_pid" 2>/dev/null; then echo "ADAPTERI: vanha $vanha_pid elää 5 s TERMin jälkeen" >&2; exit 1; fi
  echo "ADAPTERI: vanha $vanha_pid pysäytetty"
fi
( aseta_raja ydin "$ydin_raja"; exec nohup "$solmu" "${ydin_args[@]}" >>"$loki" 2>&1 9>&- ) &
ydin_pid=$!
echo "YDIN: $ydin_pid"
kaynnista_adapteri
echo "ADAPTERI: $adapteri_pid"
printf 'ydin %s\nadapteri %s\n' "$ydin_pid" "$adapteri_pid" > "$pidit"

odota_terve "$ydin_pid"
ok=$?
if [ "$ok" = 1 ]; then
  echo "TERVEYS: ei vastaa $terveys_odotus s:ssa (loki $loki)" >&2
  exit 1
elif [ "$ok" != 0 ]; then
  echo "TERVEYS: ei vastaa (loki $loki)" >&2
  exit 1
fi
echo "TERVEYS: 200"
echo "RAJA: ydin $(raja_luettu "$ydin_pid") adapteri $(raja_luettu "$adapteri_pid")"
sleep 1
if ! kill -0 "$adapteri_pid" 2>/dev/null; then
  echo "ADAPTERI: kuoli (loki $loki)" >&2
  exit 1
fi
echo "VALMIS: portti $portti"
exit 0
