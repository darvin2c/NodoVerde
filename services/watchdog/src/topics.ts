// Helpers puros de topics para watchdog — compatible con router/src/topics.ts (ADR-0015).
// Plano interno 6 segmentos: terra/{tenant}/{module}/{device}/{metric}/reading
//                           terra/{tenant}/{module}/{device}/status/status
// Plano plataforma 4 segmentos (Fase 1, ADR-0010/Watchdog):
//                           terra/{tenant}/{module}/health
//                           terra/{tenant}/{module}/alert

// ---------------------------------------------------------------------------
// Parsers — plano interno (6 seg)
// ---------------------------------------------------------------------------

export type ReadingParsed = {
  tenant: string;
  module: string;
  device: string;
  metric: string;
};

export type StatusParsed = {
  tenant: string;
  module: string;
  device: string;
};

/**
 * Parsea topic interno de reading: terra/{tenant}/{module}/{device}/{metric}/reading
 * Retorna null si no coincide.
 */
export function parseReadingTopic(topic: string): ReadingParsed | null {
  const parts = topic.split("/");
  if (parts.length !== 6) return null;
  if (parts[0] !== "terra") return null;
  if (parts[5] !== "reading") return null;
  const [_, tenant, mod, device, metric] = parts;
  if (!tenant || !mod || !device || !metric) return null;
  return { tenant, module: mod, device, metric };
}

/**
 * Parsea topic interno de status: terra/{tenant}/{module}/{device}/status/status
 * Retorna null si no coincide.
 */
export function parseStatusTopic(topic: string): StatusParsed | null {
  const parts = topic.split("/");
  if (parts.length !== 6) return null;
  if (parts[0] !== "terra") return null;
  if (parts[4] !== "status" || parts[5] !== "status") return null;
  const [_, tenant, mod, device] = parts;
  if (!tenant || !mod || !device) return null;
  return { tenant, module: mod, device };
}

/**
 * Parser general interno para reading/status.
 * Retorna el tipo de kind o null.
 */
export function parseInternalTopic(
  topic: string,
): ({ kind: "reading"; parsed: ReadingParsed } | { kind: "status"; parsed: StatusParsed }) | null {
  const r = parseReadingTopic(topic);
  if (r) return { kind: "reading", parsed: r };
  const s = parseStatusTopic(topic);
  if (s) return { kind: "status", parsed: s };
  return null;
}

// ---------------------------------------------------------------------------
// Builders — plano plataforma (4 segmentos)
// ---------------------------------------------------------------------------

/**
 * Construye topic de health: terra/{tenant}/{module}/health
 */
export function buildHealthTopic(tenant: string, mod: string): string {
  return `terra/${tenant}/${mod}/health`;
}

/**
 * Construye topic de alert: terra/{tenant}/{module}/alert
 */
export function buildAlertTopic(tenant: string, mod: string): string {
  return `terra/${tenant}/${mod}/alert`;
}

/**
 * Parsea topic de health (4 seg): terra/{tenant}/{module}/health
 */
export function parseHealthTopic(topic: string): { tenant: string; module: string } | null {
  const parts = topic.split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "terra") return null;
  if (parts[3] !== "health") return null;
  const [_, tenant, mod] = parts;
  if (!tenant || !mod) return null;
  return { tenant, module: mod };
}

/**
 * Parsea topic de alert (4 seg): terra/{tenant}/{module}/alert
 */
export function parseAlertTopic(topic: string): { tenant: string; module: string } | null {
  const parts = topic.split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "terra") return null;
  if (parts[3] !== "alert") return null;
  const [_, tenant, mod] = parts;
  if (!tenant || !mod) return null;
  return { tenant, module: mod };
}
