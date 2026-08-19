// Decisión y utilidades puras de catch-up (ADR-0021)
// Usadas por engine.ts y por tests. Parse defensivo: nunca tumbar.

export const DEFAULT_CATCHUP_MIN_SIM_MS = 300_000; // 5 min sim
export const DEFAULT_CATCHUP_MAX_STEPS = 604_800; // 7 días sim a 1s/step

function parsePositiveInt(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return n;
}

export function getCatchUpConfig(): { minSimMs: number; maxSteps: number } {
  return {
    minSimMs: parsePositiveInt(process.env.CATCHUP_MIN_SIM_MS, DEFAULT_CATCHUP_MIN_SIM_MS),
    maxSteps: parsePositiveInt(process.env.CATCHUP_MAX_STEPS, DEFAULT_CATCHUP_MAX_STEPS),
  };
}

export function computeGapSimMs(
  savedAtMs: number | undefined,
  nowMs: number,
  speed: number,
): number | null {
  if (savedAtMs == null || !Number.isFinite(savedAtMs)) return null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(speed) || speed <= 0) return null;
  const gapReal = nowMs - savedAtMs;
  if (gapReal <= 0) return 0;
  return gapReal * speed;
}

export function shouldCatchUp(gapSimMs: number | null, minSimMs: number): boolean {
  if (gapSimMs == null) return false;
  return gapSimMs > minSimMs;
}

export function catchUpPlan(
  gapSimMs: number,
  maxSteps: number,
): { steps: number; truncated: boolean } {
  const needed = Math.ceil(gapSimMs / 1000);
  if (needed > maxSteps) return { steps: maxSteps, truncated: true };
  return { steps: needed, truncated: false };
}

export function decideCatchUp(opts: {
  savedAtMs?: number;
  nowMs: number;
  speed: number;
  minSimMs?: number;
  maxSteps?: number;
}): { should: boolean; gapSimMs: number | null; steps: number; truncated: boolean } {
  const minSimMs = opts.minSimMs ?? getCatchUpConfig().minSimMs;
  const maxSteps = opts.maxSteps ?? getCatchUpConfig().maxSteps;
  const gapSimMs = computeGapSimMs(opts.savedAtMs, opts.nowMs, opts.speed);
  if (!shouldCatchUp(gapSimMs, minSimMs)) {
    return { should: false, gapSimMs, steps: 0, truncated: false };
  }
  const { steps, truncated } = catchUpPlan(gapSimMs!, maxSteps);
  return { should: true, gapSimMs, steps, truncated };
}
