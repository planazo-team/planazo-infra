# Escenario 4 · Disponibilidad — Escalamiento horizontal y tolerancia a fallos

> Tomado de `Escenarios de Calidad - Planazo Sprint 2.docx` (responsable: Juan
> Diego Melo). Reproducido aquí tal como quedó redactado, más la parte de
> "cómo correrlo" y las decisiones tomadas al implementarlo.

**Atributo:** Disponibilidad. **Táctica:** Redundancia activa, balanceo de
carga, detección de fallos (health checks) y reintento.

- **Fuente del estímulo:** Un fallo interno — una instancia de un servicio
  deja de funcionar (caída del proceso o del contenedor).
- **Estímulo:** La instancia deja de responder mientras atiende tráfico.
- **Artefacto:** Balanceador de carga (Nginx) y las instancias redundantes
  del backend (**api-gateway, booking, promo y realtime**).
- **Ambiente:** Carga pico — 300 usuarios concurrentes, con al menos 2
  instancias activas de cada servicio detrás de su balanceador.
- **Respuesta:** El balanceador detecta la falla, saca la instancia de
  rotación y reparte el tráfico entre las sanas; la instancia caída se
  reinicia. Los clientes WebSocket afectados reconectan solos y, con
  RESUME, reciben los eventos que se perdieron.
- **Medida de respuesta:** Tasa de error <1% durante la prueba; instancia
  fuera de rotación en ≤10s; reconexión WebSocket en ≤5s; 0 eventos
  perdidos/duplicados; disponibilidad ≥99% durante la ventana de prueba.
- **Cómo se demuestra:** Prueba de caos con k6 que tumba una instancia a
  media carga y mide tasa de error, tiempo fuera de rotación y reconexión.

## Qué NO entra en esta pasada (y por qué)

- **El Minijuego (`planazo-game`) no se replica.** Su estado (`SalaRuntime`)
  vive en memoria de un único proceso por sala, sin ninguna coordinación
  entre instancias — replicarlo sin resolver eso rompería las partidas en
  curso. La decisión de diseño (sticky sessions vs. Redis Pub/Sub para el
  estado de juego) queda documentada en
  [`planazo-game/ARQUITECTURA.md`](../planazo-game/ARQUITECTURA.md), sección
  "Escalamiento horizontal".
- **Railway (producción real) no se toca en esta pasada.** Todo lo de abajo
  es el prototipo local — levantarlo en Railway implica tráfico y costos
  reales, así que es un paso aparte, con confirmación explícita.
- **El Escenario 3 de Seguridad** (rate-limit por IP en Redis para
  api-gateway) es un prerrequisito para que el rate-limit siga siendo
  correcto con 2+ réplicas (hoy es en memoria, por proceso), pero es harina
  de otro costal — no se toca aquí.
- **El Escenario 6 de Rendimiento** (k6 de 500 conexiones WebSocket,
  comparando 1 vs. 2 instancias de `realtime`) tampoco es parte de esta
  pasada, aunque el fix de abajo es justo su prerrequisito.

## Decisión: un balanceador de carga por repo, no uno compartido

Cada uno de los 4 servicios (api-gateway, booking, promo, realtime) trae su
**propio** `docker-compose.yml` + `nginx.conf` en la raíz de su propio repo:
dos réplicas de sí mismo + un Nginx que las balancea, publicado en el mismo
puerto de siempre (8080/3001/3002/8081). Nada fuera de esos 4 repos nota la
diferencia: los mismos puertos, las mismas URLs.

`planazo-infra` ya no construye esos 4 servicios — solo las bases de datos,
Redis, `game` (sin replicar) y la red compartida `planazo-net`, a la que los
4 repos se conectan (`external: true`). `scripts/up-all.sh`/`down.sh` ya
hacen el recorrido por los 4 repos por ti.

**Por qué esto funciona sin tocar código de negocio** (verificado leyendo el
código, no por suposición):
- **booking**: `PgBookingStore` (lock optimista por `version`,
  inicialización con `pg_advisory_lock`) ya se activa solo con
  `DATABASE_URL`.
- **promo**: stock (CC-1) en Redis con script Lua atómico
  (`RedisStockStore`); promos/cupones en `PgPromoRepo` (también con
  `pg_advisory_lock`).
