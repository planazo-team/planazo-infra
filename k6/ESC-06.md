# ESC-06 · Latencia del tiempo real con 500 clientes

Prueba de carga que demuestra el escenario de rendimiento **ESC-06** del Sprint 2: `k6/esc06-latencia-tiempo-real.js`.

| Parte del escenario | Valor |
|---|---|
| **Fuente** | Un negocio (`b1`, dueño de `p7`, Bar El Zaguán, Zona T). |
| **Estímulo** | Lanza promociones y cambia el cupo de una franja: cada acción publica `PROMO.PUSH` o `PLACE.UPDATE` en el bus `planazo.events` con el topic `zone:zona-t`. |
| **Artefacto** | `realtime` (bus Redis → Postgres → WebSocket), alimentado por `promo` y `booking`. |
| **Entorno** | Operación normal con **500 clientes WebSocket** suscritos a `zone:zona-t`. |
| **Respuesta** | Cada evento llega a todos los clientes suscritos. |
| **Medida** | Latencia publicación → entrega **p95 ≤ 300 ms** y **p99 ≤ 500 ms**, **0 eventos perdidos**, **errores < 1 %**. |

## Cómo mide

1. `booking` y `promo` ponen `emittedAt` (epoch ms) en el sobre del evento justo al publicarlo en el bus. `realtime` lo entrega intacto en cada `EVENT` en vivo (contrato: `contracts/events.schema.json` y `contracts/realtime.md`). El campo `at` no sirve para esto: `realtime` lo reemplaza por el instante en que guarda el evento.
2. Cada uno de los 500 clientes calcula, por cada evento de la prueba que recibe, `ahora − emittedAt`. Eso da **`esc06_latencia_ms`**, la medida del escenario.
3. El negocio hace 20 rondas, una por segundo. En cada una lanza una promo (un `PROMO.PUSH`) y sube o baja en 1 el cupo de la primera franja de `p7` (un `PLACE.UPDATE`). Al final el cupo queda como estaba.
4. Cada cliente sabe cuántos eventos le tienen que llegar y cuenta los que recibe. La diferencia es **`esc06_eventos_perdidos`**. Los duplicados se descartan por `id`, como hace el frontend.
5. Cada socket que no abre o que el servidor cierra antes de tiempo, y cada `POST`/`PATCH` del negocio que falla, suma a **`esc06_errores`**.

Para reconocer sus eventos entre el tráfico real, la prueba pone en el título de cada promo `ESC-06 <run> #<ronda> t=<ms>`. Los `PLACE.UPDATE` se reconocen por `placeId = p7`.

### El reloj: lo que hay que decir en el reporte

`ahora − emittedAt` compara el reloj del servidor que publica (Railway) con el del computador que corre k6. Si el computador está adelantado o atrasado, la latencia sale corrida en esa misma cantidad. Por eso:

- **Antes de correr la prueba, sincroniza la hora** del computador. En Windows: *Configuración → Hora e idioma → Sincronizar ahora*, o `w32tm /resync` en una consola de administrador. En Linux y macOS ya se sincroniza solo por NTP.
- La prueba también mide **`esc06_latencia_e2e_ms`**: el negocio escribe en el título de la promo la hora de k6 en que manda el `POST`, y el cliente calcula `ahora − esa hora` con el mismo reloj. Así el desfase no afecta la medida. Este número incluye además el viaje HTTP hasta `promo` (a través del gateway), así que es una **cota superior**: si la e2e cumple 300/500 ms, la latencia publicación → entrega también cumple. Solo existe para `PROMO.PUSH`.
- Si `esc06_latencia_ms` sale **negativa** o mucho menor que la e2e, el reloj local está desfasado. Repórtalo y usa la e2e como evidencia.

## Correrla en local

