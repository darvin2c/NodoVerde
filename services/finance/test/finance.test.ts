import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery, mockConnect } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
}));

vi.mock("pg", async () => {
  const actual = await vi.importActual<typeof import("pg")>("pg");
  return {
    ...actual,
    default: {
      ...actual.default,
      Pool: vi.fn(function () {
        return { query: mockQuery, connect: mockConnect, on: vi.fn(), end: vi.fn() };
      }),
    },
  };
});

import { parseDoseMessage, supplyForDevice, handleDoseEvent } from "../src/consumer.js";
import { validateAttribution, DEVICE_SUPPLY_MAP, CATEGORIES, findDuplicateSameDay, voidMovementDb, costSummaryDb, listMovementsDb, setSupplyCostDb } from "../src/db.js";

function eventPayload(name: string, ml: number, ts = 1700000000000): string {
  return JSON.stringify({ name, ts, detail: { device: "doser-a-01", duration_ms: 5000, ml } });
}

// ---------------------------------------------------------------------------
// Parsing eventos de dosis
// ---------------------------------------------------------------------------
describe("parseDoseMessage — parsing de eventos de dosis", () => {
  it("parsea dose_a_end válido", () => {
    const r = parseDoseMessage("terra/demo/mod-1/doser-a-01/switch/event", eventPayload("dose_a_end", 5));
    expect(r).not.toBeNull();
    expect(r!.tenant).toBe("demo");
    expect(r!.module).toBe("mod-1");
    expect(r!.device).toBe("doser-a-01");
    expect(r!.ml).toBe(5);
    expect(r!.supply).toBe("nutriente_a");
  });

  it("ignora evento no-dosis", () => {
    const r = parseDoseMessage("terra/demo/mod-1/doser-a-01/switch/event", eventPayload("other_event", 5));
    expect(r).toBeNull();
  });

  it("ignora ml <=0", () => {
    expect(parseDoseMessage("terra/demo/mod-1/doser-a-01/switch/event", eventPayload("dose_a_end", 0))).toBeNull();
    expect(parseDoseMessage("terra/demo/mod-1/doser-a-01/switch/event", eventPayload("dose_a_end", -1))).toBeNull();
  });

  it("ignora detail ausente o sin ml", () => {
    const p1 = JSON.stringify({ name: "dose_a_end", ts: 1 });
    expect(parseDoseMessage("terra/demo/mod-1/doser-a-01/switch/event", p1)).toBeNull();
    const p2 = JSON.stringify({ name: "dose_a_end", ts: 1, detail: {} });
    expect(parseDoseMessage("terra/demo/mod-1/doser-a-01/switch/event", p2)).toBeNull();
  });

  it("ignora device no mapeado", () => {
    const payload = JSON.stringify({ name: "dose_a_end", ts: 1, detail: { ml: 5 } });
    expect(parseDoseMessage("terra/demo/mod-1/ec-01/ec/event", payload)).toBeNull();
  });

  it("ignora topic mal formado", () => {
    expect(parseDoseMessage("terra/demo/mod-1/event", eventPayload("dose_a_end", 5))).toBeNull();
    expect(parseDoseMessage("terra/demo/mod-1/doser-a-01/switch/reading", eventPayload("dose_a_end", 5))).toBeNull();
  });

  it("ignora JSON inválido", () => {
    expect(parseDoseMessage("terra/demo/mod-1/doser-a-01/switch/event", "not json")).toBeNull();
  });
});

describe("mapa device → supply", () => {
  it("doser-a-01 → nutriente_a", () => expect(supplyForDevice("doser-a-01")).toBe("nutriente_a"));
  it("doser-b-01 → nutriente_b", () => expect(supplyForDevice("doser-b-01")).toBe("nutriente_b"));
  it("doser-ph-01 → ph_down", () => expect(supplyForDevice("doser-ph-01")).toBe("ph_down"));
  it("otro → null", () => expect(supplyForDevice("ec-01")).toBeNull());
  it("DEVICE_SUPPLY_MAP categorías", () => {
    expect(DEVICE_SUPPLY_MAP["doser-a-01"]).toBe("nutriente_a");
  });
});

