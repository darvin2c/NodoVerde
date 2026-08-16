-- terraOS Fase 0 — TimescaleDB init

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Modules (parcela / módulo)
CREATE TABLE IF NOT EXISTS modules (
  tenant TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  crop TEXT NOT NULL,
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

INSERT INTO modules (tenant, id, crop) VALUES
  ('demo', 'mod-1', 'lechuga'),
  ('demo', 'mod-2', 'lechuga'),
  ('demo', 'mod-3', 'tomate'),
  ('demo', 'mod-4', 'lechuga')
ON CONFLICT (tenant, id) DO NOTHING;
