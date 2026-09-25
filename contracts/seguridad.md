# Seguridad — identidad, secretos y qué es público

Corto a propósito. Es un MVP académico sin registro ni contraseñas (`docs/contexto.md` §7): nueve usuarios semilla con JWT fijo. Lo que sí importa es que **nadie llegue a booking/promo/game saltándose el gateway**.

## Identidad

1. El frontend hace `POST /api/auth/demo { userId }` y recibe `{ token }` (JWT HS256 firmado con `JWT_SECRET`, expira en 7 días). Payload: `{ sub, name, role, placeId? }`.
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

Booking, promo y game (HTTP) rechazan con `401` toda petición cuyo `x-gateway-key` no coincida con su `GATEWAY_KEY`. Es la defensa contra alguien que descubra la URL interna y mande `x-user-id: b1` a mano. No sustituye la red privada; la complementa.

Excepción: `GET /health` no exige la clave (lo consulta Docker/Railway).

## WebSockets: verifican el JWT ellos mismos

`realtime` (8081) y `game` WS (8082) reciben conexiones **directas del navegador**, sin gateway. Por eso:

- Verifican el JWT con el **mismo `JWT_SECRET`** del gateway.
- El token llega en el **primer mensaje** `{ type: 'AUTH', token }`, nunca por query string (para que no quede en logs de acceso).
- Sin AUTH válido en unos segundos, cierran el socket.

## Dónde vive cada secreto

| Secreto | Quién lo tiene | Para qué |
|---|---|---|
| `JWT_SECRET` | api-gateway, game, realtime | Firmar (gateway) y verificar (game, realtime) los JWT. **Debe ser idéntico en los tres.** |
| `GATEWAY_KEY` | api-gateway, booking, promo, game | El gateway lo manda; los otros lo exigen. **Idéntico en los cuatro.** |
| `ANTHROPIC_API_KEY` | api-gateway | Módulo `agent` (`/api/plan`). Vacío → plantilla. |
| `DATABASE_URL` | booking, promo, realtime (cada uno la suya) | Nadie escribe en la base de otro. |
| `REDIS_URL` / `BUS_URL` | promo, game, realtime, booking | Un solo Redis en el MVP: bus (`planazo.events`) y contadores/leaderboard. |
| `ALLOWED_ORIGINS` | api-gateway | CORS: en local `http://localhost:3000`; en producción el dominio de Vercel. |

En local viven en `planazo-infra/.env` (copiado de `.env.example`, en `.gitignore`). En Railway, como **variables compartidas** del proyecto (`${{shared.JWT_SECRET}}`), para que no se desincronicen entre servicios. Generar con `openssl rand -hex 32`. Nunca en el repo, nunca en el frontend (`NEXT_PUBLIC_*` es público por definición).

## Público vs. privado en Railway

| Servicio | Exposición | Por qué |
|---|---|---|
| `api-gateway` (8080) | **Público** (dominio Railway) | Es la entrada HTTP del frontend. |
| `realtime` WS (8081) | **Público** | El navegador se conecta directo. |
| `game` WS (8082) | **Público** | El navegador se conecta directo. |
| `game` HTTP (3003) | **Privado** (red interna) | Solo el gateway lo llama (`GAME_URL=http://game.railway.internal:3003`). Si Railway no permite exponer un puerto y ocultar otro del mismo servicio, `x-gateway-key` es la barrera. |
| `booking` (3001) | **Privado** | Solo el gateway (`BOOKING_URL=http://booking.railway.internal:3001`). |
| `promo` (3002) | **Privado** | Solo el gateway (`PROMO_URL=http://promo.railway.internal:3002`). |
| Postgres ×3, Redis | **Privados** | Nunca con dominio público. |

Regla: si un servicio no necesita que el navegador le hable, no tiene dominio público. Y aunque lo tuviera, sin `x-gateway-key` no responde.

## Lo que este MVP no hace (y se asume)

Sin rotación de secretos, sin refresh tokens, sin rate limit por usuario (solo por IP en el gateway), sin TLS interno entre servicios (Railway lo da en el borde). Todo eso es trabajo posterior al MVP.
