# terra-finance — Ledger financiero (Fase 2, ADR-0011/0027)

Dueño único de la tabla `movements`: **historia financiera inmutable** (nada se borra ni se edita in-place; corrección = anulación + nuevo movimiento). Auto-registro de dosis desde MQTT + MCP read/write :7761 para registro por chat, anulaciones, costos y evidencia en MinIO.

## Qué hace

```
 dosificadora (sim/edge)                humano / cerebro (LLM)
        │ evento de dosis                     │ tools MCP (POST /mcp)
        ▼                                     ▼
 terra/{t}/{m}/{dev}/{metric}/event   ┌──────────────────────┐    ┌────────────┐
 (6 seg, qos1) ──► consumer.ts ──────►│  movements (ledger)  │◄───│  PostgreSQL│
                                      │  inmutable (ADR-0011)│    └────────────┘
                                      └─────────┬────────────┘
                                                │ evidencia (bytes) → MinIO bucket terra-media
                                      ledgerInvariant.ts (cada 24 h)
                                                │ violación → terra/{tenant}/platform/alert
                                                ▼
                                          invariant_ledger (critical)
```

- **Dos scopes (ADR-0027):** `finca` (general, sin attribution) y `modulos` (attribution en **montos** por módulo; la suma debe igualar `amount`; el lote activo se deriva y graba como snapshot).
- **Aritmética en código/SQL, nunca en el LLM:** el LLM pasa datos crudos; validación e inserción las hace el servidor (`split_equal` existe justamente para que el LLM no reparta montos).
- **Consumer MQTT (auto-registro):** suscribe `terra/+/+/+/+/event` (qos1) y registra movimientos de insumo al cerrar dosis `dose_a_end` / `dose_b_end` / `dose_ph_end`. Mapa dispositivo→insumo: `doser-a-01`→`nutriente_a`, `doser-b-01`→`nutriente_b`, `doser-ph-01`→`ph_down`. Valoriza con el costo vigente del insumo (`supplies`).
- **Invariante de ledger (`ledgerInvariant.ts`):** chequeo periódico (default 24 h) sobre movimientos vigentes — scope `modulos` exige attribution con suma = total (±0.005), scope `finca` exige attribution NULL, categoría y moneda obligatorias. Violación → alerta `invariant_ledger` (severity `critical`, qos1) en `terra/{tenant}/platform/alert`.

## Tools MCP (`POST :7761/mcp`)

| Tool | Qué hace |
|---|---|
| `register_movement` | Registra gasto/ingreso. scope `finca` (sin attribution) o `modulos` (attribution en montos que suman el total; lote derivado como snapshot). |
| `split_equal` | Reparto a partes iguales de un monto entre módulos, calculado en código (el último absorbe el centavo). El LLM llama aquí y pasa el resultado a `register_movement`. |
| `edit_movement` | Corrige: anula el original y crea el nuevo con `replaces`→original, en UNA transacción. La cadena de corrección queda grabada (ADR-0027 §7). |
| `void_movement` | Anula: crea movimiento espejo con monto negativo (SQL) y marca el original `voided_by`. Acepta UUID u op_number (`MOV-NNNN`, requiere `tenant`). |
| `attach_evidence` | Adjunta una evidencia ya subida (`POST /api/evidence`, `movement_id` null) a un movimiento. Inmutable: solo se adjunta, jamás se reasigna. |
| `list_movements` | Lista con filtros (`tenant`, `kind`, `category`, `module`, `batch`, `campaign`, `scope`, `supplier`, `mes`, `from`/`to`, `search`, `include_voided`, `limit`≤200, `offset`). Por defecto solo vigentes; orden por `occurred_at`. |
| `cost_summary` | Totales por `crop` / `module` / `category` / `batch` / `scope` / `campaign` (`group_by`). Aritmética 100% SQL; incluye costo-por-kg cuando el lote cerró con `yield_kg`. |
| `list_supplies` | Costo unitario por insumo (`nutriente_a/b`, `ph_down`) para valorización de dosis. |
| `set_supply_cost` | Actualiza el costo unitario de un insumo; las dosis futuras se valorizan con él. |

## HTTP (mismo puerto)

| Endpoint | Qué hace |
|---|---|
| `GET /healthz` | `{status:"ok"}`. |
| `POST /api/evidence` | Bytes crudos (cualquier mime, ≤15 MB). Metadata por headers: `x-tenant` y `x-uploaded-by` (obligatorios), `x-kind`, `x-channel`, `x-note` (opcionales). Dedup por sha256 → `409 duplicate_evidence`. Guarda en MinIO + fila en DB. |
| `GET /api/evidence/:id` | Metadata de la evidencia. |
| `GET /api/evidence/:id/file` | Bytes (proxy MinIO). |

## Env

| Variable | Default | Descripción |
|---|---|---|
| `FINANCE_PORT` | `7761` | Puerto HTTP (MCP + evidencia + healthz) |
| `DATABASE_URL` | `postgres://terra:changeme@localhost:5432/terra` | Postgres/Timescale del ledger |
| `MQTT_URL` | `mqtt://mosquitto:1883` | Broker (consumer de dosis + alertas de invariante) |
| `MINIO_ENDPOINT` | `localhost` | Host MinIO (`minio` en compose) |
| `MINIO_PORT` | `9000` | Puerto API MinIO |
| `MINIO_USE_SSL` | `false` | TLS contra MinIO |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `minioadmin` | Credenciales MinIO |
| `MINIO_BUCKET` | `terra-media` | Bucket de evidencia (lo crea `minio-init` antes de que finance arranque) |
| `LEDGER_CHECK_INTERVAL_HOURS` | `24` | Periodo del chequeo `invariant_ledger` |

## Desarrollo

```bash
pnpm install
pnpm dev       # tsx — MCP :7761 + consumer MQTT + loop de invariante
pnpm test      # vitest run
pnpm exec tsc --noEmit  # chequeo de tipos
```

Deploy con el resto del cerebro: `docker compose --profile cerebro up -d`. Healthcheck: `curl -sf http://localhost:7761/healthz`.

## Contrato

- Topics: suscribe `terra/+/+/+/+/event` (plano dispositivo traducido por el router); publica `terra/{tenant}/platform/alert` (plano plataforma, 4 seg, directo sin router). Ver `contract/asyncapi.yaml`.
- Ledger: tablas propias del servicio; jamás duplica movimientos (regla 6 de AGENTS.md).

## Referencias

- ADR-0011: Historia financiera inmutable (anulación + nuevo movimiento, imputación 100%).
- ADR-0021: Fase 4 — invariante de ledger y alertas gobernadas.
- ADR-0027: Scopes finca/módulos, evidencia multi-archivo, edición como anulación+recreación.
