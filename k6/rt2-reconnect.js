/**
 * RT-2 · Reconexión sin pérdida ni duplicados — el cliente se cae, pasan cosas, vuelve y pide RESUME.
 *
 * Qué demuestra: el event log con secuencia global de `realtime`. Un cliente suscrito a un
 * topic guarda el último `seq` que vio; se desconecta; mientras está fuera se generan eventos
 * de ese topic; al reconectar manda { type:'RESUME', last_seq, topics } y el servidor responde
 * un REPLAY con EXACTAMENTE los eventos de ese topic con seq > last_seq: ninguno perdido,
 * ninguno repetido, en orden.
 *
 * Fases (un solo VU, una iteración):
 *   1 · Conectado: AUTH + SUBSCRIBE al topic. Se lanza una promo para tener al menos un evento
 *       y así un `last_seq` real. Se recuerdan los `id` vistos. A los 5 s se cierra el socket.
 *   2 · Desconectado: se lanzan 3 promos (como negocio) → 3 PROMO.PUSH hacia el topic.
 *   3 · Reconexión: AUTH + RESUME { last_seq, topics }. Se recibe REPLAY y se verifica:
 *       · huecos == 0            → los 3 PROMO.PUSH lanzados en la fase 2 están en el REPLAY (nada perdido)
 *       · duplicados == 0        → ningún id del REPLAY se había visto en la fase 1, ni se repite dentro del REPLAY
 *       · orden_invalido == 0    → los seq del REPLAY son estrictamente crecientes
 *       · seq_no_mayor == 0      → todos los seq del REPLAY son > last_seq
 *       · fuera_de_topic == 0    → todos los eventos del REPLAY llevan el topic suscrito
 *
 * Nota sobre "huecos": `seq` es GLOBAL (lo asigna realtime al persistir cualquier evento de
 * cualquier topic), así que en un REPLAY filtrado por topic es normal ver saltos en los números.
 * Por eso un "hueco" no es "seq no consecutivo" sino "un evento que sabemos que se generó para
 * este topic y no llegó". Los eventos que sabemos que se generaron son los PROMO.PUSH de la fase 2
 * (los identificamos por `payload.id` == id de la promo lanzada).
 *
 * Uso:
 *   k6 run k6/rt2-reconnect.js
 *   k6 run -e BASE_URL=https://gateway.up.railway.app -e REALTIME_URL=wss://realtime.up.railway.app/ws k6/rt2-reconnect.js
 *
 * Variables de entorno:
 *   BASE_URL      URL del API Gateway                         (default http://localhost:8080)
 *   REALTIME_URL  URL WS de realtime                          (default ws://localhost:8081/ws)
 *   ZONE          zona del topic                              (default zona-g → topic zone:zona-g)
 *   NEGOCIO       negocio semilla que lanza las promos        (default b2, que administra p1 en zona-g)
 *   PLACE_ID      establecimiento del negocio                 (default p1)
 *   CLIENTE       usuario que se suscribe                     (default u1)
 *   PROMOS_OFFLINE cuántas promos lanzar estando desconectado (default 3)
 *
 * OJO con la coherencia zona/negocio: b1 administra p7 que está en zona-t; b2 administra p1 en
 * zona-g; b3 administra p8 en zona-t. Si cambias ZONE, cambia NEGOCIO/PLACE_ID para que los
 * PROMO.PUSH lleguen al topic suscrito.
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Gauge, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const REALTIME_URL = __ENV.REALTIME_URL || 'ws://localhost:8081/ws';
const ZONE = __ENV.ZONE || 'zona-g';
const TOPIC = `zone:${ZONE}`;
const NEGOCIO = __ENV.NEGOCIO || 'b2';
const PLACE_ID = __ENV.PLACE_ID || 'p1';
const CLIENTE = __ENV.CLIENTE || 'u1';
const PROMOS_OFFLINE = Number(__ENV.PROMOS_OFFLINE || 3);

const eventosEnVivo = new Counter('eventos_en_vivo'); // EVENT recibidos en la fase 1
const eventosReplay = new Counter('eventos_replay'); // eventos dentro del REPLAY
const duplicados = new Counter('duplicados');
const huecos = new Counter('huecos');
const ordenInvalido = new Counter('orden_invalido');
const seqNoMayor = new Counter('seq_no_mayor');
const fueraDeTopic = new Counter('fuera_de_topic');
const replayRecibido = new Rate('replay_recibido');
const lastSeqG = new Gauge('last_seq');

export const options = {
  scenarios: {
    reconectar: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    replay_recibido: ['rate==1'],
    duplicados: ['count==0'], // sin duplicados
    huecos: ['count==0'], // sin pérdida
    orden_invalido: ['count==0'],
    seq_no_mayor: ['count==0'],
    fuera_de_topic: ['count==0'],
  },
};

const json = { headers: { 'Content-Type': 'application/json' } };

function login(userId) {
  // Se entra únicamente con Google: /api/auth/demo exige la llave DEMO_LOGIN_KEY del gateway.
  const r = http.post(`${BASE_URL}/api/auth/demo`, JSON.stringify({ userId }), {
    headers: { 'Content-Type': 'application/json', 'x-demo-key': __ENV.DEMO_LOGIN_KEY || '' },
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`login ${userId} falló: HTTP ${r.status} ${r.body}`);
  return r.json('token');
}

function auth(token) {
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
}

/** Lanza una promo como negocio y devuelve la Promo creada (su `id` aparece en el PROMO.PUSH). */
function lanzarPromo(tokenNegocio, etiqueta) {
  const body = {
    placeId: PLACE_ID,
    title: `RT-2 ${etiqueta} · ${new Date().toISOString()}`,
    discount: '10%',
    stock: 50,
    durationS: 300, // larga, para que no lleguen PROMO.EXPIRED durante la prueba
  };
  const r = http.post(`${BASE_URL}/api/promos`, JSON.stringify(body), auth(tokenNegocio));
  if (r.status !== 200 && r.status !== 201) throw new Error(`POST /api/promos falló: HTTP ${r.status} ${r.body}`);
  return r.json();
}

