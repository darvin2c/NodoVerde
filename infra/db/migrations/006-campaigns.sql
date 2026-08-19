-- terraOS Fase 4 "Campaña con pausas honestas" (ADR-0021) — campañas + alert_resolutions + alerts sin FK
-- Idempotente: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / IF NOT EXISTS index.

-- alerts: las alertas de plataforma usan module='platform' (no es un módulo real)
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_tenant_module_fkey;

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant TEXT NOT NULL,
  crop TEXT NOT NULL REFERENCES crop_profiles(name),
  modules JSONB NOT NULL,
  profile_hash TEXT NOT NULL,
  memory_hash TEXT,
  memory_hash_close TEXT,
  note TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_one_open_per_tenant ON campaigns (tenant) WHERE state = 'open';

CREATE TABLE IF NOT EXISTS alert_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant TEXT NOT NULL,
  alert_name TEXT NOT NULL,
  module TEXT,
  fingerprint TEXT,
  note TEXT,
  resolved_by TEXT NOT NULL DEFAULT 'human',
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
