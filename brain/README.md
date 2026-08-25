# Cerebro — OpenClaw 24/7 (Fase 3: lazo cerrado con portero)

> ADR-0001 (framework) · ADR-0012 (portero) · ADR-0018 (instalación oficial) · ADR-0019 (multi-agente).
> Fase 3: el portero (`terra-policy` :7762) valida y publica `cmd` con `policy_id`; expertos proponen, humano aprueba.

## Arquitectura multi-agente (ADR-0019)

```
Chat (Telegram / WhatsApp / WebChat — el que elijas; una sola voz al humano)
       ↕
  OpenClaw Gateway (terra-openclaw :18789, bind lan, auth token)
       │
       ├─ main (orquestador)  ← reporte-diario, oficina-activa, consulta a expertos
       │     ↑ sessions_spawn      ↑ hook (reportes de expertos, vía bridge)
       ├─ experto-<especie> ×N ┤ automation propia cada 6 h → webhook → bridge → main
       │   (uno por especie de crop_profiles — los genera sync-experts.mjs, ADR-0028)
       └─ MCP terra-domain read-only (:7760/mcp)

  sim → router → MQTT → bridge (alerta → experto del cultivo; fallback main)
```

| Pieza | Qué hace | Dónde vive |
|---|---|---|
| **Gateway** | Runtime, Control UI, scheduler, channels | imagen oficial `ghcr.io/openclaw/openclaw:2026.7.1-2` (ADR-0018, pineada por digest inmutable de tag) |
| **Orquestador (`main`)** | Única voz al humano; coordina expertos con `sessions_spawn` | workspace `./brain/workspaces/main` |
| **Expertos (`experto-<especie>`)** | Memoria y playbook por especie; revisión propia cada 6 h; reportan al orquestador, NUNCA al humano ni a actuadores. NO hay lista fija: se generan desde `crop_profiles` (una especie por perfil) vía `brain/sync-experts.mjs`. | `./brain/workspaces/experto-<especie>/` (generado desde `_template-experto/`) |
| **Config** | `openclaw.json` (JSON plano, no expande env) | `openclaw.json.template` → `setup.sh` genera `openclaw.json` (mount ro) |
| **Hooks** | Ingress bus → agentes: `POST /hooks/agent` `{message, name, agentId}` con Bearer `OPENCLAW_HOOK_TOKEN`; `allowedAgentIds` limita destinos | `hooks.enabled=true` |
| **Bridge** | Alertas MQTT → experto del cultivo (lookup `modules.crop`, fallback `main`); `POST :7765/expert-report` recibe reportes de expertos → orquestador | `services/bridge/` |
| **Automations** | Scheduler nativo: `revision-<especie>` (*/6h, minuto determinístico por especie) → webhook al bridge; `reporte-diario` (07:00) → tu canal | `brain/automations.sh` (corre `sync-experts.mjs` primero; idempotente) |
| **MCP terra-domain** | Herramientas read-only: `get_farm_context`, `list_modules`, `get_crop_profile`, `latest_readings`, `telemetry_range`, `module_confidence`, `recent_alerts`, `daily_report_data` | `mcp.servers.terra-domain` |
| **MCP terra-finance** | Ledger financiero (dueño de `movements`): `register_movement` ✏️, `void_movement` ✏️, `set_supply_cost` ✏️, `list_movements`, `cost_summary`, `list_supplies` | `mcp.servers.terra-finance` (`http://finance:7761/mcp`) |
| **Portero (Fase 3)** | Gate de actuación: `terra-policy` MCP `:7762/mcp` + HTTP `:7762/healthz` y `/api/approvals` (PWA). Valida confianza/health/ventanas/techos/rate/serialización; publica `terra/{tenant}/{module}/{device}/cmd` solo si `policy_id` no vacío. Skills `aprobaciones` (gate humano) y `ordenes-trabajo` (tareas manuales) en `main`; expertos usan `propose_action` vía `terra-policy` POR CLASE (`action_class`, sin device ids — ver `_template-experto/skills/cultivo-{{ESPECIE}}/SKILL.md` §6, ADR-0028). | `services/policy/` · `mcp.servers.terra-policy` (`http://policy:7762/mcp`) · env `POLICY_ADMIN_TOKEN` (setup.sh) |

**Modelo y canal: agnósticos (ADR-0001).** El template no trae ninguno preconfigurado — el deployer elige post-boot con `openclaw config set agents.defaults.model.primary <proveedor/modelo>` y el canal correspondiente (`channels login` / `config set channels.<c>...`). WebChat (Control UI) funciona sin configurar nada.