export function setup() {
  [duplicados, huecos, ordenInvalido, seqNoMayor, fueraDeTopic, eventosEnVivo, eventosReplay].forEach((m) => m.add(0));
  return { tokenCliente: login(CLIENTE), tokenNegocio: login(NEGOCIO) };
}

export default function (data) {
  const vistos = new Set(); // ids vistos en la fase 1
  let lastSeq = 0;

  // ---------------------------------------------------------------- fase 1: conectado 5 s
  const res1 = ws.connect(REALTIME_URL, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'AUTH', token: data.tokenCliente }));
      socket.send(JSON.stringify({ type: 'SUBSCRIBE', topic: TOPIC }));
      // Un evento "de calentamiento" para que last_seq sea real y no 0.
      socket.setTimeout(() => lanzarPromo(data.tokenNegocio, 'en-vivo'), 1000);
      socket.setTimeout(() => socket.close(), 5000);
    });
    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (msg.type === 'EVENT') {
        eventosEnVivo.add(1);
        vistos.add(msg.event.id);
        if (msg.event.seq > lastSeq) lastSeq = msg.event.seq;
      }
    });
    socket.on('error', (e) => console.error(`Error WS fase 1: ${e.error()}`));
  });
  check(res1, { 'fase 1: WS abrió (101)': (r) => r && r.status === 101 });
  lastSeqG.add(lastSeq);
  console.log(`Fase 1: ${vistos.size} eventos en vivo, last_seq=${lastSeq}. Desconectado.`);

  // ---------------------------------------------------------------- fase 2: desconectado, pasan cosas
  const promosOffline = [];
  for (let i = 1; i <= PROMOS_OFFLINE; i++) {
    promosOffline.push(lanzarPromo(data.tokenNegocio, `offline-${i}`).id);
    sleep(0.3);
  }
  sleep(1); // margen para que realtime persista los eventos del bus
  console.log(`Fase 2: ${promosOffline.length} promos lanzadas estando desconectado: ${promosOffline.join(', ')}`);

  // ---------------------------------------------------------------- fase 3: reconectar y RESUME
  let replay = null;
  const res3 = ws.connect(REALTIME_URL, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'AUTH', token: data.tokenCliente }));
      // Igual que RealtimeClient.handleOpen() en el frontend: last_seq en snake_case.
      socket.send(JSON.stringify({ type: 'RESUME', last_seq: lastSeq, topics: [TOPIC] }));
      socket.setTimeout(() => socket.close(), 5000);
    });
    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (msg.type === 'REPLAY' && replay === null) {
        replay = msg.events || [];
        socket.close();
      }
    });
    socket.on('error', (e) => console.error(`Error WS fase 3: ${e.error()}`));
  });
  check(res3, { 'fase 3: WS abrió (101)': (r) => r && r.status === 101 });

  replayRecibido.add(replay !== null);
  if (replay === null) {
    console.error('No llegó REPLAY tras RESUME');
    return;
  }

  // ---------------------------------------------------------------- verificación
  eventosReplay.add(replay.length);
  const idsReplay = new Set();
  let seqAnterior = lastSeq;
  for (const e of replay) {
    if (vistos.has(e.id) || idsReplay.has(e.id)) duplicados.add(1);
    idsReplay.add(e.id);
    if (e.seq <= lastSeq) seqNoMayor.add(1);
    if (e.seq <= seqAnterior) ordenInvalido.add(1);
    seqAnterior = e.seq;
    if (!Array.isArray(e.topics) || !e.topics.includes(TOPIC)) fueraDeTopic.add(1);
  }
  // Pérdida: cada promo lanzada en la fase 2 debe aparecer como PROMO.PUSH en el REPLAY.
  const pushIds = new Set(replay.filter((e) => e.type === 'PROMO.PUSH').map((e) => e.payload && e.payload.id));
  for (const id of promosOffline) if (!pushIds.has(id)) huecos.add(1);

  console.log(`Fase 3: REPLAY con ${replay.length} eventos, seq ${replay.length ? replay[0].seq : '-'}..${replay.length ? replay[replay.length - 1].seq : '-'}`);
}

