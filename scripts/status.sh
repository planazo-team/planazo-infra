#!/usr/bin/env bash
# Muestra una tabla OK/CAÍDO con el /health de cada servicio HTTP y prueba el login demo (u1).
# Sirve igual con los servicios en Docker o corriendo con `npm run start:dev`.
# Variables opcionales: GATEWAY_URL, BOOKING_URL, PROMO_URL, GAME_URL, REALTIME_URL.
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"
BOOKING_URL="${BOOKING_URL:-http://localhost:3001}"
PROMO_URL="${PROMO_URL:-http://localhost:3002}"
GAME_URL="${GAME_URL:-http://localhost:3003}"
REALTIME_URL="${REALTIME_URL:-http://localhost:8081}"

check() {
  local name="$1" url="$2" ruta="${3:-/health}"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url$ruta" || echo 000)"
  if [ "$code" = "200" ]; then
    printf '  %-12s %-28s %s\n' "$name" "$url" "OK"
  else
    printf '  %-12s %-28s %s (HTTP %s)\n' "$name" "$url" "CAÍDO" "$code"
  fi
}

echo "Servicio     URL                          Estado"
echo "----------------------------------------------------------"
# api-gateway tiene prefijo global /api (app.setGlobalPrefix('api')): su
# salud vive en /api/health, no en /health como los demás.
check api-gateway "$GATEWAY_URL" /api/health
check booking     "$BOOKING_URL"
check promo       "$PROMO_URL"
check game        "$GAME_URL"
check realtime    "$REALTIME_URL"
echo

echo "Login demo (POST $GATEWAY_URL/api/auth/demo con u1; necesita DEMO_LOGIN_KEY):"
body="$(curl -s --max-time 5 -X POST "$GATEWAY_URL/api/auth/demo" \
  -H 'Content-Type: application/json' -H "x-demo-key: ${DEMO_LOGIN_KEY:-}" -d '{"userId":"u1"}' || true)"
if printf '%s' "$body" | grep -q '"token"'; then
  echo "  OK → token emitido (${#body} bytes)"
else
  echo "  CAÍDO → respuesta: ${body:-<sin respuesta>}"
fi
