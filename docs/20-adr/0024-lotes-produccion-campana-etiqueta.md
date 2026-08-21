---
type: adr
title: "ADR-0024: Lotes de producción — el ciclo biológico es la entidad; la campaña es etiqueta"
description: Reemplaza el registro de campañas del ADR-0021 por el modelo fábrica — lote (programa + módulos + fechas propias) como única entidad con ciclo de vida, y campaña degradada a etiqueta lógica libre para agregación contable. La restricción física vive en el módulo, no en la finca
tags: [adr, lotes, campaña, producción, multi-cultivo, pecuario, fase4]
created: 2026-08-21
status: aceptado
---
# ADR-0024: Lotes de producción — el ciclo biológico es la entidad; la campaña es etiqueta

- **Estado**: aceptado (2026-08-21). Supersede **parcialmente** al ADR-0021: su "registro de campaña" (tabla `campaigns`, `open/close_campaign`) queda reemplazado por este modelo; sus pausas honestas, invariantes por dueño y cron de tokens siguen vigentes.
- **Contexto**: la fase de decisión pre-Fase 4 expuso tres errores de concepto en el modelo de campañas del ADR-0021.

## Problema

El modelo `campaigns` (una abierta por tenant, un solo cultivo, módulos auto-derivados y congelados) no representa la realidad agrícola ni pecuaria:

1. **Restricción en el nivel equivocado** — "una campaña abierta por finca" prohíbe lechuga y tomate en paralelo en la misma finca, algo que la propia finca demo ya hace. La restricción física real es del **módulo** (una mesa solo aloja un lote a la vez), no de la finca.
2. **No representa el escalonado** — la hidroponía profesional trasplanta semanalmente: tres lotes de lechuga en distinta etapa son tres ciclos con fechas propias, no una campaña monolítica. En pecuario es peor: las lactaciones se solapan todo el año y no hay "temporada".
3. **Módulos derivados y congelados** — `open_campaign` metía todos los módulos con ese cultivo y ninguno nuevo podía entrar después.

Además, en el campo "campaña" significa *temporada* ("campaña de invierno"): un contenedor temporal para comparar márgenes entre años, no un ciclo biológico.

## Decisión

Modelo de fábrica, dos piezas y ninguna más:

### El LOTE es la única entidad con ciclo de vida

```
lotes: id, code (LOTE-NNNN), tenant, crop → crop_profiles,
       campaign TEXT (etiqueta libre, nullable),
       modules JSONB (explícitos al abrir),
       started_at, expected_end_at (started_at + crop_profiles.cycle_days),
       closed_at, close_reason (cosecha|venta|perdida|otro),
       profile_hash, memory_hash, memory_hash_close (comparabilidad ADR-0012),
       note, state (open|closed)
```

- **Un lote = un programa biológico + una fecha de inicio + uno o varios módulos + un cierre con razón.** Mismo día + mismo cultivo + mismo destino = un lote que ocupa varios módulos; trasplante distinto = lote distinto.
- **Regla física única**: un módulo solo puede estar en UN lote activo (validada en código en `open_batch`). La finca puede tener todos los lotes activos que sus módulos libres permitan.
- El cierre del lote es gobernado e incluye **razón** (cosecha/venta/pérdida/otro) — ahí vive el aprendizaje entre ciclos.
- Los hashes de perfil y memoria del experto (ADR-0012/0021) se conservan, ahora por lote: la comparabilidad de la destilación de lecciones es entre ciclos reales, no entre temporadas.
- Escala a pecuario sin cambios: pollada = lote en galpón; engorde = lote en corral; lactancia = lote de tamaño 1 (una vaca); la rotación de potreros queda como trigger diferido (cuando haya pastoreo real, las ocupaciones con tiempo entran como extensión, no como rediseño).

### La CAMPAÑA es solo una etiqueta lógica

- `lotes.campaign` es un **TEXT libre** ("invierno-2026"), sin tabla, sin apertura, sin cierre, sin gobierno.
- La comparación de temporadas es un `GROUP BY campaign` en reportes, no una entidad. Los costos imputan al **lote** (porcentajes que suman 100%, ADR-0011); la campaña agrega, nunca recibe imputaciones — cero aritmética nueva.
- Pecuario continuo (lechería) vive sin etiqueta: `campaign = NULL` es un estado honesto, no un error.

### Migración

La tabla `campaigns` (solo datos de smoke) migra a `lotes` conservando ids, hashes y fechas, y se elimina. Los tools MCP `open_campaign`/`close_campaign`/`current_campaign`/`list_campaigns` son reemplazados por `open_batch`/`close_batch`/`list_batches`. La invariante de congelamiento del ADR-0022 se traslada: un módulo en lote activo no puede cambiar de cultivo ni retirarse.

## Consecuencias

- Se pierde el "cierre formal de temporada" como acto gobernado; es un reporte (lotes de la etiqueta X, todos cerrados, margen agregado). Si se necesita congelar una temporada contra ediciones, entra por trigger del roadmap.
- `crop_profiles` gana `cycle_days` (duración del ciclo) para `expected_end_at`; null = sin estimación (honesto).
- La PWA gana la pantalla `/produccion`: línea de tiempo de lotes + ocupación de módulos.
- ROADMAP: el criterio de salida de Fase 4 ("campaña completa con cero invariantes sin resolver") se reexpresa en términos de lotes — una temporada = conjunto de lotes cerrados con invariantes cuadrados.

## Alternativas consideradas

- **Campaña-temporada como entidad contenedora con lotes dentro** (dos niveles gobernados): más fiel a la jerga, pero la campaña fingía ser importante — su gobierno (una abierta por finca, cierre con lotes activos bloqueado) no protege ninguna invariante real. La etiqueta da el mismo valor de agregación sin ciclo de vida.
- **Catálogo de campañas** en vez de texto libre: otra entidad sin invariante que proteger. Un typo en la etiqueta se corrige en reportes, no con una tabla.
- **Mantener ADR-0021 y parchear multi-cultivo con `UNIQUE(tenant, crop)`**: seguía sin representar el escalonado del mismo cultivo (tres lotes de lechuga en paralelo). Parche sobre error de concepto.
