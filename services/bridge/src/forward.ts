// Lógica pura del bridge — sin I/O ni MQTT.
// Decide si una alerta debe reenviarse al cerebro y formatea el mensaje en español.

export type Severity = "info" | "warn" | "critical";

export type Alert = {
  tenant: string;
  module: string;
  name: string;
  ts: number;
  severity: Severity;
  device?: string;
  detail?: Record<string, unknown>;
};

/** Mapa clave → timestamp del último reenvío (ms epoch). Clave: tenant/module/name */
export type ThrottleState = ReadonlyMap<string, number>;

export const DEFAULT_THROTTLE_MS = 300_000; // 5 min

// Nombres que siempre se reenvían, incluso con info y sin throttle.
const ALWAYS_NAMES: Record<string, true> = {
  module_blind: true,
  module_recovered: true,
};

// Traducción de severidades
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "crítica",
  warn: "advertencia",
  info: "informativa",
};

// Traducción de nombres de alerta conocidos
const NAME_ES: Record<string, string> = {
  device_silence: "silencio de dispositivo",
  device_frozen: "sensor congelado",
  device_impossible: "valor imposible",
  device_offline: "dispositivo desconectado",
  device_recovered: "dispositivo recuperado",
  module_blind: "módulo a ciegas",
  module_recovered: "módulo recuperado",
};

/** Clave compuesta para throttle: tenant/module/name */
export function throttleKey(alert: Alert): string {
  return `${alert.tenant}/${alert.module}/${alert.name}`;
}

/** Resultado de la decisión de reenvío */
export type ForwardDecision = {
  forward: boolean;
  newState: Map<string, number>;
};

/**
 * Decide si la alerta debe reenviarse.
 * - module_blind / module_recovered: siempre (bypass de filtro info y de throttle).
 * - severity info: nunca (ruido), salvo los dos nombres anteriores.
 * - critical/warn: sí, salvo throttle (misma clave en < throttleMs).
 */
export function shouldForward(
  alert: Alert,
  state: ThrottleState,
  nowMs: number,
  throttleMs: number = DEFAULT_THROTTLE_MS,
): ForwardDecision {
  // Copia defensiva — no mutar el mapa recibido
  const newState = new Map(state);

  // Transiciones de módulo siempre
  if (ALWAYS_NAMES[alert.name]) {
    // Actualizar timestamp igual para mantener trazabilidad, pero siempre reenviar
    newState.set(throttleKey(alert), nowMs);
    return { forward: true, newState };
  }

  // Info se filtra (ruido)
  if (alert.severity === "info") {
    return { forward: false, newState };
  }

  // Solo critical/warn llegan aquí
  if (alert.severity !== "critical" && alert.severity !== "warn") {
    return { forward: false, newState };
  }

  const key = throttleKey(alert);
  const last = state.get(key);
  if (last !== undefined && nowMs - last < throttleMs) {
    return { forward: false, newState };
  }

  newState.set(key, nowMs);
  return { forward: true, newState };
}

/** Formatea el detalle en texto legible */
function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail || Object.keys(detail).length === 0) return "";

  const value = detail["value"];
  const metric = detail["metric"];
  const range = detail["range"];
  const rango = detail["rango"];
  const expected = detail["expected"];

  if (typeof value === "number") {
    let txt = `${value}`;
    if (typeof metric === "string") txt = `${value} (${metric})`;
    if (typeof range === "string") txt += ` (rango ${range})`;
    else if (Array.isArray(range) && range.length === 2) txt += ` (rango ${range[0]}-${range[1]})`;
    else if (range && typeof range === "object") {
      const r = range as Record<string, unknown>;
      if (typeof r["min"] === "number" && typeof r["max"] === "number") {
        txt += ` (rango ${r["min"]}-${r["max"]})`;
      }
    }
    if (typeof rango === "string") txt += ` (rango ${rango})`;
    if (typeof expected === "string") txt += ` esperado ${expected}`;
    const known: Record<string, true> = { value: true, metric: true, range: true, rango: true, expected: true };
    const extras = Object.entries(detail).filter(([k]) => !known[k]);
    if (extras.length > 0) {
      const extra = Object.fromEntries(extras);
      txt += ` ${JSON.stringify(extra)}`;
    }
    return txt;
  }

  if (typeof detail["reason"] === "string") return String(detail["reason"]);
  if (typeof detail["msg"] === "string") return String(detail["msg"]);
  if (typeof detail["message"] === "string") return String(detail["message"]);

  return JSON.stringify(detail);
}

