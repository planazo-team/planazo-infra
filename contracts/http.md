# Contrato HTTP — todo lo que el frontend consume

Fuente de verdad: `planazo-frontend/frontend/src/lib/api/types.ts` (firmas), `api/live.ts` (rutas) y `lib/types.ts` (formas). Si esto cambia, cambia primero allá (PR a `planazo-frontend`) y después aquí.

Reglas generales:

- El frontend pide todo con prefijo `/api` al gateway (`:8080`). El gateway **quita `/api`** al reenviar; cada servicio expone sus rutas **sin** `/api`.
- Todos los cuerpos y respuestas son JSON en **camelCase**.
- El frontend manda `Authorization: Bearer <token>` en todas las llamadas salvo `POST /api/auth/demo`. El gateway valida el JWT y reenvía la identidad en headers (`x-user-id`, `x-user-role`, `x-user-place-id`) más `x-gateway-key` (ver `seguridad.md`).
- Errores: cuerpo `{ code, message }`. El gateway reenvía el status tal cual. El frontend lee `code` para explicar la situación al usuario (`ErrorCode` en `types.ts`); un `409` **no es un fallo**, es criterio de aceptación.
- Los `GET` de lectura, si fallan, el frontend los trata como lista vacía / `null`; los `POST`/`PATCH` devuelven `ApiResult` con el `code`.

## Tabla de rutas

| Método | Frontend pide | Servicio recibe | Servicio | Rol | Request (camelCase exacto) | Respuesta | Errores (`code`) |
|---|---|---|---|---|---|---|---|
| `POST` | `/api/auth/demo` | — (lo atiende el gateway) | gateway | público | `{ userId: string }` (`u1..u6`, `b1..b3`) | `{ token: string }` | `400 USUARIO_INVALIDO` |
| `GET` | `/api/places?zone=&category=` | `/places?zone=&category=` | booking | cliente/negocio | query opcional `zone: Zone`, `category: Category` | `Place[]` | — |
| `GET` | `/api/places/:id` | `/places/:id` | booking (+ promos activas de promo) | cliente/negocio | — | `PlaceDetail` (`Place` + `slots: Slot[]`, `events: PlaceEvent[]`, `promos: Promo[]`) | `404` |
| `POST` | `/api/reservations` | `/reservations` | booking | cliente | `{ slotId: string, people: number, version: number }` | `201` → `Reservation` | `409 VERSION_CONFLICT` (la franja cambió), `409 SIN_CUPO` |
| `GET` | `/api/reservations/mine` | `/reservations/mine` | booking | cliente | — (usa `x-user-id`) | `Reservation[]` | — |
| `GET` | `/api/places/:id/reservations` | `/places/:id/reservations` | booking | negocio (dueño de `:id`) | — | `Reservation[]` | `403` |
| `PATCH` | `/api/places/:id/slots/:sid` | `/places/:id/slots/:sid` | booking | negocio | `{ capacity: number, version: number }` | `Slot` (con `version` incrementada) | `409 VERSION_CONFLICT`, `409 CAPACIDAD_MENOR` (capacity < taken) |
| `POST` | `/api/events` | `/events` | booking | negocio | `{ placeId: string, title: string, startsAt: string, capacity: number }` | `201` → `PlaceEvent` | `403` |
| `GET` | `/api/promos?zone=` | `/promos?zone=` | promo | cliente/negocio | query opcional `zone: Zone` | `Promo[]` (solo activas: `stock > 0` y no vencidas) | — |
| `POST` | `/api/promos` | `/promos` | promo | negocio | `{ placeId: string, title: string, discount: string, stock: number, durationS: number }` | `201` → `Promo` (`expiresAt` epoch ms, `initialStock = stock`) | `403` |
| `POST` | `/api/promos/:id/claim` | `/promos/:id/claim` | promo | cliente | — (usa `x-user-id`) | `200` → `Coupon` | `409 PROMO_AGOTADA`, `409 PROMO_VENCIDA`, `404` |
| `GET` | `/api/promos/mine` | `/promos/mine` | promo | cliente | — | `Coupon[]` | — |
| `POST` | `/api/plan` | — (módulo `agent` del gateway) | gateway | cliente | `{ text: string }` | `PlanResult` | `502` si el modelo falla y no hay plantilla |
| `POST` | `/api/rooms` | `/rooms` | game | cliente | — (el host sale de `x-user-id`) | `201` → `Room` | — |
| `POST` | `/api/rooms/:code/join` | `/rooms/:code/join` | game | cliente | — | `Room` | `404 SALA_NO_EXISTE`, `409 SALA_EN_JUEGO` |
| `POST` | `/api/rooms/:code/start` | `/rooms/:code/start` | game | cliente (host) | — | `Room` (`status: 'playing'`) | `404 SALA_NO_EXISTE`, `409 JUGADORES_INSUFICIENTES`, `403` si no es el host |
| `GET` | `/api/rooms/hall-of-fame` | `/rooms/hall-of-fame` | game | cliente | — | `HallEntry[]` ordenado desc por `score` | — |
| `GET` | `/health` | `/health` | todos | público | — | `200` `{ status: 'ok' }` (o similar) | — |

