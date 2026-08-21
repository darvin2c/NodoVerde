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
  createModule: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "create_module", args }); return { module: { tenant: "demo", id: "mod-5", name: "Mesa Prueba", crop: null } }; }),
  updateModule: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "update_module", args }); return { module: { id: "mod-1", name: "Mesa Nueva" } }; }),
  retireModule: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "retire_module", args }); return { module: { id: "mod-1", retired_at: "2026-08-20" } }; }),
  claimDevice: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "claim_device", args }); return { hw_id: "020000000005" }; }),
  createTenant: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "create_tenant", args }); return { tenant: { id: "ica", name: "Finca Ica" } }; }),
  updateTenant: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "update_tenant", args }); return { tenant: { id: "ica", name: "Finca Ica Norte" } }; }),
  archiveTenant: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "archive_tenant", args }); return { tenant: { id: "ica", archived_at: "2026-08-21" } }; }),
  createCropProfile: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "create_crop_profile", args }); return { profile: { name: "lechuga_romana" } }; }),
  updateCropProfile: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "update_crop_profile", args }); return { profile: { name: "lechuga", ec_min: 1.0 } }; }),
  openBatch: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "open_batch", args }); return { id: "b-1", code: "LOTE-0009" }; }),
  closeBatch: vi.fn(async (args: unknown) => { domainCalls.push({ tool: "close_batch", args }); return { id: "b-1", code: "LOTE-0009" }; })
}));

