# Contrato — `game` (HTTP 3003 · WebSocket 8082)

Fuente de verdad: `planazo-frontend/frontend/src/lib/game/connection.ts` (WS) y `api/live.ts` (lobby por HTTP). El lobby pasa por el gateway; la partida va **directa** por WebSocket porque su perfil es otro: estado a 20 Hz, efímero, no se persiste ni se reenvía.

## Lobby (HTTP, a través del gateway)

| Método | Frontend pide | game recibe | Request | Respuesta | Errores |
|---|---|---|---|---|---|
| `POST` | `/api/rooms` | `/rooms` | — (host = `x-user-id`) | `201` `Room` con `status: 'lobby'`, el host ya dentro de `players` | — |
| `POST` | `/api/rooms/:code/join` | `/rooms/:code/join` | — | `Room` | `404 SALA_NO_EXISTE`, `409 SALA_EN_JUEGO` |
| `POST` | `/api/rooms/:code/start` | `/rooms/:code/start` | — | `Room` con `status: 'playing'` | `404 SALA_NO_EXISTE`, `409 JUGADORES_INSUFICIENTES` (< 2), `403` si no es el host |
| `GET` | `/api/rooms/hall-of-fame` | `/rooms/hall-of-fame` | — | `HallEntry[]` desc por `score` | — |

`game` recibe `x-user-id`, `x-user-role`, `x-gateway-key` como los demás (ver `seguridad.md`). El código de sala es corto y en mayúsculas (p. ej. `A7X9`); el frontend lo pasa con `encodeURIComponent`.

Declarar `GET /rooms/hall-of-fame` **antes** de `/rooms/:code/*`.

```ts
interface GamePlayer { id: string; name: string; color: string; alive: boolean; score: number; isBot?: boolean; }
interface Room { code: string; hostId: string; status: 'lobby' | 'playing' | 'finished'; players: GamePlayer[]; }
interface HallEntry { name: string; score: number; code: string; at: number; }
```

Eventos que `game` publica al bus (llegan por `realtime` a `room:<code>`): `ROOM.JOIN`, `SNAKE.SCORE`, `SNAKE.DEATH`, `ROUND.END`. Formas en `events.schema.json`.

## Partida (WebSocket directo)

```
URL:  ws://localhost:8082/rooms/:code/play          (local)
      wss://<game>.up.railway.app/rooms/:code/play
```

`connection.ts` construye la URL como `` `${config.gameUrl}/rooms/${encodeURIComponent(code)}/play` ``. El servidor verifica el JWT por su cuenta con el mismo `JWT_SECRET` del gateway.

### Cliente → servidor

```ts
{ type: 'AUTH'; token: string }      // primer mensaje tras onopen; el token NUNCA va en la URL
{ type: 'INTENT'; dir: Dir }          // Dir = 'up' | 'down' | 'left' | 'right'
```

El cliente **solo envía intenciones**, nunca posiciones: el servidor es la autoridad (RT-3). Puede llegar un `INTENT` por tecla pulsada; el servidor aplica la última intención válida en el siguiente tick (ignorar la reversa de 180°).

### Servidor → cliente

```ts
{ type: 'STATE'; state: GameState }   // en cada tick (20 Hz) a todos los sockets de la sala
{ type: 'ERROR'; message: string }    // texto legible; el frontend lo muestra tal cual
```

```ts
interface Point { x: number; y: number; }
interface LeaderEntry { playerId: string; name: string; score: number; }

interface GameState {
  code: string;
  status: 'lobby' | 'playing' | 'finished';
  tick: number;
  size: number;                       // tablero size × size
  players: GamePlayer[];
  snakes: Record<string, Point[]>;    // playerId → cuerpo (cabeza primero)
  food: Point[];
  leaderboard: LeaderEntry[];         // YA ORDENADO desc por score por el servidor (CC-2)
  endsAt?: number;                    // epoch ms en que termina la ronda
  winnerId?: string;                  // solo con status 'finished'
}
```

Situaciones que deben producir `ERROR` (y normalmente cierre del socket): token inválido o ausente tras N segundos, sala inexistente, jugador que no pertenece a la sala. Cualquier mensaje malformado el frontend lo ignora.

Al cerrarse el socket sin que el cliente lo pidiera, el frontend muestra "Se perdió la conexión con la partida." **No** hay reconexión automática en el canal del juego (a diferencia de `realtime`): la partida es efímera.

### Ciclo de la ronda

1. `POST /rooms/:code/start` → `status: 'playing'`, se fija `endsAt`, arranca el bucle a 20 Hz.
2. En cada tick: aplicar intenciones, mover, detectar colisiones y comida, actualizar `score` con escritura atómica (`ZINCRBY` sobre el sorted set `room:<code>:scores`), construir `leaderboard` desde el sorted set (ya ordenado), emitir `STATE`.
3. Al llegar a `endsAt` o quedar un solo vivo: `status: 'finished'`, `winnerId`, publicar `ROUND.END`, escribir cada jugador en el Hall of Fame (`ZADD hall-of-fame score "name|code|at"` o tabla equivalente). Es el momento de CC-2: **ningún puntaje se pierde** aunque varios mueran en el mismo tick.

## Cómo se prueba

`k6/cc2-game-score.js`: crea sala, une 6 jugadores, arranca, manda INTENTs por WS 20 s y al final verifica el Hall of Fame. Ver `k6/README.md`.
