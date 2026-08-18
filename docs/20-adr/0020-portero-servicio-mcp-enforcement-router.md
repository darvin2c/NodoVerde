---
type: adr
title: "ADR-0020: Portero como servicio MCP + enforcement en router"
description: El policy module nace como servicio de dominio (no módulo interno del cerebro); el router exige policy_id en cmd e intercepta solicitudes de actuadores; aprobación humana dual (chat y botón PWA)
tags: [adr, policy, portero, router, actuadores, fase3]
created: 2026-08-18
status: aceptado
amplia: ADR-0002
supersede-parcial: ADR-0002 (el portero nace como servicio, no como módulo interno importado por el cerebro; el dueño único y las reglas se mantienen)
---

# ADR-0020: Portero como servicio MCP + enforcement en router

## Contexto

ADR-0002 decidió que el policy module naciera como **módulo interno** que el cerebro importa, extrayéndose a servicio "cuando llegue multi-finca". ADR-0019 (2026-08-17) redefinió la actuación: los expertos hablan **directo con el portero** vía un "MCP de comandos" con validación dura en código. Un módulo interno del proceso OpenClaw no puede exponerse como MCP server a N agentes con rate limits propios ni ser consultado por la PWA sin LLM: el empaquetado de ADR-0002 ya no servía, aunque su regla central (portero = dueño único de actuadores) sigue intacta.

Fase 3 además necesita cerrar dos agujeros del diseño anterior:

1. En Fase 0 el sim "actuaba de portero" (HA publicaba `request/set` y el fierro obedecía). Con el portero real, ese atajo viola la regla de dueño único.
2. Nada impedía que cualquier publicador con acceso al broker emitiera `cmd` directo al actuador saltándose la validación.

## Decisión

### 1. El portero es un servicio de dominio: `services/policy`

Mismo patrón que `services/finance`: proceso propio en docker-compose, MCP StreamableHTTP (`terra-policy`, :7762) para el cerebro, HTTP con token para la PWA, consumer MQTT, dueño único de las tablas `action_requests` y `work_orders`. La extracción que ADR-0002 postergaba queda hecha desde el nacimiento: el trigger de multi-finca ya no exige refactor, solo réplica.

Herramientas MCP: `propose_action`, `approve_action`, `reject_action`, `list_pending_actions`, `list_action_history`, `create_work_order`, `complete_work_order`, `list_work_orders`.

### 2. Validación dura en el portero (determinística, cero LLM)

Por clase de acción (config en código, límites de especie leídos de `crop_profiles`):

| Clase | Dispositivos | Autonomía inicial | Confianza mínima (ADR-0010) |
|---|---|---|---|
| `fill_water` | valve-fill-01 | autónoma | level ≥ 80 |
| `recirculate` | pump-recirc-01 | autónoma | level ≥ 50 |
| `dose_nutrient` | doser-a/b-01 | supervisada (aprobación humana) | ec ≥ 70 |
| `dose_ph` | doser-ph-01 | supervisada | ph ≥ 70 |

Reglas por propuesta: ventana horaria (maquinaria lista, default sin restricción, override por env), techo duro físico (no dosificar con EC ≥ ec_max + 0.5, no rellenar con tanque ≥ 95%), dosis máxima por evento, rate limit por clase+módulo, serialización (una pendiente por actuador), salud del módulo (`blind`/`offline` → rechazo: en oficina, cero comandos). Confianza insuficiente no rechaza: responde `needs_data` y **activa la recolección** (publica `request/read` al sensor correspondiente).

Autonomía gradual: la tabla de arriba es el punto de partida (relleno primero, dosificación supervisada). Liberar una clase = cambiar su `autonomy`, decisión humana registrada en PR.

### 3. Enforcement en el router (defensa en profundidad)

El router de identidad pasa a ser el **punto de enforcement del contrato**:

- `cmd` interno → dispositivo solo si el payload trae `policy_id` no vacío. Comando sin portero jamás llega al actuador.
- `request` con `set|start|stop` hacia actuadores ya **no se traduce**: el portero la intercepta, valida y emite `cmd`. Solo `read|capture|calibrate` pasan directo.
- El firmware/emulador, como segunda valla, ignora `cmd` sin `policy_id`.

### 4. Aprobación humana dual: chat y botón

- **Chat**: la propuesta pendiente llega al orquestador vía bridge (`/policy-event`); el humano responde y el orquestador llama `approve_action`/`reject_action`. El LLM transmite la decisión humana; la validación dura sigue siendo código.
- **Botón PWA (CERO LLM)**: la PWA lista pendientes y aprueba/rechaza por HTTP al portero con `POLICY_ADMIN_TOKEN` (primer write de la PWA, previsto en su placeholder de Fase 1).

Ambos canales ejecutan la misma re-validación al aprobar (la confianza pudo decaer mientras el humano decidía).

### 5. Órdenes de trabajo manuales sin canal MQTT nuevo

Las acciones manuales (podar, mezclar nutrientes) viven en `work_orders` (DB) y se entregan por chat vía bridge (mismo patrón webhook que las automations de OpenClaw). Confirmación humana → `complete_work_order` → registro. El bus se reserva para telemetría y actuación.

### 6. Verificación cruzada en el watchdog

El watchdog observa `cmd` y exige efecto físico: dosificar → EC sube; rellenar → nivel sube; recircular → caudal > 0. Sin efecto en la ventana (`VERIFY_WINDOW_MS`, default 15 min) → alerta `critical verification_failed` con `policy_id` en el detalle, historificada vía Telegraf.

## Consecuencias

- Positivas: actuación end-to-end auditable (`action_requests` con trigger de transiciones y no-delete); humano e IA validados por el mismo código; la PWA aprueba sin LLM; el contrato se auto-defiende en el router aunque un publicador rogue emita `cmd`.
- Negativas: el portero entra al camino crítico junto al router (si cae, los botones de HA no actúan — aceptado: es el freno de mano por diseño, ADR-0010); dos tokens más que operar (`POLICY_ADMIN_TOKEN`).
- Humano en modo manual con sensores caídos: las mismas reglas lo frenan (igualdad de solicitantes, ADR-0009). El override físico son los interlocks de edge (Fase 5), no software.

## Referencias

- Contrato: `contract/asyncapi.yaml` v0.6.0 (cmd dispositivo, interceptación de request, `verification_failed`).
- DB: `infra/db/migrations/005-fase3.sql` (`action_requests`, `work_orders`).
- Servicio: `services/policy/`. Enforcement: `router/`. Verificación: `services/watchdog/src/verify.ts`.
