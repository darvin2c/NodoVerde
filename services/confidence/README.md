# terra-confidence — Termómetro de confianza por módulo (ADR-0010)

Servicio `services/confidence/` que calcula la **confianza graduada** por módulo para el cerebro observador (Fase 1). Cálculo **determinístico**, nunca LLM. Es el freno de mano del sistema: el portero exige confianza mínima antes de actuar.

## Qué es

Cada dato del campo lleva **fuente, frescura y confianza**. El servicio combina lecturas frescas con el decaimiento por edad para exponer un gauge por módulo en HA/Grafana y en el reporte diario por chat.

- **Por variable**: `base_fuente × 0.5^(edad/semivida)`. Base: sensor en vivo = `min(95, confianza_del_dispositivo)` (el sim publica `confidence/confidence` por dispositivo que decae con deriva — sensores mienten, nunca 100), foto = 75, reporte humano = 65, sin dato = 0 (ausencia ≠ dato cero).
- **Global por módulo**: promedio ponderado con pesos `ec 3, ph 3, temp 2, level 2, flow 1, air_temp 1, humidity 1, photo 1`. Semividas: `level 10 min, flow 5 min, temp/air_temp/humidity 30 min, ec/ph 2 h, photo 6 h` (desconocida → 1 h). Nunca 100, redondeo a 1 decimal.

Plano plataforma (4 segmentos, distinguible de 5 seg dispositivo y 6 seg interno):

```
Publica: terra/{tenant}/{module}/confidence   (retain, qos1)
Payload: { v: number 0-100, ts: epoch_ms, sources: { ec?:number, ph?:number, ... } }
Suscribe (plano interno, 6 seg):
  terra/{tenant}/{module}/{device}/{metric}/reading
  terra/{tenant}/{module}/{device}/confidence/confidence   (para baseOverride)
  terra/{tenant}/{module}/{device}/status/status           (defensivo)
```

Cero actuación: jamás publica a `cmd` ni a `request/`.

## Flujos

### 1. Ingesta

Suscribe `terra/+/+/+/+/reading` con `qos1`, más `terra/+/+/+/confidence/confidence` y `terra/+/+/+/status/status`. Por cada `reading` guarda `{ts, device}` por `(tenant, módulo, métrica)`; por cada `confidence` guarda `baseOverride` por `(tenant, módulo, device)`. Parse defensivo: JSON inválido o `ts` ausente → `Date.now()`.

### 2. Cálculo

En cada tick (`PUBLISH_INTERVAL_MS`, default 15000) y también **al vuelo** si el cambio supera 5 puntos:

1. Para cada módulo conocido (DB `modules`, refresco cada 60 s) y para cada métrica esperada (`ec, ph, temp, level, flow, air_temp, humidity, photo`) resuelve `variableConfidence({source, metric, publishedAtMs, nowMs, baseOverride})` con `nowMs = Date.now()`. Métrica sin dato → `publishedAtMs = null → 0`.
2. Agrega con `moduleConfidence(perVariable)` → `v` global.
3. Publica `terra/{tenant}/{module}/confidence` con `{v, ts: nowMs, sources: {metric: conf}}`, `retain=true`, `qos1`.

### 3. Descubrimiento de módulos

Lee `SELECT tenant, id FROM modules` al arrancar y cada 60 s. Un módulo nuevo aparece sin restart.

## Env

| Variable | Default | Descripción |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | Broker Mosquitto |
| `DATABASE_URL` | `postgres://terra:changeme@localhost:5432/terra` | DSN TimescaleDB (tabla `modules`) |
| `PUBLISH_INTERVAL_MS` | `15000` | Cadencia de recomputo y publicación periódica |

## Desarrollo

```bash
pnpm install
pnpm dev       # tsx src/index.ts — conecta a MQTT + Postgres
pnpm test      # vitest run — termómetro puro (sin broker ni DB)
pnpm exec tsc --noEmit
```

Lógica pura en `src/thermometer.ts` (inyecta `nowMs` para determinismo). `src/index.ts` solo orquesta MQTT/DB y publica el gauge.

Shutdown limpio en `SIGINT`/`SIGTERM` (cierra MQTT y pool `pg`, limpia timers).

## Referencias

- ADR-0010: *Conocimiento graduado, acciones manuales y termómetro de confianza*.
- Contrato: `contract/asyncapi.yaml` — canal plataforma `terra/{tenant}/{module}/confidence` (v0.5.0, Fase 1).
- DB: `infra/db/init.sql` + migración `02` Fase 1 (`confidence_history`, `alerts`).

