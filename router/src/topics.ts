// Helpers puros de parseo/construcción de ambos planos MQTT (ADR-0015).
// Dos planos distinguibles por número de segmentos:
//  - Dispositivo (5 seg): terra/{hw_id}/{device}/{metric}/reading|event
//                         terra/{hw_id}/{device}/status/status
//                         terra/{hw_id}/{device}/confidence/confidence
//                         terra/{hw_id}/{device}/request/{action}
//  - Interno (6 seg):     terra/{tenant}/{module}/{device}/{metric}/reading|event
//                         terra/{tenant}/{module}/{device}/status/status
//                         terra/{tenant}/{module}/{device}/confidence/confidence
//                         terra/{tenant}/{module}/{device}/request/{action}
//                         terra/{tenant}/{module}/{device}/cmd

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

/** hw_id = 12 hex minúsculas (MAC sin dos puntos) */
export const HW_ID_RE = /^[0-9a-f]{12}$/;

export function isValidHwId(hwId: string): boolean {
  return HW_ID_RE.test(hwId);
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type Kind = "reading" | "event" | "status" | "confidence" | "request" | "cmd";

export type DeviceParsed =
  | { plane: "device"; hwId: string; device: string; metric: string; kind: "reading" | "event" }
  | { plane: "device"; hwId: string; device: string; kind: "status" }
  | { plane: "device"; hwId: string; device: string; kind: "confidence" }
  | { plane: "device"; hwId: string; device: string; action: string; kind: "request" };

export type InternalParsed =
  | { plane: "internal"; tenant: string; module: string; device: string; metric: string; kind: "reading" | "event" }
  | { plane: "internal"; tenant: string; module: string; device: string; kind: "status" }
  | { plane: "internal"; tenant: string; module: string; device: string; kind: "confidence" }
  | { plane: "internal"; tenant: string; module: string; device: string; action: string; kind: "request" }
  | { plane: "internal"; tenant: string; module: string; device: string; kind: "cmd" };

export type Parsed = DeviceParsed | InternalParsed;

// ---------------------------------------------------------------------------
// Builders — plano dispositivo (5 segmentos)
// ---------------------------------------------------------------------------

export function buildDeviceReadingTopic(hwId: string, device: string, metric: string): string {
  return `terra/${hwId}/${device}/${metric}/reading`;
}

export function buildDeviceEventTopic(hwId: string, device: string, metric: string): string {
  return `terra/${hwId}/${device}/${metric}/event`;
}

export function buildDeviceStatusTopic(hwId: string, device: string): string {
  return `terra/${hwId}/${device}/status/status`;
}

export function buildDeviceConfidenceTopic(hwId: string, device: string): string {
  return `terra/${hwId}/${device}/confidence/confidence`;
}

export function buildDeviceRequestTopic(hwId: string, device: string, action: string): string {
  return `terra/${hwId}/${device}/request/${action}`;
}

// ---------------------------------------------------------------------------
// Builders — plano interno (6 segmentos)
// ---------------------------------------------------------------------------

export function buildInternalReadingTopic(tenant: string, mod: string, device: string, metric: string): string {
  return `terra/${tenant}/${mod}/${device}/${metric}/reading`;
}

export function buildInternalEventTopic(tenant: string, mod: string, device: string, metric: string): string {
  return `terra/${tenant}/${mod}/${device}/${metric}/event`;
}

export function buildInternalStatusTopic(tenant: string, mod: string, device: string): string {
  return `terra/${tenant}/${mod}/${device}/status/status`;
}

export function buildInternalConfidenceTopic(tenant: string, mod: string, device: string): string {
  return `terra/${tenant}/${mod}/${device}/confidence/confidence`;
}

export function buildInternalRequestTopic(tenant: string, mod: string, device: string, action: string): string {
  return `terra/${tenant}/${mod}/${device}/request/${action}`;
}

export function buildInternalCmdTopic(tenant: string, mod: string, device: string): string {
  return `terra/${tenant}/${mod}/${device}/cmd`;
}

// ---------------------------------------------------------------------------
// Clasificador de kind por segmentos
// ---------------------------------------------------------------------------

/** Devuelve el kind (reading, event, status, confidence, request, cmd) según el topic. */
export function getKind(topic: string): Kind | null {
  const parts = topic.split("/");
  if (parts[0] !== "terra") return null;
  const segCount = parts.length;
  const last = parts[segCount - 1];
  const secondLast = parts[segCount - 2];

  // Dispositivo (5 seg): terra/hw_id/device/xxx/yyy
  // También cubre interno cmd (terra/tenant/module/device/cmd) que comparte 5 seg; distinguir por kind.
  if (segCount === 5) {
    if (parts[3] === "request") return "request";
    if (last === "cmd") return "cmd";
    if (last === "reading") return "reading";
    if (last === "event") return "event";
    if (last === "status" && secondLast === "status") return "status";
    if (last === "confidence" && secondLast === "confidence") return "confidence";
    return null;
  }

  // Interno (6 seg): terra/tenant/module/device/xxx/yyy
  if (segCount === 6) {
    if (parts[4] === "request") return "request";
    if (last === "reading") return "reading";
    if (last === "event") return "event";
    if (last === "status" && secondLast === "status") return "status";
    if (last === "confidence" && secondLast === "confidence") return "confidence";
    return null;
  }

  return null;
}

/** Retorna true si el topic parece del plano dispositivo (5 seg con hw_id válido). */
export function isDeviceTopic(topic: string): boolean {
  const parsed = parseDeviceTopic(topic);
  return parsed !== null;
}

/** Retorna true si el topic parece del plano interno (6 seg, o 5 seg cmd). */
export function isInternalTopic(topic: string): boolean {
  const parsed = parseInternalTopic(topic);
  return parsed !== null;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parsea un topic del plano dispositivo (5 segmentos).
 * Retorna null si no coincide con el contrato.
 */
export function parseDeviceTopic(topic: string): DeviceParsed | null {
  const parts = topic.split("/");
  if (parts.length !== 5) return null;
  if (parts[0] !== "terra") return null;

  const hwId = parts[1];
  if (!isValidHwId(hwId)) return null;

  const device = parts[2];
  if (!device) return null;

  // request: terra/{hw_id}/{device}/request/{action}
  if (parts[3] === "request") {
    const action = parts[4];
    if (!action) return null;
    return { plane: "device", hwId, device, action, kind: "request" };
  }

  // status: terra/{hw_id}/{device}/status/status
  if (parts[3] === "status" && parts[4] === "status") {
    return { plane: "device", hwId, device, kind: "status" };
  }

  // confidence: terra/{hw_id}/{device}/confidence/confidence
  if (parts[3] === "confidence" && parts[4] === "confidence") {
    return { plane: "device", hwId, device, kind: "confidence" };
  }

  // reading/event: terra/{hw_id}/{device}/{metric}/reading|event
  const metric = parts[3];
  const kind = parts[4];
  if ((kind === "reading" || kind === "event") && metric) {
    return { plane: "device", hwId, device, metric, kind };
  }

  return null;
}

/**
 * Parsea un topic del plano interno (6 segmentos + cmd 5 seg).
 * Retorna null si no coincide.
 */
export function parseInternalTopic(topic: string): InternalParsed | null {
  const parts = topic.split("/");

  // Plano interno 6 segmentos
  if (parts.length === 6) {
    if (parts[0] !== "terra") return null;
    const tenant = parts[1];
    const mod = parts[2];
    const device = parts[3];
    if (!tenant || !mod || !device) return null;

    // request: terra/{tenant}/{module}/{device}/request/{action}
    if (parts[4] === "request") {
      const action = parts[5];
      if (!action) return null;
      return { plane: "internal", tenant, module: mod, device, action, kind: "request" };
    }

    // status/confidence en 6 seg: terra/{tenant}/{module}/{device}/status/status
    if (parts[4] === "status" && parts[5] === "status") {
      return { plane: "internal", tenant, module: mod, device, kind: "status" };
    }
    if (parts[4] === "confidence" && parts[5] === "confidence") {
      return { plane: "internal", tenant, module: mod, device, kind: "confidence" };
    }

    // reading/event: terra/{tenant}/{module}/{device}/{metric}/reading|event
    const metric = parts[4];
    const kind = parts[5];
    if ((kind === "reading" || kind === "event") && metric) {
      return { plane: "internal", tenant, module: mod, device, metric, kind };
    }

    return null;
  }

  // Plano interno cmd — 5 segmentos: terra/{tenant}/{module}/{device}/cmd
  if (parts.length === 5) {
    if (parts[0] !== "terra") return null;
    if (parts[4] !== "cmd") return null;
    const tenant = parts[1];
    const mod = parts[2];
    const device = parts[3];
    if (!tenant || !mod || !device) return null;
    // Si parts[1] es hw_id, esto podría parecer device topic pero parseDeviceTopic ya habría
    // requerido estructura de device (request/status/etc). Como cmd no existe en dispositivo, es seguro.
    return { plane: "internal", tenant, module: mod, device, kind: "cmd" };
  }

  return null;
}

/** Parser general: intenta ambos planos, retorna Parsed o null. */
export function parseTopic(topic: string): Parsed | null {
  return parseDeviceTopic(topic) ?? parseInternalTopic(topic);
}

// ---------------------------------------------------------------------------
// Mapeo entre planos
// ---------------------------------------------------------------------------

/**
 * Traduce un topic del plano dispositivo a plano interno.
 * @param deviceTopic - topic de 5 segmentos (hw_id)
 * @param tenant - tenant resuelto
 * @param mod - módulo resuelto
 * @returns topic interno de 6 segmentos, o null si el deviceTopic no es válido
 */
export function deviceToInternalTopic(deviceTopic: string, tenant: string, mod: string): string | null {
  const parsed = parseDeviceTopic(deviceTopic);
  if (!parsed) return null;

  if (parsed.kind === "reading" || parsed.kind === "event") {
    const metric = (parsed as { metric: string }).metric;
    if (parsed.kind === "reading") return buildInternalReadingTopic(tenant, mod, parsed.device, metric);
    return buildInternalEventTopic(tenant, mod, parsed.device, metric);
  }
  if (parsed.kind === "status") {
    return buildInternalStatusTopic(tenant, mod, parsed.device);
  }
  if (parsed.kind === "confidence") {
    return buildInternalConfidenceTopic(tenant, mod, parsed.device);
  }
  if (parsed.kind === "request") {
    // Aunque el fierro escucha request, este camino es raro device→interno, pero lo soportamos.
    return buildInternalRequestTopic(tenant, mod, parsed.device, parsed.action);
  }
  return null;
}

/**
 * Traduce un topic del plano interno a plano dispositivo.
 * @param internalTopic - topic de 6 segmentos (tenant/module)
 * @param hwId - hw_id resuelto
 * @returns topic dispositivo de 5 segmentos, o null si no se puede traducir
 */
export function internalToDeviceTopic(internalTopic: string, hwId: string): string | null {
  const parsed = parseInternalTopic(internalTopic);
  if (!parsed) return null;

  if (parsed.kind === "reading" || parsed.kind === "event") {
    const metric = (parsed as { metric: string }).metric;
    if (parsed.kind === "reading") return buildDeviceReadingTopic(hwId, parsed.device, metric);
    return buildDeviceEventTopic(hwId, parsed.device, metric);
  }
  if (parsed.kind === "status") {
    return buildDeviceStatusTopic(hwId, parsed.device);
  }
  if (parsed.kind === "confidence") {
    return buildDeviceConfidenceTopic(hwId, parsed.device);
  }
  if (parsed.kind === "request") {
    return buildDeviceRequestTopic(hwId, parsed.device, parsed.action);
  }
  if (parsed.kind === "cmd") {
    // cmd interno no tiene equivalente en dispositivo; el dispositivo escucha request/set
    // Para reenvío, mapear cmd → request/set sería policy-dependiente; no lo traducimos.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers de retain / QoS por kind (ADR-0015, contract v0.4.0)
// ---------------------------------------------------------------------------

/**
 * Determina si un topic interno debe publicarse retenido.
 * Regla: status siempre retenido; readings de switches retenidos; resto no.
 * Se decide por el kind y metric del topic parseado.
 */
export function shouldRetain(topic: string): boolean {
  const parsed = parseInternalTopic(topic) ?? parseDeviceTopic(topic);
  if (!parsed) return false;
  if (parsed.kind === "status") return true;
  if (parsed.kind === "reading") {
    const metric = (parsed as { metric?: string }).metric;
    if (metric === "switch") return true;
  }
  // confidence, event, request, cmd → no retain
  return false;
}

/**
 * Determina QoS sugerido según kind.
 * Lecturas de sensores se mantienen en qos0 (el sim hoy usa qos0); resto qos1.
 * El router republica preservando qos original por kind cuando es posible.
 */
export function qosForKind(kind: Kind, metric?: string): 0 | 1 {
  if (kind === "reading" && metric !== "switch") return 0;
  return 1;
}
