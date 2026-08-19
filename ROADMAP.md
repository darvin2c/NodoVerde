---
type: roadmap
title: Roadmap terraOS
description: Fases de construcción y backlog diferido con triggers de entrada
tags: [terraos, roadmap]
created: 2026-08-15
status: vigente
---

# Roadmap

> Pruebas por fase (manual + automática): [docs/02-plan-pruebas.md](docs/02-plan-pruebas.md)

## Contexto de la primera campaña

- **Sistema**: hidroponía (perfiles de cultivo en YAML — cambiar de cultivo = cambiar de archivo).
- **Finca**: Lambayeque, Perú (-6.486, -79.647 · 107 msnm · America/Lima). Clima real vía Open-Meteo, incluida ET0 FAO-56 ya calculada.
- **4 módulos** con kit: EC, pH, temperatura de agua, nivel de tanque, caudalímetro, estación climática (1 por invernadero), 1 cámara por módulo.
- **Actuadores**: dosificadoras (nutriente A/B, pH-down), bomba de recirculación, válvula de relleno, aireador.

## Fases

### Fase 0 — Data plane + simulador + interfaz
- `deploy/docker-compose.yaml`: Mosquitto + TimescaleDB + MinIO + **Telegraf** (ingestor) + **Home Assistant** (interfaz visual, ADR-0008) + Grafana.
- `sim/`: modelo de solución nutritiva (EC/pH/tanque/temp) + **clima real histórico de Lambayeque** (Open-Meteo archive: temp/HR/ET0 horaria, 30 días en replay) + capa de sensores calibrada (ruido/deriva/cuantización tipo Atlas/DS18B20) + mezcla gradual de dosis + reloj dual (1:1/Nx) + escenarios YAML + perfiles de cultivo YAML. Fallback offline sintético determinístico.
- Dispositivos virtuales definidos en **YAML de ESPHome** corriendo en modo host — el mismo archivo se flashea en Fase 5.
- Esquema DB: telemetría + `tenant_id` + tabla de movimientos (ADR-0011).
- **Criterio de salida:** lazo visible — sim → MQTT → Telegraf → TimescaleDB → tarjetas vivas en Home Assistant.

### Fase 1 — Cerebro observador
- OpenClaw 24/7 multi-agente (orquestador + expertos por especie con memoria propia; ADR-0019) + **bridge MQTT↔OpenClaw** (servicio delgado) + acceso read-only vía MCP.
- Canal WhatsApp/Telegram: reportes diarios, alertas, fotos.
- **PWA terraOS** (ADR-0014): pantalla de estado read-only por secciones (sistema, módulos, campo, finanzas, pendientes, cámaras).
- Watchdog propio: salud de dispositivos (silencio/congelado/imposible/LWT). Umbrales simples en Grafana.
- Termómetro de confianza por módulo (ADR-0010) visible en HA y en el reporte diario.
- **Criterio de salida:** el agente reporta estado del cultivo por chat con datos reales del sim. Cero actuación. Modo manual disponible vía botones de HA. En módulos sin datos, el agente practica oficina activa (pide fotos/mediciones).

### Fase 2 — Finanzas (registro simple, ADR-0011)
- Tabla de movimientos: gasto/ingreso, categoría, moneda, imputación a cultivo (total o proporcional).
- Captura por chat: texto, foto de recibo (VLM), nota de voz. Extraer → defaults → preguntar mínimo → confirmar. Dedup + evidencia en MinIO.
- Auto-registro desde actuadores (dosificación → gasto en nutrientes). El agente se auto-contabiliza (tokens → categoría `software`).
- Historia inmutable: corrección por anulación + nuevo movimiento.
- **Criterio de salida:** costo por kg de la cosecha consultable por chat ("¿cuánto costó la lechuga del módulo 2?").

### Fase 3 — Lazo cerrado con actuadores
- Policy module activo: agente propone (o humano pide desde HA), portero valida, aprobación por chat, ejecución, audit.
- **Acciones manuales**: portero emite órdenes de trabajo por chat (podar, mezclar nutrientes) con confirmación y registro (ADR-0010).
- Verificación cruzada en watchdog: comando dosificar → EC debió subir; si no, alerta crítica.
- El portero exige confianza mínima por clase de acción; si falta, el agente recolecta (foto/medición) antes de actuar.
- Autonomía gradual por clase de acción (relleno de agua primero, dosificación después).
- **Criterio de salida:** escenario E2E "EC baja": agente detecta → propone dosificar → humano aprueba → dosificadora actúa → EC sube → costo en ledger.

