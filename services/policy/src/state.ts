// src/state.ts — caches MQTT retained del portero
export type ReadingEntry = { v: number; ts: number };
export type ConfidenceEntry = { v: number; ts: number; sources: Record<string, number> };

// tenant/module/metric → {v, ts}
export const lastReadings = new Map<string, ReadingEntry>();
// tenant/module → {v, sources, ts}
export const moduleConfidence = new Map<string, ConfidenceEntry>();
// tenant/module → state (healthy|degraded|blind|offline|...)
export const moduleHealth = new Map<string, string>();

function readingsKey(tenant: string, mod: string, metric: string): string {
  return `${tenant}/${mod}/${metric}`;
}

function moduleKey(tenant: string, mod: string): string {
  return `${tenant}/${mod}`;
}

export function readingsForModule(tenant: string, mod: string): Record<string, number> {
  const prefix = `${tenant}/${mod}/`;
  const out: Record<string, number> = {};
  for (const [k, entry] of lastReadings.entries()) {
    if (k.startsWith(prefix)) {
      const metric = k.slice(prefix.length);
      out[metric] = entry.v;
    }
  }
  return out;
}

export function onReading(topic: string, payload: Buffer | string): boolean {
  // topic: terra/{tenant}/{module}/{device}/{metric}/reading  (6 segs)
  const parts = topic.split("/");
  if (parts.length !== 6) return false;
  if (parts[0] !== "terra" || parts[5] !== "reading") return false;
  const [, tenant, mod, _device, metric] = parts;
  if (!tenant || !mod || !metric) return false;
  let msg: unknown;
  try {
    const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : (payload as string);
    msg = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof msg !== "object" || msg === null) return false;
  const rec = msg as Record<string, unknown>;
  const v = rec.v;
  const ts = rec.ts;
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const t = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
  lastReadings.set(readingsKey(tenant, mod, metric), { v, ts: t });
  return true;
}

export function onConfidence(topic: string, payload: Buffer | string): boolean {
  // topic: terra/{tenant}/{module}/confidence  (4 segs)
  const parts = topic.split("/");
  if (parts.length !== 4) return false;
  if (parts[0] !== "terra" || parts[3] !== "confidence") return false;
  const tenant = parts[1];
  const mod = parts[2];
  if (!tenant || !mod) return false;
  let msg: unknown;
  try {
    const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : (payload as string);
    msg = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof msg !== "object" || msg === null) return false;
  const rec = msg as Record<string, unknown>;
  const v = rec.v;
  const ts = rec.ts;
  const sources = rec.sources;
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (typeof sources !== "object" || sources === null) return false;
  // sources values deben ser números
  const src: Record<string, number> = {};
  for (const [k, val] of Object.entries(sources as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val)) src[k] = val;
  }
  const t = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
  moduleConfidence.set(moduleKey(tenant, mod), { v, ts: t, sources: src });
  return true;
}

export function onHealth(topic: string, payload: Buffer | string): boolean {
  // topic: terra/{tenant}/{module}/health  (4 segs)
  const parts = topic.split("/");
  if (parts.length !== 4) return false;
  if (parts[0] !== "terra" || parts[3] !== "health") return false;
  const tenant = parts[1];
  const mod = parts[2];
  if (!tenant || !mod) return false;
  let msg: unknown;
  try {
    const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : (payload as string);
    msg = JSON.parse(raw);
  } catch {
    // salud a veces es texto plano con estado
    const rawStr = Buffer.isBuffer(payload) ? payload.toString("utf8").trim() : String(payload).trim();
    if (rawStr === "blind" || rawStr === "offline" || rawStr === "healthy" || rawStr === "degraded") {
      moduleHealth.set(moduleKey(tenant, mod), rawStr);
      return true;
    }
    return false;
  }
  if (typeof msg === "string") {
    moduleHealth.set(moduleKey(tenant, mod), msg);
    return true;
  }
  if (typeof msg !== "object" || msg === null) return false;
  const rec = msg as Record<string, unknown>;
  // formatos posibles: {state:"blind"} | {status:"blind"} | {v:"blind"}
  const state = (rec.state ?? rec.status ?? rec.v) as unknown;
  if (typeof state === "string") {
    moduleHealth.set(moduleKey(tenant, mod), state);
    return true;
  }
  return false;
}

export function getConfidence(tenant: string, mod: string): ConfidenceEntry | undefined {
  return moduleConfidence.get(moduleKey(tenant, mod));
}

export function getHealth(tenant: string, mod: string): string | undefined {
  return moduleHealth.get(moduleKey(tenant, mod));
}

export function clearState(): void {
  lastReadings.clear();
  moduleConfidence.clear();
  moduleHealth.clear();
}
