---
type: adr
title: "ADR-0003: Bus único MQTT, contrato AsyncAPI"
description: MQTT como único bus de mensajería; NATS eliminado; contrato formal en AsyncAPI
tags: [adr, mqtt, asyncapi, bus]
created: 2026-08-15
status: aceptado
---

# ADR-0003: Bus único MQTT, contrato AsyncAPI

## Contexto

El sistema necesita mover telemetría, comandos y eventos entre campo, data plane y cerebro. Opciones: MQTT, NATS, o ambos. Además, OpenClaw (WebSocket interno) y Home Assistant (event bus interno) traen sus propios buses.

## Opciones consideradas

- **MQTT + NATS** — MQTT para IoT, NATS para eventos internos. Duplicidad sin justificación a este volumen.
- **Solo NATS** — no es el idioma estándar de IoT; cerraría la puerta a hardware real.
- **Solo MQTT** — el estándar IoT; sensores y actuadores reales lo hablan nativamente.

## Decisión

**MQTT (Mosquitto) como único bus.** NATS eliminado (solo evidencia de que MQTT no basta lo resucita). Los buses internos de OpenClaw y HA nunca salen de su proceso.

Todo mensaje que cruza el bus MUST cumplir [contract/asyncapi.yaml](../../contract/asyncapi.yaml) (v0.4.0: dos planos — dispositivo `hw_id` e interno `tenant/module`, ver ADR-0015). Ningún PR cambia un mensaje sin actualizar el spec en el mismo commit.

Propiedad clave: el simulador y el hardware real publican por el mismo adapter y el mismo contrato — capas superiores no distinguen sim de real.

## Consecuencias

- Un solo broker que operar, monitorear y asegurar.
- El contrato AsyncAPI es la pieza que une todo; los contract tests de nivel 2 se generan contra él.
- QoS por tipo de mensaje: telemetría QoS 0-1, comandos a actuadores QoS 1 con confirmación de estado obligatoria.
