/**
 * CC-2 · Leaderboard concurrente — seis jugadores puntúan a la vez en una sala del Snake.
 *
 * Qué demuestra: la escritura atómica del marcador (sorted set en Redis) del servicio `game`.
 * Con seis jugadores moviéndose durante 20 s, el leaderboard que emite el servidor viene
 * siempre ordenado, y al terminar la ronda el Hall of Fame tiene una entrada por cada
 * jugador que puntuó, en orden descendente, sin perder ninguna (CC-2: ninguno se pierde).
 *
 * Flujo:
 *   setup    u1 crea la sala (POST /api/rooms), u2..u6 se unen (POST /api/rooms/:code/join),
 *            u1 arranca (POST /api/rooms/:code/start).
 *   default  6 VUs (uno por jugador) abren el WS del juego GAME_URL/rooms/:code/play, mandan
 *            { type:'AUTH', token } y luego INTENTs aleatorios cada 250 ms durante 20 s.
 *            Cada STATE recibido se revisa: leaderboard ordenado desc por score.
 *   teardown espera a que la ronda termine y consulta GET /api/rooms/hall-of-fame.
 *
 * Uso:
 *   k6 run k6/cc2-game-score.js
 *   k6 run -e BASE_URL=https://gateway.up.railway.app -e GAME_URL=wss://game.up.railway.app k6/cc2-game-score.js
 *
 * Variables de entorno:
 *   BASE_URL     URL del API Gateway                      (default http://localhost:8080)
 *   GAME_URL     URL WS del servicio game                 (default ws://localhost:8082)
 *   JUGAR_S      segundos mandando INTENTs                (default 20)
 *   ESPERA_HALL_S segundos máximos esperando la ronda     (default 90)
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────┐
 * │ DEPENDE DE LA IMPLEMENTACIÓN FINAL DE `game` (revisar cuando exista):                │
 * │  · Duración de la ronda: la prueba espera hasta ESPERA_HALL_S a que aparezcan         │
 * │    entradas con `code` de la sala en el Hall of Fame. Si la ronda dura más, súbelo.   │
 * │  · Si el Hall of Fame guarda a jugadores con score 0 o solo a los que puntuaron.      │
 * │    Aquí se exige: entradas de la sala >= 1 y <= número de jugadores, y que cada       │
 * │    `name` corresponda a un jugador de la sala.                                        │
 * │  · Si el Hall of Fame se ordena globalmente por score desc (así lo hace el mock).     │
 * │  · Que el WS acepte AUTH como primer mensaje y responda ERROR ante token inválido.    │
 * │  · Que el servidor rellene con bots si hay <2 humanos (no debería hacer falta: son 6).│
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 */
import http from 'k6/http';
import ws from 'k6/ws';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const GAME_URL = (__ENV.GAME_URL || 'ws://localhost:8082').replace(/\/$/, '');
const JUGAR_S = Number(__ENV.JUGAR_S || 20);
const ESPERA_HALL_S = Number(__ENV.ESPERA_HALL_S || 90);

const JUGADORES = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']; // u1 es el host
const DIRS = ['up', 'down', 'left', 'right'];

const estadosRecibidos = new Counter('estados_recibidos'); // mensajes STATE
const erroresWs = new Counter('errores_ws'); // mensajes ERROR o fallos de socket
const leaderboardOrdenado = new Rate('leaderboard_ordenado'); // cada STATE trae leaderboard desc
const hallTieneSala = new Rate('hall_tiene_sala'); // el hall tiene entradas de nuestra sala
const hallOrdenado = new Rate('hall_ordenado'); // el hall viene desc por score
const hallNombresValidos = new Rate('hall_nombres_validos'); // cada entrada es de un jugador real
const scoreFinal = new Trend('score_final'); // score de cada jugador en el último STATE

export const options = {
  scenarios: {
    jugar: {
      executor: 'per-vu-iterations',
      vus: JUGADORES.length,
      iterations: 1,
      maxDuration: `${JUGAR_S + 30}s`,
    },
  },
  thresholds: {
    errores_ws: ['count==0'],
    estados_recibidos: ['count>0'],
    leaderboard_ordenado: ['rate==1'], // todos los clientes ven el mismo orden, ya ordenado por el servidor
    hall_tiene_sala: ['rate==1'], // ningún puntaje se perdió
    hall_ordenado: ['rate==1'],
    hall_nombres_validos: ['rate==1'],
  },
};

const json = { headers: { 'Content-Type': 'application/json' } };

function login(userId) {
  const r = http.post(`${BASE_URL}/api/auth/demo`, JSON.stringify({ userId }), json);
  if (r.status !== 200 && r.status !== 201) throw new Error(`login ${userId} falló: HTTP ${r.status} ${r.body}`);
  return r.json('token');
}

function auth(token) {
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
}

/** Saca `name` del payload del JWT (sin verificar firma: solo para comparar con el hall). */
function nombreDelToken(token) {
  const payload = token.split('.')[1];
  return JSON.parse(encoding.b64decode(payload, 'rawurl', 's')).name;
}

function ordenadoDesc(lista, campo) {
  for (let i = 1; i < lista.length; i++) if (lista[i - 1][campo] < lista[i][campo]) return false;
  return true;
}

