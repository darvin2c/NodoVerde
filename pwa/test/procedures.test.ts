import { describe, it, expect, vi } from "vitest";
import { appRouter, shapeConfidence, shapeHealth } from "../server/trpc.js";

// Mock DB que responde a execute(sql)
function mockDb(rows: unknown[] = [], extra?: Record<string, unknown>) {
  return {
    execute: vi.fn().mockResolvedValue({ rows, ...extra })
  } as unknown as never;
}

function callerWith(db: unknown) {
  return appRouter.createCaller({ db: db as never });
}

describe("finance.monthSummary — movements vacíos", () => {
  it("retorna empty=true y ceros cuando no hay movimientos", async () => {
    const db = mockDb([{ ingresos: "0", gastos: "0", count: 0 }]);
    const caller = callerWith(db);
    const res = await caller.finance.monthSummary({ tenant: "demo" });
    expect(res.empty).toBe(true);
    expect(res.ingresos).toBe(0);
    expect(res.gastos).toBe(0);
    expect(res.balance).toBe(0);
    expect(res.count).toBe(0);
  });

  it("suma correctamente ingresos y gastos (aritmética en SQL simulada)", async () => {
    const db = mockDb([{ ingresos: "1200.50", gastos: "840.00", count: 5 }]);
    const caller = callerWith(db);
    const res = await caller.finance.monthSummary({ tenant: "demo", month: "2026-08" });
    expect(res.ingresos).toBe(1200.5);
    expect(res.gastos).toBe(840);
    expect(res.balance).toBe(360.5);
    expect(res.empty).toBe(false);
  });

  it("maneja error de DB con estado vacío honesto", async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as never;
    const caller = callerWith(db);
    const res = await caller.finance.monthSummary({ tenant: "demo" });
    expect(res.empty).toBe(true);
    expect(res.balance).toBe(0);
  });
});

describe("field.latest — telemetría", () => {
  it("agrupa latest_readings por módulo y métrica", async () => {
    const rows = [
      { module: "mod-1", device: "ec-01", metric: "ec", value: 1.45, time: "2026-08-16T10:00:00Z" },
      { module: "mod-1", device: "ph-01", metric: "ph", value: 6.1, time: "2026-08-16T10:00:00Z" },
      { module: "mod-2", device: "ec-01", metric: "ec", value: 2.1, time: "2026-08-16T10:00:00Z" }
    ];
    const db = mockDb(rows);
    const caller = callerWith(db);
    const res = await caller.field.latest({ tenant: "demo" });
    expect(res["mod-1"]["ec"].value).toBe(1.45);
    expect(res["mod-1"]["ph"].value).toBe(6.1);
    expect(res["mod-2"]["ec"].value).toBe(2.1);
  });

  it("retorna objeto vacío sin telemetría", async () => {
    const db = mockDb([]);
    const caller = callerWith(db);
    const res = await caller.field.latest({ tenant: "demo" });
    expect(Object.keys(res).length).toBe(0);
  });
});

describe("confidence shaping (ADR-0010)", () => {
  it("clamp nunca 100 y preserva sources", () => {
    const c = shapeConfidence({ v: 100, ts: Date.now(), sources: { ec: 95, ph: 90 } });
    expect(c).not.toBeNull();
    expect(c!.v).toBe(99);
    expect(c!.sources.ec).toBe(95);
  });

  it("rechaza payload inválido", () => {
    expect(shapeConfidence(null)).toBeNull();
    expect(shapeConfidence({ v: "bad", ts: 123 })).toBeNull();
  });

  it("health shaping valida state", () => {
    const h = shapeHealth({ state: "ok", ts: Date.now(), devices: { "ec-01": "ok" } });
    expect(h?.state).toBe("ok");
    expect(shapeHealth({ state: "unknown", ts: Date.now(), devices: {} })).toBeNull();
  });
});

describe("cameras.lastPhoto y pending.alerts vacíos", () => {
  it("cameras retorna vacío honesto sin fotos", async () => {
    const db = mockDb([]);
    const caller = callerWith(db);
    const res = await caller.cameras.lastPhoto({ tenant: "demo" });
    expect(res).toEqual([]);
  });

  it("pending.alerts retorna vacío sin alertas", async () => {
    const db = mockDb([]);
    const caller = callerWith(db);
    const res = await caller.pending.alerts({ tenant: "demo", limit: 10 });
    expect(res).toEqual([]);
  });
});
