# Seguridad — identidad, secretos y qué es público

Corto a propósito. Es un MVP académico sin registro ni contraseñas (`docs/contexto.md` §7): nueve usuarios semilla con JWT fijo. Lo que sí importa es que **nadie llegue a booking/promo/game saltándose el gateway**.

## Identidad

1. El frontend entra con Google: manda el ID token a `POST /api/auth/google`; el gateway lo verifica (firma con las llaves de Google, emisor, audiencia `GOOGLE_CLIENT_ID`, expiración y correo verificado) y firma el JWT de Planazo (HS256 con `JWT_SECRET`, 7 días). Payload: `{ sub, name, role, placeId? }`, con `sub` = `c-<cuenta>` en modo cliente y `n-<cuenta>` en modo negocio. El modo negocio solo se firma si la cuenta registró su negocio (NIT verificado, confirmando con Google hace menos de 10 minutos). `POST /api/auth/demo` existe solo para pruebas y exige `x-demo-key`.
2. Todas las llamadas HTTP llevan `Authorization: Bearer <token>` al gateway.
3. El gateway valida el JWT **una sola vez** y reenvía la identidad en headers. Los servicios HTTP **no vuelven a validar el token**: confían en los headers porque solo el gateway puede llegar a ellos (ver abajo).

| Header | Contenido | Quién lo pone |
|---|---|---|
| `x-user-id` | `u1`…`u6` (cliente), `b1`,`b2`,`b3` (negocio) | gateway |
| `x-user-role` | `cliente` \| `negocio` | gateway |
| `x-user-place-id` | solo negocio: el establecimiento que administra (`b1→p7`, `b2→p1`, `b3→p8`) | gateway |
| `x-gateway-key` | valor de `GATEWAY_KEY` | gateway |

Los servicios usan `x-user-place-id` para autorizar las acciones de negocio (un negocio solo edita franjas, crea eventos y lanza promos de **su** `placeId`; si el body trae otro → `403`).

## `x-gateway-key`

Booking, promo y realtime (HTTP) rechazan con `401` toda petición cuyo `x-gateway-key` no coincida con su `GATEWAY_KEY`. Game no la usa: valida el JWT que el gateway le reenvía (abajo). Es la defensa contra alguien que descubra la URL interna y mande `x-user-id: b1` a mano. No sustituye la red privada; la complementa.

Excepción: `GET /health` no exige la clave (lo consulta Docker/Railway).

## WebSockets: verifican el JWT ellos mismos

`realtime` (8081) y `game` (8082) reciben conexiones **directas del navegador**, sin gateway. Por eso verifican el JWT con el **mismo secreto** del gateway (`JWT_SECRET` en realtime, `JWT_SECRETO` en game):

- `realtime`: el token llega en el **primer mensaje** `{ type: 'AUTH', token }`, nunca por query string (para que no quede en logs de acceso). Sin AUTH válido, cierra el socket.
- `game`: el token va en el header `Authorization: Bearer` del frame STOMP `CONNECT`; un `CONNECT` sin token válido se rechaza. Game también valida el `Bearer` en su REST, por eso el gateway se lo reenvía (`passToken`) y no le manda `x-user-*`.

## Dónde vive cada secreto

| Secreto | Quién lo tiene | Para qué |
|---|---|---|
| `JWT_SECRET` (`JWT_SECRETO` en game) | api-gateway, game, realtime | Firmar (gateway) y verificar (game, realtime) los JWT. **Debe ser idéntico en los tres.** |
| `GATEWAY_KEY` | api-gateway, booking, promo, realtime | El gateway lo manda; los otros lo exigen. **Idéntico en los cuatro.** |
| `ANTHROPIC_API_KEY` | api-gateway | Módulo `agent` (`/api/plan`). Vacío → plantilla. |
| `DATABASE_URL` / `PG*` | realtime (esquema `public`) y game (esquema `minijuego`), **en el mismo Postgres de Railway** | booking y promo no usan base todavía. Que dos servicios compartan instancia y usuario es una excepción a "nadie escribe en la base de otro"; lo separa Flyway por esquema, no las credenciales. |
| `REDIS_URL` / `BUS_URL` / `REDIS*` | promo, game, realtime, booking | Un solo Redis en el MVP: bus (`planazo.events`), stock de promo y leaderboard de game (db 1). |
| `ALLOWED_ORIGINS` | api-gateway | CORS: en local `http://localhost:3000`; en producción el dominio de Vercel. |

En local viven en `planazo-infra/.env` (copiado de `.env.example`, en `.gitignore`). En Railway están hoy como variables de cada servicio (las pone `scripts/railway-deploy-core.sh`; realtime y game a mano), con el mismo valor generado con `openssl rand -hex 32`. Nunca en el repo, nunca en el frontend (`NEXT_PUBLIC_*` es público por definición).

## Público vs. privado en Railway

| Servicio | Exposición | Por qué |
|---|---|---|
| `api-gateway` (8080) | **Público**: `planazo-api-gateway-production.up.railway.app` | Es la entrada HTTP del frontend. |
| `realtime` (8080 en Railway, `/ws`) | **Público**: `planazo-realtime-production.up.railway.app` | El navegador se conecta directo. |
| `game` (8082, REST + STOMP) | **Público**: `planazo-game-production.up.railway.app` | El navegador se conecta directo por STOMP. Su REST también queda expuesto, pero exige un JWT válido del gateway. El gateway lo llama por `GAME_URL=http://planazo-game.railway.internal:8082`. |
| `booking` (3001) | **Privado** | Solo el gateway (`BOOKING_URL=http://planazo-booking.railway.internal:3001`). |
| `promo` (3002) | **Privado** | Solo el gateway (`PROMO_URL=http://planazo-promo.railway.internal:3002`). |
| Postgres, Redis | **Privados** | Nunca con dominio público. |

Regla: si un servicio no necesita que el navegador le hable, no tiene dominio público. Y aunque lo tuviera, sin `x-gateway-key` no responde.

## Lo que este MVP no hace (y se asume)

Sin rotación de secretos, sin refresh tokens, sin rate limit por usuario (solo por IP en el gateway, 600 por minuto en producción), sin TLS interno entre servicios (Railway lo da en el borde). `game` acepta cualquier origen en CORS y mantiene `POST /api/v1/auth/dev-token` activo. Todo eso es trabajo posterior al MVP.
