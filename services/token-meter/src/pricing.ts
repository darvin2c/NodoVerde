import type { Usage } from "./parser.js";

export type PriceEntry = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type PriceTable = Record<string, PriceEntry>;

export function parsePriceTable(raw: string): PriceTable {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: PriceTable = {};
    for (const [model, v] of Object.entries(parsed)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Record<string, unknown>;
      const input = toPriceNumber(e.input);
      const output = toPriceNumber(e.output);
      const cacheRead = toPriceNumber(e.cacheRead ?? e.cache_read ?? e.cacheReadTokens);
      const cacheWrite = toPriceNumber(e.cacheWrite ?? e.cache_write ?? e.cacheWriteTokens);
      // at least one price must be finite >0? otherwise skip empty
      if (input === null && output === null && cacheRead === null && cacheWrite === null) continue;
      out[model] = {
        input: input ?? 0,
        output: output ?? 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheWrite ?? 0,
      };
    }
    return out;
  } catch {
    console.warn("[token-meter] TOKEN_PRICE_TABLE JSON inválido, ignorado");
    return {};
  }
}

function toPriceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

export type CostResult = {
  costPerModel: Map<string, number>;
  totalCost: number;
  unknownModels: string[];
  knownCounts: Map<string, Usage>;
};

/**
 * Calcula costo por modelo y total.
 * Modelos sin precio van a unknownModels y no aportan al costo.
 */
export function computeCost(counts: Map<string, Usage>, priceTable: PriceTable): CostResult {
  const costPerModel = new Map<string, number>();
  const unknownModels: string[] = [];
  const knownCounts = new Map<string, Usage>();
  let totalCost = 0;
  for (const [model, usage] of counts.entries()) {
    const price = priceTable[model];
    if (!price) {
      unknownModels.push(model);
      continue;
    }
    const cost =
      (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) /
      1_000_000;
    // round to 6 decimals to avoid floating noise; amount final will be rounded later
    const rounded = Math.round(cost * 1_000_000) / 1_000_000;
    if (rounded > 0) {
      costPerModel.set(model, rounded);
      totalCost += rounded;
      knownCounts.set(model, usage);
    } else if (cost > 0) {
      // tiny cost still counts
      costPerModel.set(model, cost);
      totalCost += cost;
      knownCounts.set(model, usage);
    }
  }
  totalCost = Math.round(totalCost * 1_000_000) / 1_000_000;
  return { costPerModel, totalCost, unknownModels, knownCounts };
}

export function formatNote(counts: Map<string, Usage>, costPerModel: Map<string, number>): string {
  const parts: string[] = [];
  for (const [model, usage] of counts.entries()) {
    const cost = costPerModel.get(model);
    const costStr = cost !== undefined ? ` $${cost.toFixed(6)}` : "";
    parts.push(`${model}: in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}${costStr}`);
  }
  return `tokens ${parts.join(" | ")}`.slice(0, 800);
}
