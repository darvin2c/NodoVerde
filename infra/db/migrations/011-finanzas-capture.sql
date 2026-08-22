-- Migración 011 — Captura financiera omnicanal (ADR-0027)
-- Idempotente. Reescribe attribution de porcentajes a montos, añade traza de
-- procedencia, evidencia multi-archivo, numeración de operación y nivel finca.

-- ── movements: nuevas columnas ──────────────────────────────────────────────
ALTER TABLE movements ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'modulos';
ALTER TABLE movements ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
ALTER TABLE movements ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE movements ADD COLUMN IF NOT EXISTS raw_payload TEXT;
ALTER TABLE movements ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE movements ADD COLUMN IF NOT EXISTS op_number TEXT;
ALTER TABLE movements ADD COLUMN IF NOT EXISTS replaces UUID REFERENCES movements(id);

DO $$ BEGIN
  ALTER TABLE movements ADD CONSTRAINT movements_scope_check CHECK (scope IN ('finca','modulos'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE movements ADD CONSTRAINT movements_channel_check
    CHECK (channel IS NULL OR channel IN ('telegram','whatsapp','webchat','pwa','auto'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_op_number_unique
  ON movements (tenant, op_number) WHERE op_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movements_external_ref
  ON movements (tenant, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movements_occurred_at ON movements (occurred_at);

-- ── contador de op_number por tenant (MOV-NNNN, atómico) ───────────────────
CREATE TABLE IF NOT EXISTS tenant_counters (
  tenant TEXT PRIMARY KEY,
  op_seq INTEGER NOT NULL DEFAULT 0
);

-- ── movement_evidence: soporte probatorio multi-archivo (MinIO) ────────────
CREATE TABLE IF NOT EXISTS movement_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id UUID REFERENCES movements(id),   -- NULL = subida pendiente de adjuntar
  tenant TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  kind TEXT NOT NULL DEFAULT 'otro'
    CONSTRAINT movement_evidence_kind_check
    CHECK (kind IN ('recibo','captura_pago','factura','audio','foto_producto','otro')),
  channel TEXT,
  uploaded_by TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_movement_evidence_movement ON movement_evidence (movement_id);
CREATE INDEX IF NOT EXISTS idx_movement_evidence_sha ON movement_evidence (tenant, sha256);

-- La evidencia es inmutable salvo adjuntar (movement_id NULL → UUID, una vez)
CREATE OR REPLACE FUNCTION prevent_evidence_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidencia inmutable: no se permite borrar evidencia (la historia financiera conserva sus pruebas)';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_evidence_no_delete ON movement_evidence;
CREATE TRIGGER trg_evidence_no_delete
  BEFORE DELETE ON movement_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_delete();

CREATE OR REPLACE FUNCTION enforce_evidence_immutable_update() RETURNS trigger AS $$
BEGIN
  IF OLD.movement_id IS NULL AND NEW.movement_id IS NOT NULL
     AND OLD.id IS NOT DISTINCT FROM NEW.id
     AND OLD.tenant IS NOT DISTINCT FROM NEW.tenant
     AND OLD.object_key IS NOT DISTINCT FROM NEW.object_key
     AND OLD.sha256 IS NOT DISTINCT FROM NEW.sha256
     AND OLD.mime_type IS NOT DISTINCT FROM NEW.mime_type
     AND OLD.size_bytes IS NOT DISTINCT FROM NEW.size_bytes
     AND OLD.kind IS NOT DISTINCT FROM NEW.kind
     AND OLD.channel IS NOT DISTINCT FROM NEW.channel
     AND OLD.uploaded_by IS NOT DISTINCT FROM NEW.uploaded_by
     AND OLD.uploaded_at IS NOT DISTINCT FROM NEW.uploaded_at
     AND OLD.note IS NOT DISTINCT FROM NEW.note
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'evidencia inmutable: solo se permite adjuntar (movement_id de NULL a UUID, una vez)';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_evidence_immutable_update ON movement_evidence;
CREATE TRIGGER trg_evidence_immutable_update
  BEFORE UPDATE ON movement_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_evidence_immutable_update();

-- ── backfill de filas existentes (occurred_at, op_number, attribution) ─────
-- La inmutabilidad es regla de negocio en runtime; la migración es mantenimiento
-- del esquema: se deshabilita el trigger, se reescribe, se rehabilita.
ALTER TABLE movements DISABLE TRIGGER trg_movements_immutable_update;

UPDATE movements SET occurred_at = ts WHERE occurred_at IS NULL;

-- op_number retroactivo por tenant, en orden cronológico
WITH numbered AS (
  SELECT id, tenant,
         'MOV-' || lpad(row_number() OVER (PARTITION BY tenant ORDER BY ts, id)::text, 4, '0') AS op
  FROM movements
  WHERE op_number IS NULL
)
UPDATE movements m SET op_number = n.op FROM numbered n WHERE m.id = n.id;

-- contadores al día
INSERT INTO tenant_counters (tenant, op_seq)
SELECT tenant, COUNT(*)::int FROM movements GROUP BY tenant
ON CONFLICT (tenant) DO UPDATE SET op_seq = GREATEST(tenant_counters.op_seq, EXCLUDED.op_seq);

-- attribution: pct → montos (último elemento absorbe el resto) + snapshot del
-- lote por ventana histórica (qué lote ocupaba el módulo en ts del movimiento)
DO $$
DECLARE
  m RECORD;
  elem RECORD;
  new_attr JSONB;
  running NUMERIC;
  remaining NUMERIC;
  amt NUMERIC;
  cnt INT;
  i INT;
  batch_code TEXT;
BEGIN
  FOR m IN SELECT id, tenant, ts, amount, attribution FROM movements
           WHERE attribution IS NOT NULL AND jsonb_typeof(attribution) = 'array'
             AND jsonb_array_length(attribution) > 0
             AND (attribution->0) ? 'pct'
  LOOP
    cnt := jsonb_array_length(m.attribution);
    new_attr := '[]'::jsonb;
    running := 0;
    i := 0;
    FOR elem IN SELECT value FROM jsonb_array_elements(m.attribution)
    LOOP
      i := i + 1;
      IF i = cnt THEN
        amt := m.amount - running;            -- último absorbe el resto
      ELSE
        amt := round(m.amount * COALESCE((elem.value->>'pct')::numeric, 0) / 100, 2);
        running := running + amt;
      END IF;
      SELECT l.code INTO batch_code FROM lotes l
       WHERE l.tenant = m.tenant
         AND l.modules ? (elem.value->>'module')
         AND l.started_at <= m.ts
         AND (l.closed_at IS NULL OR m.ts <= l.closed_at)
       ORDER BY l.started_at DESC LIMIT 1;
      new_attr := new_attr || jsonb_build_object(
        'module', elem.value->>'module',
        'amount', amt,
        'batch', batch_code
      );
    END LOOP;
    UPDATE movements SET attribution = new_attr WHERE id = m.id;
  END LOOP;
END $$;

ALTER TABLE movements ENABLE TRIGGER trg_movements_immutable_update;

-- ── trigger de validación: scope finca (sin attribution) o módulos (montos) ─
CREATE OR REPLACE FUNCTION validate_movement_attribution() RETURNS trigger AS $$
DECLARE
  _elem JSONB;
  _amt NUMERIC;
  _sum NUMERIC := 0;
  _mod TEXT;
  _cnt INT;
BEGIN
  IF NEW.category IS NULL OR btrim(NEW.category) = '' THEN
    RAISE EXCEPTION 'categoría obligatoria: todo movimiento debe tener categoría';
  END IF;
  IF NEW.scope = 'finca' THEN
    IF NEW.attribution IS NOT NULL
       AND NOT (jsonb_typeof(NEW.attribution) = 'array' AND jsonb_array_length(NEW.attribution) = 0) THEN
      RAISE EXCEPTION 'scope finca: attribution debe ser NULL (gasto general de finca, sin módulos)';
    END IF;
    NEW.attribution := NULL;
    RETURN NEW;
  END IF;
  -- scope modulos
  IF NEW.attribution IS NULL OR jsonb_typeof(NEW.attribution) <> 'array' THEN
    RAISE EXCEPTION 'atribución obligatoria: array no vacío de {module, amount, batch?}';
  END IF;
  _cnt := jsonb_array_length(NEW.attribution);
  IF _cnt IS NULL OR _cnt = 0 THEN
    RAISE EXCEPTION 'atribución inválida: array vacío, al menos un elemento {module, amount}';
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
      _amt := (_elem ->> 'amount')::NUMERIC;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'atribución inválida: amount debe ser número > 0 (módulo %)', _mod;
    END;
    IF _amt IS NULL OR _amt <= 0 THEN
      RAISE EXCEPTION 'atribución inválida: amount debe ser > 0 (módulo %)', _mod;
    END IF;
    _sum := _sum + _amt;
  END LOOP;
  IF abs(_sum - abs(NEW.amount)) > 0.005 THEN
    RAISE EXCEPTION 'atribución inválida: la suma de montos (%) debe igualar el total (%)', _sum, NEW.amount;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movements_validate_attribution ON movements;
CREATE TRIGGER trg_movements_validate_attribution
  BEFORE INSERT ON movements
  FOR EACH ROW EXECUTE FUNCTION validate_movement_attribution();

-- ── inmutabilidad: cubrir las columnas nuevas ───────────────────────────────
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
     AND OLD.scope IS NOT DISTINCT FROM NEW.scope
     AND OLD.occurred_at IS NOT DISTINCT FROM NEW.occurred_at
     AND OLD.channel IS NOT DISTINCT FROM NEW.channel
     AND OLD.raw_payload IS NOT DISTINCT FROM NEW.raw_payload
     AND OLD.external_ref IS NOT DISTINCT FROM NEW.external_ref
     AND OLD.op_number IS NOT DISTINCT FROM NEW.op_number
     AND OLD.replaces IS NOT DISTINCT FROM NEW.replaces
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
