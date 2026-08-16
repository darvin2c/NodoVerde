---
type: adr
title: "ADR-0009: Modos de operación y canal de solicitudes humanas"
description: La UI (HA) tiene botones; humano e IA pasan por el mismo portero; tres modos de operación
tags: [adr, ui, home-assistant, policy, modos]
created: 2026-08-15
status: aceptado (ampliado por ADR-0010: modos por módulo + modo oficina activa)
---

# ADR-0009: Modos de operación y canal de solicitudes humanas

## Contexto

Home Assistant muestra actuadores como switches. Decisión pendiente: ¿solo lectura o con botones? Restricción: ningún botón puede publicar al topic de comandos de actuadores — eso saltaría al portero (ADR-0002).

## Opciones consideradas

- **Solo lectura** — una sola vía de órdenes (chat). Simple pero incómodo: ves la válvula en la app y no puedes tocarla.
- **Con botones vía canal de solicitudes** — HA publica una *solicitud*; el portero valida igual que valida al agente y recién entonces emite el comando.

## Decisión

**Con botones.** Nuevo canal en el contrato: `terraos/{tenant}/{parcela}/request/{device}`. Toda solicitud humana pasa por el policy module exactamente como una propuesta del agente (mismos límites, mismos interlocks, mismo audit con `requested_by`).

Propiedad derivada — **tres modos de operación** gratis, porque humano e IA son ambos solicitantes ante el mismo portero:

| Modo | Quién ordena | Cuándo |
|---|---|---|
| Manual | Humano desde botones de HA | Cerebro apagado/caído, o sin confianza aún |
| Supervisado | Cerebro propone, humano aprueba por chat | Operación normal inicial |
| Autónomo | Cerebro ordena solo (por clases de acción liberadas) | Cerebro con criterio demostrado |

Si el VPS cae, la finca sigue operable en modo manual con HA local en el edge. El cerebro es un empleado que se puede despedir temporalmente, no el dueño de la llave.

## Consecuencias

- +1 canal en AsyncAPI (`humanRequest`).
- Auditoría completa: toda acción registra solicitante (humano/agente) y veredicto del portero.
- La autonomía se libera por clase de acción, nunca de golpe.
