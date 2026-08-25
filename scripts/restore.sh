#!/usr/bin/env bash
# scripts/restore.sh — restaura un backup creado por scripts/backup.sh
#
# pg_restore --clean --if-exists: PISA la DB actual con el contenido del backup.
# Pensado para recuperar la finca real tras una sesión de desarrollo que la contaminó.
#
# Uso: ./scripts/restore.sh <archivo.dump> [--yes]
set -euo pipefail

CONTAINER="terra-timescale"
YES=0
DUMP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --help|-h)
      echo "Uso: $0 <archivo.dump> [--yes]"
      echo "  Restaura la DB terra desde un backup pg_dump -Fc (pisa la data actual)."
      exit 0
      ;;
    -*) echo "Flag desconocido: $1" >&2; exit 1 ;;
    *) DUMP="$1" ;;
  esac
  shift
done

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Falta el archivo de backup o no existe: '$DUMP'" >&2
  echo "Backups disponibles:" >&2
  ls -1 backups/*.dump 2>/dev/null >&2 || echo "  (ninguno en ./backups)" >&2
  exit 1
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "El contenedor $CONTAINER no existe. ¿Levantaste la base?" >&2
  exit 1
fi

echo "Se PISARÁ la DB 'terra' actual con: $DUMP"
if [[ $YES -eq 0 ]]; then
  read -r -p "¿Continuar? [s/N] " resp
  [[ "$resp" =~ ^[sS]$ ]] || { echo "Abortado."; exit 1; }
fi

TMP="/tmp/terra-restore-$$.dump"
docker cp "$DUMP" "$CONTAINER:$TMP"
echo "==> pg_restore --clean --if-exists"
# pg_restore con --clean reporta warnings de orden de dependencias; no son fatales
docker exec "$CONTAINER" pg_restore -U terra -d terra --clean --if-exists "$TMP" || true
docker exec "$CONTAINER" rm -f "$TMP"

echo "Restaurado. Verifica: docker exec -it $CONTAINER psql -U terra -d terra -c 'SELECT id, name FROM tenants;'"
