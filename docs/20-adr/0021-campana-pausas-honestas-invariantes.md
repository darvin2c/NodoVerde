---
type: adr
title: "ADR-0021: Campaña con pausas honestas, invariantes gobernadas por dueño y registro de campaña"
description: Fase 4 corre con apagados declarados (reloj de datos como referencia de frescura); cada servicio dueño valida su invariante y publica al topic alert; alerta corregida no invalida la fase; cron determinístico contabiliza tokens; tabla campaigns materializa el registro exigido por ADR-0012
tags: [adr, campaña, invariantes, confianza, reloj-de-datos, tokens, fase4]
created: 2026-08-18
status: aceptado
amplia: ADR-0004, ADR-0010, ADR-0011
---

# ADR-0021: Campaña con pausas honestas e invariantes gobernadas

## Contexto

La revisión previa a Fase 4 (discusión 2026-08-18) encontró tres contradicciones y tres gaps:

**Contradicciones:**
1. ROADMAP citaba el escalonamiento de ADR-0012 (expertos en Fase 3-4, orquestador como único canal al portero) — ya superseded por ADR-0019 (expertos desde Fase 1, directos al portero). La matriz de dueños arrastraba la misma fila obsoleta.
2. ROADMAP exigía "campaña sin violación de invariantes" mientras el plan de pruebas decía "alertas, no pass/fail" — el criterio de salida era indecidible. Y la invariante "presupuesto de tokens" no tenía número ni fuente de datos.
3. El ROADMAP asignaba las invariantes de campaña a "watchdogs" genéricos, colisionando con la regla 1 (un dueño por función): las tres invariantes pertenecen a tres dominios distintos.

**Gaps:**
4. La invariante "cero comandos sin policy" era ciega: el router descartaba `cmd/` sin `policy_id` solo con `console.warn` (sin señal en el bus).
5. El gasto de tokens lo mide OpenClaw (único que recibe `usage` de la API), pero nada lo extraía hacia el ledger ni hacia una métrica.
6. La consecuencia vigente de ADR-0012 ("cada campaña registra en DB versión de perfil y estado de memoria del experto") no tenía implementación ni estaba listada en Fase 4.

Además, el operador planteó correr la campaña en una workstation que se apaga de noche. Las pausas no son una concesión: **replican los cortes de luz/red de una finca real** y ejercitan la matriz de degradación de ADR-0010 (reincorporación, modo oficina activa). Pero el análisis encontró un bug latente: `services/confidence` y `services/watchdog` calculan frescura mezclando reloj real (`Date.now()`) con timestamps de reloj sim — con cualquier pausa, el desfase crece permanentemente, la confianza colapsa y el portero bloquea todo. `mcp-domain` ya resolvió este problema con el "reloj de los datos" (`max(reloj servidor, último dato)`).

Se descartó acelerar la campaña (100:1 o dinámico): contradice ADR-0004 ("1:1 para campaña, Nx para tests"), duplica lo que ya cubre el E2E acelerado de nivel 3, y elimina exactamente lo que Fase 4 existe para medir — los ritmos humanos reales (reporte 07:00, alertas nocturnas, latencia de respuesta, revisión semanal de memoria).

## Decisión

### 1. Campaña con pausas honestas (enmienda parcial a ADR-0004)

- La campaña de Fase 4 corre en la workstation del operador y **admite apagados declarados**. La métrica de la campaña son ~45 días de reloj sim (un ciclo de lechuga).
- Las pausas son **parte del protocolo de prueba**, no violaciones: apagados totales nocturnos + al menos una caída parcial semanal del sim con el stack vivo (ejercita modo oficina activa puro, ADR-0010 §4).
- **El sim hace catch-up al reanudar** (refinamiento de implementación, 2026-08-18): como una finca real durante un corte de luz, el mundo *sigue viviendo* la pausa — al arrancar, el sim integra la física del hueco (mismo paso de 1 s, misma semilla) y su reloj se resincroniza con el real. La alternativa (mundo congelado) dejaba las lecturas nuevas permanentemente "viejas" respecto al reloj real y la confianza nunca se recuperaba. Con catch-up, los servicios no cambian su cálculo de frescura: la confianza cae durante la pausa (honesto: no había datos), el portero bloquea actuación hasta datos frescos, y la recuperación ocurre sola al llegar lecturas nuevas.
- Al arrancar tras una pausa, el watchdog detecta el hueco (DB `max(time)` de telemetría vs ahora) y publica una **alerta `data_gap`** (inicio/fin/duración) para que el reporte del agente declare la ausencia automáticamente ("sin datos de 23:10 a 07:02") en vez de depender de que el LLM lo note. Ausencia de dato ≠ dato cero (ADR-0010).

