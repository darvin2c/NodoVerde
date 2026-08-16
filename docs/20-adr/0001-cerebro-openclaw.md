---
type: adr
title: "ADR-0001: Cerebro = OpenClaw"
description: Elección del framework de agente entre OpenClaw, Hermes Agent y Pi
tags: [adr, cerebro, openclaw]
created: 2026-08-15
status: aceptado (ampliado por ADR-0012: estructura multi-agente orquestador + expertos)
---

# ADR-0001: Cerebro = OpenClaw

## Contexto

Necesitamos un framework de agente autónomo que corra 24/7, sea model-agnostic (cualquier LLM), tenga memoria persistente y hable por WhatsApp/Telegram. Candidatos: OpenClaw, Hermes Agent, Pi (pi.dev).

## Opciones consideradas

- **OpenClaw** — agente completo: gateway + runtime + skills + memoria Markdown. Canales de mensajería nativos (su punto fuerte). Ecosistema grande (ClawHub), MIT, foundation 501(c)(3).
- **Hermes Agent** (Nous Research) — memoria de 3 niveles y loop cerrado de auto-mejora. Menos maduro en canales; habría que construir la capa de WhatsApp.
- **Pi (pi.dev)** — harness de coding en terminal. Es herramienta de desarrollo, no cerebro de runtime.

## Decisión

**OpenClaw.** Razones: (1) los canales nativos resuelven el requisito de reportes/fotos por WhatsApp sin construir nada; (2) su memoria en Markdown plano es auditable por humanos — crítico para revisar por qué el agente regó o gastó; (3) model-agnostic: el LLM es decisión de configuración, no de arquitectura.

De Hermes tomamos solo la **idea** del learning loop, diferida al backlog (trigger: ≥1 campaña de decisiones registradas). Pi queda fuera de la arquitectura.

## Consecuencias

- Positivas: canales gratis, memoria auditable, ecosistema de skills genéricas.
- Negativas: skills de ClawHub son superficie de seguridad → mitigado por ADR-0002 (actuadores jamás como skill) y por la regla "dominio solo por MCP".
- Restricción: los prompts y la memoria no deben acoplarse a un proveedor de LLM específico.
