// Termómetro de confianza — cálculo determinístico (ADR-0010).
// NUNCA LLM. Toda variable lleva fuente, frescura y confianza.
// Fórmula: c = base × 0.5^(edad / semivida)

export type Source = "sensor" | "photo" | "human";

// Confianza base por fuente (ADR-0010 §1)
export const BASE_CONFIDENCE: Record<Source, number> = {
  sensor: 95,
  photo: 75,
  human: 65,
};

// Semividas por métrica (ms). Valores decididos en Context del ticket.
// - level: 10 min (el tanque cambia rápido)
// - ec/ph: 2 h (deriva lenta)
// - temp/air_temp/humidity: 30 min
// - flow: 5 min (se detiene al apagar bomba)
// - photo: 6 h (evidencia visual caduca en horas)
// Métrica desconocida → 1 h por defecto.
export const HALF_LIVES_MS: Record<string, number> = {
  ec: 2 * 60 * 60 * 1000,
  ph: 2 * 60 * 60 * 1000,
  temp: 30 * 60 * 1000,
  level: 10 * 60 * 1000,
  flow: 5 * 60 * 1000,
  air_temp: 30 * 60 * 1000,
  humidity: 30 * 60 * 1000,
  photo: 6 * 60 * 60 * 1000,
};

export const DEFAULT_HALF_LIFE_MS = 60 * 60 * 1000;

// Pesos para el promedio global por módulo (Context)
export const DEFAULT_WEIGHTS: Record<string, number> = {
  ec: 3,
  ph: 3,
  temp: 2,
  level: 2,
  flow: 1,
  air_temp: 1,
  humidity: 1,
  photo: 1,
};

// ---------------------------------------------------------------------------
// variableConfidence — confianza por variable individual
// ---------------------------------------------------------------------------

export interface VariableConfidenceOpts {
  source: Source;
  /** Confianza publicada por el dispositivo (sim) — si es menor que 95 la usamos como base. */
  baseOverride?: number;
  /** Epoch ms del último dato (payload ts). null = sin dato. */
  publishedAtMs: number | null | undefined;
  /** Epoch ms "ahora" — inyectado para determinismo en tests. */
  nowMs: number;
  /** Métrica para elegir semivida (ec, ph, temp, level, flow, air_temp, humidity, photo...) */
  metric: string;
}

/**
 * Confianza de una variable (0–100).
 * - Sin dato (publishedAtMs == null) → 0 explícito (ausencia ≠ cero).
 * - Base: sensor = min(95, baseOverride ?? 95), photo = 75, human = 65.
 * - Decaimiento exponencial: base × 0.5^(edad/semivida).
 * - Nunca >95 en sensores (los sensores mienten).
 * - Métrica desconocida → semivida default 1 h.
 * - Edad negativa (reloj adelantado) → 0 (trata como fresca).
 */
export function variableConfidence(opts: VariableConfidenceOpts): number {
  const { source, baseOverride, publishedAtMs, nowMs, metric } = opts;

  if (publishedAtMs == null) return 0;

  const ageMs = Math.max(0, nowMs - publishedAtMs);

  let base: number;
  if (source === "sensor") {
    const raw = baseOverride !== undefined ? Math.min(95, baseOverride) : 95;
    base = Math.max(0, Math.min(95, raw));
  } else if (source === "photo") {
    base = BASE_CONFIDENCE.photo;
  } else if (source === "human") {
    base = BASE_CONFIDENCE.human;
  } else {
    base = 0;
  }

  if (base === 0) return 0;

  const halfLife = HALF_LIVES_MS[metric] ?? DEFAULT_HALF_LIFE_MS;

  // Edad 0 → base; edad = semivida → base/2
  const decayed = base * Math.pow(0.5, ageMs / halfLife);

  // Sensores nunca >95 (ya capado) y nunca 100 global
  const clamped = Math.max(0, Math.min(95, decayed));

  // Redondeo a 1 decimal para estabilidad en el bus (mismo que global)
  return Math.round(clamped * 10) / 10;
}

// ---------------------------------------------------------------------------
// moduleConfidence — promedio ponderado global (0–100, 1 decimal)
// ---------------------------------------------------------------------------

export interface PerVariable {
  metric: string;
  value: number; // 0–100 (ya es salida de variableConfidence o 0 si sin dato)
}

/**
 * Promedio ponderado del módulo.
 * - Pesos default: ec 3, ph 3, temp 2, level 2, flow 1, air_temp 1, humidity 1, photo 1.
 * - Si weights se provee, se usa para las métricas presentes; métrica sin peso → 1.
 * - 0 si el arreglo está vacío o todas son 0.
 * - Redondeo a 1 decimal.
 */
export function moduleConfidence(
  perVariable: PerVariable[],
  weights: Record<string, number> = DEFAULT_WEIGHTS,
): number {
  if (!perVariable || perVariable.length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const { metric, value } of perVariable) {
    const w = weights[metric] ?? 1;
    // Incluir también valores 0: penalizan el promedio (ausencia arrastra).
    // Pero pesos de 0 no aportan; los ignoramos en denominador si no fueran deseados,
    // aquí sí los contamos porque el servicio siempre pasa las 8 métricas incluyendo ceros.
    const v = Math.max(0, Math.min(100, value));
    weightedSum += v * w;
    totalWeight += w;
  }

  if (totalWeight === 0) return 0;
  const avg = weightedSum / totalWeight;

  // Si todas son 0, avg ya es 0
  if (avg === 0) return 0;

  const rounded = Math.round(avg * 10) / 10;
  // Nunca 100 (sensores mienten) — cap a 95 si por redondeo llegara a 100,
  // pero mantenemos 95 como techo plausible del global.
  // El contrato pide "Nunca 100", no necesariamente cap a 95; pero cap a 99.9 evita 100 por flotante.
  if (rounded > 99.9) return 99.9;
  return rounded;
}
