#!/usr/bin/env bash
# Levanta SOLO la infraestructura (Redis + 3 Postgres) y espera a que todo esté healthy.
# Los servicios se corren aparte con `npm run start:dev` en cada repo (o con up-all.sh).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

if [ ! -f .env ]; then
  echo "No hay .env; copiando .env.example (cámbiale los secretos después)."
  cp .env.example .env
fi

docker compose up -d

INFRA=(redis postgres-booking postgres-promo postgres-realtime)
echo "Esperando a que la infra esté healthy..."
for i in $(seq 1 30); do
  all_ok=1
  for svc in "${INFRA[@]}"; do
    cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
    status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "sin-contenedor")"
    if [ "$status" != "healthy" ]; then all_ok=0; fi
  done
  if [ "$all_ok" = 1 ]; then
    echo "Infra lista."
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "Alguno no llegó a healthy en 60 s:" >&2
docker compose ps >&2
exit 1