// ---------------------------------------------------------------------------
// Validación imputación
// ---------------------------------------------------------------------------
describe("validateAttribution", () => {
  it("suma 100 ok", () => expect(validateAttribution([{ module: "mod-1", pct: 100 }])).toBeNull());
  it("suma 50+50 ok", () => expect(validateAttribution([{ module: "mod-1", pct: 50 }, { module: "mod-2", pct: 50 }])).toBeNull());
  it("tolerancia 0.001", () => expect(validateAttribution([{ module: "mod-1", pct: 33.333 }, { module: "mod-2", pct: 33.333 }, { module: "mod-3", pct: 33.334 }])).toBeNull());
  it("suma !=100 rechaza", () => expect(validateAttribution([{ module: "mod-1", pct: 50 }])).toMatch(/≠ 100/));
  it("suma 101 rechaza", () => expect(validateAttribution([{ module: "mod-1", pct: 60 }, { module: "mod-2", pct: 41 }])).not.toBeNull());
  it("vacía rechaza", () => expect(validateAttribution([])).not.toBeNull());
});

// ---------------------------------------------------------------------------
// handleDoseEvent — aritmética en SQL (no en TS)
// ---------------------------------------------------------------------------
describe("handleDoseEvent — SQL hace amount = ml * cost_per_unit", () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it("usa INSERT ... SELECT cost_per_unit con ml como parámetro separado", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "uuid-1" }] } as never);
    const id = await handleDoseEvent(
      "terra/demo/mod-1/doser-a-01/switch/event",
      eventPayload("dose_a_end", 10, 999),
    );
    expect(id).toBe("uuid-1");
    const sql: string = mockQuery.mock.calls[0][0] as string;
    const params: unknown[] = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toMatch(/\$2 \* sc\.cost_per_unit/);
    expect(sql).toMatch(/FROM supply_costs/);
    expect(sql).toMatch(/ON CONFLICT \(tenant, source_event\) WHERE source_event IS NOT NULL DO NOTHING/);
    expect(params[1]).toBe(10);
  });

  it("dedup ON CONFLICT DO NOTHING retorna null si ya existe", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    const id = await handleDoseEvent(
      "terra/demo/mod-1/doser-a-01/switch/event",
      eventPayload("dose_b_end", 5, 888),
    );
    expect(id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// register_movement — validación y dedup
// ---------------------------------------------------------------------------
describe("register_movement — validación y dedup", () => {
  beforeEach(() => mockQuery.mockReset());

  it("rechaza categoría inválida", () => {
    expect((CATEGORIES as readonly string[]).includes("invalida")).toBe(false);
  });

  it("rechaza attribution suma !=100", () => {
    expect(validateAttribution([{ module: "mod-1", pct: 50 }])).not.toBeNull();
  });

  it("dedup same-day retorna possible_duplicate salvo force", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "existing-id" }] } as never);
    const dup = await findDuplicateSameDay({ tenant: "demo", amount: 100, category: "nutrientes" });
    expect(dup).toBe("existing-id");
    expect(mockQuery.mock.calls[0][0]).toMatch(/ts::date = now\(\)::date/);
    expect(mockQuery.mock.calls[0][0]).toMatch(/voided_by IS NULL/);
  });

  it("findDuplicate filtra vigente (anula_a IS NULL)", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await findDuplicateSameDay({ tenant: "demo", amount: 10, category: "otro" });
    expect(mockQuery.mock.calls[0][0]).toMatch(/anula_a IS NULL/);
  });
});

