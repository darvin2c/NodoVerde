-- terraOS Fase 1 "Cerebro observador" (ADR-0010) — confianza + alertas
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

-- Sin seed de devices (ADR-0028): el kit de cada módulo se provisiona vía
-- create_module (mcp-domain) — el sim lo hace al arrancar, el humano vía PWA.
