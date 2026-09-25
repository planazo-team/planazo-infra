/**
 * CC-3 · Cupos limitados — N usuarios reservan a la vez la misma franja horaria.
 *
 * Qué demuestra: el lock optimista con versionado del servicio `booking`. La franja tiene
 * `capacity - taken` cupos libres y llegan más reservas que cupos. Al final, `taken` NUNCA
 * supera `capacity` (cero sobreventa) y el número de reservas exitosas es exactamente el
 * número de cupos que había libres.
 *
 * Dos variantes, elegidas con MODE:
 *
 *   MODE=simple    Todos los VUs mandan la MISMA `version` leída en setup, una sola vez.
 *                  Con lock optimista puro solo UNA reserva puede pasar: las demás reciben
 *                  409 VERSION_CONFLICT aunque quedaran cupos. Es correcto (nadie sobrevende)
 *                  pero no demuestra que los cupos libres se lleguen a ocupar. Sirve para ver
 *                  el conflicto "en crudo".
 *
 *   MODE=reintento (default) Ante 409 VERSION_CONFLICT, el VU relee la franja (GET /api/places/:id),
 *                  toma la `version` nueva y reintenta, hasta 5 veces. Así se demuestra la
 *                  propiedad completa: se ocupan todos los cupos libres, ninguno más, y los
 *                  que sobran terminan en 409 SIN_CUPO.
 *
 * Uso:
 *   k6 run k6/cc3-booking-reserve.js
 *   k6 run -e MODE=simple k6/cc3-booking-reserve.js
 *   k6 run -e BASE_URL=https://gateway.up.railway.app -e VUS=40 k6/cc3-booking-reserve.js
 *
 * Variables de entorno:
 *   BASE_URL    URL del API Gateway                        (default http://localhost:8080)
 *   PLACE_ID    establecimiento                            (default p1)
 *   SLOT_INDEX  índice de la franja dentro de slots[]      (default 0)
 *   VUS         usuarios virtuales                         (default 25)
 *   MODE        reintento | simple                         (default reintento)
 *   MAX_INTENTOS reintentos por VU en modo reintento       (default 5)
 *
 * Nota sobre VUS: k6 fija el número de VUs en la fase init, ANTES de setup(), así que no puede
 * calcularse como `libres + 5` leyendo el servidor. Se pide por env con un default que supera con
 * holgura los cupos del seed (p1, franja 0: capacity 10, taken 6 → 4 libres). Si VUS < libres,
 * el número esperado de éxitos pasa a ser VUS.
 *
 * Nota sobre repetir la prueba: cada corrida ocupa cupos. Si la franja queda llena, la siguiente
 * corrida tendrá 0 libres y todos recibirán SIN_CUPO (lo cual sigue siendo correcto). Reinicia el
 * seed (scripts/seed.sh) o usa otro SLOT_INDEX.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Gauge, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PLACE_ID = __ENV.PLACE_ID || 'p1';
const SLOT_INDEX = Number(__ENV.SLOT_INDEX || 0);
const VUS = Number(__ENV.VUS || 25);
const MODE = (__ENV.MODE || 'reintento').toLowerCase();
const MAX_INTENTOS = Number(__ENV.MAX_INTENTOS || 5);

const CLIENTES = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];

const reservasOk = new Counter('reservas_ok'); // 201: reserva creada
const conflictosVersion = new Counter('conflictos_version'); // 409 VERSION_CONFLICT
const sinCupo = new Counter('sin_cupo'); // 409 SIN_CUPO
const respuestas5xx = new Counter('respuestas_5xx');
const otras = new Counter('reservas_otras');
const reintentos = new Counter('reintentos');

// Se evalúan en teardown leyendo el estado final de la franja.
const sinSobreventa = new Rate('sin_sobreventa'); // taken <= capacity
const exitosIgualLibres = new Rate('exitos_igual_libres'); // taken_final - taken_inicial == min(libres, VUS)

// Para mostrar en el resumen final.
const libresIniciales = new Gauge('libres_iniciales');
const takenFinalG = new Gauge('taken_final');
const capacityG = new Gauge('capacity');

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

export const options = {
  scenarios: {
    reservar: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '3m',
    },
  },
  thresholds: {
    sin_sobreventa: ['rate==1'], // NUNCA taken > capacity
    exitos_igual_libres: ['rate==1'], // se ocuparon exactamente los cupos libres (en modo simple no aplica: ver teardown)
    respuestas_5xx: ['count==0'],
    reservas_otras: ['count==0'],
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

/** Lee la ficha del lugar y devuelve la franja bajo prueba (con capacity, taken y version actuales). */
function leerFranja(token) {
  const r = http.get(`${BASE_URL}/api/places/${PLACE_ID}`, auth(token));
  if (r.status !== 200) throw new Error(`GET /api/places/${PLACE_ID} falló: HTTP ${r.status} ${r.body}`);
  const place = r.json();
  const slot = place.slots && place.slots[SLOT_INDEX];
  if (!slot) throw new Error(`El lugar ${PLACE_ID} no tiene slots[${SLOT_INDEX}]`);
  return slot;
}

