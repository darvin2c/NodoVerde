-- terraOS Fase 6 "Módulo como unidad lógica nombrada" (ADR-0022)
-- modules.name: nombre humano libre ("Mesa Norte") — el id técnico (mod-N) no cambia.
-- modules.retired_at: retiro gobernado — NADA se borra (ADR-0011 aplicado a dominio);
-- un módulo retirado deja de aceptar telemetría/claiming pero conserva su historia.
-- Idempotente: IF NOT EXISTS en todo.

ALTER TABLE modules ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

-- Nombres demo (solo si la fila aún no tiene nombre — no pisa renombres del dueño)
UPDATE modules SET name = 'Mesa Norte' WHERE tenant = 'demo' AND id = 'mod-1' AND name IS NULL;
UPDATE modules SET name = 'Mesa Sur'   WHERE tenant = 'demo' AND id = 'mod-2' AND name IS NULL;
UPDATE modules SET name = 'Mesa Tomate' WHERE tenant = 'demo' AND id = 'mod-3' AND name IS NULL;
UPDATE modules SET name = 'Mesa Este'  WHERE tenant = 'demo' AND id = 'mod-4' AND name IS NULL;
