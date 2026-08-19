# terra-token-meter — Contabilidad determinística de tokens (ADR-0021 Fase 4)

Servicio `services/token-meter/` que contabiliza tokens del cerebro OpenClaw y los liquida en el ledger financiero. Cero LLM; parse defensivo y pricing determinístico.

## Qué hace

1. **Parser de sesiones OpenClaw**  
   Lee `$OPENCLAW_STATE_PATH/agents/*/sessions/*.jsonl` (excluye `*.trajectory.jsonl`). Cada línea JSON con `usage: {input, output, cacheRead, cacheWrite}` + timestamp (`timestamp`/`ts`/`time`/`created_at`/`date`) + `model` (default `"unknown"`). Suma por modelo para el **día UTC anterior** a la corrida. Línea rota / JSON inválido → skip + count; nunca tumba el proceso.

2. **Pricing**  
   `TOKEN_PRICE_TABLE` JSON `{modelo: {input, output, cacheRead, cacheWrite}}` USD por 1M tokens. Modelo sin precio → **no registra movimiento**; publica alerta `budget_tokens` pending `detail: {reason:"unknown_model", model, state:"pending"}` a `terra/{tenant}/platform/alert`.

3. **Liquidación**  
   Si costo del día > 0 → llama `register_movement` del MCP finance (Streamable HTTP, `FINANCE_MCP_URL` default `http://localhost:7761/mcp`, stateless `sessionIdGenerator: undefined`) con:
   ```
   kind=gasto category=software currency=USD amount=costo
   attribution=split igualitario entre módulos del tenant (pcts 2 decimales, residual en último suma 100)
   source_event=auto:tokens:<tenant>:<yyyy-mm-dd>  created_by="token-meter"
   note="tokens <modelo>: in=… out=… cacheRead=… cacheWrite=… $cost | …"
   ```
   Respuesta `possible_duplicate` → log y skip (dedup natural de reintentos).

4. **Budget check**  
   Tras liquidar suma `category=software` vigente del mes calendario UTC (`movements` `ts >= mes` `ts < mes siguiente` `voided_by IS NULL` `anula_a IS NULL`).  
   Si `sum > TOKEN_BUDGET_USD_MONTHLY` (default 50) → alerta `budget_tokens` pending `fingerprint=<tenant>:<yyyy-mm>` `detail:{month,cost_usd,cap_usd,state:"pending",fingerprint}`.  
   Al volver bajo el cap → misma alerta `state:"resolved"` (edge-triggered; estado previo en memoria por `tenant:month`).

5. **Loop**  
   `setInterval` cada `SETTLE_INTERVAL_HOURS` (default 24) + primera corrida a los **60 s** del arranque. Errores → `console.error` y sigue; nunca `process.exit` por un fallo de liquidación.

## Estructura

```
services/token-meter/
  src/env.ts            — parseo de envs con defaults y validación
  src/parser.ts          — parseSessions + helpers puros (bucketing día UTC, broken lines)
  src/pricing.ts         — parsePriceTable + computeCost
  src/attribution.ts     — buildAttribution (split 2 decimales) + fetchTenantModules
  src/financeClient.ts   — registerMovementViaMcp (Client + StreamableHTTPClientTransport)
  src/budget.ts          — queryMonthSoftwareCost + decide/shouldPublish
  src/alert.ts           — build*Alert + publishAlert (qos1, no retained)
  src/index.ts           — runtime: pg + mqtt + loop + shutdown limpio
  test/token-meter.test.ts — vitest: bucketing, broken, pricing, unknown, split 100, budget, shape register_movement
```

## Env

| Variable | Default | Descripción |
|---|---|---|
| `OPENCLAW_STATE_PATH` | `""` | Root del estado OpenClaw (`$OPENCLAW_STATE_PATH/agents/*/sessions/*.jsonl`). Vacío → skip parse (log). Montado ro en compose. |
| `TOKEN_PRICE_TABLE` | `""` | JSON `{modelo:{input,output,cacheRead,cacheWrite}}` USD/1M. Vacío → sin precios (todo unknown_model). |
| `TOKEN_BUDGET_USD_MONTHLY` | `50` | Cap mensual USD para `category=software`. Budget check > cap ⇒ pending. |
| `SETTLE_INTERVAL_HOURS` | `24` | Horas entre liquidaciones. |
| `FINANCE_MCP_URL` | `http://localhost:7761/mcp` | Endpoint Streamable HTTP del MCP finance. |
| `DATABASE_URL` | `postgres://terra:changeme@localhost:5432/terra` | DSN Postgres (pool para modules/movements/tenants). |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker para alertas `terra/{tenant}/platform/alert` (qos1, no retained). |
| `TENANT` | `""` | Si seteado, solo ese tenant; si vacío, descubre `SELECT id FROM tenants` (fallback `demo`). |

## Desarrollo

```bash
pnpm install
pnpm test        # vitest run — fixtures JSONL temporales, sin broker ni DB real
pnpm build       # tsc
pnpm dev         # tsx src/index.ts — conecta a MQTT + Postgres + Finance MCP
pnpm exec tsc --noEmit  # chequeo tipos
```

Alertas publicadas: `budget_tokens` (warn, `module=platform`) con `detail.state` pending/resolved y `fingerprint` para correlación. JSON malformado / env inválido → `warn` + default, nunca `throw`. Shutdown limpio en `SIGINT`/`SIGTERM`.

## Contrato (Fase 4)

- Topic alertas: `terra/{tenant}/{module}/alert` qos1 no retained payload `{name, ts, severity, device?, detail?}`.
- Movimiento finance: `kind=gasto category=software currency=USD` `source_event` dedup único por tenant/día.
- DDL: `movements` ya existe (init.sql); token-meter solo lee `modules`/`tenants`/`movements`.
