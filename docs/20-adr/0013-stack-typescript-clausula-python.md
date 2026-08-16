---
type: adr
title: "ADR-0013: Stack unificado TypeScript + cláusula Python"
description: TypeScript/Node como único lenguaje por defecto (sim, servicios, bridge, watchdog); Python entra solo por trigger científico con forma MCP predefinida
tags: [adr, stack, typescript, python, mcp]
created: 2026-08-15
status: aceptado
---

# ADR-0013: Stack unificado TypeScript + cláusula Python

## Contexto

La propuesta inicial fue Python para sim y servicios (reflejo "agronomía = ecosistema científico"). Al examinar la carga real: la matemática pesada (ET0 FAO-56) la entrega Open-Meteo ya calculada; lo que queda es aritmética (EC/pH/tanque) y SQL (movimientos). Además el cerebro (OpenClaw) es Node.

## Evidencia verificada (no asumida)

- **MCP SDK TypeScript**: SDK de referencia del protocolo, tipado estático + Zod para validación runtime.
- **MCP Python (FastMCP 2.0)**: maduro, framework de facto; deriva JSON schemas automáticamente (Pydantic).
- **Contrato bilingüe**: `datamodel-code-generator` (estándar industria) genera modelos Pydantic desde JSON Schema; TS usa Zod. Misma fuente (AsyncAPI), dos lenguajes, sin desalineación.
- **Ecosistema de modelos de cultivo**: PCSE (WOFOST/LINTUL) es Python puro; DSSAT es Fortran con wrappers Python (DSSATTools, gym-DSSAT). **No existe equivalente en Node.** Ni PCSE ni DSSAT traen hidroponía de fábrica — se adaptarían módulos; nuestro modelo de solución nutritiva propio sigue siendo el núcleo.

## Decisión

**TypeScript/Node para todo:**

| Pieza | Lenguaje |
|---|---|
| Simulador (`sim/`) | TypeScript |
| Servicios de dominio (finanzas, confianza, agronomía) | TypeScript |
| Bridge MQTT↔OpenClaw, watchdog, cámaras→MinIO | TypeScript |
| Cerebro | OpenClaw (Node) |

Un solo toolchain, un test runner, una CI, tipos compartidos con el contrato vía Zod.

## Cláusula Python (patrón predefinido, no idea)

**Trigger:** un servicio con necesidad científica real (PCSE/DSSAT, ML local de plagas, estadística pesada).

**Forma obligatoria cuando el trigger se cumpla:**
- `services/agro-models/` — contenedor propio (python:3.12-slim), FastMCP, mismo patrón MCP que los servicios TS.
- Tipos Pydantic generados del mismo AsyncAPI (`datamodel-code-generator`).
- **Cómputo pesado batch → DB, nunca dentro de la tool call**: el modelo corre como job, escribe resultados; el MCP expone solo lecturas instantáneas.
- Toolchain Python (ruff + pytest) entra a CI solo cuando el servicio existe (regla de admisión).
- **Doble cliente**: el mismo servicio puede alimentar al cerebro (vía MCP) y al sim (vía HTTP/MQTT interno) — cubre el caso de un motor de física serio para el simulador.

## Alternativas descartadas

- Todo Python: OpenClaw es Node; dos toolchains sin necesidad actual.
- Todo TS sin cláusula: cierra la puerta a PCSE/DSSAT (solo existen en Python/Fortran).
- Políglota desde el día 1: viola la regla de admisión.

## Consecuencias

- Cero fronteras de lenguaje en v1; si Python nunca se necesita, nunca entra al repo.
- La puerta científica queda escrita con trigger, estructura y regla de tipos — no depende de memoria.
