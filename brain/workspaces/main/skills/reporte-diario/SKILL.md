---
name: reporte-diario
description: Genera el reporte diario por módulo — estado, confianza, desvíos de rango, alertas y datos faltantes (usa daily_report_data)
---

# Skill: Reporte Diario

Generas el **resumen de las últimas 24 h por módulo** que se envía cada mañana por Telegram/WhatsApp. Cero actuación: solo lectura y redacción.

## Herramienta principal

```
daily_report_data({ tenant?: string }) → {
  modules: [{ id, crop, confidence: { v, sources }, health: { state, devices }, readings: { ec, ph, temp, level, flow, air_temp, humidity }, alerts: [...] }],
  generated_at: epoch_ms
}
```

Si `daily_report_data` no está disponible, compone el reporte consultando por módulo:
`telemetry_range` (últimas 24 h) + `module_confidence` + `get_crop_profile` + `recent_alerts`.

## Estructura del reporte (español, conciso)

```
🌱 Reporte diario — <nombre de la finca según get_farm_context> — YYYY-MM-DD (<tz de la finca>)

Módulo mod-1 (lechuga) — confianza 78% [ec 88% | ph 82% | temp 75% | level 90%]
  EC 1.45 mS/cm (rango 1.2–1.8) ✓  pH 6.0 (5.8–6.3) ✓
  Temp agua 22.1 °C (18–24) ✓  Nivel 62%  Flujo 4.2 L/min  Aire 27 °C / 68%
  Salud: ok — sin alertas

Módulo mod-3 (tomate) — confianza 43% [ec 45% ⚠ dato de hace 2.5 h | ph 60% …]
  EC 1.7 mS/cm (rango 2.0–3.5) ↓ bajo — lleva 6 h por debajo del mínimo
  Salud: degraded — device_silence en ec-01 desde 03:12
  ⚠️ Faltante: EC con confianza baja; pido medición manual (ver oficina-activa)

Alertas 24 h: 2 (device_silence ec-01 mod-3, module_blind mod-4 resuelto 06:40)
Finanzas: (placeholder Fase 2 — costo/kg disponible desde Fase 2)

Faltantes declarados: mod-4 sin foto en 18 h — pido foto del módulo 4
```

## Reglas

1. **Siempre declara confianza y faltantes.** Ausencia ≠ cero. Si un sensor no reportó, escribe "sin dato (última lectura hace X h)".
2. **Nunca 100%.** Si el MCP reporta 100, cap a 95 y nota "cap 95% (sensores nunca 100%)".
3. **Rangos desde MCP.** Cita `get_crop_profile` por cultivo; no hardcodees.
4. **Desvíos con contexto.** Indica cuánto tiempo lleva fuera de rango y con qué confianza.
5. **Alertas del watchdog tal cual.** `device_silence`, `device_frozen`, `device_impossible`, `device_offline`, `device_recovered`, `module_blind`, `module_recovered` — no inventes nombres.
6. **Finanzas placeholder.** Si preguntan costo, responde: "Finanzas detalladas llegan en Fase 2; hoy el reporte cubre estado agronómico y confianza".
7. **Cita frescura.** Cada valor lleva fuente y edad: "EC 1.45 (sensor hace 2 min)" o "foto hace 8 h".
8. **Oficina activa.** Si `health.state == "blind"` o confianza global <40%, añade al final: "Módulo X en oficina activa — necesito [foto/medición] para subir confianza".

## Qué NO hacer

- No proponer dosis, no editar perfiles, no comandar actuadores.
- No hacer aritmética financiera.
- No inventar valores de sensores ni redondear la confianza a 100.
