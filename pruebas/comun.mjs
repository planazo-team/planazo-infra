/**
 * Piezas compartidas por los scripts de prueba contra un despliegue real
 * (produccion.mjs y demo-salon.mjs). Node 22+, sin dependencias.
 */

/** Solo se prueba contra gateways conocidos: producción o uno local. */
const BASES = ['https://planazo-api-gateway-production.up.railway.app', 'http://localhost:8080', 'http://localhost:18080'];
const basePedida = (process.env.BASE_URL ?? BASES[0]).replace(/\/$/, '');
export const BASE = BASES.find((b) => b === basePedida);
if (!BASE) {
  console.error(`BASE_URL debe ser uno de: ${BASES.join(', ')}`);
  process.exit(1);
}
export const RT = process.env.REALTIME_URL ?? 'wss://planazo-realtime-production.up.railway.app/ws';
export const GAME_WS = (process.env.GAME_WS ?? 'wss://planazo-game-production.up.railway.app').replace(/\/$/, '') + '/ws/websocket';

/**
 * Se entra únicamente con Google, así que las pruebas usan POST /api/auth/demo
 * con la llave DEMO_LOGIN_KEY (la misma variable del gateway). Cada persona de
 * prueba es un usuario `qa-…` distinto por corrida.
 */
export const DEMO_KEY = process.env.DEMO_LOGIN_KEY ?? '';
if (!DEMO_KEY) {
  console.error('Falta DEMO_LOGIN_KEY (la misma que tiene el gateway): DEMO_LOGIN_KEY=... node pruebas/<script>.mjs');
  process.exit(1);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rnd = (n = 16) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
export const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Lo que viene del servidor va a la consola en una sola línea: sin saltos ni caracteres de control. */
export const enUnaLinea = (texto) => String(texto).replace(/[\u0000-\u001f\u007f]+/g, ' ');

/**
 * Los ids vienen de respuestas del servidor. Lista blanca: un id solo puede tener
 * letras, dígitos, `-` y `_`, y el segmento se arma con caracteres de este alfabeto.
 */
const ALFABETO_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function seg(id) {
  const texto = String(id);
  if (texto.length === 0 || texto.length > 64) throw new Error(`id inválido (${texto.length} caracteres)`);
  return Array.from(texto, (c) => {
    const i = ALFABETO_ID.indexOf(c);
    if (i < 0) throw new Error('id con caracteres no permitidos');
    return ALFABETO_ID[i];
  }).join('');
}

/** Llama al gateway. Devuelve el status y el JSON tal cual (o null si no hay cuerpo). */
export async function pedirApi(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(path === '/api/auth/demo' ? { 'x-demo-key': DEMO_KEY } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

/** Cliente de realtime: se autentica, se suscribe y guarda eventos y replays con su último seq. */
export function rtCliente(token, topics) {
  const eventos = [];
  const replays = [];
  let lastSeq = 0;
  const ws = new WebSocket(RT);
  const abierto = new Promise((ok, mal) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'AUTH', token }));
      for (const t of topics) ws.send(JSON.stringify({ type: 'SUBSCRIBE', topic: t }));
      ok();
    };
    ws.onerror = (e) => mal(e);
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.type === 'EVENT') {
      eventos.push({ ...msg.event, llegada: performance.now() });
      if (msg.event.seq > lastSeq) lastSeq = msg.event.seq;
    } else if (msg.type === 'REPLAY') {
      replays.push(msg.events);
      for (const e of msg.events) if (e.seq > lastSeq) lastSeq = e.seq;
    }
  };
  return {
    ws,
    eventos,
    replays,
    abierto,
    get lastSeq() {
      return lastSeq;
    },
  };
}
