#!/usr/bin/env bash
# autovaihto.sh-mock (T-63-G): `bash <juuri>/claude/siirto/tools/autovaihto.sh vaihda <skooppi> [--ei-sulje] [--model M] [--viesti V]`.
# Kirjaa argv lokiin ($TMUX_MOCK_LOKI). Vastaus: autovaihto.txt, autovaihto.stderr, autovaihto.koodi ($TMUX_MOCK_DATA).
# Oletus: stdout "OK: https://claude.ai/code/session_mock", exit 0.
exec node "$(dirname "$0")/../../../../mock-skripti.mjs" autovaihto "$@"
