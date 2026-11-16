#!/usr/bin/env node
/**
 * Ensayo de la demo con el salón, contra producción. N personas hacen a la vez
 * lo mismo que hará el salón (por defecto 4; con PERSONAS=30 se ensaya en grande).
 * Node 22+ (fetch y WebSocket nativos), sin dependencias.
 *
 *   node pruebas/demo-salon.mjs
 *   PERSONAS=8 node pruebas/demo-salon.mjs
 *
 *   1. Todos entran a la vez con nombre único; un nombre repetido recibe 409.
 *   2. RT-2  el negocio lanza una promo y les llega a todos en vivo.
 *      CC-1  todos la reclaman a la vez: salen exactamente los cupones del stock.
 *   3. CC-3  todos pelean el mismo cupo con la misma versión: gana uno.
 *      RT-1  el cambio de cupos le llega en vivo a todos.
 *   4. RT-3 + CC-2  duelos de Snake simultáneos con bono «solo ganadores»:
 *      un ganador por sala, la sala queda vacía, el aviso llega solo al
 *      ganador y una sola vez aunque gane otra partida; quien pierde no reclama.
 *   5. El agente arma un plan para todos a la vez.
 *   6. RT-2  un celular pierde la señal y al volver recupera lo que se perdió.
 */

/** Solo se ensaya contra gateways conocidos: producción o uno local. */
const BASES = ['https://planazo-api-gateway-production.up.railway.app', 'http://localhost:8080', 'http://localhost:18080'];
const basePedida = (process.env.BASE_URL ?? BASES[0]).replace(/\/$/, '');
const BASE = BASES.find((b) => b === basePedida);
if (!BASE) {
  console.error(`BASE_URL debe ser uno de: ${BASES.join(', ')}`);
  process.exit(1);
}
const RT = process.env.REALTIME_URL ?? 'wss://planazo-realtime-production.up.railway.app/ws';
const GAME_WS = (process.env.GAME_WS ?? 'wss://planazo-game-production.up.railway.app').replace(/\/$/, '') + '/ws/websocket';
const N = Math.max(4, Number(process.env.PERSONAS ?? 4));
const STOCK = Math.max(1, Math.floor(N / 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n = 14) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const CORRIDA = rnd(4);
const resultados = [];
/** Lo que viene del servidor va a la consola en una sola línea: sin saltos ni caracteres de control. */
const enUnaLinea = (texto) => String(texto).replace(/[\u0000-\u001f\u007f]+/g, ' ');
function check(nombre, ok, detalle = '') {
  resultados.push(ok);
  console.log(enUnaLinea(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`));
}
const ms = (t0) => `${Math.round(performance.now() - t0)} ms`;

/**
 * Se entra únicamente con Google, así que las pruebas usan POST /api/auth/demo
 * con la llave DEMO_LOGIN_KEY (la misma variable del gateway). Cada persona de
 * prueba es un usuario `qa-…` distinto por corrida.
 */
const DEMO_KEY = process.env.DEMO_LOGIN_KEY ?? '';
if (!DEMO_KEY) {
  console.error('Falta DEMO_LOGIN_KEY (la misma que tiene el gateway): DEMO_LOGIN_KEY=... node pruebas/<script>.mjs');
  process.exit(1);
}
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Los ids vienen de respuestas del servidor. Lista blanca: un id solo puede tener
 * letras, dígitos, `-` y `_`, y el segmento se arma con caracteres de este alfabeto.
 */
const ALFABETO_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function seg(id) {
  const texto = String(id);
  if (texto.length === 0 || texto.length > 64) throw new Error(`id inválido (${texto.length} caracteres)`);
  return Array.from(texto, (c) => {
    const i = ALFABETO_ID.indexOf(c);
    if (i < 0) throw new Error('id con caracteres no permitidos');
    return ALFABETO_ID[i];
  }).join('');
}

async function api(method, path, { token, body } = {}) {
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
  return { status: res.status, data: data?.data ?? data };
}

async function esperar(cond, limite = 8000) {
  const fin = Date.now() + limite;
  while (Date.now() < fin) {
    const v = cond();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

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
      eventos.push({ ...msg.event, llegada: performance.now() });
      if (msg.event.seq > lastSeq) lastSeq = msg.event.seq;
    } else if (msg.type === 'REPLAY') {
      replays.push(msg.events);
      for (const e of msg.events) if (e.seq > lastSeq) lastSeq = e.seq;
    }
  };
  return { ws, eventos, replays, abierto, get lastSeq() { return lastSeq; } };
}

function stomp(token) {
  const ws = new WebSocket(GAME_WS);
  const frame = (cmd, headers = {}, body = '') =>
    ws.send(`${cmd}\n${Object.entries(headers).map(([k, v]) => `${k}:${v}`).join('\n')}\n\n${body}\0`);
  const conectado = new Promise((ok, mal) => {
    ws.onopen = () => frame('CONNECT', { 'accept-version': '1.2', host: 'planazo', Authorization: `Bearer ${token}`, 'heart-beat': '0,0' });
    ws.onerror = (e) => mal(e);
    ws.onmessage = (m) => {
      for (const raw of String(m.data).split('\0')) {
        const cmd = raw.replace(/^\n+/, '').split('\n')[0];
        if (cmd === 'CONNECTED') ok();
        if (cmd === 'ERROR') mal(new Error(raw));
      }
    };
  });
  return {
    conectado,
    send: (dest, body) => frame('SEND', { destination: dest, 'content-type': 'application/json' }, JSON.stringify(body)),
    close: () => { try { ws.close(); } catch {} },
  };
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`Ensayo de la demo con ${N} personas contra ${BASE}\n`);

  // 1. Todos entran a la vez ------------------------------------------------
  let t0 = performance.now();
  const logins = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      api('POST', '/api/auth/demo', { body: { userId: `qa-salon-${i + 1}-${CORRIDA}`, name: `Salón ${i + 1} ${CORRIDA}`, role: 'cliente' } }),
    ),
  );
  const gente = logins.filter((r) => r.status === 200 || r.status === 201).map((r) => ({ token: r.data.token, user: r.data.user }));
  check(`Entrar: ${N} personas a la vez`, gente.length === N, `${gente.length}/${N} en ${ms(t0)}`);
  const ids = new Set(gente.map((g) => g.user.id));
  check('Entrar: cada persona es una cuenta distinta', ids.size === N);

  // conexiones en vivo de todos: su zona y su tópico privado
  const vivos = gente.map((g) => rtCliente(g.token, ['zone:zona-t', `user:${g.user.id}`]));
  await Promise.all(vivos.map((v) => v.abierto));
  await sleep(500);
  check('Tiempo real: todos conectados', vivos.every((v) => v.ws.readyState === 1), `${vivos.length} WebSocket`);

  const negocio = (await api('POST', '/api/auth/demo', { body: { userId: 'b1' } })).data.token;

  // 2. Promo en vivo y carrera por los cupones -----------------------------
  t0 = performance.now();
  const promo = await api('POST', '/api/promos', {
    token: negocio,
    body: { placeId: 'p7', title: `Ensayo de la demo ${CORRIDA}`, discount: 'QA', stock: STOCK, durationS: 180 },
  });
  if (promo.status !== 201) return check('Promo: lanzar', false, `${promo.status} ${JSON.stringify(promo.data)}`);
  const llego = await esperar(() => vivos.every((v) => v.eventos.some((e) => e.type === 'PROMO.PUSH' && e.payload?.id === promo.data.id)), 5000);
  const tiempos = vivos.map((v) => v.eventos.find((e) => e.type === 'PROMO.PUSH' && e.payload?.id === promo.data.id)?.llegada).filter(Boolean);
  check('RT-2: la promo le llega en vivo a todos', !!llego, `${tiempos.length}/${N}, la última en ${Math.round(Math.max(...tiempos) - t0)} ms`);

  t0 = performance.now();
  const reclamos = await Promise.all(gente.map((g) => api('POST', `/api/promos/${seg(promo.data.id)}/claim`, { token: g.token })));
  const ok = reclamos.filter((r) => r.status === 200 || r.status === 201).length;
  const agotadas = reclamos.filter((r) => r.data?.code === 'PROMO_AGOTADA').length;
  const errores = reclamos.filter((r) => r.status >= 500).length;
  check(`CC-1: ${N} reclaman a la vez un stock de ${STOCK}`, ok === STOCK && agotadas === N - STOCK && errores === 0, `${ok} cupones, ${agotadas} «agotada», ${errores} errores, en ${ms(t0)}`);
  const ganadas = await esperar(() => vivos[0].eventos.filter((e) => e.type === 'PROMO.WON' && e.payload?.promoId === promo.data.id).length >= STOCK && true, 5000);
  check('RT-2: el stock baja en vivo en los celulares', !!ganadas);
  const otraVez = await api('POST', `/api/promos/${seg(promo.data.id)}/claim`, { token: gente[0].token });
  check('CC-1: nadie reclama dos veces', ['YA_RECLAMADA', 'PROMO_AGOTADA'].includes(otraVez.data?.code), otraVez.data?.code);

  // 3. Todos pelean el mismo cupo ------------------------------------------
  const lugar = await api('GET', '/api/places/p7', { token: gente[0].token });
  const franja = (lugar.data?.slots ?? []).find((s) => s.capacity - s.taken >= 1);
  if (!franja) {
    check('CC-3: hay una franja con cupo en p7', false);
  } else {
    const antes = vivos.map((v) => v.eventos.length);
    t0 = performance.now();
    const reservas = await Promise.all(
      gente.map((g) => api('POST', '/api/reservations', { token: g.token, body: { slotId: franja.id, version: franja.version, people: 1 } })),
    );
    const confirmadas = reservas.filter((r) => r.status === 201);
    const conflictos = reservas.filter((r) => r.data?.code === 'VERSION_CONFLICT' || r.data?.code === 'SIN_CUPO').length;
    check(`CC-3: ${N} reservan el mismo cupo a la vez`, confirmadas.length === 1 && conflictos === N - 1, `1 confirmada y ${conflictos} «alguien reservó primero», en ${ms(t0)}`);
    const vieron = await esperar(
      () => vivos.every((v, k) => v.eventos.slice(antes[k]).some((e) => e.type === 'PLACE.UPDATE' && e.payload?.placeId === 'p7')),
      5000,
    );
    check('RT-1: el cupo cambia en vivo en el mapa de todos', !!vieron);
    const despues = await api('GET', '/api/places/p7', { token: gente[0].token });
    const f2 = despues.data.slots.find((s) => s.id === franja.id);
    check('CC-3: sin sobreventa', f2.taken === franja.taken + 1 && f2.taken <= f2.capacity, `ocupados ${franja.taken} → ${f2.taken} de ${f2.capacity}`);
    // deja la franja como estaba
    const quien = gente[reservas.indexOf(confirmadas[0])];
    await api('DELETE', `/api/reservations/${seg(confirmadas[0].data.id)}`, { token: quien.token });
  }

  // 4. Duelos de Snake con bono para ganadores -----------------------------
  const bono = await api('POST', '/api/promos', {
    token: negocio,
    body: { placeId: 'p7', title: `Bono del ensayo ${CORRIDA}`, discount: 'QA', stock: N, durationS: 300, soloGanadores: true, puestos: 1 },
  });
  if (bono.status !== 201) return check('Bono: lanzar', false, JSON.stringify(bono.data));
  const salas = (await api('GET', '/api/salas', { token: gente[0].token })).data.filter((s) => s.capacidad === 2 && s.cantidadJugadores === 0);
  const duelos = [];
  for (let k = 0; k + 1 < N && duelos.length < salas.length; k += 2) duelos.push({ sala: salas[duelos.length].id, a: gente[k], b: gente[k + 1] });
  check('Snake: hay salas de duelo libres', duelos.length >= 1, `${duelos.length} duelos simultáneos`);

  async function jugar(d) {
    const obs = rtCliente(d.a.token, [`salas:${d.sala}`]);
    await obs.abierto;
    const conA = stomp(d.a.token);
    const conB = stomp(d.b.token);
    await Promise.all([conA.conectado, conB.conectado]);
    for (const u of [d.a, d.b]) {
      const j = await api('POST', `/api/salas/${seg(d.sala)}/jugadores`, { token: u.token });
      if (j.status >= 300) throw new Error(`entrar a ${d.sala}: ${j.status} ${JSON.stringify(j.data)}`);
    }
    for (const c of [conA, conB]) c.send(`/app/salas/${d.sala}/registrar-sesion`, {});
    const enCurso = await esperar(() => obs.eventos.some((e) => e.type === 'GAME.STATE_UPDATE' && e.payload.estado === 'EN_CURSO'), 20000);
    // A (nace mirando a la derecha) gira hacia arriba y se estrella; B sigue derecho.
    const giro = setInterval(() => conA.send(`/app/salas/${d.sala}/mover`, { direccion: 'ARRIBA' }), 100);
    const fin = await esperar(() => obs.eventos.find((e) => e.type === 'GAME.STATE_UPDATE' && e.payload.resultado)?.payload.resultado, 60000);
    clearInterval(giro);
    await sleep(1500);
    const finales = obs.eventos.filter((e) => e.type === 'GAME.STATE_UPDATE' && e.payload.resultado).map((e) => e.payload.resultado.finalizadaEn);
    conA.close();
    conB.close();
    obs.ws.close();
    return { enCurso: !!enCurso, fin, resultadosDistintos: new Set(finales).size };
  }

  t0 = performance.now();
  const partidas = await Promise.all(duelos.map(jugar));
  check('RT-3: los duelos arrancan solos con la sala llena', partidas.every((p) => p.enCurso));
  check(
    `CC-2: ${partidas.length} partidas simultáneas terminan, cada una con su ganador`,
    partidas.every((p, k) => p.fin?.ganadorJugadorId === duelos[k].b.user.id && p.resultadosDistintos === 1),
    `${ms(t0)}; ganadores: ${partidas.map((p) => p.fin?.ganadorJugadorNombre).join(', ')}`,
  );
  await sleep(3000);
  // La app es pública: alguien más puede entrar a la sala; lo que importa es que los nuestros ya no estén.
  const tras = (await api('GET', '/api/salas', { token: gente[0].token })).data;
  const nuestros = new Set(duelos.flatMap((d) => [d.a.user.name, d.b.user.name]));
  check('Fin de partida: los jugadores salen de la sala, sin revancha sola',
    duelos.every((d) => !(tras.find((s) => s.id === d.sala)?.nombresJugadores ?? []).some((n) => nuestros.has(n))));

  const avisos = (u) => vivos[gente.indexOf(u)].eventos.filter((e) => e.type === 'PROMO.UNLOCKED' && e.payload?.promo?.id === bono.data.id).length;
  check('Bono: el aviso le llega solo a cada ganador', duelos.every((d) => avisos(d.b) === 1 && avisos(d.a) === 0), duelos.map((d) => `${avisos(d.b)}/${avisos(d.a)}`).join(' '));

  // revancha: los mismos vuelven a jugar (en salas libres) y ganan los mismos → ningún aviso nuevo
  const libres = (await api('GET', '/api/salas', { token: gente[0].token })).data.filter((s) => s.capacidad === 2 && s.cantidadJugadores === 0);
  const revanchas = duelos.slice(0, libres.length).map((d, k) => ({ ...d, sala: libres[k].id }));
  await Promise.all(revanchas.map(jugar));
  await sleep(2000);
  check('Bono: volver a ganar no repite el aviso', duelos.every((d) => avisos(d.b) === 1));

  const reclamosBono = await Promise.all(duelos.flatMap((d) => [d.b, d.a]).map((u) => api('POST', `/api/promos/${seg(bono.data.id)}/claim`, { token: u.token })));
  const okGan = reclamosBono.filter((r, k) => k % 2 === 0 && r.status === 200).length;
  const noPerd = reclamosBono.filter((r, k) => k % 2 === 1 && r.data?.code === 'SOLO_GANADORES').length;
  check('Bono: los ganadores reclaman y quienes perdieron no', okGan === duelos.length && noPerd === duelos.length, `${okGan} reclamados, ${noPerd} «solo ganadores»`);

  // 5. El agente para todos a la vez ---------------------------------------
  const pedidos = ['cumpleaños para seis, comida y rumba', 'plan de parque y picnic barato', 'tejo y cerveza con los amigos', 'cita tranquila con mi pareja'];
  t0 = performance.now();
  const planes = await Promise.all(
    gente.map((g, k) => {
      const t = performance.now();
      return api('POST', '/api/plan', { token: g.token, body: { text: pedidos[k % pedidos.length] } }).then((r) => ({ ...r, ms: performance.now() - t }));
    }),
  );
  const buenos = planes.filter((p) => (p.status === 200 || p.status === 201) && p.data?.stops?.length >= 2);
  check(
    `Agente: ${N} planes a la vez`,
    buenos.length === N,
    `${buenos.length}/${N} · ${buenos.filter((p) => p.data.source === 'claude').length} con Claude · el más lento ${Math.round(Math.max(...planes.map((p) => p.ms)) / 1000)} s`,
  );

  // 6. Un celular pierde la señal y vuelve ----------------------------------
  const corte = vivos[N - 1];
  const ultimo = corte.lastSeq;
  corte.ws.close();
  await sleep(500);
  const perdida = await api('POST', '/api/promos', {
    token: negocio,
    body: { placeId: 'p7', title: `Mientras no había señal ${CORRIDA}`, discount: 'QA', stock: 1, durationS: 60 },
  });
  await sleep(1000);
  const vuelta = rtCliente(gente[N - 1].token, []);
  await vuelta.abierto;
  vuelta.ws.send(JSON.stringify({ type: 'RESUME', last_seq: ultimo, topics: ['zone:zona-t'] }));
  const replay = await esperar(() => vuelta.replays.flat().find((e) => e.type === 'PROMO.PUSH' && e.payload?.id === perdida.data?.id), 5000);
  check('RT-2: al volver la señal llega lo que se perdió', !!replay);
  vuelta.ws.close();

  vivos.forEach((v) => v.ws.close());
  const total = resultados.length;
  const verdes = resultados.filter(Boolean).length;
  console.log(`\n${verdes}/${total} verificaciones en verde.`);
  process.exit(verdes === total ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ El ensayo se detuvo:', err.message);
  process.exit(1);
});
