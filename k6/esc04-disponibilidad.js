/**
 * Escenario 4 · Disponibilidad — escalamiento horizontal y tolerancia a fallos.
 *
 * Qué demuestra: con cada uno de api-gateway/booking/promo/realtime corriendo
 * 2 réplicas detrás de SU PROPIO balanceador Nginx (ver docker-compose.yml de
 * cada repo), una carga sostenida de peticiones mantiene una tasa de error
 * baja y una disponibilidad alta incluso si, a mitad de la prueba, una
 * réplica se cae (ver scripts/demo-disponibilidad.sh, que orquesta el
 * `docker stop`/`docker start` mientras este script corre).
 *
 * Qué NO hace este script: no tumba ninguna réplica — eso es
 * responsabilidad de scripts/demo-disponibilidad.sh (o de quien lo corra a
 * mano), para separar "generar carga y medir" de "inyectar la falla", como
 * en cualquier prueba de caos.
 *
 * Cada respuesta trae la cabecera `X-Upstream` (la agrega el Nginx de cada
 * repo, ver nginx.conf): este script la usa para contar cuántas peticiones
 * atendió cada réplica, así se confirma que el balanceo reparte tráfico
 * entre las dos sin tener que mirar los logs a mano.
 *
 * Uso:
 *   k6 run k6/esc04-disponibilidad.js                        # las 4 (round-robin de a una por iteración)
 *   k6 run -e TARGET=booking k6/esc04-disponibilidad.js       # solo booking, para la prueba de caos dirigida
 *   k6 run -e VUS=20 -e DURACION_S=60 k6/esc04-disponibilidad.js
 *
 * Variables de entorno:
 *   TARGET       api-gateway | booking | promo | realtime | all  (default all)
 *   VUS          usuarios virtuales concurrentes                 (default 10)
 *   DURACION_S   segundos que dura la carga sostenida             (default 30)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const TARGET = __ENV.TARGET || 'all';
const VUS = Number(__ENV.VUS || 10);
const DURACION_S = Number(__ENV.DURACION_S || 30);

/**
 * Cada servicio publica su propio balanceador en el puerto de siempre.
 * api-gateway tiene prefijo global `/api` (`app.setGlobalPrefix('api')`), así
 * que su salud vive en `/api/health`; los demás, en `/health`.
 */
const SERVICIOS = {
  'api-gateway': { url: __ENV.GATEWAY_URL || 'http://localhost:8080', ruta: '/api/health' },
  booking: { url: __ENV.BOOKING_URL || 'http://localhost:3001', ruta: '/health' },
  promo: { url: __ENV.PROMO_URL || 'http://localhost:3002', ruta: '/health' },
  realtime: { url: __ENV.REALTIME_URL || 'http://localhost:8081', ruta: '/health' },
};

const objetivos = TARGET === 'all' ? Object.entries(SERVICIOS) : [[TARGET, SERVICIOS[TARGET]]];
if (!objetivos[0] || !objetivos[0][1]) {
  throw new Error(`TARGET inválido: "${TARGET}". Usa api-gateway, booking, promo, realtime o all.`);
}
const nombresObjetivos = objetivos.map(([s]) => s);

const errores = new Rate('errores'); // 1 - disponibilidad
const latencia = new Trend('latencia_ms', true);
const porReplica = new Counter('peticiones_por_replica'); // tag `upstream` (ip:puerto real que respondió)
const porServicio = new Counter('peticiones_por_servicio'); // tag `servicio`

export const options = {
  scenarios: {
    carga_sostenida: {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${DURACION_S}s`,
    },
  },
  thresholds: {
    // Medida de respuesta del Escenario 4: <1% de error, >=99% de disponibilidad.
    errores: ['rate<0.01'],
  },
};

export default function () {
  const [servicio, { url: baseUrl, ruta }] = objetivos[Math.floor(Math.random() * objetivos.length)];
  const res = http.get(`${baseUrl}${ruta}`, { tags: { servicio } });

  const ok = check(res, { 'respuesta 200': (r) => r.status === 200 });
  errores.add(!ok);
  latencia.add(res.timings.duration, { servicio });
  porServicio.add(1, { servicio });

  const upstream = res.headers['X-Upstream'] || res.headers['x-upstream'];
  if (upstream) porReplica.add(1, { servicio, upstream });

  sleep(0.2);
}

export function handleSummary(data) {
  const rate = (name) => (data.metrics[name] ? data.metrics[name].values.rate : null);
  const count = (name) => (data.metrics[name] && data.metrics[name].values.count) || 0;
  const errorRate = rate('errores') ?? 0;
  const disponibilidad = (1 - errorRate) * 100;
  const p95 = data.metrics.latencia_ms ? data.metrics.latencia_ms.values['p(95)'] : null;
  const ok = errorRate < 0.01;

  const lineas = [
    '',
    '=== Escenario 4 · Disponibilidad ===',
    `Objetivo(s):          ${nombresObjetivos.join(', ')}`,
    `VUs:                  ${VUS}  ·  duración: ${DURACION_S}s`,
    `Peticiones totales:   ${count('peticiones_por_servicio')}`,
    `Tasa de error:        ${(errorRate * 100).toFixed(2)}%  (umbral: <1%)`,
    `Disponibilidad:       ${disponibilidad.toFixed(2)}%  (umbral: >=99%)`,
    `Latencia p95:         ${p95 !== null ? p95.toFixed(1) + ' ms' : 'n/d'}`,
    ok
      ? 'RESULTADO: OK — disponibilidad dentro de lo pedido por el Escenario 4'
      : 'RESULTADO: FALLÓ — revisa si alguna réplica se quedó caída fuera de los 10s de fail_timeout',
    '',
  ];
  return { stdout: lineas.join('\n') };
}
