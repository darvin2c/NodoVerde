---
type: architecture
title: Arquitectura terraOS
description: Componentes, flujo de datos y matriz de dueños únicos por función
tags: [terraos, arquitectura]
created: 2026-08-15
status: vigente
---

# Arquitectura

## Vista simple (C4 nivel 1)

```
CAMPO (simulado hoy, hardware mañana)  →  CEREBRO  →  PORTERO  →  CAMPO
                                               ↕
                                          TÚ (chat)
```

1. **El campo** — hoy un simulador con física real (FAO-56); mañana hardware real. Publica por MQTT y todo queda en la base de datos.
2. **El cerebro** — OpenClaw multi-agente (ADR-0019): un **orquestador** (única voz al humano) + un **agente experto por especie** (memoria y playbook propios; hablan directo con el portero, que los valida como a cualquier solicitante). Lee datos, mira fotos, reporta por WhatsApp/Telegram, llevará las cuentas (Fase 2).
3. **El portero** — policy module. Toda orden a actuador pasa por él: valida límites, pide aprobación, deja registro.
4. **Tú** — WhatsApp/Telegram. Reportes, fotos, aprobaciones. Esa es toda la interfaz.

## Vista de contenedores (C4 nivel 2)

```mermaid
flowchart LR
    subgraph SIM["sim/ (TypeScript)"]
        FIELD[Modelo hidroponía: EC/pH/tanque<br/>clima real Open-Meteo (replay 30d)<br/>sensores calibrados · reloj dual 1:1/Nx]
        DEV[Dispositivos: YAML ESPHome modo host]
    end
    subgraph EDGE["edge/ (futuro: hardware real)"]
        REAL[Mismo YAML ESPHome flasheado<br/>+ interlocks de seguridad física]
    end
    subgraph VPS["VPS (todo en docker-compose durante desarrollo)"]
        MQT[(Mosquitto MQTT)]
        TEL[Telegraf: MQTT → DB]
        DB[(Postgres + TimescaleDB<br/>telemetría + dominio + ledger)]
        OBJ[(MinIO: fotos)]
        HA[Home Assistant: interfaz visual<br/>botones → solicitudes, nunca comandos]
        BRAIN[Cerebro: OpenClaw multi-agente (ADR-0019)<br/>orquestador + expertos por especie<br/>+ bridge MQTT↔OpenClaw]
        GRAF[Grafana: análisis + alertas de umbral]
        WD[Watchdog: salud dispositivos<br/>+ verificación cruzada]
    end
    CHAT[WhatsApp / Telegram]
    DEV --> MQT
    REAL -.->|mismo contrato AsyncAPI| MQT
    MQT --> TEL --> DB
    MQT <--> HA
    SIM --> OBJ
    DB --> GRAF
    MQT --> WD -->|event/alert| MQT
    MQT <--> BRAIN
    BRAIN -->|tools MCP| DB
    BRAIN <--> CHAT
```

**Modos de operación** ([ADR-0009](20-adr/0009-modos-operacion-solicitudes-humanas.md)): manual (humano vía botones HA) → supervisado (agente propone, humano aprueba) → autónomo (por clase de acción). Humano e IA son ambos solicitantes ante el mismo portero.

## Matriz de dueños

Toda función tiene exactamente un dueño. Quien no es dueño, tiene prohibido ejercerla.

