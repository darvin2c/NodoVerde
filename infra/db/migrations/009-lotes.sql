-- 009-lotes.sql — Lotes de producción (ADR-0024): reemplaza el registro de campañas (ADR-0021).
-- Modelo fábrica: el LOTE es el ciclo productivo real (programa + módulos + fechas propias);
-- la CAMPAÑA deja de ser entidad gobernada y pasa a ser etiqueta lógica libre ("invierno-2026").
-- Regla física: un módulo solo puede estar en UN lote activo (validada en código al abrir).
-- Idempotente. Nada se pierde: las filas de campaigns migran a lotes conservando ids y hashes.

-- Duración de ciclo por cultivo (para fin esperado del lote)
ALTER TABLE crop_profiles ADD COLUMN IF NOT EXISTS cycle_days INT;
UPDATE crop_profiles SET cycle_days = 45 WHERE name = 'lechuga' AND cycle_days IS NULL;
UPDATE crop_profiles SET cycle_days = 90 WHERE name = 'tomate' AND cycle_days IS NULL;

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

-- Migración de historia (campaigns → lotes). Conserva id, hashes, nota y fechas.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'campaigns') THEN
    INSERT INTO lotes (id, code, tenant, crop, campaign, modules, started_at, closed_at,
                       profile_hash, memory_hash, memory_hash_close, note, state)
    SELECT c.id,
           'LOTE-' || lpad(nextval('lotes_code_seq')::text, 4, '0'),
           c.tenant, c.crop, NULL, c.modules, c.opened_at, c.closed_at,
           c.profile_hash, c.memory_hash, c.memory_hash_close, c.note, c.state
    FROM campaigns c
    ON CONFLICT (id) DO NOTHING;
    DROP TABLE campaigns;
  END IF;
END $$;
