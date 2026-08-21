-- terraOS Fase 0 — TimescaleDB init

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenants — la identidad de la finca vive AQUÍ (única fuente de verdad).
-- El cerebro es agnóstico al lugar: consulta location_name/lat/lon/tz vía MCP
-- (get_farm_context). Jamás se hardcodea en prompts ni skills.
-- Quien la escribe: aprovisionamiento (sim supervisor en sim; edge en Fase 5).
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,             -- slug elegido por el usuario (^[a-z0-9][a-z0-9-]*$), inmutable
  name TEXT NOT NULL,              -- nombre display de la finca (mutable)
  location_name TEXT,              -- zona humana (ej: "Lambayeque, Perú")
  lat DOUBLE PRECISION,            -- coordenadas para clima/ET0 (obligatorias vía create_tenant)
  lon DOUBLE PRECISION,
  tz TEXT,                         -- IANA derivada de lat/lon (tz-lookup) — reportes en hora local
  currency TEXT NOT NULL DEFAULT 'PEN', -- ISO 4217 — los resúmenes financieros nunca mezclan monedas
  archived_at TIMESTAMPTZ,         -- finca archivada: sale del selector, historia conservada (nada se borra)
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
  cycle_days INT,                 -- duración del ciclo (trasplante/siembra → cosecha); null = sin estimación
  notes TEXT
);

-- Modules (parcela / módulo) — unidad lógica de asignación, infraestructura
-- fungible (ADR-0022/0025): name = identificación humana libre; retired_at =
-- retiro gobernado (nada se borra). crop = CACHÉ nullable del lote activo:
-- solo open/close_batch lo escriben; NULL = mesa libre, sin cultivo.
CREATE TABLE IF NOT EXISTS modules (
  tenant TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  name TEXT,
  crop TEXT REFERENCES crop_profiles(name),
  retired_at TIMESTAMPTZ,
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

-- Fase 1 "Cerebro observador" (ADR-0010) — confidence_history + alerts

-- confidence_history: termómetro global por módulo (plano plataforma 4-seg terra/{tenant}/{module}/confidence)
-- v -> value 0-100, sources (TEXT con JSON serializado) con desglose por variable (ec, ph, temp, level, flow, air_temp, humidity, photo)
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
  detail TEXT -- JSON serializado (telegraf CopyFrom no escribe jsonb; se parsea al leer)
);