// ---------------------------------------------------------------------------
// void feliz + doble-void rechazado
// ---------------------------------------------------------------------------
describe("void_movement", () => {
  beforeEach(() => { mockQuery.mockReset(); mockConnect.mockReset(); });

  function mockClient(rows: Record<string, unknown>[]) {
    const q = vi.fn();
    q.mockResolvedValueOnce({ rows: [] } as never); // BEGIN
    q.mockResolvedValueOnce({ rows } as never); // SELECT orig
    if (rows.length > 0 && !rows[0].voided_by && !rows[0].anula_a) {
      q.mockResolvedValueOnce({ rows: [{ id: "void-id" }] } as never); // INSERT espejo
      q.mockResolvedValueOnce({ rows: [] } as never); // UPDATE orig
      q.mockResolvedValueOnce({ rows: [] } as never); // COMMIT
    } else if (rows.length > 0) {
      q.mockResolvedValueOnce({ rows: [] } as never); // ROLLBACK
    } else {
      q.mockResolvedValueOnce({ rows: [] } as never); // ROLLBACK
    }
    mockConnect.mockResolvedValueOnce({ query: q, release: vi.fn() } as never);
    return q;
  }

  it("void feliz crea espejo con amount negativo vía SQL", async () => {
    const q = mockClient([{ id: "orig-id", tenant: "demo", kind: "gasto", amount: "10.00", currency: "PEN", category: "nutrientes", attribution: [], voided_by: null, anula_a: null }]);
    const res = await voidMovementDb({ id: "orig-id", reason: "error", created_by: "tester" });
    expect(res).toEqual({ voidId: "void-id" });
    const calls = q.mock.calls.map((c) => c[0] as string);
    const insertCall = calls.find((s) => s.includes("INSERT INTO movements") && s.includes("SELECT"));
    expect(insertCall).toMatch(/-amount/);
  });

  it("doble void rechazado", async () => {
    mockClient([{ id: "orig-id", tenant: "demo", kind: "gasto", amount: "10.00", currency: "PEN", category: "nutrientes", attribution: [], voided_by: "void-id", anula_a: null }]);
    const res = await voidMovementDb({ id: "orig-id", reason: "otro", created_by: "tester" });
    expect(res).toEqual({ error: "movimiento ya anulado" });
  });

  it("anular movimiento de anulación rechazado", async () => {
    mockClient([{ id: "void-id", tenant: "demo", kind: "gasto", amount: "-10.00", currency: "PEN", category: "nutrientes", attribution: [], voided_by: null, anula_a: "orig-id" }]);
    const res = await voidMovementDb({ id: "void-id", reason: "x", created_by: "tester" });
    expect(res).toEqual({ error: "no se puede anular un movimiento de anulación" });
  });
});

// ---------------------------------------------------------------------------
// cost_summary shaping
// ---------------------------------------------------------------------------
describe("cost_summary — shaping group_by", () => {
  beforeEach(() => mockQuery.mockReset());

  it("group_by category hace query sin JOIN modules", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "nutrientes", gasto: "100", ingreso: "0" }] } as never);
    const rows = await costSummaryDb({ group_by: "category" });
    expect(rows[0].group).toBe("nutrientes");
    expect(rows[0].gasto).toBe("100");
    expect(rows[0].neto).toBeDefined();
    const sql: string = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/GROUP BY m\.category/);
  });

  it("group_by crop resuelve cultivo por ventana del lote (ADR-0025), no por modules.crop", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "lechuga", gasto: "50", ingreso: "200" }] } as never);
    const rows = await costSummaryDb({ tenant: "demo", group_by: "crop" });
    expect(rows[0].group).toBe("lechuga");
    const sql: string = mockQuery.mock.calls[0][0] as string;
    // El cultivo viene del lote vigente en el instante del movimiento; mesa sin
    // lote en ese momento → 'sin_lote'. NO usa modules.crop (caché volátil).
    expect(sql).toMatch(/FROM lotes l/);
    expect(sql).toMatch(/l\.started_at <= m\.ts/);
    expect(sql).toMatch(/l\.closed_at IS NULL OR m\.ts <= l\.closed_at/);
    expect(sql).toMatch(/'sin_lote'/);
    expect(sql).not.toMatch(/JOIN modules/);
  });

  it("group_by module desagrega por attribution pct", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "mod-1", gasto: "30", ingreso: "0" }] } as never);
    const rows = await costSummaryDb({ group_by: "module" });
    expect(rows[0].group).toBe("mod-1");
    const sql: string = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/jsonb_array_elements/);
  });
});

// ---------------------------------------------------------------------------
// listMovements filtro vigente y include_voided
// ---------------------------------------------------------------------------
describe("listMovementsDb — include_voided", () => {
  beforeEach(() => mockQuery.mockReset());

  it("por defecto filtra vigente", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listMovementsDb({});
    expect(mockQuery.mock.calls[0][0]).toMatch(/voided_by IS NULL AND anula_a IS NULL/);
  });

  it("include_voided true no filtra", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listMovementsDb({ include_voided: true });
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/voided_by IS NULL/);
  });

  it("límite max 50", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listMovementsDb({ limit: 100 });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[params.length - 1]).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// set_supply_cost UPSERT
// ---------------------------------------------------------------------------
describe("setSupplyCostDb — UPSERT", () => {
  beforeEach(() => mockQuery.mockReset());
  it("hace ON CONFLICT DO UPDATE", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await setSupplyCostDb({ supply: "nutriente_a", cost_per_unit: 0.5 });
    expect(mockQuery.mock.calls[0][0]).toMatch(/ON CONFLICT.*DO UPDATE SET/);
  });
});
