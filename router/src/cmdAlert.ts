// Helpers para alerta cmd_sin_policy — ADR-0021 Fase 4
// Extraído a módulo propio para testabilidad sin side-effects de MQTT.

export const ALERT_RATE_LIMIT_MS = 60_000;

const VALID_ACTIONS: Record<string, true> = { start: true, stop: true, set: true };

/** Mapa en memoria para rate-limit por (topic, reason) */
export const alertRateLimit = new Map<string, number>();

function getKey(topic: string, reason: string): string {
  return `${topic}\x00${reason}`;
}

export function isRateLimited(topic: string, reason: string, nowMs: number = Date.now()): boolean {
  const last = alertRateLimit.get(getKey(topic, reason));
  if (last === undefined) return false;
  return nowMs - last < ALERT_RATE_LIMIT_MS;
}

export function markAlertPublished(topic: string, reason: string, nowMs: number = Date.now()): void {
  alertRateLimit.set(getKey(topic, reason), nowMs);
}

export function clearAlertRateLimit(): void {
  alertRateLimit.clear();
}

export type CmdSinPolicyReason = "missing_policy_id" | "invalid_payload";

/**
 * Clasifica el reason de descarte por payload Cmd inválido.
 * Regla ADR-0021:
 *  - JSON.parse manual; si parsea objeto con action válida (start|stop|set)
 *    pero sin policy_id string no vacío → 'missing_policy_id'
 *  - resto (JSON roto, no objeto, action inválida, etc.) → 'invalid_payload'
 */
export function classifyCmdReason(
  raw: Buffer | string | Uint8Array | null | undefined,
): CmdSinPolicyReason {
  if (raw == null) return "invalid_payload";
  let str: string;
  if (Buffer.isBuffer(raw)) str = raw.toString("utf8");
  else if (raw instanceof Uint8Array) str = Buffer.from(raw).toString("utf8");
  else if (typeof raw === "string") str = raw;
  else return "invalid_payload";

  if (!str.trim()) return "invalid_payload";

  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch {
    return "invalid_payload";
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "invalid_payload";
  }
  const obj = parsed as Record<string, unknown>;
  const action = obj["action"];
  if (typeof action !== "string" || !VALID_ACTIONS[action]) {
    return "invalid_payload";
  }
  const policy_id = obj["policy_id"];
  if (typeof policy_id !== "string" || policy_id.trim() === "") {
    return "missing_policy_id";
  }
  // Si llegó hasta aquí, el payload sería válido (no debería entrar en descarte),
  // pero por contrato lo tratamos como invalid_payload si se llama por error.
  // También cubre casos de params inválido: parseCmdPayload rechazaría,
  // pero classify consideraría invalid_payload (no missing).
  // Para no enmascarar, devolvemos invalid_payload como fallback.
  // Nota: si params es inválido y policy_id válido, debería ser invalid_payload.
  // Lo detectamos aquí solo si fuese llamado, pero no es missing.
  return "invalid_payload";
}

export function buildAlertTopic(tenant: string, mod: string): string {
  return `terra/${tenant}/${mod}/alert`;
}

export interface CmdSinPolicyAlertPayload {
  name: "cmd_sin_policy";
  ts: number;
  severity: "critical";
  device: string;
  detail: {
    topic: string;
    reason: CmdSinPolicyReason;
    state: "pending";
  };
}

export function buildAlertPayload(
  device: string,
  topic: string,
  reason: CmdSinPolicyReason,
  nowMs: number = Date.now(),
): CmdSinPolicyAlertPayload {
  return {
    name: "cmd_sin_policy",
    ts: nowMs,
    severity: "critical",
    device,
    detail: { topic, reason, state: "pending" },
  };
}
