#!/usr/bin/env bash
# Apaga todo: los 4 repos con balanceador propio primero, luego infra + frontend.
#   scripts/down.sh       → conserva los volúmenes (datos de Postgres/Redis)
#   scripts/down.sh -v    → borra también los volúmenes (empezar de cero)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

extra=()
for arg in "$@"; do
  case "$arg" in
    -v|--volumes) extra+=(-v) ;;
    *) echo "Argumento desconocido: $arg" >&2; exit 2 ;;
  esac
done

for servicio in realtime promo booking api-gateway; do
  echo "== ${servicio} =="
  (cd "../planazo-${servicio}" && docker compose down --remove-orphans "${extra[@]}")
done

docker compose --profile app --profile frontend down --remove-orphans "${extra[@]}"
