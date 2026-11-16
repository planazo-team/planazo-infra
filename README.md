# planazo-infra

Infraestructura local, pruebas de carga y contratos del proyecto **Planazo** (organización [`planazo-team`](https://github.com/planazo-team)).

Este repo **no tiene código de negocio**. Tiene lo que necesita el equipo para correr los seis servicios juntos en una máquina, probar que los retos técnicos se cumplen bajo carga y ponerse de acuerdo en los contratos antes de que cada servicio exista.

| Carpeta | Qué hay |
|---|---|
| `docker-compose.yml` | Redis + 4 Postgres siempre; `game` bajo el profile `app` (se construye con Maven desde su Dockerfile); el frontend bajo `frontend`; la red compartida `planazo-net`. **api-gateway, booking, promo y realtime ya NO se construyen aquí** — cada uno trae su propio `docker-compose.yml` (2 réplicas + balanceador Nginx), ver `ESCENARIO-04-DISPONIBILIDAD.md`. |
| `ESCENARIO-04-DISPONIBILIDAD.md` | El escenario de calidad de Disponibilidad completo: por qué un balanceador por repo, el fix que hizo falta en `realtime` para poder escalarlo, y cómo correr/demostrar el prototipo. |
| `scripts/` | `clone-all`, `up`, `up-all` (ahora también levanta los 4 repos con balanceador propio), `down`, `status`, `seed`, `demo-disponibilidad` (prueba de caos) y `railway-deploy-core` (crea gateway, booking y promo en Railway). Bash, funcionan en Git Bash de Windows. |
| `k6/` | Pruebas de carga, una por reto de concurrencia/tiempo real/disponibilidad. Son la evidencia del Definition of Done. `cc2-game-score.js` sigue el protocolo anterior del juego y hay que reescribirlo a STOMP. |
| `contracts/` | Rutas HTTP, JSON Schema de los eventos, protocolos WebSocket y modelo de seguridad. **Si esto y el frontend no coinciden, manda el frontend.** |
| `bruno/` | Colección [Bruno](https://www.usebruno.com/) para probar el gateway a mano. |

Contexto completo del proyecto: [`planazo-frontend/docs/contexto.md`](https://github.com/planazo-team/planazo-frontend/blob/main/docs/contexto.md).

## Prerequisitos

- **Docker** 24+ con `docker compose` (v2).
- **Node 20+** (para correr los servicios con `npm run start:dev` y para `node --check`).
- **Git** y, opcional, **`gh`** (GitHub CLI) autenticado para `clone-all.sh`.
- **k6** (opcional, solo para las pruebas de carga; ver `k6/README.md`).
- En Windows: **Git Bash** (viene con Git). Los scripts no funcionan en PowerShell/cmd.

## Estructura de directorios esperada

Todos los repos son **hermanos**; los `build.context` del compose y los scripts asumen esta disposición:

```
IdeaProjects/                     (o la carpeta que uses)
├── planazo-infra/                ← este repo (bases de datos, Redis, game, red planazo-net)
├── planazo-frontend/             Next.js · :3000 · el código está en frontend/
├── planazo-api-gateway/          NestJS · :8080 · + módulo agent · propio docker-compose.yml (2 réplicas + Nginx)
├── planazo-booking/              NestJS · :3001 · Postgres · propio docker-compose.yml (2 réplicas + Nginx)
├── planazo-promo/                NestJS · :3002 · Postgres + Redis · propio docker-compose.yml (2 réplicas + Nginx)
├── planazo-game/                 Java + Spring Boot · REST /api/v1 y STOMP /ws en :8082 · Postgres + Redis · sin replicar
└── planazo-realtime/             NestJS · WS :8081 (/ws) · Postgres + Redis · propio docker-compose.yml (2 réplicas + Nginx)
```

api-gateway, booking, promo y realtime se conectan a la red `planazo-net`
que crea `planazo-infra` (`external: true` en su propio compose) — por eso
siempre hay que levantar `planazo-infra` primero.

## Inicio rápido (5 comandos)

```bash
# 1 · Clonar los seis repos como hermanos (se saltan los que ya existen)
scripts/clone-all.sh

# 2 · Secretos compartidos (edita JWT_SECRET y GATEWAY_KEY; genera con `openssl rand -hex 32`)
cp .env.example .env

# 3 · Levantar la infra (Redis + 4 Postgres, game, la red planazo-net) y esperar a que esté healthy
scripts/up.sh

# 4 · Correr los servicios. Opción A: cada uno en su terminal, desde su repo
#       npm install && npm run start:dev
#     Opción B: todos en Docker — cada uno de api-gateway/booking/promo/realtime
#       levanta sus 2 réplicas + su propio balanceador Nginx (necesitan Dockerfile)
scripts/up-all.sh

# 5 · Ver qué está arriba y probar el login demo
scripts/status.sh
```

Después: `scripts/seed.sh` carga el catálogo (12 establecimientos) en booking, y el frontend se conecta con `NEXT_PUBLIC_API_MODE=live` (ver §10 de `contexto.md`).

Para apagar: `scripts/down.sh` (conserva datos) o `scripts/down.sh -v` (borra volúmenes).

## Puertos y URLs locales

| Pieza | Puerto host | URL | Variable que la consume |
|---|---|---|---|
| frontend | 3000 | http://localhost:3000 | `ALLOWED_ORIGINS` del gateway |
| api-gateway | 8080 | http://localhost:8080 · `/health` · `/api/*` | `NEXT_PUBLIC_API_URL` |
| booking | 3001 | http://localhost:3001 · `/health` | `BOOKING_URL` del gateway |
| promo | 3002 | http://localhost:3002 · `/health` | `PROMO_URL` del gateway |
| game (Java) | 8082 | http://localhost:8082 · `/actuator/health` · `/api/v1/*` · `/swagger-ui.html` · STOMP en `/ws` | `GAME_URL` del gateway (`http://localhost:8082`) y `NEXT_PUBLIC_GAME_URL` (`ws://localhost:8082`) |
| realtime WS | 8081 | ws://localhost:8081/ws · `/health` por HTTP | `NEXT_PUBLIC_REALTIME_URL` |
| redis | 6379 | redis://localhost:6379 | `BUS_URL`, `REDIS_URL` |
| postgres-booking | 5433 | postgresql://booking:booking@localhost:5433/booking | `DATABASE_URL` de booking |
| postgres-promo | 5434 | postgresql://promo:promo@localhost:5434/promo | `DATABASE_URL` de promo |
| postgres-realtime | 5435 | postgresql://realtime:realtime@localhost:5435/realtime | `DATABASE_URL` de realtime |
| postgres-game | 5436 | postgresql://minijuego:minijuego@localhost:5436/minijuego | `PGHOST`/`PGPORT`/... de game |

Cuando los servicios corren **con `npm run start:dev`** (fuera de Docker) usan las URLs de `localhost` de arriba en su propio `.env`. Cuando corren **dentro de compose** (`up-all.sh`) cada uno de api-gateway/booking/promo/realtime arranca 2 réplicas + su propio Nginx — el puerto de host de la tabla de arriba es el del balanceador, no el de una réplica en particular. `game` sigue siendo 1 sola instancia. Ver [`ESCENARIO-04-DISPONIBILIDAD.md`](ESCENARIO-04-DISPONIBILIDAD.md).

### Variables por servicio

| Servicio | Variables |
|---|---|
| api-gateway | `PORT`, `JWT_SECRET`, `GATEWAY_KEY`, `BOOKING_URL`, `PROMO_URL`, `GAME_URL`, `ALLOWED_ORIGINS`, `ANTHROPIC_API_KEY` |
| booking | `PORT`, `BUS_URL`, `GATEWAY_KEY` (`DATABASE_URL` cuando pase a PostgreSQL; hoy en memoria) |
| promo | `PORT`, `REDIS_URL`, `BUS_URL`, `GATEWAY_KEY` (`DATABASE_URL` cuando pase a PostgreSQL) |
| game | `SERVER_PORT`, `JWT_SECRETO` (= `JWT_SECRET`), `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `REDISHOST`, `REDISPORT`, `REDISPASSWORD` |
| realtime | `PORT`, `JWT_SECRET`, `GATEWAY_KEY`, `DATABASE_URL`, `BUS_URL` |

Un solo Redis hace de bus (canal `planazo.events`) y de almacén de contadores/leaderboard en el MVP.

### Frontend en Docker

El servicio `frontend` del compose (profile `frontend`) construye `planazo-frontend/frontend/Dockerfile` pasando las `NEXT_PUBLIC_*` como `ARG` de build (Next.js las resuelve al compilar). En el día a día el frontend se corre con `npm run dev` o se usa el de Vercel.

## Pruebas de carga (k6)

```bash
k6 run k6/cc1-promo-claim.js        # CC-1: 200 claims, stock 10 → 10 cupones y 190 PROMO_AGOTADA
k6 run k6/cc3-booking-reserve.js    # CC-3: 25 reservas a la misma franja → cero sobreventa
k6 run k6/cc2-game-score.js         # CC-2: 6 jugadores, leaderboard ordenado, Hall of Fame completo
k6 run k6/rt2-reconnect.js          # RT-2: caída + RESUME → sin pérdida ni duplicados
k6 run k6/esc04-disponibilidad.js   # Escenario 4: carga sostenida contra los balanceadores, <1% error
scripts/demo-disponibilidad.sh      # Escenario 4: lo mismo + tumba una réplica a mitad de la prueba
```

Todo parametrizado por env (`BASE_URL`, `REALTIME_URL`, `GAME_URL`, `VUS`, `STOCK`, …). Instalación, variantes, corrida contra Railway y significado de cada threshold: [`k6/README.md`](k6/README.md).

## Cuando cambia el contrato

El contrato lo define el frontend (`planazo-frontend/frontend/src/lib/types.ts`, `api/types.ts`, `api/live.ts`, `realtime/*.ts`, `game/types.ts`, `game/client.ts`). Para cambiarlo:

1. **PR a `planazo-frontend`** con el cambio en los tipos y en el mock (`lib/mock/*`), para que el modo `mock` siga siendo la referencia de comportamiento.
2. **Actualizar `contracts/` aquí** en el mismo día: `http.md`, `events.schema.json`, `realtime.md`, `game.md`. El CI valida el schema.
3. Avisar en el canal del equipo qué servicio tiene que adaptarse.

Nunca al revés: un servicio no cambia una ruta o un payload sin que el frontend lo sepa primero.

## Despliegue en Railway

Un solo **proyecto** de Railway con los cinco servicios, un Postgres y un Redis. El frontend va en Vercel con Root Directory = `frontend`. Estado al 8 de octubre de 2026: todo desplegado.

| Servicio | Fuente | Exposición | Variables |
|---|---|---|---|
| `planazo-api-gateway` | GitHub `main`, Dockerfile | público `https://planazo-api-gateway-production.up.railway.app` | `NODE_ENV`, `PORT=8080`, `JWT_SECRET`, `GATEWAY_KEY`, `ALLOWED_ORIGINS`, `BOOKING_URL`, `PROMO_URL`, `GAME_URL`, `RATE_LIMIT_PER_MINUTE=600` |
| `planazo-booking` | GitHub `main` | privado `planazo-booking.railway.internal:3001` | `PORT=3001`, `GATEWAY_KEY`, `BUS_URL=${{Redis.REDIS_URL}}` |
| `planazo-promo` | GitHub `main` | privado `planazo-promo.railway.internal:3002` | `PORT=3002`, `GATEWAY_KEY`, `REDIS_URL`, `BUS_URL` (ambas `${{Redis.REDIS_URL}}`) |
| `planazo-realtime` | GitHub `main` | público `wss://planazo-realtime-production.up.railway.app/ws` | `DATABASE_URL` (Postgres, esquema `public`), `BUS_URL`, `JWT_SECRET`, `GATEWAY_KEY` |
| `planazo-game` | GitHub `main`, Dockerfile Maven | público `planazo-game-production.up.railway.app:8082` (REST + STOMP) | `PG*` y `REDIS*` (referencias al Postgres y Redis del proyecto), `JWT_SECRETO` (= `JWT_SECRET`) |
| `Postgres` | imagen | privado | compartido: realtime (`public`) y game (`minijuego`) |
| `Redis` | imagen | privado | bus `planazo.events`, stock de promo, leaderboard de game (db 1) |

- `scripts/railway-deploy-core.sh` crea o actualiza gateway, booking y promo con esas variables (genera `JWT_SECRET` y `GATEWAY_KEY` si no se le pasan). realtime y game se conectan con `railway service source connect --repo planazo-team/<repo> --branch main --service <servicio>` y reciben los secretos a mano.
- Los secretos están hoy como variables de cada servicio, no como variables compartidas del proyecto; el valor es el mismo en todos.
- **1 réplica** para `game` y `realtime`: tienen estado en memoria (salas, suscripciones).
- `ALLOWED_ORIGINS` del gateway = `https://planazo-frontend.vercel.app,http://localhost:3000`.
- En Vercel: `NEXT_PUBLIC_API_MODE=live`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_REALTIME_URL`, `NEXT_PUBLIC_GAME_URL` en Production; cada push a `main` despliega y cada PR tiene preview.

Modelo de seguridad completo (qué es público, dónde vive cada secreto): [`contracts/seguridad.md`](contracts/seguridad.md).

## CI

`.github/workflows/ci.yml` valida en cada push/PR: `docker compose config` (con y sin profile `app`), `bash -n` de los scripts, `node --check` de los k6 y `ajv compile` del schema de eventos. No levanta contenedores.
