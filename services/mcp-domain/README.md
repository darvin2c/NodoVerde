# terra-mcp-domain — MCP server de dominio (read-only + campaña gobernada)

Servidor MCP que expone datos de negocio de terraOS al cerebro (OpenClaw). Es la **única** vía por la que el agente consulta telemetría, perfiles y reportes — matriz de dueños: *herramientas del agente = MCP*.

- Stack: `@modelcontextprotocol/sdk` (StreamableHTTPServerTransport), `zod`, `pg`.
- Puerto: `MCP_DOMAIN_PORT` (default `7760`), endpoint `POST /mcp`.
- Invariante: **telemetría y perfiles solo `SELECT`/`WITH`** — jamás `INSERT`/`UPDATE`/`DELETE` sobre `telemetry`/`confidence_history`/`alerts`/`modules`/`tenants`/`crop_profiles` (validado en `src/db.ts` con `assertReadOnly`; grepeable). Excepción gobernada ADR-0021: `src/write.ts` usa pool separado con statements explícitos **solo** sobre `lotes` y `alert_resolutions` (ADR-0024) (INSERT/UPDATE). Documentado como única escritura permitida.
## Herramientas MCP

Todas devuelven JSON estructurado (`structuredContent`) + resumen en `content[0].text`.

### Lectura (read-only, `src/db.ts`)

| Tool | Input | Descripción | Query interna |
|---|---|---|---|
| `list_modules` | `{tenant?: string}` | Lista módulos registrados (`tenant, id, crop`) | `SELECT ... FROM modules` |
| `get_crop_profile` | `{name: string}` | Perfil de cultivo por nombre (`ec_min/max, ph_min/max, water_temp_min/max, notes`) | `SELECT ... FROM crop_profiles` |
| `get_farm_context` | `{tenant?: string}` | Identidad de la finca (tenants) + módulos | `SELECT ... FROM tenants` + `modules` |
| `latest_readings` | `{tenant: string, module: string}` | Última lectura por métrica en el módulo (una fila por métrica). Métrica sin dato no se inventa | `SELECT DISTINCT ON (metric) ... FROM telemetry` |
| `telemetry_range` | `{tenant, module, metric, from: ISO, to: ISO, limit? <=500}` | Telemetría en ventana temporal ordenada por tiempo | `SELECT ... FROM telemetry WHERE ... time>= ... LIMIT` |
| `module_confidence` | `{tenant?: string, module?: string}` | Último termómetro global por módulo (`value` 0–100 + `sources`) | `SELECT ... FROM confidence_history` |
| `recent_alerts` | `{tenant?: string, hours?: number}` | Alertas recientes del watchdog (silence/frozen/impossible/offline/blind) | `SELECT ... FROM alerts WHERE time >= now()-hours` |
| `daily_report_data` | `{tenant: string, date?: YYYY-MM-DD}` | Construye `DailyReportData` del día delegando a `buildDailyReportData` (puro): `latest` solo con lecturas en ventana, `missing` honesto, `stats` min/avg/max, `pctTimeInRange` vs perfil, `confidence` y `alerts` del día | Lee `modules` + `crop_profiles` + `telemetry` día + `confidence_history` + `alerts`, luego `buildDailyReportData` |

### Lotes de producción y alertas invariantes (excepción gobernada ADR-0021/0024, `src/write.ts`)

Telemetría sigue read-only. `lotes` y `alert_resolutions` son la única escritura permitida, con pool separado y statements explícitos (INSERT/UPDATE solo sobre esas dos tablas). Ningún handler publica a MQTT ni toca otras tablas.

El **lote** es el ciclo biológico real (ADR-0024): cultivo + módulos explícitos + fechas propias. La campaña es solo una etiqueta lógica libre (`campaign: string | null`), sin tabla ni ciclo de vida. Regla física: un módulo solo aloja UN lote activo (validado en `open_batch`).

