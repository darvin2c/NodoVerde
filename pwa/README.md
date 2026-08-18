# terraOS PWA — Portada read-only

PWA instalable (Vite + React + TanStack Router + tRPC + drizzle-orm) que resume el estado del sistema en **6 secciones** (ADR-0014). **Cero actuación**: no hay botones que muevan actuadores; solo lectura.

## Qué muestra

| Sección | Fuente | Enlace |
|---|---|---|
| **SISTEMA** | `system.status` (MQTT conectado, DB ok, último `telemetry`, health de módulos) | HA :8124 / Grafana :3001 |
| **MÓDULOS** | `modules.list` (DB) + suscripciones `modules.confidence` / `modules.health` (`terra/+/+/confidence`, `terra/+/+/health`) | HA :8124 |
| **CAMPO** | `field.latest` — última lectura EC/pH/temp/tanque por módulo (`telemetry`) | Grafana :3001 |
| **FINANZAS** | `finance.monthSummary` — SUM en SQL sobre `movements` del mes; vacío honesto si no hay movimientos | — |
| **PENDIENTES** | `pending.alerts` — `alerts` warn/critical + placeholder *aprobaciones: Fase 3* | — |
| **CÁMARAS** | `cameras.lastPhoto` — último `photo` por módulo en `telemetry`; tarjeta *sin cámara Fase 0* si no hay datos | MinIO :9000 |

Cada tarjeta enlaza a la herramienta dueña (HA para operar, Grafana para analizar, MinIO para fotos).

## Stack

- **Frontend**: Vite + React 18 + TanStack Router + TanStack Query + tRPC client (`httpBatchLink` + `httpSubscriptionLink` SSE)
- **Servidor**: Node + tRPC server (`superjson`) + drizzle-orm + `mqtt` (solo en `server/`)
- **PWA**: `vite-plugin-pwa` — manifest `terraOS`, theme oscuro `#0f172a`, iconos `pwa-192/512` generados

## Cómo correr

```bash
cp ../.env.example ../.env   # DATABASE_URL, MQTT_URL
pnpm install
pnpm dev                     # concurrently: Vite :5173 + tRPC server :7780
# o por separado:
# VITE_API_URL=http://localhost:7780/trpc pnpm vite --port 5173
# PWA_SERVER_PORT=7780 DATABASE_URL=postgres://terra:changeme@localhost:5432/terra MQTT_URL=mqtt://localhost:1883 pnpm tsx server/index.ts
```

Variables:

- `DATABASE_URL` — default `postgres://terra:changeme@localhost:5432/terra`
- `MQTT_URL` — default `mqtt://localhost:1883`
- `PWA_SERVER_PORT` — default `7780`
- `VITE_API_URL` — default `/trpc` (usa proxy de Vite en dev)

## Build

```bash
pnpm build   # tsc (server) + vite build (client)
pnpm start   # node dist/server/index.js  (sirve tRPC; el front es estático en dist/)
pnpm test    # vitest — procedures con DB mockeada
```

## Read-only — garantías

- Ningún componente importa `mqtt` (solo `server/mqtt.ts`).
- No existe publish a `cmd` ni `request/` en el código PWA — `grep -r "request\|cmd"` solo toca comentarios/docs.
- Finanzas: `SUM` en SQL, no en el render.
- Ausencia de dato ≠ cero: secciones muestran *sin datos / sin movimientos / sin cámara*.

## Estructura

```
pwa/
  vite.config.ts  tsconfig*.json  index.html
  src/  main.tsx  App.tsx  trpc.ts  components/ui/  lib/
  server/  index.ts  trpc.ts  db.ts  mqtt.ts
  public/  pwa-192x192.png  pwa-512x512.png  favicon.svg
  test/  procedures.test.ts
```
