import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ParseResult = {
  counts: Map<string, Usage>;
  brokenLines: number;
  filesRead: number;
  totalLines: number;
};

/**
 * Extrae timestamp ms desde un objeto línea.
 * Intenta varios campos; si es número <1e12 lo trata como segundos.
 */
export function extractTimestamp(obj: Record<string, unknown>): number | null {
  const candidates = [
    obj.timestamp,
    obj.ts,
    obj.time,
    obj.created_at,
    obj.createdAt,
    obj._ts,
    obj.date,
    obj.datetime,
    (obj as Record<string, unknown>).created,
  ];
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      // heuristic: sec vs ms
      if (v < 1e12) return Math.round(v * 1000);
      return Math.round(v);
    }
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) continue;
      // try numeric string
      const n = Number(s);
      if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s)) {
        if (n < 1e12) return Math.round(n * 1000);
        return Math.round(n);
      }
      const parsed = Date.parse(s);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function toFiniteNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * Extrae usage {input,output,cacheRead,cacheWrite} de la línea.
 * Soporta camelCase y snake_case.
 */
export function extractUsage(obj: Record<string, unknown>): Usage | null {
  const raw = (obj as Record<string, unknown>).usage;
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  // need at least one numeric field?
  const hasAny =
    "input" in u || "output" in u || "cacheRead" in u || "cacheWrite" in u || "cache_read" in u || "cache_write" in u || "cacheReadTokens" in u;
  if (!hasAny) return null;
  const input = toFiniteNumber(u.input ?? u.input_tokens ?? u.inputTokens);
  const output = toFiniteNumber(u.output ?? u.output_tokens ?? u.outputTokens);
  const cacheRead = toFiniteNumber(u.cacheRead ?? (u as Record<string, unknown>).cache_read ?? (u as Record<string, unknown>).cacheReadTokens ?? (u as Record<string, unknown>).cachedRead);
  const cacheWrite = toFiniteNumber(u.cacheWrite ?? (u as Record<string, unknown>).cache_write ?? (u as Record<string, unknown>).cacheWriteTokens ?? (u as Record<string, unknown>).cachedWrite);
  // if all zero and no explicit fields, treat as no usage? But if input/output explicit zero, still valid.
  // We consider null only if object empty; otherwise return zeros allowed.
  return { input, output, cacheRead, cacheWrite };
}

export function extractModel(obj: Record<string, unknown>): string {
  const v = obj.model ?? obj.model_name ?? obj.modelName;
  if (typeof v === "string" && v.trim()) return v.trim();
  return "unknown";
}

export function getTargetDate(runAt: Date): string {
  // día UTC anterior a la corrida
  const d = new Date(runAt);
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isTargetDay(tsMs: number, targetDate: string): boolean {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const ds = `${y}-${m}-${day}`;
  return ds === targetDate;
}

function addUsage(map: Map<string, Usage>, model: string, u: Usage): void {
  const prev = map.get(model);
  if (!prev) {
    map.set(model, { ...u });
  } else {
    prev.input += u.input;
    prev.output += u.output;
    prev.cacheRead += u.cacheRead;
    prev.cacheWrite += u.cacheWrite;
  }
}

async function listSessionFiles(openclawPath: string): Promise<string[]> {
  const out: string[] = [];
  const agentsRoot = join(openclawPath, "agents");
  let agentDirs: string[] = [];
  try {
    agentDirs = await readdir(agentsRoot);
  } catch {
    return [];
  }
  for (const agent of agentDirs) {
    const sessionsDir = join(agentsRoot, agent, "sessions");
    let files: string[] = [];
    try {
      files = await readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      if (f.endsWith(".trajectory.jsonl")) continue;
      out.push(join(sessionsDir, f));
    }
  }
  return out;
}

export async function parseSessions(openclawPath: string, targetDate: string): Promise<ParseResult> {
  const counts = new Map<string, Usage>();
  let brokenLines = 0;
  let totalLines = 0;
  let filesRead = 0;
  if (!openclawPath) {
    return { counts, brokenLines, filesRead, totalLines };
  }
  const files = await listSessionFiles(openclawPath);
  for (const file of files) {
    let content: string;
    try {
      // verify file exists
      const s = await stat(file);
      if (!s.isFile()) continue;
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    filesRead += 1;
    const lines = content.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      totalLines += 1;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        brokenLines += 1;
        continue;
      }
      const usage = extractUsage(obj);
      if (!usage) continue;
      const tsMs = extractTimestamp(obj);
      if (tsMs === null) continue;
      if (!isTargetDay(tsMs, targetDate)) continue;
      const model = extractModel(obj);
      addUsage(counts, model, usage);
    }
  }
  return { counts, brokenLines, filesRead, totalLines };
}

/** Helpers puros para tests: parsear líneas en memoria sin FS */
export function parseLines(lines: string[], targetDate: string): ParseResult {
  const counts = new Map<string, Usage>();
  let brokenLines = 0;
  let totalLines = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    totalLines += 1;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      brokenLines += 1;
      continue;
    }
    const usage = extractUsage(obj);
    if (!usage) continue;
    const tsMs = extractTimestamp(obj);
    if (tsMs === null) continue;
    if (!isTargetDay(tsMs, targetDate)) continue;
    const model = extractModel(obj);
    addUsage(counts, model, usage);
  }
  return { counts, brokenLines, filesRead: 0, totalLines };
}
