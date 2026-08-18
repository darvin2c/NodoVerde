// src/rules.ts — funciones PURAS unit-testeables del portero
import { ACTION_CLASSES, DEVICE_TO_CLASS, getWindowForClass, type ActionClass } from "./config.js";

// ---------------------------------------------------------------------------
// Clasificación
// ---------------------------------------------------------------------------
export function classifyDevice(device: string): ActionClass | null {
  return DEVICE_TO_CLASS[device] ?? null;
}

// ---------------------------------------------------------------------------
// parseRequestPayload — crudo ON/OFF, JSON, {v}, {action}
// ---------------------------------------------------------------------------
export type ParsedPayload =
  | { action: "start"; params?: { duration_ms?: number } }
  | { action: "stop" }
  | { action: "set"; params: { v: "ON" | "OFF" } };

function defaultDurationForDevice(device: string): number | undefined {
  const cls = classifyDevice(device);
  if (!cls) return undefined;
  return ACTION_CLASSES[cls].defaultDurationMs;
}

export function parseRequestPayload(raw: unknown, device: string): ParsedPayload | null {
  // Normalizar raw a texto u objeto
  let text: string | null = null;
  let obj: unknown = raw;

  if (Buffer.isBuffer(raw)) {
    text = raw.toString("utf8").trim();
    obj = text;
  } else if (typeof raw === "string") {
    text = raw.trim();
    obj = text;
  } else if (raw !== null && typeof raw === "object" && !Buffer.isBuffer(raw)) {
    // ya es objeto, no hay texto
    text = null;
    obj = raw;
  } else if (raw === null || raw === undefined) {
    return null;
  }

  // Si tenemos texto, intentar interpretar ON/OFF directo primero
  if (text !== null) {
    const up = text.toUpperCase();
    if (up === "ON") {
      // Doser/valve → start con default, pump → set ON sostenido
      if (device === "pump-recirc-01") {
        return { action: "set", params: { v: "ON" } };
      }
      const d = defaultDurationForDevice(device);
      if (d !== undefined) return { action: "start", params: { duration_ms: d } };
      // fill_water sin default definido → usar 30000 como pulso por defecto (válido dentro de 500..120000)
      // Si no hay default y no es pump, retornar start sin duration (validateParams lo rellenará o rechazará)
      return { action: "start", params: { duration_ms: 30000 } };
    }
    if (up === "OFF") {
      return { action: "stop" };
    }
    // Intentar JSON parse si parece JSON
    const trimmed = text.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      try {
        obj = JSON.parse(trimmed);
        // si parse resulta string "ON"/"OFF", manejar abajo
      } catch {
        return null;
      }
    } else {
      // texto que no es ON/OFF ni JSON → no parseable
      // intentar JSON parse genérico por si es {"v":"ON"}
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          obj = parsed;
        } else if (typeof parsed === "string") {
          obj = parsed;
        } else {
          return null;
        }
      } catch {
        return null;
      }
    }
    // obj ahora es el parse; si sigue siendo string ON/OFF, manejar
    if (typeof obj === "string") {
      const u = (obj as string).trim().toUpperCase();
      if (u === "ON") {
        if (device === "pump-recirc-01") return { action: "set", params: { v: "ON" } };
        const d = defaultDurationForDevice(device);
        return { action: "start", params: { duration_ms: d ?? 30000 } };
      }
      if (u === "OFF") return { action: "stop" };
      return null;
    }
  }

  // obj debe ser objeto a partir de aquí
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;

  // — {v: "ON"/"OFF"} directo o dentro de params
  const vRaw = rec.v ?? (rec.params as Record<string, unknown> | undefined)?.v;
  if (typeof vRaw === "string") {
    const vUp = vRaw.trim().toUpperCase();
    if (vUp === "ON") {
      // si v es ON, distinguir pump vs resto igual que crudo ON
      if (device === "pump-recirc-01") {
        return { action: "set", params: { v: "ON" } };
      }
      // Si viene {v:"ON"} sin action explícito, para doser/valve interpretamos como start
      // (patrón humano HA button publica {v:ON} pero el portero debe convertir a start)
      // Sin embargo spec dice set+{v} es sostenido solo para pump; para doser/valve debe ser start.
      // Mantenemos comportamiento: {v:ON} con doser/valve → start
      const d = defaultDurationForDevice(device);
      // Si el objeto también trae action set explícito, respetarlo
      if (typeof rec.action === "string" && rec.action.toLowerCase() === "set") {
        return { action: "set", params: { v: "ON" } };
      }
      return { action: "start", params: { duration_ms: d ?? 30000 } };
    }
    if (vUp === "OFF") {
      // OFF siempre es stop (apagar), salvo que action sea set explícito para pump
      if (typeof rec.action === "string" && rec.action.toLowerCase() === "set") {
        return { action: "set", params: { v: "OFF" } };
      }
      return { action: "stop" };
    }
  }

  // — {action: "start"|"stop"|"set", params:{...}, v, duration_ms}
  const actionRaw = rec.action;
  if (typeof actionRaw === "string") {
    const a = actionRaw.trim().toLowerCase();
    if (a === "stop") return { action: "stop" };
    if (a === "start") {
      const dm =
        (rec.params as Record<string, unknown> | undefined)?.duration_ms ??
        rec.duration_ms ??
        (rec.params as Record<string, unknown> | undefined)?.durationMs ??
        rec.durationMs;
      if (typeof dm === "number" && Number.isFinite(dm)) {
        return { action: "start", params: { duration_ms: Math.round(dm) } };
      }
      if (typeof dm === "string" && dm.trim() !== "") {
        const n = Number(dm);
        if (Number.isFinite(n)) return { action: "start", params: { duration_ms: Math.round(n) } };
      }
      // sin duration → default si existe
      const d = defaultDurationForDevice(device);
      if (d !== undefined) return { action: "start", params: { duration_ms: d } };
      return { action: "start", params: { duration_ms: 30000 } };
    }
    if (a === "set") {
      // set requiere v ON|OFF
      let vVal: unknown = rec.v ?? (rec.params as Record<string, unknown> | undefined)?.v;
      if (typeof vVal === "string") {
        const vv = vVal.trim().toUpperCase();
        if (vv === "ON" || vv === "OFF") return { action: "set", params: { v: vv as "ON" | "OFF" } };
      }
      return null;
    }
  }

  // — Payload tipo params directo sin action pero con duration_ms (asumir start)
  const directDm = rec.duration_ms ?? rec.durationMs;
  if (typeof directDm === "number" && Number.isFinite(directDm)) {
    return { action: "start", params: { duration_ms: Math.round(directDm) } };
  }

  // Si solo trae params con v, ya manejado arriba; si llega aquí → no reconocido
  // También caso {params:{v:"ON"}} sin action ya manejado via vRaw
  return null;
}

