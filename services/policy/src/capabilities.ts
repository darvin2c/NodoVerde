// src/capabilities.ts — resolución dispositivo↔clase desde PROVISIONING (ADR-0028).
// El portero NO compila hardware: lee devices.capability (la escribe create_module
// con el kit declarativo del nodo). Caché por módulo con TTL 30s — el kit cambia
// solo al provisionar, no entre decisiones.
import { pool } from "./db.js";
import { type ActionClass } from "./config.js";

export type ModuleCapabilities = {
  /** clase de acción → ids de actuadores capaces (ordenados, determinista) */
  classToDevices: Map<ActionClass, string[]>;
  /** métrica observada → id del sensor que la alimenta (ec/ph/temp/level/flow/climate) */
  metricToDevice: Map<string, string>;
};

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; caps: ModuleCapabilities }>();

const ACTUATOR_CLASSES: Record<string, true> = {
  fill_water: true,
  dose_nutrient: true,
  dose_ph: true,
  recirculate: true,
};

/** Para tests: reset cache (patrón __resetWindowsCache de config.ts). */
export function __resetCapabilitiesCache(): void {
  cache.clear();
}

export async function getModuleCapabilities(tenant: string, module: string): Promise<ModuleCapabilities> {
  const key = `${tenant}/${module}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.caps;
  const res = await pool.query<{ id: string; capability: string }>(
    `SELECT id, capability FROM devices WHERE tenant=$1 AND module=$2 AND capability IS NOT NULL ORDER BY id`,
    [tenant, module],
  );
  const classToDevices = new Map<ActionClass, string[]>();
  const metricToDevice = new Map<string, string>();
  for (const row of res.rows) {
    if (ACTUATOR_CLASSES[row.capability]) {
      const cls = row.capability as ActionClass; // membership verificada por ACTUATOR_CLASSES
      const arr = classToDevices.get(cls) ?? [];
      arr.push(row.id);
      classToDevices.set(cls, arr);
    } else {
      metricToDevice.set(row.capability, row.id);
    }
  }
  for (const arr of classToDevices.values()) arr.sort();
  const caps: ModuleCapabilities = { classToDevices, metricToDevice };
  cache.set(key, { at: Date.now(), caps });
  return caps;
}

/** Clase de acción de un dispositivo según capabilities provisionadas; null si no es actuador conocido. */
export function classOfDevice(caps: ModuleCapabilities, device: string): ActionClass | null {
  for (const [cls, devices] of caps.classToDevices) {
    if (devices.includes(device)) return cls;
  }
  return null;
}