### 2. Invariantes de campaña: cada dueño valida lo suyo

Ningún servicio nuevo, ningún segundo dueño. Cada invariante vive donde viven sus datos y **publica violaciones al topic `alert` existente** (Telegraf ya lo historifica; el bridge ya despierta al cerebro):

| Invariante | Dueño que valida | Señal |
|---|---|---|
| Todo movimiento con categoría + moneda + imputación 100% | **finance** (dueño del ledger, ADR-0011) | alerta `invariant_ledger` |
| Cero comandos sin policy | **router** (único que ve el descarte) | alerta `cmd_sin_policy` al descartar `cmd/` sin `policy_id` (hoy solo `console.warn`) |
| Presupuesto de tokens | **cron de tokens** (§4) | alerta `budget_tokens` al superar el techo |

Watchdog y Grafana solo visualizan/alertan umbrales — no conocen reglas de dominio ajeno. Los nombres de alerta nuevos entran al contrato AsyncAPI en el mismo commit que su código (regla 3).

### 3. Ciclo de vida de alertas y criterio de salida decidible

- Toda alerta de invariante lleva estado **pendiente/resuelta** (resolución registrada por el humano o por el propio chequeo al dejar de cumplirse la violación).
- **Criterio de salida de Fase 4:** campaña completa (45 días de sim) con **cero alertas de invariante sin resolver al cierre**. Una violación detectada y corregida (ej: movimiento anulado + recreado según ADR-0011) no invalida la fase — premia corregir sobre nunca fallar.

### 4. Contabilidad de tokens: cron + herramienta determinística

- Un cron del stack consulta el usage al gateway OpenClaw **por superficie soportada** (CLI del contenedor o API del gateway — jamás su SQLite interno, ADR-0018 prohíbe acoplar a internals de la imagen pineada).
- El costo se calcula **en código** con tabla de precios (cero aritmética de LLM, ADR-0011) y se registra como movimiento diario categoría `software` vía el MCP de finanzas — cumple la promesa pendiente de Fase 2 ("el agente se auto-contabiliza") y alimenta el costo por kg.
- Techo en **USD/mes**, valor en configuración; se calibra con 1-2 semanas de datos reales de la campaña. La alerta `budget_tokens` no bloquea nada — informa (ADR-0010: el freno de mano es la confianza, no el gasto).

### 5. Registro de campaña (materializa ADR-0012)

- Tabla `campaigns` (prefijo de dominio, con `tenant_id`): cultivo, módulos, **hash del perfil YAML**, **snapshot/hash de la memoria del experto**, fechas de inicio/cierre, estado.
- Herramientas MCP `open_campaign` / `close_campaign` en el servicio de dominio; los hashes se calculan en código al abrir/cerrar.
- Esto hace comparable la destilación de lecciones entre ciclos y **formaliza el trigger** del backlog "learning loop" (≥1 campaña de decisiones registradas): las decisiones son el audit del portero vinculado a la campaña abierta.

## Consecuencias

- La campaña se vuelve a prueba de apagones y, a la vez, banco de pruebas de la reincorporación (gap → honestidad → confianza baja → portero exige recolección → recuperación) — el escenario exacto del piloto de Fase 5 en Lambayeque.
- El criterio de salida de Fase 4 pasa de juicio ambiguo a chequeo decidible: `SELECT count(*) FROM alertas_invariante WHERE estado='pendiente'` al cierre.
- ROADMAP, plan de pruebas y matriz de dueños se actualizan en este mismo commit para eliminar las contradicciones 1-3.
- Prerequisitos de código antes del día 1 de campaña: catch-up del sim al reanudar, alerta `data_gap` en watchdog, alerta `cmd_sin_policy` en router, cron de tokens, tabla `campaigns`, chequeo `invariant_ledger` en finance. Todo verificable con tests acelerados (nivel 2-3), sin esperar 45 días.
- Riesgo aceptado: el catch-up integra la física del hueco sin capa de sensores — las lecturas del hueco no existen (honesto) y el estado físico post-pausa es una integración grosera, no una medición.
