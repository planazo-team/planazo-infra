# Escenario 5 · Mantenibilidad — Inspección continua con análisis estático

> Tomado de `Escenarios de Calidad - Planazo Sprint 2.docx` (responsable: Juan
> Camilo Melo). Reproducido aquí tal como quedó redactado, más la parte de
> "cómo correrlo" y el paso manual que falta para activarlo de verdad.

**Atributo:** Mantenibilidad. **Táctica:** Inspección continua (análisis
estático en el pipeline de CI).

- **Fuente del estímulo:** Un desarrollador del equipo.
- **Estímulo:** Abre un pull request hacia `main` en cualquiera de los 7
  repositorios de Planazo.
- **Artefacto:** Pipeline de CI (GitHub Actions, `ci.yml` de cada repo) con
  el análisis de SonarCloud integrado.
- **Ambiente:** Flujo normal de desarrollo, antes de fusionar el cambio.
- **Respuesta:** El pipeline compila, corre las pruebas con reporte de
  cobertura (lcov en TypeScript, JaCoCo en Java) y corre el análisis
  estático de SonarCloud. El resultado del Quality Gate se publica en el
  pull request y bloquea la fusión si falla.
- **Medida de respuesta:** 100% de los PR analizados antes de fusionarse, en
  ≤10 min; calificación A en confiabilidad/seguridad/mantenibilidad;
  cobertura ≥80% backend / ≥40% frontend; duplicación ≤3%.
- **Cómo se demuestra:** PR de prueba que introduce un code smell crítico y
  baja la cobertura; se verifica que el Quality Gate lo bloquea.

## Qué ya quedó listo en código (esta pasada)

Mismo patrón en los 7 repos: un paso `SonarCloud` en `ci.yml`, condicionado a
que exista el secret `SONAR_TOKEN` (`if: ${{ secrets.SONAR_TOKEN != '' }}`)
para que el pipeline **no se rompa** mientras el proyecto no esté creado en
sonarcloud.io. Usa la acción oficial `SonarSource/sonarqube-scan-action@v4`
(o el plugin Maven en Java), apuntando a `https://sonarcloud.io`.

| Repo | Cobertura que reporta | Detalle |
|---|---|---|
| `planazo-game` | JaCoCo (`target/site/jacoco/jacoco.xml`) | Se agregó el plugin `jacoco-maven-plugin` al `pom.xml` (no existía). Verificado con `mvn verify`: genera el reporte. |
| `planazo-booking` | lcov (`coverage/lcov.info`) | `npm test` ahora corre con `--coverage`; se agregó `coverageReporters: ["lcov","text"]` al bloque `jest` de `package.json`. 40/40 pruebas, cobertura actual ≈58%. |
| `planazo-promo` | lcov (`coverage/lcov.info`) | Igual que booking. 30/30 pruebas. |
| `planazo-realtime` | lcov (`coverage/lcov.info`) | Igual que booking. 24/24 pruebas (incluye el test de regresión del fan-out del Escenario 4). |
| `planazo-api-gateway` | Ninguna todavía | **Este repo no tiene pruebas** (`package.json` no tenía ni `test` ni `jest`). El paso de Sonar igual corre y reporta code smells/duplicación, pero la cobertura saldrá en 0% hasta que se agreguen pruebas — eso es un trabajo aparte, no algo que este cambio resuelva. |
| `planazo-infra` | Ninguna (no aplica) | No es un servicio de aplicación; Sonar analiza `scripts/` y `k6/` (bash y JS) por code smells/duplicación, sin cobertura. |

Cada repo tiene además su `sonar-project.properties` (sources, tests,
exclusiones, ruta del lcov) — `sonar.organization` y `sonar.projectKey` se
pasan como `-D` desde `ci.yml`, leyendo los secrets, así que el `.properties`
no tiene que cambiar por repo ni por organización.

## Lo que falta — y que SOLO se puede hacer desde fuera del código

Esto es trabajo manual en sonarcloud.io y GitHub; ningún cambio de código
puede hacerlo por sí mismo:

1. **Crear la cuenta/organización en SonarCloud** — en <https://sonarcloud.io>,
   "Log in with GitHub", autorizar, y crear una organización ligada al
   usuario o a `planazo-team` (gratis para repos públicos).
2. **Crear un proyecto por repositorio** (o importarlos todos de una vez
   desde GitHub) — 7 proyectos: `planazo-game`, `planazo-infra`,
   `planazo-api-gateway`, `planazo-booking`, `planazo-promo`,
   `planazo-realtime`, `planazo-frontend`.
3. **Generar un token** — My Account → Security → Generate Token. Un único
   token sirve para los 7 repos si se analizan como "GitHub Actions" (no
   hace falta uno por proyecto).
4. **Guardar los secrets en GitHub**, idealmente a nivel de organización
   (`github.com/organizations/planazo-team/settings/secrets/actions`) para
   no repetirlo 7 veces — si no hay permisos de org, se repite por repo en
   `Settings → Secrets and variables → Actions`:
   - `SONAR_TOKEN` — el token del paso 3.
   - `SONAR_ORGANIZATION` — la key de la organización (paso 1).
   - `SONAR_PROJECT_KEY` — opcional; si no se define, cada `ci.yml` usa el
     nombre del repo por defecto (`planazo-booking`, etc.), que es exactamente
     la convención que SonarCloud usa al importar desde GitHub.
5. **`planazo-frontend` queda pendiente aparte** — ese repo no está clonado
   en este entorno de trabajo, así que no se pudo tocar su `ci.yml` desde
   aquí; hay que replicarle el mismo patrón (test con cobertura + paso de
   Sonar) directamente en su propio checkout.
6. **(Opcional) Activar el Quality Gate como check obligatorio** — en GitHub,
   `Settings → Branches → Branch protection rules` para `main`: marcar
   "SonarCloud Code Analysis" como required status check. Sin esto, Sonar
   analiza pero no bloquea el merge — la medida de respuesta del escenario
   pide que si bloquee.

## Por qué no se intentó automatizar lo anterior

Crear la cuenta, el token y los secrets requiere iniciar sesión con las
credenciales de GitHub del equipo — ninguna herramienta de este asistente
puede ni debe hacer eso por la cuenta de otra persona. Es la única parte de
este escenario que es trabajo manual, de una sola vez, y toma unos 10
minutos siguiendo los 4 primeros pasos de arriba.

## Bono de cobertura (PDF del Sprint 2)

Si las métricas llegan a A/Verde y la cobertura a ≥40% frontend / ≥80%
backend, hay 0.5 puntos extra. Con los números actuales (`booking` ≈58%,
el resto sin medir todavía) **no se alcanza el bono por ahora**: subir la
cobertura de los servicios NestJS y, sobre todo, escribir las primeras
pruebas de `api-gateway` (hoy en 0%) es lo que más rápido movería esa
cifra.
