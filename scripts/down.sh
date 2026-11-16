#!/usr/bin/env bash
# Apaga todo (infra + servicios de todos los profiles).
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

# Escenario 4 (Disponibilidad): primero los 4 repos que ya tienen su propio
# docker-compose.yml (2 réplicas + balanceador cada uno), y solo al final la
# infra compartida (postgres-*/redis/planazo-net) de la que dependen.
for servicio in api-gateway booking promo realtime; do
  repo="../planazo-$servicio"
  if [ -d "$repo" ]; then
    (cd "$repo" && docker compose --env-file "$HERE/.env" down --remove-orphans "${extra[@]}") || true
  fi
done

docker compose --profile app --profile frontend down --remove-orphans "${extra[@]}"
