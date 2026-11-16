FROM grafana/grafana:11.3.1

# Tableros de solo lectura: se entra sin cuenta (rol Viewer) y no hay formulario
# de login ni autenticación básica, así que nadie puede entrar como admin ni
# cambiar nada desde la web. Los tableros y el origen de datos vienen del repo.
ENV GF_AUTH_ANONYMOUS_ENABLED=true \
    GF_AUTH_ANONYMOUS_ORG_NAME="Main Org." \
    GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
    GF_AUTH_DISABLE_LOGIN_FORM=true \
    GF_AUTH_BASIC_ENABLED=false \
    GF_USERS_ALLOW_SIGN_UP=false \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    GF_NEWS_NEWS_FEED_ENABLED=false \
    GF_SERVER_HTTP_PORT=3000 \
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/etc/grafana/dashboards/tecnico.json \
    PROMETHEUS_URL=http://planazo-prometheus.railway.internal:9090

COPY provisioning /etc/grafana/provisioning
COPY dashboards /etc/grafana/dashboards

EXPOSE 3000
