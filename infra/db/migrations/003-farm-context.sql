-- 003-farm-context.sql — identidad de la finca en DB (cerebro agnóstico al lugar)
-- Aplica a volúmenes existentes (Fase 1): docker exec -i terra-timescale psql -U terra -d terra < infra/db/migrations/003-farm-context.sql

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS location_name TEXT,
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS tz TEXT;

-- Backfill demo (única finca conocida hoy). Otras fincas: las provisiona el sim/edge al boot.
UPDATE tenants SET location_name = 'Lambayeque, Perú', lat = -6.486, lon = -79.647, tz = 'America/Lima'
  WHERE id = 'demo' AND lat IS NULL;

-- Nota de cultivo genérica (el ciclo no depende del lugar)
UPDATE crop_profiles SET notes = REPLACE(notes, ' Lambayeque', '') WHERE name = 'lechuga';
