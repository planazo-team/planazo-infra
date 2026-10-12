# Pruebas de carga con k6

> **Prueba de punta a punta sin instalar nada:** `node pruebas/produccion.mjs` (Node 22+) corre contra Railway RT-1, RT-2 (incluida la suscripción después de `RESUME`), CC-3 con 25 reservas simultáneas, CC-1 con 60 personas contra stock 5, un cupón por persona y CC-2 con una partida real de dos bots en una sala de duelo: solo el ganador puede reclamar el bono de ganadores. Las URLs se cambian con `BASE_URL`, `REALTIME_URL` y `GAME_WS`.

Estas pruebas son la evidencia del **Definition of Done** del proyecto (`docs/contexto.md` §13):

1. **Recurso finito** (`booking`, `promo`, `game`): no se da por terminada una historia sin una prueba con peticiones concurrentes y **cero sobreventas**.
2. **Tiempo real** (`realtime`): no se da por terminada sin probarla **desconectando y reconectando**, sin pérdida ni duplicados de eventos.

| Script | Reto | Servicio | Qué demuestra |
|---|---|---|---|
| `cc1-promo-claim.js` | CC-1 | promo | 200 usuarios reclaman un cupón con stock 10: salen exactamente 10 cupones y 190 `PROMO_AGOTADA`. |
| `cc3-booking-reserve.js` | CC-3 | booking | 25 usuarios reservan la misma franja con la misma `version`: cero sobreventa, se ocupan exactamente los cupos libres. |
| `cc2-game-score.js` | CC-2 | game | 6 jugadores puntúan a la vez: el leaderboard siempre llega ordenado y ningún puntaje se pierde. **Desactualizado:** usa el protocolo anterior (`/rooms` + WebSocket `INTENT`); hay que reescribirlo al de `contracts/game.md` (REST `/api/salas`, STOMP `mover`, estado por realtime). |
| `rt2-reconnect.js` | RT-2 | realtime | Un cliente se cae, pasan cosas, vuelve con `RESUME`: el `REPLAY` trae todo lo perdido, sin duplicados, en orden. |

Cada script obtiene sus tokens en `setup()` con `POST /api/auth/demo` usando los usuarios semilla (`u1..u6` clientes, `b1..b3` negocios). No hay que preparar nada a mano salvo tener los servicios arriba y el seed cargado.

## Instalar k6

```bash
# Windows
winget install k6 --source winget
# o
choco install k6

# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Sin instalar nada: Docker
docker run --rm -i --network host grafana/k6 run - < k6/cc1-promo-claim.js
```

Si no tienes k6, `node --check k6/<script>.js` al menos valida la sintaxis (es lo que hace el CI).

## Correr contra local

Con la infra arriba (`scripts/up.sh`) y los servicios corriendo (con `npm run start:dev` en cada repo o `scripts/up-all.sh`):

```bash
k6 run k6/cc1-promo-claim.js                       # VUS=200 STOCK=10 por defecto
k6 run -e VUS=500 -e STOCK=25 k6/cc1-promo-claim.js

k6 run k6/cc3-booking-reserve.js                   # MODE=reintento (la prueba completa)
k6 run -e MODE=simple k6/cc3-booking-reserve.js    # ver el VERSION_CONFLICT "en crudo"
k6 run -e PLACE_ID=p7 -e SLOT_INDEX=1 k6/cc3-booking-reserve.js

k6 run k6/cc2-game-score.js                        # 6 jugadores, 20 s
k6 run -e JUGAR_S=30 -e ESPERA_HALL_S=120 k6/cc2-game-score.js

k6 run k6/rt2-reconnect.js                         # topic zone:zona-g, promos como b2 (p1)
k6 run -e ZONE=zona-t -e NEGOCIO=b1 -e PLACE_ID=p7 k6/rt2-reconnect.js
```

Los defaults apuntan a `BASE_URL=http://localhost:8080`, `REALTIME_URL=ws://localhost:8081/ws` y `GAME_URL=ws://localhost:8082`.

Para guardar resultados (la carpeta está en `.gitignore`):

```bash
mkdir -p k6-results
k6 run --out json=k6-results/cc1.json k6/cc1-promo-claim.js
```

## Correr contra Railway

Cambia las tres URLs por las públicas (`https://` y `wss://`). `booking` y `promo` no necesitan URL: se llega a ellos a través del gateway.

```bash
export BASE_URL=https://planazo-api-gateway-production.up.railway.app
export REALTIME_URL=wss://planazo-realtime-production.up.railway.app/ws
export GAME_URL=wss://planazo-game-production.up.railway.app

k6 run -e BASE_URL=$BASE_URL k6/cc1-promo-claim.js
k6 run -e BASE_URL=$BASE_URL k6/cc3-booking-reserve.js
k6 run -e BASE_URL=$BASE_URL -e GAME_URL=$GAME_URL k6/cc2-game-score.js
k6 run -e BASE_URL=$BASE_URL -e REALTIME_URL=$REALTIME_URL k6/rt2-reconnect.js
```