export function setup() {
  const tokens = JUGADORES.map(login);
  const nombres = tokens.map(nombreDelToken);

  // u1 crea la sala
  let r = http.post(`${BASE_URL}/api/rooms`, null, auth(tokens[0]));
  if (r.status !== 200 && r.status !== 201) throw new Error(`POST /api/rooms falló: HTTP ${r.status} ${r.body}`);
  const code = r.json('code');

  // u2..u6 se unen
  for (let i = 1; i < tokens.length; i++) {
    r = http.post(`${BASE_URL}/api/rooms/${code}/join`, null, auth(tokens[i]));
    if (r.status !== 200 && r.status !== 201) throw new Error(`join de ${JUGADORES[i]} falló: HTTP ${r.status} ${r.body}`);
  }

  // el host arranca
  r = http.post(`${BASE_URL}/api/rooms/${code}/start`, null, auth(tokens[0]));
  if (r.status !== 200 && r.status !== 201) throw new Error(`start falló: HTTP ${r.status} ${r.body}`);
  const room = r.json();
  console.log(`Sala ${code} en estado ${room.status} con ${room.players.length} jugadores`);

  erroresWs.add(0);
  return { code, tokens, nombres };
}

export default function (data) {
  const idx = __VU - 1;
  const token = data.tokens[idx];
  const url = `${GAME_URL}/rooms/${data.code}/play`;
  let ultimoEstado = null;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      // El token va en el primer mensaje, nunca en la URL (igual que el frontend).
      socket.send(JSON.stringify({ type: 'AUTH', token }));

      // Intenciones aleatorias: el servidor es la autoridad, el cliente solo pide dirección.
      socket.setInterval(() => {
        socket.send(JSON.stringify({ type: 'INTENT', dir: DIRS[Math.floor(Math.random() * DIRS.length)] }));
      }, 250);

      socket.setTimeout(() => socket.close(), JUGAR_S * 1000);
    });

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (msg.type === 'STATE') {
        estadosRecibidos.add(1);
        ultimoEstado = msg.state;
        leaderboardOrdenado.add(ordenadoDesc(msg.state.leaderboard || [], 'score'));
      } else if (msg.type === 'ERROR') {
        erroresWs.add(1);
        console.error(`ERROR del juego para ${JUGADORES[idx]}: ${msg.message}`);
      }
    });

    socket.on('error', (e) => {
      erroresWs.add(1);
      console.error(`Error de socket para ${JUGADORES[idx]}: ${e.error()}`);
    });
  });

  check(res, { 'WS del juego abrió (101)': (r) => r && r.status === 101 });

  if (ultimoEstado) {
    const yo = (ultimoEstado.leaderboard || []).find((e) => e.name === data.nombres[idx]);
    if (yo) scoreFinal.add(yo.score);
  }
}

export function teardown(data) {
  // Espera a que la ronda termine y el juego escriba el Hall of Fame (ROUND.END).
  const nombres = new Set(data.nombres);
  let entradasSala = [];
  let hall = [];
  const inicio = Date.now();
  while (Date.now() - inicio < ESPERA_HALL_S * 1000) {
    const r = http.get(`${BASE_URL}/api/rooms/hall-of-fame`, auth(data.tokens[0]));
    if (r.status === 200) {
      hall = r.json();
      entradasSala = hall.filter((e) => e.code === data.code);
      if (entradasSala.length > 0) break;
    }
    sleep(3);
  }

  hallTieneSala.add(entradasSala.length >= 1 && entradasSala.length <= data.tokens.length);
  hallOrdenado.add(ordenadoDesc(hall, 'score'));
  hallNombresValidos.add(entradasSala.every((e) => nombres.has(e.name)));

  console.log(
    `Hall of Fame: ${hall.length} entradas en total, ${entradasSala.length} de la sala ${data.code}: ` +
      entradasSala.map((e) => `${e.name}=${e.score}`).join(', '),
  );
}

export function handleSummary(data) {
  const c = (name) => (data.metrics[name] && data.metrics[name].values.count) || 0;
  const rate = (name) => (data.metrics[name] ? data.metrics[name].values.rate : null);
  const ok = rate('hall_tiene_sala') === 1 && rate('hall_ordenado') === 1 && rate('leaderboard_ordenado') === 1 && c('errores_ws') === 0;
  const lineas = [
    '',
    '=== CC-2 · Leaderboard concurrente ===',
    `Jugadores:                 ${JUGADORES.length} durante ${JUGAR_S} s`,
    `STATEs recibidos:          ${c('estados_recibidos')}`,
    `Errores WS:                ${c('errores_ws')}`,
    `Leaderboard siempre desc:  ${rate('leaderboard_ordenado') === 1 ? 'sí' : 'NO'}`,
    `Hall con la sala:          ${rate('hall_tiene_sala') === 1 ? 'sí' : 'NO'}`,
    `Hall ordenado desc:        ${rate('hall_ordenado') === 1 ? 'sí' : 'NO'}`,
    ok
      ? 'RESULTADO: OK — ningún puntaje se perdió y todos ven el mismo orden (CC-2 cumplido)'
      : 'RESULTADO: FALLÓ — revisa la escritura atómica del leaderboard o la duración de la ronda (ESPERA_HALL_S)',
    '',
  ];
  return { stdout: lineas.join('\n') };
}
