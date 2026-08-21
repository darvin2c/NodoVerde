-- 010-modulo-fungible.sql — Flujo lote-céntrico (ADR-0025).
-- La mesa (módulo) deja de tener cultivo propio: modules.crop pasa a ser caché
-- nullable mantenido SOLO por el ciclo del lote (open_batch lo escribe,
-- close_batch lo limpia a NULL). Mesa libre = sin cultivo (honesto, ADR-0010).
-- Idempotente.

-- crop se vuelve nullable (sigue referenciando crop_profiles cuando hay valor)
ALTER TABLE modules ALTER COLUMN crop DROP NOT NULL;

-- Consistencia inicial: cultivo solo en módulos con lote ABIERTO que lo declare.
-- El resto queda libre (NULL) — su cultivo anterior era una asignación sin ciclo.
UPDATE modules m
SET crop = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM lotes l
  WHERE l.tenant = m.tenant
    AND l.state = 'open'
    AND l.modules ? m.id
    AND l.crop = m.crop
);
