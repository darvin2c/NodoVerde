import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockTransportClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function () {
    return { connect: mockConnect, callTool: mockCallTool, close: mockClose };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function () {
    return { close: mockTransportClose };
  }),
}));

import { parseLines, getTargetDate, isTargetDay, extractTimestamp, extractUsage, extractModel, parseSessions } from "../src/parser.js";
import { parsePriceTable, computeCost, formatNote } from "../src/pricing.js";
import { buildAttribution } from "../src/attribution.js";
import { shouldPublishBudgetAlert, decideBudgetState, monthStrFromDate, monthBoundsUtc } from "../src/budget.js";
import { buildUnknownModelAlert, buildBudgetAlert, alertTopic } from "../src/alert.js";
import { registerMovementViaMcp } from "../src/financeClient.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}
function tsUtc(y: number, m: number, d: number, h = 12): number {
  return Date.UTC(y, m - 1, d, h, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Parser: bucketing por día UTC
// ---------------------------------------------------------------------------
describe("parser — bucketing por día UTC", () => {
  it("filtra solo día UTC anterior", () => {
    const target = "2026-08-17";
    const lines = [
      line({ usage: { input: 100, output: 50 }, timestamp: tsUtc(2026, 8, 17, 10), model: "claude-4" }),
      line({ usage: { input: 200, output: 20 }, timestamp: tsUtc(2026, 8, 17, 23), model: "claude-4" }),
      line({ usage: { input: 999, output: 999 }, timestamp: tsUtc(2026, 8, 18, 1), model: "claude-4" }),
      line({ usage: { input: 999, output: 999 }, timestamp: tsUtc(2026, 8, 16, 23), model: "claude-4" }),
    ];
    const r = parseLines(lines, target);
    const u = r.counts.get("claude-4")!;
    expect(u.input).toBe(300);
    expect(u.output).toBe(70);
    expect(r.totalLines).toBe(4);
  });

  it("soporta múltiples formatos de timestamp (ts, time, ISO string)", () => {
    const target = "2026-08-17";
    const iso = new Date(tsUtc(2026, 8, 17, 5)).toISOString();
    const lines = [
      line({ usage: { input: 10, output: 5 }, ts: tsUtc(2026, 8, 17, 5), model: "m1" }),
      line({ usage: { input: 10, output: 5 }, time: tsUtc(2026, 8, 17, 6), model: "m1" }),
      line({ usage: { input: 10, output: 5 }, timestamp: iso, model: "m1" }),
      // segundos en vez de ms
      line({ usage: { input: 10, output: 5 }, timestamp: Math.floor(tsUtc(2026, 8, 17, 7) / 1000), model: "m1" }),
    ];
    const r = parseLines(lines, target);
    expect(r.counts.get("m1")!.input).toBe(40);
  });

  it("línea sin usage se ignora sin contar como rota", () => {
    const target = "2026-08-17";
    const lines = [
      line({ model: "m1", timestamp: tsUtc(2026, 8, 17) }),
      line({ usage: { input: 5, output: 5 }, timestamp: tsUtc(2026, 8, 17), model: "m1" }),
    ];
    const r = parseLines(lines, target);
    expect(r.brokenLines).toBe(0);
    expect(r.counts.get("m1")!.input).toBe(5);
  });

  it("línea sin timestamp se ignora", () => {
    const target = "2026-08-17";
    const lines = [line({ usage: { input: 5, output: 5 }, model: "m1" })];
    const r = parseLines(lines, target);
    expect(r.counts.size).toBe(0);
  });
});

describe("parser — líneas rotas", () => {
  it("cuenta líneas JSON inválidas como broken y sigue", () => {
    const target = "2026-08-17";
    const lines = [
      line({ usage: { input: 10, output: 10 }, timestamp: tsUtc(2026, 8, 17), model: "m1" }),
      "{ no json",
      line({ usage: { input: 20, output: 20 }, timestamp: tsUtc(2026, 8, 17), model: "m1" }),
      "",
      "   ",
      "{ also broken",
    ];
    const r = parseLines(lines, target);
    expect(r.brokenLines).toBe(2);
    expect(r.totalLines).toBe(4); // empty lines not counted
    expect(r.counts.get("m1")!.input).toBe(30);
  });

  it("parser suma por modelo y soporta cacheRead/cacheWrite snake_case", () => {
    const target = "2026-08-17";
    const lines = [
      line({ usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }, timestamp: tsUtc(2026, 8, 17), model: "a" }),
      line({ usage: { input: 500, output: 100, cache_read: 50, cache_write: 25 }, timestamp: tsUtc(2026, 8, 17), model: "a" }),
      line({ usage: { input: 200, output: 200 }, timestamp: tsUtc(2026, 8, 17), model: "b" }),
    ];
    const r = parseLines(lines, target);
    expect(r.counts.get("a")!.cacheRead).toBe(250);
    expect(r.counts.get("a")!.cacheWrite).toBe(125);
    expect(r.counts.get("b")!.input).toBe(200);
  });

  it("model ausente -> unknown", () => {
    const target = "2026-08-17";
    const lines = [line({ usage: { input: 1, output: 1 }, timestamp: tsUtc(2026, 8, 17) })];
    const r = parseLines(lines, target);
    expect(r.counts.has("unknown")).toBe(true);
  });
});

describe("parser — fixtures temporales con parseSessions", () => {
  it("excluye *.trajectory.jsonl y suma solo targetDate", async () => {
    const base = await mkdtemp(join(tmpdir(), "token-meter-"));
    try {
      const agentsDir = join(base, "agents", "agent1", "sessions");
      await mkdir(agentsDir, { recursive: true });
      const target = "2026-08-17";
      const other = "2026-08-16";
      // file normal
      await writeFile(
        join(agentsDir, "s1.jsonl"),
        [
          line({ usage: { input: 100, output: 50 }, timestamp: tsUtc(2026, 8, 17, 10), model: "claude" }),
          line({ usage: { input: 10, output: 10 }, timestamp: tsUtc(2026, 8, 16, 10), model: "claude" }),
          "{ broken",
        ].join("\n"),
      );
      // trajectory debe ser excluido
      await writeFile(
        join(agentsDir, "s1.trajectory.jsonl"),
        [line({ usage: { input: 9999, output: 9999 }, timestamp: tsUtc(2026, 8, 17, 10), model: "claude" })].join("\n"),
      );
      // otro agente
      const agentsDir2 = join(base, "agents", "agent2", "sessions");
      await mkdir(agentsDir2, { recursive: true });
      await writeFile(
        join(agentsDir2, "s2.jsonl"),
        [line({ usage: { input: 200, output: 20 }, timestamp: tsUtc(2026, 8, 17, 12), model: "claude" })].join("\n"),
      );

      const r = await parseSessions(base, target);
      expect(r.filesRead).toBe(2);
      expect(r.brokenLines).toBe(1);
      expect(r.counts.get("claude")!.input).toBe(300);
      // line del 16 no contado
      expect(r.counts.get("claude")!.output).toBe(70);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("OPENCLAW_STATE_PATH vacío retorna vacío sin error", async () => {
    const r = await parseSessions("", "2026-08-17");
    expect(r.counts.size).toBe(0);
    expect(r.filesRead).toBe(0);
  });
});

describe("pricing", () => {
  it("calcula costo USD/1M por tipo de token", () => {
    const table = parsePriceTable(
      JSON.stringify({
        "claude-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        "gpt-4o": { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    const counts = new Map([
      ["claude-4", { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 }],
      ["gpt-4o", { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 }],
    ]);
    const { costPerModel, totalCost, unknownModels } = computeCost(counts, table);
    // claude: 1M*3 + 0.5M*15 +2M*0.3+0.1M*3.75 =3+7.5+0.6+0.375=11.475
    expect(costPerModel.get("claude-4")).toBeCloseTo(11.475, 6);
    expect(costPerModel.get("gpt-4o")).toBeCloseTo(0.5, 6);
    expect(totalCost).toBeCloseTo(11.975, 6);
    expect(unknownModels).toEqual([]);
  });

  it("modelo sin precio -> unknownModels y no aporta costo", () => {
    const table = parsePriceTable(JSON.stringify({ "claude-4": { input: 3, output: 15, cacheRead: 1, cacheWrite: 1 } }));
    const counts = new Map([
      ["claude-4", { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }],
      ["unknown-model-x", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }],
      ["unknown", { input: 500, output: 500, cacheRead: 0, cacheWrite: 0 }],
    ]);
    const { totalCost, unknownModels, knownCounts } = computeCost(counts, table);
    expect(unknownModels.sort()).toEqual(["unknown", "unknown-model-x"].sort());
    expect(knownCounts.has("unknown-model-x")).toBe(false);
    expect(totalCost).toBeCloseTo(0.018, 6); // (1000*3+1000*15)/1e6=0.018
  });

  it("TOKEN_PRICE_TABLE vacío o inválido -> tabla vacía", () => {
    expect(parsePriceTable("")).toEqual({});
    expect(parsePriceTable("   ")).toEqual({});
    expect(parsePriceTable("not json")).toEqual({});
    expect(parsePriceTable(JSON.stringify({ bad: "nope" }))).toEqual({});
  });

  it("pricing con cacheRead/cacheWrite snake_case parseado", () => {
    const table = parsePriceTable(JSON.stringify({ m: { input: 1, output: 1, cache_read: 0.5, cache_write: 0.5 } }));
    expect(table.m.cacheRead).toBe(0.5);
    expect(table.m.cacheWrite).toBe(0.5);
  });
});

describe("attribution split", () => {
  it("split igualitario suma exacto 100 con 2 decimales", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 10]) {
      const mods = Array.from({ length: n }, (_, i) => `mod-${i + 1}`);
      const attr = buildAttribution(mods);
      expect(attr.length).toBe(n);
      const sum = attr.reduce((a, x) => a + x.pct, 0);
      expect(sum).toBeCloseTo(100, 6);
      for (const a of attr) {
        // 2 decimales
        expect(Math.round(a.pct * 100) / 100).toBe(a.pct);
      }
    }
  });

  it("3 módulos -> 33.33,33.33,33.34 ordenados", () => {
    const attr = buildAttribution(["mod-1", "mod-2", "mod-3"]);
    expect(attr.map((a) => a.pct)).toEqual([33.33, 33.33, 33.34]);
    expect(attr.map((a) => a.module)).toEqual(["mod-1", "mod-2", "mod-3"]);
  });

  it("1 módulo -> 100", () => {
    expect(buildAttribution(["mod-1"])).toEqual([{ module: "mod-1", pct: 100 }]);
  });

  it("2 módulos -> 50,50", () => {
    expect(buildAttribution(["a", "b"]).map((x) => x.pct)).toEqual([50, 50]);
  });

  it("ordena módulos alfabéticamente antes de split", () => {
    const attr = buildAttribution(["mod-3", "mod-1", "mod-2"]);
    expect(attr.map((a) => a.module)).toEqual(["mod-1", "mod-2", "mod-3"]);
  });
});

describe("budget decision", () => {
  it("decide over cap correctamente", () => {
    expect(decideBudgetState(50, 50)).toBe(false);
    expect(decideBudgetState(50.001, 50)).toBe(true);
    expect(decideBudgetState(0, 50)).toBe(false);
    expect(decideBudgetState(100, 50)).toBe(true);
  });

  it("shouldPublishBudgetAlert transiciones", () => {
    // primera vez over -> pending
    expect(shouldPublishBudgetAlert(true, undefined)).toBe("pending");
    expect(shouldPublishBudgetAlert(true, false)).toBe("pending");
    expect(shouldPublishBudgetAlert(true, true)).toBe(null);
    // vuelve bajo cap -> resolved solo si antes over
    expect(shouldPublishBudgetAlert(false, true)).toBe("resolved");
    expect(shouldPublishBudgetAlert(false, false)).toBe(null);
    expect(shouldPublishBudgetAlert(false, undefined)).toBe(null);
  });

  it("month bounds UTC", () => {
    const { from, to } = monthBoundsUtc("2026-08");
    expect(from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("monthStrFromDate usa UTC", () => {
    expect(monthStrFromDate(new Date("2026-08-17T23:00:00.000Z"))).toBe("2026-08");
    expect(monthStrFromDate(new Date("2026-08-01T00:00:00.000Z"))).toBe("2026-08");
  });
});

describe("alert shapes", () => {
  it("unknown_model alert tiene reason y pending", () => {
    const a = buildUnknownModelAlert("misterioso");
    expect(a.name).toBe("budget_tokens");
    expect(a.severity).toBe("warn");
    expect(a.detail).toMatchObject({ reason: "unknown_model", model: "misterioso", state: "pending" });
  });

  it("budget alert tiene fingerprint tenant:month", () => {
    const a = buildBudgetAlert({ tenant: "demo", month: "2026-08", costUsd: 60, capUsd: 50, state: "pending" });
    expect(a.detail.fingerprint).toBe("demo:2026-08");
    expect(a.detail.month).toBe("2026-08");
    expect(a.detail.cost_usd).toBe(60);
    expect(a.detail.state).toBe("pending");
    const b = buildBudgetAlert({ tenant: "demo", month: "2026-08", costUsd: 10, capUsd: 50, state: "resolved" });
    expect(b.detail.state).toBe("resolved");
    expect(b.detail.fingerprint).toBe("demo:2026-08");
  });

  it("topic es terra/{tenant}/platform/alert", () => {
    expect(alertTopic("demo")).toBe("terra/demo/platform/alert");
    expect(alertTopic("finca-1")).toBe("terra/finca-1/platform/alert");
  });
});

describe("register_movement shape (transport mockeado)", () => {
  beforeEach(() => {
    mockCallTool.mockReset();
    mockConnect.mockReset();
    mockClose.mockReset();
    mockTransportClose.mockReset();
  });

  it("construye args register_movement con shape esperado", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockTransportClose.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({
      structuredContent: { status: "registered", id: "uuid-1" },
      content: [{ type: "text", text: "Movimiento registrado uuid-1" }],
    });

    const attribution = buildAttribution(["mod-1", "mod-2"]);
    await registerMovementViaMcp("http://localhost:7761/mcp", {
      tenant: "demo",
      kind: "gasto",
      category: "software",
      currency: "USD",
      amount: 11.475,
      attribution,
      source_event: "auto:tokens:demo:2026-08-17",
      created_by: "token-meter",
      note: "tokens claude-4: in=1000 out=500",
    });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    const callArgs = mockCallTool.mock.calls[0][0] as { name: string; arguments: Record<string, unknown> };
    expect(callArgs.name).toBe("register_movement");
    const a = callArgs.arguments;
    expect(a.tenant).toBe("demo");
    expect(a.kind).toBe("gasto");
    expect(a.category).toBe("software");
    expect(a.currency).toBe("USD");
    expect(a.amount).toBe(11.475);
    expect(a.source_event).toBe("auto:tokens:demo:2026-08-17");
    expect(a.created_by).toBe("token-meter");
    expect(Array.isArray(a.attribution)).toBe(true);
    const sum = (a.attribution as Array<{ pct: number }>).reduce((s, x) => s + x.pct, 0);
    expect(sum).toBeCloseTo(100, 6);
    expect(typeof a.note).toBe("string");
  });

  it("detecta possible_duplicate y no registra error", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({
      structuredContent: { status: "possible_duplicate", existing_id: "existing-1" },
      content: [{ type: "text", text: "Posible duplicado mismo día" }],
    });
    const res = await registerMovementViaMcp("http://localhost:7761/mcp", {
      tenant: "demo",
      kind: "gasto",
      category: "software",
      currency: "USD",
      amount: 1,
      attribution: buildAttribution(["mod-1"]),
      source_event: "auto:tokens:demo:2026-08-17",
      created_by: "token-meter",
      note: "x",
    });
    expect(res.status).toBe("possible_duplicate");
    expect(res.id).toBe("existing-1");
  });

  it("detecta possible_duplicate vía texto plano", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "Posible duplicado mismo día\n{...}" }],
    });
    const res = await registerMovementViaMcp("http://localhost:7761/mcp", {
      tenant: "demo",
      kind: "gasto",
      category: "software",
      currency: "USD",
      amount: 1,
      attribution: buildAttribution(["mod-1"]),
      source_event: "auto:tokens:demo:2026-08-17",
      created_by: "token-meter",
      note: "x",
    });
    expect(res.status).toBe("possible_duplicate");
  });
});

