---
type: adr
title: "ADR-0005: Finanzas con ledger gobernado + namespace del agente"
description: Esquema financiero núcleo fijo de doble partida; el agente crea tablas solo bajo prefijo agent_*
tags: [adr, finanzas, ledger, base-de-datos]
created: 2026-08-15
status: supersedido por ADR-0011

> **Nota:** Este ADR quedó supersedido por [ADR-0011](0011-finanzas-registro-simple.md) (registro simple de movimientos categorizados). Se conserva como historia: el namespace `agent_*` y la regla "el LLM nunca hace aritmética" siguen vigentes en ADR-0011.
---

# ADR-0005: Finanzas con ledger gobernado + namespace del agente

## Contexto

El agente debe gestionar finanzas completas (costos, presupuesto, ventas, cosechas, inventario, nómina) y se pidió que pueda crear sus propias tablas. Riesgos: el LLM haciendo DDL libre en producción, haciendo aritmética financiera, o duplicando datos del ledger en tablas sueltas.

## Opciones consideradas

- **DDL libre para el agente** — flexible pero inaceptable: esquema impredecible, datos duplicados, auditoría imposible.
- **Esquema totalmente cerrado** — seguro pero castra la capacidad del agente de organizar información nueva.
- **Núcleo gobernado + namespace abierto** — ledger fijo, tablas del agente bajo prefijo.

## Decisión

**Núcleo gobernado**: ledger de doble partida (cada movimiento registra origen y destino), centros de costo por parcela/lote/cultivo, cuentas, presupuestos. Migraciones normales, revisadas en PR.

**Namespace del agente**: puede crear tablas SOLO con prefijo `agent_*`, vía una herramienta MCP de migraciones gobernadas. Jamás puede crear tablas que dupliquen gastos/transacciones — eso va al ledger o falla.

**El LLM nunca hace aritmética financiera**: los cálculos (costo/ha, margen por cosecha) los ejecutan funciones determinísticas expuestas por MCP; el agente interpreta resultados.

## Consecuencias

- Invariante continua de campaña: el ledger siempre cuadra (watchdog de nivel 4).
- Property-based testing (Hypothesis) sobre secuencias de transacciones.
- Alcance por fases (ROADMAP Fase 2): ledger + costos primero; ventas, cosechas, inventario, nómina después, cada uno su propio PR. Facturación fiscal es non-goal de v1.
