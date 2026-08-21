-- 008-tenant-admin.sql — gestión multi-finca desde PWA (ADR-0023, sin auth)
-- Aplica a volúmenes existentes: docker exec -i terra-timescale psql -U terra -d terra < infra/db/migrations/008-tenant-admin.sql

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'PEN',
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- La finca demo opera en soles
UPDATE tenants SET currency = 'PEN' WHERE id = 'demo' AND currency IS NULL;
