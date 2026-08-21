---
type: adr
title: "ADR-0025: Flujo lote-céntrico — el cultivo pertenece al lote; la actuación biológica exige lote activo"
description: Congela el flujo operativo de punta a punta decidido en la fase de discusión — la mesa (módulo) es infraestructura fungible sin cultivo propio; el cultivo, las fechas y la actividad productiva existen solo dentro de un lote; el portero bloquea dosificación sin lote activo; el sim solo cultiva donde hay lote. Anota el error de diseño de sensores compartidos (estación climática) como corrección diferida
tags: [adr, lotes, flujo, modulo-fungible, policy, sim, fase4]
created: 2026-08-21
status: aceptado
---
# ADR-0025: Flujo lote-céntrico — el cultivo pertenece al lote; la actuación biológica exige lote activo

- **Estado**: aceptado (2026-08-21). Supersede **parcialmente** al ADR-0022: el módulo deja de tener cultivo propio (`modules.crop` pasa a ser caché mantenido por el ciclo del lote); el resto del ADR-0022 (id técnico, nombre humano, claiming, retiro gobernado) sigue vigente.
- **Contexto**: fase de discusión posterior al ADR-0024. El dueño detectó que el sistema seguía operando "por módulos" cuando la actividad real es "por lotes".

## Problema

El sistema tenía el cultivo en dos sitios y permitía operar sin ciclo vivo:

1. **`modules.crop` como fuente de verdad** — la mesa "era de lechuga" aunque estuviera vacía. Biológicamente falso: una mesa vacía no es de nada. La mesa es fierro permanente; la lechuga vive 45 días. Lo que vive 45 días no puede ser propiedad de lo permanente.
2. **Fuente dual** — el cultivo existía en `modules.crop` y en `lotes.crop`, validados solo al abrir el lote.
3. **Actuación sin ciclo** — el portero validaba rangos de cultivo del módulo, permitiendo dosificar una mesa sin nada plantado (tirar insumo).
4. **El sim divergía del sistema** — el mundo tenía plantas por config propia, aunque el sistema no tuviera lote abierto: el gemelo dejaba de ser gemelo.

## Decisión

### Principio 1 — la mesa es infraestructura fungible

El módulo es solo el nombre lógico de un lugar físico (mesa hoy; corral/jaula mañana). No tiene cultivo. Se crea con nombre y nada más. Mesa Norte hoy lechuga, mañana tomate: la mesa no cambia, la vida que aloja cambia.

### Principio 2 — el cultivo pertenece al lote

El cultivo existe solo dentro de un lote vivo. `modules.crop` se convierte en **caché derivado nullable**:
- `open_batch` escribe el cultivo en los módulos que ocupa.
- `close_batch` lo limpia a `NULL` (= libre, sin cultivo).
- **Nadie más escribe `modules.crop`**: `create_module`/`update_module` ya no aceptan cultivo; el supervisor del sim pierde su backdoor de `UPDATE modules SET crop`.

### Principio 3 — la única forma de iniciar actividad es abrir un lote

Sin lote activo en la mesa:
- **Actuación biológica bloqueada** por el portero: `dose_nutrient` y `dose_ph` se rechazan — no hay planta que alimentar ni rango que defender.
- **Actuación de fierro permitida**: bomba, válvula de relleno, aireador (mantenimiento, preparación, pruebas tras instalar). El portero sigue validando seguridad física.
- **Sin rangos biológicos**: watchdog/reporte no calculan desvíos EC/pH para esa mesa; declaran "sin lote activo" (honesto, ADR-0010). La infraestructura se sigue vigilando: silencios, sensores pegados, niveles.
- **Preparación de solución antes del trasplante**: se hace con el lote ya abierto — así todo gasto de arranque queda imputado al ciclo desde el primer sol.

### Principio 4 — el sim cultiva solo donde hay lote

El mundo simulado es coherente con el sistema: el motor lee los lotes abiertos y solo esos módulos tienen planta (consumo de nutrientes, crecimiento). Mesa sin lote = solución circulando sin planta: la EC no cae por consumo, la ET no aplica. Cerrar un lote = cosechar: la planta desaparece del mundo.

### Principio 5 — toda la data operativa se ingresa desde la PWA

La PWA es el mostrador del humano: perfiles de cultivo (crear/editar), módulos (crear sin cultivo), lotes (abrir/cerrar), fincas. Perfiles cambian solo por humano (regla 9, ya vigente) — la PWA ES el humano. El MCP dominio gana `create_crop_profile`/`update_crop_profile` como escritura gobernada.

### Corrección diferida (anotada, no implementada)

**Sensores compartidos**: hoy todo device se amarra a UNA mesa y el seed finge un `climate-01` por mesa. Físicamente falso: la estación climática es una por invernadero y sirve a todas las mesas. Fix pendiente: claim a nivel invernadero/finca, un solo dueño publica y todas las mesas leen; si cae, todas pierden el dato a la vez (verdad física). Trigger: antes del piloto de hardware real (Fase 5). Registrado en ROADMAP backlog.

## El flujo completo (inicio a fin)

```
1. El humano crea PERFIL de cultivo en la PWA (si es nuevo)     → crop_profiles
2. El humano crea MESA en la PWA (solo nombre)                  → modules (crop NULL)
3. El humano vincula el fierro de la mesa (claim)               → device_identities
4. El humano ABRE LOTE: cultivo + mesas libres + etiqueta       → lotes; modules.crop = cultivo
5. El sim cultiva en esas mesas (planta crece, consume)         → telemetría MQTT → DB
6. Watchdog/confianza vigilan rangos DEL LOTE en esas mesas     → alertas si desvío
7. El cerebro reporta POR LOTE; propone acciones si algo deriva
8. El portero valida: ¿lote activo? ¿en rango? ¿quién pide?     → cmd/ o rechazo
9. Gastos se imputan al ciclo                                   → movements
10. Cosecha: el humano CIERRA LOTE con razón                    → modules.crop = NULL
11. El experto destila lecciones del ciclo cerrado              → MEMORY.md + hashes
```

Mesa libre entre ciclos: solo vigilancia de infraestructura (¿sensores respiran? ¿hay fuga? ¿nivel?). El gap entre lotes queda grabado gratis (barbecho medible).

## Consecuencias

- **Una sola fuente de verdad del cultivo**: el lote. La rotación queda registrada ("Mesa Norte lleva 3 lechugas seguidas" → riesgo de patógenos acumulados).
- **Finanza histórica protegida**: los reportes de costo resuelven el cultivo de un movimiento por la **ventana del lote** que ocupaba el módulo en ese momento — cerrar un lote no borra la historia.
- **Escala a pecuario**: corral = módulo, pollada/piara/lactancia = lote. Sin excepciones.
- **Costo aceptado**: mesa libre no tiene rangos en Grafana ni % en rango en reportes — es la verdad (no hay planta).

## Verificación

- Tests mcp-domain: `open_batch` escribe cultivo en módulos; `close_batch` lo limpia; `create_module` sin cultivo; módulo libre entra a lote de cualquier cultivo.
- Test policy: dosificación sin lote activo → rechazo `no_active_batch`.
- Test sim: módulo sin lote no consume nutrientes (EC estable); con lote sí.
- E2E navegador: crear perfil + crear módulo + abrir lote con cualquier mesa libre + cerrar → mesa libre otra vez.