| Función | Dueño único | Prohibido a |
|---|---|---|
| Bus de mensajería | **MQTT (Mosquitto)** | NATS (eliminado); buses internos de OpenClaw/HA nunca salen de su proceso |
| Autorizar actuadores | **Policy module** | OpenClaw (nunca expone actuadores como skill); automatizaciones de HA (prohibidas para actuadores agrícolas) |
| Seguridad física | **Interlocks en edge** | Todo software (los interlocks funcionan aunque caiga todo lo demás) |
| Registro de dispositivos/assets | **DB de dominio** | Registries de HA; inferencia del agente |
| Memoria operativa del agente | **Markdown de OpenClaw** | Duplicar ese conocimiento en DB |
| Datos de negocio | **DB (Postgres/TimescaleDB)** | Markdown del agente; tablas `agent_*` que dupliquen el ledger |
| Herramientas del agente | **MCP** | Skills de ClawHub para dominio agrícola/financiero (solo genéricas) |
| Dashboard telemetría | **Grafana** | UI propia en v1 |
| Interfaz operativa | **Chat (WhatsApp/Telegram)** | UI propia en v1 |
| Contrato de mensajes | **[AsyncAPI](contract/asyncapi.yaml)** (v0.4.0: dos planos — dispositivo `hw_id` + interno `tenant/module`, ver ADR-0015) | Payloads ad-hoc fuera del spec |
| Ingesta MQTT → DB | **Telegraf** (config declarativa) | Consumidor propio (solo si Telegraf se queda corto) |
| Interfaz visual | **Home Assistant** (ADR-0008/0009) | UI propia; sus botones publican solicitudes, nunca comandos |
| Firmware de nodos | **ESPHome** (YAML; modo host en sim) | Firmware propio en C++/MicroPython |
| Alertas de umbral simple | **Grafana** | Watchdog propio para umbrales |
| Salud de dispositivos + verificación cruzada | **Watchdog propio** | Reglas YAML dispersas en HA |
| Cálculo del termómetro de confianza | **Servicio de dominio** (función determinística: fuente × edad, ADR-0010) | El LLM (jamás calcula confianza) |
| Exigir confianza mínima por acción | **Policy module** | El agente decidiendo "ya es suficiente" |
| Órdenes de trabajo manuales | **Policy module** las emite, **chat** las entrega (ADR-0010) | Comandos MQTT a humanos |
| IoT hub / integraciones | **Home Assistant** (ADR-0008) | openHAB, Gladys (descartados) |
| Cerebro | **OpenClaw** | Hermes (descartado como pieza; su learning loop va al backlog) |
| Propuestas agronómicas por cultivo | **Agente experto de la especie** (workspace + memoria + playbook propios, ADR-0019) | El orquestador improvisando agronomía |
| Canal hacia el portero | **Cualquier agente validado** (expertos directo, ADR-0019; la validación dura vive en el portero) | Publicar `cmd/` por fuera del portero; orquestador reenviando propuestas (mensajería LLM innecesaria) |
| Cambios a perfiles de cultivo | **Humano aprueba** (experto solo propone) | Auto-edición de perfiles por el agente |
| Ledger financiero (`movements`) | **MCP terra-finance** (`services/finance`, dueño único de escritura; `voided_by`/`anula_a` + filtro vigente `voided_by IS NULL AND anula_a IS NULL`) | Cualquier otro escritor (mcp-domain, PWA, agente directo a DB) |
| Lecturas de telemetría | **MCP terra-domain** (read-only) + **Telegraf** (ingesta) | Escritura de telemetría por otros servicios |
| Invariante financiera de campaña (imputación 100%) | **finance** (valida su propio ledger y publica al topic `alert`, ADR-0021) | Watchdog u otro servicio conociendo reglas del ledger |
| Invariante de actuación (cero cmd sin policy) | **router** (único que ve el descarte; publica `cmd_sin_policy`, ADR-0021) | Inferencia externa desde logs |
| Invariante de presupuesto de tokens | **Cron de tokens** (lee usage del gateway, calcula USD en código, registra en ledger, ADR-0021) | El LLM calculando o reportando su propio gasto |
| Registro de ciclo biológico (lotes: perfil + memoria + módulos, campaña como etiqueta) | **MCP terra-domain** (tabla `lotes`, `open/close_batch`, hashes en código, ADR-0021/0024; un módulo solo aloja un lote activo) | Markdown del agente como registro primario |
| Provisionamiento de módulos (`modules`, claiming `device_identities`) | **MCP terra-domain** (`create/update/retire_module`, `claim_device`, ADR-0022/0025; nombre propagado a HA por el router vía evento `meta`; el módulo NO tiene cultivo propio — es infraestructura fungible) | PWA/agente escribiendo `modules` directo a la DB |
| Cultivo vigente de un módulo (`modules.crop` como caché) | **Ciclo del lote** (`open_batch` lo escribe, `close_batch` lo limpia a NULL; ADR-0025). Nadie más escribe esa columna | update_module, seeds, supervisor del sim |
| Perfiles de cultivo (`crop_profiles`: crear/editar) | **MCP terra-domain** (`create/update_crop_profile`, ADR-0025) — solo humano vía PWA (regla 9) | El LLM creando/editando perfiles |
| Gestión de fincas (`tenants`: crear/editar/archivar, tz derivada, moneda) | **MCP terra-domain** (`create/update/archive_tenant`, ADR-0023; id slug inmutable, nada se borra) | PWA/agente escribiendo `tenants` directo; sumas globales que mezclen monedas |
## Flujo de una decisión (lazo cerrado)

1. Simulador/edge publica telemetría → MQTT → Telegraf → TimescaleDB.
2. Cerebro observa (vía bridge MQTT↔OpenClaw + consultas MCP a DB).
3. Alguien propone una acción: el cerebro (dosificar nutriente A) o un humano (botón en HA).
4. La propuesta pasa al **policy module**: valida rangos del perfil de cultivo, límites, presupuesto. Si la clase de acción lo exige → pide aprobación por chat.
5. Aprobada → comando MQTT al actuador → ejecución → confirmación de estado.
6. Watchdog verifica el efecto físico (dosifiqué → EC debió subir).
7. Todo queda registrado: propuesta, validación, ejecución, costo en el ledger.

## Reglas de datos

- Telemetría → TimescaleDB (hypertable).
- Dominio (parcelas, cultivos, tareas, ledger) → Postgres, todas las tablas con `tenant_id`.
- Media (fotos) → MinIO; en DB solo metadata + referencia.
- Conocimiento del agente → su Markdown (auditable por humanos).
- **Nunca el mismo dato en dos sitios.**

## Superficies (ADR-0014)

| Superficie | Dueña de |
|---|---|
| **PWA terraOS** (Vite+React+tRPC+shadcn/Base UI, panel de control — Fase 6 implementada) | Vista resumen unificada |
| Home Assistant | Operación del fierro (botones → portero) |
| Grafana | Análisis profundo + alertas de umbral |
| Chat | Conversación, aprobaciones, captura financiera |
| OpenClaw Control UI | Estado del cerebro |

## Despliegue

Híbrido ([ADR-0006](20-adr/0006-despliegue-hibrido.md)): VPS corre cerebro + data plane; edge local en finca (futuro) sobrevive cortes de red/luz. En desarrollo, todo corre en docker-compose local.
