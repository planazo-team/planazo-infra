/**
 * ESC-06 · Rendimiento del tiempo real — 500 clientes en la Zona T y un negocio que lanza promos.
 *
 * Escenario de calidad (Sprint 2):
 *   Fuente:     un negocio (b1, dueño de p7 en la Zona T) lanza promociones y cambia su cupo.
 *   Estímulo:   cada acción publica en el bus `planazo.events` un PROMO.PUSH o un PLACE.UPDATE
 *               con topic `zone:zona-t`.
 *   Entorno:    operación normal con N clientes WebSocket suscritos a `zone:zona-t` (500 por defecto).
 *   Respuesta:  realtime entrega cada evento a todos los suscritos.
 *   Medida:     latencia publicación → entrega p95 ≤ 300 ms y p99 ≤ 500 ms, 0 eventos perdidos,
 *               errores < 1 %.
 *
 * Cómo se mide la latencia:
 *   El servicio que publica en el bus pone `emittedAt` (epoch ms) en el sobre y realtime lo entrega
 *   intacto en cada EVENT. Cada cliente calcula `ahora − emittedAt` → `esc06_latencia_ms`.
 *   Ese número compara el reloj del servidor emisor con el de la máquina que corre k6: si están
 *   desfasados, la latencia sale corrida en ese desfase. Para tener una cota sin ese problema, el
 *   negocio escribe en el título de cada promo el instante (reloj de k6) en que manda el POST, y los
 *   clientes calculan `ahora − ese instante` → `esc06_latencia_e2e_ms`. Esa medida incluye además el
 *   viaje HTTP hasta promo (gateway incluido), así que es una COTA SUPERIOR: si la e2e cumple, la de
 *   publicación → entrega también cumple.
 *
 * Fases (todo en una corrida):
 *   1 · Conexión (RAMPA_S): N VUs abren su WebSocket escalonados, mandan AUTH y SUBSCRIBE zone:zona-t.
 *   2 · Calentamiento (CALENTAR_S): todos conectados, nadie publica.
 *   3 · Publicación: el negocio hace RONDAS rondas, una cada INTERVALO_S. En cada ronda lanza una
 *       promo (→ PROMO.PUSH) y sube o baja en 1 la capacidad de una franja de su lugar
 *       (→ PLACE.UPDATE). Al final deja la capacidad como estaba (con RONDAS impar, un PATCH más).
 *   4 · Espera (GRACIA_S): los clientes siguen escuchando; cierran cuando ya recibieron todo lo
 *       esperado o cuando se acaba ESPERA_MAX_S.
 *
 * Uso:
 *   k6 run k6/esc06-latencia-tiempo-real.js
 *   k6 run -e CONEXIONES=50 -e RONDAS=5 k6/esc06-latencia-tiempo-real.js        # humo en local
 *   k6 run -e BASE_URL=https://planazo-api-gateway-production.up.railway.app \
 *          -e REALTIME_URL=wss://planazo-realtime-production.up.railway.app/ws k6/esc06-latencia-tiempo-real.js
 *
 * Variables de entorno:
 *   BASE_URL        URL del API Gateway                                (default http://localhost:8080)
 *   REALTIME_URL    URL WS de realtime                                 (default ws://localhost:8081/ws)
 *   CONEXIONES      clientes WebSocket suscritos                       (default 500)
 *   ZONE            zona del topic                                     (default zona-t → zone:zona-t)
 *   NEGOCIO         negocio semilla que publica                        (default b1, dueño de p7)
 *   PLACE_ID        lugar del negocio                                  (default p7, Zona T)
 *   CLIENTES        usuarios semilla para los tokens de los clientes   (default u1,u2,u3,u4,u5,u6)
 *                   Se reparten en round robin: 500 sockets no necesitan 500 logins (y así no se
 *                   choca con el rate limit del gateway).
 *   DEMO_KEY        si el gateway exige `x-demo-key` en POST /api/auth/demo (DEMO_LOGIN_KEY definida),
 *                   su valor. Sin ella se llama como siempre. También se acepta DEMO_LOGIN_KEY.
 *   TOKEN_NEGOCIO   token ya emitido para el negocio: si está, no se hace login del negocio.
 *   TOKENS_CLIENTES tokens ya emitidos para los clientes, separados por coma: si está, no hay login.
 *   RAMPA_S         segundos para abrir todas las conexiones           (default 30)
 *   CALENTAR_S      segundos de espera antes de publicar               (default 5)
 *   RONDAS          rondas de publicación                              (default 20)
 *   INTERVALO_S     segundos entre rondas                              (default 1)
 *   GRACIA_S        segundos de escucha después de la última ronda     (default 5)
 *   ESPERA_MAX_S    tope adicional de espera por eventos que no llegan (default 20)
 *   DURACION_PROMO_S duración de cada promo lanzada                    (default 120; mínimo 10)
 *   SIN_PLACE_UPDATE=1  no tocar la capacidad (solo PROMO.PUSH)
 *   RESUMEN_JSON    ruta donde guardar el resumen de k6 en JSON (p. ej. k6-results/esc06.json)
 */
