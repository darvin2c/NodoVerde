# terra-router — Router de identidad (ADR-0015)

Servicio `router/` que traduce entre el **plano dispositivo** (hardware tonto, `hw_id`) y el **plano interno** (identidad lógica `tenant/módulo`).

## Qué es

El hardware de campo publica **solo por su `hw_id` de fábrica** (MAC sin dos puntos, 12 hex minúsculas). La identidad —a qué finca y módulo pertenece— se asigna dinámicamente en la DB vía *claiming* (`device_identities`). El router resuelve esa identidad y traduce los topics MQTT entre ambos planos, sin que el fierro jamás conozca `tenant`/`módulo`/`cultivo`.

Dos planos distinguibles por número de segmentos:

```
Plano dispositivo (5 seg) — lo que publica/escucha el fierro
  terra/{hw_id}/{device}/{metric}/reading
  terra/{hw_id}/{device}/{metric}/event
  terra/{hw_id}/{device}/status/status           (retained + LWT)
  terra/{hw_id}/{device}/confidence/confidence
  terra/{hw_id}/{device}/request/{action}        (escucha: set|read|capture|calibrate)

Plano interno (6 seg) — consumen HA/Telegraf/cerebro/Grafana
  terra/{tenant}/{module}/{device}/{metric}/reading|event
  terra/{tenant}/{module}/{device}/status/status
  terra/{tenant}/{module}/{device}/confidence/confidence
  terra/{tenant}/{module}/{device}/request/{action}
  terra/{tenant}/{module}/{device}/cmd
  homeassistant/{component}/{unique_id}/config   (publicado por el router, nunca por el dispositivo)
```

## Flujos

### 1. Device → interno
Subscribe a `terra/+/+/+/reading`, `terra/+/+/+/event`, `terra/+/+/status/status`, `terra/+/+/confidence/confidence` (patrones de 5 segmentos). Por cada mensaje:
- extrae `hw_id`, resuelve `hw_id → (tenant, módulo)` consultando `device_identities` (cache 30 s, invalidación por TTL).
- si `hw_id` desconocido → `log warn` + descartar.
- republica en el plano interno con **payload idéntico**; `retain` solo para `status` y readings de `switch` (`retain=true` y `qos1`), resto `retain=false` (`qos0` para lecturas de sensores).
- al resolver un `hw_id` conocido por primera vez (o si cambió la asignación `UPDATE device_identities`), publica discovery de HA con `state_topic` internos (6 seg) y `retain=true`.

### 2. Interno → device
Subscribe a `terra/+/+/+/request/#` (plano interno, 6 seg). Por cada `request`:
- resuelve `(tenant, módulo) → hw_id` (misma tabla, mismo TTL).
- republica como `terra/{hw_id}/{device}/request/{action}`, payload intacto, `qos1`.
- `hw_id` desconocido para ese `(tenant,módulo)` → `log warn` + descartar.

### 3. HA discovery
Publicado por el router al confirmar una identidad. Incluye por nodo:
- Sensores: `ec-01` (ec, mS/cm), `ph-01` (ph), `temp-01` (temp, °C), `level-01` (level, %), `flow-01` (flow, L/min), `climate-01` (air_temp °C + humidity %).
- Switches: `pump-recirc-01`, `valve-fill-01`, `doser-a-01`, `doser-b-01`, `doser-ph-01`.
Todos con `state_topic` interno, `availability_topic` interno y, para switches, `command_topic` interno `request/set`.

## Env

| Variable | Default | Descripción |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | URL del broker Mosquitto |
| `DATABASE_URL` | `postgres://terra:changeme@localhost:5432/terra` | DSN de Postgres (tabla `device_identities`) |

## Desarrollo

```bash
pnpm install
pnpm dev       # tsx src/index.ts — conecta a MQTT + Postgres
pnpm test      # vitest run — tests puros de topics (sin broker ni DB)
pnpm exec tsc --noEmit  # chequeo de tipos
```

Shutdown limpio en `SIGINT` / `SIGTERM` (cierra MQTT y pool `pg`).

## Referencias

- ADR-0015: *Dispositivo tonto — identidad dinámica vía claiming y router*.
- Contrato: `contract/asyncapi.yaml` v0.4.0.
- DB: `infra/db/init.sql` — tabla `device_identities`.