// ---------------------------------------------------------------------------
// Ventana horaria — pura, con tz
// ---------------------------------------------------------------------------
function hourInTz(date: Date, tz: string): number {
  // Usar Intl para obtener hora en tz
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour");
  if (!hourPart) return date.getHours();
  const h = parseInt(hourPart.value, 10);
  // En-GB puede dar 24 para medianoche; normalizar a 0
  if (h === 24) return 0;
  return h;
}

export function checkTimeWindow(
  cls: ActionClass,
  farmDate: Date,
  tz?: string,
): { ok: true } | { ok: false; reason: string } {
  const win = getWindowForClass(cls);
  const [start, end] = win;
  if (start === 0 && end === 24) return { ok: true };
  if (start === 0 && end === 0) return { ok: true }; // sin restricción
  const hour = tz ? hourInTz(farmDate, tz) : farmDate.getHours();
  // Ventana [start, end) — si start < end, simple; si cruza medianoche, wrap
  let inside: boolean;
  if (start < end) {
    inside = hour >= start && hour < end;
  } else {
    inside = hour >= start || hour < end;
  }
  if (inside) return { ok: true };
  return {
    ok: false,
    reason: `fuera de ventana horaria ${start}–${end} (hora local ${hour}h)`,
  };
}

// ---------------------------------------------------------------------------
// Confianza
// ---------------------------------------------------------------------------
export function checkConfidence(
  sources: Record<string, number> | null | undefined,
  cls: ActionClass,
): { ok: true } | { ok: false; needs: string[] } {
  const required = ACTION_CLASSES[cls].minConfidence;
  if (!required || Object.keys(required).length === 0) return { ok: true };
  const needs: string[] = [];
  const src = sources ?? {};
  for (const [metric, min] of Object.entries(required)) {
    const v = src[metric];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
      needs.push(metric);
    }
  }
  if (needs.length === 0) return { ok: true };
  return { ok: false, needs };
}

