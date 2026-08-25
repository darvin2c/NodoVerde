# terra-policy — Portero de actuación (Fase 3, ADR-0009/0019/0020)

**Único publicador de `cmd/`** en todo el sistema. Toda actuación — la proponga un agente IA o un humano desde Home Assistant (`request/`) — pasa por el mismo gate: validación dura en código, aprobación según autonomía de la clase, publicación y auditoría. Los expertos hablan con el portero directo (MCP); jamás publican `cmd/` ni tienen message tool (ADR-0019).

## Qué hace

```
 agente IA (MCP propose_action)        humano (HA → request/…)
              │                              │
              └──────────┬───────────────────┘   ← igualdad de solicitantes (ADR-0009)
                         ▼
                  ┌─────────────┐   validación dura (código, NUNCA skill):
                  │  terra-policy│   salud del módulo · confianza mínima ·
                  │   (portero)  │   techo EC/pH/nivel · ventana horaria ·
                  └──────┬───────┘   rate limit · params · lote activo (ADR-0025)
                         │
            autonomía de la clase de acción
              ┌──────────┴──────────┐
        supervised            autonomous
        (dose_nutrient,       (fill_water,
         dose_ph)              recirculate)
              │                     │
              ▼                     ▼
     pending → aprobación    publica directo
     (botón PWA / chat)            │
              └──────────┬─────────┘
                         ▼
        terra/{tenant}/{module}/{device}/cmd   (qos1, único publicador)
                         │
        auditoría: executed | failed (jamás executed sin cmd publicado)
                         ▼
        evento → bridge /policy-event → cerebro (fire-and-forget)
```

- **Clases de acción** (config en código, `config.ts`): `fill_water` (`valve-fill-01`, autonomous, confianza level≥80), `dose_nutrient` (`doser-a/b-01`, supervised, ec≥70, pulso ≤10 s), `dose_ph` (`doser-ph-01`, supervised, ph≥70, pulso ≤8 s), `recirculate` (`pump-recirc-01`, autonomous, level≥50).
- **Reglas duras** (`rules.ts`, funciones puras): salud (`blind`/`offline` → rechazo), confianza mínima por métrica (insuficiente → `needs_data` con lo que falta), techo duro contra el perfil del cultivo (EC ≥ ec_max+0.5, pH ≤ ph_min−0.5, nivel ≥95), ventana horaria en tz de la finca (override `POLICY_WINDOWS_JSON`), rate limit por clase, y validación de params (`start` exige `duration_ms` 500..max; `set` exige `{v: ON|OFF}`). Apagar (`stop`/`OFF`) siempre pasa: es seguro.
- **Lote activo (ADR-0025):** la actuación **biológica** (`dose_nutrient`/`dose_ph` que energiza) exige lote vivo en la mesa; sin cultivo → rechazo honesto `no_active_batch`. También al aprobar: si el lote cerró mientras la acción esperaba, se rechaza. La actuación de fierro (bomba/válvula) sigue libre para mantenimiento.
- **Humanos por `request/`:** consumer suscrito a `terra/+/+/+/request/#` (solo actuadores, `set|start|stop`); cada solicitud entra al mismo pipeline con `source: "human"`.
- **Notificación:** eventos `proposal_pending` / `action_executed` / `work_order_created` / `needs_data` → `POST {BRIDGE_URL}/policy-event?token=<OPENCLAW_HOOK_TOKEN>` (fire-and-forget, timeout 3 s; el cerebro se entera vía bridge).
- **Estado y auditoría:** `action_requests` en Postgres (`state.ts`/`db.ts`); readings/confianza/health en caché desde MQTT (`terra/+/+/+/+/reading`, `terra/+/+/confidence`, `terra/+/+/health`).

## Tools MCP (`POST :7762/mcp`)

| Tool | Qué hace |
|---|---|
| `propose_action` | Propone actuación (`tenant`, `module`, `device`, `action` start/stop/set, `params`, `requested_by`). Valida y encola o ejecuta según autonomía. |
| `approve_action` | Aprueba una acción pending. Re-valida lote/salud/confianza antes de publicar el `cmd/`. |
| `reject_action` | Rechaza una acción pending (con motivo). |
| `list_pending_actions` | Lista aprobaciones pendientes (filtro por tenant). |
| `list_action_history` | Historial de acciones decididas/ejecutadas. |
| `create_work_order` | Crea orden de trabajo manual (tarea para humano, sin actuación). |
| `complete_work_order` | Marca una orden como completada. |
| `list_work_orders` | Lista órdenes de trabajo (filtro tenant/status). |

## HTTP (mismo puerto, para la PWA)

| Endpoint | Qué hace |
|---|---|
| `GET /healthz` | Sin auth. |
| `GET /api/approvals?tenant=` | Pendientes (requiere `POLICY_ADMIN_TOKEN`). |
| `POST /api/approvals/{id}/approve` | Aprueba (botón PWA; body `{by}`). |
| `POST /api/approvals/{id}/reject` | Rechaza (body `{by, reason?}`). |
| `GET /api/work-orders?tenant=&status=` | Lista órdenes. |
| `POST /api/work-orders/{id}/complete` | Completa orden (body `{by, note?}`). |

## Env

| Variable | Default | Descripción |
|---|---|---|
| `POLICY_PORT` | `7762` | Puerto HTTP (MCP + API aprobaciones + healthz) |
| `DATABASE_URL` | `postgres://terra:changeme@localhost:5432/terra` | Postgres (estado y auditoría) |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker (subs reading/confidence/health/request + publicación `cmd/`) |
| `BRIDGE_URL` | `http://localhost:7765` | Base URL del bridge (eventos → cerebro) |
| `OPENCLAW_HOOK_TOKEN` | *(vacío)* | Token del endpoint `/policy-event` del bridge |
| `POLICY_ADMIN_TOKEN` | `dev-admin-token` | Auth de la API HTTP de aprobaciones (PWA). **Cambiar fuera de dev** (lo genera `brain/setup.sh` en `.env`) |
| `POLICY_WINDOWS_JSON` | *(vacío)* | Override de ventanas horarias por clase, p.ej. `{"dose_nutrient":[6,20]}` |

## Desarrollo

```bash
pnpm install
pnpm dev       # tsx — MCP :7762 + consumer MQTT + API aprobaciones
pnpm test      # vitest run — reglas puras (rules.ts) sin broker
pnpm exec tsc --noEmit  # chequeo de tipos
```

Deploy con el resto del cerebro: `docker compose --profile cerebro up -d`. Healthcheck: `curl -sf http://localhost:7762/healthz`.

## Contrato

- Publica `terra/{tenant}/{module}/{device}/cmd` (plano dispositivo, enforcement del router ADR-0020) — **nadie más publica ahí**.
- Suscribe `terra/+/+/+/request/#`, `terra/+/+/+/+/reading`, `terra/+/+/confidence`, `terra/+/+/health`. Ver `contract/asyncapi.yaml`.

## Referencias

- ADR-0009: Órdenes humanas desde HA van a `request/` — el portero valida a humanos e IA por igual.
- ADR-0019: Expertos hablan con el portero directo; la validación dura vive en esta herramienta (código), jamás en una skill.
- ADR-0020: Portero como único publicador de `cmd/` + enforcement en el router.
- ADR-0025: Flujo lote-céntrico — actuación biológica exige lote activo.
