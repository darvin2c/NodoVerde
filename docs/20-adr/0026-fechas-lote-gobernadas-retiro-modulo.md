---
type: adr
title: "ADR-0026: Fechas del lote gobernadas por el humano + retiro de módulo sin cerrar el lote"
description: El inicio del ciclo lo declara el humano (pasada = registro tardío, futura = programación) y la cosecha tentativa es overrideable — el cálculo inicio + cycle_days es solo la sugerencia. Se puede retirar un módulo de un lote sin cerrarlo; la última mesa no se retira, se cierra el lote. Mesa ocupada no acepta nada, ni a futuro. Las fechas del lote son reloj de pared — tensión con el reloj acelerado del sim anotada
tags: [adr, lotes, fechas, produccion, pwa, fase4]
created: 2026-08-21
status: aceptado
---
# ADR-0026: Fechas del lote gobernadas por el humano + retiro de módulo sin cerrar el lote

- **Estado**: aceptado (2026-08-21). Complementa ADR-0024 (lotes) y ADR-0025 (flujo lote-céntrico).
- **Contexto**: fase de discusión sobre la apertura de lotes en la PWA. Hasta aquí `started_at` era siempre `now()` y la cosecha esperada solo se veía *después* de abrir.

## Problema

1. **El reloj biológico no arranca en el clic** — el trasplante ocurre en la mesa; el registro en la app puede ser horas o días después. Forzar `started_at = now()` hace nacer cada ciclo con error.
2. **La planificación necesita futuro** — programar una siembra/trasplante de la semana próxima es operación normal.
3. **La cosecha calculada era rígida** — `inicio + cycle_days` sin vuelta: la realidad (clima, variedad, mercado) mueve la fecha.
4. **Cambiar de cultivo en UNA mesa exigía cerrar el lote entero** — un lote multi-mesa moría completo aunque solo una mesa hubiera terminado.

## Decisión

1. **Inicio elegible** — `open_batch` acepta `started_at`: pasada (registro tardío), hoy (default) o futura (programación). Sin límite en ninguna dirección: el dato declarado por el humano es honesto (ADR-0010).
2. **Cosecha tentativa visible antes de confirmar + override manual** — la PWA muestra en vivo `inicio + cycle_days` mientras se llena el formulario; el humano puede ajustar la fecha. El cálculo del perfil es la sugerencia inicial, no la verdad. Validación dura: `expected_end_at > started_at`.
3. **Lote programado ocupa desde ya** — un lote con inicio futuro bloquea sus mesas desde el momento de creación (sin reservas ni cola: es un lote abierto más). En la UI se muestra "programado · inicia en N días", nunca "día -7".
4. **Mesa ocupada = bloqueada total** — no se abre ni programa nada sobre una mesa con lote activo, sin importar fechas. La mesa se libera al cerrar el lote o al retirarla de él.
5. **Retiro de módulo sin cerrar el lote** — `remove_module_from_batch` saca una mesa del lote (el lote sigue con las restantes; la mesa queda libre). Regla dura: **la última mesa no se retira** — un lote sin mesas no existe; para eso está `close_batch`.
6. **Perfil congelado, sin excepciones** — cambiar de cultivo/perfil a mitad de ciclo no existe: se retira la mesa (o se cierra el lote) y se abre uno nuevo. (Reafirma ADR-0024.)

## Consecuencias

- **Sim**: el supervisor solo siembra plantas de lotes ya iniciados (`started_at <= now()`) — un lote programado no germina antes de tiempo.
- **Portero**: dosificar en una mesa con lote programado queda permitido — preparar la solución nutritiva antes del trasplante es práctica real.
- **Tensión anotada (reloj)**: las fechas del lote son reloj de pared; el sim corre acelerado (`--speed N`). En simulación acelerada las fechas de ciclo pierden sentido físico; en operación real (Fase 5) el reloj de pared es el correcto. No se resuelve aquí — se acepta.
- `expected_end_at` sigue congelado al abrir: editar el perfil a mitad de ciclo no mueve lotes existentes (ADR-0024). El override manual se da en la apertura; cambiarlo después no está soportado (cerrar y reabrir).

## Verificación

- Tests de lógica pura en `services/mcp-domain/test/modules.test.ts`: `computeExpectedEnd` (override gana, inicio+cycle_days, perfil sin ciclo → null) y `canRemoveModuleFromBatch` (retiro normal, string JSONB, última mesa rechazada, módulo ajeno, modules corrupto).
- E2E navegador: abrir lote con fecha pasada / futura / override de cosecha; timeline muestra "programado"; retirar mesa de lote multi-mesa deja la mesa libre y el lote vivo.