import http from 'k6/http';
import ws from 'k6/ws';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const REALTIME_URL = __ENV.REALTIME_URL || 'ws://localhost:8081/ws';
const CONEXIONES = Number(__ENV.CONEXIONES || 500);
const ZONE = __ENV.ZONE || 'zona-t';
const TOPIC = `zone:${ZONE}`;
const NEGOCIO = __ENV.NEGOCIO || 'b1';
const PLACE_ID = __ENV.PLACE_ID || 'p7';
const CLIENTES = (__ENV.CLIENTES || 'u1,u2,u3,u4,u5,u6').split(',').map((s) => s.trim()).filter(Boolean);
const DEMO_KEY = __ENV.DEMO_KEY || __ENV.DEMO_LOGIN_KEY || '';
const RAMPA_S = Number(__ENV.RAMPA_S || 30);
const CALENTAR_S = Number(__ENV.CALENTAR_S || 5);
const RONDAS = Number(__ENV.RONDAS || 20);
const INTERVALO_S = Number(__ENV.INTERVALO_S || 1);
const GRACIA_S = Number(__ENV.GRACIA_S || 5);
const ESPERA_MAX_S = Number(__ENV.ESPERA_MAX_S || 20);
const DURACION_PROMO_S = Math.max(10, Number(__ENV.DURACION_PROMO_S || 120));
const CON_PLACE_UPDATE = __ENV.SIN_PLACE_UPDATE !== '1';

const INICIO_PUBLICACION_S = RAMPA_S + CALENTAR_S;
const FIN_PREVISTO_S = INICIO_PUBLICACION_S + RONDAS * INTERVALO_S + GRACIA_S;
const DURACION_MAX = `${Math.ceil(FIN_PREVISTO_S + ESPERA_MAX_S + 60)}s`;

// ------------------------------------------------------------------ métricas
/** ahora − emittedAt, por evento y por cliente. Etiqueta `tipo`. La medida del escenario. */
const latencia = new Trend('esc06_latencia_ms', true);
/** ahora − instante del POST según el reloj de k6 (solo PROMO.PUSH). Cota superior sin desfase de relojes. */
const latenciaE2e = new Trend('esc06_latencia_e2e_ms', true);
const recibidos = new Counter('esc06_eventos_recibidos');
const esperados = new Counter('esc06_eventos_esperados');
const perdidos = new Counter('esc06_eventos_perdidos');
const duplicados = new Counter('esc06_duplicados');
const sinEmittedAt = new Counter('esc06_sin_emitted_at');
const conexionesOk = new Counter('esc06_conexiones_ok');
const cierresInesperados = new Counter('esc06_cierres_inesperados');
const publicados = new Counter('esc06_publicados');
/** Cada operación (abrir socket, mantenerlo vivo, cada POST/PATCH del negocio) suma un éxito o un fallo. */
const errores = new Rate('esc06_errores');

