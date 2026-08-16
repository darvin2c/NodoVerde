---
type: adr
title: "ADR-0006: Despliegue híbrido (edge local + VPS)"
description: Edge en la finca sobrevive cortes de red/luz; cerebro y data plane en VPS; desarrollo en docker-compose
tags: [adr, despliegue, edge, vps]
created: 2026-08-15
status: aceptado
---

# ADR-0006: Despliegue híbrido (edge local + VPS)

## Contexto

El entorno real es una finca: internet intermitente, cortes de luz. El sistema debe seguir operando (control local, buffer de datos) aunque caiga la conectividad.

## Opciones consideradas

- **Todo en VPS** — simple de operar, pero si cae la red de la finca se pierde telemetría y control.
- **Todo on-premise** — sin costos de nube, pero acceso remoto, respaldos y potencia de cómputo para el cerebro quedan a nuestro cargo.
- **Híbrido** — edge local con control determinístico + buffer; VPS con cerebro, data plane y canales.

## Decisión

**Híbrido.** Edge local: gateway con interlocks, buffer store-and-forward, sincronización cuando vuelve la red. VPS: Mosquitto, TimescaleDB, MinIO, OpenClaw, Grafana.

En desarrollo (Fases 0–4) todo corre en docker-compose local; el simulador ocupa el lugar del edge. El edge físico aparece en Fase 5.

## Consecuencias

- El contrato MQTT debe tolerar reconexiones y duplicados (QoS 1 en comandos).
- El cerebro debe asumir telemetría con huecos: ausencia de dato ≠ dato cero (regla de interpretación).
- Costo: un VPS modesto + hardware de edge por finca (Fase 5).
