# terra-watchdog — Salud de dispositivos (ADR-0015 + Fase 1)

Servicio `services/watchdog/` que observa el **plano interno** (6 segmentos) y publica salud por módulo en el **plano plataforma** (4 segmentos). Dueño único de salud + verificación cruzada; en Fase 1 **solo salud** (cero actuación).

## Qué hace

Consume lecturas y LWT del plano interno (traducidas por el router desde el plano dispositivo) y deriva:

- Estado por dispositivo: `ok` | `silence` | `frozen` | `impossible` | `offline`
- Estado por módulo: `ok` | `degraded` | `offline` | `blind`

```
Plano interno (6 seg) — subscribe
  terra/{tenant}/{module}/{device}/{metric}/reading   (ec, ph, temp, level, flow, air_temp, humidity, switch, photo)
  terra/{tenant}/{module}/{device}/status/status      (retained + LWT)

Plano plataforma (4 seg) — publica
  terra/{tenant}/{module}/health   (retained, qos1) — {state, ts, devices: {id: DeviceState}}
  terra/{tenant}/{module}/alert    (no retained, qos1) — {name, ts, severity, device?, detail?}
```

### Detecciones

1. **impossible** — reading fuera de rango físico → `impossible` inmediato + alerta `device_impossible` (critical). Rangos: ph 0-14, ec 0-10 mS/cm, temp -10..60°C, air_temp -30..60°C, humidity 0-100%, level 0-110%, flow 0-50 L/min.
2. **frozen** — mismo valor exacto en ≥12 readings consecutivos (switch exento, métrica `switch`) → `frozen` + `device_frozen` (warn).
3. **silence** — sin reading en >`SILENCE_AFTER_MS` (default 90000 (3× la cadencia de sensores del sim, 30s a speed 1)) → `silence` + `device_silence` (warn).
4. **offline** — `status/status` con `state: offline` (LWT) → `offline` + `device_offline` (critical); al volver → `device_recovered` (info). Un status offline **stale** (llegó antes que la última lectura viva) NO marca offline: la evidencia viva gana. La precedencia se decide por **tiempo de llegada real** al watchdog, no por el `ts` del payload (inmune a `--speed N` del sim, cuyo reloj corre adelantado).
5. **cámara** (`kind: camera`) — exenta de `silence`/`frozen`: solo publica al capturar; su salud la da el LWT.

Estado de módulo = peor dispositivo: `blind` si **todos** los sensores (`kind: sensor`) están sin dato (`silence`/`offline`) — señal de oficina activa —, `offline` si algún `offline`, `degraded` si algún `silence`/`frozen`/`impossible`, `ok` resto. Alertas `module_blind` (warn) y `module_recovered` (info) solo en transiciones (edge-triggered, sin duplicados).

## Estructura

```
services/watchdog/
  src/topics.ts   — helpers puros: parsea 6-seg reading/status, construye 4-seg health/alert
  src/health.ts   — DeviceHealthTracker puro: seenReading/seenStatus/evaluate
  src/index.ts    — runtime: MQTT + pg (devices) refresh 60s, publica health/alert, heartbeat 30s
  test/health.test.ts — tests puros (vitest, sin broker ni DB)
```

`topics.ts` no duplica lógica incompatible con `router/src/topics.ts` (mismo formato de 6 segmentos).

## Env

| Variable | Default | Descripción |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | URL del broker Mosquitto |
| `DATABASE_URL` | `postgres://terra:changeme@localhost:5432/terra` | DSN Postgres (tabla `devices`) |
| `SILENCE_AFTER_MS` | `90000` | Ventana sin readings para marcar `silence` |
| `FROZEN_READINGS` | `12` | Repeticiones exactas para marcar `frozen` |

## Desarrollo

```bash
pnpm install
pnpm test       # vitest run — tests puros de health (sin broker ni DB)
pnpm dev        # tsx src/index.ts — conecta a MQTT + Postgres
pnpm exec tsc --noEmit  # chequeo de tipos
```

Nunca publica a `cmd` ni a `request/`. JSON malformado → `log warn`, nunca `throw`. Shutdown limpio en `SIGINT`/`SIGTERM` (cierra MQTT y pool `pg`).

## Contrato

- `contract/asyncapi.yaml` v0.5.0 (plano plataforma 4 segmentos `health`/`alert`).
- DB: `infra/db/init.sql` + migración 02 — tabla `devices` (kit estándar por módulo) e hypertables `confidence_history`/`alerts` (creadas por ContractInfra).

## Referencias

- ADR-0010: termómetro de confianza por módulo (watchdog no lo calcula, solo salud).
- ADR-0015: planos dispositivo (5 seg) / interno (6 seg) / plataforma (4 seg).
- Roadmap Fase 1: cerebro observador, cero actuación.