export const options = {
  setupTimeout: '60s',
  scenarios: {
    suscriptores: {
      executor: 'per-vu-iterations',
      exec: 'suscriptor',
      vus: CONEXIONES,
      iterations: 1,
      maxDuration: DURACION_MAX,
    },
    negocio: {
      executor: 'per-vu-iterations',
      exec: 'negocio',
      vus: 1,
      iterations: 1,
      startTime: `${INICIO_PUBLICACION_S}s`,
      maxDuration: DURACION_MAX,
    },
  },
  thresholds: {
    esc06_latencia_ms: ['p(95)<300', 'p(99)<500'],
    'esc06_latencia_ms{tipo:PROMO.PUSH}': ['p(95)<300'],
    'esc06_latencia_ms{tipo:PLACE.UPDATE}': ['p(95)<300'],
    esc06_eventos_perdidos: ['count==0'],
    // Sin entregas la latencia sale vacía (y "pasaría"): exigir que algo haya llegado.
    esc06_eventos_recibidos: ['count>0'],
    esc06_errores: ['rate<0.01'],
    // Si realtime o el emisor aún no tienen `emittedAt`, la latencia no se puede medir: falla explícito.
    esc06_sin_emitted_at: ['count==0'],
  },
  // Los percentiles que se reportan en el resumen.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// ------------------------------------------------------------------ HTTP
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** POST /api/auth/demo. Con DEMO_KEY manda `x-demo-key` (gateway con DEMO_LOGIN_KEY); sin ella, como siempre. */
function login(userId) {
  const headers = Object.assign({}, JSON_HEADERS, DEMO_KEY ? { 'x-demo-key': DEMO_KEY } : {});
  const r = http.post(`${BASE_URL}/api/auth/demo`, JSON.stringify({ userId }), { headers, tags: { op: 'login' } });
  if (r.status !== 200 && r.status !== 201) {
    const pista = r.status === 401 || r.status === 403 || r.status === 404 ? ' (¿el gateway exige x-demo-key? pasa -e DEMO_KEY=...)' : '';
    throw new Error(`login ${userId} falló: HTTP ${r.status} ${r.body}${pista}`);
  }
  return r.json('token');
}

function auth(token, op) {
  return { headers: Object.assign({}, JSON_HEADERS, { Authorization: `Bearer ${token}` }), tags: { op } };
}

/** La franja de PLACE_ID que el negocio va a mover, o null si no hay ninguna. */
function leerFranja(token) {
  const r = http.get(`${BASE_URL}/api/places/${PLACE_ID}`, auth(token, 'leer_lugar'));
  if (r.status !== 200) throw new Error(`GET /api/places/${PLACE_ID} falló: HTTP ${r.status} ${r.body}`);
  const slots = r.json('slots') || [];
  return slots.length ? slots[0] : null;
}

// ------------------------------------------------------------------ setup
export function setup() {
  [perdidos, duplicados, sinEmittedAt, cierresInesperados, recibidos, esperados, publicados].forEach((m) => m.add(0));

  const tokenNegocio = __ENV.TOKEN_NEGOCIO || login(NEGOCIO);
  const tokensClientes = __ENV.TOKENS_CLIENTES
    ? __ENV.TOKENS_CLIENTES.split(',').map((s) => s.trim()).filter(Boolean)
    : CLIENTES.map(login);
  if (tokensClientes.length === 0) throw new Error('No hay tokens de clientes (CLIENTES o TOKENS_CLIENTES vacío).');

  let franja = null;
  if (CON_PLACE_UPDATE) {
    franja = leerFranja(tokenNegocio);
    if (!franja) console.warn(`${PLACE_ID} no tiene franjas: solo se medirá PROMO.PUSH.`);
  }

  // Marca de la corrida: los PROMO.PUSH de esta prueba llevan `ESC-06 <run>` en el título.
  const run = Math.random().toString(36).slice(2, 8);
  // Con RONDAS impar la capacidad queda en original + 1 y el negocio hace un PATCH más para devolverla.
  const porTipo = { 'PROMO.PUSH': RONDAS, 'PLACE.UPDATE': franja ? RONDAS + (RONDAS % 2) : 0 };
  console.log(
    `ESC-06 run=${run}: ${CONEXIONES} conexiones a ${REALTIME_URL} (${TOPIC}), ${RONDAS} rondas como ${NEGOCIO}/${PLACE_ID}` +
      ` desde el segundo ${INICIO_PUBLICACION_S}; esperados por cliente: ${porTipo['PROMO.PUSH']} PROMO.PUSH + ${porTipo['PLACE.UPDATE']} PLACE.UPDATE`,
  );
  return { run, tokenNegocio, tokensClientes, franja, porTipo, inicio: Date.now() };
}

// ------------------------------------------------------------------ clientes
export function suscriptor(data) {
  const i = exec.scenario.iterationInTest; // 0..CONEXIONES-1
  // Escalonar las conexiones a lo largo de RAMPA_S, como llegan personas al mapa.
  sleep((i * RAMPA_S) / Math.max(1, CONEXIONES));

  const token = data.tokensClientes[i % data.tokensClientes.length];
  const marca = `ESC-06 ${data.run} `;
  const finPrevisto = data.inicio + FIN_PREVISTO_S * 1000;
  const finMaximo = finPrevisto + ESPERA_MAX_S * 1000;
  const totalEsperado = data.porTipo['PROMO.PUSH'] + data.porTipo['PLACE.UPDATE'];
  const vistos = new Set(); // ids de evento (el frontend deduplica por id)
  const cuenta = { 'PROMO.PUSH': 0, 'PLACE.UPDATE': 0 };
  let suscritoEn = 0;
  let cerreYo = false;

  const res = ws.connect(REALTIME_URL, { tags: { op: 'ws' } }, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'AUTH', token }));
      socket.send(JSON.stringify({ type: 'SUBSCRIBE', topic: TOPIC }));
      suscritoEn = Date.now();
      socket.setInterval(() => {
        const ahora = Date.now();
        const completo = cuenta['PROMO.PUSH'] + cuenta['PLACE.UPDATE'] >= totalEsperado;
        if ((ahora >= finPrevisto && completo) || ahora >= finMaximo) {
          cerreYo = true;
          socket.close();
        }
      }, 250);
    });

    socket.on('message', (raw) => {
      const ahora = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (msg.type !== 'EVENT' || !msg.event) return;
      const e = msg.event;
      const p = e.payload || {};

      // ¿Es un evento de esta prueba?
      let propio = false;
      let enviadoEnK6 = 0;
      if (e.type === 'PROMO.PUSH' && typeof p.title === 'string' && p.title.indexOf(marca) === 0) {
        propio = true;
        const t = /t=(\d+)/.exec(p.title);
        if (t) enviadoEnK6 = Number(t[1]);
      } else if (e.type === 'PLACE.UPDATE' && p.placeId === PLACE_ID && data.porTipo['PLACE.UPDATE'] > 0) {
        propio = true;
      }
      if (!propio) return;

      if (vistos.has(e.id)) {
        duplicados.add(1);
        return;
      }
      vistos.add(e.id);
      cuenta[e.type] += 1;
      recibidos.add(1, { tipo: e.type });

      if (typeof e.emittedAt === 'number' && e.emittedAt > 0) {
        latencia.add(ahora - e.emittedAt, { tipo: e.type });
      } else {
        sinEmittedAt.add(1, { tipo: e.type });
      }
      if (enviadoEnK6 > 0) latenciaE2e.add(ahora - enviadoEnK6, { tipo: e.type });
    });

    socket.on('close', (code) => {
      if (!cerreYo) {
        cierresInesperados.add(1);
        console.warn(`Cliente ${i}: el servidor cerró el socket (code ${code}) antes de tiempo`);
      }
    });
    socket.on('error', (e) => console.error(`Cliente ${i}: error WS ${e.error()}`));
  });

  const abrio = check(res, { 'WS abrió (101)': (r) => r && r.status === 101 });
  errores.add(!abrio, { op: 'ws_abrir' });
  if (!abrio) return; // nunca estuvo suscrito: cuenta como error, no como eventos perdidos

  conexionesOk.add(1);
  errores.add(!cerreYo, { op: 'ws_vivo' });
  if (suscritoEn > data.inicio + INICIO_PUBLICACION_S * 1000) {
    console.warn(`Cliente ${i}: se suscribió después de empezar la publicación (sube RAMPA_S o CALENTAR_S)`);
  }

  esperados.add(totalEsperado);
  for (const tipo of ['PROMO.PUSH', 'PLACE.UPDATE']) {
    const faltan = data.porTipo[tipo] - cuenta[tipo];
    if (faltan > 0) perdidos.add(faltan, { tipo });
  }
}

