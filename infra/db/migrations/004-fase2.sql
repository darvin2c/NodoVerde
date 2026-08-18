-- terraOS Fase 2 "Finanzas" (ADR-0011) — ledger de movimientos + imputación + supply_costs
-- Idempotente: IF NOT EXISTS / ON CONFLICT / DO ... EXCEPTION WHEN duplicate_object.
-- Para volúmenes existentes (docker-entrypoint 04-fase2.sql).
-- También replicado en init.sql para volúmenes nuevos.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── movements: nuevas columnas ──────────────────────────────────────────────
ALTER TABLE movements ADD COLUMN IF NOT EXISTS anula_a UUID REFERENCES movements(id);
ALTER TABLE movements ADD COLUMN IF NOT EXISTS source_event TEXT;

-- ── CHECK constraints (kind, category) ─────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE movements ADD CONSTRAINT movements_kind_check
    CHECK (kind IN ('gasto','ingreso'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE movements ADD CONSTRAINT movements_category_check
    CHECK (category IN ('nutrientes','energia','agua','plantulas','mano_obra','empaque','transporte','venta_cosecha','software','otro'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- category NOT NULL: tabla vacía en producción → puede exigirse firme.
-- Si hay datos legacy con NULL, el ALTER fallará; se captura y se deja
-- la validación en el trigger (que exige categoría obligatoria).
DO $$ BEGIN
  ALTER TABLE movements ALTER COLUMN category SET NOT NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE '004-fase2: no se pudo hacer category NOT NULL (datos existentes con NULL), se exige vía trigger';
END $$;

-- ── dedup idempotente del consumidor MQTT ──────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_source_event_unique
  ON movements (tenant, source_event) WHERE source_event IS NOT NULL;

-- ── supply_costs ───────────────────────────────────────────────────────────
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
  -- categoría obligatoria (todo vigente tiene categoría; la anulación también)
  IF NEW.category IS NULL THEN
    RAISE EXCEPTION 'categoría obligatoria: todo movimiento debe tener categoría';
  END IF;

  -- attribution obligatoria: array no vacío de {module, pct}
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
  -- Única mutación permitida: voided_by de NULL a UUID.
  -- Todas las demás columnas deben permanecer idénticas.
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
