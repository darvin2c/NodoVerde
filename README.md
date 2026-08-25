# terraOS

Agente autónomo de gestión agrícola integral (financiero + operacional): un cerebro LLM (OpenClaw) que observa módulos hidropónicos vía MQTT, propone actuaciones que un portero valida en código, y lleva la contabilidad de cada cultivo en un ledger inmutable.

- Visión: [docs/00-vision.md](docs/00-vision.md)
- Arquitectura y matriz de dueños: [docs/10-architecture.md](docs/10-architecture.md)
- Reglas para agentes de desarrollo: [AGENTS.md](./AGENTS.md)

## Prerrequisitos

- **Docker Engine ≥ 24** con plugin Compose v2 (todo el stack de datos y servicios corre en contenedores).
- **Node.js ≥ 20 + pnpm** — SOLO para `sim/` y `router/`, que corren fuera de Docker en el host.
- `jq` opcional (para inspeccionar respuestas JSON en la verificación).
- Puerto 8123 del host ocupado por TerraSmart (app preexistente) → Home Assistant usa **8124** (ya configurado en el compose).

## Instalación

```bash
git clone <repo> && cd terraOS
cp .env.example .env
./brain/setup.sh        # genera brain/openclaw.json + tokens en .env (idempotente)
docker compose up -d --wait   # base: broker, DB, MinIO, Telegraf
```

> ⚠️ **Footgun:** si `brain/openclaw.json` no existe antes del primer `up`, Docker crea un **directorio** con ese nombre (bind mount) y el contenedor `openclaw` falla al arrancar. Recuperación: `docker compose --profile cerebro --profile ui --profile lab down`, borrar el directorio `brain/openclaw.json`, correr `./brain/setup.sh` y repetir el `up`.

## Despliegue por estratos (profiles)

La base (datos) no tiene profile: siempre arranca. El resto se activa por estratos:

| Estrato | Comando | Qué levanta |
|---|---|---|
| Base (siempre) | `docker compose up -d` | mosquitto, timescale, minio(+init), telegraf |
| Cerebro | `docker compose --profile cerebro up -d` | openclaw, bridge, mcp-domain, finance, policy, token-meter, watchdog, confidence |
| Interfaz | `docker compose --profile ui up -d` | pwa, grafana, homeassistant |
| Laboratorio | `docker compose --profile lab up -d` | nodered (monitor del sim, NO producto) |
| Todo | `docker compose --profile cerebro --profile ui --profile lab up -d --wait` | stack completo |

Notas:

- Los profiles se **acumulan** entre comandos `up`: `--profile cerebro up -d` seguido de `--profile ui up -d` deja ambos estratos corriendo.
- Nombrar un servicio explícitamente ignora profiles y arrastra sus dependencias: `docker compose up -d openclaw` levanta openclaw + mcp-domain + finance + base (sin watchdog/confidence/policy/bridge/token-meter).
- `pwa` declara sus dependencias del cerebro como **opcionales** (`required: false`): `--profile ui up -d` funciona sin cerebro (modo degradado); con ambos profiles activos, `pwa` espera a que `mcp-domain`/`finance`/`policy` estén healthy.
- `docker compose down` solo baja los servicios de los profiles activos en ese comando. Para apagar todo: `docker compose --profile cerebro --profile ui --profile lab down`.

## Post-arranque del cerebro

Con el estrato cerebro arriba (resumen de los pasos que imprime `./brain/setup.sh`; detalle en [brain/README.md](brain/README.md)):

