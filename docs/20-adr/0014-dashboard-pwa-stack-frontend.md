---
type: adr
title: "ADR-0014: Dashboard único PWA (read-only) + stack frontend"
description: PWA TypeScript por secciones como portada del sistema; HA sigue siendo la cabina de actuadores; escalera PWA → Tauri con triggers
tags: [adr, dashboard, pwa, frontend, trpc]
created: 2026-08-15
status: aceptado
---

# ADR-0014: Dashboard único PWA + stack frontend

## Contexto

Home Assistant es la cabina del fierro (operar actuadores) y Grafana analiza, pero falta **la portada del sistema**: una sola pantalla resumida por secciones que responda en 5 segundos "¿todo conectado, todo levantado, todo bien?" — de la vista operativa a la financiera. Requisitos: pequeña, resumida, web convertible a app/desktop.

## Decisión

**PWA read-only en TypeScript**, construida temprano (Fase 1), que crece hasta ser la UI completa (Fase 6). Nace chiquita, crece con evidencia de uso real; no se diseña a ciegas ni se construye dos veces.

### Secciones de la pantalla de estado

```
SISTEMA     broker ✅  DB ✅  sim/edge ✅  cerebro ✅
MÓDULOS     m1 🟢94%  m2 🟡61%  m3 🟢  m4 🟢     (confianza ADR-0010)
CAMPO       EC pH tanque temp — última lectura
FINANZAS    mes: -S/840 · costo/kg: S/3.20
PENDIENTES  aprobaciones · alertas críticas
CÁMARAS     última foto por módulo
```

Cada tarjeta enlaza a la herramienta especializada (HA para operar, Grafana para analizar). Read-only: cero lógica de negocio, cero botones de actuadores.

### Stack (evaluado y corregido en discusión)

```
Vite + React + TanStack Router + shadcn/ui      ← frontend
TanStack Query + tRPC (queries + subscriptions) ← datos, estado vivo incluido
drizzle-orm + Zod                               ← DB y validación (servidor tRPC)
mqtt.js en el SERVIDOR                          ← único que habla con el broker
vite-plugin-pwa                                 ← instalable app/desktop
```

Decisiones clave:
- **tRPC subscriptions > mqtt.js directo al navegador**: el servidor se suscribe a MQTT (fan-out a N clientes); el broker jamás se expone a internet. Tipado end-to-end del payload MQTT al componente.
- **Trade-off aceptado**: tRPC es TS-a-TS (interno). La API pública OpenAPI para integraciones externas queda como fachada futura con trigger propio (backlog).

### Escalera multiplataforma (con triggers)

| Peldaño | Trigger |
|---|---|
| **PWA** (ahora) | Cubre web + instalable móvil/desktop |
| **Tauri desktop** | Notificaciones nativas, tray con alertas, autostart, offline real en PC de oficina |
| Tauri/Capacitor móvil | PWA instalable no basta (push nativo, tiendas) |

Tauri consume el mismo build de Vite: adoptarlo después cuesta días, no semanas.

## División de superficies (matriz de dueños)

| Superficie | Dueña de |
|---|---|
| **PWA terraOS** | Vista resumen unificada (portada) |
| Home Assistant | Operación del fierro (botones → portero) |
| Grafana | Análisis profundo + alertas de umbral |
| Chat | Conversación, aprobaciones, captura financiera |
| OpenClaw Control UI | Estado del cerebro |

## Consecuencias

- Fase 1 incluye la pantalla de estado; Fase 6 se reformula: de "construir UI" a "hacer crecer esta PWA".
- Un solo lenguaje (ADR-0013) cubre ya frontend, API, servicios y sim.
