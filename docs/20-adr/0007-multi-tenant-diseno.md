---
type: adr
title: "ADR-0007: Multi-tenant por diseño, mono-finca en operación"
description: tenant_id en el esquema desde el día 1; auth y aislamiento diferidos
tags: [adr, multi-tenant, base-de-datos]
created: 2026-08-15
status: aceptado
---

# ADR-0007: Multi-tenant por diseño, mono-finca en operación

## Contexto

terraOS apunta a varias fincas eventualmente. Retroceder un esquema mono-finca a multi-tenant cuesta ~10x más que nacer con la columna.

## Opciones consideradas

- **Mono-finca puro** — más rápido hoy, refactor caro mañana (esquemas, contratos, topics).
- **Multi-tenant operativo** — auth, aislamiento, orgs desde el inicio: demasiado para cero usuarios.
- **Diseño multi-tenant, operación mono-finca** — `tenant_id` en tablas y topics; nada más.

## Decisión

**Diseño multi-tenant, operación mono-finca.** Concretamente:

- Todas las tablas de dominio llevan `tenant_id`.
- Los topics MQTT incluyen el tenant: `terraos/{tenant}/{parcela}/...` (ver AsyncAPI).
- Se despliega y prueba con una sola finca.
- Auth, aislamiento entre tenants y administración de organizaciones: **diferidos** (trigger: segunda finca real).

## Consecuencias

- Barato ahora (una columna, un segmento de topic), sin refactor futuro.
- Riesgo controlado: ningún código puede asumir "la única finca"; las consultas siempre filtran por tenant.