Nota de enrutamiento: `GET /rooms/hall-of-fame` debe declararse **antes** que `/rooms/:code/*` en `game`, si no `hall-of-fame` se interpreta como código de sala.

## Formas de respuesta (de `lib/types.ts`)

```ts
type Zone = 'zona-g' | 'zona-t';
type Category = 'restaurante' | 'bar' | 'discoteca' | 'hotel' | 'evento' | 'aire-libre';

interface Place {
  id: string; name: string; category: Category; zone: Zone;
  lat: number; lng: number; description: string;
  priceLevel: 0 | 1 | 2 | 3;
  freeSeats: number | null;       // suma de cupos libres de todas las franjas; null si no maneja cupos
}

interface Slot { id: string; placeId: string; startsAt: string; capacity: number; taken: number; version: number; }

interface PlaceEvent { id: string; placeId: string; title: string; startsAt: string; capacity: number; taken: number; }

interface Promo {
  id: string; placeId: string; placeName: string; zone: Zone;
  title: string; discount: string; stock: number; initialStock: number;
  expiresAt: number;              // epoch ms
}

interface PlaceDetail extends Place { slots: Slot[]; events: PlaceEvent[]; promos: Promo[]; }

interface Reservation {
  id: string; slotId: string; placeId: string; placeName: string; startsAt: string;
  people: number; code: string; userId: string; userName: string;
  createdAt: number;              // epoch ms
}

interface Coupon {
  id: string; promoId: string; code: string; title: string; discount: string; placeName: string;
  claimedAt: number;              // epoch ms
}

interface PlanStop { placeId: string; placeName: string; category: Category; hour: string; why: string; }
interface PlanResult { intro: string; stops: PlanStop[]; }

interface GamePlayer { id: string; name: string; color: string; alive: boolean; score: number; isBot?: boolean; }
interface Room { code: string; hostId: string; status: 'lobby' | 'playing' | 'finished'; players: GamePlayer[]; }
interface HallEntry { name: string; score: number; code: string; at: number; }
```

### `POST /api/plan` — aclaración

La respuesta es **`PlanResult { intro, stops: [{ placeId, placeName, category, hour, why }] }`** en camelCase. La versión antigua de `docs/arquitectura.md` muestra `{ stops: [{ place_id, hour, why }] }`: está desactualizada; manda `api/types.ts`. El request es solo `{ text }` (sin `lat`/`lng`).

## Códigos de error que el frontend entiende

| `code` | Status | Quién | Cuándo |
|---|---|---|---|
| `VERSION_CONFLICT` | 409 | booking | La `version` enviada no coincide con la actual de la franja (alguien reservó o el negocio editó). |
| `SIN_CUPO` | 409 | booking | `taken + people > capacity`. |
| `CAPACIDAD_MENOR` | 409 | booking | El negocio intenta bajar `capacity` por debajo de `taken`. |
| `PROMO_AGOTADA` | 409 | promo | `stock` llegó a 0 antes de este claim (CC-1). |
| `PROMO_VENCIDA` | 409 | promo | `expiresAt` ya pasó. |
| `SALA_NO_EXISTE` | 404 | game | Código de sala inválido. |
| `SALA_EN_JUEGO` | 409 | game | Intento de `join` con la partida en curso. |
| `JUGADORES_INSUFICIENTES` | 409 | game | `start` con menos de dos jugadores. |
| `SIN_TOKEN` / `TOKEN_INVALIDO` | 401 | gateway | Falta el `Bearer` o está vencido. |
| `USUARIO_INVALIDO` | 400 | gateway | `userId` no está en los usuarios semilla. |
| `SIN_CONEXION` | 0 | (frontend) | No es del servidor: el `fetch` falló. |

Un `502` del gateway significa "el servicio destino no respondió"; el frontend lo muestra como error genérico.