1. **Verificar**: `curl -sf http://localhost:18789/healthz` y `docker compose exec openclaw node openclaw.mjs agents list --bindings`.
2. **Elegir el LLM** (agnóstico, ADR-0001): exportar la key del proveedor en `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …), `docker compose up -d openclaw` para recargar env, y `docker compose exec openclaw node openclaw.mjs config set agents.defaults.model.primary <proveedor/modelo>`. El gateway arranca sin modelo, pero los turnos lo necesitan.
3. **Elegir el canal de chat**: Telegram (`TELEGRAM_BOT_TOKEN` + pairing), WhatsApp (`channels login --channel whatsapp`, QR) o WebChat (http://localhost:18789, sin configuración).
4. **Automations de los agentes** (idempotente, ADR-0019): `./brain/automations.sh` (revisiones de expertos cada 6 h) y opcionalmente `./brain/automations.sh --channel telegram --to <CHAT_ID>` para el reporte diario 07:00.

## Sim y router (fuera de Docker)

```bash
cd router && pnpm install && pnpm dev   # router de identidad (ADR-0015) + enforcement cmd (ADR-0020)
cd sim && pnpm install && pnpm dev      # mundo simulado (ADR-0017): física + un emulador por hw_id
```

Flags del sim: `--speed N --seed S --offline --scenario normal|ec_baja|sensor_muerto --start <iso>`. Laboratorio: `pnpm ctl list | add-node --crop X [--hw H] | remove-node --hw H [--unclaim] | scenario <nombre>`.

Sin sim/edge el sistema entra en **modo oficina** (ADR-0010): finanzas, chat y PWA funcionan; la telemetría no. Ausencia de dato ≠ dato cero.

## URLs y puertos

| Servicio | URL | Notas |
|---|---|---|
| Home Assistant | http://localhost:8124 | onboarding + integración MQTT → broker `mosquitto:1883` |
| Grafana | http://localhost:3001 | admin/admin, dashboard "Terra Overview" |
| PWA | http://localhost:7780 | selector de finca en el header, gestión en `/fincas` |
| MCP dominio | http://localhost:7760/mcp | herramientas del cerebro sobre datos de negocio |
| Finance | http://localhost:7761/mcp | ledger read/write |
| Portero (policy) | http://localhost:7762/mcp | único publicador de `cmd/` |
| Bridge | :7765 | interno (webhooks de automations) |
| OpenClaw gateway | http://localhost:18789 | Control UI / WebChat |
| Node-RED | http://localhost:1880 | laboratorio: `/dashboard/lab` |
| MinIO consola | http://localhost:9002 | minioadmin/minioadmin (dev) |
| Mosquitto | :1883 | anónimo, SOLO dev — prod exige TLS+auth (futuro, ADR-0006) |

TLS/auth de Mosquitto, túnel Cloudflare y deploy a VPS están fuera de esta fase; ver ADR-0006 en [docs/20-adr/](docs/20-adr/).

## Verificación rápida

```bash
docker compose ps
curl -sf http://localhost:18789/healthz   # cerebro
curl -sf http://localhost:7760/healthz    # MCP dominio
curl -sf http://localhost:7761/healthz    # finance
curl -sf http://localhost:7762/healthz    # portero
curl -sf http://localhost:7780/           # PWA
```

## Tests y E2E

```bash
pnpm test            # en sim/, router/, services/*/, pwa/ — un paquete a la vez
cd sim && pnpm contract   # mensajes vivos vs AsyncAPI (contract/asyncapi.yaml)
pnpm --dir e2e ec-baja    # E2E Fase 3 con stack vivo
```

Precondición del E2E: `docker compose --profile cerebro up -d` (policy, watchdog, finance) + router por host + sim corriendo (`cd sim && pnpm dev -- --offline --speed 240`).

Migraciones DB para volúmenes existentes (idempotentes; `init.sql` ya cubre volúmenes nuevos):

```bash
for m in infra/db/migrations/*.sql; do docker exec -i terra-timescale psql -U terra -d terra < $m; done
```

## Mapa del repo

| Directorio | Qué es | README |
|---|---|---|
| `brain/` | Cerebro OpenClaw: setup, automations, workspaces de agentes | [brain/README.md](brain/README.md) |
| `router/` | Router de identidad dispositivo ↔ interno + enforcement `cmd/` | [router/README.md](router/README.md) |
| `sim/` | Mundo simulado: física, emuladores, laboratorio ctl | [sim/README.md](sim/README.md) |
| `pwa/` | PWA: portada, aprobaciones, gestión de fincas/lotes | [pwa/README.md](pwa/README.md) |
| `services/bridge/` | Bridge MQTT → hooks de OpenClaw (bus → cerebro) | [services/bridge/README.md](services/bridge/README.md) |
| `services/confidence/` | Termómetro de confianza determinístico por módulo | [services/confidence/README.md](services/confidence/README.md) |
| `services/finance/` | Ledger financiero inmutable + evidencia (MinIO) | [services/finance/README.md](services/finance/README.md) |
| `services/mcp-domain/` | MCP del dominio: herramientas del cerebro | [services/mcp-domain/README.md](services/mcp-domain/README.md) |
| `services/policy/` | Portero: único publicador de `cmd/` | [services/policy/README.md](services/policy/README.md) |
| `services/token-meter/` | Contabilidad de tokens del cerebro → ledger | [services/token-meter/README.md](services/token-meter/README.md) |
| `services/watchdog/` | Salud de dispositivos → health + alert | [services/watchdog/README.md](services/watchdog/README.md) |
| `contract/` | Contrato AsyncAPI de los topics MQTT | — |
| `docs/` | Visión, arquitectura, ADRs (MADR) | — |
| `infra/` | Config de mosquitto, telegraf, grafana, HA, DB | — |
| `e2e/` | E2E de fase (escenario EC baja) | — |

## Troubleshooting

- **`openclaw.json` es un directorio** → el bind mount lo creó Docker porque el archivo no existía. `docker compose --profile cerebro --profile ui --profile lab down`, `rm -r brain/openclaw.json`, `./brain/setup.sh`, repetir `up`.
- **El cerebro no piensa** (no responde turnos) → falta la key del LLM: exportarla en `.env`, `docker compose up -d openclaw`, y fijar el modelo con `docker compose exec openclaw node openclaw.mjs config set agents.defaults.model.primary <proveedor/modelo>`.
- **Tokens no generados** (`OPENCLAW_HOOK_TOKEN`, `POLICY_ADMIN_TOKEN` vacíos) → re-correr `./brain/setup.sh` (es idempotente).
- **Puerto 8123 ocupado** → lo usa TerraSmart; HA de terraOS está en **8124** (ya mapeado en compose).
