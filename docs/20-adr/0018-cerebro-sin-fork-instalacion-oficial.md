---
type: adr
title: "ADR-0018: Cerebro sin fork — OpenClaw oficial y funcionalidad en su lugar correcto"
description: El cerebro se instala con las herramientas oficiales de OpenClaw (imagen pre-construida), nunca desde fuente; el comportamiento del LLM vive en skills Markdown; el código determinístico jamás en skills
tags: [adr, cerebro, openclaw, instalacion, skills]
created: 2026-08-17
status: aceptado
amplia: ADR-0001
---

# ADR-0018: Cerebro sin fork — instalación oficial y ubicación de la funcionalidad

## Contexto

La primera implementación del cerebro construía OpenClaw **desde fuente** (`docker compose build` con contexto `https://github.com/openclaw/openclaw.git#<tag>`): el camino de un contribuidor, no de un usuario. Además se difundió la idea imprecisa de que "toda la funcionalidad va a skills", cuando las skills de OpenClaw **sí pueden llevar código ejecutable** — la pregunta correcta no es si pueden, sino si *deben*.

## Opciones consideradas

- **Build desde fuente (git clone + pnpm build)** — control total; en realidad: minutos de build, superficie de drift, mantenimiento de toolchain ajena.
- **`npm i -g openclaw` en Dockerfile propio** — empaquetado oficial, pero seguimos manteniendo una imagen.
- **Imagen oficial pre-construida** — `ghcr.io/openclaw/openclaw:<versión>` (espejo: `openclaw/openclaw` en Docker Hub). Verificado 2026-08-17: tags versionados existen (`2026.7.1-2` confirmado por manifest), más `latest` y `extended-stable`, variantes `slim` y `-browser`.

## Decisión

1. **OpenClaw se consume como dependencia oficial**: `image: ghcr.io/openclaw/openclaw:<versión pineada>` en docker-compose. Cero fork, cero parches, cero build propio. Actualizar = cambiar el tag. `brain/` se reduce a: README de instalación, config estructural y workspaces Markdown.
2. **Ubicación de la funcionalidad** (tres tipos, un dueño cada uno):

| Tipo | Dónde vive | Por qué |
|---|---|---|
| Comportamiento del LLM (cómo razonar, cuándo pedir foto, honestidad) | Skills Markdown + SOUL.md | Son instrucciones para el modelo |
| Código determinístico (queries, confianza, watchdog, validaciones) | Servicios (`services/`, portero) | Regla inviolable 4: el LLM nunca hace aritmética ni ejecuta validaciones de seguridad |
| Cableado (modelo, canales, MCP, hooks, automations) | `openclaw.json` | Una skill no se auto-registra |

3. **Nuestras skills se mantienen Markdown puro por política** (ADR-0001: skills de terceros son superficie de seguridad). No por limitación técnica — el debate "skill con código" queda explícitamente diferido: si alguna skill necesita ejecutable, entra por ADR propio.
4. **Config mínima estructural**: el template solo declara lo que es arquitectura del sistema (MCP de dominio, hooks del bridge, automations, agentes). Modelo y canales son decisión del que despliega y se configuran con las herramientas nativas (`openclaw onboard`, `openclaw channels ...`) — OpenClaw ya sabe generar y mantener ese config; duplicarlo en template es riesgo de drift.

## Consecuencias

- Positivas: instalación en segundos, procedencia verificable del binario, upgrades triviales, `brain/` sin código ajeno que mantener.
- Negativas: dependemos del ritmo de publicación del registry oficial (mitigado: tags versionados + `extended-stable`).
- Restricción: queda prohibido introducir un fork o parche de OpenClaw en el repo. Si OpenClaw no soporta algo que necesitamos, se escribe ADR antes de cualquier workaround.
