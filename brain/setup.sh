#!/usr/bin/env bash
# brain/setup.sh — genera openclaw.json (agnóstico: sin LLM ni canal) y guía el primer arranque
# Uso: ./brain/setup.sh
# Requiere: .env en la raíz (genera OPENCLAW_HOOK_TOKEN y OPENCLAW_GATEWAY_TOKEN si faltan).
# El LLM y el canal de chat los eliges DESPUÉS del boot (ADR-0001): ver pasos 3-4 que imprime.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CEREBRO="$ROOT/brain"
TEMPLATE="$CEREBRO/openclaw.json.template"
TARGET="$CEREBRO/openclaw.json"
ENV_FILE="$ROOT/.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "Uso: $0"
      echo "  Genera brain/openclaw.json (agnóstico) y muestra los pasos de arranque."
      exit 0
      ;;
    *) echo "Flag desconocido: $1" >&2; exit 1 ;;
  esac
done

# 1) Asegurar OPENCLAW_HOOK_TOKEN
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

TOKEN="${OPENCLAW_HOOK_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 32)"
  else
    TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  echo "→ OPENCLAW_HOOK_TOKEN no estaba en .env — generado uno nuevo."
  echo "  Añadiendo a $ENV_FILE ..."
  {
    echo ""
    echo "# OpenClaw — token para hooks (no compartir con gateway auth)"
    echo "OPENCLAW_HOOK_TOKEN=$TOKEN"
  } >> "$ENV_FILE"
  export OPENCLAW_HOOK_TOKEN="$TOKEN"
  echo "  Token: $TOKEN"
  echo "  ⚠️  No reutilices este token como gateway.auth.token — audit lo flaggea como crítico."
else
  echo "→ OPENCLAW_HOOK_TOKEN ya existe en .env (no se regenera)."
fi

