-- terraOS Fase 1 "Cerebro observador" (ADR-0010) — confianza + alertas + kit de dispositivos
-- Idempotente: IF NOT EXISTS / ON CONFLICT. Para volúmenes existentes (docker-entrypoint 02-fase1.sql).
-- También replicado en init.sql para volúmenes nuevos.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- confidence_history: termómetro global por módulo (plano plataforma 4-seg terra/{tenant}/{module}/confidence)
-- v -> value 0-100, sources jsonb con desglose por variable (ec, ph, temp, level, flow, air_temp, humidity, photo)
CREATE TABLE IF NOT EXISTS confidence_history (
  time TIMESTAMPTZ NOT NULL,
  tenant TEXT NOT NULL,
  module TEXT NOT NULL,
  value DOUBLE PRECISION,
  sources TEXT, -- JSON serializado (telegraf CopyFrom no puede escribir jsonb; se parsea al leer)
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);

SELECT create_hypertable('confidence_history', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_confidence_history_lookup ON confidence_history (tenant, module, time DESC);

-- alerts: transiciones de salud por módulo (plano plataforma 4-seg terra/{tenant}/{module}/alert)
-- NO retained; historificada para auditoría y Grafana. Health (4-seg retained) NO se ingesta.
CREATE TABLE IF NOT EXISTS alerts (
  time TIMESTAMPTZ NOT NULL,
  tenant TEXT NOT NULL,
  module TEXT NOT NULL,
  name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
  device TEXT,
  detail TEXT, -- JSON serializado (telegraf CopyFrom no escribe jsonb; se parsea al leer)
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);

SELECT create_hypertable('alerts', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_alerts_lookup ON alerts (tenant, module, time DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts (severity, time DESC);

-- Seed kit estándar por módulo demo (12 dispositivos por módulo)
-- idempotente: PK (tenant, module, id) con ON CONFLICT DO NOTHING
INSERT INTO devices (tenant, module, id, kind) VALUES
  ('demo', 'mod-1', 'ec-01', 'sensor'),
  ('demo', 'mod-1', 'ph-01', 'sensor'),
  ('demo', 'mod-1', 'temp-01', 'sensor'),
  ('demo', 'mod-1', 'level-01', 'sensor'),
  ('demo', 'mod-1', 'flow-01', 'sensor'),
  ('demo', 'mod-1', 'climate-01', 'sensor'),
  ('demo', 'mod-1', 'pump-recirc-01', 'switch'),
  ('demo', 'mod-1', 'valve-fill-01', 'switch'),
  ('demo', 'mod-1', 'doser-a-01', 'switch'),
  ('demo', 'mod-1', 'doser-b-01', 'switch'),
  ('demo', 'mod-1', 'doser-ph-01', 'switch'),
  ('demo', 'mod-1', 'cam-01', 'camera'),
  ('demo', 'mod-2', 'ec-01', 'sensor'),
  ('demo', 'mod-2', 'ph-01', 'sensor'),
  ('demo', 'mod-2', 'temp-01', 'sensor'),
  ('demo', 'mod-2', 'level-01', 'sensor'),
  ('demo', 'mod-2', 'flow-01', 'sensor'),
  ('demo', 'mod-2', 'climate-01', 'sensor'),
  ('demo', 'mod-2', 'pump-recirc-01', 'switch'),
  ('demo', 'mod-2', 'valve-fill-01', 'switch'),
  ('demo', 'mod-2', 'doser-a-01', 'switch'),
  ('demo', 'mod-2', 'doser-b-01', 'switch'),
  ('demo', 'mod-2', 'doser-ph-01', 'switch'),
  ('demo', 'mod-2', 'cam-01', 'camera'),
  ('demo', 'mod-3', 'ec-01', 'sensor'),
  ('demo', 'mod-3', 'ph-01', 'sensor'),
  ('demo', 'mod-3', 'temp-01', 'sensor'),
  ('demo', 'mod-3', 'level-01', 'sensor'),
  ('demo', 'mod-3', 'flow-01', 'sensor'),
  ('demo', 'mod-3', 'climate-01', 'sensor'),
  ('demo', 'mod-3', 'pump-recirc-01', 'switch'),
  ('demo', 'mod-3', 'valve-fill-01', 'switch'),
  ('demo', 'mod-3', 'doser-a-01', 'switch'),
  ('demo', 'mod-3', 'doser-b-01', 'switch'),
  ('demo', 'mod-3', 'doser-ph-01', 'switch'),
  ('demo', 'mod-3', 'cam-01', 'camera'),
  ('demo', 'mod-4', 'ec-01', 'sensor'),
  ('demo', 'mod-4', 'ph-01', 'sensor'),
  ('demo', 'mod-4', 'temp-01', 'sensor'),
  ('demo', 'mod-4', 'level-01', 'sensor'),
  ('demo', 'mod-4', 'flow-01', 'sensor'),
  ('demo', 'mod-4', 'climate-01', 'sensor'),
  ('demo', 'mod-4', 'pump-recirc-01', 'switch'),
  ('demo', 'mod-4', 'valve-fill-01', 'switch'),
  ('demo', 'mod-4', 'doser-a-01', 'switch'),
  ('demo', 'mod-4', 'doser-b-01', 'switch'),
  ('demo', 'mod-4', 'doser-ph-01', 'switch'),
  ('demo', 'mod-4', 'cam-01', 'camera')
ON CONFLICT (tenant, module, id) DO NOTHING;
