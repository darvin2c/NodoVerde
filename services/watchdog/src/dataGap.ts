// decideGap — helper puro para alerta data_gap (Fase 4, ADR-0021).
// Sin I/O, 100% testeable. No tumba el proceso por input malformado (parse defensivo).

export type DataGapDetail = {
  from_ms: number;
  to_ms: number;
  duration_min: number;
};

export type DecideGapResult =
  | { shouldAlert: true; detail: DataGapDetail }
  | { shouldAlert: false; detail?: undefined };

/**
 * Decide si hay que publicar data_gap.
 * @param maxTs - max(time) de telemetry en epoch_ms, o null si nunca hubo telemetría
 * @param nowMs - Date.now() inyectable
 * @param minMs - GAP_MIN_MS (default 600000) — gap strictly > min triggers alert
 */
export function decideGap(
  maxTs: number | null | undefined,
  nowMs: number,
  minMs: number,
): DecideGapResult {
  if (maxTs === null || maxTs === undefined) return { shouldAlert: false };
  if (typeof maxTs !== "number" || !Number.isFinite(maxTs)) return { shouldAlert: false };
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return { shouldAlert: false };
  if (typeof minMs !== "number" || !Number.isFinite(minMs)) return { shouldAlert: false };

  const gap = nowMs - maxTs;
  // gap negativo (reloj atrás) o cero -> no alerta
  if (gap <= minMs) return { shouldAlert: false };

  const duration_min = Math.round(gap / 60000);
  return {
    shouldAlert: true,
    detail: { from_ms: maxTs, to_ms: nowMs, duration_min },
  };
}

export function parseGapMinMs(envVal: string | undefined, fallback = 600000): number {
  if (!envVal) return fallback;
  const n = parseInt(envVal, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
