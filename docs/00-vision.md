---
type: vision
title: Visión de terraOS
description: Qué es terraOS, para quién, y qué explícitamente no es
tags: [terraos, vision]
created: 2026-08-15
status: vigente
---

# Visión

**terraOS es un agente autónomo de gestión agrícola integral: desde lo financiero hasta lo operacional.**

Un administrador de finca que nunca duerme: observa sensores y cámaras, decide riego y fertilización, lleva la contabilidad, y habla con el dueño por WhatsApp.

## En una frase

> Un cerebro (IA) que mira datos, decide, y solo actúa si un portero lo deja — hablando contigo por chat.

## Principios rectores

1. **El cerebro propone, el portero autoriza, el campo actúa.** La IA nunca toca un actuador directamente ni hace aritmética financiera; el software determinístico ejecuta.
2. **Un dueño por función.** Si dos piezas pueden hacer lo mismo, una pierde ese derecho por ADR. Ver [arquitectura](10-architecture.md#matriz-de-dueños).
3. **Regla de admisión.** Nada entra al build sin responder a la fase actual. Lo diferido vive en el [ROADMAP](../ROADMAP.md) con su trigger, no en el código.
4. **Simulación primero.** Todo el sistema se desarrolla y valida contra un gemelo digital con física real (FAO-56). El hardware llega al final sin cambiar nada más.
5. **Datos con ground truth.** La telemetría base la genera física + estocástica, nunca IA — para poder validar si el agente decidió bien.
6. **Adoptar antes que construir** ([ADR-0008](20-adr/0008-adoptar-vs-construir.md)). Interfaz = Home Assistant, firmware = ESPHome, ingestor = Telegraf. Solo construimos el diferencial: simulador, portero, dominio, cerebro-config, contrato.

## Non-goals (v1)

- Facturación fiscal / cumplimiento tributario.
- UI propia (interfaz visual = Home Assistant adoptado; operación = chat + botones de HA).
- Cumplimiento formal de estándares (OGC SensorThings, ADAPT): nos inspiramos, no cumplimos.
- Soporte de múltiples fincas en operación (el esquema sí nace multi-tenant).
