# Observabilidad (Feature 10.4)

Prometheus y Grafana propios, desplegados como dos servicios más en Railway.

```
gateway ×2 ┐
booking ×2 ├─ :9464/metrics (red privada) ──▶ planazo-prometheus :9090 ──▶ planazo-grafana :3000 (dominio público, solo lectura)
promo   ×2 │                                   (alertas.yml)
realtime×2 │
game       ┘
```

- **Métricas**: cada instancia publica `/metrics` en el puerto **9464**, que no tiene dominio público. Prometheus las recoge cada 10 s por `*.railway.internal` y etiqueta cada serie con `service` e `instance`, así se distingue cada réplica.
- **Tablero técnico** (`dashboards/tecnico.json`): estado de cada instancia, peticiones/s, errores 5xx, latencia p50/p95, latencia de tiempo real, conexiones WebSocket, CPU y memoria por instancia, duración del tick del Minijuego, ataques detectados y alertas.
- **Tablero de negocio** (`dashboards/negocio.json`): usuarios activos, sesiones, reservas por zona, cupones entregados y rechazados, partidas, consultas al agente, funcionalidades más usadas y tiempo promedio por interacción. Tiene filtros por zona y por tiempo.
- **Alertas** (`prometheus/alertas.yml`): errores > 5 %, instancia caída, latencia RT p95 > 300 ms y ataque detectado.

## Railway

| Servicio | Root directory | Puerto | Dominio |
|---|---|---|---|
| `planazo-prometheus` | `observabilidad/prometheus` | 9090 | ninguno (privado) |
| `planazo-grafana` | `observabilidad/grafana` | 3000 | público |

Grafana entra sin cuenta en modo **solo lectura**: no hay formulario de login ni autenticación básica, y los tableros vienen del repo (`allowUiUpdates: false`). Para cambiar un tablero se edita `grafana/generar_tableros.py`, se corre `python generar_tableros.py dashboards` y se vuelve a desplegar.

## Métricas por servicio

| Servicio | Métricas propias |
|---|---|
| api-gateway | `planazo_sesiones_emitidas_total{modo}`, `planazo_usuarios_activos`, `planazo_consultas_agente_total{fuente}`, `planazo_uso_funcionalidad_total{funcionalidad}`, `planazo_ataques_detectados_total` |
| booking | `planazo_reservas_total{zona}`, `planazo_reservas_canceladas_total{zona}`, `planazo_reservas_rechazadas_total{motivo,donde}` |
| promo | `planazo_cupones_reclamados_total{zona}`, `planazo_cupones_rechazados_total{motivo}`, `planazo_promos_lanzadas_total{zona}` |
| realtime | `planazo_ws_conexiones`, `planazo_eventos_entregados_total{tipo}`, `planazo_evento_latencia_seconds` |
| game | `planazo_salas_en_curso`, `planazo_salas_ocupadas`, `planazo_jugadores_en_salas`, `planazo_partidas_total{motivo}`, `planazo_game_tick_seconds` |

Todos publican además `http_request_duration_seconds{method,route,status}` y las métricas de proceso (CPU, memoria; en game, las de la JVM).
