"""Genera los tableros de Grafana (JSON) en la carpeta dashboards/ junto a este script."""
import json
import os

SALIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboards")
DS = {"type": "prometheus", "uid": "prometheus"}

_id = 0


def panel(titulo, tipo, exprs, x, y, w, h, unidad=None, descripcion=None, extra=None, leyendas=None):
    global _id
    _id += 1
    targets = []
    for i, e in enumerate(exprs):
        t = {"datasource": DS, "expr": e, "refId": chr(65 + i)}
        if leyendas:
            t["legendFormat"] = leyendas[i]
        if tipo in ("stat", "bargauge", "piechart"):
            t["instant"] = tipo != "stat" or (extra or {}).get("instant", False)
        targets.append(t)
    p = {
        "id": _id,
        "title": titulo,
        "type": tipo,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": targets,
        "fieldConfig": {"defaults": {}, "overrides": []},
        "options": {},
    }
    if descripcion:
        p["description"] = descripcion
    if unidad:
        p["fieldConfig"]["defaults"]["unit"] = unidad
    if tipo == "timeseries":
        p["fieldConfig"]["defaults"]["custom"] = {"lineWidth": 2, "fillOpacity": 12, "showPoints": "never"}
        p["options"] = {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}}
    if tipo == "stat":
        p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "background", "graphMode": "area", "textMode": "value_and_name"}
    if tipo == "bargauge":
        p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"]}, "orientation": "horizontal", "displayMode": "gradient", "showUnfilled": True}
    if extra:
        for k, v in extra.items():
            if k == "instant":
                continue
            if k == "defaults":
                p["fieldConfig"]["defaults"].update(v)
            else:
                p[k] = v
    return p


def tablero(uid, titulo, descripcion, paneles, variables=None):
    return {
        "uid": uid,
        "title": titulo,
        "description": descripcion,
        "tags": ["planazo"],
        "timezone": "America/Bogota",
        "refresh": "10s",
        "time": {"from": "now-1h", "to": "now"},
        "schemaVersion": 39,
        "editable": False,
        "templating": {"list": variables or []},
        "panels": paneles,
    }


ARRIBA_ABAJO = {
    "defaults": {
        "mappings": [{"type": "value", "options": {"0": {"text": "Caída", "color": "red"}, "1": {"text": "Arriba", "color": "green"}}}],
        "thresholds": {"mode": "absolute", "steps": [{"color": "red", "value": None}, {"color": "green", "value": 1}]},
    }
}

