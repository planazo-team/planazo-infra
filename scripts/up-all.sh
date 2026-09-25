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
echo
echo "Comprueba el estado con: scripts/status.sh"
