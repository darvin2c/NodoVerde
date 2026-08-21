---
type: adr
title: "ADR-0022: Módulo como unidad lógica nombrada — provisionamiento gobernado vía MCP y PWA"
description: El módulo gana nombre humano libre (name) y retiro sin borrado (retired_at); crear/renombrar/retirar/vincular-fierro son escrituras gobernadas del MCP de dominio consumidas por la PWA; el router propaga el nombre a Home Assistant (suggested_area) vía evento meta del bus
tags: [adr, módulo, provisionamiento, claiming, pwa, home-assistant, fase6]
created: 2026-08-20
status: aceptado
amplia: ADR-0011, ADR-0015, ADR-0019, ADR-0021
superseded_parcial: "ADR-0025 (el módulo deja de tener cultivo propio: modules.crop es caché mantenido por el ciclo del lote; create/update_module ya no aceptan cultivo; la actuación biológica exige lote activo)"
---

# ADR-0022: Módulo como unidad lógica nombrada — provisionamiento gobernado vía MCP y PWA

> **SUPERSEDED parcial por ADR-0025 (2026-08-21).** El módulo deja de tener cultivo propio: `modules.crop` pasa a ser caché nullable mantenido solo por `open_batch`/`close_batch` (mesa libre = sin cultivo, honesto); `create_module`/`update_module` ya no aceptan cultivo; la actuación biológica (dosificación) exige lote activo en el portero. El texto original queda como registro histórico:

## Contexto

La discusión de diseño 2026-08-20 (previa a campaña) expuso tres gaps del modelo de dominio:

1. **El concepto "módulo" no estaba documentado ni nombrado.** `modules` existía como tabla, pero nada definía qué es: unidad lógica de asignación (cultivo + fierro + telemetría + costos) cuya forma física depende del tipo de producción. Hoy carga implícitamente "mesa hidropónica".
2. **Los módulos no tenían nombre humano.** `mod-1` es plumbing; el dueño piensa en "Mesa Norte". HA mostraba entidades sueltas sin área (las áreas de fábrica Dormitorio/Sala son ruido del onboarding de HA, no de terraOS).
3. **No existía forma de crear/configurar módulos** — nacieron del seed de la DB. La PWA (Fase 6) es la cara del sistema, pero la escritura de dominio debe pasar por el MCP gobernado: la PWA es ventanilla, no dueña (regla 1: un dueño por función).

Decisiones de alcance tomadas en la misma discusión:

- `system_type` (hidroponía/suelo/ganado) NO se implementa: se anota en backlog con trigger "primera unidad no-hidropónica real". Cuando entre, vive **en el módulo, no en la finca** — una finca puede mezclar tipos.
- Multi-nodo por módulo (relajar `one_hardware_per_module`) queda anotado con el mismo trigger.
- Crear fincas (tenants) desde PWA queda diferido al trigger multi-tenant ("segunda finca real"); `tenants.name` ya existe y lat/lon ya derivan clima/ET0 — falta derivar tz (tz-lookup, offline) y zona (reverse geocoding, online).

## Decisión

1. **Esquema**: `modules` gana `name TEXT` (humano, libre, no único) y `retired_at TIMESTAMPTZ` (null = activo). El `id` técnico se autogenera `mod-N` (max+1 sobre TODOS los ids del tenant: un id jamás se reutiliza, ni siquiera de retirados — colisionaría con historia financiera y telemetría). Se eligió slug corto sobre UUID porque el id vive en topics MQTT, logs, alertas y entidades HA donde un humano depura; la creación es centralizada vía MCP, así que no hace falta generación offline. Migración idempotente `007-module-identity.sql`.

2. **Escrituras gobernadas en mcp-domain** (mismo patrón que ADR-0021 — excepciones explícitas al read-only):
   - `create_module` (valida cultivo en `crop_profiles`; nace sin fierro — estado válido "sin hardware vinculado", ADR-0010)
   - `update_module` (rename y/o cambio de cultivo)
   - `retire_module` (set `retired_at`; NADA se borra — ADR-0011 aplicado a dominio: telemetría, alertas e imputación financiera histórica quedan intactas)
   - `claim_device` (inserta `device_identities`; un hw_id = un claim; un módulo = un fierro activo)

3. **Congelamiento por lote activo (ADR-0024, antes ADR-0021)**: cambio de cultivo y retiro se RECHAZAN si el módulo está en un lote activo del tenant (`lotes.modules ? module` con `state='open'`). El lote congeló crop + módulos + profile_hash al abrir; mientras vive, el módulo no cambia de identidad.

4. **Propagación de nombre a HA**: el router incluye `suggested_area` (nombre del módulo, fallback al id) en cada payload de discovery — HA crea el área y agrupa los dispositivos automáticamente. Tras cada escritura de módulo, mcp-domain publica `terra/{tenant}/{module}/meta` (plano plataforma 4-seg, contrato v0.8.0, no retained, best-effort); el router suscrito refresca el discovery sin reinicio, y en `module_retired` borra las entidades HA (payload vacío retenido) y deja de aceptar telemetría del módulo. Si el evento se pierde, el router recupera el estado fresco de la DB en su próximo arranque — la DB sigue siendo la única fuente de verdad.

5. **PWA**: página Módulos con "Nuevo módulo" (nombre + cultivo) y detalle con Configuración (renombrar, vincular fierro, retirar). La PWA jamás escribe la DB directamente: llama las tools MCP vía tRPC (`server/mcpDomain.ts`), igual que `resolve_alert`.

## Consecuencias

- El cerebro dice "Mesa Norte" en el reporte diario (`get_farm_context`, `daily_report_data` incluyen `name`).
- Limitación conocida y aceptada: `suggested_area` de HA solo se aplica si el dispositivo no tiene área asignada manualmente; un rename posterior actualiza el nombre del dispositivo pero no mueve el área (requeriría API de HA; 2 clicks manuales en Settings → Areas).
- Un módulo retirado no entra en lotes nuevos (`open_batch` filtra retirados, ADR-0024).
- El sim no cambia: sus 4 nodos demo siguen claimeados por seed; un módulo creado por PWA sin fierro simplemente no tiene telemetría (honesto).

## Alternativas consideradas

- **UUID como id de módulo**: descartado — topics/logs/entidades HA ilegibles; solo ganaría con autoprovisionamiento offline de nodos, que no existe en el roadmap.
- **Borrado de módulos**: descartado por ADR-0011 — la historia financiera y de telemetría es inmutable; retiro = anulación, no borrado.
- **PWA escribe DB directo**: descartado — salta la validación de dominio y rompe "un dueño por función".
- **`system_type` ahora**: descartado por regla de admisión — sin trigger, es diseño especulativo; queda anotado en backlog con su trigger.
