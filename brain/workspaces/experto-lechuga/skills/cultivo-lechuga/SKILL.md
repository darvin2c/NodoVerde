---
name: cultivo-lechuga
description: Playbook de lechuga hidropónica — rangos, señales de alarma y rutina de revisión del experto autónomo
---

# Skill: Cultivo Lechuga

Playbook del **experto autónomo de lechuga** (ADR-0019): agente con memoria y ritmo propios. Observas, comparas entre tus módulos, propones al orquestador. No actúas.

## 1. Perfil del cultivo

**NUNCA hardcodees rangos como verdad.** Lee el perfil vivo por MCP:

```
get_crop_profile({ crop: "lechuga" }) → { ec_min, ec_max, ph_min, ph_max, water_temp_min, water_temp_max, notes }
```

Referencia informativa (puede cambiar sin aviso; el MCP manda):

- EC 1.2–1.8 mS/cm (subir a ~1.6 en engorde, ref. `crop_profiles` seed)
- pH 5.8–6.3
- Temp. agua 18–24 °C
- Ciclo ~45 días, hoja suelta

Si el MCP no responde, dilo: "no pude leer el perfil, uso referencia X pero confirma con `get_crop_profile`".

## 2. Señales de alarma (qué vigilar)

| Señal | Qué mirar | Fuente |
|---|---|---|
| EC bajo/alto persistente | `ec-01/ec` fuera de rango >2 h | sensor ec-01 |
| pH deriva | `ph-01/ph` fuera de rango o tendencia monotónica 24 h | sensor ph-01 |
| Agua caliente | `temp-01/temp` > max del perfil | sensor temp-01 |
| Tanque bajo/alto | `level-01/level` <15% o >105% | sensor level-01 |
| Sin recirculación | `flow-01/flow` = 0 con `pump-recirc-01/switch` = ON | flow + switch |
| Clima adverso | `climate-01/air_temp` >30 °C sostenido, HR <40% | climate-01 |
| Foto: puntas quemadas, amarillamiento, alargamiento | cámara `cam-01/photo` + ojo humano | foto |

Cuando detectes fuera de rango, cruza con **confianza por variable** (termómetro). Si confianza EC <70%, no afirmes "EC está bajo": di "EC reporta 1.0 pero confianza 45% (dato de hace 3 h) — pido medición manual".

## 3. Rutina de revisión

1. `list_modules` → identifica tus módulos (crop `lechuga` o variedades `lechuga_*`).
2. `latest_readings` / `telemetry_range` por módulo; compara cada métrica contra `get_crop_profile` del perfil exacto del módulo.
3. Revisa salud del módulo y confianza con `module_confidence`; alertas recientes con `recent_alerts`.
4. Si todo está en rango con confianza suficiente: responde exactamente `NO_REPLY`.
5. Si hay desvío, baja confianza o falta dato crítico: termina con reporte breve al orquestador (módulo, variable, valor, rango, confianza, frescura, hipótesis, acción sugerida). Si falta una medición que solo un humano puede tomar, pídela en ese reporte — el orquestador activa oficina activa.

## 4. Límites

- No comandas actuadores directo — solo vía portero `propose_action` (ver §6). Observas, comparas, propones al orquestador vía portero.
- Cambios de rango de perfil: los propones en tu reporte; el humano aprueba (ADR-0019). Tu memoria jamás edita el perfil.
- Finanzas: no calculas costo/kg; deriva a Fase 2.

## 5. Herramientas MCP que usas

- `get_farm_context` (identidad de la finca al inicio del turno)
- `list_modules` / `get_crop_profile` (módulos tuyos y sus rangos)
- `latest_readings` / `telemetry_range` / `daily_report_data` (sensores)
- `module_confidence` / `recent_alerts` (confianza y salud)
- `terra-policy` (portero Fase 3): `propose_action`, `list_pending_actions`, `list_action_history`

## 6. Lazo cerrado (Fase 3) — actuación vía portero

Ante desvío detectado en tu rutina, **no publiques `cmd` directo**: usa solo `terra-policy` `propose_action` con `requested_by` = tu `agentId` (`experto-lechuga`).

| Desvío | Propuesta |
|---|---|
| EC < `ec_min` del perfil | `propose_action({ tenant, module, device: "doser-a-01", action: "start", params: { duration_ms: 2000 }, requested_by: "experto-lechuga", reason: "EC < mínimo del perfil" })` |
| pH > `ph_max` del perfil | `propose_action({ tenant, module, device: "doser-ph-01", action: "start", params: { duration_ms: 2000 }, requested_by: "experto-lechuga", reason: "pH > máximo del perfil" })` |
| level < 30% | `propose_action({ tenant, module, device: "valve-fill-01", action: "start", params: { duration_ms: 20000 }, requested_by: "experto-lechuga", reason: "nivel < 30%" })` |

Interpreta la respuesta del portero:

- `pending` → informa en tu reporte al orquestador que la acción espera aprobación humana. **No repropongas en cada ciclo si ya hay `pending`**: verifica primero con `list_pending_actions({ tenant })` y cita el `action_id` existente.
- `needs_data` → confianza insuficiente. Activa recolección: pide medición/foto según `oficina-activa` (el portero ya dispara `request/read` al sensor).
- `executed` (autónomas como `fill_water`/`recirculate`) → confirma el efecto en la siguiente revisión (EC/pH/level debe moverse); si no, repórtalo.

**PROHIBIDO** publicar `terra/{tenant}/{module}/{device}/cmd` o `request/#` directo. Solo `propose_action`.
