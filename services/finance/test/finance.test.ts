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
import {
  DEVICE_SUPPLY_MAP,
  CATEGORIES,
  validateAttributionAmounts,
  splitEqual,
  findDuplicateByExternalRef,
  findDuplicateSameDay,
  voidMovementDb,
  editMovementDb,
  insertMovement,
  costSummaryDb,
  listMovementsDb,
  attachEvidenceDb,
  setSupplyCostDb,
} from "../src/db.js";

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
// validateAttributionAmounts (ADR-0027: montos, no porcentajes)
// ---------------------------------------------------------------------------
describe("validateAttributionAmounts", () => {
  it("un módulo con el total ok", () =>
    expect(validateAttributionAmounts([{ module: "mod-1", amount: 100 }], 100)).toBeNull());
  it("reparto 50/50 ok", () =>
    expect(validateAttributionAmounts([{ module: "mod-1", amount: 50 }, { module: "mod-2", amount: 50 }], 100)).toBeNull());
  it("reparto con centavos ok", () =>
    expect(validateAttributionAmounts(
      [{ module: "mod-1", amount: 33.33 }, { module: "mod-2", amount: 33.33 }, { module: "mod-3", amount: 33.34 }], 100,
    )).toBeNull());
  it("suma ≠ total rechaza", () =>
    expect(validateAttributionAmounts([{ module: "mod-1", amount: 50 }], 100)).toMatch(/≠ total/));
  it("amount 0 rechaza", () =>
    expect(validateAttributionAmounts([{ module: "mod-1", amount: 0 }], 0)).not.toBeNull());
  it("módulo repetido rechaza", () =>
    expect(validateAttributionAmounts(
      [{ module: "mod-1", amount: 60 }, { module: "mod-1", amount: 40 }], 100,
    )).toMatch(/repetido/));
  it("vacía rechaza", () => expect(validateAttributionAmounts([], 100)).not.toBeNull());
});

