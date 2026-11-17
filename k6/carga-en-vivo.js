// Prueba de carga para la demo en vivo (ESC-04): tráfico sostenido contra lb-gateway
// mientras se apaga una instancia del gateway. Mide errores, latencia y el reparto
// entre gateway-a y gateway-b (header x-lb-backend que agrega nuestro balanceador).
//
//   k6 run k6/carga-en-vivo.js
//   k6 run -e RPS=60 -e DURACION=90s k6/carga-en-vivo.js
//
// OJO: el gateway limita a 5000 peticiones por minuto POR INSTANCIA y cuenta los 429
// como ataque (más de 50 en un minuto bloquea la IP 10 minutos). Con RPS=80 llegan
// 4800 por minuto en total: caben aunque quede una sola instancia. No subir de 80.
// Solo usa /api/health, que no exige token (un 401 también contaría como ataque).
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'https://planazo-api-gateway-production.up.railway.app').replace(/\/$/, '');
const RPS = Math.min(Number(__ENV.RPS || 80), 80);
const DURACION = __ENV.DURACION || '60s';

const atendidasA = new Counter('atendidas_gateway_a');
const atendidasB = new Counter('atendidas_gateway_b');
const atendidasOtro = new Counter('atendidas_otro');

export const options = {
  dns: { ttl: '10m', select: 'first' }, // una sola consulta DNS: el resolvedor local se ahoga con cientos
  scenarios: {
    carga: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURACION,
      preAllocatedVUs: 40,
      maxVUs: 120,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const r = http.get(`${BASE_URL}/api/health`, { tags: { name: 'GET /api/health' } });
  check(r, { 'respondió 200': (x) => x.status === 200 });
  const b = r.headers['X-Lb-Backend'];
  if (b === 'gateway-a') atendidasA.add(1);
  else if (b === 'gateway-b') atendidasB.add(1);
  else atendidasOtro.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const total = m.http_reqs ? m.http_reqs.values.count : 0;
  const fallidas = m.http_req_failed ? Math.round(m.http_req_failed.values.rate * total) : 0;
  const d = m.http_req_duration ? m.http_req_duration.values : {};
  const n = (k) => (m[k] ? m[k].values.count : 0);
  const reparto = `gateway-a ${n('atendidas_gateway_a')} · gateway-b ${n('atendidas_gateway_b')}` + (n('atendidas_otro') ? ` · sin respuesta ${n('atendidas_otro')}` : '');
  const texto = [
    '',
    '================ PLANAZO · CARGA EN VIVO ================',
    `Peticiones: ${total} (${RPS} por segundo)   Fallidas: ${fallidas}`,
    `Latencia: mediana ${Math.round(d.med || 0)} ms · p95 ${Math.round(d['p(95)'] || 0)} ms · máx ${Math.round(d.max || 0)} ms`,
    `Reparto del balanceador: ${reparto || '(sin datos)'}`,
    '=========================================================',
    '',
  ].join('\n');
  return { stdout: texto };
}
