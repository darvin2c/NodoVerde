---
type: adr
title: "ADR-0012: Arquitectura multi-agente — orquestador + expertos por cultivo"
description: Un gateway OpenClaw; agente orquestador único dueño del canal al portero; expertos por cultivo con skill y memoria propia que aprenden por ciclo cerrado
tags: [adr, multi-agente, openclaw, memoria, aprendizaje]
created: 2026-08-15
status: aceptado (supersede parcial por ADR-0019: los expertos hablan directo con el portero — el orquestador ya no es el único canal — y entran en Fase 1, no en Fase 3-4; el resto del modelo orquestador+expertos se mantiene)
amplia: ADR-0001
---

# ADR-0012: Orquestador + expertos por cultivo

## Contexto

La finca tendrá varios cultivos simultáneos. La expertise debe especializarse (lechuga ≠ tomate) y aprender entre ciclos. OpenClaw es multi-agente dentro de la misma instancia: permite varios agentes con memoria/workspace propios sin despliegues adicionales.

## Opciones consideradas

- **Un cerebro + perfiles YAML** — simple, pero la experiencia de todos los cultivos cae en una sola memoria (contaminación cruzada).
- **Instancia de agente por cultivo** — especialización real, pero N despliegues, N veces el costo fijo, y conflicto por recursos compartidos (tanque, dosificadoras).
- **Un gateway: orquestador + expertos por cultivo** — especialización con memoria propia, costo solo cuando el experto trabaja, un solo punto de control.

## Decisión

**Un solo gateway OpenClaw** con:

```
Agente ORQUESTADOR (el administrador)
  - habla con el humano por chat
  - finanzas unificadas, visión de toda la finca
  - coordina expertos
  - ÚNICO que presenta propuestas al portero

Agente EXPERTO por cultivo (lechuga, tomate, ...)
  = skill/playbook del cultivo (Markdown) + perfil YAML (lee) + MEMORIA PROPIA
  - se activa por demanda (diagnóstico, plan de dosificación, análisis de foto)
  - propone al orquestador; jamás ejecuta ni habla con el portero
```

**Reglas inviolables:**
- Portero único: los expertos proponen, nunca ejecutan. El orquestador es el único canal. No existe conflicto por hardware compartido porque ningún experto toca hardware.
- Finanzas solo en el orquestador: una sola tabla de movimientos (ADR-0011).
- Nuevo cultivo = perfil YAML + playbook MD + entrada de config. Cero código, cero deploy.

## Aprendizaje por ciclo cerrado

1. Cada ciclo registra: decisiones tomadas, condiciones, resultado (kg, calidad, problemas).
2. Al **cerrar el ciclo**, el experto destila lecciones a su memoria ("agosto: agua >25°C los últimos 10 días → amargor; próximo ciclo sombrear desde día 30").
3. El ciclo siguiente arranca **con** esas lecciones.

**Tres reglas de aprendizaje sano:**
1. Solo se aprende de ciclos cerrados con resultado — decisión sin resultado es anécdota, no lección.
2. La memoria nunca edita el perfil YAML — el experto *propone* cambios de rangos; el humano aprueba (el perfil es contrato del portero).
3. La memoria es Markdown auditable — el humano la revisa periódicamente y tacha lo que no convenga. Una temporada atípica no debe volverse dogma.

**Honestidad técnica:** esto es memoria experiencial, no fine-tuning. El aprendizaje sistemático (destilación automática, estilo Hermes) sigue en backlog con su trigger.

## Evolución por etapas (regla de admisión)

| Etapa | Configuración | Trigger |
|---|---|---|
| Fase 1 | Un solo agente + skills de cultivo cargables | arranque |
| Fase 3–4 | Orquestador + expertos con memoria propia | ≥2 cultivos simultáneos reales en campaña |

La migración es trivial: playbook y memoria ya existen como archivos; solo se declara el experto como agente en la config del gateway.

## Futuro habilitado gratis

Multi-finca (ADR-0007): expertos del mismo cultivo en distintas fincas pueden compartir **lecciones destiladas** (no datos crudos). Lo que aprende la lechuga en Lambayeque le sirve a la de Piura.

## Consecuencias

- Costo de tokens escala con trabajo real, no con número de cultivos declarados.
- Cada campaña registra en DB qué versión de perfil y qué estado de memoria usó el experto (comparabilidad entre ciclos).
