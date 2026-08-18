#!/usr/bin/env bash
# automations.sh — crea/actualiza las automations de los agentes (ADR-0019).
#
# Idempotente por nombre: si la job existe, no la toca (para cambiarla,
# bórrala con `openclaw cron rm <id>` y vuelve a correr este script).
#
# Uso:
#   brain/automations.sh [--channel <CANAL> --to <DESTINO>]
#
# Requiere: stack arriba (docker compose up -d), openclaw sano, .env en la raíz
# con OPENCLAW_HOOK_TOKEN. Con --channel/--to crea además el reporte diario
# (07:00) con entrega a tu canal (ej: --channel telegram --to 123456789).
# Canal agnóstico: vale cualquier canal soportado por OpenClaw.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
CHANNEL=""
DEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="${2:?}"; shift 2;;
    --to) DEST="${2:?}"; shift 2;;
    *) echo "Uso: $0 [--channel <CANAL> --to <DESTINO>]"; exit 1;;
  esac
done
if [ -n "$CHANNEL" ] && [ -z "$DEST" ] || [ -z "$CHANNEL" ] && [ -n "$DEST" ]; then
  echo "ERROR: --channel y --to van juntos"; exit 1
fi

OPENCLAW_HOOK_TOKEN="${OPENCLAW_HOOK_TOKEN:-$(grep -s '^OPENCLAW_HOOK_TOKEN=' "$ENV_FILE" | cut -d= -f2-)}"
if [ -z "${OPENCLAW_HOOK_TOKEN:-}" ]; then
  echo "ERROR: falta OPENCLAW_HOOK_TOKEN (.env o entorno)"; exit 1
fi

# CLI dentro del contenedor (imagen oficial: entrypoint tini, CLI = node openclaw.mjs)
OC="docker compose exec -T openclaw node openclaw.mjs"

# Timezone de la finca vía MCP (fuente de verdad). Fallback UTC con aviso.
FARM_TZ="$(
  curl -sf -X POST http://localhost:7760/mcp \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_farm_context","arguments":{}}}' 2>/dev/null \
  | grep -o '"tz"[^,}]*' | head -1 | cut -d'"' -f4 || true
)"
if [ -z "$FARM_TZ" ]; then
  FARM_TZ="UTC"
  echo "AVISO: no pude leer la timezone de la finca vía MCP — usando UTC"
fi
echo "Timezone de la finca: $FARM_TZ"

webhook_url() { echo "http://bridge:7765/expert-report?token=$OPENCLAW_HOOK_TOKEN"; }

job_exists() {
  local name="$1"
  $OC cron list --json 2>/dev/null | grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$name\"" \
    || $OC cron list 2>/dev/null | grep -q "$name"
}

create_job() {
  local name="$1" schedule="$2" agent="$3" prompt="$4"
  shift 4
  if job_exists "$name"; then
    echo "  = $name (ya existe)"
    return 0
  fi
  $OC cron add "$schedule" "$prompt" \
    --name "$name" --agent "$agent" --session isolated --tz "$FARM_TZ" "$@"
  echo "  + $name creada (agent=$agent, $schedule $FARM_TZ)"
}

echo "Creando automations (agente / ritmo):"

# --- Expertos (ADR-0019): ritmo propio, reportan al orquestador vía webhook ---
create_job "revision-lechuga" "7 */6 * * *" "experto-lechuga" \
  "Revisión programada de tus módulos. Lista los módulos con list_modules, quédate con los de crop 'lechuga' o variedades 'lechuga_*'. Para cada uno: latest_readings, module_confidence y recent_alerts (24 h), y compara contra los rangos de get_crop_profile del perfil exacto del módulo. Si todo está en rango y con confianza suficiente, responde exactamente NO_REPLY. Si hay anomalía, desvío sostenido, baja confianza o falta dato: redacta un reporte breve para el orquestador — módulo, variable, valor, rango del perfil, confianza y frescura del dato, acción sugerida. No actúas ni hablas con el humano." \
  --webhook "$(webhook_url)"

create_job "revision-tomate" "37 */6 * * *" "experto-tomate" \
  "Revisión programada de tus módulos. Lista los módulos con list_modules, quédate con los de crop 'tomate' o variedades 'tomate_*'. Para cada uno: latest_readings, module_confidence y recent_alerts (24 h), y compara contra los rangos de get_crop_profile del perfil exacto del módulo. Si todo está en rango y con confianza suficiente, responde exactamente NO_REPLY. Si hay anomalía, desvío sostenido, baja confianza o falta dato: redacta un reporte breve para el orquestador — módulo, variable, valor, rango del perfil, confianza y frescura del dato, acción sugerida. No actúas ni hablas con el humano." \
  --webhook "$(webhook_url)"

# --- Orquestador: reporte diario al humano (solo si hay canal destino) ---
if [ -n "$CHANNEL" ]; then
  create_job "reporte-diario" "0 7 * * *" "main" \
    "Genera el reporte diario siguiendo tu skill reporte-diario: estado por módulo, confianza por fuente, desvíos de rango con contexto, alertas del watchdog y faltantes declarados. Español, conciso, tablas." \
    --announce --channel "$CHANNEL" --to "$DEST"
else
  echo "  - reporte-diario omitido (pasa --channel <CANAL> --to <DESTINO> para crearlo)"
fi

echo "Listo. Verifica con: $OC cron list"