# 1b) Asegurar OPENCLAW_GATEWAY_TOKEN (auth del gateway; DISTINTO del hook token — audit lo exige)
GW_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
if [[ -z "$GW_TOKEN" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    GW_TOKEN="$(openssl rand -hex 32)"
  else
    GW_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  echo "→ OPENCLAW_GATEWAY_TOKEN no estaba en .env — generado uno nuevo."
  {
    echo "# OpenClaw — token de auth del gateway (distinto del hook token)"
    echo "OPENCLAW_GATEWAY_TOKEN=$GW_TOKEN"
  } >> "$ENV_FILE"
  export OPENCLAW_GATEWAY_TOKEN="$GW_TOKEN"
else
  echo "→ OPENCLAW_GATEWAY_TOKEN ya existe en .env (no se regenera)."
fi

# 1c) Asegurar POLICY_ADMIN_TOKEN (portero Fase 3 — auth PWA→policy)
POLICY_TOKEN="${POLICY_ADMIN_TOKEN:-}"
if [[ -z "$POLICY_TOKEN" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    POLICY_TOKEN="$(openssl rand -hex 32)"
  else
    POLICY_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  echo "→ POLICY_ADMIN_TOKEN no estaba en .env — generado uno nuevo."
  {
    echo "# Portero — token admin PWA→policy (Fase 3)"
    echo "POLICY_ADMIN_TOKEN=$POLICY_TOKEN"
  } >> "$ENV_FILE"
  export POLICY_ADMIN_TOKEN="$POLICY_TOKEN"
else
  echo "→ POLICY_ADMIN_TOKEN ya existe en .env (no se regenera)."
fi

# 2) Generar openclaw.json desde template
if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: no existe $TEMPLATE" >&2; exit 1
fi

# openclaw.json es JSON plano — no expande env en runtime.
# Solo sustituimos ${OPENCLAW_HOOK_TOKEN}. La config es deliberadamente AGNÓSTICA:
# ni modelo LLM ni canal de chat vienen preconfigurados (ADR-0001: son decisión
# del deployer). Se configuran post-boot con `openclaw config set` / `channels login`.
if command -v envsubst >/dev/null 2>&1; then
  # envsubst solo la variable que nos interesa, para no tocar otras
  OPENCLAW_HOOK_TOKEN="$TOKEN" envsubst '${OPENCLAW_HOOK_TOKEN}' < "$TEMPLATE" > "$TARGET"
else
  # fallback sed — escapa / y & del token
  ESCAPED_TOKEN=$(printf '%s' "$TOKEN" | sed 's/[\/&]/\\&/g')
  sed "s/\${OPENCLAW_HOOK_TOKEN}/$ESCAPED_TOKEN/g" "$TEMPLATE" > "$TARGET"
fi

echo "→ Generado $TARGET desde $TEMPLATE"

# Validar JSON
if command -v python3 >/dev/null 2>&1; then
  python3 -c "import json,sys; json.load(open('$TARGET')); print('  ✓ JSON válido')"
elif command -v node >/dev/null 2>&1; then
  node -e "JSON.parse(require('fs').readFileSync('$TARGET','utf8')); console.log('  ✓ JSON válido')"
fi

# Avisos agnósticos: sin LLM ni canal preconfigurados, los agentes arrancan
# pero no "piensan" ni hablan hasta que el deployer elija ambos.
echo "  ℹ️  Sin LLM configurado (agnóstico por diseño, ADR-0001) — elige proveedor en el paso 3 de abajo."
echo "  ℹ️  Sin canal de chat configurado — elige el tuyo en el paso 4 (Telegram, WhatsApp, WebChat…)."

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Siguientes pasos — primer arranque (ejecuta en orden):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1) Levantar el cerebro (imagen oficial pineada ghcr.io/openclaw/openclaw:2026.7.1-2 — sin build):"
echo "     docker compose --profile cerebro up -d"
echo ""
echo "  2) Verificar health y agentes:"
echo "     curl -sf http://localhost:18789/healthz | jq ."
echo "     docker compose exec openclaw node openclaw.mjs config validate"
echo "     docker compose exec openclaw node openclaw.mjs agents list --bindings   # main + expertos"
echo ""
echo "  3) Elegir el LLM (agnóstico, ADR-0001 — el gateway arranca sin modelo; los turnos lo necesitan):"
echo "     export OPENAI_API_KEY=...        # o ANTHROPIC_API_KEY / GEMINI_API_KEY / etc. en .env"
echo "     docker compose up -d openclaw    # recarga env"
echo "     docker compose exec openclaw node openclaw.mjs config set agents.defaults.model.primary <proveedor/modelo>"
echo "     # ejemplos: openai/gpt-4o · anthropic/claude-sonnet-4-6 · ollama/llama3.1 (local)"
echo ""
echo "  4) Elegir el canal de chat (agnóstico):"
echo "     Telegram:  TELEGRAM_BOT_TOKEN en .env + config set channels.telegram.botToken --ref-id TELEGRAM_BOT_TOKEN"
echo "                luego /start a tu bot y aprueba el pairing en http://localhost:18789"
echo "     WhatsApp:  docker compose exec -it openclaw node openclaw.mjs channels login --channel whatsapp  (QR)"
echo "     WebChat:   Control UI http://localhost:18789 — funciona sin configurar nada"
echo ""
echo "  5) Automations de los agentes (idempotente; ADR-0019):"
echo "     ./brain/automations.sh                                    # revisiones de expertos cada 6 h"
echo "     ./brain/automations.sh --channel telegram --to <CHAT_ID>  # + reporte diario 07:00 a tu canal"
echo ""
echo "  Notas:"
echo "  - OPENCLAW_STATE_DIR=/home/node/.openclaw (volumen openclaw_state)"
echo "  - openclaw.json: generado aquí, MUTABLE en runtime (config set persiste en él; bind rw sobre el volumen — docker permite mounts anidados)"
echo "  - Workspaces versionados: ./brain/workspaces/main → orquestador; ./brain/workspaces/experto-* → expertos (ADR-0019). Un solo bind: nueva especie no toca compose."
echo "  - Tag verificado: ghcr.io/openclaw/openclaw:2026.7.1-2 (ADR-0018). Otros tags: docker manifest inspect ghcr.io/openclaw/openclaw:latest"
echo "  - POLICY_ADMIN_TOKEN: generado en .env si faltaba (auth PWA→portero :7762); usado por compose como \${POLICY_ADMIN_TOKEN:-dev-admin-token}"
echo ""
