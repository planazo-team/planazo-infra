#!/usr/bin/env node
/**
 * Prueba de punta a punta de Planazo contra un despliegue real (Railway).
 * Node 22+ (fetch y WebSocket nativos), sin dependencias.
 *
 *   node pruebas/produccion.mjs
 *   BASE_URL=... REALTIME_URL=... GAME_WS=... node pruebas/produccion.mjs
 *
 * Qué demuestra:
 *   RT-1  un cambio de cupos llega por WebSocket a quien mira la zona
 *   RT-2  al reconectar con RESUME llega lo perdido y lo nuevo sigue llegando
 *   CC-3  N reservas simultáneas con la misma versión: gana exactamente una
 *   CC-1  M personas contra una promo de stock S: exactamente S cupones
 *         y cada persona reclama una sola vez
 *   CC-2  una partida real de dos bots en una sala de duelo: las serpientes
 *         avanzan solas, el ganador queda registrado y SOLO él puede
 *         reclamar el bono de ganadores
 *   Cancelar  una reserva cancelada devuelve sus cupos
 *   Salas  quien entra a una sala sin conexión de juego sale solo
 *   Agente  POST /api/plan devuelve una ruta con lugares del catálogo
 *
 * Deja rastro mínimo en producción: algunas reservas de prueba, promos
 * cortas del negocio semilla b1 (vencen en minutos) y una partida.
 */

const BASE = (process.env.BASE_URL ?? 'https://planazo-api-gateway-production.up.railway.app').replace(/\/$/, '');
const RT = process.env.REALTIME_URL ?? 'wss://planazo-realtime-production.up.railway.app/ws';
const GAME_WS = (process.env.GAME_WS ?? 'wss://planazo-game-production.up.railway.app').replace(/\/$/, '') + '/ws/websocket';
const SALA = process.env.SALA_DUELO ?? 'sala-006';
const CLIENTES = Number(process.env.CLIENTES ?? 60);
const STOCK = Number(process.env.STOCK ?? 5);

const resultados = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n = 16) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

function check(nombre, ok, detalle = '') {
  resultados.push({ nombre, ok, detalle });
  console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

/** Los nombres son únicos: cada corrida usa los suyos («QA Bot Ana 7k2p»). */
const CORRIDA = rnd(4);

async function login(nombre, role = 'cliente', deviceId = `qa${rnd(14)}`) {
  const name = `${nombre} ${CORRIDA}`;
  const r = await api('POST', '/api/auth/login', { body: { name, role, deviceId } });
  if (r.status !== 200) throw new Error(`login ${name}: ${r.status} ${JSON.stringify(r.data)}`);
  return { token: r.data.token, user: r.data.user };
}

/* ---------------- cliente de realtime ---------------- */

function rtCliente(token, topics) {
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
      eventos.push(msg.event);
      if (msg.event.seq > lastSeq) lastSeq = msg.event.seq;
    } else if (msg.type === 'REPLAY') {
      replays.push(msg.events);
      for (const e of msg.events) if (e.seq > lastSeq) lastSeq = e.seq;
    }
  };
  return { ws, eventos, replays, abierto, get lastSeq() { return lastSeq; } };
}