export function handleSummary(data) {
  const c = (name) => (data.metrics[name] && data.metrics[name].values.count) || 0;
  const g = (name) => (data.metrics[name] && data.metrics[name].values.value) || 0;
  const rate = (name) => (data.metrics[name] ? data.metrics[name].values.rate : null);
  const ok = rate('replay_recibido') === 1 && c('duplicados') === 0 && c('huecos') === 0 && c('orden_invalido') === 0 && c('seq_no_mayor') === 0 && c('fuera_de_topic') === 0;
  const lineas = [
    '',
    `=== RT-2 · Reconexión (topic ${TOPIC}) ===`,
    `Eventos en vivo (fase 1):   ${c('eventos_en_vivo')}   last_seq=${g('last_seq')}`,
    `Promos lanzadas offline:    ${PROMOS_OFFLINE}`,
    `Eventos en REPLAY:          ${c('eventos_replay')}`,
    `Duplicados:                 ${c('duplicados')}`,
    `Huecos (perdidos):          ${c('huecos')}`,
    `Orden inválido:             ${c('orden_invalido')}`,
    `seq <= last_seq:            ${c('seq_no_mayor')}`,
    `Fuera de topic:             ${c('fuera_de_topic')}`,
    ok
      ? 'RESULTADO: OK — reconexión sin pérdida ni duplicados (DoD tiempo real cumplido)'
      : 'RESULTADO: FALLÓ — revisa el reenvío selectivo (seq > last_seq AND topics && $topics) de realtime',
    '',
  ];
  return { stdout: lineas.join('\n') };
}
