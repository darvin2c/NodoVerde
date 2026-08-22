-- 012-yield-supplier.sql — Rendimiento al cerrar lote + proveedor en movimientos.
-- lotes.yield_kg: kg cosechados declarados al cierre (nullable = honesto cuando no hay báscula).
-- movements.supplier: a quién se le compró/pagó (opcional; historial de precios y dedup fino).
-- Idempotente.

ALTER TABLE lotes ADD COLUMN IF NOT EXISTS yield_kg NUMERIC
  CONSTRAINT lotes_yield_kg_check CHECK (yield_kg IS NULL OR yield_kg >= 0);

ALTER TABLE movements ADD COLUMN IF NOT EXISTS supplier TEXT;

CREATE INDEX IF NOT EXISTS idx_movements_supplier ON movements (tenant, supplier) WHERE supplier IS NOT NULL;
