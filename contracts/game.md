# Contrato — `game` (Java + Spring Boot · puerto 8082: REST `/api/v1` y STOMP `/ws`)

Fuente de verdad: `planazo-game` (código de Diego) y, del lado del frontend, `planazo-frontend/frontend/src/lib/game/types.ts` y `game/client.ts`. Tres canales:

1. **REST por el gateway** para el catálogo de salas, unirse, salir, marcador e histórico.
2. **STOMP directo** para los comandos del jugador (registrar la sesión, mover).
3. **Eventos por `realtime`** para el estado: `game` publica al bus el snapshot de cada tick y la lista de salas, y `realtime` los reparte.

## Identidad

`game` valida el JWT por su cuenta (HS256, `JWT_SECRETO` = `JWT_SECRET` del gateway). En REST llega como `Authorization: Bearer` reenviado por el gateway; en STOMP, en el header `Authorization` del frame `CONNECT`. Lee `sub` (id del jugador, `u1`…) y `nombre`. No usa `x-user-*` ni `x-gateway-key`.

## REST (a través del gateway)

| Método | Frontend pide | game recibe | Respuesta | Errores |
|---|---|---|---|---|
| `GET` | `/api/salas` | `/api/v1/salas` | `{ data: ResumenSala[] }` | — |
| `GET` | `/api/salas/:id` | `/api/v1/salas/:id` | `{ data: ResumenSala }` | `404` |
| `POST` | `/api/salas/:id/jugadores` | `/api/v1/salas/:id/jugadores` | `201 { data: ResumenSala }` | `409 SALA_LLENA`, `404` |
| `DELETE` | `/api/salas/:id/jugadores/:jugadorId` | ídem | `204` | `403` si no es el propio jugador |
| `GET` | `/api/leaderboard?limite=10` | `/api/v1/leaderboard` | `{ data: EntradaLeaderboard[] }` | — |
| `GET` | `/api/historico/mio` | `/api/v1/historico/mio` | `{ data: ResultadoPartida[] }` | — |

Errores: `{ codigo, mensaje }`. Swagger: `/swagger-ui.html`.

Las salas son fijas (`V1__catalogo_salas_y_resultados.sql`): `sala-001` Sala Bogotá (6), `sala-002` Sala Medellín (6), `sala-003` Sala Cali (6), `sala-004` Sala Cartagena (4). La partida arranca sola cuando la sala está llena, tras 3 s de cuenta regresiva; al terminar, la sala vuelve a `ESPERANDO_JUGADORES` con los mismos jugadores.

```ts
type EstadoSala = 'ESPERANDO_JUGADORES' | 'CUENTA_REGRESIVA' | 'EN_CURSO' | 'FINALIZADA';
type Direccion = 'ARRIBA' | 'ABAJO' | 'IZQUIERDA' | 'DERECHA';
type EstadoSerpiente = 'VIVA' | 'ELIMINADA' | 'DESCONECTADA_CONGELADA';

interface ResumenSala { id: string; codigo: string; capacidad: number; cantidadJugadores: number; estado: EstadoSala; nombresJugadores: string[]; }
interface Posicion { x: number; y: number; }
interface JugadorEnSala { jugadorId: string; jugadorNombre: string; cuerpo: Posicion[]; direccion: Direccion; estado: EstadoSerpiente; puntaje: number; conectado: boolean; }
interface ResultadoPartida { salaId: string; salaCodigo: string; ganadorJugadorId: string | null; ganadorJugadorNombre: string | null; motivoVictoria: string; puntajes: { jugadorId: string; jugadorNombre: string; puntaje: number }[]; iniciadaEn: string; finalizadaEn: string; }
interface EstadoJuego {
  salaId: string; salaCodigo: string; estado: EstadoSala; capacidad: number;
  segundosCuentaRegresiva: number;        // solo en CUENTA_REGRESIVA
  anchoTablero: number; altoTablero: number;   // 24 × 18 celdas; (0,0) arriba a la izquierda
  jugadores: JugadorEnSala[];
  comida: Posicion | null;
  tiempoRestanteSegundos: number;         // partida de 3 min
  resultado: ResultadoPartida | null;     // poblado en FINALIZADA
}
interface EntradaLeaderboard { posicion: number; jugadorId: string; jugadorNombre: string; puntajeTotal: number; }
```

## STOMP (directo, `NEXT_PUBLIC_GAME_URL`)

```
URL:  ws://localhost:8082/ws/websocket                     (local; /ws es el endpoint SockJS)
      wss://planazo-game-production.up.railway.app/ws/websocket
```

```
CONNECT    Authorization: Bearer <jwt>                  sin token válido el CONNECT se rechaza
SUBSCRIBE  /user/queue/errores                          { codigo, mensaje } solo para este jugador
SEND       /app/salas/{id}/registrar-sesion   body {}   tras unirse por REST; asocia el socket al jugador
                                                        y, si estaba DESCONECTADA_CONGELADA, lo reconecta (SNK-07)
SEND       /app/salas/{id}/mover              body { "direccion": Direccion }
                                                        cada pulsación es un paso; el servidor limita a 10 por segundo
                                                        e ignora la reversa de 180°
```

El cliente del frontend (`@stomp/stompjs`) reconecta con backoff y vuelve a la misma sala. Si el jugador pierde el socket, su serpiente queda congelada 15 s; si no vuelve, se elimina.

`/topic/salas` y `/topic/salas/{id}` siguen existiendo en el broker, pero **desde octubre game ya no publica ahí**: el estado va por el bus (abajo).

## Estado (por el bus y `realtime`)

| Evento | Tópico | Payload | Cuándo |
|---|---|---|---|
| `LOBBY.ROOMS_UPDATE` | `salas` | `ResumenSala[]` | cada vez que alguien entra o sale, o una sala cambia de estado |
| `GAME.STATE_UPDATE` | `salas:<salaId>` | `EstadoJuego` | en cada tick (20 por segundo) mientras hay partida, y en cada cambio de estado |
| `GAME.PARTIDA_FINALIZADA` | `global` | `ResultadoPartida` | al terminar |

El frontend hace `SUBSCRIBE salas` y `SUBSCRIBE salas:<id>` en `realtime` y escucha esos `type`. `realtime` los persiste con `seq` como a cualquier otro evento; ver la nota de volumen en `realtime.md`.

## Mecanismos

- **RT-3:** un `SalaRuntime` por sala es el único que toca el agregado `Sala`. Los movimientos entran a una cola concurrente que solo drena el hilo del tick; unirse, salir y reconectar toman un `ReentrantLock`, nunca anidado. Hacia afuera solo salen snapshots inmutables.
- **CC-2:** al cerrar la partida, el resultado se persiste en PostgreSQL (`resultados_partida`, `puntajes_jugador`) y cada puntaje se suma al sorted set global de Redis; el leaderboard se lee ya ordenado, nunca se reescribe.

## Cómo se prueba

`k6/cc2-game-score.js` **sigue el protocolo anterior** (`/rooms` + WebSocket con `INTENT`) y hay que reescribirlo: unirse a una sala por REST, conectar por STOMP, mandar `mover`, escuchar `GAME.STATE_UPDATE` por realtime y al final verificar `GET /api/leaderboard`. Mientras tanto, la prueba manual es la del 8 de octubre: cuatro usuarios en `Sala Cartagena` desde el frontend en producción.