/**
 * Texto en español para el cerebro (hook de OpenClaw).
 * Ej: `[ALERTA crítica] demo/mod-2 ec-01: valor imposible 14.2 (rango 0-10)`
 */
export function formatHookMessage(alert: Alert): string {
  const label = SEVERITY_LABEL[alert.severity] ?? alert.severity;
  const location = `${alert.tenant}/${alert.module}`;
  const nameEs = NAME_ES[alert.name] ?? alert.name.replace(/_/g, " ");
  const detailText = formatDetail(alert.detail);

  if (alert.device) {
    if (detailText) {
      return `[ALERTA ${label}] ${location} ${alert.device}: ${nameEs} ${detailText}`;
    }
    return `[ALERTA ${label}] ${location} ${alert.device}: ${nameEs}`;
  }

  if (detailText) {
    return `[ALERTA ${label}] ${location}: ${nameEs} ${detailText}`;
  }
  return `[ALERTA ${label}] ${location}: ${nameEs}`;
}

// ---------------------------------------------------------------------------
// Eventos del portero (Fase 3) — políticas / acciones / órdenes
// ---------------------------------------------------------------------------

export type PolicyEventKind =
  | "proposal_pending"
  | "action_executed"
  | "work_order_created"
  | "needs_data";

export type PolicyEvent = {
  kind: PolicyEventKind;
  tenant: string;
  module: string;
  message: string;
};

const POLICY_KIND_PREFIX: Record<PolicyEventKind, string> = {
  proposal_pending: "🔐 Aprobación pendiente",
  action_executed: "✅ Acción ejecutada",
  work_order_created: "📋 Orden de trabajo",
  needs_data: "📉 Confianza insuficiente",
};

export const VALID_POLICY_KINDS: readonly PolicyEventKind[] = [
  "proposal_pending",
  "action_executed",
  "work_order_created",
  "needs_data",
] as const;

/** Mensaje en español para el orquestador (hook OpenClaw, agentId main). */
export function formatPolicyEvent(event: PolicyEvent): string {
  const prefix = POLICY_KIND_PREFIX[event.kind] ?? event.kind;
  const location = `${event.tenant}/${event.module}`;
  return `${prefix} [${location}] ${event.message}`;
}

/**
 * Eventos del portero son raros y load-bearing — siempre se reenvían.
 * Sin throttle ni filtrado (contrario a las alertas de sensores).
 */
export function shouldForwardPolicyEvent(_event: PolicyEvent): boolean {
  return true;
}

/**
 * Valida el body JSON de POST /policy-event.
 * Mensajes alineados con la respuesta HTTP 400 {error} del bridge.
 */
export function parsePolicyEventBody(
  body: unknown,
): { ok: true; event: PolicyEvent } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body inválido" };
  }
  const obj = body as Record<string, unknown>;
  const kind = obj.kind;
  const tenant = obj.tenant;
  const mod = obj.module;
  const message = obj.message;
  if (typeof kind !== "string" || !(kind in POLICY_KIND_PREFIX)) {
    return { ok: false, error: "kind desconocido" };
  }
  if (typeof tenant !== "string" || !tenant.trim() || typeof mod !== "string" || !mod.trim()) {
    return { ok: false, error: "tenant y module requeridos" };
  }
  if (typeof message !== "string" || !message.trim()) {
    return { ok: false, error: "message vacío" };
  }
  return {
    ok: true,
    event: {
      kind: kind as PolicyEventKind,
      tenant: tenant.trim(),
      module: mod.trim(),
      message: message.trim(),
    },
  };
}
