#!/usr/bin/env bash
# Carga los datos semilla (los 12 establecimientos p1..p12 con franjas y eventos) en booking.
# Ejecuta `npm run seed` DENTRO del contenedor de booking. El script `seed` lo define cada
# servicio en su package.json (booking hoy; promo/game si llegan a necesitarlo).
#
#   scripts/seed.sh            → booking (por defecto)
#   scripts/seed.sh promo      → otro servicio que exponga `npm run seed`
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

svc="${1:-booking}"

if [ -z "$(docker compose --profile app ps -q "$svc" 2>/dev/null)" ]; then
  echo "El contenedor '$svc' no está corriendo. Levántalo con scripts/up-all.sh" >&2
  exit 1
fi

# -T: sin TTY, para que funcione en Git Bash / CI.
docker compose --profile app exec -T "$svc" npm run seed
echo "Seed de '$svc' ejecutado."