**Fase 3 — lazo cerrado:** el portero (`terra-policy` :7762) es el único que publica `cmd` con `policy_id`; expertos proponen vía `propose_action`, humanos aprueban vía `aprobaciones`, tareas manuales vía `ordenes-trabajo`. En Fase 1 solo había observación; humanos operaban por botones HA (`request/`, ADR-0009) que ahora también pasan por el portero.

## Instalación oficial (ADR-0018)

Se usa la **imagen oficial pre-construida** — prohibido build desde fuente/fork. Tag fijado en compose: `ghcr.io/openclaw/openclaw:2026.7.1-2` (estable más reciente al 2026-08-16; las 2026.8.x eran beta). Para cambiar de versión: edita el tag en `docker-compose.yml`, `docker compose pull openclaw && docker compose up -d openclaw`. Explorar tags: `docker manifest inspect ghcr.io/openclaw/openclaw:latest`.

## Primer arranque — paso a paso

| Paso | Comando | Qué hace |
|---|---|---|
| 0 | `cp .env.example .env` (LLM y canal vienen comentados: descomenta los tuyos) | Envs para compose |
| 1 | `./brain/setup.sh` | Genera tokens en `.env` si faltan y `brain/openclaw.json` desde el template |
| 2 | `docker compose up -d openclaw` | Pull de la imagen oficial y arranque del gateway |
| 3 | `curl -i http://localhost:18789/healthz` · `docker compose exec openclaw node openclaw.mjs config validate` | Health + config contra schema |
| 4 | `docker compose exec openclaw node openclaw.mjs agents list --bindings` | Debe listar `main` (los expertos aparecen tras el paso 5 — los crea `sync-experts.mjs` desde `crop_profiles`) |
| 5 | `./brain/automations.sh --channel <CANAL> --to <DESTINO>` | Corre `sync-experts.mjs` (expertos desde `crop_profiles`: workspaces + agents + crons `revision-<especie>`) y crea el reporte diario (idempotente; sin flags solo expertos) |
| 6 | Configura tu LLM (`config set agents.defaults.model.primary …`) y tu canal (`channels login` o `config set channels.<c>…`) | Sin LLM los turnos fallan; sin canal, WebChat sigue disponible |
| 7 | `./brain/automations.sh --channel … --to …` (si no lo hiciste en 5) | Reporte diario 07:00 a tu canal |

> El destino del reporte (`--to`) se obtiene tras el pairing del canal que elijas (Control UI). Puede añadirse después re-ejecutando `automations.sh`.

## Qué persiste y dónde

- **Volumen `openclaw_state` → `/home/node/.openclaw`** — sesiones, pairing, automations, memoria de runtime. Sobrevive `docker compose down`; borrarlo resetea pairing y automations.
- **`./brain/workspaces/` (un solo bind)** — un subdirectorio por agente (`main`, `experto-<especie>`): SOUL/skills/memoria semilla versionados en git. Los workspaces de expertos son GENERADOS por `sync-experts.mjs` desde `_template-experto/` (SOUL/IDENTITY/TOOLS/skills se reescriben; `MEMORY.md` jamás se pisa — es memoria experiencial). Nueva especie = crear el perfil en la PWA y re-correr `./brain/automations.sh` (ADR-0028), sin tocar compose ni template.
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
| Experto no existe (`agents list`) | Los expertos ya NO viven en el template: los genera `sync-experts.mjs` desde `crop_profiles` (ADR-0028). ¿Creaste el perfil y corriste `./brain/automations.sh`? Verifica `list_crop_profiles` vía MCP. |
| Automation no corre | `docker compose exec openclaw node openclaw.mjs automations list` → revisa `nextRun`. Logs del run en el Control UI. El webhook exige que el bridge esté arriba (`http://bridge:7765`). |
| Alerta no llega al experto | Log del bridge: `[bridge] hook OK (… agent=experto-lechuga)`. Si cae a `main`: el experto no existe o el hook lo rechazó. Verifica `hooks.allowedAgentIds`. ¿Corriste `automations.sh` tras crear el perfil? |
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
    _template-experto/       # plantilla genérica ({{ESPECIE}}) — fuente de los expertos
    experto-<especie>/       # GENERADO por sync-experts.mjs (SOUL/skills reescritos; MEMORY.md experiencial, jamás se pisa)
```
