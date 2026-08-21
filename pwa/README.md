# terraOS PWA — Panel de control

Dashboard instalable (Vite + React + TanStack Router + tRPC + drizzle-orm + shadcn/Base UI + Tailwind v4) — la portada pro del sistema (ADR-0014, Fase 6). Dark/light, sidebar colapsable, header con breadcrumb + ⌘K + campana de alertas.

## Rutas

| Ruta | Qué muestra | Fuente |
|---|---|---|
| `/` Overview | KPIs: módulos OK, alertas abiertas 24h, aprobaciones pendientes, gasto del día, confianza media, campaña | `overview.kpis` |
| `/modulos` | Tarjetas por módulo: salud, confianza, EC/pH/tanque | `modules.list` + `field.latest` + SSE |
| `/modulos/:id` | Lecturas vs rangos del perfil (fuera de rango marcado), sparklines 24h, confianza por fuente, alertas del módulo | `modules.detail` + `field.series` |
| `/alertas` | Centro de alertas: severidad, abierta/resuelta, drawer con **qué está pasando + cómo solucionar** (mapa de remediación en código, `src/lib/remediation.ts`) | `alerts.list` |
| `/finanzas` | Mes: ingresos/gastos/balance, gasto por categoría, movimientos (anulados tachados — ADR-0011) | `finance.*` |
| `/aprobaciones` | Acciones del portero (aprobar/rechazar, ADR-0020) + órdenes de trabajo manuales | `pending.*` |
| `/camaras` | Última foto por módulo o placeholder honesto | `cameras.lastPhoto` |
| `/fincas` | Gestión de fincas: crear (slug inmutable + lat/lon + moneda), editar, archivar (nada se borra) | `tenants.*` → MCP dominio (ADR-0023) |
| `/sistema` | Sonda de servicios (broker, DB, portero, MCPs, sim) + salud de módulos + links | `system.services` |

## Finca activa (ADR-0023)

Selector en el header: **una finca** filtra todas las páginas; **"Todas las fincas"** agrega con tarjetas/tablas por finca y etiqueta de finca por fila. Regla de oro: jamás sumar monedas distintas — el gasto global multi-moneda es `—` honesto y el desglose va por finca. La selección persiste en `localStorage` (sin auth); si la finca se archiva, vuelve a "Todas" sola. Montos con `formatMoney(amount, currency)` — la moneda es de la finca, no fija.

## Escrituras (las únicas)

- `pending.decide` / `pending.completeWorkOrder` → portero HTTP con `POLICY_ADMIN_TOKEN` (ADR-0020, cero LLM).
- `alerts.resolve` → MCP dominio `resolve_alert` (ADR-0021, resolución gobernada en `alert_resolutions`).
- `modules.create/update/retire/claim` → MCP dominio (ADR-0022, provisionamiento gobernado).
- `tenants.create/update/archive` → MCP dominio (ADR-0023; validación de slug/moneda en la frontera tRPC).

Todo lo demás es lectura. Nunca publica `cmd/` ni `request/`.

## Stack

- **Frontend**: Vite + React 18 + TanStack Router (rutas code-based) + TanStack Query (polling 5–15s) + tRPC client (`httpBatchLink` + SSE para subscriptions) + shadcn/ui sobre **Base UI** (`@base-ui/react`) + Tailwind v4 (CSS-first, tokens en `src/index.css`).
- **Server** (`server/`): tRPC standalone + drizzle/pg sobre TimescaleDB + bus MQTT interno (SSE fan-out) + fetch al portero + cliente MCP al mcp-domain.
- Componentes UI: instalados vía `pnpm dlx shadcn@latest add <componente>` (preset base-nova). **No escribir primitivos a mano.**

## Dev

```bash
pnpm install
pnpm dev        # vite :5173 (proxy /trpc) + server :7780
pnpm test       # vitest: procedures + policy + remediación + dashboard
pnpm build      # tsc server → dist-server + vite → dist (PWA con SW)
```

## Tests

- `test/procedures.test.ts` — procedures base (finanzas, campo, shaping confianza).
- `test/policy.test.ts` — cliente del portero (aprobaciones/órdenes).
- `test/dashboard.test.ts` — procedures Fase 6 (alerts.list con estado abierto, overview.kpis, modules.detail, system.services).
- `test/remediation.test.ts` — el mapa de remediación cubre exactamente los tipos de alerta que emite el sistema; añadir un tipo nuevo de alerta exige su ficha.
