// Comportamiento del firmware emulado — funciones puras (testeables sin broker ni física).
// Define QUÉ publica un nodo: métricas por dispositivo, estado de switches y
// lógica de auto-dosis (protección de cultivo que corre en el firmware real).
import type { ModuleState } from "../model.js";

// dispositivo → métrica publicada (contrato plano dispositivo)
export const DEVICE_METRICS: Record<string, string> = {
  "ec-01": "ec",
  "ph-01": "ph",
  "temp-01": "temp",
  "level-01": "level",
  "flow-01": "flow",
  "climate-01": "air_temp",
  "pump-recirc-01": "switch",
  "valve-fill-01": "switch",
  "doser-a-01": "switch",
  "doser-b-01": "switch",
  "doser-ph-01": "switch",
};

export const SENSOR_DEVICES = ["ec-01", "ph-01", "temp-01", "level-01", "flow-01", "climate-01"] as const;
export const SWITCH_DEVICES = ["pump-recirc-01", "valve-fill-01", "doser-a-01", "doser-b-01", "doser-ph-01"] as const;
export const ALL_DEVICES = [...SENSOR_DEVICES, ...SWITCH_DEVICES, "cam-01"] as const;

export function switchOn(state: ModuleState, device: string): boolean {
  const onMap: Record<string, boolean> = {
    "pump-recirc-01": state.pumpOn,
    "valve-fill-01": state.valveOn,
    "doser-a-01": state.doserAOn,
    "doser-b-01": state.doserBOn,
    "doser-ph-01": state.doserPhOn,
  };
  return onMap[device] ?? false;
}

// payload de request: acepta crudo ("ON"), JSON string o {"v": ...} / {"action": ...}
export function parseRequestPayload(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (parsed !== null && typeof parsed === "object") {
      if ("v" in parsed) {
        const v = (parsed as Record<string, unknown>).v;
        if (typeof v === "string") return v;
        if (typeof v === "number") return String(v);
      }
      if ("action" in parsed) {
        const a = (parsed as Record<string, unknown>).action;
        if (typeof a === "string") return a;
      }
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export type CropTargets = { ec: [number, number]; ph: [number, number] };
export type AutoDoseAction =
  | { device: "doser-a-01" | "doser-b-01"; event: "auto_dose"; durationMs: number }
  | { device: "doser-ph-01"; event: "auto_dose_ph"; durationMs: number }
  | { device: "valve-fill-01"; event: "auto_fill"; durationMs: number };

// Auto-dosis del firmware: protege el cultivo sin intervención de nadie.
// Devuelve a lo sumo UNA acción por ciclo (la más urgente), como hace el firmware real.
export function decideAutoDose(
  state: ModuleState,
  targets: CropTargets,
  disableAutoDose: boolean,
  rng: () => number,
): AutoDoseAction | null {
  if (disableAutoDose) return null;
  if (state.ec < targets.ec[0] && state.doserATimer === 0 && state.doserBTimer === 0) {
    const device = rng() > 0.5 ? "doser-a-01" : "doser-b-01";
    return { device, event: "auto_dose", durationMs: 2000 };
  }
  if (state.ph > targets.ph[1] && state.doserPhTimer === 0) {
    return { device: "doser-ph-01", event: "auto_dose_ph", durationMs: 2000 };
  }
  if (state.tankLevel < 25 && state.valveTimer === 0) {
    return { device: "valve-fill-01", event: "auto_fill", durationMs: 20000 };
  }
  return null;
}