SELECT create_hypertable('alerts', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_alerts_lookup ON alerts (tenant, module, time DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts (severity, time DESC);

-- Movements (ADR-0011 — append-only ledger; Fase 2: imputación + inmutabilidad + dedup)
CREATE TABLE IF NOT EXISTS movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CONSTRAINT movements_kind_check CHECK (kind IN ('gasto','ingreso')),
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PEN',
  category TEXT NOT NULL CONSTRAINT movements_category_check CHECK (category IN ('nutrientes','energia','agua','plantulas','mano_obra','empaque','transporte','venta_cosecha','software','otro')),
  attribution JSONB,
  evidence_url TEXT,
  voided_by UUID REFERENCES movements(id),
  anula_a UUID REFERENCES movements(id),
  source_event TEXT,
  source TEXT,
  created_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_source_event_unique
  ON movements (tenant, source_event) WHERE source_event IS NOT NULL;

-- supply_costs (ADR-0011 — costo unitario por insumo para valorización de dosis)
CREATE TABLE IF NOT EXISTS supply_costs (
  supply TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  cost_per_unit NUMERIC NOT NULL CHECK (cost_per_unit > 0),
  currency TEXT NOT NULL DEFAULT 'PEN',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO supply_costs (supply, unit, cost_per_unit, currency) VALUES
  ('nutriente_a', 'ml', 0.08, 'PEN'),
  ('nutriente_b', 'ml', 0.08, 'PEN'),
  ('ph_down',     'ml', 0.12, 'PEN')
ON CONFLICT (supply) DO NOTHING;
-- Precios placeholder: el agricultor los actualiza vía set_supply_cost (terra-finance).

-- ── trigger: validación de imputación (ADR-0011) ───────────────────────────
CREATE OR REPLACE FUNCTION validate_movement_attribution() RETURNS trigger AS $$
DECLARE
  _elem JSONB;
  _pct NUMERIC;
  _sum NUMERIC := 0;
  _mod TEXT;
  _cnt INT;
BEGIN
  IF NEW.category IS NULL THEN
    RAISE EXCEPTION 'categoría obligatoria: todo movimiento debe tener categoría';
  END IF;
  IF NEW.attribution IS NULL THEN
    RAISE EXCEPTION 'atribución obligatoria: debe ser un array no vacío de {module, pct}';
  END IF;
  IF jsonb_typeof(NEW.attribution) <> 'array' THEN
    RAISE EXCEPTION 'atribución inválida: debe ser un array JSONB no vacío de {module, pct}';
  END IF;
  _cnt := jsonb_array_length(NEW.attribution);
  IF _cnt IS NULL OR _cnt = 0 THEN
    RAISE EXCEPTION 'atribución inválida: array vacío, debe tener al menos un elemento {module, pct}';
  END IF;
  FOR _elem IN SELECT * FROM jsonb_array_elements(NEW.attribution)
  LOOP
    _mod := _elem ->> 'module';
    IF _mod IS NULL OR btrim(_mod) = '' THEN
      RAISE EXCEPTION 'atribución inválida: cada elemento debe tener module (texto no vacío)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM modules WHERE tenant = NEW.tenant AND id = _mod) THEN
      RAISE EXCEPTION 'atribución inválida: módulo "%" no existe para tenant "%"', _mod, NEW.tenant;
    END IF;
    BEGIN
      _pct := (_elem ->> 'pct')::NUMERIC;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'atribución inválida: pct debe ser número > 0 (módulo %)', _mod;
    END;
    IF _pct IS NULL OR _pct <= 0 THEN
      RAISE EXCEPTION 'atribución inválida: pct debe ser > 0 (módulo %)', _mod;
    END IF;
    _sum := _sum + _pct;
  END LOOP;
  IF abs(_sum - 100) > 0.001 THEN
    RAISE EXCEPTION 'atribución inválida: la suma de pct debe ser 100 (actual %)', _sum;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movements_validate_attribution ON movements;
CREATE TRIGGER trg_movements_validate_attribution
  BEFORE INSERT ON movements
  FOR EACH ROW EXECUTE FUNCTION validate_movement_attribution();

-- ── inmutabilidad (ADR-0011): historia financiera inmutable ─────────────────
CREATE OR REPLACE FUNCTION prevent_movement_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'movimientos inmutables: no se permite borrar movimientos (use anulación)';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movements_no_delete ON movements;
CREATE TRIGGER trg_movements_no_delete
  BEFORE DELETE ON movements
  FOR EACH ROW EXECUTE FUNCTION prevent_movement_delete();

CREATE OR REPLACE FUNCTION enforce_movement_immutable_update() RETURNS trigger AS $$
BEGIN
  IF OLD.voided_by IS NULL AND NEW.voided_by IS NOT NULL
     AND OLD.id IS NOT DISTINCT FROM NEW.id
     AND OLD.tenant IS NOT DISTINCT FROM NEW.tenant
     AND OLD.ts IS NOT DISTINCT FROM NEW.ts
     AND OLD.kind IS NOT DISTINCT FROM NEW.kind
     AND OLD.amount IS NOT DISTINCT FROM NEW.amount
     AND OLD.currency IS NOT DISTINCT FROM NEW.currency
     AND OLD.category IS NOT DISTINCT FROM NEW.category
     AND OLD.attribution IS NOT DISTINCT FROM NEW.attribution
     AND OLD.evidence_url IS NOT DISTINCT FROM NEW.evidence_url
     AND OLD.anula_a IS NOT DISTINCT FROM NEW.anula_a
     AND OLD.source_event IS NOT DISTINCT FROM NEW.source_event
     AND OLD.source IS NOT DISTINCT FROM NEW.source
     AND OLD.created_by IS NOT DISTINCT FROM NEW.created_by
     AND OLD.note IS NOT DISTINCT FROM NEW.note
     AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
  THEN
    RETURN NEW;
  END IF;
  IF OLD.voided_by IS DISTINCT FROM NEW.voided_by THEN
    RAISE EXCEPTION 'movimientos inmutables: solo se permite establecer voided_by de NULL a UUID (una vez)';
  END IF;
  RAISE EXCEPTION 'movimientos inmutables: no se permite modificar movimientos (solo voided_by de NULL a UUID)';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movements_immutable_update ON movements;
CREATE TRIGGER trg_movements_immutable_update
  BEFORE UPDATE ON movements
  FOR EACH ROW EXECUTE FUNCTION enforce_movement_immutable_update();

-- Seed: tenant demo
INSERT INTO tenants (id, name, location_name, lat, lon, tz) VALUES
  ('demo', 'Finca Demo', 'Lambayeque, Perú', -6.486, -79.647, 'America/Lima')
ON CONFLICT (id) DO NOTHING;

-- Seed: perfiles de cultivo (fuente de verdad en runtime para cerebro/portero; ADR-0016)
INSERT INTO crop_profiles (name, ec_min, ec_max, ph_min, ph_max, water_temp_min, water_temp_max, cycle_days, notes) VALUES
  ('lechuga', 1.2, 1.8, 5.8, 6.3, 18, 24, 45, 'Lechuga hidropónica de hoja suelta; ciclo ~45 días. EC baja al inicio, subir a 1.6 en engorde. Renovar solución si EC deriva.'),
  ('tomate', 2.0, 3.5, 5.5, 6.5, 18, 26, 90, 'Tomate indeterminado hidropónico; EC se eleva progresivamente con carga de frutos. Vigilar blossom-end rot si EC/pH fuera de rango.')
ON CONFLICT (name) DO NOTHING;

-- Mesas nacen LIBRES (sin cultivo): el cultivo lo pone el lote al abrirse (ADR-0025)
INSERT INTO modules (tenant, id, name) VALUES
  ('demo', 'mod-1', 'Mesa Norte'),
  ('demo', 'mod-2', 'Mesa Sur'),
  ('demo', 'mod-3', 'Mesa Tomate'),
  ('demo', 'mod-4', 'Mesa Este')
ON CONFLICT (tenant, id) DO NOTHING;

INSERT INTO device_identities (hw_id, tenant, module, claimed_by) VALUES
  ('020000000001', 'demo', 'mod-1', 'seed'),
  ('020000000002', 'demo', 'mod-2', 'seed'),
  ('020000000003', 'demo', 'mod-3', 'seed'),
  ('020000000004', 'demo', 'mod-4', 'seed')
ON CONFLICT DO NOTHING;

-- Seed kit estándar por módulo demo (12 dispositivos por módulo) — Fase 1
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

-- ── Fase 3 "Lazo cerrado" (ADR-0002/0009/0010/0019/0020) ────────────────────

-- action_requests: auditoría del portero (dueño único: services/policy).
-- Toda propuesta de actuación queda registrada: propuesta → validación → decisión → ejecución.
CREATE TABLE IF NOT EXISTS action_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id TEXT NOT NULL UNIQUE,        -- va en el payload Cmd; el router/fierro lo exigen
  tenant TEXT NOT NULL,
  module TEXT NOT NULL,
  device TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('start','stop','set')),
  params JSONB,                          -- ej: {"duration_ms": 2000} o {"v": "ON"}
  action_class TEXT NOT NULL,            -- dose_nutrient | dose_ph | fill_water | recirculate
  source TEXT NOT NULL CHECK (source IN ('agent','human')),
  requested_by TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','executed','rejected','failed','needs_data')),
  confidence JSONB,                      -- snapshot del termómetro al decidir
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);

CREATE INDEX IF NOT EXISTS idx_action_requests_status ON action_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_requests_module ON action_requests (tenant, module, created_at DESC);

-- work_orders: órdenes de trabajo manuales (ADR-0010). El portero las emite,
-- el chat las entrega, el humano confirma, queda registro.
CREATE TABLE IF NOT EXISTS work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant TEXT NOT NULL,
  module TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- podar | mezclar_nutrientes | trasplantar | cosechar | otro
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_by TEXT,
  done_at TIMESTAMPTZ,
  note TEXT,
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);

CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders (status, created_at DESC);

-- Auditoría: la historia de acciones no se borra; solo transiciones pending → executed|rejected|failed.
CREATE OR REPLACE FUNCTION prevent_action_request_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'action_requests inmutable: no se permite borrar auditoría del portero';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_requests_no_delete ON action_requests;
CREATE TRIGGER trg_action_requests_no_delete
  BEFORE DELETE ON action_requests
  FOR EACH ROW EXECUTE FUNCTION prevent_action_request_delete();

CREATE OR REPLACE FUNCTION enforce_action_request_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('executed','rejected','failed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'action_requests: transición de estado inválida (% → %)', OLD.status, NEW.status;
  END IF;
  IF OLD.policy_id IS DISTINCT FROM NEW.policy_id
     OR OLD.tenant IS DISTINCT FROM NEW.tenant
     OR OLD.module IS DISTINCT FROM NEW.module
     OR OLD.device IS DISTINCT FROM NEW.device
     OR OLD.action IS DISTINCT FROM NEW.action
     OR OLD.params IS DISTINCT FROM NEW.params
     OR OLD.action_class IS DISTINCT FROM NEW.action_class
     OR OLD.source IS DISTINCT FROM NEW.source
     OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
  THEN
    RAISE EXCEPTION 'action_requests: la propuesta original no se puede reescribir';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_requests_transition ON action_requests;
CREATE TRIGGER trg_action_requests_transition
  BEFORE UPDATE ON action_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_action_request_transition();


-- ── Fase 4 "Campaña con pausas honestas" (ADR-0021) / Lotes de producción (ADR-0024) ──
-- alerts ya no tiene FK a modules (module='platform' para alertas de plataforma)
-- lotes + alert_resolutions son la única excepción de escritura gobernada en mcp-domain (write.ts)
-- Modelo fábrica: el lote es el ciclo productivo real; la campaña es etiqueta lógica libre.
-- Regla física (validada en código al abrir): un módulo solo está en UN lote activo.
CREATE TABLE IF NOT EXISTS lotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,                       -- correlativo legible: LOTE-0001
  tenant TEXT NOT NULL,
  crop TEXT NOT NULL REFERENCES crop_profiles(name),
  campaign TEXT,                            -- etiqueta lógica libre; null = sin campaña
  modules JSONB NOT NULL,                   -- ["mod-1","mod-2"] — uno o varios, explícitos al abrir
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_end_at TIMESTAMPTZ,              -- started_at + crop_profiles.cycle_days (null si perfil sin ciclo)
  closed_at TIMESTAMPTZ,
  close_reason TEXT CHECK (close_reason IN ('cosecha','venta','perdida','otro')),
  profile_hash TEXT NOT NULL,               -- sha256 del perfil al abrir (comparabilidad ADR-0012)
  memory_hash TEXT,                         -- sha256 MEMORY.md del experto al abrir (null honesto)
  memory_hash_close TEXT,                   -- idem al cerrar
  note TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS lotes_code_unique ON lotes (code);
CREATE INDEX IF NOT EXISTS idx_lotes_tenant_state ON lotes (tenant, state);
CREATE SEQUENCE IF NOT EXISTS lotes_code_seq;

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