### Fase 4 — Campaña con pausas honestas (ADR-0021)
- Simulador una temporada completa (ciclo lechuga ~45 días **de reloj sim**). Admite apagados declarados en workstation: pausas totales nocturnas + una caída parcial semanal del sim con stack vivo — las pausas son parte del protocolo (matriz de degradación ADR-0010), no violaciones.
- Prerequisitos de código (verificables acelerado): catch-up del sim al reanudar (el mundo vive la pausa, el reloj se resincroniza), alerta `data_gap` en watchdog, alerta `cmd_sin_policy` en router, cron de tokens determinístico, tabla `campaigns` + `open/close_campaign`, chequeo `invariant_ledger` en finance.
- Invariantes, cada una validada por su dueño y publicada al topic `alert` con estado pendiente/resuelta: finance → imputación 100%; router → cero comandos sin policy; cron → presupuesto de tokens (techo USD/mes).
- **Criterio de salida:** campaña completa con **cero alertas de invariante sin resolver al cierre** (una alerta corregida no invalida).

### Fase 5 — Hardware real (piloto mínimo)
- 1 ESP32 flasheado con el YAML ESPHome de la Fase 0 + 1 sensor EC + 1 dosificadora.
- Interlocks físicos. Radio campo: el sistema debe soportar WiFi + LoRa + celular (ADR-0015 §"Requisito multi-transporte"); el piloto decide **cuál usa cada ubicación**, no cuál existe.
- Día 1 del piloto: experimentos de broker discovery en el orden acordado (mDNS → DNS fijo público → QR custom; celular exige hostname público) — plan detallado en ADR-0015 §"Plan de evaluación".
- **Criterio de salida:** el piloto convive con el sim sin que el sistema distinga la diferencia.

### Fase 6 — PWA crece a UI completa
- **Trigger cumplido 2026-08-19** (declarado por el dueño): la operación de la campaña de Fase 4 exige centro de alertas con remediación, vistas de módulos y aprobaciones pro — la portada read-only se quedó corta antes de empezar la campaña.
- La PWA de Fase 1 crece: operación, vistas financieras completas, vista del agente.
- Implementado 2026-08-19: dashboard pro estilo shadcn-admin (Base UI + Tailwind v4), dark/light, sidebar + header con ⌘K y campana, rutas Overview/Módulos(+detalle)/Alertas/Finanzas/Aprobaciones/Cámaras/Sistema, centro de alertas con mapa de remediación en código (`pwa/src/lib/remediation.ts`) y resolución gobernada vía MCP (`alerts.resolve` → mcp-domain `resolve_alert`, ADR-0021).
- Si integraciones externas lo exigen: fachada OpenAPI sobre los mismos servicios.

## Backlog diferido (con triggers)

| Pieza | Trigger de entrada |
|---|---|
| Policy module → servicio separado | Multi-finca operativo |
| Learning loop (destilación automática, estilo Hermes) | ≥1 campaña de decisiones registradas (tabla `campaigns` + audit del portero, ADR-0021) |
| IA generativa para fotos del sim | Pipeline de visión funcionando |
| Escenarios generados por LLM | Los escenarios YAML se quedan cortos |
| OpenAPI | Primera API REST real |
| Wokwi (test de firmware en CI) | Firmware ESPHome real en Fase 5 |
| Radio campo: LoRa/celular + ChirpStack | Piloto de hardware real |
| Auth/aislamiento multi-tenant | Segunda finca real |
| Tauri desktop | Notificaciones nativas / tray / autostart / offline real |
| Fachada OpenAPI pública | Primera integración externa |
| NATS | Eliminado. Solo evidencia de que MQTT no basta lo resucita |
| UI propia | **Ya planificada**: PWA nace en Fase 1 y crece en Fase 6 (ADR-0014) |

## Regla de admisión

> Nada entra al build sin trigger cumplido. Lo diferido vive aquí, no en el código.
