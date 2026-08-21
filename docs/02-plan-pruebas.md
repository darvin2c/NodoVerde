---
type: reference
title: Plan de pruebas por fase
description: Qué se construye en cada fase y cómo se prueba — manual y automáticamente
tags: [terraos, testing, roadmap]
created: 2026-08-15
status: vigente
---

# Plan de pruebas por fase

Cada fase tiene dos verificaciones: **manual** (lo que tú ves y tocas) y **automática** (lo que corre en CI). Regla: la automática cubre lo que la manual ya validó una vez.

## Fase 0 — Mitad IoT + simulador

**Se construye:** docker-compose (Mosquitto, TimescaleDB, MinIO, Telegraf, HA, Grafana) · esquema DB · sim hidropónico (EC/pH/tanque/temp + clima real Open-Meteo en replay + capa de sensores calibrada + mezcla gradual + reloj dual + persistencia) · dispositivos MQTT + discovery HA · escenarios YAML.

| Manual | Automática |
|---|---|
| Abrir HA: 4 módulos con tarjetas vivas (EC, pH, temp, tanque) | Unit: modelo de solución nutritiva (EC cae con consumo, sube con dosificación; pH deriva) |
| Ver curvas del día en Grafana | Unit: reloj dual (1:1 y Nx producen misma física por día simulado) |
| Botón prender/apagar recirculación → caudalímetro se mueve | Integración: cada payload MQTT valida contra AsyncAPI v0.3.0 (contract test) |
| Escenario `sensor_muerto`: tarjeta se queda gris, status `offline` por LWT | Integración: Telegraf escribe lecturas en TimescaleDB |
| Apagar todo, prender mañana: el mundo vivió la noche (catch-up: tanque/EC evolucionaron sin lecturas del hueco) y el sistema declara el gap | Integración: estado del sim sobrevive reinicio + catch-up integra el hueco (ADR-0021) |
| | Unit: RNG con semilla fija → misma corrida reproducible |

**Criterio de salida:** lazo visible sim → MQTT → Telegraf → TimescaleDB → HA.

## Fase 1 — Cerebro observador

**Se construye:** OpenClaw + bridge MQTT↔OpenClaw + canal WhatsApp/Telegram + termómetro de confianza + watchdog + oficina activa.

| Manual | Automática |
|---|---|
| Recibir reporte diario en WhatsApp con datos reales | E2E acelerado: 7 días simulados → el reporte contiene los números correctos (contra ground truth del sim) |
| Preguntar por chat "¿cómo va el módulo 2?" | E2E: `sensor_muerto` inyectado → el agente reporta el sensor caído y NO inventa su valor |
| Apagar el sim → el agente declara "estoy ciego" y pide foto/medición | E2E: edge caído → agente entra en modo oficina, cero comandos emitidos |
| Ver gauge de confianza por módulo en HA | Unit: termómetro (fuente × edad) con casos límite |
| | E2E: confianza baja bloquea acción y dispara petición de datos |

**Criterio de salida:** agente reporta con datos reales; honestidad verificada (declara lo que no sabe).

## Fase 2 — Finanzas (registro simple)

**Se construye:** tabla movimientos + captura texto/foto/voz + dedup + evidencia MinIO + auto-registro desde actuadores.

| Manual | Automática |
|---|---|
| Mandar "gasté 150 en nutriente A" → confirmación → consulta | Unit: extracción y categorización con casos ambiguos |
| Mandar foto de recibo → movimiento con evidencia | E2E: dedup — mismo monto+fecha → pregunta antes de duplicar |
| Corregir: "ese gasto era del módulo 3" → anulación + nuevo | Property-based: imputaciones siempre suman 100%, nunca se borra historia |
| Preguntar "¿cuánto costó la lechuga del módulo 2?" | E2E: dosificación automática genera su movimiento de gasto solo |

**Criterio de salida:** costo por kg consultable por chat.

## Fase 3 — Lazo cerrado (portero)

**Se construye:** policy module (`services/policy`, ADR-0020) + órdenes de trabajo + verificación cruzada + autonomía gradual.

| Manual | Automática |
|---|---|
| Escenario `ec_baja`: agente propone → apruebas por chat → dosifica → EC sube | E2E completo con aserciones en cada eslabón + movimiento financiero generado: `pnpm --dir e2e ec-baja` (stack vivo + sim `--scenario ec_baja`) |
| Botón de HA pasa por el portero (ves el audit) | Unit: reglas del portero (ventanas, límites, umbrales de confianza) — `cd services/policy && pnpm test` |
| Intentar acción fuera de rango → portero rechaza con razón | E2E: comando sin `policy_id` jamás llega al actuador — router lo descarta (unit `cd router && pnpm test` + aserción en `e2e/ec-baja`) |
| Orden de trabajo manual: "podar módulo 1" llega por chat con instrucciones | E2E: verificación cruzada — dosificar sin que EC suba → alerta crítica `verification_failed` (unit `cd services/watchdog && pnpm test`) |
| Aprobar/rechazar desde la PWA (botón, cero LLM) | Unit: procedures tRPC `pending.*` — `cd pwa && pnpm test` |

**Criterio de salida:** E2E "EC baja" pasa de punta a punta.

## Fase 4 — Campaña con pausas honestas (~45 días de reloj sim, ciclo lechuga; ADR-0021)

**Prerequisitos de código (nivel 2-3, acelerados):** catch-up del sim al reanudar (apagado de 8 h → el mundo vivió la noche, la confianza cae y se recupera sola con lecturas frescas), alerta `data_gap` en el arranque, alerta `cmd_sin_policy` del router, cron de tokens → movimiento `software` diario, chequeo `invariant_ledger` en finance, `open/close_batch` con hash de perfil y memoria (ADR-0024).

| Manual | Automática |
|---|---|
| Revisión semanal: memoria del experto (Markdown) + decisiones tomadas | Invariantes continuas, cada una validada por su dueño (ADR-0021): imputación 100% (finance), cero comandos sin policy (router), presupuesto de tokens en USD/mes (cron) → alertas con estado pendiente/resuelta |
| Protocolo de pausas: apagado nocturno → el reporte declara el gap ("sin datos de X a Y"); caída parcial semanal del sim → oficina activa (pide fotos/mediciones), finanzas siguen | Reincorporación: gap detectado y reportado, confianza se recupera con datos nuevos, portero bloquea actuación mientras confianza baja (ADR-0010) |
| Al cierre: ¿el experto destiló lecciones correctas? ¿los lotes quedaron registrados con perfil + memoria (un lote por ciclo, campaña como etiqueta, ADR-0024)? | Grafana: histórico de confianza por módulo |

**Criterio de salida (decidible):** 45 días de sim completos con **cero alertas de invariante en estado pendiente al cierre**. Una violación detectada y corregida (ej: movimiento anulado + recreado, ADR-0011) no invalida la fase.

## Fase 5 — Piloto hardware real

**Se construye:** ESP32 + sensor EC + dosificadora con el YAML ESPHome de Fase 0 + interlocks físicos.

| Manual | Automática |
|---|---|
| El piloto convive con el sim: el sistema no distingue cuál es real | Contract tests contra el hardware real (mismo AsyncAPI) |
| Interlock: intentar dosificar con tanque vacío → bloqueo físico | E2E mixto: 3 módulos sim + 1 real |
