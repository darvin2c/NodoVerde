#!/usr/bin/env bash
# scripts/backup.sh — snapshot de la DB de dominio (telemetría + lotes + ledger + tenants)
#
# pg_dump -Fc dentro del contenedor terra-timescale → ./backups/terra-<timestamp>.dump
# Usar ANTES de una sesión de desarrollo riesgosa; restaurar con scripts/restore.sh.
#
# Uso: ./scripts/backup.sh [nombre-salida.dump]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/backups"
CONTAINER="terra-timescale"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="${1:-$OUT_DIR/terra-$TS.dump}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "El contenedor $CONTAINER no existe. ¿Levantaste la base? (docker compose up -d --wait)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
TMP="/tmp/terra-backup-$$.dump"

echo "==> pg_dump -Fc de terra@$CONTAINER"
docker exec "$CONTAINER" pg_dump -U terra -d terra -Fc -f "$TMP"
docker cp "$CONTAINER:$TMP" "$OUT"
docker exec "$CONTAINER" rm -f "$TMP"

SIZE="$(stat -c %s "$OUT")"
echo "Backup listo: $OUT ($SIZE bytes)"
echo "Restaurar con: ./scripts/restore.sh $OUT"