describe("modules mutations — delegación gobernada al MCP", () => {
  it("create pasa solo tenant/name (la mesa nace LIBRE, sin cultivo — ADR-0025)", async () => {
    const caller = callerWith(mockDb());
    const res = await caller.modules.create({ tenant: "demo", name: "Mesa Prueba" }) as { module: { id: string; crop: string | null } };
    expect(res.module.id).toBe("mod-5");
    expect(res.module.crop).toBeNull();
    expect(domainCalls.at(-1)).toEqual({ tool: "create_module", args: { tenant: "demo", name: "Mesa Prueba" } });
  });

  it("update renombra; el cultivo NO se edita por módulo (ADR-0025)", async () => {
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

describe("farms.summary — pulso por finca (peor alerta, lecturas vs rango, series)", () => {
  // El procedure lanza 6 queries en secuencia; mockResolvedValueOnce las encadena en orden.
  function dbChain(...queries: unknown[][]) {
    const execute = vi.fn();
    for (const rows of queries) execute.mockResolvedValueOnce({ rows });
    execute.mockResolvedValue({ rows: [] });
    return { execute } as unknown as never;
  }
  const farmRows = [
    { id: "demo", name: "Parcela Demo", location_name: "Lambayeque", currency: "PEN", total_modules: 2, open_warn: 1, open_critical: 0, today_spend: "30" }
  ];

  it("peor alerta: critical gana sobre warn aunque sea más vieja", async () => {
    const db = dbChain(farmRows, [
      { tenant: "demo", name: "ec_baja", severity: "critical", module: "mod-1", time: "2026-08-21T10:00:00Z" }
    ]);
    const res = await callerWith(db).farms.summary() as Array<{ worstAlert: { name: string; severity: string } | null }>;
    expect(res[0].worstAlert).toMatchObject({ name: "ec_baja", severity: "critical" });
  });

  it("lecturas: el módulo fuera de rango gana sobre los sanos", async () => {
    const db = dbChain(farmRows, [], [
      { tenant: "demo", module: "mod-1", metric: "ec", value: 1.8, ec_min: 1.6, ec_max: 2.2, ph_min: 5.5, ph_max: 6.5 },
      { tenant: "demo", module: "mod-2", metric: "ec", value: 1.2, ec_min: 1.6, ec_max: 2.2, ph_min: 5.5, ph_max: 6.5 },
      { tenant: "demo", module: "mod-1", metric: "ph", value: 6.0, ec_min: 1.6, ec_max: 2.2, ph_min: 5.5, ph_max: 6.5 },
      { tenant: "demo", module: "mod-2", metric: "level", value: 45, ec_min: 1.6, ec_max: 2.2, ph_min: 5.5, ph_max: 6.5 }
    ]);
    const res = await callerWith(db).farms.summary() as Array<{
      readings: { ec: { value: number; status: string; module: string } | null; ph: { status: string } | null; level: { value: number } | null };
    }>;
    // mod-2 fuera de rango (1.2 < 1.6) gana sobre mod-1 sano
    expect(res[0].readings.ec).toMatchObject({ value: 1.2, status: "warn", module: "mod-2" });
    expect(res[0].readings.ph?.status).toBe("ok");
    expect(res[0].readings.level).toMatchObject({ value: 45, status: "ok" });
  });

  it("clima: última lectura de air_temp y humidity por finca", async () => {
    const db = dbChain(farmRows, [], [], [
      { tenant: "demo", metric: "air_temp", value: 28.5, time: "2026-08-21T15:00:00Z" },
      { tenant: "demo", metric: "humidity", value: 70, time: "2026-08-21T14:00:00Z" }
    ]);
    const res = await callerWith(db).farms.summary() as Array<{ climate: { airTemp: number; humidity: number } | null }>;
    expect(res[0].climate).toMatchObject({ airTemp: 28.5, humidity: 70 });
  });

  it("series: sparkline de confianza y gasto 7d pasan tal cual, con números", async () => {
    const db = dbChain(farmRows, [], [], [], [
      { tenant: "demo", h: "2026-08-21T10:00:00Z", v: "0.85" },
      { tenant: "demo", h: "2026-08-21T11:00:00Z", v: "0.90" }
    ], [
      { tenant: "demo", d: "2026-08-20", v: "120.5" },
      { tenant: "demo", d: "2026-08-21", v: "30" }
    ]);
    const res = await callerWith(db).farms.summary() as Array<{
      confidenceSeries: Array<{ t: string; v: number }>; spend7d: Array<{ d: string; v: number }>;
    }>;
    expect(res[0].confidenceSeries).toEqual([
      { t: "2026-08-21T10:00:00Z", v: 0.85 }, { t: "2026-08-21T11:00:00Z", v: 0.9 }
    ]);
    expect(res[0].spend7d).toEqual([{ d: "2026-08-20", v: 120.5 }, { d: "2026-08-21", v: 30 }]);
  });

  it("sección caída degrada honesta: finca sin clima la devuelve con climate null", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: farmRows })   // farms
      .mockResolvedValueOnce({ rows: [] })         // worstAlert
      .mockResolvedValueOnce({ rows: [] })         // readings
      .mockRejectedValueOnce(new Error("boom"));   // climate falla
    const res = await callerWith({ execute } as never).farms.summary() as Array<{ climate: unknown; readings: unknown }>;
    expect(res[0].climate).toBeNull();
    expect(res[0].readings).toEqual({ ec: null, ph: null, level: null });
  });
});

describe("overview.activity — feed unificado", () => {
  it("mapea filas del UNION a items tipados y parsea meta string", async () => {
    const db = mockDb([
      { time: "2026-08-21T15:00:00Z", tenant: "demo", kind: "alert", ref: "ec_baja", severity: "critical", module: "mod-1", device: "ec_01", meta: '{"value":1.2}' },
      { time: "2026-08-21T14:00:00Z", tenant: "ica", kind: "movement", ref: "nutrientes", severity: "gasto", module: null, device: null, meta: { amount: "55.00", currency: "USD", voided: false } },
      { time: "2026-08-21T13:00:00Z", tenant: "demo", kind: "action", ref: "dose_nutrient", severity: "executed", module: "mod-1", device: "doser_a", meta: { requested_by: "experto-lechuga" } }
    ]);
    const res = await callerWith(db).overview.activity({ limit: 40 });
    expect(res).toHaveLength(3);
    expect(res[0]).toMatchObject({ kind: "alert", ref: "ec_baja", severity: "critical", meta: { value: 1.2 } });
    expect(res[1]).toMatchObject({ kind: "movement", tenant: "ica", meta: { amount: "55.00", currency: "USD" } });
    expect(res[2]).toMatchObject({ kind: "action", module: "mod-1", device: "doser_a" });
  });

  it("DB caída devuelve feed vacío honesto", async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as never;
    expect(await callerWith(db).overview.activity({})).toEqual([]);
  });
});

