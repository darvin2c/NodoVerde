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
    const db = mockDb([{ tenant: "demo", currency: "PEN", ingresos: "0", gastos: "0", count: 0 }]);
    const caller = callerWith(db);
    const res = await caller.finance.monthSummary({ tenant: "demo" });
    expect(res.empty).toBe(true);
    expect(res.ingresos).toBe(0);
    expect(res.gastos).toBe(0);
    expect(res.balance).toBe(0);
    expect(res.count).toBe(0);
  });

  it("suma correctamente ingresos y gastos (aritmética en SQL simulada)", async () => {
    const db = mockDb([{ tenant: "demo", currency: "PEN", ingresos: "1200.50", gastos: "840.00", count: 5 }]);
    const caller = callerWith(db);
    const res = await caller.finance.monthSummary({ tenant: "demo", month: "2026-08" });
    expect(res.ingresos).toBe(1200.5);
    expect(res.gastos).toBe(840);
    expect(res.balance).toBe(360.5);
    expect(res.empty).toBe(false);
  });

  it("modo Todas (sin tenant): byTenant con moneda por finca, sin mezclar", async () => {
    const db = mockDb([
      { tenant: "demo", currency: "PEN", ingresos: "100", gastos: "40", count: 3 },
      { tenant: "ica", currency: "USD", ingresos: "200", gastos: "50", count: 2 }
    ]);
    const caller = callerWith(db);
    const res = await caller.finance.monthSummary({});
    // Nunca se suma global (monedas distintas): los planos quedan a cero
    expect(res.ingresos).toBe(0);
    expect(res.byTenant).toHaveLength(2);
    expect(res.byTenant[0]).toMatchObject({ tenant: "demo", currency: "PEN", balance: 60 });
    expect(res.byTenant[1]).toMatchObject({ tenant: "ica", currency: "USD", balance: 150 });
    expect(res.empty).toBe(false);
  });

  it("maneja error de DB con estado vacío honesto", async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as never;
    const caller = callerWith(db);
    const res = await caller.finance.monthSummary({ tenant: "demo" });
    expect(res.empty).toBe(true);
    expect(res.balance).toBe(0);
    expect(res.byTenant).toEqual([]);
  });
});

describe("field.latest — telemetría", () => {
  it("agrupa latest_readings por finca/módulo y métrica (ADR-0023)", async () => {
    const rows = [
      { tenant: "demo", module: "mod-1", device: "ec-01", metric: "ec", value: 1.45, time: "2026-08-16T10:00:00Z" },
      { tenant: "demo", module: "mod-1", device: "ph-01", metric: "ph", value: 6.1, time: "2026-08-16T10:00:00Z" },
      { tenant: "ica", module: "mod-1", device: "ec-01", metric: "ec", value: 2.1, time: "2026-08-16T10:00:00Z" }
    ];
    const db = mockDb(rows);
    const caller = callerWith(db);
    const res = await caller.field.latest({ tenant: "demo" });
    // Clave compuesta: el mismo mod-1 en dos fincas NO colisiona
    expect(res["demo/mod-1"]["ec"].value).toBe(1.45);
    expect(res["demo/mod-1"]["ph"].value).toBe(6.1);
    expect(res["ica/mod-1"]["ec"].value).toBe(2.1);
  });

  it("sin tenant devuelve todas las fincas", async () => {
    const rows = [{ tenant: "demo", module: "mod-1", device: "ec-01", metric: "ec", value: 1.45, time: "2026-08-16T10:00:00Z" }];
    const db = mockDb(rows);
    const caller = callerWith(db);
    const res = await caller.field.latest({});
    expect(res["demo/mod-1"]["ec"].value).toBe(1.45);
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

// — Provisionamiento de módulos (ADR-0022): la PWA delega SIEMPRE al MCP de dominio —
const domainCalls: Array<{ tool: string; args: unknown }> = [];
vi.mock("../server/mcpDomain.js", () => ({
  resolveAlert: vi.fn(),
  createModule: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "create_module", args }); return { module: { tenant: "demo", id: "mod-5", name: "Mesa Prueba", crop: "lechuga" } }; }),
  updateModule: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "update_module", args }); return { module: { id: "mod-1", name: "Mesa Nueva" } }; }),
  retireModule: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "retire_module", args }); return { module: { id: "mod-1", retired_at: "2026-08-20" } }; }),
  claimDevice: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "claim_device", args }); return { hw_id: "020000000005" }; }),
  createTenant: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "create_tenant", args }); return { tenant: { id: "ica", name: "Finca Ica" } }; }),
  updateTenant: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "update_tenant", args }); return { tenant: { id: "ica", name: "Finca Ica Norte" } }; }),
  archiveTenant: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "archive_tenant", args }); return { tenant: { id: "ica", archived_at: "2026-08-21" } }; })
}));

