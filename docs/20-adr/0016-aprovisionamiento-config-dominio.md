---
type: adr
title: "ADR-0016: Aprovisionamiento de config de dominio — cerebro lee DB, sim lee YAML"
description: Los YAML de finca/cultivos son config del mundo del fierro (firmware/seed); el cerebro consume solo la base de datos, como en producción real
tags: [adr, simulador, configuracion, realismo, base-de-datos]
created: 2026-08-16
status: aceptado
---

# ADR-0016: Aprovisionamiento de config de dominio — cerebro lee DB, sim lee YAML

## Contexto

ADR-0004 dice *"Sim, cerebro y portero leen el mismo perfil"* (`config/crops/*.yaml`). Eso crea un canal cerebro↔fierro vía archivos compartidos que **no existe en producción real**: un ESP32 jamás comparte archivos con el cerebro. Si la simulación no es 100% realista en sus canales, no sirve. Además, `config/` y `fincas/` en root parecen config de producción cuando su único consumidor en runtime es el simulador.

Principio rector (acordado): **el cerebro se entera del mundo solo por los conductos reales** — telemetría y comandos por MQTT, y estado de dominio por la base de datos.

## Decisión

1. **La DB es la única fuente de verdad en runtime para el cerebro, portero y expertos.** Topología de finca (tenant, módulos, cultivo por módulo) y perfiles de cultivo (rangos EC/pH/temp) se aprovisionan a la DB (seed desde YAML, una vez, al instalar) y se mantienen por chat/formulario del dueño. Ningún componente de producción lee YAML en runtime.
2. **Los YAML pertenecen al mundo del fierro.** Su único consumidor en runtime es el simulador, que los usa como "firmware" para fingir la física. Equivalente real: el YAML ESPHome que se compila y flashea al ESP32 (muere en el dispositivo, no se comparte).
3. **Reubicación:** `config/crops/` y `fincas/` se mueven bajo `sim/` (config de arranque del gemelo digital). `esphome/` permanece en root: es firmware de hardware real, no simulación.
4. **Enmienda ADR-0004:** donde dice "Sim, cerebro y portero leen el mismo perfil" debe leerse "el sim lee YAML; producción lee la DB aprovisionada desde ese YAML".

## Consecuencias

- Realismo total: ningún canal del cerebro deja de existir cuando se conecta hardware real.
- La declaración del dueño ("módulo 3 = tomate") sigue existiendo — es inherente al dominio (la planta no se anuncia) — pero vive en la DB, no en archivos.
- Los 4 módulos de `infra/db/init.sql` ya son el seed parcial; falta la tabla de perfiles de cultivo.
- El root deja de parecer "un simulador con aspiraciones": `sim/` contiene todo lo del mundo simulado.

## Decisiones complementarias (discusión 2026-08-16)

- **Frontera manual/automática:** es manual exactamente lo que es físico en la realidad — montar el fierro, flashearlo, y **declarar su ubicación** (a qué finca/chacra/zona/módulo pertenece y qué cultiva; el dispositivo no puede saberlo, solo el dueño lo sabe). Todo lo demás fluye automático tras la declaración: HA descubre vía MQTT discovery, el cerebro monitorea, la física simula, las finanzas imputan.
- **Un solo canal de declaración:** todo lo manual entra igual en simulación y en producción (declaración del dueño → DB). El sim no usa puertas traseras (ej. editar un YAML que el cerebro lea) — eso rompería el realismo acordado.
- **Topología (finca → chacra/zona → módulo → dispositivo):** la decisión de cuántos niveles y sus nombres queda **diferida** (mono-finca no la necesita). Seguro barato desde ahora: (a) ningún código asume N segmentos fijos en los topics MQTT (parseo tolerante, nada de `split("/")[3]`); (b) la topología en DB se modela como árbol (`parent_id`), no como columnas fijas por nivel. Agregar "chacra" después = insertar fila intermedia, no migrar esquema.

## Ejecutado (2026-08-16)

- [x] `config/crops/` y `fincas/` movidos bajo `sim/`; `sim/src/config.ts` actualizado.
- [x] Tabla `crop_profiles` en `infra/db/init.sql` con seed lechuga/tomate; `modules.crop` ahora la referencia (FK).
- [x] ADR-0004 enmendado; este ADR pasa a aceptado.