describe("getTargetDate", () => {
  it("día anterior UTC", () => {
    expect(getTargetDate(new Date("2026-08-18T10:00:00.000Z"))).toBe("2026-08-17");
    expect(getTargetDate(new Date("2026-08-18T00:00:00.000Z"))).toBe("2026-08-17");
    expect(getTargetDate(new Date("2026-03-01T00:00:00.000Z"))).toBe("2026-02-28");
  });

  it("isTargetDay respeta UTC", () => {
    const target = "2026-08-17";
    expect(isTargetDay(Date.UTC(2026, 7, 17, 23, 59, 59), target)).toBe(true);
    expect(isTargetDay(Date.UTC(2026, 7, 18, 0, 0, 0), target)).toBe(false);
    expect(isTargetDay(Date.UTC(2026, 7, 16, 23, 59, 59), target)).toBe(false);
  });
});

describe("extractTimestamp / extractUsage defensivo", () => {
  it("extractTimestamp tolera número como string", () => {
    expect(extractTimestamp({ timestamp: String(tsUtc(2026, 8, 17)) })).toBe(tsUtc(2026, 8, 17));
  });
  it("extractUsage null si no es objeto", () => {
    expect(extractUsage({})).toBe(null);
    expect(extractUsage({ usage: null } as unknown as Record<string, unknown>)).toBe(null);
  });
  it("extractModel default unknown", () => {
    expect(extractModel({})).toBe("unknown");
    expect(extractModel({ model: "" })).toBe("unknown");
    expect(extractModel({ model: "  gpt-4o " })).toBe("gpt-4o");
  });
});

describe("formatNote", () => {
  it("formatea conteos por modelo y trunca a 800", () => {
    const counts = new Map([
      ["a", { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }],
      ["b", { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }],
    ]);
    const costs = new Map([["a", 0.001], ["b", 0.002]]);
    const note = formatNote(counts, costs);
    expect(note).toContain("a: in=100");
    expect(note).toContain("b: in=200");
    expect(note.length).toBeLessThanOrEqual(800);
  });
});
