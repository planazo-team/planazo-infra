#!/usr/bin/env bash
# Crea (o actualiza) en Railway los servicios del núcleo HTTP de Planazo:
# api-gateway, booking y promo, conectados por la red privada y compartiendo
# el Redis del proyecto. Deja a realtime y game para después.
#
# Requisitos: `railway login` hecho y el proyecto enlazado en esta carpeta
# (`railway link --project <id> --environment production`). El proyecto debe
# tener ya un servicio llamado `Redis`.
#
# Uso:
#   scripts/railway-deploy-core.sh                                  # genera secretos nuevos
#   JWT_SECRET=... GATEWAY_KEY=... scripts/railway-deploy-core.sh   # reutiliza los tuyos
#   PROMO_BRANCH=feat/promo-contrato scripts/railway-deploy-core.sh # rama de promo
#
# Se puede correr varias veces: si el servicio ya existe, solo reaplica las
# variables y redespliega.
set -euo pipefail

FRONTEND_URL="${FRONTEND_URL:-https://planazo-frontend.vercel.app}"
PROMO_BRANCH="${PROMO_BRANCH:-main}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
GATEWAY_KEY="${GATEWAY_KEY:-$(openssl rand -hex 24)}"

echo "→ JWT_SECRET y GATEWAY_KEY listos. Guárdalos: realtime y game los necesitan con el mismo valor."
echo "  JWT_SECRET=$JWT_SECRET"
echo "  GATEWAY_KEY=$GATEWAY_KEY"
echo

# crear <servicio> <repo> <rama> K=V...
crear() {
  local nombre="$1" repo="$2" rama="$3"; shift 3
  local add=() set=()
  for kv in "$@"; do add+=(-v "$kv"); set+=(--set "$kv"); done

  if railway service list 2>/dev/null | grep -q "^$nombre\$\|[[:space:]]$nombre\$\|$nombre"; then
    echo "→ $nombre ya existe: se reaplican las variables y se redespliega"
    railway variables --service "$nombre" --skip-deploys "${set[@]}" >/dev/null
    railway service redeploy --service "$nombre" 2>/dev/null || railway redeploy --service "$nombre" -y
  else
    railway add --service "$nombre" --repo "$repo" --branch "$rama" "${add[@]}"
    echo "→ servicio $nombre creado desde $repo@$rama"
  fi
}

crear planazo-booking planazo-team/planazo-booking main \
  NODE_ENV=production \
  PORT=3001 \
  "GATEWAY_KEY=$GATEWAY_KEY" \
  'BUS_URL=${{Redis.REDIS_URL}}'

crear planazo-promo planazo-team/planazo-promo "$PROMO_BRANCH" \
  NODE_ENV=production \
  PORT=3002 \
  "GATEWAY_KEY=$GATEWAY_KEY" \
  'REDIS_URL=${{Redis.REDIS_URL}}' \
  'BUS_URL=${{Redis.REDIS_URL}}'

# La red privada de Railway (*.railway.internal) va cifrada por WireGuard entre
# contenedores; los servicios se hablan por HTTP plano dentro de ella.
INTERNO="http"

crear planazo-api-gateway planazo-team/planazo-api-gateway main \
  NODE_ENV=production \
  PORT=8080 \
  "JWT_SECRET=$JWT_SECRET" \
  "GATEWAY_KEY=$GATEWAY_KEY" \
  "ALLOWED_ORIGINS=$FRONTEND_URL,$INTERNO://localhost:3000" \
  "BOOKING_URL=$INTERNO://planazo-booking.railway.internal:3001" \
  "PROMO_URL=$INTERNO://planazo-promo.railway.internal:3002" \
  "GAME_URL=$INTERNO://planazo-game.railway.internal:8082" \
  RATE_LIMIT_PER_MINUTE=600

# Solo el gateway tiene dominio público; booking y promo se hablan por la red privada.
railway domain --service planazo-api-gateway 2>/dev/null || railway domain list --service planazo-api-gateway || true

cat <<'EOF'

Listo. Siguiente paso:
  1. Espera a que los tres servicios estén en SUCCESS (railway status) y prueba
       curl https://<dominio-del-gateway>/api/health
  2. En Vercel (proyecto planazo-frontend, Root Directory = frontend):
       NEXT_PUBLIC_API_MODE=live
       NEXT_PUBLIC_API_URL=https://<dominio-del-gateway>
     y vuelve a desplegar el frontend (vercel --prod).
  3. Cuando realtime y game se redesplieguen, ponles JWT_SECRET / JWT_SECRETO y
     GATEWAY_KEY con los valores de arriba, y en Vercel NEXT_PUBLIC_REALTIME_URL
     y NEXT_PUBLIC_GAME_URL.
EOF
