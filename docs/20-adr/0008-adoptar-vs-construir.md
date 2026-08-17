---
type: adr
title: "ADR-0008: Adoptar antes que construir"
description: Mapa de piezas adoptadas del ecosistema vs. piezas propias que son el diferencial
tags: [adr, build-vs-buy, home-assistant, esphome, telegraf]
created: 2026-08-15
status: aceptado
---

# ADR-0008: Adoptar antes que construir

## Contexto

Riesgo de reinventar piezas que el ecosistema open-source ya resolvió (UI, firmware, ingestores). Inicialmente Home Assistant se difirió "hasta hardware real" y se declaró el chat como única interfaz — contradicción con la regla de no construir lo ya construido.

## Decisión

**Adoptar (no se construye):**

| Pieza | Rol en terraOS | Desde |
|---|---|---|
| Home Assistant | **Interfaz visual** (dashboard, app móvil, cámaras) + hub IoT | Fase 0 |
| ESPHome | Firmware de nodos (YAML declarativo, OTA). En Fase 0 corre en modo host/simulado con el MISMO YAML que luego se flashea | Fase 0 (sim) / Fase 5 (real) |
| Telegraf | Ingestor MQTT → TimescaleDB (config declarativa) | Fase 0 |
| OpenClaw | Cerebro | Fase 1 |
| Mosquitto / TimescaleDB / MinIO / Grafana | Bus / historial / media / análisis | Fase 0 |
| Node-RED + FlowFuse Dashboard 2.0 | **Monitor del simulador** (banco de laboratorio: verdad física vs. publicado, LWT, enchufar/desenchufar). Plano laboratorio — jamás en el camino del producto | Fase 0 |

**Construir (el diferencial, nadie lo tiene):**

1. Simulador/gemelo digital (perfiles de cultivo en YAML, física FAO-56 vía ET0 de Open-Meteo).
2. Policy module (portero) — IP crítica de seguridad.
3. Dominio agrícola-financiero (ledger, costos por lote) como servicios MCP.
4. Configuración del cerebro: prompts, skills de dominio, memoria agronómica.
5. Contrato AsyncAPI.
6. Servicios delgados de pegamento: bridge MQTT↔OpenClaw, cámaras→MinIO, watchdog (salud de dispositivos + verificación cruzada).

**División de alertas (mixta):** umbrales simples sobre series → Grafana (adoptado); salud de dispositivos y verificación cruzada comando↔efecto → watchdog propio.

## Reglas de convivencia con Home Assistant

- HA es **vista, no dueño**: la fuente de verdad de dispositivos es la DB; HA la refleja vía MQTT discovery.
- Automatizaciones de HA **prohibidas** para actuadores agrícolas (ADR-0002 intacto).
- Los botones de actuadores en HA publican al canal de **solicitudes humanas**, nunca al de comandos (ver ADR-0009).

## Consecuencias

- El build real se reduce a 5 piezas propias + 3 delgadas.
- ESPHome en modo host permite probar el firmware real sin hardware; el mismo YAML se flashea en Fase 5.
