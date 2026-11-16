FROM prom/prometheus:v2.55.1
COPY prometheus.yml /etc/prometheus/prometheus.yml
COPY alertas.yml /etc/prometheus/alertas.yml
# La imagen oficial ya corre sin privilegios; se declara explícito.
USER nobody
# Sin dominio público: Grafana lo consulta por la red privada de Railway.
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=7d", "--web.listen-address=:9090"]
