# AGENTS.md — Instrucciones para agentes de desarrollo

## Qué es este repo

terraOS: agente autónomo de gestión agrícola integral (financiero + operacional). Lee [docs/00-vision.md](docs/00-vision.md) y [docs/10-architecture.md](docs/10-architecture.md) antes de tocar código.

## Reglas inviolables

1. **Un dueño por función** — consulta la matriz de dueños en `docs/10-architecture.md`. Si tu cambio crea un segundo dueño, para y escribe un ADR.
2. **Regla de admisión** — nada entra al build sin trigger cumplido del backlog en `ROADMAP.md`.
3. **Contratos primero** — ningún PR cambia un mensaje MQTT sin actualizar `contract/asyncapi.yaml` en el mismo commit.
4. **El LLM nunca**: toca actuadores sin policy module, hace aritmética financiera, ni genera la telemetría base del sim.
5. **Órdenes humanas desde HA** van al canal de solicitudes (`request/`), jamás al de comandos (`cmd/`) — el portero valida a humanos e IA por igual (ADR-0009).
6. **Tablas del agente** — solo con prefijo `agent_*`; jamás duplicando movimientos financieros.
7. **Conocimiento honesto (ADR-0010)** — ausencia de dato ≠ dato cero. El agente declara lo que no sabe; la confianza la calcula código determinístico, nunca el LLM.
8. **Historia financiera inmutable (ADR-0011)** — nada se borra ni se edita; corrección = anulación + nuevo movimiento. Todo movimiento se imputa a cultivo(s) con porcentajes que suman 100%.
9. **Solo el orquestador habla con el portero (ADR-0012)** — los expertos por cultivo proponen; nunca ejecutan ni emiten comandos. Los perfiles de cultivo solo cambian con aprobación humana.

## Cómo correr (Fase 0)

```bash
cp .env.example .env
docker compose up -d --wait              # mosquitto, timescale, telegraf, grafana, minio, HA
cd router && pnpm install && pnpm dev    # router de identidad (ADR-0015) — traduce plano dispositivo ↔ interno
cd sim && pnpm install && pnpm dev       # mundo simulado (ADR-0017): física + un emulador por hw_id
# flags del sim: --speed N --seed S --offline --scenario normal|ec_baja|sensor_muerto --start <iso>
# laboratorio: pnpm ctl list | add-node --crop X [--hw H] | remove-node --hw H [--unclaim] | scenario <nombre>
```

- HA: http://localhost:8124 (el 8123 del host lo ocupa TerraSmart). Primera vez: onboarding + Settings → Add Integration → MQTT → broker `mosquitto:1883` (HA moderno NO acepta broker en YAML).
- Grafana: http://localhost:3001 (admin/admin), dashboard "Terra Overview" provisionado.
- Laboratorio (monitor del simulador, Node-RED): http://localhost:1880/dashboard/lab — verdad física vs. publicado, enchufar/desenchufar nodos. Editor: http://localhost:1880.
- Verificación automática: `cd sim && pnpm test` (unit) y `pnpm contract` (mensajes vivos vs AsyncAPI v0.4.0); `cd router && pnpm test`.

## Stack

- **TypeScript/Node para todo** (ADR-0013): `sim/`, servicios de dominio, watchdog, bridge MQTT↔OpenClaw.
- Cerebro: OpenClaw (Node). Servicios de dominio se exponen como MCP servers.
- Python: SOLO si se cumple el trigger de la cláusula (ADR-0013): PCSE/DSSAT, ML local, estadística pesada → `services/agro-models/` con FastMCP.
- Infra adoptada (ADR-0008): Mosquitto, TimescaleDB, MinIO, Telegraf, Home Assistant, Grafana — todo en docker-compose.
- Firmware: ESPHome en YAML (modo host en sim; se flashea en Fase 5).

## Tests

Pirámide de 4 niveles (ver glosario). Todo PR pasa niveles 1–2; merge a main corre nivel 3 (E2E acelerado, semilla fija).

## Documentación

Todo doc en `docs/` lleva frontmatter OKF (type, title, description, tags, created, status). Las decisiones se congelan como ADR en `docs/20-adr/` (formato MADR, nunca se borran, se supersede).
