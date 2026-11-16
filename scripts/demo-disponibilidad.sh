#!/usr/bin/env bash
# Escenario 4 · Disponibilidad — prueba de caos: genera carga sostenida con k6
# contra el balanceador de UN servicio mientras, a mitad de la prueba, se
# apaga una de sus 2 réplicas (y se restaura después). Así se demuestra que
# el balanceador la saca de rotación sin que la tasa de error se dispare, y
# que al volver se reincorpora sola.
#
# Requiere: k6 instalado, el servicio elegido ya arriba con sus 2 réplicas +
# balanceador (scripts/up-all.sh, o `docker compose up` en su propio repo).
#
# Uso:
#   scripts/demo-disponibilidad.sh                        # booking, réplica 1, 45s de carga
#   scripts/demo-disponibilidad.sh promo 2                # promo, réplica 2
#   scripts/demo-disponibilidad.sh realtime 1 60          # realtime, réplica 1, 60s de carga
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SERVICIO="${1:-booking}"
REPLICA="${2:-1}"
DURACION_S="${3:-45}"

case "$SERVICIO" in
  api-gateway|booking|promo|realtime) ;;
  *) echo "Servicio desconocido: $SERVICIO (usa api-gateway, booking, promo o realtime)" >&2; exit 2 ;;
esac

CONTENEDOR="planazo-${SERVICIO}-${REPLICA}"
if ! docker inspect "$CONTENEDOR" >/dev/null 2>&1; then
  echo "No encuentro el contenedor $CONTENEDOR. ¿Está $SERVICIO arriba? (docker compose up, en ../planazo-$SERVICIO)" >&2
  exit 1
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "Falta k6 (ver k6/README.md para instalarlo)." >&2
  exit 1
fi

SALIDA_K6="$(mktemp)"
trap 'rm -f "$SALIDA_K6"' EXIT

echo "=== Escenario 4 · Disponibilidad — $SERVICIO, tumbando $CONTENEDOR ==="
echo "Carga: ${DURACION_S}s. k6 arranca ya; la réplica se apaga a 1/3 de la prueba."
echo

(cd "$HERE" && k6 run -e TARGET="$SERVICIO" -e DURACION_S="$DURACION_S" -e VUS=20 k6/esc04-disponibilidad.js \
  >"$SALIDA_K6" 2>&1) &
PID_K6=$!

ESPERA_ANTES=$((DURACION_S / 3))
sleep "$ESPERA_ANTES"

echo "--> docker stop $CONTENEDOR (réplica fuera de rotación)"
docker stop "$CONTENEDOR" >/dev/null

# Ventana en la que el balanceador debe sacarla de rotación (fail_timeout=10s
# en el nginx.conf del servicio) y servir todo con la réplica sana.
sleep 20

echo "--> docker start $CONTENEDOR (réplica de vuelta)"
docker start "$CONTENEDOR" >/dev/null

wait "$PID_K6" || true
echo
cat "$SALIDA_K6"
