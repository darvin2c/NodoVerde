---
type: adr
title: "ADR-0010: Conocimiento graduado, acciones manuales y termómetro de confianza"
description: El agente sabe en proporción a la instrumentación; las acciones son automáticas u órdenes de trabajo; toda variable lleva fuente, frescura y confianza
tags: [adr, confianza, work-orders, modo-oficina, conocimiento]
created: 2026-08-15
status: aceptado
amplia: ADR-0009
---

# ADR-0010: Conocimiento graduado, acciones manuales y termómetro de confianza

## Contexto

Ninguna finca está 100% instrumentada y muchas tareas agrícolas no se automatizan (podar, trasplantar, cosechar, mezclar nutrientes). El modelo binario "conectado/desconectado" no refleja la realidad. Además, si el edge cae, el agente puede seguir operando con fotos y reportes del usuario.

## Decisión

### 1. Conocimiento graduado

Cada dato que el agente conoce lleva **fuente, frescura y confianza**. El agente declara lo que no sabe; jamás asume ni inventa valores. **Ausencia de dato ≠ dato cero ≠ último dato conocido.**

| Fuente | Confianza base | Decaimiento |
|---|---|---|
| Sensor en vivo | ~95% (nunca 100: los sensores mienten) | Según velocidad de cambio de la variable (nivel de tanque: minutos; EC: horas) |
| Foto analizada | ~75% | Medio |
| Reporte humano por chat | ~65% | Medio |
| Última lectura vieja | decae hacia 0 | Función de la edad |
| Sin dato | 0% — declarado | — |

### 2. Termómetro de confianza (0–100%)

- **Por variable**: lo que el agente usa para decidir. Cálculo = confianza base de la fuente × decaimiento por edad. **Función determinística** (servicio de dominio, no el LLM).
- **Global por módulo**: promedio ponderado, visible como gauge en HA y en el reporte diario por chat.
- **El portero exige confianza mínima por clase de acción**: dosificar requiere EC ≥ 70%; rellenar tanque requiere nivel ≥ 80%. Si no alcanza, no rechaza: responde "primero necesito saber X" → activa la recolección (foto, medición manual) → la confianza sube → actúa. El termómetro es el freno de mano del sistema.
- La confianza se publica al bus como métrica retenida por módulo (`terraos/{tenant}/{parcela}/confidence`) para HA/Grafana. El histórico de confianza indica dónde invertir en el próximo sensor.

### 3. Dos clases de acciones

| Clase | Ejemplo | Camino |
|---|---|---|
| **Automática** | Dosificar, recircular, rellenar | Portero → comando MQTT → actuador → verificación por sensor |
| **Manual** | Podar, trasplantar, mezclar nutrientes, cosechar | Portero → **orden de trabajo al humano por chat** (instrucciones paso a paso) → confirmación → registro |

El portero audita ambas igual. La orden manual también cierra el lazo: el agente verifica que se hizo (confirmación, foto, o sensor que cambió).

### 4. Modo oficina activo

Si el edge cae (o un módulo nunca se instrumentó), el agente pasa a **oficina activa**: no espera datos — los **pide** ("manda foto del módulo 3", "mide el EC con el medidor de mano"). El usuario se convierte en sus sensores. Una finca cero instrumentada es operable desde el día 1: fotos + reportes + finanzas.

En modo oficina: finanzas completas, análisis histórico, planificación y chat funcionan (viven en el VPS); observación del campo solo vía humano; **cero comandos** (el portero los rechaza sin heartbeat del edge).

### 5. Modos por módulo, no por finca

Los modos de ADR-0009 (manual/supervisado/autónomo) + oficina se aplican **por módulo**: un módulo instrumentado puede ser autónomo mientras otro está en oficina. Permite crecer por etapas según presupuesto.

## Matriz de degradación

| Cerebro | Edge | Modo | Qué funciona |
|---|---|---|---|
| ✅ | ✅ | Supervisado/Autónomo | Todo |
| ❌ | ✅ | Manual | Botones HA, interlocks, buffer local |
| ✅ | ❌ | Oficina activa | Finanzas, análisis, planificación, chat; observación vía humano |
| ❌ | ❌ | Solo interlocks físicos | — |

## Consecuencias

- AsyncAPI v0.3.0: canal `confidence` retenido por módulo; eventos `task_created`/`task_done`.
- El cerebro debe razonar sobre confianza, no solo sobre valores.
- Producto vendible sin hardware: modo oficina activo puro.