// ---------------------------------------------------------------------------
// Salud
// ---------------------------------------------------------------------------
export function checkHealth(state: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (state === "blind" || state === "offline") {
    return { ok: false, reason: "module_offline" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Techo duro
// ---------------------------------------------------------------------------
export type CropProfile = {
  ec_min: number;
  ec_max: number;
  ph_min: number;
  ph_max: number;
};

export function checkHardCeiling(
  cls: ActionClass,
  readings: Record<string, number> | null | undefined,
  crop: CropProfile | null | undefined,
): { ok: true } | { ok: false; reason: string } {
  const r = readings ?? {};
  if (cls === "dose_nutrient") {
    const ec = r.ec;
    if (typeof ec === "number" && Number.isFinite(ec) && crop && typeof crop.ec_max === "number") {
      if (ec >= crop.ec_max + 0.5) {
        return { ok: false, reason: `techo EC: ${ec} >= ${crop.ec_max}+0.5` };
      }
    }
    return { ok: true };
  }
  if (cls === "dose_ph") {
    const ph = r.ph;
    if (typeof ph === "number" && Number.isFinite(ph) && crop && typeof crop.ph_min === "number") {
      if (ph <= crop.ph_min - 0.5) {
        return { ok: false, reason: `techo pH: ${ph} <= ${crop.ph_min}-0.5` };
      }
    }
    return { ok: true };
  }
  if (cls === "fill_water") {
    const level = r.level;
    if (typeof level === "number" && Number.isFinite(level)) {
      if (level >= 95) {
        return { ok: false, reason: `techo nivel: ${level} >= 95` };
      }
    }
    return { ok: true };
  }
  // recirculate sin techo
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Validación de params normalizados
// ---------------------------------------------------------------------------
export function validateParams(
  cls: ActionClass,
  action: string,
  params: Record<string, unknown> | null | undefined,
): { ok: true; params: Record<string, unknown> } | { ok: false; reason: string } {
  const cfg = ACTION_CLASSES[cls];
  if (!cfg) return { ok: false, reason: `clase desconocida ${cls}` };

  const a = action.trim().toLowerCase();

  if (a === "stop") {
    // stop no requiere params, si trae v/duration ignorar
    return { ok: true, params: {} };
  }

  if (a === "set") {
    const vRaw = params?.v;
    if (typeof vRaw !== "string") return { ok: false, reason: "set requiere params.v ON|OFF" };
    const vUp = vRaw.trim().toUpperCase();
    if (vUp !== "ON" && vUp !== "OFF") return { ok: false, reason: "set requiere params.v ON|OFF" };
    return { ok: true, params: { v: vUp } };
  }

  if (a === "start") {
    let dm: unknown = params?.duration_ms ?? params?.durationMs;
    // Si no viene duration_ms, aplicar default para doser/valve
    if (dm === undefined || dm === null || dm === "") {
      if (cfg.defaultDurationMs !== undefined) {
        return { ok: true, params: { duration_ms: cfg.defaultDurationMs } };
      }
      // fill_water sin default en spec → default 30000 (mitad del max) si no hay default
      if (cls === "fill_water") {
        return { ok: true, params: { duration_ms: 30000 } };
      }
      return { ok: false, reason: "start requiere duration_ms" };
    }
    let n: number;
    if (typeof dm === "string") {
      n = Number(dm);
    } else if (typeof dm === "number") {
      n = dm;
    } else {
      return { ok: false, reason: "duration_ms debe ser número entero" };
    }
    if (!Number.isFinite(n)) return { ok: false, reason: "duration_ms debe ser número finito" };
    n = Math.round(n);
    const max = cfg.maxDurationMs ?? 120000;
    if (n < 500 || n > max) {
      return { ok: false, reason: `duration_ms debe estar entre 500 y ${max}` };
    }
    return { ok: true, params: { duration_ms: n } };
  }

  return { ok: false, reason: `acción inválida ${action}` };
}