- **api-gateway**: proxy sin estado. Su rate-limit por IP es en memoria
  (por proceso) — limitación conocida, no rompe nada aquí, pero hay que
  resolverla para el Escenario 3.
- **realtime**: fan-out por Redis pub/sub + `seq` global real (columna
  autoincremental en Postgres). Tenía un bug real que SÍ bloqueaba
  escalarlo — ver abajo.

### El fix que hizo falta en `realtime` antes de poder replicarlo

En `src/realtime/realtime.gateway.ts`, método `guardarYDifundir`: el bus
(Redis pub/sub) entrega cada evento a **todas** las instancias suscritas.
Cuando dos instancias reciben el mismo evento y ambas intentan
`prisma.event.create` con el mismo `id`, la que pierde la carrera del
INSERT (`P2002`, `events.id` es `@unique`) **ignoraba el error y no
difundía nada a sus propios clientes conectados**. Con una sola instancia
esto nunca se nota; con 2+, ~la mitad de las entregas en vivo de eventos
persistidos (`PROMO.PUSH`, `PLACE.UPDATE`, justo lo que mide el Escenario
6) se habrían perdido para los clientes conectados a la instancia que
perdió la carrera — solo las recuperarían al reconectar con RESUME.

El fix: en el `catch` de `P2002`, se busca la fila que sí quedó guardada
(`findUnique` por `id`) y se difunde igual, con su `seq` real — pero solo
si esta instancia no la difundió ya ella misma (hay un registro acotado de
`id`s ya difundidos por instancia, para no duplicarle el evento a un
cliente que ya lo recibió por el camino feliz). Test de regresión:
`realtime.gateway.spec.ts`, caso "escalado horizontal: la instancia que
pierde la carrera del INSERT igual difunde a sus propios clientes".

### Salud pasiva, no activa

El `nginx.conf` de cada repo usa `max_fails=1 fail_timeout=10s` en el
`upstream`: es salud **pasiva** (Nginx libre, sin plan Plus) — una réplica
que falla una vez queda fuera de rotación 10s, que es exactamente la
medida de respuesta pedida. Salud **activa** (probar la réplica
periódicamente aunque no reciba tráfico) requeriría Nginx Plus o un módulo
extra tipo OpenResty; no hizo falta para cumplir la medida tal como está
redactada.

### Lo que se pierde al partir en 4 `docker-compose.yml` independientes

`depends_on` ya no puede cruzar de un compose a otro: las réplicas de un
servicio ya no esperan formalmente a que su Postgres/Redis (en
`planazo-infra`) estén healthy antes de arrancar — solo se garantiza si
`planazo-infra` ya estaba arriba primero (el flujo normal con
`scripts/up-all.sh`). Es el costo real de la autonomía por repo, y es
coherente con cómo se comportaría en producción: servicios independientes
que reintentan conexión, no que se bloquean entre sí.

## Cómo correr el prototipo

```bash
# 1. Infra compartida (bases de datos, Redis, game, red planazo-net)
cd planazo-infra
scripts/up.sh            # o: docker compose --profile app up --build -d

# 2. Los 4 servicios, cada uno con sus 2 réplicas + su balanceador
scripts/up-all.sh        # hace el loop por los 4 repos hermanos
```

## Cómo demostrarlo

```bash
# Ver que el balanceo reparte tráfico entre las 2 réplicas (repetir varias veces):
curl -i http://localhost:3001/health | grep -i x-upstream

# Prueba de carga simple (sin tumbar nada):
k6 run k6/esc04-disponibilidad.js

# Prueba de caos completa: carga sostenida + tumbar una réplica a mitad de camino + restaurarla
scripts/demo-disponibilidad.sh booking 1 45
```

`scripts/demo-disponibilidad.sh` arranca k6 contra el balanceador del
servicio elegido, a 1/3 de la prueba apaga la réplica indicada
(`docker stop planazo-<servicio>-<N>`), espera la ventana de
`fail_timeout`, la restaura (`docker start`) y al final muestra el resumen
de k6 (tasa de error, disponibilidad, latencia p95).

Para la reconexión WebSocket sin pérdida ni duplicados (parte de la medida
de respuesta), reutiliza la prueba que ya existía para esto:

```bash
k6 run k6/rt2-reconnect.js   # apunta a ws://localhost:8081/ws — ahora son 2 réplicas de realtime detrás de su balanceador
```
