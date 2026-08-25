#!/usr/bin/env bash
# scripts/reset-data.sh — vuelve la DATA de negocio a cero (telemetría, lotes, ledger, fotos)
#
# Borra SOLO los volúmenes de datos: timescale_data (telemetría + dominio + ledger)
# y minio_data (fotos/evidencia). init.sql reconstruye el esquema al levantar.
#
# PRESERVA a propósito:
#   - openclaw_state  → pairing de canales, automations, memoria del agente
#   - ha_config       → onboarding e integración MQTT de Home Assistant
#   - grafana_data    → sesión admin y prefs
#
# Uso: ./scripts/reset-data.sh [--yes]
# Después del reset: crea tus fincas de nuevo (PWA /fincas o MCP terra-domain).
# Convención recomendada: una finca "dev" para experimentos y la finca real intocable
# (todo dato de negocio lleva tenant_id — ADR-0023), así el desarrollo no contamina.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --help|-h)
      echo "Uso: $0 [--yes]"
      echo "  Borra volúmenes timescale_data y minio_data (data de negocio a cero)."
      echo "  Preserva openclaw_state, ha_config y grafana_data."
      exit 0
      ;;
    *) echo "Flag desconocido: $1" >&2; exit 1 ;;
  esac
  shift
done

# Volúmenes por sufijo (tolera prefijo de proyecto distinto de terraos_)
mapfile -t VOLS < <(docker volume ls -q | grep -E '(^|_)(timescale_data|minio_data)$' || true)

if [[ ${#VOLS[@]} -eq 0 ]]; then
  echo "No hay volúmenes de datos que borrar (¿stack nunca levantado?)."
  exit 0
fi

echo "Se borrarán DEFINITIVAMENTE estos volúmenes:"
printf '  - %s\n' "${VOLS[@]}"
echo "Se preservan: openclaw_state (pairing), ha_config, grafana_data."

if [[ $YES -eq 0 ]]; then
  read -r -p "¿Continuar? [s/N] " resp
  [[ "$resp" =~ ^[sS]$ ]] || { echo "Abortado."; exit 1; }
fi

echo "==> Bajando stack"
docker compose down

echo "==> Borrando volúmenes de datos"
docker volume rm "${VOLS[@]}"

echo "==> Levantando base (init.sql reconstruye el esquema)"
docker compose up -d --wait

echo ""
echo "Data de negocio a cero. Próximos pasos:"
echo "  1. Levanta los profiles que uses:  docker compose --profile cerebro --profile ui up -d --wait"
echo "  2. Crea tus fincas (PWA /fincas o MCP create_tenant): una 'dev' para experimentos + la real."
echo "  3. Apunta el sim y los escenarios SOLO a módulos de la finca dev."
echo "  Tip: antes de una sesión de desarrollo riesgosa, ./scripts/backup.sh"