| Tool | Input | Descripción | Query interna |
|---|---|---|---|
| `open_batch` | `{tenant: string, crop: string, modules: string[], campaign?: string, note?: string}` | Abre lote: valida crop existe, módulos existen/activos/mismo cultivo y ninguno ocupado por lote abierto; `expected_end_at` = inicio + `cycle_days` del perfil (null honesto si el perfil no lo tiene); `profile_hash` = sha256 del row `crop_profiles`; `memory_hash` = sha256 de `$WORKSPACES_PATH/experto-<crop>/MEMORY.md`. Genera `code` legible (LOTE-0001). Inserta y retorna `id`/`code`. | `SELECT ... FROM crop_profiles` + `SELECT ... FROM modules` + `SELECT ... FROM lotes WHERE state='open'` + `INSERT INTO lotes ...` |
| `close_batch` | `{id: string, reason: 'cosecha'\|'venta'\|'perdida'\|'otro', note?: string}` | Cierra lote por id: `memory_hash_close` = sha256 de MEMORY.md al cerrar, `closed_at=now()`, `state='closed'`. Error si no existe o ya está cerrado. | `SELECT ... FROM lotes WHERE id` + `UPDATE lotes SET memory_hash_close, closed_at, close_reason, state` |
| `list_batches` | `{tenant?: string, state?: 'open'\|'closed'}` | Lotes (activos primero), filtrable por tenant y estado. | `SELECT ... FROM lotes ORDER BY state, started_at DESC` |
| `resolve_alert` | `{tenant: string, alert_name: string, module?: string, fingerprint?: string, note?: string, resolved_by?: string}` | Inserta resolución manual (silencia alerta invariante). Matching: `alert_name` + `module`/`fingerprint` opcionales (null = aplica a todos). | `INSERT INTO alert_resolutions ...` |
| `list_invariant_alerts` | `{tenant: string, only_open?: boolean}` | Lista alertas invariantes (`cmd_sin_policy`, `invariant_ledger`, `budget_tokens`) con `is_open` según regla: abierta si no existe (a) alerta posterior mismo `tenant+name+fingerprint` con `state="resolved"` ni (b) fila en `alert_resolutions` que matchee. Parsea `detail::jsonb` defensivo. | `SELECT ... FROM alerts WHERE name = ANY(...)` + `SELECT ... FROM alert_resolutions` + filtro puro |

`buildDailyReportData` es puro (sin I/O) y **nunca inventa valores**:

- `latest[metrica]` solo si hubo lectura en la ventana del día; si no, ausente.
- `missing: string[]` lista dispositivos sin dato (ej. `ec-01` si no hubo `ec`; `climate-01` si faltaron `air_temp`+`humidity`).
- `stats` por métrica con `min/avg/max` redondeados a 2 decimales.
- `pctTimeInRange` vs rangos del perfil de cultivo (ec/ph/temp agua).
- Módulo ciego → `latest` vacío, `missing` completo.

Aritmética simple de promedios/min/max aquí está permitida (no es financiera).

## Env

| Variable | Default | Descripción |
|---|---|---|
| `MCP_DOMAIN_PORT` | `7760` | Puerto HTTP para `/mcp` y `/healthz` |
| `DATABASE_URL` | `postgres://terra:changeme@localhost:5432/terra` | DSN Postgres/TimescaleDB (lectura + escritura gobernada lotes/alert_resolutions) |
| `WORKSPACES_PATH` | `""` | Ruta base de workspaces para `experto-<crop>/MEMORY.md` (hash honesto; vacío → `memory_hash=null`) |

## Desarrollo

```bash
pnpm install
pnpm dev        # tsx src/index.ts — HTTP + MCP en :7760
pnpm test       # vitest run — report puro + campañas (sin DB; hashing y resolución invariante)
pnpm exec tsc --noEmit
```

Healthcheck: `GET /healthz` → `200 {status:"ok"}`. Shutdown limpio en `SIGINT`/`SIGTERM` (cierra HTTP, transport MCP y pools pg).

## Config OpenClaw (mcp.servers)

El cerebro consume este MCP vía `streamable-http`. Ejemplo en `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "terra-domain": {
        "transport": "streamable-http",
        "url": "http://mcp-domain:7760/mcp"
      }
    }
  }
}
```

En docker-compose el servicio se llama `mcp-domain`; fuera de Docker usar `http://localhost:7760/mcp`.

En desarrollo local sin Docker, `MCP_DOMAIN_PORT` puede dejarse en `7760` y OpenClaw apunta a `http://localhost:7760/mcp`.

## Seguridad

- Telemetría: ningún handler publica a `cmd` ni a `request/`; `telemetry`/`confidence_history` nunca se escriben. `lotes`/`alert_resolutions` son la única escritura gobernada (pool separado, statements explícitos).
- Validación read-only en `assertReadOnly` — cualquier query que no sea `SELECT`/`WITH` lanza antes de llegar a `pg`.
- `telemetry_range.limit` acotado a `<=500` y `recent_alerts.hours` a `<=720` para evitar escaneos pesados.

## Referencias

- ADR-0010: termómetro de confianza (cálculo determinístico; el MCP solo lo lee).
- ADR-0012: matriz de dueños — herramientas del agente = MCP.
- Contrato: `contract/asyncapi.yaml` (plano interno 6 seg + plano plataforma 4 seg retenido `terra/{tenant}/{module}/confidence|health|alert`).
