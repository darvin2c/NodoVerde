// src/config.ts — configuración del portero (env + clases de acción)
export const POLICY_PORT = parseInt(process.env.POLICY_PORT ?? "7762", 10);
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";
export const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
export const BRIDGE_URL = (process.env.BRIDGE_URL ?? "http://localhost:7765").replace(/\/$/, "");
export const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN ?? "";
export const POLICY_ADMIN_TOKEN = process.env.POLICY_ADMIN_TOKEN ?? "dev-admin-token";

// ---------------------------------------------------------------------------
// Clases de acción del portero (config en código, override de ventanas por env)
// ---------------------------------------------------------------------------
export type Autonomy = "autonomous" | "supervised";
export type ActionClass = "fill_water" | "dose_nutrient" | "dose_ph" | "recirculate";

export interface ClassConfig {
  devices: string[];
  autonomy: Autonomy;
  minConfidence: Record<string, number>;
  maxDurationMs?: number;
  rateLimitMs: number;
  defaultDurationMs?: number;
}

export const ACTION_CLASSES: Record<ActionClass, ClassConfig> = {
  fill_water: {
    devices: ["valve-fill-01"],
    autonomy: "autonomous",
    minConfidence: { level: 80 },
    maxDurationMs: 120000,
    rateLimitMs: 600000,
  },
  dose_nutrient: {
    devices: ["doser-a-01", "doser-b-01"],
    autonomy: "supervised",
    minConfidence: { ec: 70 },
    maxDurationMs: 10000,
    rateLimitMs: 600000,
    defaultDurationMs: 2000,
  },
  dose_ph: {
    devices: ["doser-ph-01"],
    autonomy: "supervised",
    minConfidence: { ph: 70 },
    maxDurationMs: 8000,
    rateLimitMs: 600000,
    defaultDurationMs: 2000,
  },
  recirculate: {
    devices: ["pump-recirc-01"],
    autonomy: "autonomous",
    minConfidence: { level: 50 },
    rateLimitMs: 60000,
  },
};

// Mapa dispositivo → clase
export const DEVICE_TO_CLASS: Record<string, ActionClass> = {
  "valve-fill-01": "fill_water",
  "doser-a-01": "dose_nutrient",
  "doser-b-01": "dose_nutrient",
  "doser-ph-01": "dose_ph",
  "pump-recirc-01": "recirculate",
};

// Mapa clase → sensorDevice para recolección (request/read cuando falta confianza)
export const CLASS_SENSOR_DEVICE: Record<ActionClass, string> = {
  fill_water: "level-01",
  dose_nutrient: "ec-01",
  dose_ph: "ph-01",
  recirculate: "level-01",
};

// ---------------------------------------------------------------------------
// Ventanas horarias (default 0-24, override por env POLICY_WINDOWS_JSON)
// ---------------------------------------------------------------------------
export type WindowRange = [number, number];

function parsePolicyWindows(): Record<string, WindowRange> {
  const raw = process.env.POLICY_WINDOWS_JSON;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, WindowRange> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") {
        out[k] = [v[0], v[1]];
      }
    }
    return out;
  } catch {
    console.warn("[terra-policy] POLICY_WINDOWS_JSON inválido, usando default 0-24");
    return {};
  }
}

let _cachedWindows: Record<string, WindowRange> | null = null;
export function getPolicyWindows(): Record<string, WindowRange> {
  if (_cachedWindows) return _cachedWindows;
  _cachedWindows = parsePolicyWindows();
  return _cachedWindows;
}

export function getWindowForClass(cls: ActionClass): WindowRange {
  const windows = getPolicyWindows();
  const w = windows[cls];
  if (w) return w;
  return [0, 24];
}

// Para tests: reset cache
export function __resetWindowsCache(): void {
  _cachedWindows = null;
}
