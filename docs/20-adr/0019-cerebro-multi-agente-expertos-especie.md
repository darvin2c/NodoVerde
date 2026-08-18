---
type: adr
title: "ADR-0019: Cerebro multi-agente — orquestador + expertos por especie con acceso directo al portero"
description: Un gateway OpenClaw con agentes nativos por especie (memoria/skills/cron propios); los expertos hablan directo con el portero (validación dura en la herramienta, límites de especie como datos); aprobación humana sin LLM
tags: [adr, multi-agente, openclaw, portero, memoria, ciclo-de-vida]
created: 2026-08-17
status: aceptado
amplia: ADR-0001
supersede-parcial: ADR-0012 (el orquestador deja de ser el único canal al portero; los expertos entran en Fase 1, no en Fase 3-4)
---

# ADR-0019: Cerebro multi-agente — orquestador + expertos por especie

## Contexto

ADR-0012 definió orquestador + expertos por cultivo, pero con dos decisiones que la discusión de diseño (2026-08-17) demostró incorrectas:

1. **"Solo el orquestador habla con el portero"** — pone un LLM de mensajería entre el experto y la actuación: costo de tokens y latencia que **no agrega seguridad** (la seguridad viene del portero, que es código determinístico, no de otro LLM reenviando propuestas).
2. **Expertos diferidos a Fase 3-4** — postergar los expertos contamina la memoria del orquestador con conocimiento de cultivo que no le pertenece (viola "un dueño por función") y retrasa la acumulación del activo más valioso: la memoria experiencial por especie.

Además se verificó el diseño completo contra la documentación oficial de OpenClaw (docs.openclaw.ai, v2026.7.x): **todas las primitivas necesarias existen nativamente** — cero plugin custom, cero fork.

## Decisión

### Agentes (primitivas nativas verificadas)

Un solo gateway OpenClaw con agentes aislados (`agents.entries`):

- **Orquestador (`main`)**: único con bindings a canales (WhatsApp/Telegram) → **única voz al humano**. Contexto de finca completa. Consulta a expertos 1-2 veces/día vía `sessions_spawn(agentId)` (gateado por `subagents.allowAgents`).
- **Experto por especie** (`experto-lechuga`, `experto-tomate`, ...): workspace propio (SOUL/MEMORY propios), session store propio, **skills propias** (`agents.entries.*.skills` — reemplazo, no merge), **modelo propio elegido por capacidad, nunca por precio** (`agents.entries.*.model`).
- **Expertos sin bindings** → inalcanzables desde canales. **`tools.allow/deny` por agente** les niega `message`/`exec` a nivel plataforma: "proponen, no hablan" deja de ser disciplina de prompt y pasa a ser jaula de configuración.

### Autonomía de expertos

Cada experto tiene **su propio ritmo** (no espera a que lo consulten):
- `openclaw automations create ... --agent experto-<especie>`: cron por agente.
- Alertas del watchdog enrutadas por cultivo: el bridge publica al hook con `agentId` del experto dueño (restringido por `hooks.allowedAgentIds`).
- Notificación de anomalías: experto → webhook de su automation → bridge → hook con `agentId: main` → el orquestador decide qué le dice al humano. **El humano siempre habla con una sola boca.**

### Actuación: experto → portero directo (supersede ADR-0012)

```
experto → tool del portero (MCP de comandos) → validación DURA en código
        → dentro de límites: publica cmd/ + audit
        → fuera de límites o no trivial: aprobación humana por botón (PWA/HA, CERO LLM)
        → telemetría confirma efecto (verificación cruzada) → audit
```

- **La validación vive dentro de la herramienta de actuación**, no en la skill. Una skill es contexto de LLM (ignorable/inyectable); la jaula debe estar en el código que publica `cmd/`.
- **El portero es agnóstico de especie porque los límites de seguridad son físicos**, no agronómicos: dosis máxima por evento, interlocks (bomba, válvula), techos absolutos de EC/pH, rate limit por agente, serialización de actuadores compartidos. Lo que sí es de especie (rango EC objetivo, tasa de cambio tolerada) son **datos en `crop_profiles`**, no código: el portero los lee al validar. Nueva especie con restricción especial = columna nueva en el perfil, no código nuevo ni portero nuevo.
- El orquestador **no está en el camino de actuación**; se entera por el audit para responder "qué pasó hoy".
- Intacto: regla 4 (el LLM nunca toca actuadores sin policy module), ADR-0002 (portero), ADR-0009 (órdenes humanas por `request/`, validadas igual).

