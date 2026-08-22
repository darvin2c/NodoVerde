---
type: adr
title: "ADR-0027: Captura financiera omnicanal — dos niveles (finca/módulo), lote derivado, imputación en montos, evidencia probatoria y numeración de operación"
description: Refina ADR-0011 — la imputación se expresa en montos que suman el total (no porcentajes); dos niveles de captura (finca general / módulos) con snapshot del lote activo por elemento; traza de procedencia obligatoria (channel, raw_payload, occurred_at); evidencia multi-archivo en tabla hija sobre MinIO; op_number MOV-NNNN y external_ref como dedup fuerte; edición = anulación + recreación; la PWA es la tercera puerta del mismo dueño
tags: [adr, finanzas, captura, evidencia, lotes, pwa, fase4]
created: 2026-08-21
status: aceptado
---
# ADR-0027: Captura financiera omnicanal — dos niveles, lote derivado, montos, evidencia y trazabilidad

- **Estado**: aceptado (2026-08-21). Refina el ADR-0011 (sigue vigente en lo demás: historia inmutable, LLM jamás hace aritmética, dedup, categorías, auto-registro desde actuadores). Compatible con ADR-0024/0025: la campaña jamás se captura — se agrega.
- **Contexto**: fase de discusión con el dueño sobre llevar finanzas a sección propia de la PWA con captura estructurada, evidencia y trazabilidad de origen.

## Decisión

### 1. Dos niveles de captura: finca (general) o módulos

```
movements.scope: 'finca' | 'modulos'
```

- **`finca`** (default): gasto/ingreso general — alquiler, internet, equipos, venta sin lote claro. `attribution` es NULL. Los reportes lo declaran como "general de finca", jamás lo fuerzan a un lote.
- **`modulos`**: `attribution` es un array de elementos por módulo. Reparto asistido: el sistema propone partes iguales, el humano confirma o ajusta **en plata**.
- Se acabó la cascada automática: el reparto ocurre UNA vez al capturar (sistema propone, humano confirma) y queda congelado. Nada se redistribuye solo después.

### 2. La imputación se guarda en MONTOS, no en porcentajes

El humano piensa en plata ("200 al mod-1, 50 a cada uno"), no en "66.67%". Cambia el elemento de attribution:

```json
[{ "module": "mod-1", "amount": 200.00, "batch": "LOTE-0007" }]
```

- **Invariante (reemplaza "pct suma 100")**: la suma de `amount` de los elementos = `movements.amount` al céntimo. Cuadra contra el recibo; un solo redondeo (el último elemento absorbe el centavo).
- El porcentaje se deriva en reportes cuando haga falta — SQL determinístico, nunca dato almacenado que pueda desincronizarse.
- Los registros existentes migran: `amount = round(total × pct/100, 2)`, último elemento absorbe el resto.

### 3. El lote se deriva, no se pregunta

Con ADR-0025 (una mesa = máximo un lote activo), al insertar cada elemento el sistema resuelve en código el lote activo del módulo y graba el **snapshot** (`batch` = `lotes.code`):

- Reportes por lote y campaña (`GROUP BY` sobre el lote) sin ventanas frágiles ni preguntas al usuario.
- Mesa libre → `batch: null` — honesto: esa fracción no pertenece a ningún ciclo. El sistema lo advierte al confirmar ("mod-3 no tiene lote activo"), no lo bloquea (mantenimiento legítimo existe).
- Pago tardío tras cierre → mesa libre → cae a finca/módulo sin lote, declarado. El flujo natural (registrar la venta al cerrar el lote) lo evita.

### 4. Trazabilidad de procedencia obligatoria

Todo movimiento nace con la cadena "quién dijo qué, desde dónde, cuándo":

```
channel:      telegram | whatsapp | webchat | pwa | auto
created_by:   usuario de chat | "pwa" | "auto:portero" | ...
raw_payload:  texto original verbatim (o transcripción de voz) — NULL en auto
occurred_at:  fecha del gasto declarada (≠ ts, que es cuándo se grabó)
```