// ------------------------------------------------------------------ negocio
export function negocio(data) {
  const token = data.tokenNegocio;
  let franja = data.franja;
  const capacidadOriginal = franja ? franja.capacity : 0;
  const inicioRondas = Date.now();

  for (let ronda = 1; ronda <= RONDAS; ronda++) {
    // Ritmo fijo: la ronda r empieza en inicio + (r-1)·INTERVALO, aunque una petición tarde.
    const espera = inicioRondas + (ronda - 1) * INTERVALO_S * 1000 - Date.now();
    if (espera > 0) sleep(espera / 1000);

    // PROMO.PUSH: el título lleva la marca de la corrida y el instante del POST (reloj de k6).
    const body = {
      placeId: PLACE_ID,
      title: `ESC-06 ${data.run} #${ronda} t=${Date.now()}`,
      discount: '10%',
      stock: 50,
      durationS: DURACION_PROMO_S,
    };
    const r = http.post(`${BASE_URL}/api/promos`, JSON.stringify(body), auth(token, 'lanzar_promo'));
    const ok = r.status === 201 || r.status === 200;
    errores.add(!ok, { op: 'lanzar_promo' });
    if (ok) publicados.add(1, { tipo: 'PROMO.PUSH' });
    else console.error(`Ronda ${ronda}: POST /api/promos → HTTP ${r.status} ${r.body}`);

    // PLACE.UPDATE: sube 1 en rondas impares y baja 1 en pares (vuelve a la capacidad original).
    if (franja) {
      const capacidad = ronda % 2 === 1 ? capacidadOriginal + 1 : capacidadOriginal;
      const nueva = moverCapacidad(token, franja, capacidad, ronda);
      if (nueva) franja = nueva;
    }
  }

  // Si RONDAS es impar, la capacidad quedó en original + 1: se devuelve (ese PLACE.UPDATE también se espera).
  if (franja && franja.capacity !== capacidadOriginal) moverCapacidad(token, franja, capacidadOriginal, 'restaurar');
}

