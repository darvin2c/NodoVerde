-- terraOS Fase 0 — TimescaleDB init

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Crop profiles (ADR-0016 — referencia agronómica aprovisionada en DB; cerebro/portero/expertos
-- leen de aquí en runtime, nunca de YAML. Seed equivalente a sim/config/crops/*.yaml)
CREATE TABLE IF NOT EXISTS crop_profiles (
  name TEXT PRIMARY KEY,
  ec_min DOUBLE PRECISION NOT NULL,
  ec_max DOUBLE PRECISION NOT NULL,
  ph_min DOUBLE PRECISION NOT NULL,
  ph_max DOUBLE PRECISION NOT NULL,
  water_temp_min DOUBLE PRECISION NOT NULL,
  water_temp_max DOUBLE PRECISION NOT NULL,
  notes TEXT
);

-- Modules (parcela / módulo)
CREATE TABLE IF NOT EXISTS modules (
  tenant TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  crop TEXT NOT NULL REFERENCES crop_profiles(name),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id)
);

-- Devices
CREATE TABLE IF NOT EXISTS devices (
  tenant TEXT NOT NULL,
  module TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, module, id),
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);

-- Device identities — dispositivo tonto (ADR-0015): el hardware publica solo por hw_id,
-- la identidad (tenant/módulo) se asigna dinámicamente por claiming en esta tabla.
-- El router traduce plano dispositivo (terra/{hw_id}/...) ↔ plano interno (terra/{tenant}/{module}/...).
CREATE TABLE IF NOT EXISTS device_identities (
  hw_id TEXT PRIMARY KEY,               -- id de fábrica (MAC sin dos puntos, 12 hex min)
  tenant TEXT NOT NULL,
  module TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);

-- un módulo solo puede tener UN hardware activo: cierra la race de dos claims
-- concurrentes que lean el mismo módulo libre (el segundo falla en vez de duplicar)
CREATE UNIQUE INDEX IF NOT EXISTS device_identities_one_hardware_per_module
  ON device_identities (tenant, module);

-- Telemetry (hypertable — ingested by Telegraf from terra/+/+/+/+/reading)
CREATE TABLE IF NOT EXISTS telemetry (
  time TIMESTAMPTZ NOT NULL,
  tenant TEXT NOT NULL,
  module TEXT NOT NULL,
  device TEXT NOT NULL,
  metric TEXT NOT NULL,
  value DOUBLE PRECISION,
  raw JSONB
);

SELECT create_hypertable('telemetry', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_telemetry_lookup ON telemetry (tenant, module, device, metric, time DESC);

-- Movements (ADR-0011 — append-only ledger)
CREATE TABLE IF NOT EXISTS movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PEN',
  category TEXT,
  attribution JSONB,
  evidence_url TEXT,
  voided_by UUID REFERENCES movements(id),
  source TEXT,
  created_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed: tenant demo
INSERT INTO tenants (id, name) VALUES ('demo', 'Finca Demo - Lambayeque') ON CONFLICT (id) DO NOTHING;

-- Seed: perfiles de cultivo (fuente de verdad en runtime para cerebro/portero; ADR-0016)
INSERT INTO crop_profiles (name, ec_min, ec_max, ph_min, ph_max, water_temp_min, water_temp_max, notes) VALUES
  ('lechuga', 1.2, 1.8, 5.8, 6.3, 18, 24, 'Lechuga hidropónica de hoja suelta; ciclo ~45 días Lambayeque. EC baja al inicio, subir a 1.6 en engorde. Renovar solución si EC deriva.'),
  ('tomate', 2.0, 3.5, 5.5, 6.5, 18, 26, 'Tomate indeterminado hidropónico; EC se eleva progresivamente con carga de frutos. Vigilar blossom-end rot si EC/pH fuera de rango.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO modules (tenant, id, crop) VALUES
  ('demo', 'mod-1', 'lechuga'),
  ('demo', 'mod-2', 'lechuga'),
  ('demo', 'mod-3', 'tomate'),
  ('demo', 'mod-4', 'lechuga')
ON CONFLICT (tenant, id) DO NOTHING;

INSERT INTO device_identities (hw_id, tenant, module, claimed_by) VALUES
  ('020000000001', 'demo', 'mod-1', 'seed'),
  ('020000000002', 'demo', 'mod-2', 'seed'),
  ('020000000003', 'demo', 'mod-3', 'seed'),
  ('020000000004', 'demo', 'mod-4', 'seed')
ON CONFLICT DO NOTHING;
