-- terraOS — devices.capability (ADR-0028): la capacidad de cada dispositivo se
-- provisiona en DB, no se compila en el portero ni en el sim.
--   actuadores → clase de acción: dose_nutrient | dose_ph | fill_water | recirculate
--   sensores   → métrica que alimentan: ec | ph | temp | level | flow | climate
--   cámara     → NULL (no alimenta métrica numérica ni actúa)
-- Idempotente. Para volúmenes existentes: AGENTS.md documenta el loop de migraciones.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS capability TEXT;
