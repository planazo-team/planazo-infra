# Contrato WebSocket — `realtime` (puerto 8081, ruta `/ws`)

Fuente de verdad: `planazo-frontend/frontend/src/lib/realtime/ws.ts` (transporte) y `realtime/client.ts` (`ClientMsg`, `RealtimeClient`). Lo de abajo está copiado de ahí: si el servidor hace algo distinto, el frontend no lo va a entender.

```
URL:  ws://localhost:8081/ws        (local)
      wss://planazo-realtime-production.up.railway.app/ws   (producción; en Railway el proceso escucha en PORT=8080)
```

El frontend se conecta **directo** a `realtime`, sin pasar por el gateway. Por eso `realtime` verifica el JWT por su cuenta con el mismo `JWT_SECRET` del gateway.

## Mensajes cliente → servidor (`ClientMsg`)

```ts
type ClientMsg =
  | { type: 'AUTH'; token: string }
  | { type: 'SUBSCRIBE'; topic: string }
  | { type: 'UNSUBSCRIBE'; topic: string }
  | { type: 'RESUME'; last_seq: number; topics: string[] };
```

| Mensaje | Cuándo lo manda el frontend | Qué debe hacer el servidor |
|---|---|---|
| `{ type: 'AUTH', token }` | **Primer mensaje** tras `onopen`, siempre que haya sesión. El token **nunca va en la URL** (para que no quede en logs de acceso). | Verificar el JWT (`sub` = userId, `role`, `placeId`). Si es inválido, cerrar el socket. Mientras no haya AUTH válido, ignorar SUBSCRIBE/RESUME. |
| `{ type: 'SUBSCRIBE', topic }` | En la primera conexión, uno por cada topic activo; después, cada vez que una pantalla se suscribe a un topic nuevo (mover el mapa a otra zona, abrir una ficha, entrar a una sala). | Añadir el topic a la conexión. A partir de ahí, reenviar cada evento cuyo `topics` contenga ese topic. |
| `{ type: 'UNSUBSCRIBE', topic }` | Cuando ya nadie en la app escucha ese topic. | Quitar el topic de la conexión. |
| `{ type: 'RESUME', last_seq, topics }` | **Solo al reconectar** (segunda apertura en adelante), en lugar de mandar SUBSCRIBE uno a uno. `last_seq` es el mayor `seq` visto; `topics` son todos los topics activos en ese momento. | Reemplazar la lista de topics de la conexión por `topics`, ejecutar la consulta de reenvío selectivo y responder **un solo** `REPLAY` con lo perdido (puede ser `events: []`). Después, seguir en vivo. |

> **`last_seq` va en snake_case** a propósito: es el único campo así en todo el contrato. Se mantiene por compatibilidad con el frontend actual (`client.ts` lo manda tal cual). Todo lo demás (payloads, `RtEvent`) es camelCase.

Topics válidos: `zone:zona-g` · `zone:zona-t` · `place:<placeId>` · `user:<userId>` · `salas` · `salas:<salaId>` · `global`. (`room:<code>` era del diseño anterior del juego.)

## Mensajes servidor → cliente (`ServerMsg`)

```ts
type ServerMsg =
  | { type: 'EVENT';  event: RtEvent }
  | { type: 'REPLAY'; events: RtEvent[] };

interface RtEvent<T = unknown> {
  seq: number;        // orden global, lo asigna realtime al persistir (BIGSERIAL)
  id: string;         // UUID del evento, viene del servicio emisor
  type: EventType;    // 'PLACE.UPDATE' | 'INV.UPDATE' | 'RESERVE.OK' | 'PROMO.PUSH' | 'PROMO.WON' | 'PROMO.EXPIRED' | 'GAME.STATE_UPDATE' | 'LOBBY.ROOMS_UPDATE' | 'GAME.PARTIDA_FINALIZADA'
  payload: T;         // ver events.schema.json
  topics: string[];
  at: number;         // epoch ms
}
```

| Mensaje | Cuándo | Qué hace el frontend |
|---|---|---|
| `{ type: 'EVENT', event }` | Cada vez que llega al bus un evento con algún topic de la conexión. | `RealtimeClient.deliver`: descarta si ya vio ese `id`, actualiza `lastSeq = max(lastSeq, seq)`, dispara los handlers por `type` y `*`. |
| `{ type: 'REPLAY', events }` | Respuesta a `RESUME`. | Entrega cada evento con la misma lógica (los duplicados se descartan por `id`) y cuenta cuántos eran nuevos (`recovered`). |

Cualquier otro mensaje o JSON malformado el frontend lo **ignora en silencio**. No hay ACK, ni ping/pong de aplicación (el del protocolo WS es suficiente), ni mensaje de error definido.

## Reconexión (lo que hace el frontend, para que el servidor lo espere)

1. `ws.ts` reconecta solo con backoff exponencial: `min(10 s, 500 ms · 2^intento) + jitter(0..300 ms)`.
2. En cada apertura manda `AUTH` primero.
3. Si es la **primera** apertura: un `SUBSCRIBE` por topic. Si es una **reapertura**: un único `RESUME { last_seq, topics }`.
4. Deduplica por `id` con una ventana de los últimos 1000 ids.

Consecuencia para el servidor: `RESUME` con `last_seq: 0` es válido (cliente que nunca recibió nada) y debe responder con **todo el historial** de esos topics; conviene acotarlo (p. ej. últimas 24 h o últimos N eventos) y documentar el límite.

## Flujo del evento de punta a punta

```
booking/promo/game  --PUBLISH planazo.events--> Redis --> realtime
                     { id, type, topics, payload, at }        │
                                                              ├─ INSERT INTO events (...)  → obtiene seq
                                                              └─ para cada conexión con topic ∩ topics ≠ ∅:
                                                                   send { type:'EVENT', event:{ seq, id, type, payload, topics, at } }
```

`realtime` no interpreta el `payload`: solo persiste, enruta y recuerda.

> **Volumen:** `game` publica `GAME.STATE_UPDATE` 20 veces por segundo por sala en partida, y hoy `realtime` persiste cada uno. Decisión pendiente: difundirlos sin `INSERT` o purgar la tabla periódicamente.

## Almacenamiento

```sql
CREATE TABLE events (
  seq        BIGSERIAL PRIMARY KEY,   -- orden global
  id         UUID UNIQUE NOT NULL,    -- idempotencia: un reintento del emisor no crea otra fila
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  topics     TEXT[] NOT NULL,         -- a quién se enruta
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_topics_gin ON events USING GIN (topics);
```

En memoria, por conexión: `{ userId, topics: Set<string> }`. `last_seq` **no** hace falta guardarlo en el servidor: lo trae el cliente en el `RESUME`.

## Consulta de reenvío selectivo (RT-2)

```sql
SELECT seq, id, type, payload, topics,
       (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS at
  FROM events
 WHERE seq > $1                 -- last_seq del cliente
   AND topics && $2::text[]     -- intersección con los topics del cliente
 ORDER BY seq
 LIMIT 1000;
```

Solo lo que se perdió, y solo de lo que tiene suscrito. El `ORDER BY seq` garantiza que el `REPLAY` llegue en orden; el `UNIQUE (id)` garantiza que una reentrega del emisor no produzca dos filas.

## Cómo se prueba

`k6/rt2-reconnect.js`: se conecta, se cae 5 s, se generan eventos, reconecta con `RESUME` y verifica que el `REPLAY` trae exactamente lo perdido, sin duplicados, en orden. Ver `k6/README.md`.
