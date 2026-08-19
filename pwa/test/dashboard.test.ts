import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appRouter } from "../server/trpc.js";

function mockDb(rows: unknown[] = []) {
  return { execute: vi.fn().mockResolvedValue({ rows }) } as unknown as never;
}

function callerWith(db: unknown) {
  return appRouter.createCaller({ db: db as never });
}

describe("alerts.list — centro de alertas", () => {
  it("parsea detail (TEXT→JSON) y preserva flag open", async () => {
    const caller = callerWith(mockDb([{
      time: "2026-08-19T10:00:00Z", tenant: "demo", module: "platform",
      name: "invariant_ledger", severity: "critical", device: null,
      detail: "{\"state\":\"pending\",\"fingerprint\":\"abc\"}", open: true
    }]));
    const rows = await caller.alerts.list({ tenant: "demo", limit: 10, onlyOpen: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ state: "pending", fingerprint: "abc" });
    expect(rows[0].open).toBe(true);
  });

  it("detail inválido no rompe: se devuelve como string", async () => {
    const caller = callerWith(mockDb([{
      time: "2026-08-19T10:00:00Z", tenant: "demo", module: "mod-1",
      name: "device_silence", severity: "warn", device: "ec-01",
      detail: "no-es-json", open: true
    }]));
    const rows = await caller.alerts.list({ tenant: "demo", limit: 10, onlyOpen: false });
    expect(rows[0].detail).toBe("no-es-json");
  });

  it("onlyOpen se delega al SQL: la procedure devuelve lo que la DB responde", async () => {
    // El filtro open vive en la query (subselect q.open) — el mock ya devuelve solo abiertas
    const db = mockDb([
      { time: "t", tenant: "demo", module: "mod-1", name: "a", severity: "warn", device: null, detail: null, open: true }
    ]);
    const caller = callerWith(db);
    const rows = await caller.alerts.list({ tenant: "demo", limit: 10, onlyOpen: true });
    expect(rows).toHaveLength(1);
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("error de DB → lista vacía honesta", async () => {
    const caller = callerWith({ execute: vi.fn().mockRejectedValue(new Error("db caída")) });
    expect(await caller.alerts.list({ tenant: "demo", limit: 10, onlyOpen: false })).toEqual([]);
  });
});

describe("finance.recentMovements y byCategory", () => {
  it("recentMovements devuelve filas con estado de anulación", async () => {
    const caller = callerWith(mockDb([
      { id: "1", ts: "2026-08-19T00:00:00Z", kind: "gasto", amount: "150.00", currency: "PEN",
        category: "nutrientes", note: "compra A/B", attribution: [], voided_by: null, anula_a: null, source: "chat", created_by: "humano" },
      { id: "2", ts: "2026-08-18T00:00:00Z", kind: "gasto", amount: "90.00", currency: "PEN",
        category: "agua", note: "error de captura", attribution: [], voided_by: "3", anula_a: null, source: "chat", created_by: "humano" }
    ]));
    const rows = await caller.finance.recentMovements({ tenant: "demo", limit: 30 });
    expect(rows).toHaveLength(2);
    expect(rows[1].voided_by).toBe("3");
  });

  it("byCategory devuelve totales numéricos por categoría", async () => {
    const caller = callerWith(mockDb([
      { category: "nutrientes", total: "230.50" },
      { category: "software", total: "41.20" }
    ]));
    const rows = await caller.finance.byCategory({ tenant: "demo" });
    expect(rows).toEqual([
      { category: "nutrientes", total: 230.5 },
      { category: "software", total: 41.2 }
    ]);
  });
});

describe("modules.detail", () => {
  it("devuelve null honesto cuando el módulo no existe", async () => {
    const caller = callerWith(mockDb([]));
    expect(await caller.modules.detail({ tenant: "demo", id: "mod-99" })).toBeNull();
  });

  it("ensambla ficha + lecturas + alertas cuando existe", async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ tenant: "demo", id: "mod-1", crop: "lechuga", ec_min: 1.2, ec_max: 1.8 }] })
        .mockResolvedValueOnce({ rows: [{ device: "ec-01", metric: "ec", value: 1.4, time: "2026-08-19T10:00:00Z" }] })
        .mockResolvedValueOnce({ rows: [{ time: "t", name: "device_silence", severity: "warn", device: "ec-01", detail: null, open: true }] })
    };
    const caller = callerWith(db);
    const detail = await caller.modules.detail({ tenant: "demo", id: "mod-1" });
    expect(detail).not.toBeNull();
    expect(detail!.readings[0].metric).toBe("ec");
    expect(detail!.alerts[0].open).toBe(true);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });
});

describe("overview.kpis", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => JSON.stringify({ actions: [{}, {}] })
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("agrega módulos, alertas, aprobaciones y gasto en un solo objeto", async () => {
    const caller = callerWith(mockDb([{
      total_modules: 4, open_warn: 2, open_critical: 1, today_spend: "55.20", last_telemetry: "2026-08-19T10:00:00Z"
    }]));
    // campaigns query (segunda llamada): sin campaña abierta
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total_modules: 4, open_warn: 2, open_critical: 1, today_spend: "55.20", last_telemetry: "2026-08-19T10:00:00Z" }] })
        .mockResolvedValueOnce({ rows: [] })
    };
    void caller;
    const caller2 = callerWith(db);
    const kpis = await caller2.overview.kpis({ tenant: "demo" });
    expect(kpis.modules.total).toBe(4);
    expect(kpis.openAlerts).toEqual({ warn: 2, critical: 1 });
    expect(kpis.todaySpend).toBe(55.2);
    expect(kpis.pendingApprovals).toBe(2);
    expect(kpis.campaign).toBeNull();
  });

  it("portero inalcanzable → policyReachable false, no rompe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total_modules: 0, open_warn: 0, open_critical: 0, today_spend: "0", last_telemetry: null }] })
        .mockResolvedValueOnce({ rows: [] })
    };
    const kpis = await callerWith(db).overview.kpis({ tenant: "demo" });
    expect(kpis.policyReachable).toBe(false);
    expect(kpis.pendingApprovals).toBe(0);
  });
});

describe("system.services", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("marca servicios por respuesta HTTP y reporta latencia", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const caller = callerWith(mockDb([]));
    const res = await caller.system.services();
    expect(res.services).toHaveLength(4);
    for (const s of res.services) {
      expect(s.ok).toBe(true);
      expect(typeof s.ms).toBe("number");
    }
  });

  it("servicio caído (fetch rechaza) → ok false, no excepción", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const caller = callerWith(mockDb([]));
    const res = await caller.system.services();
    expect(res.services.every((s) => s.ok === false)).toBe(true);
  });
});