Necesitas [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (`winget install GrafanaLabs.k6`), la infraestructura arriba (`scripts/up.sh`: Postgres y Redis) y los servicios `api-gateway` (8080), `booking`, `promo` y `realtime` (8081) corriendo **con la versión que trae `emittedAt`**. Los cuatro tienen que compartir el mismo `BUS_URL`, y el gateway y `realtime` el mismo `JWT_SECRET`.

```bash
# humo: 20 clientes, 5 rondas, rampa corta (unos 15 s)
k6 run -e CONEXIONES=20 -e RONDAS=5 -e RAMPA_S=3 -e CALENTAR_S=2 k6/esc06-latencia-tiempo-real.js

# el escenario completo: 500 clientes, 20 rondas (alrededor de 1 minuto)
k6 run k6/esc06-latencia-tiempo-real.js
```

Si los servicios corren en otros puertos, pasa `-e BASE_URL=http://localhost:<gateway>` y `-e REALTIME_URL=ws://localhost:<realtime>/ws`.

## Correrla contra producción (Railway)

> Antes de correrla, confirma con el equipo: la prueba lanza 20 promos reales de `p7` (duran 2 minutos, título `ESC-06 …`) y mueve un cupo de `p7` arriba y abajo. Lo deja como estaba, pero quien esté mirando el mapa lo verá.

```bash
k6 run \
  -e BASE_URL=https://planazo-api-gateway-production.up.railway.app \
  -e REALTIME_URL=wss://planazo-realtime-production.up.railway.app/ws \
  -e RESUMEN_JSON=k6-results/esc06-produccion.json \
  k6/esc06-latencia-tiempo-real.js
```

- **Login demo con llave.** Si el gateway tiene `DEMO_LOGIN_KEY` definida, `POST /api/auth/demo` exige el header `x-demo-key`. Agrega `-e DEMO_KEY=<valor de DEMO_LOGIN_KEY>`. Sin esa variable la prueba hace el login como siempre. Si el login demo está apagado, pasa los tokens directamente: `-e TOKEN_NEGOCIO=<jwt de b1> -e TOKENS_CLIENTES=<jwt1>,<jwt2>`.
- **Rate limit.** Los 500 sockets van directo a `realtime`, que no tiene rate limit. Al gateway solo llegan 7 logins (`u1..u6` y `b1`, los tokens se reparten entre los sockets), un `GET` y unas 40 peticiones del negocio. Cabe en cualquier límite.
- **Desde dónde correrla.** k6 con 500 sockets usa poca CPU, pero conviene una red estable: la latencia de tu conexión entra en la medida. Corre la prueba por cable o con buen wifi, y no en una red de datos.
- `mkdir k6-results` antes de usar `RESUMEN_JSON` (la carpeta está en `.gitignore`).

## Variables

| Variable | Default | Para qué |
|---|---|---|
| `BASE_URL` | `http://localhost:8080` | API Gateway. |
| `REALTIME_URL` | `ws://localhost:8081/ws` | WebSocket de `realtime`. |
| `CONEXIONES` | `500` | Clientes suscritos. |
| `ZONE` / `NEGOCIO` / `PLACE_ID` | `zona-t` / `b1` / `p7` | Topic y quién publica. Tienen que ser coherentes: `b2`→`p1` está en `zona-g`. |
| `CLIENTES` | `u1,…,u6` | Usuarios semilla cuyos tokens se reparten entre los sockets. |
| `DEMO_KEY` (o `DEMO_LOGIN_KEY`) | — | Valor del header `x-demo-key` para el login demo. |
| `TOKEN_NEGOCIO`, `TOKENS_CLIENTES` | — | Tokens ya emitidos; si están, la prueba no hace login. |
| `RAMPA_S` | `30` | Segundos para abrir todas las conexiones, escalonadas. |
| `CALENTAR_S` | `5` | Pausa con todos conectados antes de publicar. |
| `RONDAS` / `INTERVALO_S` | `20` / `1` | Rondas de publicación y separación entre ellas. |
| `GRACIA_S` / `ESPERA_MAX_S` | `5` / `20` | Escucha después de la última ronda y tope extra para eventos que no llegan. |
| `DURACION_PROMO_S` | `120` | Duración de las promos lanzadas (mínimo 10). |
| `SIN_PLACE_UPDATE=1` | — | Solo `PROMO.PUSH`, sin tocar el cupo. |
| `RESUMEN_JSON` | — | Guarda el resumen completo de k6 en ese archivo. |

## Cómo leer el resultado para el reporte

Al final k6 imprime su tabla de métricas y después un bloque así. Este es de una corrida en local el 10 de noviembre de 2026: los 500 clientes y las 20 rondas por defecto, con los servicios en el mismo computador, así que casi no hay red de por medio:

```
=== ESC-06 · Latencia publicación → entrega (zone:zona-t) ===
Conexiones abiertas:         500 de 500   cierres inesperados: 0
Publicados por el negocio:   40 (PROMO.PUSH + PLACE.UPDATE) en 20 rondas
Entregas esperadas:          20000
Entregas recibidas:          20000   perdidas: 0   duplicadas: 0
Latencia (ahora − emittedAt) p50 43.0 ms · p95 87.0 ms · p99 137.0 ms · máx 148.0 ms   [meta p95 ≤ 300, p99 ≤ 500]
Latencia e2e (desde el POST) p50 35.0 ms · p95 77.0 ms · p99 112.0 ms   [cota superior, mismo reloj]
Tasa de errores:             0.00 %   [meta < 1 %]
Eventos sin emittedAt:       0
RESULTADO: CUMPLE ESC-06
```

*Entregas esperadas* = clientes conectados × eventos publicados (500 × 40). En producción se suma la latencia de internet entre Railway y tu computador.

| Threshold | Qué significa | En el reporte |
|---|---|---|
| `esc06_latencia_ms: p(95)<300, p(99)<500` | Latencia publicación → entrega de todas las entregas (500 clientes × eventos). | La medida del escenario: copia p50, p95, p99 y máx. |
| `esc06_latencia_ms{tipo:PROMO.PUSH}` / `{tipo:PLACE.UPDATE}` | Lo mismo, separado por tipo de evento. | Muestra que se cumple para los dos tipos de evento. |
| `esc06_eventos_perdidos: count==0` | Entregas esperadas menos entregas recibidas, cliente por cliente. | «0 eventos perdidos». Copia también *esperadas* y *recibidas*. |
| `esc06_eventos_recibidos: count>0` | Llegó al menos un evento. | Evita que una corrida vacía pase porque no hubo latencias que medir. |
| `esc06_errores: rate<0.01` | Sockets que no abrieron o se cayeron, y peticiones del negocio que fallaron. | «Errores < 1 %». |
| `esc06_sin_emitted_at: count==0` | Eventos que llegaron sin `emittedAt`. | Tiene que ser 0. Si no, alguno de los servicios desplegados todavía no tiene el cambio. |

k6 termina con código ≠ 0 si algún threshold falla, y lo marca con ✗ en la tabla. Para la evidencia guarda la salida completa (`k6 run … | tee k6-results/esc06.txt`), el JSON de `RESUMEN_JSON` y una captura del bloque final. En el reporte incluye también la fecha, el entorno (local o Railway), desde qué red se corrió y si el reloj estaba sincronizado.

**Si no cumple**, estas son las causas más probables:

- **Muchos `cierres inesperados`**: Railway o `realtime` cortaron sockets. Mira los logs de `realtime`.
- **Perdidas > 0 con 0 cierres**: el bus entregó el evento pero `realtime` no lo difundió. Busca `Error procesando` en el log de `realtime`.
- **p99 alto y p50 bajo**: la cola de `realtime` es serial (`guardarYDifundir` guarda cada evento en Postgres antes de difundirlo), así que una escritura lenta retrasa a los eventos que vienen detrás.
