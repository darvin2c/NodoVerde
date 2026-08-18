// Routing puro del bridge (ADR-0019) — sin I/O.
// Decide a QUÉ agente de OpenClaw va cada alerta/reporte.

/**
 * Convención de nombres (ADR-0019):
 * - crop_profiles.name = "<especie>" o "<especie>_<variedad>" (lechuga, lechuga_romana)
 * - agente experto    = "experto-<especie>" (experto-lechuga)
 * La variedad NO tiene experto propio: la expertise es de la especie.
 */
export function expertAgentId(crop: string | null | undefined): string | null {
  if (!crop) return null;
  const normalized = crop.trim().toLowerCase();
  if (!normalized) return null;
  const species = normalized.split(/[\s_]+/)[0];
  if (!/^[a-z0-9-]+$/.test(species)) return null;
  return `experto-${species}`;
}

/**
 * Cadena de destino para una alerta de un módulo:
 * primero el experto de la especie; si el hook lo rechaza (agente inexistente),
 * el caller cae al orquestador. Sin cultivo conocido → solo orquestador.
 */
export function targetAgents(crop: string | null | undefined): string[] {
  const expert = expertAgentId(crop);
  return expert ? [expert, "main"] : ["main"];
}

/**
 * Extrae el texto del payload que OpenClaw POSTea al webhook de una automation
 * terminada. Defensivo: la forma exacta puede variar entre versiones.
 * Devuelve null si no hay texto útil o si es un NO_REPLY (silencio explícito).
 */
export function extractExpertReport(payload: unknown): string | null {
  let candidate: unknown = payload;
  if (typeof payload === "object" && payload !== null) {
    const obj = payload as Record<string, unknown>;
    candidate =
      obj.text ?? obj.message ?? obj.result ?? obj.output ??
      (typeof obj.data === "object" && obj.data !== null
        ? (obj.data as Record<string, unknown>).text ?? (obj.data as Record<string, unknown>).message
        : undefined) ??
      obj.summary;
  }
  if (typeof candidate !== "string") return null;
  const text = candidate.trim();
  if (!text) return null;
  if (/^no[_-]?reply$/i.test(text)) return null;
  return text.slice(0, 4000);
}