`occurred_at` separa la fecha económica de la de registro ("gasté 150 **ayer**"). Los reportes por mes operan sobre `occurred_at`.

### 5. Soporte probatorio: artefactos + traza

**Tabla hija `movement_evidence`** (reemplaza el campo único `evidence_url`) — un movimiento, N pruebas, **cualquier tipo de archivo** (imagen, audio, PDF, video, hoja de cálculo):

```
movement_evidence: id, movement_id (nullable → adjuntar al confirmar), tenant,
  object_key (MinIO terra-media), sha256, mime_type, size_bytes,
  kind (recibo|captura_pago|factura|audio|foto_producto|otro),
  channel, uploaded_by, uploaded_at, note
```

- Flujo chat: foto/voz al bot → upload a MinIO → `register_movement(evidence_ids=[...])` enlaza en la misma transacción. La nota de voz queda como audio **y** su transcripción en `raw_payload`.
- Flujo PWA: drag & drop multi-archivo en el formulario.
- Dedup por contenido: mismo `sha256` ya registrado → "esta foto ya está en MOV-0041".
- La evidencia **sobrevive a la anulación**: historia completa (qué se registró, con qué prueba, por qué se anuló).
- Bytes en MinIO; en DB solo metadata + referencia (matriz de dueños).

### 6. Numeración de operación y referencia externa

- **`op_number`**: correlativo humano por tenant (`MOV-0001`), contador atómico en DB. Sirve para hablar ("anula el MOV-0041") — el UUID es ilegible por chat.
- **`external_ref`**: número de operación externo (Yape/Plin/banco), opcional. Dedup fuerte: mismo `external_ref` vigente → "¿ya lo habías registrado?" antes de guardar.

### 7. Edición = anulación + recreación (UX de "Editar")

La historia sigue inmutable (regla 8, triggers DB intactos). La PWA ofrece botón "Editar": formulario pre-llenado → al guardar, el servicio en UNA transacción anula el original y crea el nuevo con `replaces → original`. La cadena queda grabada; la vista por defecto muestra solo vigentes.

### 8. Tres puertas, un dueño

| Puerta | Entra por | `source` |
|---|---|---|
| Chat (cualquier canal del cerebro) | MCP `register_movement` | `chat` |
| Formulario PWA | MCP `register_movement` vía tRPC (la PWA jamás escribe la tabla) | `pwa` |
| Actuadores (dosis) | consumer MQTT interno | `auto:doser` |

Las mismas validaciones determinísticas aplican a las tres: monto positivo, categoría válida, suma de montos = total, módulos existentes, dedup. Escrituras SOLO vía `services/finance`.

## Consecuencias

- Migración `011-finanzas-capture.sql`: columnas nuevas, reescritura de attribution pct→montos, backfill de `batch` por ventana del lote, `op_number` retroactivo, tabla `movement_evidence`, trigger de validación actualizado (scope finca admite attribution NULL; scope módulos exige suma de montos = total).
- `evidence_url` queda deprecado (se conserva la columna para historia; los nuevos van a la tabla hija).
- La invariante `invariant_ledger` se reexpresa: scope='modulos' → attribution con suma de montos = total; category y currency obligatorios.
- `cost_summary` gana `group_by: 'batch'` y resuelve cultivo por snapshot (no por ventana).
- El portero financiero, recurrentes y doble partida siguen en backlog con sus triggers (ADR-0011) — este ADR no los activa.

## Alternativas consideradas

- **Cascada automática finca→campaña→lote→módulo**: los números se moverían solos al abrir nuevos lotes y la regla de reparto sería invisible — viola el espíritu de la historia inmutable y el conocimiento honesto. El reparto es explícito y único, al capturar.
- **Campaña como nivel de imputación**: contradice ADR-0024 (etiqueta de agregación). Un gasto "de campaña" se distribuye a sus lotes al capturar.
- **Filas planas + group_id en vez del array JSONB**: SQL más simple, pero el array ya está probado y el cambio no habilita capacidad nueva; puerta de escape si los reportes escalan mal.
- **Header/líneas multi-categoría por recibo**: primer paso hacia doble partida; hoy se registran N movimientos compartiendo evidencia y `external_ref`. Backlog con trigger.