describe("batches.list — lotes de producción (ADR-0024)", () => {
  it("mapea lote con módulos nombrados y campaign etiqueta", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "uuid-1", code: "LOTE-0003", tenant: "demo", crop: "lechuga", campaign: "invierno-2026",
        modules: ["mod-1", "mod-2"], started_at: "2026-08-21T10:00:00Z", expected_end_at: "2026-10-05T10:00:00Z",
        closed_at: null, close_reason: null, note: null, state: "open", cycle_days: 45
      }]})
      .mockResolvedValueOnce({ rows: [
        { tenant: "demo", id: "mod-1", name: "Mesa Norte" },
        { tenant: "demo", id: "mod-2", name: null }
      ]});
    const res = await callerWith({ execute } as never).batches.list({ tenant: "demo" });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      code: "LOTE-0003", crop: "lechuga", campaign: "invierno-2026", state: "open", cycleDays: 45,
      modules: [{ id: "mod-1", name: "Mesa Norte" }, { id: "mod-2", name: "mod-2" }]
    });
    expect(res[0].closedAt).toBeNull();
  });

  it("modules como string JSON (pg TEXT defensivo) se parsea igual", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "uuid-2", code: "LOTE-0001", tenant: "demo", crop: "tomate", campaign: null,
        modules: "[\"mod-4\"]", started_at: "2026-08-01T10:00:00Z", expected_end_at: null,
        closed_at: "2026-08-20T10:00:00Z", close_reason: "cosecha", note: "primera", state: "closed", cycle_days: 90
      }]})
      .mockResolvedValueOnce({ rows: [] });
    const res = await callerWith({ execute } as never).batches.list({});
    expect(res[0].modules).toEqual([{ id: "mod-4", name: "mod-4" }]);
    expect(res[0]).toMatchObject({ campaign: null, closeReason: "cosecha", state: "closed" });
  });

  it("DB caída devuelve lista vacía honesta", async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as never;
    expect(await callerWith(db).batches.list({})).toEqual([]);
  });
});

// — Perfiles de cultivo (ADR-0025, regla 9: el humano escribe vía MCP gobernado) —
describe("profiles router — catálogo biológico gobernado", () => {
  it("create delega al MCP con rangos completos", async () => {
    const caller = callerWith(mockDb());
    await caller.profiles.create({
      name: "lechuga_romana", ec_min: 1.2, ec_max: 1.8,
      ph_min: 5.8, ph_max: 6.3, water_temp_min: 18, water_temp_max: 24,
      cycle_days: 45, notes: "variedad romana"
    });
    expect(domainCalls.at(-1)).toEqual({
      tool: "create_crop_profile",
      args: { name: "lechuga_romana", ec_min: 1.2, ec_max: 1.8, ph_min: 5.8, ph_max: 6.3, water_temp_min: 18, water_temp_max: 24, cycle_days: 45, notes: "variedad romana" }
    });
  });

  it("create rechaza slug inválido ANTES de llamar al MCP", async () => {
    const caller = callerWith(mockDb());
    const before = domainCalls.length;
    await expect(caller.profiles.create({
      name: "Lechuga Romana", ec_min: 1.2, ec_max: 1.8,
      ph_min: 5.8, ph_max: 6.3, water_temp_min: 18, water_temp_max: 24
    })).rejects.toThrow();
    expect(domainCalls.length).toBe(before);
  });

  it("update delega cambios parciales; name inmutable", async () => {
    const caller = callerWith(mockDb());
    await caller.profiles.update({ name: "lechuga", ec_min: 1.0 });
    expect(domainCalls.at(-1)).toEqual({ tool: "update_crop_profile", args: { name: "lechuga", ec_min: 1.0 } });
  });
});
