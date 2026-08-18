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
// Solo para read|capture|calibrate (Fase 3: request set ya no actúa — ver emulator.ts)
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

export type CmdPayload = {
  action: "start" | "stop" | "set";
  policyId: string;
  durationMs?: number;
  v?: "ON" | "OFF";
};

// Fase 3: el fierro solo actúa por cmd con policy_id no vacío (defensa en profundidad).
// Payload contrato Cmd: {action:'start'|'stop'|'set', policy_id, params?:{duration_ms?, v?}}
export function parseCmdPayload(raw: string): CmdPayload | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const action = obj.action;
  if (action !== "start" && action !== "stop" && action !== "set") return null;
  const policyIdRaw = obj.policy_id ?? obj.policyId;
  if (typeof policyIdRaw !== "string" || policyIdRaw.trim().length === 0) return null;
  const policyId = policyIdRaw.trim();
  let durationMs: number | undefined;
  let v: "ON" | "OFF" | undefined;
  const params = obj.params;
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    const p = params as Record<string, unknown>;
    const d = p.duration_ms ?? p.durationMs;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) durationMs = Math.round(d);
    // también aceptar string numérico
    if (typeof d === "string" && d.trim().length > 0) {
      const n = Number(d);
      if (Number.isFinite(n) && n >= 0) durationMs = Math.round(n);
    }
    const vv = p.v;
    if (vv === "ON" || vv === "OFF") v = vv;
  }
  // tolerancia: algunos productores ponen v o duration_ms a nivel raíz (no params)
  if (v === undefined) {
    const vv = obj.v;
    if (vv === "ON" || vv === "OFF") v = vv;
  }
  if (durationMs === undefined) {
    const dd = obj.duration_ms ?? obj.durationMs;
    if (typeof dd === "number" && Number.isFinite(dd) && dd >= 0) durationMs = Math.round(dd);
  }
  return { action: action as CmdPayload["action"], policyId, ...(durationMs !== undefined ? { durationMs } : {}), ...(v !== undefined ? { v } : {}) };
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
