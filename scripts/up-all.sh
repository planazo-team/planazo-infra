#!/usr/bin/env bash
# Levanta infra + los 5 servicios de aplicación construidos desde los repos hermanos.
# Requiere que cada ../planazo-<servicio> tenga Dockerfile en su raíz.
# Pasa `--frontend` para incluir también el frontend (necesita Dockerfile en ../planazo-frontend/frontend).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

if [ ! -f .env ]; then
  echo "No hay .env; copiando .env.example (cámbiale los secretos después)."
  cp .env.example .env
fi

profiles=(--profile app)
for arg in "$@"; do
  case "$arg" in
    --frontend) profiles+=(--profile frontend) ;;
    *) echo "Argumento desconocido: $arg" >&2; exit 2 ;;
  esac
done

docker compose "${profiles[@]}" up --build -d
docker compose "${profiles[@]}" ps

# Escenario 4 (Disponibilidad): api-gateway, booking, promo y realtime ya no
# se construyen desde este compose — cada uno trae su propio
# docker-compose.yml (2 réplicas + balanceador Nginx). La red compartida
# (planazo-net) y postgres-*/redis ya quedaron arriba por el comando de
# encima; ahora se entra a cada repo hermano y se levanta ahí.
for servicio in api-gateway booking promo realtime; do
  repo="../planazo-$servicio"
  if [ -d "$repo" ]; then
    echo
    echo "=== $servicio ($repo) ==="
    (cd "$repo" && docker compose --env-file "$HERE/.env" up --build -d && docker compose --env-file "$HERE/.env" ps)
  else
    echo "Aviso: no encontré $repo, lo salto (¿falta clonar? scripts/clone-all.sh)." >&2
  fi
done

echo
echo "Comprueba el estado con: scripts/status.sh"
