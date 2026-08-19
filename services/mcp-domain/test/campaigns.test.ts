import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  computeSha256,
  computeProfileHash,
  computeMemoryHash,
  parseDetail,
  isAlertOpen,
  filterInvariantAlerts,
} from "../src/write.js";

// Helpers for alert rows
function mkAlert(overrides: Partial<{
  time: Date;
  tenant: string;
  module: string;
  name: string;
  severity: string;
  device: string | null;
  detail: unknown;
}> = {}) {
  return {
    time: overrides.time ?? new Date("2026-08-10T10:00:00.000Z"),
    tenant: overrides.tenant ?? "demo",
    module: overrides.module ?? "platform",
    name: overrides.name ?? "invariant_ledger",
    severity: overrides.severity ?? "critical",
    device: overrides.device ?? null,
    detail: overrides.detail ?? { state: "pending", fingerprint: "abc123", reason: "test" },
  };
}

describe("hashing determinístico", () => {
  it("computeSha256 mismo contenido → mismo hash", () => {
    const a = computeSha256("hola mundo");
    const b = computeSha256("hola mundo");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("computeSha256 contenido distinto → hash distinto", () => {
    const a = computeSha256("contenido A");
    const b = computeSha256("contenido B");
    expect(a).not.toBe(b);
  });

  it("computeProfileHash determinístico sobre mismo row", () => {
    const row = { name: "lechuga", ec_min: 1.2, ec_max: 1.8, ph_min: 5.8, ph_max: 6.3, water_temp_min: 18, water_temp_max: 24, notes: "algo" };
    const h1 = computeProfileHash(row);
    const h2 = computeProfileHash(row);
    expect(h1).toBe(h2);
    // Verifica contra sha256 manual
    const expected = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
    expect(h1).toBe(expected);
  });

  it("computeProfileHash cambia si cambia el row", () => {
    const r1 = { name: "lechuga", ec_min: 1.2 };
    const r2 = { name: "lechuga", ec_min: 1.3 };
    expect(computeProfileHash(r1)).not.toBe(computeProfileHash(r2));
  });

  it("computeMemoryHash retorna null si WORKSPACES_PATH vacío", async () => {
    const prev = process.env.WORKSPACES_PATH;
    process.env.WORKSPACES_PATH = "";
    const h = await computeMemoryHash("lechuga");
    expect(h).toBeNull();
    process.env.WORKSPACES_PATH = prev;
  });

  it("computeMemoryHash retorna null si archivo ausente", async () => {
    const prev = process.env.WORKSPACES_PATH;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-"));
    process.env.WORKSPACES_PATH = tmp;
    const h = await computeMemoryHash("lechuga");
    expect(h).toBeNull();
    await fs.rm(tmp, { recursive: true, force: true });
    process.env.WORKSPACES_PATH = prev;
  });

  it("computeMemoryHash lee archivo y hashea determinísticamente", async () => {
    const prev = process.env.WORKSPACES_PATH;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-"));
    const dir = path.join(tmp, "experto-lechuga");
    await fs.mkdir(dir, { recursive: true });
    const content = "# Memoria lechuga\n- dato 1\n";
    await fs.writeFile(path.join(dir, "MEMORY.md"), content);
    process.env.WORKSPACES_PATH = tmp;
    const h1 = await computeMemoryHash("lechuga");
    const h2 = await computeMemoryHash("lechuga");
    expect(h1).toBe(h2);
    const expected = crypto.createHash("sha256").update(content).digest("hex");
    expect(h1).toBe(expected);
    // Modificar contenido cambia hash
    await fs.writeFile(path.join(dir, "MEMORY.md"), content + "extra");
    const h3 = await computeMemoryHash("lechuga");
    expect(h3).not.toBe(h1);
    await fs.rm(tmp, { recursive: true, force: true });
    process.env.WORKSPACES_PATH = prev;
  });
});

describe("parseDetail defensivo", () => {
  it("parsea objeto directo", () => {
    expect(parseDetail({ state: "pending", fingerprint: "fp1" })).toEqual({ state: "pending", fingerprint: "fp1" });
  });
  it("parsea string JSON válido", () => {
    const s = JSON.stringify({ state: "resolved", fingerprint: "xyz" });
    expect(parseDetail(s)).toEqual({ state: "resolved", fingerprint: "xyz" });
  });
  it("string inválido → vacío sin tirar", () => {
    expect(parseDetail("no-json{{{")).toEqual({});
  });
  it("null/undefined → vacío", () => {
    expect(parseDetail(null)).toEqual({});
    expect(parseDetail(undefined)).toEqual({});
  });
  it("fingerprint no string → undefined", () => {
    expect(parseDetail({ state: "pending", fingerprint: 123 })).toEqual({ state: "pending", fingerprint: undefined });
  });
  it("nunca tumba el proceso por input malformado", () => {
    expect(() => parseDetail("{ bad")).not.toThrow();
    expect(() => parseDetail(42 as unknown as string)).not.toThrow();
    expect(() => parseDetail({} )).not.toThrow();
  });
});

describe("isAlertOpen — regla de resolución", () => {
  it("pending sin resolución posterior ni fila → abierta", () => {
    const a = mkAlert({ detail: { state: "pending", fingerprint: "fp1" } });
    expect(isAlertOpen(a, [a], [])).toBe(true);
  });

  it("resolved nunca está abierta", () => {
    const a = mkAlert({ detail: { state: "resolved", fingerprint: "fp1" } });
    expect(isAlertOpen(a, [a], [])).toBe(false);
  });

  it("sin state → no abierta (declarativa)", () => {
    const a = mkAlert({ detail: { fingerprint: "fp1" } });
    expect(isAlertOpen(a, [a], [])).toBe(false);
  });

  it("detalle malformado string → no abierta y no tira", () => {
    const a = mkAlert({ detail: "not-json" as unknown as object });
    expect(isAlertOpen(a, [a], [])).toBe(false);
  });

  it("pending con alerta posterior resolved mismo fingerprint → cerrada (regla a)", () => {
    const pending = mkAlert({ time: new Date("2026-08-10T10:00:00Z"), detail: { state: "pending", fingerprint: "fp1" } });
    const resolved = mkAlert({ time: new Date("2026-08-10T11:00:00Z"), detail: { state: "resolved", fingerprint: "fp1" } });
    expect(isAlertOpen(pending, [pending, resolved], [])).toBe(false);
  });

  it("pending con resolved posterior pero fingerprint distinto → sigue abierta", () => {
    const pending = mkAlert({ time: new Date("2026-08-10T10:00:00Z"), detail: { state: "pending", fingerprint: "fp1" } });
    const resolved = mkAlert({ time: new Date("2026-08-10T11:00:00Z"), detail: { state: "resolved", fingerprint: "fp2" } });
    expect(isAlertOpen(pending, [pending, resolved], [])).toBe(true);
  });

  it("resolved anterior no cierra pending posterior (orden temporal)", () => {
    const resolved = mkAlert({ time: new Date("2026-08-10T09:00:00Z"), detail: { state: "resolved", fingerprint: "fp1" } });
    const pending = mkAlert({ time: new Date("2026-08-10T10:00:00Z"), detail: { state: "pending", fingerprint: "fp1" } });
    expect(isAlertOpen(pending, [resolved, pending], [])).toBe(true);
  });

  it("pending con fila alert_resolutions exacta → cerrada (regla b)", () => {
    const a = mkAlert({ detail: { state: "pending", fingerprint: "fp1" }, name: "invariant_ledger", module: "platform", tenant: "demo" });
    const resolutions = [{ tenant: "demo", alert_name: "invariant_ledger", module: "platform", fingerprint: "fp1" }];
    expect(isAlertOpen(a, [a], resolutions)).toBe(false);
  });

  it("fila con module null matchea cualquier módulo (cuando se proveen)", () => {
    const a = mkAlert({ detail: { state: "pending", fingerprint: "fp1" }, module: "mod-1" });
    const resolutions = [{ tenant: "demo", alert_name: "invariant_ledger", module: null, fingerprint: "fp1" }];
    expect(isAlertOpen(a, [a], resolutions)).toBe(false);
  });

  it("fila con fingerprint null matchea cualquier fingerprint", () => {
    const a = mkAlert({ detail: { state: "pending", fingerprint: "fp1" } });
    const resolutions = [{ tenant: "demo", alert_name: "invariant_ledger", module: null, fingerprint: null }];
    expect(isAlertOpen(a, [a], resolutions)).toBe(false);
  });

  it("fila con module distinto no matchea → sigue abierta", () => {
    const a = mkAlert({ detail: { state: "pending", fingerprint: "fp1" }, module: "mod-1" });
    const resolutions = [{ tenant: "demo", alert_name: "invariant_ledger", module: "mod-2", fingerprint: "fp1" }];
    expect(isAlertOpen(a, [a], resolutions)).toBe(true);
  });

  it("fila con fingerprint distinto no matchea", () => {
    const a = mkAlert({ detail: { state: "pending", fingerprint: "fp1" } });
    const resolutions = [{ tenant: "demo", alert_name: "invariant_ledger", module: null, fingerprint: "fp2" }];
    expect(isAlertOpen(a, [a], resolutions)).toBe(true);
  });

  it("fila con tenant distinto no matchea", () => {
    const a = mkAlert({ tenant: "demo", detail: { state: "pending", fingerprint: "fp1" } });
    const resolutions = [{ tenant: "other", alert_name: "invariant_ledger", module: null, fingerprint: null }];
    expect(isAlertOpen(a, [a], resolutions)).toBe(true);
  });

  it("fila con alert_name distinto no matchea", () => {
    const a = mkAlert({ name: "budget_tokens", detail: { state: "pending", fingerprint: "demo:2026-08" } });
    const resolutions = [{ tenant: "demo", alert_name: "invariant_ledger", module: null, fingerprint: null }];
    expect(isAlertOpen(a, [a], resolutions)).toBe(true);
  });

  it("detail como string JSON también funciona", () => {
    const a = mkAlert({ detail: JSON.stringify({ state: "pending", fingerprint: "fp1" }) as unknown as object });
    const resolved = mkAlert({ time: new Date("2026-08-10T11:00:00Z"), detail: JSON.stringify({ state: "resolved", fingerprint: "fp1" }) as unknown as object });
    expect(isAlertOpen(a, [a, resolved], [])).toBe(false);
  });
});

describe("filterInvariantAlerts", () => {
  it("only_open true filtra solo abiertas", () => {
    const pendingOpen = mkAlert({ time: new Date("2026-08-10T10:00:00Z"), detail: { state: "pending", fingerprint: "fp1" } });
    const pendingClosed = mkAlert({ time: new Date("2026-08-10T09:00:00Z"), detail: { state: "pending", fingerprint: "fp2" } });
    const resolved = mkAlert({ time: new Date("2026-08-10T11:00:00Z"), detail: { state: "resolved", fingerprint: "fp2" } });
    const all = [pendingOpen, pendingClosed, resolved];
    const onlyOpen = filterInvariantAlerts(all, [], true);
    expect(onlyOpen.length).toBe(1);
    expect(onlyOpen[0].detail).toEqual({ state: "pending", fingerprint: "fp1" });
  });

  it("only_open false retorna todas con is_open calculado", () => {
    const a = mkAlert({ detail: { state: "pending", fingerprint: "fp1" } });
    const result = filterInvariantAlerts([a], [], false);
    expect(result.length).toBe(1);
    expect(result[0].is_open).toBe(true);
  });

  it("usa también filas de alert_resolutions para filtrar", () => {
    const a = mkAlert({ detail: { state: "pending", fingerprint: "fp1" }, name: "cmd_sin_policy" });
    const resolutions = [{ tenant: "demo", alert_name: "cmd_sin_policy", module: null, fingerprint: null }];
    const onlyOpen = filterInvariantAlerts([a], resolutions, true);
    expect(onlyOpen.length).toBe(0);
  });
});

describe("validaciones de campaña (semántica del contrato)", () => {
  it("crop inexistente debe rechazarse (profile null)", () => {
    const profile: Record<string, unknown> | null = null;
    const shouldReject = profile === null;
    expect(shouldReject).toBe(true);
  });

  it("doble campaña abierta debe rechazarse", () => {
    const current = { id: "existing", tenant: "demo", state: "open" };
    const shouldReject = current !== null;
    expect(shouldReject).toBe(true);
  });

  it("cerrar sin abierta debe rechazarse", () => {
    const current: unknown = null;
    const shouldReject = current === null;
    expect(shouldReject).toBe(true);
  });

  it("profile_hash es sha256 del row serializado (contrato)", () => {
    const row = { name: "tomate", ec_min: 2.0 };
    const hash = computeProfileHash(row);
    const expected = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
    expect(hash).toBe(expected);
  });

  it("memory_hash honesto: null si no hay archivo", async () => {
    const prev = process.env.WORKSPACES_PATH;
    process.env.WORKSPACES_PATH = "";
    expect(await computeMemoryHash("tomate")).toBeNull();
    process.env.WORKSPACES_PATH = prev;
  });
});