// ---------------------------------------------------------------------------
// splitEqual — reparto asistido en plata, último absorbe el centavo
// ---------------------------------------------------------------------------
describe("splitEqual — reparto a partes iguales", () => {
  it("divide exacto", () =>
    expect(splitEqual(100, ["a", "b"])).toEqual([{ module: "a", amount: 50 }, { module: "b", amount: 50 }]));
  it("centavo al último", () => {
    const parts = splitEqual(100, ["a", "b", "c"]);
    expect(parts).toEqual([
      { module: "a", amount: 33.33 },
      { module: "b", amount: 33.33 },
      { module: "c", amount: 33.34 },
    ]);
    expect(parts.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(100, 5);
  });
  it("un módulo recibe todo", () =>
    expect(splitEqual(42.5, ["mod-1"])).toEqual([{ module: "mod-1", amount: 42.5 }]));
});

// ---------------------------------------------------------------------------
// handleDoseEvent — aritmética y snapshot de lote en SQL (no en TS)
// ---------------------------------------------------------------------------
describe("handleDoseEvent — SQL hace amount = ml * cost_per_unit y snapshot del lote", () => {
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
    // snapshot del lote activo resuelto en SQL (ADR-0027 §3)
    expect(sql).toMatch(/FROM lotes l/);
    expect(sql).toMatch(/l\.state = 'open'/);
    // op_number MOV-NNNN por contador atómico
    expect(sql).toMatch(/tenant_counters/);
    expect(sql).toMatch(/MOV-/);
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
// dedup: external_ref (fuerte) + same-day (suave)
// ---------------------------------------------------------------------------
describe("dedup", () => {
  beforeEach(() => mockQuery.mockReset());

  it("external_ref: mismo nro. de operación vigente", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "x", op_number: "MOV-0007" }] } as never);
    const dup = await findDuplicateByExternalRef({ tenant: "demo", external_ref: "913842" });
    expect(dup).toEqual({ id: "x", op_number: "MOV-0007" });
    expect(mockQuery.mock.calls[0][0]).toMatch(/external_ref = \$2/);
    expect(mockQuery.mock.calls[0][0]).toMatch(/voided_by IS NULL/);
  });

  it("same-day usa fecha económica occurred_at", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await findDuplicateSameDay({ tenant: "demo", amount: 100, category: "nutrientes" });
    expect(mockQuery.mock.calls[0][0]).toMatch(/COALESCE\(occurred_at, ts\)::date = now\(\)::date/);
  });

  it("rechaza categoría inválida (contrato de dominio)", () => {
    expect((CATEGORIES as readonly string[]).includes("invalida")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// insertMovement — snapshot de lote, op_number y evidencia en transacción
// ---------------------------------------------------------------------------
describe("insertMovement", () => {
  beforeEach(() => { mockConnect.mockReset(); });

  function mockClient(handlers: { batches?: Record<string, string | null>; id?: string }) {
    const q = vi.fn();
    // BEGIN
    q.mockResolvedValueOnce({ rows: [] } as never);
    // resolveActiveBatches
    q.mockResolvedValueOnce({
      rows: Object.entries(handlers.batches ?? {}).map(([module, code]) => ({ module, code })),
    } as never);
    // nextOpNumber
    q.mockResolvedValueOnce({ rows: [{ op_seq: 41 }] } as never);
    // INSERT movement
    q.mockResolvedValueOnce({ rows: [{ id: handlers.id ?? "new-id" }] } as never);
    // attach evidence / COMMIT
    q.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    mockConnect.mockResolvedValueOnce({ query: q, release: vi.fn() } as never);
    return q;
  }

  it("resuelve snapshot del lote y advierte mesa libre", async () => {
    const q = mockClient({ batches: { "mod-1": "LOTE-0007", "mod-2": null } });
    const res = await insertMovement({
      tenant: "demo", kind: "gasto", amount: 100, currency: "PEN", category: "nutrientes",
      scope: "modulos",
      attribution: [{ module: "mod-1", amount: 60 }, { module: "mod-2", amount: 40 }],
      created_by: "tester", source: "chat",
    });
    expect(res.op_number).toBe("MOV-0041");
    expect(res.attribution).toEqual([
      { module: "mod-1", amount: 60, batch: "LOTE-0007" },
      { module: "mod-2", amount: 40, batch: null },
    ]);
    expect(res.warnings.some((w) => w.includes("mod-2"))).toBe(true);
    const insertSql = q.mock.calls.map((c) => c[0] as string).find((s) => s.includes("INSERT INTO movements"));
    expect(insertSql).toBeDefined();
  });

  it("scope finca inserta attribution NULL sin resolver lotes", async () => {
    const q = vi.fn();
    q.mockResolvedValueOnce({ rows: [] } as never); // BEGIN
    q.mockResolvedValueOnce({ rows: [{ op_seq: 1 }] } as never); // counter
    q.mockResolvedValueOnce({ rows: [{ id: "f1" }] } as never); // insert
    q.mockResolvedValue({ rows: [] } as never); // COMMIT
    mockConnect.mockResolvedValueOnce({ query: q, release: vi.fn() } as never);
    const res = await insertMovement({
      tenant: "demo", kind: "gasto", amount: 320, currency: "PEN", category: "energia",
      scope: "finca", created_by: "tester", source: "pwa",
    });
    expect(res.attribution).toBeNull();
    const insertParams = q.mock.calls[2][1] as unknown[];
    expect(insertParams[6]).toBeNull(); // attribution NULL
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
    q.mockResolvedValueOnce({ rows } as never); // SELECT orig FOR UPDATE
    if (rows.length > 0 && !rows[0].voided_by && !rows[0].anula_a) {
      q.mockResolvedValueOnce({ rows: [{ op_seq: 9 }] } as never); // nextOpNumber
      q.mockResolvedValueOnce({ rows: [{ id: "void-id" }] } as never); // INSERT espejo
      q.mockResolvedValueOnce({ rows: [] } as never); // UPDATE orig
      q.mockResolvedValueOnce({ rows: [] } as never); // COMMIT
    } else {
      q.mockResolvedValue({ rows: [] } as never); // ROLLBACK
    }
    mockConnect.mockResolvedValueOnce({ query: q, release: vi.fn() } as never);
    return q;
  }

  it("void feliz crea espejo con amount negativo vía SQL", async () => {
    const q = mockClient([{ id: "orig-id", tenant: "demo", op_number: "MOV-0001", kind: "gasto", amount: "10.00", currency: "PEN", category: "nutrientes", attribution: [], voided_by: null, anula_a: null }]);
    const res = await voidMovementDb({ id: "orig-id", reason: "error", created_by: "tester" });
    expect(res).toEqual({ voidId: "void-id", voidOpNumber: "MOV-0009", orig: expect.anything() });
    const calls = q.mock.calls.map((c) => c[0] as string);
    const insertCall = calls.find((s) => s.includes("INSERT INTO movements") && s.includes("SELECT"));
    expect(insertCall).toMatch(/-amount/);
  });

  it("doble void rechazado", async () => {
    mockClient([{ id: "orig-id", tenant: "demo", op_number: "MOV-0001", voided_by: "void-id", anula_a: null }]);
    const res = await voidMovementDb({ id: "orig-id", reason: "otro", created_by: "tester" });
    expect(res).toEqual({ error: "movimiento MOV-0001 ya anulado" });
  });

  it("anular movimiento de anulación rechazado", async () => {
    mockClient([{ id: "void-id", tenant: "demo", op_number: null, voided_by: null, anula_a: "orig-id" }]);
    const res = await voidMovementDb({ id: "void-id", reason: "x", created_by: "tester" });
    expect(res).toEqual({ error: "no se puede anular un movimiento de anulación" });
  });
});

// ---------------------------------------------------------------------------
// editMovement — anulación + recreación atómicas con cadena replaces
// ---------------------------------------------------------------------------
describe("editMovementDb", () => {
  beforeEach(() => mockConnect.mockReset());

  it("anula y recrea en una transacción, nuevo con replaces→original", async () => {
    const q = vi.fn();
    q.mockResolvedValueOnce({ rows: [] } as never); // BEGIN
    q.mockResolvedValueOnce({ rows: [{ id: "orig-id", tenant: "demo", op_number: "MOV-0003", voided_by: null, anula_a: null }] } as never); // SELECT FOR UPDATE
    q.mockResolvedValueOnce({ rows: [{ op_seq: 10 }] } as never); // counter (void)
    q.mockResolvedValueOnce({ rows: [{ id: "void-id" }] } as never); // INSERT espejo
    q.mockResolvedValueOnce({ rows: [] } as never); // UPDATE voided_by
    q.mockResolvedValueOnce({ rows: [{ module: "mod-1", code: "LOTE-0001" }] } as never); // resolveActiveBatches
    q.mockResolvedValueOnce({ rows: [{ op_seq: 11 }] } as never); // counter (new)
    q.mockResolvedValueOnce({ rows: [{ id: "new-id" }] } as never); // INSERT new
    q.mockResolvedValue({ rows: [] } as never); // COMMIT
    mockConnect.mockResolvedValueOnce({ query: q, release: vi.fn() } as never);

    const res = await editMovementDb({
      id: "orig-id", reason: "monto mal", created_by: "tester",
      newMovement: {
        kind: "gasto", amount: 150, currency: "PEN", category: "nutrientes",
        scope: "modulos", attribution: [{ module: "mod-1", amount: 150 }],
        created_by: "tester",
      },
    });
    expect(res).toMatchObject({ voidId: "void-id", newId: "new-id", op_number: "MOV-0011" });
    const newInsert = q.mock.calls.find((c) => (c[0] as string).includes("VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb"));
    expect(newInsert).toBeDefined();
    const params = newInsert![1] as unknown[];
    expect(params[15]).toBe("orig-id"); // replaces → original (tras supplier)
  });
});

// ---------------------------------------------------------------------------
// cost_summary shaping
// ---------------------------------------------------------------------------
describe("cost_summary — shaping group_by", () => {
  beforeEach(() => mockQuery.mockReset());

  it("group_by category", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "nutrientes", gasto: "100", ingreso: "0" }] } as never);
    const rows = await costSummaryDb({ group_by: "category" });
    expect(rows[0].group).toBe("nutrientes");
    expect(mockQuery.mock.calls[0][0]).toMatch(/GROUP BY m\.category/);
  });

  it("group_by crop resuelve por snapshot del lote (ADR-0027), no por ventana ni modules.crop", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "lechuga", gasto: "50", ingreso: "200" }] } as never);
    const rows = await costSummaryDb({ tenant: "demo", group_by: "crop" });
    expect(rows[0].group).toBe("lechuga");
    const sql: string = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/l\.code = elem->>'batch'/);
    expect(sql).toMatch(/'sin_lote'/);
    expect(sql).not.toMatch(/started_at <= m\.ts/);
    expect(sql).not.toMatch(/JOIN modules/);
  });

  it("group_by module desagrega por montos de attribution", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "mod-1", gasto: "30", ingreso: "0" }] } as never);
    const rows = await costSummaryDb({ group_by: "module" });
    expect(rows[0].group).toBe("mod-1");
    const sql: string = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/jsonb_array_elements/);
    expect(sql).toMatch(/elem->>'amount'/);
  });

  it("group_by batch agrupa por lote", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "LOTE-0007", gasto: "80", ingreso: "0" }] } as never);
    const rows = await costSummaryDb({ group_by: "batch" });
    expect(rows[0].group).toBe("LOTE-0007");
    expect(mockQuery.mock.calls[0][0]).toMatch(/elem->>'batch'/);
  });

  it("group_by scope separa finca de módulos", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "finca", gasto: "320", ingreso: "0" }] } as never);
    const rows = await costSummaryDb({ group_by: "scope" });
    expect(rows[0].group).toBe("finca");
    expect(mockQuery.mock.calls[0][0]).toMatch(/GROUP BY m\.scope/);
  });

  it("group_by campaign agrupa por etiqueta del lote; sin lote → sin_campana", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ grp: "invierno-2026", gasto: "90", ingreso: "300" }] } as never);
    const rows = await costSummaryDb({ group_by: "campaign" });
    expect(rows[0].group).toBe("invierno-2026");
    const sql: string = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/COALESCE\(l\.campaign, 'sin_campana'\)/);
  });

  it("group_by batch incluye yield_kg y costo_por_kg determinístico; null honesto sin báscula", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { grp: "LOTE-0006", gasto: "100", ingreso: "0", yield_kg: "40" },
        { grp: "LOTE-0007", gasto: "80", ingreso: "0", yield_kg: null },
      ],
    } as never);
    const rows = await costSummaryDb({ group_by: "batch" });
    expect(rows[0].costo_por_kg).toBe("2.5000"); // 100/40 calculado en código, nunca por el LLM
    expect(rows[0].yield_kg).toBe("40");
    expect(rows[1].costo_por_kg).toBeNull(); // sin rendimiento declarado → null, no 0
  });
});