Ojo con el rate limit del gateway: en producción está en 600 peticiones por minuto por IP (`RATE_LIMIT_PER_MINUTE`); `cc1` con 200 VUs hace unos 400 (login + claim) y cabe, pero si subes los VUs aparecerán `429` en `claims_otras` y la prueba falla. Estado al 8 de octubre: los k6 aún no se han corrido contra Railway.

## Qué significa cada threshold

k6 marca la corrida como fallida (exit code ≠ 0) si algún threshold no se cumple. Sobre métricas `Counter` se escriben como `count==N`; sobre `Rate`, como `rate==1` (el 100 % de las comprobaciones pasaron).

### `cc1-promo-claim.js` — CC-1

| Threshold | Significado para el DoD |
|---|---|
| `claims_ok: count==STOCK` | Se entregaron **exactamente** `STOCK` cupones. Más = sobreventa; menos = se perdieron cupones por una carrera. |
| `claims_agotado: count==VUS-STOCK` | Todos los que llegaron tarde recibieron `409 PROMO_AGOTADA`, ni un 5xx ni un timeout. |
| `respuestas_5xx: count==0` | El servicio no se cayó bajo el pico. |
| `claims_otras: count==0` | No hubo respuestas fuera del contrato (p. ej. `429` del rate limit, `401`). |

### `cc3-booking-reserve.js` — CC-3

| Threshold | Significado para el DoD |
|---|---|
| `sin_sobreventa: rate==1` | Al final `taken <= capacity` en la franja. **La propiedad que no se puede violar.** |
| `exitos_igual_libres: rate==1` | `taken_final - taken_inicial == min(libres, VUS)`: se ocuparon todos los cupos libres, ni uno más. En `MODE=simple` el esperado es 1 (solo una reserva puede pasar con la misma `version`). |
| `respuestas_5xx: count==0` | El servicio no se cayó. |
| `reservas_otras: count==0` | Solo hubo `201`, `409 VERSION_CONFLICT` o `409 SIN_CUPO`. |

Por qué dos variantes: con lock optimista todos los VUs mandan la misma `version`; el primero en escribir la incrementa y los demás fallan con `VERSION_CONFLICT` **aunque quedaran cupos**. Eso es correcto pero incompleto: el frontend, ante `VERSION_CONFLICT`, relee la ficha y deja al usuario reintentar. `MODE=reintento` reproduce ese comportamiento y demuestra la propiedad completa.

### `cc2-game-score.js` — CC-2

| Threshold | Significado para el DoD |
|---|---|
| `leaderboard_ordenado: rate==1` | Cada `STATE` trae el leaderboard ya ordenado por el servidor: todos los clientes ven el mismo orden. |
| `hall_tiene_sala: rate==1` | Al terminar la ronda, el Hall of Fame tiene entradas de la sala (entre 1 y el número de jugadores): **ningún puntaje se perdió** por escrituras concurrentes. |
| `hall_ordenado: rate==1` | El Hall of Fame viene en orden descendente por `score`. |
| `hall_nombres_validos: rate==1` | Cada entrada corresponde a un jugador real de la sala. |
| `errores_ws: count==0` | Ningún `ERROR` del juego ni fallo de socket (AUTH aceptado, sala válida). |
| `estados_recibidos: count>0` | El servidor emitió estado (RT-3, 20 Hz). |

Este script describe el diseño anterior del juego. El `game` real (Java) no tiene `/rooms` ni `INTENT`/`STATE`: hay que reescribirlo con `POST /api/salas/:id/jugadores`, STOMP `/app/salas/{id}/mover` y `GAME.STATE_UPDATE` por realtime, y verificar al final `GET /api/leaderboard`.

### `rt2-reconnect.js` — RT-2

| Threshold | Significado para el DoD |
|---|---|
| `replay_recibido: rate==1` | El servidor respondió al `RESUME` con un `REPLAY`. |
| `huecos: count==0` | **Sin pérdida**: cada `PROMO.PUSH` generado mientras el cliente estaba desconectado aparece en el `REPLAY`. |
| `duplicados: count==0` | **Sin duplicados**: ningún `id` del `REPLAY` se había visto antes ni se repite dentro del `REPLAY`. |
| `orden_invalido: count==0` | Los `seq` del `REPLAY` son estrictamente crecientes. |
| `seq_no_mayor: count==0` | Todos los `seq` del `REPLAY` son `> last_seq` (no reenvía lo que ya teníamos). |
| `fuera_de_topic: count==0` | El `REPLAY` solo trae eventos del topic suscrito (`topics && $topics`). |

Sobre `huecos`: `seq` es global (cualquier evento de cualquier topic lo incrementa), así que un `REPLAY` filtrado por topic tendrá saltos en la numeración y eso es normal. "Hueco" aquí significa "evento que sabemos que se generó para este topic y no llegó".