### Granularidad y variedades

- **La expertise es de la especie; las diferencias entre instancias son datos.** `experto-lechuga` cubre N módulos; lechuga romana vs hoja son dos filas en `crop_profiles` (`modules.crop → crop_profiles.name` ya lo soporta).
- El experto gana **aprendizaje cruzado**: ve todas las instancias de su especie y puede comparar ("mod-1 va más lento que mod-4 con el mismo perfil → algo físico en mod-1").
- **Regla de formato de memoria**: todo aprendizaje se registra con módulo/variedad/fecha. Dos módulos con el mismo cultivo pueden comportarse distinto; mezclar observaciones corrompe la memoria. Formato fijo además hace fusiones futuras baratas.

### Ciclo de vida de expertos (siempre con aprobación humana)

| Operación | Mecanismo |
|---|---|
| Crear | `openclaw agents add` — si lo pide otro agente, OpenClaw exige aprobación del operador (nativo) |
| Fusionar (lechuga+acelga+espinaca → "hojas-verdes") | El nuevo experto destila las memorias viejas (Markdown auditable; `memory promote` rescata lo no destilado de sesiones); el humano revisa el diff y aprueba |
| Dividir (una variedad diverge) | Nuevo workspace; memoria heredada por `memory.search.extraPaths`, curada |
| Retirar | `openclaw agents delete` — workspace a Trash, memoria preservada como referencia |

Las sesiones (SQLite) no son portables entre agentes; el conocimiento valioso vive destilado en Markdown (sesión = trabajo sucio, memoria = lo aprendido).

### Dominios futuros

El patrón generaliza a **experto por especie/dominio**, no solo cultivo hidropónico: `experto-cuy`, `experto-vaca` (granja) son el mismo patrón con datos nuevos (perfiles, sensores, skill Markdown), sin arquitectura nueva. **Regla de admisión: nada ganadero se construye hasta que exista una granja real.**

## Verificación contra documentación oficial (2026-08-17)

| Necesidad | Primitiva | Doc |
|---|---|---|
| Agentes aislados en un gateway | `agents.entries`, workspace/agentDir/sesiones por agente | /concepts/multi-agent |
| Memoria aislada + compartida explícita | default aislado; `memory.search.extraPaths` | /concepts/multi-agent |
| Skills por agente | `agents.defaults.skills` + `agents.entries.*.skills` | /tools/skills-config |
| Jaula de herramientas por agente | `agents.entries.*.tools.allow/deny` | /tools/multi-agent-sandbox-tools |
| Orquestador consulta experto | `sessions_spawn(agentId)` + `subagents.allowAgents` | /tools/subagents |
| Cron por agente | `automations create --agent <id>` | /automation/cron-jobs |
| Alertas → experto correcto | hooks con `agentId` + `hooks.allowedAgentIds` | /automation/hooks |
| Experto → orquestador sin message tool | delivery de automation a webhook → bridge → hook | /automation/cron-jobs |
| Modelo por agente | `agents.entries.*.model`, `modelPolicy.allow` | /gateway/config-agents |
| Ciclo de vida | `agents add/delete` (aprobación operador), `memory promote --agent` | /cli/agents, /cli/memory |
| MCP de dominio | `mcp.servers` | /gateway/config-tools |

Detalles operativos descubiertos: (1) si un experto se sandboxea, sus tools MCP requieren `terra-domain__*` en `tools.sandbox.tools` o queda ciego silenciosamente; (2) auth es por agente — las API keys estáticas se siembran al crear cada agente en modo headless.

## Consecuencias

- Positivas: el experto actúa con la latencia y el costo mínimos posibles sin ceder seguridad; la jaula es código y config de plataforma, no prompts; la memoria por especie empieza a acumular desde Fase 1; agregar especie/dominio es config + datos, nunca código.
- Negativas: N expertos hablando directo al portero exigen rate limits por agente y serialización de compartidos en el portero (código, barato); la supervisión de N agentes exige disciplina de revisión de memorias.
- Riesgo aceptado: un experto glitcheado/inyectado puede *solicitar* actuaciones — mitigado por validación dura del portero, rate limits, aprobación humana para lo no trivial y audit completo.
