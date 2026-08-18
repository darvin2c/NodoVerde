# Cerebro — OpenClaw 24/7 (observador puro, Fase 1)

> ADR-0001 (framework) · ADR-0012 (portero) · ADR-0018 (instalación oficial) · ADR-0019 (multi-agente).
> Cero actuación: nadie publica a `cmd` ni a `request/`.

## Arquitectura multi-agente (ADR-0019)

```
Chat (Telegram / WhatsApp / WebChat — el que elijas; una sola voz al humano)
       ↕
  OpenClaw Gateway (terra-openclaw :18789, bind lan, auth token)
       │
       ├─ main (orquestador)  ← reporte-diario, oficina-activa, consulta a expertos
       │     ↑ sessions_spawn      ↑ hook (reportes de expertos, vía bridge)
       ├─ experto-lechuga ──┐
       ├─ experto-tomate ───┤ automation propia cada 6 h → webhook → bridge → main
       │                    │
       └─ MCP terra-domain read-only (:7760/mcp)

  sim → router → MQTT → bridge (alerta → experto del cultivo; fallback main)
```

| Pieza | Qué hace | Dónde vive |
|---|---|---|
| **Gateway** | Runtime, Control UI, scheduler, channels | imagen oficial `ghcr.io/openclaw/openclaw:2026.7.1-2` (ADR-0018, pineada por digest inmutable de tag) |
| **Orquestador (`main`)** | Única voz al humano; coordina expertos con `sessions_spawn` | workspace `./brain/workspaces/main` |
| **Expertos (`experto-<especie>`)** | Memoria y playbook por especie; revisión propia cada 6 h; reportan al orquestador, NUNCA al humano ni a actuadores | `./brain/workspaces/experto-<especie>/` |
| **Config** | `openclaw.json` (JSON plano, no expande env) | `openclaw.json.template` → `setup.sh` genera `openclaw.json` (mount ro) |
| **Hooks** | Ingress bus → agentes: `POST /hooks/agent` `{message, name, agentId}` con Bearer `OPENCLAW_HOOK_TOKEN`; `allowedAgentIds` limita destinos | `hooks.enabled=true` |
| **Bridge** | Alertas MQTT → experto del cultivo (lookup `modules.crop`, fallback `main`); `POST :7765/expert-report` recibe reportes de expertos → orquestador | `services/bridge/` |
| **Automations** | Scheduler nativo: `revision-lechuga` (7 */6h), `revision-tomate` (37 */6h) → webhook al bridge; `reporte-diario` (07:00) → tu canal | `brain/automations.sh` (idempotente) |
| **MCP terra-domain** | Herramientas read-only: `get_farm_context`, `list_modules`, `get_crop_profile`, `latest_readings`, `telemetry_range`, `module_confidence`, `recent_alerts`, `daily_report_data` | `mcp.servers.terra-domain` |
| **MCP terra-finance** | Ledger financiero (dueño de `movements`): `register_movement` ✏️, `void_movement` ✏️, `set_supply_cost` ✏️, `list_movements`, `cost_summary`, `list_supplies` | `mcp.servers.terra-finance` (`http://finance:7761/mcp`) |
**Convención de nombres:** `crop_profiles.name` = `<especie>` o `<especie>_<variedad>` (`lechuga`, `lechuga_romana`); el experto es por especie (`experto-lechuga`). Nueva especie = nuevo workspace + entrada en `agents.list` + `allowedAgentIds` + automation (toca plantilla y `automations.sh` en el mismo commit).

**Modelo y canal: agnósticos (ADR-0001).** El template no trae ninguno preconfigurado — el deployer elige post-boot con `openclaw config set agents.defaults.model.primary <proveedor/modelo>` y el canal correspondiente (`channels login` / `config set channels.<c>...`). WebChat (Control UI) funciona sin configurar nada.

**No hay actuación en Fase 1.** El portero llega en Fase 3; humanos operan por botones de Home Assistant (canal `request/`, ADR-0009).

## Instalación oficial (ADR-0018)

Se usa la **imagen oficial pre-construida** — prohibido build desde fuente/fork. Tag fijado en compose: `ghcr.io/openclaw/openclaw:2026.7.1-2` (estable más reciente al 2026-08-16; las 2026.8.x eran beta). Para cambiar de versión: edita el tag en `docker-compose.yml`, `docker compose pull openclaw && docker compose up -d openclaw`. Explorar tags: `docker manifest inspect ghcr.io/openclaw/openclaw:latest`.

## Primer arranque — paso a paso

