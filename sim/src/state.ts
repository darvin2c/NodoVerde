import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ModuleState } from "./model.js";

export type PersistedState = {
  simMs: number;
  startMs?: number; // origen del replay de clima; estados viejos sin él → cae a simMs
  seed: number;
  speed: number;
  modules: ModuleState[];
  scenario: string;
};

function statePath(): string {
  const candidates = [
    resolve(process.cwd(), "data/sim-state.json"),
    resolve(process.cwd(), "sim/data/sim-state.json"),
  ];
  // prefer existing dir, else first
  for (const c of candidates) {
    if (existsSync(dirname(c))) return c;
  }
  return candidates[0];
}

export function saveState(state: PersistedState, customPath?: string): void {
  const p = customPath ?? statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

export function loadState(customPath?: string): PersistedState | null {
  const p = customPath ?? statePath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
}

export function statePathForTest(tmpDir: string): string {
  return resolve(tmpDir, "sim-state.json");
}