## Addendum (2026-08-22): consulta omnicanal, proveedor y costo-por-kg

Segunda vuelta del mismo ADR (no es decisión nueva: es la cara de lectura del modelo + dos campos). Migración `012-yield-supplier.sql`.

### 9. Consulta: filtros, búsqueda, paginación y agrupación

- `/finanzas` filtra por rango de fechas económicas, tipo, categoría, **campaña → lote → módulo en cascada**, con búsqueda única (`op_number`, nota, `external_ref`, autor, proveedor), paginación server-side y filtros persistentes en la URL (link compartible).
- Vista agrupada (lote/campaña/categoría) con subtotales SQL y drill-down al filtro. Export CSV respeta los filtros activos (cap 5000 filas).
- **Overhead declarado, nunca prorrateado**: al filtrar por lote/campaña/módulo, los gastos generales de finca se muestran como línea aparte ("no imputados a este lote"). Prorratear sería inventar precisión; si la decisión lo exige, se hará con regla explícita y etiquetada (backlog con trigger).
- MCP `list_movements` gana `search`, `offset`, `from/to`, `campaign`, `supplier`; `cost_summary` gana `group_by: 'campaign'`.

### 10. `supplier` (proveedor)

Columna opcional en `movements`. Habilita historial de precios por proveedor y la pregunta "¿cuánto le he comprado a X?". Sin catálogo gobernado: texto libre (un typo se corrige editando, no con una tabla).

### 11. Rendimiento y costo-por-kg

- `lotes.yield_kg`: kg cosechados declarados al cerrar el lote (nullable = honesto cuando no hay báscula). `close_batch` lo acepta; el diálogo de cierre en la PWA lo pide y muestra la **ficha del ciclo** (gasto, ingreso, margen, costo/kg).
- `costo_por_kg = gasto del lote ÷ yield_kg` lo calcula SIEMPRE código (`cost_summary` group_by batch / `filteredSummary` con filtro lote). Null si no hay rendimiento — jamás 0 inventado.

### 12. Evidencia post-hoc

`attach_evidence(movement, evidence_id)`: la evidencia subida sin movimiento (`movement_id NULL`) puede adjuntarse después. El trigger permite solo la transición NULL → UUID: la evidencia es inmutable, jamás reasignable. La PWA lo expone como botón "Adjuntar" en el detalle.

### Consecuencias del addendum

- Procedures `monthSummary`/`recentMovements`/`byCategory` de la PWA quedan reemplazados por `movements` (filtros+paginación), `filteredSummary` (KPIs+overhead+costo/kg), `groupedTotals` y `filterOptions` — eliminados, sin shims.
- `lotes` gana `yield_kg`; `movements` gana `supplier`.
- La ficha de cierre convierte `close_batch` en momento de captura: rendimiento + resumen financiero + puente a registrar la venta.

### 13. Sentinelas de grupo como filtros de primer orden (2026-08-22, UX tree-table)

La vista agrupada de la PWA es una tabla-árbol (TanStack Table): las filas de grupo llevan subtotales SQL y se expanden mostrando sus movimientos. Para que el grupo "sin lote" / "sin campaña" sea navegable como cualquier otro, `financeWhere` acepta los sentinelas `batch=sin_lote` (atribución sin batch — overhead de finca) y `campaign=sin_campana` (lotes sin etiqueta o sin batch), y `groupedTotals` los emite como claves estables. Antes de esto el overhead de finca era invisible en la vista por lote: no se podía filtrar ni expandir. Sort server-side por columna (`sortBy`/`sortDir`: occurred_at, amount, op_number, category) con whitelist estricta.