| Paso | Comando | Qué hace |
|---|---|---|
| 0 | `cp .env.example .env` (LLM y canal vienen comentados: descomenta los tuyos) | Envs para compose |
| 1 | `./brain/setup.sh` | Genera tokens en `.env` si faltan y `brain/openclaw.json` desde el template |
| 2 | `docker compose up -d openclaw` | Pull de la imagen oficial y arranque del gateway |
| 3 | `curl -i http://localhost:18789/healthz` · `docker compose exec openclaw node openclaw.mjs config validate` | Health + config contra schema |
| 4 | `docker compose exec openclaw node openclaw.mjs agents list --bindings` | Debe listar `main`, `experto-lechuga`, `experto-tomate` |
| 5 | `./brain/automations.sh --channel <CANAL> --to <DESTINO>` | Crea las 3 automations (idempotente; sin flags solo las de expertos) |
| 6 | Configura tu LLM (`config set agents.defaults.model.primary …`) y tu canal (`channels login` o `config set channels.<c>…`) | Sin LLM los turnos fallan; sin canal, WebChat sigue disponible |
| 7 | `./brain/automations.sh --channel … --to …` (si no lo hiciste en 5) | Reporte diario 07:00 a tu canal |

> El destino del reporte (`--to`) se obtiene tras el pairing del canal que elijas (Control UI). Puede añadirse después re-ejecutando `automations.sh`.

## Qué persiste y dónde

- **Volumen `openclaw_state` → `/home/node/.openclaw`** — sesiones, pairing, automations, memoria de runtime. Sobrevive `docker compose down`; borrarlo resetea pairing y automations.
- **`./brain/workspaces/` (un solo bind)** — un subdirectorio por agente (`main`, `experto-<especie>`): SOUL/skills/memoria semilla versionados en git. Nueva especie = `mkdir` + entrada en el template, sin tocar compose. Edita en el repo y reinicia el gateway.
- **`./brain/openclaw.json` (bind rw anidado DESPUÉS del volumen)** — generado por `setup.sh` y **mutable en runtime**: `openclaw config set` persiste aquí (así se eligen LLM y canal). Estructura base = template; para resetear, re-ejecuta `setup.sh`.

```yaml
volumes:
  - openclaw_state:/home/node/.openclaw                                            # 1º volumen base
  - ./brain/workspaces:/home/node/.openclaw/workspaces                            # 2º workspaces (main + expertos)
  - ./brain/openclaw.json:/home/node/.openclaw/openclaw.json:ro                   # último: config ro
```

## Solución de problemas

| Síntoma | Qué hacer |
|---|---|
| Gateway no responde en `18789` | `docker compose ps` → debe estar `healthy`; si no, `docker compose logs openclaw --tail 100`. El gateway corre con `--bind lan` + `gateway.auth` (obligatorio fuera de loopback). |
| `config validate` falla | No inventes keys — las del template fueron verificadas. Revisa el template, re-ejecuta `setup.sh`. |
| Experto no existe (`agents list`) | La entrada vive en `agents.list` del template + su workspace montado. Ambos en el mismo commit. |
| Automation no corre | `docker compose exec openclaw node openclaw.mjs automations list` → revisa `nextRun`. Logs del run en el Control UI. El webhook exige que el bridge esté arriba (`http://bridge:7765`). |
| Alerta no llega al experto | Log del bridge: `[bridge] hook OK (… agent=experto-lechuga)`. Si cae a `main`: el experto no existe o el hook lo rechazó. Verifica `hooks.allowedAgentIds`. |
| `hooks` 401 | Bearer debe ser `OPENCLAW_HOOK_TOKEN` (≠ `OPENCLAW_GATEWAY_TOKEN`). |
| El canal no responde | Verifica la env de tu canal en `.env` y descomentada en `docker-compose.yml`; re-ejecuta `docker compose up -d openclaw`. Sin canal configurado el resto funciona igual (WebChat en :18789). |
| Turnos fallan con "no model" / auth_error | No hay LLM configurado o la key es inválida: `docker compose exec openclaw node openclaw.mjs config set agents.defaults.model.primary <proveedor/modelo>` con la env del proveedor presente. |
| Cambié `.env` y no aplica | `setup.sh` regenera `openclaw.json`; luego `docker compose up -d openclaw`. |

## Archivos en este directorio

```
brain/
  README.md                  # este archivo
  openclaw.json.template     # plantilla JSON — commit
  openclaw.json              # generado — gitignored, mount ro
  setup.sh                   # genera config + guía de arranque
  automations.sh             # automations idempotentes por agente (ADR-0019)
  workspaces/                # un subdirectorio por agente — un solo bind en compose
    main/                    # ORQUESTADOR: SOUL, AGENTS, skills reporte-diario/oficina-activa
    experto-lechuga/         # SOUL + MEMORY + AGENTS + skills/cultivo-lechuga
    experto-tomate/          # SOUL + MEMORY + AGENTS + skills/cultivo-tomate
```
