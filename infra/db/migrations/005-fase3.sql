-- terraOS Fase 3 "Lazo cerrado" (ADR-0002/0009/0010/0019/0020) — portero: audit de acciones + órdenes de trabajo
-- Idempotente: IF NOT EXISTS / DO ... EXCEPTION WHEN duplicate_object.
-- Para volúmenes existentes (docker-entrypoint 05-fase3.sql).
-- También replicado en init.sql para volúmenes nuevos.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── action_requests: auditoría del portero (dueño único: services/policy) ──
-- Toda propuesta de actuación (agente o humano) queda registrada:
-- propuesta → validación → decisión → ejecución. Status terminal: executed|rejected|failed|needs_data.
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
  requested_by TEXT NOT NULL,            -- agentId del cerebro o identidad del humano (ha-button, chat)
  reason TEXT,                           -- justificación del solicitante o motivo de rechazo
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','executed','rejected','failed','needs_data')),
  confidence JSONB,                      -- snapshot del termómetro al decidir (fuentes por variable)
  decided_by TEXT,                       -- quién aprobó/rechazó (humano) o NULL si autónoma
  decided_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);

CREATE INDEX IF NOT EXISTS idx_action_requests_status ON action_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_requests_module ON action_requests (tenant, module, created_at DESC);

-- ── work_orders: órdenes de trabajo manuales (ADR-0010) ─────────────────────
-- Acciones manuales (podar, mezclar nutrientes, cosechar): el portero las emite,
-- el chat las entrega, el humano confirma, queda registro. Sin canal MQTT nuevo.
CREATE TABLE IF NOT EXISTS work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant TEXT NOT NULL,
  module TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- podar | mezclar_nutrientes | trasplantar | cosechar | otro
  instructions TEXT NOT NULL,            -- pasos concretos para el humano
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  created_by TEXT NOT NULL,              -- agentId o humano que la originó
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_by TEXT,
  done_at TIMESTAMPTZ,
  note TEXT,                             -- confirmación / observación del humano
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);

CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders (status, created_at DESC);

-- ── auditoría: la historia de acciones no se borra ──────────────────────────
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

-- Transiciones de estado permitidas (la fila nace pending|executed|rejected|needs_data):
--   pending → executed | rejected | failed. Lo demás queda congelado.
CREATE OR REPLACE FUNCTION enforce_action_request_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('executed','rejected','failed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'action_requests: transición de estado inválida (% → %)', OLD.status, NEW.status;
  END IF;
  -- mismo estado: solo se permite rellenar campos de decisión/ejecución, no reescribir la propuesta
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
