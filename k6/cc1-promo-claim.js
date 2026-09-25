/**
 * CC-1 · Promociones limitadas — N usuarios reclaman a la vez un cupón con stock finito.
 *
 * Qué demuestra: el decremento atómico en Redis del servicio `promo`. Con STOCK cupones y
 * VUS reclamantes simultáneos, deben salir EXACTAMENTE STOCK respuestas 200 y VUS - STOCK
 * respuestas 409 `PROMO_AGOTADA`. Ni un cupón de más (sobreventa) ni uno de menos (pérdida).
 *
 * Uso:
 *   k6 run k6/cc1-promo-claim.js
 *   k6 run -e BASE_URL=https://gateway.up.railway.app -e VUS=500 -e STOCK=20 k6/cc1-promo-claim.js
 *
 * Variables de entorno:
 *   BASE_URL  URL del API Gateway              (default http://localhost:8080)
 *   VUS       usuarios virtuales que reclaman  (default 200)
 *   STOCK     stock de la promo que se lanza   (default 10)
 *
 * Sobre los thresholds: en k6 un threshold sobre una métrica `Counter` se expresa con `count==N`
 * (también `count<N`, `count>=N`). Aquí usamos igualdad exacta porque el reto es de conteo exacto.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const VUS = Number(__ENV.VUS || 200);
const STOCK = Number(__ENV.STOCK || 10);

// Tokens de clientes que rotan entre los VUs (u1..u6 son los usuarios semilla del gateway).
const CLIENTES = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
// Negocio que lanza la promo y el establecimiento que administra (b1 → p7, Bar El Zaguán).
const NEGOCIO = 'b1';
const PLACE_ID = 'p7';

const claimsOk = new Counter('claims_ok'); // 200: cupón entregado
const claimsAgotado = new Counter('claims_agotado'); // 409 PROMO_AGOTADA: llegó tarde
const respuestas5xx = new Counter('respuestas_5xx'); // cualquier 5xx: fallo del servidor
const otras = new Counter('claims_otras'); // cualquier otro status/código inesperado

// Un 409 es una respuesta ESPERADA en esta prueba: no debe contar como http_req_failed.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

export const options = {
  scenarios: {
    reclamar: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1, // cada VU reclama UNA vez
      maxDuration: '2m',
    },
  },
  thresholds: {
    claims_ok: [`count==${STOCK}`], // exactamente el stock: cero sobreventa, cero pérdida
    claims_agotado: [`count==${VUS - STOCK}`], // todos los demás reciben PROMO_AGOTADA
    respuestas_5xx: ['count==0'],
    claims_otras: ['count==0'],
  },
};

const json = { headers: { 'Content-Type': 'application/json' } };

/** Login demo: el gateway firma un JWT fijo para el usuario semilla. */
function login(userId) {
  const r = http.post(`${BASE_URL}/api/auth/demo`, JSON.stringify({ userId }), json);
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`login ${userId} falló: HTTP ${r.status} ${r.body}`);
  }
  return r.json('token');
}

function auth(token) {
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
}

export function setup() {
  if (VUS < STOCK) throw new Error(`VUS (${VUS}) debe ser >= STOCK (${STOCK}) para que la prueba tenga sentido`);

  // 1 · el negocio lanza la promo con el stock de la prueba
  const negocio = login(NEGOCIO);
  const body = {
    placeId: PLACE_ID,
    title: `Prueba de carga CC-1 · ${new Date().toISOString()}`,
    discount: '2x1',
    stock: STOCK,
    durationS: 120,
  };
  const r = http.post(`${BASE_URL}/api/promos`, JSON.stringify(body), auth(negocio));
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`POST /api/promos falló: HTTP ${r.status} ${r.body}`);
  }
  const promo = r.json();
  console.log(`Promo lanzada: ${promo.id} (stock ${promo.stock}) en ${promo.placeName || PLACE_ID}`);

  // 2 · tokens de los clientes que van a competir
  const tokens = CLIENTES.map(login);

  // Se arrancan las métricas en 0 para que existan aunque nunca se incrementen.
  respuestas5xx.add(0);
  otras.add(0);

  return { promoId: promo.id, tokens };
}

export default function (data) {
  // Rotación de usuarios: el VU 1 usa u1, el 2 usa u2, ..., el 7 vuelve a u1.
  const token = data.tokens[(__VU - 1) % data.tokens.length];

  const r = http.post(`${BASE_URL}/api/promos/${data.promoId}/claim`, null, auth(token));

  let code;
  try {
    code = r.json('code');
  } catch (_) {
    code = undefined;
  }

  if (r.status === 200 || r.status === 201) {
    claimsOk.add(1);
    check(r, { 'cupón con code y promoId': (res) => !!res.json('code') && res.json('promoId') === data.promoId });
  } else if (r.status === 409 && code === 'PROMO_AGOTADA') {
    claimsAgotado.add(1);
  } else if (r.status >= 500) {
    respuestas5xx.add(1);
    console.error(`5xx en claim: ${r.status} ${r.body}`);
  } else {
    otras.add(1);
    console.error(`Respuesta inesperada en claim: ${r.status} ${r.body}`);
  }
}

export function handleSummary(data) {
  const c = (name) => (data.metrics[name] && data.metrics[name].values.count) || 0;
  const ok = c('claims_ok');
  const agotado = c('claims_agotado');
  const lineas = [
    '',
    '=== CC-1 · Promociones limitadas ===',
    `VUs reclamando:        ${VUS}`,
    `Stock de la promo:     ${STOCK}`,
    `Cupones entregados:    ${ok}   (esperado ${STOCK})`,
    `PROMO_AGOTADA:         ${agotado}   (esperado ${VUS - STOCK})`,
    `Respuestas 5xx:        ${c('respuestas_5xx')}`,
    `Otras respuestas:      ${c('claims_otras')}`,
    ok === STOCK && agotado === VUS - STOCK
      ? 'RESULTADO: OK — cero sobreventa y cero pérdida (DoD recurso finito cumplido)'
      : 'RESULTADO: FALLÓ — el conteo no cuadra con el stock',
    '',
  ];
  return { stdout: lineas.join('\n') };
}