describe("modules mutations — delegación gobernada al MCP", () => {
  it("create pasa tenant/name/crop al MCP y devuelve el módulo creado", async () => {
    const caller = callerWith(mockDb());
    const res = await caller.modules.create({ tenant: "demo", name: "Mesa Prueba", crop: "lechuga" }) as { module: { id: string } };
    expect(res.module.id).toBe("mod-5");
    expect(domainCalls.at(-1)).toEqual({ tool: "create_module", args: { tenant: "demo", name: "Mesa Prueba", crop: "lechuga" } });
  });

  it("update pasa rename al MCP", async () => {
    const caller = callerWith(mockDb());
    await caller.modules.update({ tenant: "demo", module: "mod-1", name: "Mesa Nueva" });
    expect(domainCalls.at(-1)).toEqual({ tool: "update_module", args: { tenant: "demo", module: "mod-1", name: "Mesa Nueva" } });
  });

  it("retire pasa el módulo al MCP", async () => {
    const caller = callerWith(mockDb());
    await caller.modules.retire({ tenant: "demo", module: "mod-1" });
    expect(domainCalls.at(-1)).toEqual({ tool: "retire_module", args: { tenant: "demo", module: "mod-1" } });
  });

  it("claim acepta hw_id válido y lo marca claimed_by=pwa", async () => {
    const caller = callerWith(mockDb());
    await caller.modules.claim({ tenant: "demo", module: "mod-5", hw_id: "020000000005" });
    expect(domainCalls.at(-1)).toEqual({ tool: "claim_device", args: { tenant: "demo", module: "mod-5", hw_id: "020000000005", claimed_by: "pwa" } });
  });

  it("claim rechaza hw_id mal formado ANTES de llamar al MCP", async () => {
    const caller = callerWith(mockDb());
    const before = domainCalls.length;
    await expect(caller.modules.claim({ tenant: "demo", module: "mod-5", hw_id: "XYZ" })).rejects.toThrow();
    expect(domainCalls.length).toBe(before); // nunca llegó al dominio
  });
});

// — Gestión de fincas (ADR-0023): listado read DB + escrituras gobernadas al MCP —
describe("tenants router — listado y delegación gobernada", () => {
  it("list devuelve fincas desde la DB con archived_at", async () => {
    const db = mockDb([
      { id: "demo", name: "Parcela Demo", location_name: "Lambayeque", lat: -6.486, lon: -79.647, tz: "America/Lima", currency: "PEN", archived_at: null, created_at: "2026-08-15" },
      { id: "ica", name: "Finca Ica", location_name: null, lat: null, lon: null, tz: "America/Lima", currency: "USD", archived_at: "2026-08-20", created_at: "2026-08-18" }
    ]);
    const caller = callerWith(db);
    const res = await caller.tenants.list({ includeArchived: true }) as Array<{ id: string; archived_at: string | null; currency: string }>;
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ id: "demo", archived_at: null, currency: "PEN" });
    expect(res[1]).toMatchObject({ id: "ica", archived_at: "2026-08-20", currency: "USD" });
  });

  it("create delega al MCP con slug, coords y moneda", async () => {
    const caller = callerWith(mockDb());
    const res = await caller.tenants.create({ id: "ica", name: "Finca Ica", lat: -14.07, lon: -75.73, currency: "USD" }) as { tenant: { id: string } };
    expect(res.tenant.id).toBe("ica");
    expect(domainCalls.at(-1)).toEqual({ tool: "create_tenant", args: { id: "ica", name: "Finca Ica", lat: -14.07, lon: -75.73, currency: "USD" } });
  });

  it("create rechaza id con mayúsculas ANTES de llamar al MCP", async () => {
    const caller = callerWith(mockDb());
    const before = domainCalls.length;
    await expect(caller.tenants.create({ id: "Ica Norte", name: "x", lat: -14.07, lon: -75.73 })).rejects.toThrow();
    expect(domainCalls.length).toBe(before);
  });

  it("create rechaza moneda fuera del catálogo ANTES del MCP", async () => {
    const caller = callerWith(mockDb());
    const before = domainCalls.length;
    await expect(caller.tenants.create({ id: "ica", name: "x", lat: -14.07, lon: -75.73, currency: "BTC" as never })).rejects.toThrow();
    expect(domainCalls.length).toBe(before);
  });

  it("archive pasa el flag al MCP", async () => {
    const caller = callerWith(mockDb());
    await caller.tenants.archive({ id: "ica", archived: true });
    expect(domainCalls.at(-1)).toEqual({ tool: "archive_tenant", args: { id: "ica", archived: true } });
  });
});

describe("farms.summary — resumen por finca (modo Todas)", () => {
  it("devuelve KPIs por finca sin mezclar monedas (cada fila lleva su currency)", async () => {
    const db = mockDb([
      { id: "demo", name: "Parcela Demo", location_name: "Lambayeque", currency: "PEN", total_modules: 3, open_warn: 1, open_critical: 0, today_spend: "55.50" },
      { id: "ica", name: "Finca Ica", location_name: null, currency: "USD", total_modules: 0, open_warn: 0, open_critical: 2, today_spend: "0" }
    ]);
    const caller = callerWith(db);
    const res = await caller.farms.summary() as Array<{
      id: string; currency: string; totalModules: number;
      openAlerts: { warn: number; critical: number }; todaySpend: number; avgConfidence: number | null;
    }>;
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ id: "demo", currency: "PEN", totalModules: 3, todaySpend: 55.5 });
    expect(res[0].openAlerts).toEqual({ warn: 1, critical: 0 });
    expect(res[1]).toMatchObject({ id: "ica", currency: "USD", totalModules: 0, todaySpend: 0 });
    expect(res[1].openAlerts).toEqual({ warn: 0, critical: 2 });
    // Sin bus MQTT vivo en test, la confianza es null honesto (ADR-0010)
    expect(res[0].avgConfidence).toBeNull();
  });

  it("DB caída devuelve lista vacía honesta", async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as never;
    const caller = callerWith(db);
    const res = await caller.farms.summary();
    expect(res).toEqual([]);
  });
});
