# planazo-infra

Infraestructura local, pruebas de carga y contratos del proyecto **Planazo** (organización [`planazo-team`](https://github.com/planazo-team)).

Este repo **no tiene código de negocio**. Tiene lo que necesita el equipo para correr los seis servicios juntos en una máquina, probar que los retos técnicos se cumplen bajo carga y ponerse de acuerdo en los contratos antes de que cada servicio exista.

| Carpeta | Qué hay |
|---|---|
| `docker-compose.yml` | Redis + 3 Postgres siempre; los 5 servicios bajo el profile `app`; el frontend bajo `frontend`. |
| `scripts/` | `clone-all`, `up`, `up-all`, `down`, `status`, `seed`. Bash, funcionan en Git Bash de Windows. |
| `k6/` | Cuatro pruebas de carga, una por reto de concurrencia/tiempo real. Son la evidencia del Definition of Done. |
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
├── planazo-infra/                ← este repo
├── planazo-frontend/             Next.js · :3000 · el código está en frontend/
├── planazo-api-gateway/          NestJS · :8080 · + módulo agent
├── planazo-booking/              NestJS · :3001 · Postgres
├── planazo-promo/                NestJS · :3002 · Postgres + Redis
├── planazo-game/                 NestJS · HTTP :3003 · WS :8082 · Redis
└── planazo-realtime/             NestJS · WS :8081 (/ws) · Postgres + Redis
```

## Inicio rápido (5 comandos)

```bash
# 1 · Clonar los seis repos como hermanos (se saltan los que ya existen)
scripts/clone-all.sh

# 2 · Secretos compartidos (edita JWT_SECRET y GATEWAY_KEY; genera con `openssl rand -hex 32`)
cp .env.example .env

# 3 · Levantar la infra (Redis + 3 Postgres) y esperar a que esté healthy
scripts/up.sh

# 4 · Correr los servicios. Opción A: cada uno en su terminal, desde su repo
#       npm install && npm run start:dev
#     Opción B: todos en Docker desde los repos hermanos (necesitan Dockerfile)
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
| game HTTP | 3003 | http://localhost:3003 · `/health` · `/rooms*` | `GAME_URL` del gateway |
| game WS | 8082 | ws://localhost:8082/rooms/:code/play | `NEXT_PUBLIC_GAME_URL` |
| realtime WS | 8081 | ws://localhost:8081/ws · `/health` por HTTP | `NEXT_PUBLIC_REALTIME_URL` |
| redis | 6379 | redis://localhost:6379 | `BUS_URL`, `REDIS_URL` |
| postgres-booking | 5433 | postgresql://booking:booking@localhost:5433/booking | `DATABASE_URL` de booking |
| postgres-promo | 5434 | postgresql://promo:promo@localhost:5434/promo | `DATABASE_URL` de promo |
| postgres-realtime | 5435 | postgresql://realtime:realtime@localhost:5435/realtime | `DATABASE_URL` de realtime |

Cuando los servicios corren **con `npm run start:dev`** (fuera de Docker) usan las URLs de `localhost` de arriba en su propio `.env`. Cuando corren **dentro de compose** (`up-all.sh`) el compose les inyecta los hostnames internos (`redis`, `postgres-booking`, `http://booking:3001`, …) y los secretos de `.env`.

### Variables por servicio

| Servicio | Variables |
|---|---|
| api-gateway | `PORT`, `JWT_SECRET`, `GATEWAY_KEY`, `BOOKING_URL`, `PROMO_URL`, `GAME_URL`, `ALLOWED_ORIGINS`, `ANTHROPIC_API_KEY` |
| booking | `PORT`, `DATABASE_URL`, `BUS_URL`, `GATEWAY_KEY` |
| promo | `PORT`, `DATABASE_URL`, `REDIS_URL`, `BUS_URL`, `GATEWAY_KEY` |
| game | `PORT`, `WS_PORT`, `JWT_SECRET`, `REDIS_URL`, `BUS_URL`, `GATEWAY_KEY` |
| realtime | `PORT`, `JWT_SECRET`, `DATABASE_URL`, `BUS_URL` |

Un solo Redis hace de bus (canal `planazo.events`) y de almacén de contadores/leaderboard en el MVP.

### Frontend en Docker

El servicio `frontend` del compose (profile `frontend`) espera un `Dockerfile` en `planazo-frontend/frontend/`, que **hoy no existe**: el frontend se corre con `npm run dev` o se despliega en Vercel. Si se añade, debe aceptar las `NEXT_PUBLIC_*` como `ARG` de build (Next.js las resuelve al compilar). Hasta entonces, `scripts/up-all.sh --frontend` fallará en el build.

## Pruebas de carga (k6)

```bash
k6 run k6/cc1-promo-claim.js        # CC-1: 200 claims, stock 10 → 10 cupones y 190 PROMO_AGOTADA
k6 run k6/cc3-booking-reserve.js    # CC-3: 25 reservas a la misma franja → cero sobreventa
k6 run k6/cc2-game-score.js         # CC-2: 6 jugadores, leaderboard ordenado, Hall of Fame completo
k6 run k6/rt2-reconnect.js          # RT-2: caída + RESUME → sin pérdida ni duplicados
```

Todo parametrizado por env (`BASE_URL`, `REALTIME_URL`, `GAME_URL`, `VUS`, `STOCK`, …). Instalación, variantes, corrida contra Railway y significado de cada threshold: [`k6/README.md`](k6/README.md).

## Cuando cambia el contrato

El contrato lo define el frontend (`planazo-frontend/frontend/src/lib/types.ts`, `api/types.ts`, `api/live.ts`, `realtime/*.ts`, `game/connection.ts`). Para cambiarlo:

1. **PR a `planazo-frontend`** con el cambio en los tipos y en el mock (`lib/mock/*`), para que el modo `mock` siga siendo la referencia de comportamiento.
2. **Actualizar `contracts/` aquí** en el mismo día: `http.md`, `events.schema.json`, `realtime.md`, `game.md`. El CI valida el schema.
3. Avisar en el canal del equipo qué servicio tiene que adaptarse.

Nunca al revés: un servicio no cambia una ruta o un payload sin que el frontend lo sepa primero.

## Despliegue en Railway

Un solo **proyecto** de Railway con seis servicios (gateway, booking, promo, game, realtime + los plugins de Postgres ×3 y Redis ×1). El frontend va en Vercel con Root Directory = `frontend`.

- **Variables compartidas** del proyecto: `JWT_SECRET`, `GATEWAY_KEY`, `BUS_URL` (la URL interna del Redis). Cada servicio las referencia con `${{shared.JWT_SECRET}}` para que nunca se desincronicen.
- **Red privada** para `booking` y `promo` (y el HTTP de `game`): sin dominio público; el gateway les habla por `http://<servicio>.railway.internal:<puerto>`.
- **Dominio público** solo para `api-gateway` (→ `NEXT_PUBLIC_API_URL`), `realtime` (→ `NEXT_PUBLIC_REALTIME_URL`, con `wss://` y ruta `/ws`) y el WS de `game` (→ `NEXT_PUBLIC_GAME_URL`, `wss://`).
- **1 réplica** para `game` y `realtime`: tienen estado en memoria (salas, suscripciones) y varias instancias lo repartirían mal. Los demás pueden escalar.
- `ALLOWED_ORIGINS` del gateway = el dominio de Vercel.
- Cada Postgres es de un solo servicio (`DATABASE_URL` distinto). Nadie escribe en la base de otro.

Modelo de seguridad completo (qué es público, dónde vive cada secreto): [`contracts/seguridad.md`](contracts/seguridad.md).

## CI

`.github/workflows/ci.yml` valida en cada push/PR: `docker compose config` (con y sin profile `app`), `bash -n` de los scripts, `node --check` de los k6 y `ajv compile` del schema de eventos. No levanta contenedores.
