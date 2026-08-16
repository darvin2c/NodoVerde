---
type: adr
title: "ADR-0002: Policy engine como módulo interno, dueño único de actuadores"
description: Toda orden a actuadores pasa por un portero; nace como módulo, no como servicio
tags: [adr, policy, seguridad, actuadores]
created: 2026-08-15
status: aceptado
---

# ADR-0002: Policy engine como módulo interno, dueño único de actuadores

## Contexto

El agente decidirá sobre hardware físico (válvulas, bombas). Un error cuesta dinero real (riego de más, bomba en seco). Las skills de OpenClaw ejecutan herramientas directamente — exponer actuadores como skill sería un agujero de seguridad.

## Opciones consideradas

- **Servicio separado** — proceso propio, red, retries, deploy independiente. Robusto pero pesado para v1 mono-finca.
- **Módulo interno** — librería que el cerebro importa, con interfaz limpia.
- **Sin policy** (skill directa) — descartado: inaceptable con hardware físico.

## Decisión

**Módulo interno** (el "portero"), dueño único del derecho a emitir comandos a actuadores. Se extraerá a servicio cuando llegue multi-finca operativo (trigger en ROADMAP).

Dominios disjuntos de decisión sobre actuadores:

| Nivel | Responsable | Alcance |
|---|---|---|
| Seguridad física | Interlocks en edge | Bomba en seco, sobrepresión. Funcionan aunque caiga todo el software |
| Acciones agronómicas | **Policy module** | Toda acción del agente: valida ventana horaria, límites, presupuesto; pide aprobación humana por chat según clase de acción |
| Conveniencia UI | Home Assistant (futuro) | Prohibido para actuadores agrícolas |

## Consecuencias

- Toda acción queda registrada: propuesta → validación → aprobación → ejecución → costo en ledger.
- Autonomía gradual: cada clase de acción tiene nivel (solo-reportar / requiere-aprobación / autónoma).
- El agente nunca tiene credenciales ni topics de comando de actuadores; solo habla con el portero.
