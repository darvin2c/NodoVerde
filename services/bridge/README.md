# terra-bridge — Bridge MQTT → OpenClaw (Fase 1)

Servicio delgado **bus → cerebro** (observador). Reenvía alertas del plano plataforma al hook de OpenClaw. **Nunca publica a `cmd` ni a `request/`** — Fase 1 es solo lectura.

## Qué hace

```
                          ┌─────────────────────┐
                          │  watchdog / otros   │
                          │  servicios de dominio│
                          └─────────┬───────────┘
                                    │ publica
                   terra/{tenant}/{module}/alert   (4 seg, interno directo, qos1)
                   terra/{tenant}/{module}/health  (4 seg, retained, qos1)
                                    │
                                    ▼
                          ┌─────────────────────┐
                          │   terra-bridge       │
                          │  - suscribe alert    │
                          │  - filtra info       │
                          │  - throttle 5 min    │
                          │  - blind siempre     │
                          │  - health solo log   │
                          └─────────┬───────────┘
                                    │ POST
                                    │ Authorization: Bearer <HOOK_TOKEN>
                                    │ { message, name }
                                    ▼
                          ┌─────────────────────┐
                          │  OpenClaw gateway    │
                          │  POST /hooks/agent         │
                          │  → cerebro           │
                          └─────────────────────┘
```

- **Alertas:** `terra/+/+/alert` — payload `{name, ts, severity, device?, detail?}`. Solo `critical`/`warn` se reenvían (con throttle por `tenant/module/name`, default 5 min). `info` se filtra salvo `module_blind`/`module_recovered` que **siempre** pasan y bypassan throttle.
- **Routing por cultivo (ADR-0019):** la alerta se entrega al **experto de la especie** del módulo — `experto-<especie>` derivado de `modules.crop` (DB, cache 60 s; `<especie>_<variedad>` → experto de la especie). Si el hook rechaza al experto, cae al orquestador `main`. Sin `DATABASE_URL` o sin cultivo → directo a `main`.
- **Health:** `terra/+/+/health` — solo log de transiciones (`ok`/`degraded`/`offline`/`blind`). El `module_blind` ya genera su alerta y es el que despierta al cerebro.
- **`POST :7765/expert-report?token=<OPENCLAW_HOOK_TOKEN>`** — receptor de los webhooks de las automations de expertos. Extrae el texto del run (`NO_REPLY` = silencio), lo reenvía al hook con `agentId=main` (el orquestador es la única voz al humano).

## Env

| Variable | Default | Descripción |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | URL del broker Mosquitto |
| `OPENCLAW_URL` | `http://localhost:18789` | Base URL del gateway OpenClaw |
| `OPENCLAW_HOOK_TOKEN` | *(obligatorio)* | `hooks.token` de `openclaw.json` — sin él el proceso sale con error claro |
| `HOOKS_PATH` | `/hooks/agent` | Path del endpoint de hooks |
| `BRIDGE_NAME` | `terra-bridge` | Campo `name` en el body del POST |
| `THROTTLE_MS` | `300000` | Ventana de throttle por `tenant/module/name` (ms) |
| `DATABASE_URL` | *(vacío)* | Postgres para lookup módulo→cultivo (routing a expertos). Vacío = todo al orquestador |
| `BRIDGE_HTTP_PORT` | `7765` | Puerto del listener `/expert-report` (webhooks de automations) |

Arranque sin `OPENCLAW_HOOK_TOKEN` → `process.exit(1)` con mensaje explicativo.

## Desarrollo

```bash
pnpm install
pnpm dev       # tsx src/index.ts — conecta a MQTT y escucha alert/health
pnpm test      # vitest run — tests puros de forward (sin broker)
pnpm exec tsc --noEmit  # chequeo de tipos
```

Shutdown limpio en `SIGINT` / `SIGTERM` (cierra cliente MQTT).

## Formato del mensaje al cerebro

`formatHookMessage(alert)` produce texto en español:

```
[ALERTA crítica] demo/mod-2 ec-01: valor imposible 14.2 (rango 0-10)
[ALERTA advertencia] demo/mod-1 temp-01: sensor congelado
[ALERTA crítica] demo/mod-1: módulo a ciegas
```

Se envía como:

```json
{
  "message": "[ALERTA crítica] demo/mod-2 ec-01: valor imposible 14.2 (rango 0-10)",
  "name": "terra-bridge",
  "agentId": "experto-lechuga"
}
```

`agentId` lo calcula el bridge según el cultivo del módulo (ADR-0019). Con header `Authorization: Bearer <OPENCLAW_HOOK_TOKEN>`, timeout 5 s y 1 retry por destino. Errores solo se loguean, nunca hacen throw.

## Ejemplo curl al hook

```bash
# Simula lo que hace el bridge al reenviar una alerta
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer $OPENCLAW_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "[ALERTA crítica] demo/mod-1 ec-01: valor imposible 14.2 (rango 0-10)",
    "name": "terra-bridge"
  }'
```

Respuesta esperada del gateway: `200 OK` (o `202` según versión). Verificar en logs de OpenClaw que `terra-bridge` aparece como origen.

## Contrato

- Topics de plataforma (4 segmentos, **no** pasan por router): `terra/{tenant}/{module}/alert`, `terra/{tenant}/{module}/health` — ver `contract/asyncapi.yaml`.
- Fase 1: **cero publicaciones a `cmd` ni a `request/`** (verificable con `grep -r "cmd\|request" services/bridge/src/`).

## Referencias

- ADR-0010: Termómetro de confianza (alertas y health por módulo).
- ADR-0012: Orquestación (Fase 1 = agente único, bridge como sensor del cerebro).
- Contrato: `contract/asyncapi.yaml` — plano plataforma (4 seg).
