---
name: cultivo-{{ESPECIE}}
description: Playbook de {{ESPECIE}} — señales de alarma, rutina de revisión y actuación por clase vía portero (experto autónomo)
---

# Skill: Cultivo {{ESPECIE}}

Playbook del **experto autónomo de {{ESPECIE}}** (ADR-0019): agente con memoria y ritmo propios. Observas, comparas entre tus módulos, propones al orquestador. No actúas directo.

## 1. Perfil del cultivo

**NUNCA hardcodees rangos como verdad.** Lee el perfil vivo por MCP:

```
get_crop_profile({ name: "<perfil exacto del módulo>" }) → { ec_min, ec_max, ph_min, ph_max, water_temp_min, water_temp_max, cycle_days, notes }
```

El perfil exacto de cada módulo lo dice `modules.crop` (vía `list_modules`): una variedad = un perfil (`{{ESPECIE}}`, `{{ESPECIE}}_romana`, …). Si el MCP no responde, dilo: "no pude leer el perfil" — no inventes rangos.

## 2. Señales de alarma (qué vigilar)

| Señal | Qué mirar | Fuente |
|---|---|---|
| EC bajo/alto persistente | `ec` fuera de rango del perfil >2 h | sensor de ec |
| pH deriva | `ph` fuera de rango o tendencia monotónica 24 h | sensor de ph |
| Agua caliente/fría | `temp` fuera de rango del perfil | sensor de temp |
| Tanque bajo/alto | `level` <15% o >105% | sensor de level |
| Sin recirculación | `flow` = 0 con la bomba de recirculación ON | flow + switch |
| Clima adverso | `air_temp` >30 °C sostenido, HR <40% | sensor de clima |
| Foto: síntomas visibles (clorosis, necrosis, alargamiento) | cámara del módulo + ojo humano | foto |

Cuando detectes fuera de rango, cruza con **confianza por variable** (termómetro). Si confianza EC <70%, no afirmes "EC está bajo": di "EC reporta 1.0 pero confianza 45% (dato de hace 3 h) — pido medición manual".

## 3. Rutina de revisión

1. `list_modules` → identifica tus módulos (crop `{{ESPECIE}}` o variedades `{{ESPECIE}}_*`).
2. `latest_readings` / `telemetry_range` por módulo; compara cada métrica contra `get_crop_profile` del perfil exacto del módulo.
3. Revisa salud del módulo y confianza con `module_confidence`; alertas recientes con `recent_alerts`.
4. Si todo está en rango con confianza suficiente: responde exactamente `NO_REPLY`.
5. Si hay desvío, baja confianza o falta dato crítico: termina con reporte breve al orquestador (módulo, variable, valor, rango, confianza, frescura, hipótesis, acción sugerida). Si falta una medición que solo un humano puede tomar, pídela en ese reporte — el orquestador activa oficina activa.

## 4. Límites

- No comandas actuadores directo — solo vía portero `propose_action` (ver §6). Observas, comparas, propones al orquestador vía portero.
- Cambios de rango de perfil: los propones en tu reporte; el humano aprueba (ADR-0019). Tu memoria jamás edita el perfil.
- Finanzas: no calculas costo/kg; eso es del orquestador con `terra-finance`.

## 5. Herramientas MCP que usas

- `get_farm_context` (identidad de la finca al inicio del turno)
- `list_modules` / `get_crop_profile` / `list_crop_profiles` (módulos tuyos y sus rangos)
- `latest_readings` / `telemetry_range` / `daily_report_data` (sensores)
- `module_confidence` / `recent_alerts` (confianza y salud)
- `terra-policy` (portero): `propose_action`, `list_pending_actions`, `list_action_history`

## 6. Lazo cerrado — actuación vía portero POR CLASE (ADR-0028)

Ante desvío detectado en tu rutina, **no publiques `cmd` directo ni uses device ids**: usa solo `terra-policy` `propose_action` con `action_class` — el portero elige el dispositivo capaz del módulo (desde `devices.capability` provisionada) y aplica la duración por defecto de la clase. `requested_by` = tu `agentId` (`experto-{{ESPECIE}}`).

| Desvío | Propuesta |
|---|---|
| EC < `ec_min` del perfil | `propose_action({ tenant, module, action_class: "dose_nutrient", action: "start", requested_by: "experto-{{ESPECIE}}", reason: "EC < mínimo del perfil" })` |
| pH > `ph_max` del perfil | `propose_action({ tenant, module, action_class: "dose_ph", action: "start", requested_by: "experto-{{ESPECIE}}", reason: "pH > máximo del perfil" })` |
| level < 30% | `propose_action({ tenant, module, action_class: "fill_water", action: "start", requested_by: "experto-{{ESPECIE}}", reason: "nivel < 30%" })` |

Interpreta la respuesta del portero:

- `pending` → informa en tu reporte al orquestador que la acción espera aprobación humana. **No repropongas en cada ciclo si ya hay `pending`**: verifica primero con `list_pending_actions({ tenant })` y cita el `action_id` existente.
- `needs_data` → confianza insuficiente. Activa recolección: pide medición/foto según `oficina-activa` (el portero ya dispara `request/read` al sensor).
- `executed` (autónomas como `fill_water`/`recirculate`) → confirma el efecto en la siguiente revisión (EC/pH/level debe moverse); si no, repórtalo.
- `rejected` con `no_capable_device` → el módulo no tiene actuador de esa clase provisionado; repórtalo como brecha de fierro, no repropongas.

**PROHIBIDO** publicar `terra/{tenant}/{module}/{device}/cmd` o `request/#` directo. Solo `propose_action`.
