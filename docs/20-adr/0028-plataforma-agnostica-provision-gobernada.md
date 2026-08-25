---
type: adr
title: "ADR-0028: Plataforma agnóstica — el dominio entra por interfaces gobernadas, nunca hardcodeado"
description: El mundo del sim se provisiona vía APIs gobernadas (init.sql queda solo schema); la evaluación agronómica vive en el watchdog contra crop_profiles (Grafana pasa a visor); el portero resuelve dispositivos desde devices.capability provisionada y acepta actuación por clase; los expertos del cerebro se generan desde crop_profiles con un template genérico
tags: [adr, agnostic, provisioning, watchdog, policy, cerebro, grafana]
created: 2026-08-25
status: aceptado
---
# ADR-0028: Plataforma agnóstica — dominio por interfaces, nunca hardcodeado

- **Estado**: aceptado (2026-08-25). Refina ADR-0016 (perfiles en DB), ADR-0020 (portero), ADR-0022 (provisioning gobernado) y ADR-0019 (expertos). Contrato MQTT v0.9.0.
- **Contexto**: cuatro fugas de dominio hardcodeado en la plataforma: (1) `init.sql`/`002-fase1.sql` sembraban el mundo demo (tenant, módulos, identities, devices, perfiles, supply_costs) y el supervisor del sim escribía SQL directo bypasseando las APIs gobernadas ya existentes; (2) Grafana evaluaba umbrales agronómicos literales (EC 1.2–3.5, pH 5.5–6.5, level<15) siendo el único evaluador agronómico del sistema, sin tenant ni cultivo; (3) el portero compilaba el mapa dispositivo→clase (`DEVICE_TO_CLASS`/`CLASS_SENSOR_DEVICE` con `doser-a-01` etc.); (4) el cerebro compilaba las especies (`openclaw.json.template` + `automations.sh` + workspaces fijos): crear perfil `fresa` por PWA no generaba `experto-fresa`.

## Decisión

### 1. El mundo se provisiona por APIs gobernadas; init.sql es solo schema

- `init.sql` ya no siembra NADA de mundo (ni tenant demo, ni módulos, ni devices, ni perfiles, ni supply_costs) — solo DDL/triggers. La DB nace vacía de mundo.
- El sim provisiona su mundo al arrancar vía MCP (`sim/src/provision.ts`): `create_tenant` (la tz la deriva el servidor de lat/lon, ADR-0023), `create_module` con kit declarativo, `claim_device`, `create_crop_profile` desde `sim/config/crops/*.yaml`, `set_supply_cost` vía finance. Idempotente por diseño (corre en cada arranque; los errores `tenant_exists`/`profile_exists`/`hw_already_claimed` son ok). En producción el humano provisiona con las mismas APIs vía PWA.
- `create_module` acepta `devices[]` opcional insertado en la MISMA transacción que el módulo (o nada).
- Nuevo tool gobernado `unclaim_device` (DELETE explícito en `device_identities`): función de laboratorio/mantenimiento que hoy hacía el supervisor con SQL directo. Excepción declarada al "nada se borra": la identidad es asignación volátil; la historia (telemetría/auditoría) jamás se toca.
- El supervisor solo LEE la DB (claims actuales, módulos libres, sync de cultivos) — toda escritura pasa por el dueño de la tabla.

### 2. La evaluación agronómica vive en el dominio; Grafana es visor

- `devices.capability TEXT` (migración 013): actuadores → clase de acción (`dose_nutrient`/`dose_ph`/`fill_water`/`recirculate`); sensores → métrica que alimentan (`ec`/`ph`/`temp`/`level`/`flow`/`climate`); cámara → NULL.
- El watchdog (dueño de alertas) evalúa rangos contra `crop_profiles` del módulo con lote activo (`cropRange.ts`, edge-triggered): `crop_out_of_range` (warn) / `crop_in_range` (info) para ec/ph/temp, y `level_low` (critical) / `level_ok` (info) para nivel — invariante física de cavitación, independiente del cultivo (umbral `LEVEL_LOW_PCT`, default 15).
- Grafana deja de evaluar: se borran las reglas provisionadas de umbrales (`deleteRules` para volúmenes existentes) y queda como visor de la tabla `alerts`.

### 3. El portero resuelve capabilities desde provisioning y actúa por clase

- Se eliminan `DEVICE_TO_CLASS`/`CLASS_SENSOR_DEVICE` compiladas. `getModuleCapabilities(tenant, module)` lee `devices.capability` (caché 30 s) y construye `classToDevices` / `metricToDevice`.
- `propose_action` acepta `action_class` sin device id: el portero elige el primer dispositivo capaz del módulo (ids ordenados, determinista). Rechazos honestos: `no_capable_device` (módulo sin actuador de esa clase), `unknown_device_capability` (device sin capability provisionada), `class_mismatch` (device + clase incoherentes).
- Lo que queda en código son invariantes del portero (autonomía, techos, ventanas, rate limits, `CLASS_OBSERVED_METRIC`) — reglas de decisión, no de despliegue.

### 4. Los expertos se provisionan desde crop_profiles

- Nuevo tool read-only `list_crop_profiles` en mcp-domain.
- `brain/sync-experts.mjs` (cero deps): una especie por perfil (`name.split("_")[0]`, convención ADR-0019). Genera `workspaces/experto-<especie>/` desde `_template-experto/` (SOUL/IDENTITY/TOOLS/skills se reescriben; `MEMORY.md` jamás se pisa — es memoria experiencial que alimenta `memory_hash` de lotes), parchea `openclaw.json` (con `.bak`, restart solo si cambia) y crea crons `revision-<especie>` (*/6h, minuto determinístico por especie).
- Los playbooks generados proponen POR CLASE (`action_class`) sin device ids ni duraciones fijas.
- `brain/automations.sh` corre el sync primero; los workspaces `experto-lechuga`/`experto-tomate` dejan de ser código del repo (son artefactos generados).

## Consecuencias

- **Agnosticidad real**: nuevo cultivo = crear perfil en PWA + re-correr `automations.sh`. Nuevo despliegue de fierro = declarar el kit en `create_module`. Nada se recompila.
- Volúmenes dev existentes conservan las filas demo (inertes; el boot-claim las reconoce idempotente por hw_id). Mundo limpio: `docker compose down -v` (decisión del operador).
- Contrato v0.9.0: alertas nuevas del watchdog + `device_unclaimed` en meta (mismo commit, regla 3).
- Diferido fuera de scope: taxonomía en CHECK constraints (`movements.category`, `movement_evidence.kind`); workspace pnpm.