tecnico = tablero(
    "planazo-tecnico",
    "Planazo · Técnico",
    "Estado de cada instancia, latencias, errores, tiempo real, CPU/memoria y alertas (HU-134).",
    [
        panel("Estado de cada instancia", "stat", ['up{job!="prometheus"}'], 0, 0, 24, 5,
              descripcion="1 = responde a Prometheus; 0 = caída. Cada réplica por separado.",
              leyendas=["{{job}} · {{instance}}"], extra={**ARRIBA_ABAJO, "instant": True}),
        panel("Peticiones por segundo", "timeseries",
              ['sum by (service) (rate(http_request_duration_seconds_count[1m]))'], 0, 5, 12, 8, unidad="reqps",
              leyendas=["{{service}}"]),
        panel("Errores 5xx (%)", "timeseries",
              ['100 * sum by (service) (rate(http_request_duration_seconds_count{status=~"5.."}[5m])) / clamp_min(sum by (service) (rate(http_request_duration_seconds_count[5m])), 1e-9)'],
              12, 5, 12, 8, unidad="percent", leyendas=["{{service}}"],
              extra={"defaults": {"thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}, {"color": "red", "value": 5}]}, "custom": {"thresholdsStyle": {"mode": "line"}, "lineWidth": 2, "fillOpacity": 12, "showPoints": "never"}}}),
        panel("Latencia p50 / p95 por servicio", "timeseries",
              ['histogram_quantile(0.5, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))',
               'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))'],
              0, 13, 12, 8, unidad="s", leyendas=["p50 {{service}}", "p95 {{service}}"]),
        panel("Tiempo real: latencia publicación → entrega (p95)", "timeseries",
              ['histogram_quantile(0.95, sum by (le) (rate(planazo_evento_latencia_seconds_bucket[5m])))',
               'histogram_quantile(0.5, sum by (le) (rate(planazo_evento_latencia_seconds_bucket[5m])))'],
              12, 13, 12, 8, unidad="s", leyendas=["p95", "p50"],
              descripcion="Alerta si el p95 supera 300 ms (ESC-06).",
              extra={"defaults": {"thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}, {"color": "red", "value": 0.3}]}, "custom": {"thresholdsStyle": {"mode": "line"}, "lineWidth": 2, "fillOpacity": 12, "showPoints": "never"}}}),
        panel("Usuarios concurrentes (conexiones WebSocket)", "timeseries",
              ['sum by (instance) (planazo_ws_conexiones)', 'sum(planazo_ws_conexiones)'], 0, 21, 8, 8,
              leyendas=["realtime {{instance}}", "total"]),
        panel("CPU por instancia", "timeseries",
              ['sum by (service, instance) (rate(process_cpu_seconds_total[1m]))', 'sum by (service, instance) (process_cpu_usage)'],
              8, 21, 8, 8, unidad="percentunit", leyendas=["{{service}} {{instance}}", "{{service}} {{instance}}"]),
        panel("Memoria por instancia", "timeseries",
              ['sum by (service, instance) (process_resident_memory_bytes)', 'sum by (service, instance) (jvm_memory_used_bytes)'],
              16, 21, 8, 8, unidad="bytes", leyendas=["{{service}} {{instance}}", "{{service}} {{instance}} (JVM)"]),
        panel("Minijuego: duración del tick", "timeseries",
              ['rate(planazo_game_tick_seconds_sum[1m]) / clamp_min(rate(planazo_game_tick_seconds_count[1m]), 1e-9)', 'planazo_game_tick_seconds_max'],
              0, 29, 12, 8, unidad="s", leyendas=["promedio", "máximo"],
              descripcion="Cada tick debe caber de sobra en los 50 ms del periodo (RT-3)."),
        panel("Ataques detectados (IPs bloqueadas, 15 min)", "stat",
              ['sum(increase(planazo_ataques_detectados_total[15m])) or vector(0)'], 12, 29, 4, 8,
              extra={"defaults": {"thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}, {"color": "red", "value": 1}]}}}),
        panel("Alertas", "alertlist", [], 16, 29, 8, 8,
              extra={"options": {"showOptions": "current", "stateFilter": {"firing": True, "pending": True, "normal": True}, "alertInstanceLabelFilter": "", "datasource": "Prometheus", "maxItems": 10, "sortOrder": 1, "groupMode": "default", "viewMode": "list"}}),
    ],
)

ZONA = {
    "name": "zona",
    "label": "Zona",
    "type": "query",
    "datasource": DS,
    "query": {"query": "label_values(planazo_reservas_total, zona)", "refId": "zona"},
    "definition": "label_values(planazo_reservas_total, zona)",
    "includeAll": True,
    "multi": True,
    "allValue": ".*",
    "current": {"text": "All", "value": "$__all"},
    "refresh": 2,
}

negocio = tablero(
    "planazo-negocio",
    "Planazo · Negocio",
    "KPIs del business case: usuarios, sesiones, reservas por zona, cupones, partidas, agente y uso de la app (HU-133). Filtra por zona y por tiempo.",
    [
        panel("Usuarios activos (5 min)", "stat", ['sum(planazo_usuarios_activos) or vector(0)'], 0, 0, 4, 5, extra={"instant": True}),
        panel("Sesiones en el rango", "stat", ['sum(increase(planazo_sesiones_emitidas_total[$__range])) or vector(0)'], 4, 0, 4, 5, extra={"instant": True}),
        panel("Reservas en el rango", "stat", ['sum(increase(planazo_reservas_total{zona=~"$zona"}[$__range])) or vector(0)'], 8, 0, 4, 5, extra={"instant": True}),
        panel("Cupones entregados", "stat", ['sum(increase(planazo_cupones_reclamados_total{zona=~"$zona"}[$__range])) or vector(0)'], 12, 0, 4, 5, extra={"instant": True}),
        panel("Partidas jugadas", "stat", ['sum(increase(planazo_partidas_total[$__range])) or vector(0)'], 16, 0, 4, 5, extra={"instant": True}),
        panel("Consultas al agente", "stat", ['sum(increase(planazo_consultas_agente_total[$__range])) or vector(0)'], 20, 0, 4, 5, extra={"instant": True}),
        panel("Reservas por zona", "timeseries",
              ['sum by (zona) (increase(planazo_reservas_total{zona=~"$zona"}[5m]))',
               'sum by (zona) (increase(planazo_reservas_canceladas_total{zona=~"$zona"}[5m]))'],
              0, 5, 12, 8, leyendas=["reservas {{zona}}", "canceladas {{zona}}"]),
        panel("Cupones: entregados vs. rechazados", "timeseries",
              ['sum by (zona) (increase(planazo_cupones_reclamados_total{zona=~"$zona"}[5m]))',
               'sum by (motivo) (increase(planazo_cupones_rechazados_total[5m]))'],
              12, 5, 12, 8, leyendas=["entregados {{zona}}", "rechazados: {{motivo}}"],
              descripcion="PROMO_AGOTADA indica que la demanda superó el stock (CC-1)."),
        panel("Funcionalidades más usadas", "bargauge",
              ['sort_desc(sum by (funcionalidad) (increase(planazo_uso_funcionalidad_total[$__range])))'], 0, 13, 12, 9,
              leyendas=["{{funcionalidad}}"]),
        panel("Sesiones por modo", "piechart",
              ['sum by (modo) (increase(planazo_sesiones_emitidas_total[$__range]))'], 12, 13, 6, 9, leyendas=["{{modo}}"]),
        panel("Agente: quién armó el plan", "piechart",
              ['sum by (fuente) (increase(planazo_consultas_agente_total[$__range]))'], 18, 13, 6, 9, leyendas=["{{fuente}}"]),
        panel("Minijuego en vivo", "timeseries",
              ['sum(planazo_salas_en_curso)', 'sum(planazo_jugadores_en_salas)'], 0, 22, 12, 8,
              leyendas=["salas en partida", "jugadores en salas"]),
        panel("Tiempo promedio por interacción", "timeseries",
              ['sum by (service) (rate(http_request_duration_seconds_sum[5m])) / clamp_min(sum by (service) (rate(http_request_duration_seconds_count[5m])), 1e-9)'],
              12, 22, 12, 8, unidad="s", leyendas=["{{service}}"],
              descripcion="Cuánto tarda en promedio cada interacción del usuario con la app, por servicio."),
        panel("Promociones lanzadas", "timeseries",
              ['sum by (zona) (increase(planazo_promos_lanzadas_total{zona=~"$zona"}[15m]))'], 0, 30, 12, 7, leyendas=["{{zona}}"]),
        panel("Reservas rechazadas por motivo (CC-3)", "bargauge",
              ['sum by (motivo) (increase(planazo_reservas_rechazadas_total[$__range]))'], 12, 30, 12, 7, leyendas=["{{motivo}}"]),
    ],
    variables=[ZONA],
)

os.makedirs(SALIDA, exist_ok=True)
for nombre, t in (("tecnico.json", tecnico), ("negocio.json", negocio)):
    with open(os.path.join(SALIDA, nombre), "w", encoding="utf-8") as f:
        json.dump(t, f, ensure_ascii=False, indent=2)
        f.write("\n")
print("ok", len(tecnico["panels"]), len(negocio["panels"]))
