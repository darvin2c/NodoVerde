---
type: adr
title: "ADR-0004: Simulador persistente con reloj dual"
description: Gemelo digital como servicio permanente; 1:1 para campaña, Nx para tests; física + estocástica, IA solo para imágenes y escenarios
tags: [adr, simulador, testing, fao56]
created: 2026-08-15
status: aceptado
---

# ADR-0004: Simulador persistente con reloj dual

## Contexto

Desarrollar y probar sin hardware exige un gemelo digital del campo. Requisitos: realismo temporal (una temporada dura meses), datos realistas (no ruido blanco), lazo cerrado (las acciones del agente afectan al campo), y tests rápidos en CI.

## Opciones consideradas

- **Simulador acelerado únicamente** — feedback rápido pero no valida comportamiento de largo plazo (deriva, memoria del agente, costos acumulados).
- **Solo tiempo real** — realista pero ciclo de feedback de meses: imposible desarrollar.
- **Reloj dual** — mismo código, velocidad configurable: 1:1 para campaña, Nx para tests.
- **Datos generados por IA** — descartado para telemetría base: sin ground truth controlable no se puede validar si el agente decidió bien.

## Decisión

**Servicio persistente con reloj dual** (default 1:1; Nx solo en tests). Generación de datos en 3 capas:

1. **Física** (columna vertebral): primera campaña = **hidroponía** — modelo de solución nutritiva (EC, pH, nivel de tanque, temperatura de agua) + consumo de agua por transpiración usando **ET0 FAO-56 ya calculada por Open-Meteo** (no implementamos Penman-Monteith). Clima real de la finca (Lambayeque, Perú: -6.486, -79.647).
2. **Estocástica**: ruido AR(1)/Ornstein-Uhlenbeck correlacionado, deriva de calibración, fallos con cadenas de Markov (batería, muerte gradual, dropout).
3. **IA solo donde aporta**: imágenes de cámaras (diferido al backlog) y narrativa de escenarios (diferido). v1: biblioteca de fotos reales etiquetadas + escenarios YAML.

**Perfiles de cultivo como configuración** (`sim/config/crops/*.yaml`): rangos EC/pH, temperatura máxima de agua, ciclo, etapas. Cambiar de cultivo = apuntar el módulo a otro YAML. ~~Sim, cerebro y portero leen el mismo perfil~~ *(enmendado por ADR-0016: solo el sim lee YAML; cerebro y portero leen la tabla `crop_profiles` de la DB, aprovisionada desde esos YAML — ningún componente de producción comparte archivos con el fierro)*. Perfiles iniciales: lechuga y tomate hidropónico.

Propiedades obligatorias: estado persistente (sobrevive reinicios), RNG con semilla fija (corridas reproducibles), fault injection como API (`sim.inject("sensor_muerto", parcela=2, dia=3)`), lazo cerrado (regar → humedad sube).

## Consecuencias

- El mismo sim sirve a los 4 niveles de test y a la campaña — no hay dos simuladores.
- Una campaña simulada produce meses de datos realistas y un agente que ya "vivió" una temporada, sin finca.
- Riesgo aceptado: radio (LoRaWAN), fallos eléctricos/mecánicos y latencia real no se simulan — se validan en Fase 5 con piloto de hardware mínimo.
