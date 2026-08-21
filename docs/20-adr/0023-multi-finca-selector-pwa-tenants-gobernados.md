---
type: adr
title: "ADR-0023: Multi-finca operativo — selector de finca en PWA, gestión gobernada de tenants y moneda por finca"
description: La PWA gana selector de finca (contexto, persistido en localStorage) con modo "Todas las fincas" honesto (nunca suma monedas distintas); crear/editar/archivar fincas son escrituras gobernadas del MCP de dominio; la tz se deriva de lat/lon en código con catálogo offline
tags: [adr, multi-finca, tenants, pwa, moneda, fase6]
created: 2026-08-21
status: aceptado
amplia: ADR-0010, ADR-0011, ADR-0014, ADR-0022
---

# ADR-0023: Multi-finca operativo — selector de finca en PWA, gestión gobernada de tenants y moneda por finca

## Contexto

El esquema nació multi-tenant (`tenants`, `tenant` en cada tabla, visión §34) pero la operación era de una sola finca: la PWA consultaba siempre `tenant: "demo"` hardcodeado en cada página, y `tenants` se poblaba solo por seed. La discusión de diseño 2026-08-21 (fase de decisión pre-Fase 5) cumplió el trigger del backlog ("Crear/editar fincas desde PWA… — segunda finca real") y expuso dos riesgos:

1. **Moneda mezclable.** Fincas distintas pueden operar en monedas distintas (PEN en Lambayeque, USD en una finca exportadora). Un "total global" que sume PEN+USD sería un número falso — la peor mentira posible en un ledger (ADR-0011).
2. **Escritura sin dueño.** Si la PWA inserta en `tenants` directo a la DB, rompe la regla 1 (un dueño por función) y el precedente de ADR-0022 (provisionamiento gobernado vía MCP).

## Decisión

### Gestión de fincas (escritura gobernada)

- **Dueño único: MCP terra-domain** (`services/mcp-domain`), siguiendo ADR-0022. Tools nuevas: `list_tenants`, `create_tenant`, `update_tenant`, `archive_tenant`.
- **id = slug inmutable** (`^[a-z0-9][a-z0-9-]{1,31}$`, minúsculas/dígitos/guiones, 2-32 chars): queda grabado en topics MQTT, telemetría y ledger — jamás se renombra.
- **Nada se borra (ADR-0011):** no hay DELETE de fincas. `archive_tenant` pone `archived_at` y la excluye de la operación diaria (selectores, fan-out de aprobaciones); la historia (telemetría, movimientos, alertas) queda intacta y consultable.
- **lat/lon obligatorios al crear.** De ellas salen: zona horaria (derivada en código con catálogo offline embebido `tz-lookup` — el clima no puede depender de un servicio online) y nombre de zona legible (`location_name`, editable a mano).
- **Moneda por finca:** columna `tenants.currency` (catálogo PEN/USD/EUR, default PEN). La validación del catálogo se hace dos veces: en la frontera tRPC de la PWA (un valor inválido nunca llega al MCP) y en el MCP de dominio (dueño).
- La PWA ofrece la página `/fincas` (crear/editar/archivar) delegando SIEMPRE al MCP vía `mcpDomain.ts` — ventanilla, no dueña.

### Selector de finca y modo "Todas"

- **Contexto global** (`tenant-provider.tsx`): finca activa disponible en toda la app; `null` = "Todas las fincas" (vista agregada del dueño). Persistida en `localStorage` por navegador — sin auth no hay usuarios; con auth futuro migra a preferencia de usuario. Si la finca almacenada se archiva, el contexto vuelve solo a "Todas".
- **Selector en el header** (dropdown) + tarjetas por finca en el Overview en modo Todas (módulos, alertas abiertas, gasto del día, confianza media — todo en SQL/live, cada finca en su moneda). Click en tarjeta fija esa finca.
- **Regla de oro del modo Todas: jamás sumar entre monedas.** Donde una suma global mezclaría monedas (gasto de hoy, resumen del mes), se muestra desglose por finca o `null` honesto con el desglose al lado (ADR-0010: ausencia de dato ≠ dato cero).
- Cada página filtra por la finca activa o muestra todas con etiqueta de finca (`farmName`/`farmCurrency` desde el contexto). El detalle de módulo (`/modulos/:id`) resuelve la finca desde la respuesta del servidor — el id de módulo es único por finca, y en modo Todas el servidor lo resuelve si no es ambiguo.
- Montos formateados con la moneda de su finca (`formatMoney(amount, currency)` con cache de `Intl.NumberFormat`); el viejo `formatPEN` queda solo donde PEN es el contrato (ningún sitio tras este ADR).

### Fan-out del portero

`pending.approvals` y `pending.workOrders` sin tenant hacen fan-out a las fincas activas (no archivadas) y etiquetan cada item con su finca; con tenant explícito el error del portero propaga (visible para el usuario), en modo Todas la finca caída se omite — degradación honesta, no falso "sin pendientes" cuando el error es explícito.

## Consecuencias

- **+** Segunda finca = alta desde la PWA en 1 minuto, sin tocar DB ni redeploy.
- **+** Imposible por construcción mostrar una suma PEN+USD; cada número lleva su moneda.
- **+** El aislamiento real (auth, RLS, usuarios por finca) sigue diferido en el backlog — este ADR es gestión y visualización, NO seguridad multi-tenant.
- **−** Una sola sesión de navegador comparte la finca activa (localStorage); dos pestañas con fincas distintas no se pueden (limitación aceptada hasta auth).
- **Riesgo aceptado:** el catálogo de monedas es cerrado (PEN/USD/EUR); una cuarta moneda exige migración del enum — deliberado: la moneda es decisión de negocio, no dato libre.

## Verificación

- `pwa/test/procedures.test.ts`: tenants.list/create/update/archive (delegación gobernada + rechazo de slug/moneda inválidos ANTES del MCP), `farms.summary` (KPIs por finca con su moneda, lista vacía honesta con DB caída), `monthSummary` modo Todas (`byTenant` con currency, planos a cero).
- `pwa/test/policy.test.ts`: fan-out de approvals/workOrders etiquetando finca; error explícito propaga, finca caída en modo Todas se omite.
- E2E navegador (2026-08-21): crear "Finca Ica" (USD, -14.067/-75.729) desde `/fincas` → fila en `tenants` con tz derivada `America/Lima`; selector cambia el contexto (KPIs, alertas, módulos, finanzas filtran); modo Todas muestra tarjetas por finca y tabla financiera por finca sin suma global; archivar mueve la tarjeta a la sección archivada con historia conservada.
