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
  autonomy: Autonomy;
  minConfidence: Record<string, number>;
  maxDurationMs?: number;
  rateLimitMs: number;
  defaultDurationMs?: number;
}

export const ACTION_CLASSES: Record<ActionClass, ClassConfig> = {
  fill_water: {
    autonomy: "autonomous",
    minConfidence: { level: 80 },
    maxDurationMs: 120000,
    rateLimitMs: 600000,
  },
  dose_nutrient: {
    autonomy: "supervised",
    minConfidence: { ec: 70 },
    maxDurationMs: 10000,
    rateLimitMs: 600000,
    defaultDurationMs: 2000,
  },
  dose_ph: {
    autonomy: "supervised",
    minConfidence: { ph: 70 },
    maxDurationMs: 8000,
    rateLimitMs: 600000,
    defaultDurationMs: 2000,
  },
  recirculate: {
    autonomy: "autonomous",
    minConfidence: { level: 50 },
    rateLimitMs: 60000,
  },
};

// Qué métrica observa cada clase (regla del portero, invariante — NO del despliegue).
// El dispositivo sensor concreto se resuelve desde devices.capability (capabilities.ts).
export const CLASS_OBSERVED_METRIC: Record<ActionClass, string> = {
  fill_water: "level",
  dose_nutrient: "ec",
  dose_ph: "ph",
  recirculate: "level",
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