// ---------------------------------------------------------------------------
// listMovements filtro vigente, batch y mes por occurred_at
// ---------------------------------------------------------------------------
describe("listMovementsDb", () => {
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

  it("mes filtra por fecha económica", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listMovementsDb({ mes: "2026-08" });
    expect(mockQuery.mock.calls[0][0]).toMatch(/to_char\(COALESCE\(occurred_at, ts\), 'YYYY-MM'\)/);
  });

  it("batch filtra por snapshot del lote", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listMovementsDb({ batch: "LOTE-0007" });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain(JSON.stringify([{ batch: "LOTE-0007" }]));
  });

  it("límite max 200 y offset", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listMovementsDb({ limit: 500, offset: 25 });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[params.length - 2]).toBe(200); // limit capado
    expect(params[params.length - 1]).toBe(25); // offset
  });

  it("search cubre op_number, nota, external_ref, autor y proveedor en un solo parámetro", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listMovementsDb({ search: "yape" });
    const sql: string = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/op_number ILIKE/);
    expect(sql).toMatch(/note ILIKE/);
    expect(sql).toMatch(/external_ref ILIKE/);
    expect(sql).toMatch(/supplier ILIKE/);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params.filter((p) => p === "%yape%")).toHaveLength(1); // un solo parámetro reutilizado
  });

  it("campaign filtra por etiqueta del lote vía snapshot", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listMovementsDb({ campaign: "invierno-2026" });
    const sql: string = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/JOIN lotes l ON l\.code = e->>'batch'/);
    expect(mockQuery.mock.calls[0][1]).toContain("invierno-2026");
  });
});

describe("attachEvidenceDb — evidencia post-hoc", () => {
  beforeEach(() => mockQuery.mockReset());

  it("adjunta solo si la evidencia está huérfana y es del tenant", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "ev-1" }] } as never);
    const res = await attachEvidenceDb({ tenant: "demo", movement_id: "m-1", evidence_id: "ev-1" });
    expect(res.attached).toBe(true);
    const sql: string = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/movement_id IS NULL/);
    expect(sql).toMatch(/tenant = /);
  });

  it("rechaza evidencia ya adjunta o ajena", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    const res = await attachEvidenceDb({ tenant: "demo", movement_id: "m-1", evidence_id: "ev-x" });
    expect(res.attached).toBe(false);
    expect(res.reason).toBeTruthy();
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
