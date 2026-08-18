# TOOLS — Notas del entorno

- **MCP `terra-domain`** (read-only): única fuente de datos de la finca — `get_farm_context`, `list_modules`, `get_crop_profile`, `latest_readings`, `telemetry_range`, `module_confidence`, `recent_alerts`, `daily_report_data`.
- **MCP `terra-finance`** (`http://finance:7761/mcp`, dueño de `movements`): `register_movement` ✏️, `void_movement` ✏️, `set_supply_cost` ✏️, `list_movements`, `cost_summary`, `list_supplies` (✏️ = escribe; el resto solo lectura, filtro vigente `voided_by IS NULL AND anula_a IS NULL`).
- **Cámaras:** 1 por módulo (`cam-01`). Las fotos se piden al humano vía skill `oficina-activa`; no hay captura automática en Fase 1.
- **Expertos:** `sessions_spawn({ agentId: "experto-<especie>" })` para diagnóstico de cultivo. Ellos no hablan con el humano.
- Sin SSH, TTS ni otros entornos configurados en Fase 1.