/** PATCH de la capacidad con lock optimista. Si otro cambió la franja (409), relee y reintenta una vez. */
function moverCapacidad(token, franja, capacidad, ronda) {
  const patch = (f) =>
    http.patch(
      `${BASE_URL}/api/places/${PLACE_ID}/slots/${f.id}`,
      JSON.stringify({ capacity: capacidad, version: f.version }),
      auth(token, 'mover_capacidad'),
    );
  let r = patch(franja);
  if (r.status === 409) {
    const actual = leerFranja(token);
    if (actual) r = patch(actual);
  }
  const ok = r.status === 200;
  errores.add(!ok, { op: 'mover_capacidad' });
  if (ok) publicados.add(1, { tipo: 'PLACE.UPDATE' });
  if (!ok) {
    console.error(`Ronda ${ronda}: PATCH capacidad → HTTP ${r.status} ${r.body}`);
    return null;
  }
  return r.json();
}

// ------------------------------------------------------------------ resumen
export function handleSummary(data) {
  const m = (n) => (data.metrics[n] ? data.metrics[n].values : {});
  const c = (n) => m(n).count || 0;
  const lat = m('esc06_latencia_ms');
  const e2e = m('esc06_latencia_e2e_ms');
  const err = m('esc06_errores').rate || 0;
  const fmt = (v) => (typeof v === 'number' ? `${v.toFixed(1)} ms` : '—');
  const umbral = (n) => {
    const t = data.metrics[n] && data.metrics[n].thresholds;
    return t ? Object.keys(t).every((k) => t[k].ok) : true;
  };
  const ok = ['esc06_latencia_ms', 'esc06_eventos_perdidos', 'esc06_errores', 'esc06_sin_emitted_at'].every(umbral);

  const lineas = [
    '',
    `=== ESC-06 · Latencia publicación → entrega (${TOPIC}) ===`,
    `Conexiones abiertas:         ${c('esc06_conexiones_ok')} de ${CONEXIONES}   cierres inesperados: ${c('esc06_cierres_inesperados')}`,
    `Publicados por el negocio:   ${c('esc06_publicados')} (PROMO.PUSH + PLACE.UPDATE) en ${RONDAS} rondas`,
    `Entregas esperadas:          ${c('esc06_eventos_esperados')}`,
    `Entregas recibidas:          ${c('esc06_eventos_recibidos')}   perdidas: ${c('esc06_eventos_perdidos')}   duplicadas: ${c('esc06_duplicados')}`,
    `Latencia (ahora − emittedAt) p50 ${fmt(lat.med)} · p95 ${fmt(lat['p(95)'])} · p99 ${fmt(lat['p(99)'])} · máx ${fmt(lat.max)}   [meta p95 ≤ 300, p99 ≤ 500]`,
    `Latencia e2e (desde el POST) p50 ${fmt(e2e.med)} · p95 ${fmt(e2e['p(95)'])} · p99 ${fmt(e2e['p(99)'])}   [cota superior, mismo reloj]`,
    `Tasa de errores:             ${(err * 100).toFixed(2)} %   [meta < 1 %]`,
    `Eventos sin emittedAt:       ${c('esc06_sin_emitted_at')}`,
    ok ? 'RESULTADO: CUMPLE ESC-06' : 'RESULTADO: NO CUMPLE ESC-06 — revisa los thresholds marcados con ✗ arriba',
    '',
  ];
  const salida = { stdout: textSummary(data, { indent: ' ', enableColors: true }) + '\n' + lineas.join('\n') };
  if (__ENV.RESUMEN_JSON) salida[__ENV.RESUMEN_JSON] = JSON.stringify(data, null, 2);
  return salida;
}