async function esperar(cond, ms = 8000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const v = cond();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

/* ---------------- STOMP mínimo para el juego ---------------- */

function stomp(token) {
  const ws = new WebSocket(GAME_WS);
  const subs = new Map();
  let n = 0;
  const frame = (cmd, headers = {}, body = '') =>
    ws.send(`${cmd}\n${Object.entries(headers).map(([k, v]) => `${k}:${v}`).join('\n')}\n\n${body}\0`);
  const conectado = new Promise((ok, mal) => {
    ws.onopen = () => frame('CONNECT', { 'accept-version': '1.2', host: 'planazo', Authorization: `Bearer ${token}`, 'heart-beat': '0,0' });
    ws.onerror = (e) => mal(e);
    ws.onmessage = (m) => {
      for (const raw of String(m.data).split('\0')) {
        if (!raw.trim()) continue;
        const [head, ...rest] = raw.split('\n\n');
        const [cmd, ...hs] = head.replace(/^\n+/, '').split('\n');
        const h = Object.fromEntries(hs.map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
        if (cmd === 'CONNECTED') ok();
        else if (cmd === 'ERROR') mal(new Error(h.message ?? 'STOMP ERROR'));
        else if (cmd === 'MESSAGE') subs.get(h.subscription)?.(JSON.parse(rest.join('\n\n')));
      }
    };
  });
  return {
    conectado,
    sub(dest, fn) {
      const id = `s${n++}`;
      subs.set(id, fn);
      frame('SUBSCRIBE', { id, destination: dest });
    },
    send(dest, body) {
      frame('SEND', { destination: dest, 'content-type': 'application/json' }, JSON.stringify(body));
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

/* ---------------- pruebas ---------------- */

async function salud() {
  const g = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  check('Gateway arriba', g?.status === 'UP');
  const r = await fetch(RT.replace('wss://', 'https://').replace('/ws', '/health')).then((r) => r.json()).catch(() => null);
  check('Realtime arriba', r?.status === 'UP');
}

async function loginPorNombre() {
  const dev = `qa${rnd(14)}`;
  const a = await login('Prueba QA', 'cliente', dev);
  check('Login solo con el nombre', !!a.token && a.user.id.startsWith('c-'), a.user.id);
  const b = await login('Prueba QA', 'cliente', dev);
  check('Mismo dispositivo = misma persona', a.user.id === b.user.id);
  // Nombres únicos: otro navegador no puede usar el mismo nombre (ni en mayúsculas).
  const otro = await api('POST', '/api/auth/login', { body: { name: `PRUEBA QA ${CORRIDA}`, role: 'cliente', deviceId: `qa${rnd(14)}` } });
  check('Nombre único: otro navegador recibe NOMBRE_EN_USO', otro.status === 409 && otro.data?.code === 'NOMBRE_EN_USO', otro.data?.message);
  // Dos nombres en el mismo navegador son dos cuentas (el caso de Casa Tequila).
  const c = await login('Otra Persona QA', 'negocio', dev);
  check('Mismo navegador, otro nombre = otra cuenta', c.user.id !== `n-${a.user.id.slice(2)}` && !c.user.placeId, c.user.id);
  const malo = await api('POST', '/api/auth/login', { body: { name: '<script>', role: 'cliente', deviceId: dev } });
  check('Nombre inválido rechazado', malo.status === 400, malo.data?.code);
}

async function rt1yCc3() {
  const yo = await login('QA Reservas');
  const lugares = (await api('GET', '/api/places', { token: yo.token })).data;
  const conCupo = [];
  for (const p of lugares.filter((p) => p.freeSeats > 0)) {
    const det = (await api('GET', `/api/places/${p.id}`, { token: yo.token })).data;
    const s = det.slots.find((s) => s.capacity - s.taken >= 1);
    if (s) conCupo.push({ p: det, s });
    if (conCupo.length) break;
  }
  if (!conCupo.length) return check('CC-3 / RT-1', false, 'no hay franjas con cupo');
  const { p, s } = conCupo[0];

  const rt = rtCliente(yo.token, [`zone:${p.zone}`]);
  await rt.abierto;
  await sleep(500);

  const N = 25;
  const usuarios = await Promise.all(Array.from({ length: N }, (_, i) => login(`QA Rival ${i}`)));
  const r = await Promise.all(
    usuarios.map((u) => api('POST', '/api/reservations', { token: u.token, body: { slotId: s.id, people: 1, version: s.version } })),
  );
  const ok = r.filter((x) => x.status === 201 || x.status === 200).length;
  const conflictos = r.filter((x) => x.data?.code === 'VERSION_CONFLICT').length;
  check(`CC-3: ${N} reservas simultáneas con la misma versión`, ok === 1 && conflictos === N - 1, `${ok} confirmada, ${conflictos} VERSION_CONFLICT`);

  const despues = (await api('GET', `/api/places/${p.id}`, { token: yo.token })).data.slots.find((x) => x.id === s.id);
  check('CC-3: sin sobreventa', despues.taken === s.taken + 1 && despues.version === s.version + 1, `taken ${s.taken}→${despues.taken}`);

  // Cancelar: quien ganó la reserva la cancela y los cupos vuelven.
  const iOk = r.findIndex((x) => x.status === 201 || x.status === 200);
  const ajena = await api('DELETE', `/api/reservations/${r[iOk].data.id}`, { token: yo.token });
  check('Cancelar: una reserva ajena no se puede cancelar', ajena.data?.code === 'RESERVA_AJENA', ajena.data?.code);
  const cancel = await api('DELETE', `/api/reservations/${r[iOk].data.id}`, { token: usuarios[iOk].token });
  const tras = (await api('GET', `/api/places/${p.id}`, { token: yo.token })).data.slots.find((x) => x.id === s.id);
  check('Cancelar: los cupos vuelven a la franja', cancel.status === 200 && tras.taken === s.taken, `taken ${despues.taken}→${tras.taken}`);

  const ev = await esperar(() => rt.eventos.find((e) => e.type === 'PLACE.UPDATE' && e.payload.placeId === p.id));
  check('RT-1: el mapa recibe PLACE.UPDATE en vivo', !!ev, ev ? `seq ${ev.seq}` : 'no llegó');

  // RT-2: se corta, pasan cosas, vuelve con RESUME.
  const ultimo = rt.lastSeq;
  rt.ws.close();
  await sleep(300);
  const otro = await login('QA Durante el corte');
  const s2 = (await api('GET', `/api/places/${p.id}`, { token: otro.token })).data.slots.find((x) => x.capacity - x.taken >= 1);
  if (s2) await api('POST', '/api/reservations', { token: otro.token, body: { slotId: s2.id, people: 1, version: s2.version } });
  await sleep(800);

  const vuelta = rtCliente(yo.token, []);
  await vuelta.abierto;
  vuelta.ws.send(JSON.stringify({ type: 'RESUME', last_seq: ultimo, topics: [`zone:${p.zone}`] }));
  const replay = await esperar(() => vuelta.replays[0]);
  check('RT-2: REPLAY trae lo perdido durante el corte', !!replay && replay.some((e) => e.type === 'PLACE.UPDATE' && e.seq > ultimo), replay ? `${replay.length} eventos` : 'sin REPLAY');
  const ordenados = !!replay && replay.every((e, i) => i === 0 || e.seq > replay[i - 1].seq);
  check('RT-2: en orden y sin duplicados', ordenados && new Set(replay?.map((e) => e.id)).size === replay?.length);

  // Lo nuevo después del RESUME también debe llegar (el bug que se corrigió).
  const s3 = (await api('GET', `/api/places/${p.id}`, { token: otro.token })).data.slots.find((x) => x.capacity - x.taken >= 1);
  if (s3) await api('POST', '/api/reservations', { token: otro.token, body: { slotId: s3.id, people: 1, version: s3.version } });
  const nuevo = await esperar(() => vuelta.eventos.find((e) => e.type === 'PLACE.UPDATE'));
  check('RT-2: después de reanudar siguen llegando eventos', !!nuevo);
  vuelta.ws.close();
}

async function cc1() {
  const negocio = (await api('POST', '/api/auth/demo', { body: { userId: 'b1' } })).data.token;
  const promo = await api('POST', '/api/promos', {
    token: negocio,
    body: { placeId: 'p7', title: 'Prueba de carga CC-1', discount: 'QA', stock: STOCK, durationS: 90 },
  });
  if (promo.status !== 201) return check('CC-1: lanzar promo', false, `${promo.status} ${JSON.stringify(promo.data)}`);

  const clientes = await Promise.all(Array.from({ length: CLIENTES }, (_, i) => login(`QA Cliente ${i}`)));
  const r = await Promise.all(clientes.map((c) => api('POST', `/api/promos/${promo.data.id}/claim`, { token: c.token })));
  const ok = r.filter((x) => x.status === 200).length;
  const agotadas = r.filter((x) => x.data?.code === 'PROMO_AGOTADA').length;
  check(`CC-1: ${CLIENTES} personas contra stock ${STOCK}`, ok === STOCK && agotadas === CLIENTES - STOCK, `${ok} cupones, ${agotadas} PROMO_AGOTADA`);

  const promo2 = await api('POST', '/api/promos', {
    token: negocio,
    body: { placeId: 'p7', title: 'Prueba un cupón por persona', discount: 'QA', stock: 10, durationS: 60 },
  });
  const una = clientes[0];
  const r2 = await Promise.all(Array.from({ length: 8 }, () => api('POST', `/api/promos/${promo2.data.id}/claim`, { token: una.token })));
  check('Un cupón por persona', r2.filter((x) => x.status === 200).length === 1 && r2.filter((x) => x.data?.code === 'YA_RECLAMADA').length === 7);
}

async function ganadores() {
  const negocio = (await api('POST', '/api/auth/demo', { body: { userId: 'b1' } })).data.token;
  const promo = await api('POST', '/api/promos', {
    token: negocio,
    body: { placeId: 'p7', title: 'Prueba bono para el ganador', discount: 'QA', stock: 2, durationS: 180, soloGanadores: true, puestos: 1 },
  });
  if (promo.status !== 201) return check('Solo ganadores: lanzar', false, JSON.stringify(promo.data));

  const a = await login('QA Bot Ana');
  const b = await login('QA Bot Beto');
  const antes = await api('POST', `/api/promos/${promo.data.id}/claim`, { token: a.token });
  check('Solo ganadores: sin jugar no se puede', antes.data?.code === 'SOLO_GANADORES', antes.data?.code);

  // Los avisos de bono de Beto llegan a su tópico privado.
  const avisosBeto = rtCliente(b.token, [`user:${b.user.id}`]);
  await avisosBeto.abierto;

  const fin = await duelo(a, b, true);
  if (!fin) return;
  const salaTras = ((await api('GET', '/api/salas', { token: a.token })).data?.data ?? []).find((s) => s.id === SALA);
  check('Fin de partida: la sala queda vacía (sin revancha automática)', salaTras?.cantidadJugadores === 0, `${salaTras?.cantidadJugadores} jugadores, ${salaTras?.estado}`);

  // Beto vuelve a ganar: el mismo bono no se avisa dos veces.
  await duelo(a, b, false);
  await sleep(1500); // promo procesa GAME.PARTIDA_FINALIZADA por el bus
  const avisos = avisosBeto.eventos.filter((e) => e.type === 'PROMO.UNLOCKED' && e.payload?.promo?.id === promo.data.id).length;
  avisosBeto.ws.close();
  check('Bono: dos victorias, un solo aviso', avisos === 1, `${avisos} avisos`);

  const rb = await api('POST', `/api/promos/${promo.data.id}/claim`, { token: b.token });
  check('Solo ganadores: el ganador reclama su bono', rb.status === 200, rb.data?.code ?? rb.data?.code);
  const ra = await api('POST', `/api/promos/${promo.data.id}/claim`, { token: a.token });
  check('Solo ganadores: quien perdió no puede', ra.data?.code === 'SOLO_GANADORES', ra.data?.code);
}

/** Una partida de duelo entre dos bots: Ana se estrella a propósito y gana Beto. */
async function duelo(a, b, conChecks) {
  for (const u of [a, b]) {
    const j = await api('POST', `/api/salas/${SALA}/jugadores`, { token: u.token });
    if (j.status >= 300) {
      check('CC-2: entrar a la sala de duelo', false, `${j.status} ${JSON.stringify(j.data)}`);
      return null;
    }
  }
  // El estado de cada tick lo publica game en el bus y llega por realtime
  // (GAME.STATE_UPDATE en salas:<id>), igual que en la app. Los comandos van por STOMP.
  const rt = rtCliente(a.token, [`salas:${SALA}`]);
  await rt.abierto;
  let resultado = null;
  let enCurso = false;
  const cabezasBeto = [];
  const mirar = () => {
    for (const e of rt.eventos.splice(0)) {
      if (e.type !== 'GAME.STATE_UPDATE') continue;
      if (e.payload.estado === 'EN_CURSO') {
        enCurso = true;
        const beto = e.payload.jugadores.find((j) => j.jugadorId === b.user.id);
        if (beto?.cuerpo?.[0]) cabezasBeto.push(`${beto.cuerpo[0].x},${beto.cuerpo[0].y}`);
      }
      if (e.payload.resultado) resultado = e.payload.resultado;
    }
  };
  const vigia = setInterval(mirar, 50);
  const conA = stomp(a.token);
  const conB = stomp(b.token);
  await Promise.all([conA.conectado, conB.conectado]);
  for (const c of [conA, conB]) c.send(`/app/salas/${SALA}/registrar-sesion`, {});
  const empezo = await esperar(() => enCurso, 20000);
  if (conChecks) check('CC-2: la partida arranca sola con la sala llena', !!empezo);
  // Snake continuo: las serpientes avanzan solas. Ana (nace en (4,2) mirando a
  // la derecha) gira hacia arriba y choca con el borde en 3 pasos; Beto no toca
  // nada y sigue derecho, lejos de las paredes.
  const t = setInterval(() => conA.send(`/app/salas/${SALA}/mover`, { direccion: 'ARRIBA' }), 100);
  const fin = await esperar(() => resultado, 60000);
  clearInterval(t);
  clearInterval(vigia);
  conA.close();
  conB.close();
  rt.ws.close();
  if (conChecks) {
    check('Snake continuo: la serpiente avanza sin recibir teclas', new Set(cabezasBeto).size >= 2, `${new Set(cabezasBeto).size} posiciones de Beto`);
    check('CC-2: la partida termina con un ganador registrado', !!fin && fin.ganadorJugadorId === b.user.id, fin ? `ganó ${fin.ganadorJugadorNombre}` : 'sin resultado');
  }
  await sleep(500);
  return fin;
}

async function salaSinConexion() {
  // Alguien entra a una sala por REST y cierra la app sin conectarse al juego.
  const yo = await login('QA Fantasma');
  const sala = 'sala-005';
  const j = await api('POST', `/api/salas/${sala}/jugadores`, { token: yo.token });
  if (j.status >= 300) return check('Salas: entrar sin conexión', false, `${j.status}`);
  const adentro = async () =>
    ((await api('GET', '/api/salas', { token: yo.token })).data?.data ?? []).find((s) => s.id === sala)?.nombresJugadores.includes(yo.user.name);
  check('Salas: entra a la sala', await adentro());
  const inicio = Date.now();
  let sigue = true;
  while (sigue && Date.now() - inicio < 45000) {
    await sleep(3000);
    sigue = await adentro();
  }
  check('Salas: sin conexión de juego sale solo', !sigue, `${Math.round((Date.now() - inicio) / 1000)} s`);
}

async function agente() {
  const yo = await login('QA Agente');
  const r = await api('POST', '/api/plan', { token: yo.token, body: { text: 'Somos cuatro amigos, queremos comer y después bailar' } });
  check('Agente arma una ruta', r.status === 201 || r.status === 200 ? r.data?.stops?.length >= 2 : false, r.data ? `${r.data.source}: ${r.data.stops?.map((s) => s.placeName).join(' → ')}` : String(r.status));
}

const pasos = [salud, loginPorNombre, rt1yCc3, cc1, ganadores, salaSinConexion, agente];
for (const paso of pasos) {
  try {
    await paso();
  } catch (e) {
    check(paso.name, false, e instanceof Error ? e.message : String(e));
  }
}
const fallas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - fallas.length}/${resultados.length} verificaciones en verde.`);
process.exit(fallas.length ? 1 : 0);