export function setup() {
  const tokens = CLIENTES.map(login);
  const slot = leerFranja(tokens[0]);
  const libres = slot.capacity - slot.taken;
  libresIniciales.add(libres);
  capacityG.add(slot.capacity);
  respuestas5xx.add(0);
  otras.add(0);
  conflictosVersion.add(0);
  sinCupo.add(0);
  reintentos.add(0);

  console.log(
    `Franja ${slot.id} de ${PLACE_ID}: capacity=${slot.capacity} taken=${slot.taken} version=${slot.version} → ${libres} libres; ${VUS} VUs en modo ${MODE}`,
  );
  return { tokens, slotId: slot.id, version: slot.version, capacity: slot.capacity, takenInicial: slot.taken, libres };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  let version = data.version; // todos arrancan con la MISMA version leída en setup
  const intentosMax = MODE === 'simple' ? 1 : MAX_INTENTOS;

  for (let intento = 1; intento <= intentosMax; intento++) {
    const body = { slotId: data.slotId, people: 1, version };
    const r = http.post(`${BASE_URL}/api/reservations`, JSON.stringify(body), auth(token));
    let code;
    try {
      code = r.json('code');
    } catch (_) {
      code = undefined;
    }

    if (r.status === 201 || r.status === 200) {
      reservasOk.add(1);
      check(r, { 'reserva con id y code': (res) => !!res.json('id') && !!res.json('code') });
      return;
    }
    if (r.status === 409 && code === 'SIN_CUPO') {
      sinCupo.add(1); // no quedan cupos: resultado legítimo, no se reintenta
      return;
    }
    if (r.status === 409 && code === 'VERSION_CONFLICT') {
      conflictosVersion.add(1);
      if (intento < intentosMax) {
        // Alguien cambió la franja mientras decidíamos: releer y volver a intentar con la version nueva.
        reintentos.add(1);
        version = leerFranja(token).version;
        continue;
      }
      return;
    }
    if (r.status >= 500) {
      respuestas5xx.add(1);
      console.error(`5xx en reserva: ${r.status} ${r.body}`);
      return;
    }
    otras.add(1);
    console.error(`Respuesta inesperada en reserva: ${r.status} ${r.body}`);
    return;
  }
}

export function teardown(data) {
  const slot = leerFranja(data.tokens[0]);
  takenFinalG.add(slot.taken);

  // 1 · Cero sobreventa: la propiedad que NO se puede violar.
  sinSobreventa.add(slot.taken <= slot.capacity);

  // 2 · Se ocuparon exactamente los cupos libres (ni uno menos).
  //     En modo simple solo una reserva puede pasar por diseño, así que el esperado es min(1, libres).
  const esperado = MODE === 'simple' ? Math.min(1, data.libres) : Math.min(data.libres, VUS);
  const ocupados = slot.taken - data.takenInicial;
  exitosIgualLibres.add(ocupados === esperado);

  console.log(`Estado final: taken=${slot.taken}/${slot.capacity} · ocupados en la prueba=${ocupados} · esperado=${esperado}`);
}

export function handleSummary(data) {
  const c = (name) => (data.metrics[name] && data.metrics[name].values.count) || 0;
  const g = (name) => (data.metrics[name] && data.metrics[name].values.value) || 0;
  const rate = (name) => (data.metrics[name] ? data.metrics[name].values.rate : null);

  const libres = g('libres_iniciales');
  const capacity = g('capacity');
  const takenFinal = g('taken_final');
  const okSobreventa = rate('sin_sobreventa') === 1;
  const okExitos = rate('exitos_igual_libres') === 1;

  const lineas = [
    '',
    `=== CC-3 · Cupos limitados (${PLACE_ID}, slots[${SLOT_INDEX}], modo ${MODE}) ===`,
    `VUs reservando:            ${VUS}`,
    `Cupos libres al inicio:    ${libres}   (capacity ${capacity})`,
    `Reservas 201:              ${c('reservas_ok')}`,
    `409 VERSION_CONFLICT:      ${c('conflictos_version')}   (reintentos: ${c('reintentos')})`,
    `409 SIN_CUPO:              ${c('sin_cupo')}`,
    `Respuestas 5xx:            ${c('respuestas_5xx')}`,
    `taken final:               ${takenFinal}/${capacity}   → ${okSobreventa ? 'sin sobreventa' : 'SOBREVENTA'}`,
    `Éxitos == libres:          ${okExitos ? 'sí' : 'NO'}`,
    okSobreventa && okExitos
      ? 'RESULTADO: OK — cero sobreventa y todos los cupos libres ocupados (DoD recurso finito cumplido)'
      : 'RESULTADO: FALLÓ — revisa el lock optimista de booking',
    MODE === 'simple'
      ? 'Nota: en modo simple solo una reserva puede pasar (todas mandaron la misma version). Corre MODE=reintento para la prueba completa.'
      : '',
    '',
  ];
  return { stdout: lineas.join('\n') };
}
