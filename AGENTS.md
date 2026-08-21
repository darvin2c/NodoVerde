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
9. **Expertos hablan con el portero directo (ADR-0019)** — la validación dura vive en la herramienta de actuación (código), jamás en una skill; los expertos nunca publican `cmd/` directamente ni tienen message tool. El orquestador es la única voz al humano. Los perfiles de cultivo solo cambian con aprobación humana.

## Cómo correr (Fase 3)

```bash
cp .env.example .env
./brain/setup.sh                          # genera brain/openclaw.json (token hooks) desde template
docker compose up -d --wait              # data plane + watchdog + confidence + mcp-domain + finance + policy (portero) + bridge + token-meter + pwa (+ openclaw si hay API key)
docker compose up -d openclaw            # cerebro: imagen oficial ghcr pineada (ADR-0018), sin build
./brain/automations.sh                   # automations de agentes (ADR-0019; --channel <C> --to <D> añade reporte diario)
cd router && pnpm install && pnpm dev    # router de identidad (ADR-0015) — traduce plano dispositivo ↔ interno + enforcement cmd (ADR-0020)
cd sim && pnpm install && pnpm dev       # mundo simulado (ADR-0017): física + un emulador por hw_id
# flags del sim: --speed N --seed S --offline --scenario normal|ec_baja|sensor_muerto --start <iso>
# laboratorio: pnpm ctl list | add-node --crop X [--hw H] | remove-node --hw H [--unclaim] | scenario <nombre>
```

- HA: http://localhost:8124 (el 8123 del host lo ocupa TerraSmart). Primera vez: onboarding + Settings → Add Integration → MQTT → broker `mosquitto:1883` (HA moderno NO acepta broker en YAML). Incluye gauges de confianza y salud por módulo (discovery del router, contrato v0.8.0). Sus botones publican a `request/` y el portero los valida como a cualquier solicitante (ADR-0009/0020).
- Grafana: http://localhost:3001 (admin/admin), dashboard "Terra Overview" + alertas de umbral (EC/pH/nivel) provisionadas.
- MCP dominio: http://localhost:7760/mcp — herramientas del cerebro (`daily_report_data`, `latest_readings`, …). Telemetría read-only; Fase 4 (ADR-0021/0024) añade la excepción gobernada `open/close_batch` + `resolve_alert` (tablas `lotes`/`alert_resolutions`); ADR-0022/0023 añaden provisionamiento gobernado de módulos (`create/update/retire_module`, `claim_device`) y fincas (`create/update/archive_tenant`, tz derivada de lat/lon, moneda por finca).
- PWA: http://localhost:7780 — selector de finca en el header (modo "Todas" = agregado honesto, nunca suma monedas distintas) y gestión de fincas en `/fincas` (ADR-0023).
- Finanzas (read+write): http://localhost:7761/mcp — ledger `movements` (`register_movement`, `void_movement`, `list_movements`, `cost_summary`, `list_supplies`, `set_supply_cost`).
- Portero (policy, ADR-0020): http://localhost:7762/mcp — único publicador de `cmd/` (`propose_action`, `approve_action`, `reject_action`, `list_pending_actions`, `create_work_order`, …). Aprobaciones por botón PWA (HTTP con `POLICY_ADMIN_TOKEN`) o por chat vía orquestador.
- Cerebro (OpenClaw): gateway en :18789. Reporte diario por el canal que elijas (Telegram/WhatsApp/WebChat) — ver `brain/README.md`. Sin `TELEGRAM_BOT_TOKEN` el canal queda inactivo; el resto funciona igual.
- Laboratorio (monitor del simulador, Node-RED): http://localhost:1880/dashboard/lab — verdad física vs. publicado, enchufar/desenchufar nodos. Editor: http://localhost:1880.
- Verificación automática: `pnpm test` en `sim/`, `router/`, `services/watchdog/`, `services/confidence/`, `services/bridge/`, `services/mcp-domain/`, `services/finance/`, `services/policy/`, `services/token-meter/`, `pwa/`; `cd sim && pnpm contract` (mensajes vivos vs AsyncAPI v0.8.0, incluye plano plataforma 4-seg y cmd); E2E Fase 3 con stack vivo: `pnpm --dir e2e ec-baja` (escenario "EC baja" de punta a punta).
- Migración DB para volúmenes existentes (idempotentes; `init.sql` ya cubre volúmenes nuevos): `for m in infra/db/migrations/*.sql; do docker exec -i terra-timescale psql -U terra -d terra < $m; done`

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
