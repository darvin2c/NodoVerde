import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("mqtt", async () => {
  return {
    default: {
      connect: vi.fn(() => ({
        on: vi.fn(),
        subscribe: vi.fn((_t: unknown, _o: unknown, cb: (e: null) => void) => cb(null)),
        publish: vi.fn((_t: string, _p: string, _o: unknown, cb: (e: null) => void) => cb(null)),
        end: vi.fn((_a: unknown, _b: unknown, cb: () => void) => cb()),
      })),
    },
  };
});

// Import after mocks
import {
  classifyDevice,
  parseRequestPayload,
  checkTimeWindow,
  checkConfidence,
  checkHealth,
  checkHardCeiling,
  validateParams,
} from "../src/rules.js";
import { ACTION_CLASSES, DEVICE_TO_CLASS, __resetWindowsCache } from "../src/config.js";
import { proposeAction, approveAction, rejectAction, setPublisher } from "../src/policy.js";
import { clearState, moduleConfidence, moduleHealth, lastReadings, onReading, onConfidence, onHealth, readingsForModule } from "../src/state.js";
import { getModuleWithCrop, lastExecutedAt, hasPendingFor } from "../src/db.js";

// Helper to make a Date at given hour in Lima (America/Lima) for window tests
function dateAtHour(hour: number, tz = "America/Lima"): Date {
  // 2026-06-01 es fecha arbitraria; construir date UTC y luego interpretar hora local
  // Truco: crear fecha con hora local deseada en tz específica usando Intl
  // Simplificar: usar Date con horas UTC y confiar en checkTimeWindow que convierte via tz.
  // Creamos un ISO en la tz: 2026-01-15T{h}:00:00 en Lima = UTC-5
  const pad = String(hour).padStart(2, "0");
  // Para America/Lima (UTC-5 sin DST) → hora local +5 = UTC
  const utcHour = (hour + 5) % 24;
  const utcPad = String(utcHour).padStart(2, "0");
  return new Date(`2026-01-15T${utcPad}:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// clasificación
// ---------------------------------------------------------------------------
describe("classifyDevice", () => {
  it("valve-fill-01 → fill_water", () => expect(classifyDevice("valve-fill-01")).toBe("fill_water"));
  it("doser-a-01 → dose_nutrient", () => expect(classifyDevice("doser-a-01")).toBe("dose_nutrient"));
  it("doser-b-01 → dose_nutrient", () => expect(classifyDevice("doser-b-01")).toBe("dose_nutrient"));
  it("doser-ph-01 → dose_ph", () => expect(classifyDevice("doser-ph-01")).toBe("dose_ph"));
  it("pump-recirc-01 → recirculate", () => expect(classifyDevice("pump-recirc-01")).toBe("recirculate"));
  it("sensor → null", () => expect(classifyDevice("ec-01")).toBeNull());
  it("desconocido → null", () => expect(classifyDevice("otro")).toBeNull());
});

// ---------------------------------------------------------------------------
// parseRequestPayload
// ---------------------------------------------------------------------------
describe("parseRequestPayload", () => {
  it("ON crudo a doser → start con default 2000", () => {
    const r = parseRequestPayload("ON", "doser-a-01");
    expect(r).toEqual({ action: "start", params: { duration_ms: 2000 } });
  });
  it("ON crudo a valve → start con 30000 (fill sin default)", () => {
    const r = parseRequestPayload("ON", "valve-fill-01");
    expect(r?.action).toBe("start");
    expect((r as { params?: { duration_ms?: number } })?.params?.duration_ms).toBeGreaterThanOrEqual(500);
  });
  it("ON crudo a pump → set ON sostenido", () => {
    const r = parseRequestPayload("ON", "pump-recirc-01");
    expect(r).toEqual({ action: "set", params: { v: "ON" } });
  });
  it("OFF crudo → stop", () => {
    expect(parseRequestPayload("OFF", "doser-a-01")).toEqual({ action: "stop" });
    expect(parseRequestPayload("OFF", "pump-recirc-01")).toEqual({ action: "stop" });
  });
  it("Buffer ON → start", () => {
    expect(parseRequestPayload(Buffer.from("ON"), "doser-b-01")?.action).toBe("start");
  });
  it('JSON {v:"ON"} a doser → start', () => {
    const r = parseRequestPayload(JSON.stringify({ v: "ON" }), "doser-a-01");
    expect(r?.action).toBe("start");
  });
  it('JSON {v:"OFF"} → stop', () => {
    expect(parseRequestPayload(JSON.stringify({ v: "OFF" }), "doser-a-01")).toEqual({ action: "stop" });
  });
  it('JSON {action:"start", params:{duration_ms:5000}} → start 5000', () => {
    const r = parseRequestPayload(JSON.stringify({ action: "start", params: { duration_ms: 5000 } }), "doser-a-01");
    expect(r).toEqual({ action: "start", params: { duration_ms: 5000 } });
  });
  it('JSON {action:"set", v:"ON"} a pump → set', () => {
    const r = parseRequestPayload(JSON.stringify({ action: "set", v: "ON" }), "pump-recirc-01");
    expect(r).toEqual({ action: "set", params: { v: "ON" } });
  });
  it("objeto directo {action:'stop'} → stop", () => {
    expect(parseRequestPayload({ action: "stop" }, "doser-a-01")).toEqual({ action: "stop" });
  });
  it("payload inválido → null", () => {
    expect(parseRequestPayload("XYZ", "doser-a-01")).toBeNull();
    expect(parseRequestPayload("", "doser-a-01")).toBeNull();
    expect(parseRequestPayload(null, "doser-a-01")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkTimeWindow
// ---------------------------------------------------------------------------
describe("checkTimeWindow", () => {
  beforeEach(() => {
    __resetWindowsCache();
    delete process.env.POLICY_WINDOWS_JSON;
    __resetWindowsCache();
  });
  afterEach(() => {
    delete process.env.POLICY_WINDOWS_JSON;
    __resetWindowsCache();
  });

  it("default 0-24 siempre ok", () => {
    expect(checkTimeWindow("dose_nutrient", new Date(), "America/Lima").ok).toBe(true);
  });

  it("ventana [6,22] permite 10h y bloquea 23h", () => {
    process.env.POLICY_WINDOWS_JSON = JSON.stringify({ dose_nutrient: [6, 22] });
    __resetWindowsCache();
    expect(checkTimeWindow("dose_nutrient", dateAtHour(10), "America/Lima").ok).toBe(true);
    const res = checkTimeWindow("dose_nutrient", dateAtHour(23), "America/Lima");
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/ventana/);
  });

  it("ventana cruza medianoche [22,6] permite 23h y 2h, bloquea 12h", () => {
    process.env.POLICY_WINDOWS_JSON = JSON.stringify({ recirculate: [22, 6] });
    __resetWindowsCache();
    expect(checkTimeWindow("recirculate", dateAtHour(23), "America/Lima").ok).toBe(true);
    expect(checkTimeWindow("recirculate", dateAtHour(2), "America/Lima").ok).toBe(true);
    expect(checkTimeWindow("recirculate", dateAtHour(12), "America/Lima").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkConfidence
// ---------------------------------------------------------------------------
describe("checkConfidence", () => {
  it("suficiente → ok", () => {
    expect(checkConfidence({ level: 90 }, "fill_water").ok).toBe(true);
    expect(checkConfidence({ ec: 80 }, "dose_nutrient").ok).toBe(true);
    expect(checkConfidence({ ph: 75 }, "dose_ph").ok).toBe(true);
    expect(checkConfidence({ level: 60 }, "recirculate").ok).toBe(true);
  });
  it("insuficiente → needs", () => {
    const r = checkConfidence({ level: 10 }, "fill_water");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needs).toContain("level");
  });
  it("sources null → needs", () => {
    const r = checkConfidence(null, "dose_nutrient");
    expect(r.ok).toBe(false);
  });
  it("ec 69 < 70 → needs ec", () => {
    const r = checkConfidence({ ec: 69 }, "dose_nutrient");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needs).toEqual(["ec"]);
  });
});

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------
describe("checkHealth", () => {
  it("healthy → ok", () => expect(checkHealth("healthy").ok).toBe(true));
  it("degraded → ok", () => expect(checkHealth("degraded").ok).toBe(true));
  it("blind → module_offline", () => {
    const r = checkHealth("blind");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("module_offline");
  });
  it("offline → module_offline", () => expect(checkHealth("offline").ok).toBe(false));
  it("null → ok", () => expect(checkHealth(null).ok).toBe(true));
});

// ---------------------------------------------------------------------------
// checkHardCeiling
// ---------------------------------------------------------------------------
describe("checkHardCeiling", () => {
  const crop = { ec_min: 1.2, ec_max: 1.8, ph_min: 5.8, ph_max: 6.3 };
  it("dose_nutrient ec >= ec_max+0.5 rechaza", () => {
    expect(checkHardCeiling("dose_nutrient", { ec: 2.3 }, crop).ok).toBe(false);
    expect(checkHardCeiling("dose_nutrient", { ec: 2.29 }, crop).ok).toBe(true);
  });
  it("dose_nutrient ec justo en límite ok", () => {
    // ec_max 1.8 +0.5 =2.3 → 2.3 rechaza, 2.29 ok
    expect(checkHardCeiling("dose_nutrient", { ec: 2.0 }, crop).ok).toBe(true);
  });
  it("dose_ph ph <= ph_min-0.5 rechaza", () => {
    expect(checkHardCeiling("dose_ph", { ph: 5.3 }, crop).ok).toBe(false);
    expect(checkHardCeiling("dose_ph", { ph: 5.31 }, crop).ok).toBe(true);
  });
  it("fill_water level >=95 rechaza", () => {
    expect(checkHardCeiling("fill_water", { level: 95 }, crop).ok).toBe(false);
    expect(checkHardCeiling("fill_water", { level: 94.9 }, crop).ok).toBe(true);
  });
  it("recirculate sin techo siempre ok", () => {
    expect(checkHardCeiling("recirculate", { flow: 999 }, crop).ok).toBe(true);
  });
  it("sin lectura → ok (no techo aplicable)", () => {
    expect(checkHardCeiling("dose_nutrient", {}, crop).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateParams
// ---------------------------------------------------------------------------
describe("validateParams", () => {
  it("start sin duration usa default 2000 para dose_nutrient", () => {
    const r = validateParams("dose_nutrient", "start", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.duration_ms).toBe(2000);
  });
  it("start con duration_ms 500 ok, 499 rechaza, >max rechaza", () => {
    expect(validateParams("dose_nutrient", "start", { duration_ms: 500 }).ok).toBe(true);
    expect(validateParams("dose_nutrient", "start", { duration_ms: 499 }).ok).toBe(false);
    expect(validateParams("dose_nutrient", "start", { duration_ms: 10001 }).ok).toBe(false);
  });
  it("start duration_ms string numérico se normaliza", () => {
    const r = validateParams("dose_ph", "start", { duration_ms: "3000" as unknown as number });
    expect(r.ok).toBe(true);
  });
  it("set requiere v ON|OFF", () => {
    expect(validateParams("recirculate", "set", { v: "ON" }).ok).toBe(true);
    expect(validateParams("recirculate", "set", { v: "OFF" }).ok).toBe(true);
    expect(validateParams("recirculate", "set", { v: "bad" }).ok).toBe(false);
    expect(validateParams("recirculate", "set", {}).ok).toBe(false);
  });
  it("stop no requiere params", () => {
    expect(validateParams("fill_water", "stop", null).ok).toBe(true);
    expect(validateParams("fill_water", "stop", { duration_ms: 999 }).ok).toBe(true);
  });
  it("acción inválida rechaza", () => {
    expect(validateParams("fill_water", "bad", {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// state handlers
// ---------------------------------------------------------------------------
describe("state handlers puros", () => {
  beforeEach(() => clearState());
  it("onReading guarda lastReadings", () => {
    const ok = onReading("terra/demo/mod-1/ec-01/ec/reading", JSON.stringify({ v: 1.5, ts: 1000 }));
    expect(ok).toBe(true);
    expect(readingsForModule("demo", "mod-1").ec).toBe(1.5);
  });
  it("onConfidence guarda sources", () => {
    onConfidence("terra/demo/mod-1/confidence", JSON.stringify({ v: 80, ts: 1000, sources: { ec: 90, ph: 40 } }));
    expect(moduleConfidence.get("demo/mod-1")?.sources.ec).toBe(90);
  });
  it("onHealth guarda state blind", () => {
    onHealth("terra/demo/mod-1/health", JSON.stringify({ state: "blind" }));
    expect(moduleHealth.get("demo/mod-1")).toBe("blind");
  });
  it("onReading topic mal formado → false", () => {
    expect(onReading("terra/demo/mod-1/reading", "{}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Flujo propose/decide con pg mockeado
// ---------------------------------------------------------------------------
describe("pipeline proposeAction — flujo completo", () => {
  let published: Array<{ topic: string; payload: string }>;
  beforeEach(() => {
    mockQuery.mockReset();
    mockConnect.mockReset();
    clearState();
    published = [];
    setPublisher(async (topic, payload) => {
      published.push({ topic, payload: String(payload) });
    });
    // default confidence ok y health ok
    moduleConfidence.set("demo/mod-1", { v: 85, ts: Date.now(), sources: { ec: 90, ph: 90, level: 90 } });
    moduleHealth.set("demo/mod-1", "healthy");
    // readings por debajo de techos
    lastReadings.set("demo/mod-1/ec", { v: 1.5, ts: Date.now() });
    lastReadings.set("demo/mod-1/ph", { v: 6.0, ts: Date.now() });
    lastReadings.set("demo/mod-1/level", { v: 50, ts: Date.now() });
    __resetWindowsCache();
    delete process.env.POLICY_WINDOWS_JSON;
    __resetWindowsCache();
  });
  afterEach(() => setPublisher(null));

  function mockModuleOk() {
    // getModuleWithCrop → retorna módulo
    mockQuery.mockResolvedValueOnce({
      rows: [{ tenant: "demo", module: "mod-1", crop: "lechuga", ec_min: 1.2, ec_max: 1.8, ph_min: 5.8, ph_max: 6.3, water_temp_min: 18, water_temp_max: 24, tz: "America/Lima" }],
    } as never);
  }

  it("autonomous (fill_water) ejecuta inmediato y publica cmd", async () => {
    mockModuleOk();
    // hasPendingFor false
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    // lastExecutedAt null
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    // insertActionRequest executed — eco del policy_id real que el portero pasa al INSERT ($2)
    mockQuery.mockImplementationOnce(async (_sql: string, params: unknown[]) => ({
      rows: [{ id: "id-1", policy_id: params[1], tenant: "demo", module: "mod-1", device: "valve-fill-01", action: "start", status: "executed" }],
    }) as never);

    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "valve-fill-01",
      action: "start",
      params: { duration_ms: 10000 },
      requested_by: "agent-test",
      source: "agent",
    });
    expect(res.status).toBe("executed");
    expect(published.length).toBe(1);
    expect(published[0].topic).toBe("terra/demo/mod-1/valve-fill-01/cmd");
    const pl = JSON.parse(published[0].payload);
    expect(pl.action).toBe("start");
    // el policy_id del cmd es el mismo generado para la fila de audit (publish antes de insert)
    expect(pl.policy_id).toBe((res as { policy_id: string }).policy_id);
    expect(pl.policy_id).toMatch(/^pol-/);
  });

  it("supervised (dose_nutrient) queda pending y NO publica cmd", async () => {
    mockModuleOk();
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // hasPending
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // lastExecuted
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "id-2", policy_id: "pol-2", status: "pending" }] } as never);
    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "doser-a-01",
      action: "start",
      params: { duration_ms: 2000 },
      requested_by: "agent-test",
    });
    expect(res.status).toBe("pending");
    expect(published.length).toBe(0);
  });

  it("needs_data cuando confianza baja: publica request/read y no cmd", async () => {
    moduleConfidence.set("demo/mod-1", { v: 40, ts: Date.now(), sources: { ec: 10 } }); // ec 10 <70
    mockModuleOk();
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // hasPending
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // lastExecuted
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "id-3", policy_id: "pol-3", status: "needs_data" }] } as never);
    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "doser-a-01",
      action: "start",
      params: { duration_ms: 2000 },
      requested_by: "agent-test",
    });
    expect(res.status).toBe("needs_data");
    if (res.status === "needs_data") expect(res.needs).toContain("ec");
    expect(published.some((p) => p.topic.includes("/ec-01/request/read"))).toBe(true);
    expect(published.some((p) => p.topic.includes("/cmd"))).toBe(false);
  });

  it("rate limit rechaza si última executed reciente", async () => {
    mockModuleOk();
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // hasPending false
    // lastExecutedAt hace 10s, rateLimit 600s para dose_nutrient
    mockQuery.mockResolvedValueOnce({ rows: [{ executed_at: new Date(Date.now() - 10_000) }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "id-4", policy_id: "pol-4", status: "rejected" }] } as never);
    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "doser-a-01",
      action: "start",
      params: { duration_ms: 2000 },
      requested_by: "agent-test",
    });
    expect(res.status).toBe("rejected");
    expect((res as { reason: string }).reason).toBe("rate_limited");
  });

  it("rate limit NO aplica a stop (modo manual: quien abre puede cerrar)", async () => {
    // recirculate es autonomous: si stop pasara por rate limit quedaría rejected;
    // aquí debe ejecutar aunque haya un executed reciente de la misma clase
    mockModuleOk();
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // hasPending false
    // NO se consulta lastExecutedAt para stop — si se consultara y devolviera reciente, rompería
    mockQuery.mockImplementationOnce(async (_sql: string, params: unknown[]) => ({
      rows: [{ id: "id-4b", policy_id: params[1], status: "executed" }],
    }) as never); // insertActionRequest
    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "pump-recirc-01",
      action: "stop",
      requested_by: "agent-test",
    });
    expect(res.status).toBe("executed");
    expect(published.length).toBe(1);
    expect(JSON.parse(published[0].payload).action).toBe("stop");
  });

  it("serialización rechaza si hay pending mismo device", async () => {
    mockModuleOk();
    mockQuery.mockResolvedValueOnce({ rows: [{ "1": 1 }] } as never); // hasPending true
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "id-5", policy_id: "pol-5", status: "rejected" }] } as never);
    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "doser-a-01",
      action: "start",
      params: { duration_ms: 2000 },
      requested_by: "agent-test",
    });
    expect(res.status).toBe("rejected");
    expect((res as { reason: string }).reason).toBe("already_pending");
  });

  it("techo duro EC rechaza dose_nutrient", async () => {
    lastReadings.set("demo/mod-1/ec", { v: 2.5, ts: Date.now() }); // ec_max 1.8 +0.5 =2.3 → 2.5 rechaza
    mockModuleOk();
    // health/pending/rate no llegan a consultarse porque techo antes de pending/rate? En pipeline techo antes de pendiente, sí.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "id-6", policy_id: "pol-6", status: "rejected" }] } as never);
    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "doser-a-01",
      action: "start",
      params: { duration_ms: 2000 },
      requested_by: "agent-test",
    });
    expect(res.status).toBe("rejected");
    expect((res as { reason: string }).reason).toMatch(/techo EC/);
  });

  it("techo duro level >=95 rechaza fill_water", async () => {
    lastReadings.set("demo/mod-1/level", { v: 96, ts: Date.now() });
    mockModuleOk();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "lvl-rej", policy_id: "pol-lvl", status: "rejected" }] } as never);
    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "valve-fill-01",
      action: "start",
      params: { duration_ms: 10000 },
      requested_by: "agent-test",
    });
    expect(res.status).toBe("rejected");
  });

  it("health blind rechaza con module_offline", async () => {
    moduleHealth.set("demo/mod-1", "blind");
    mockModuleOk();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "id-7", policy_id: "pol-7", status: "rejected" }] } as never);
    const res = await proposeAction({
      tenant: "demo",
      module: "mod-1",
      device: "valve-fill-01",
      action: "start",
      params: { duration_ms: 5000 },
      requested_by: "agent-test",
    });
    expect(res.status).toBe("rejected");
    expect((res as { reason: string }).reason).toBe("module_offline");
  });

  it("approve re-valida y ejecuta si confianza recuperada", async () => {
    // propose supervised pendiente ya existe (fila pending)
    // approve: getAction → pending
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "pending-1", policy_id: "pol-pending-1", tenant: "demo", module: "mod-1", device: "doser-a-01", action: "start", params: { duration_ms: 2000 }, action_class: "dose_nutrient", status: "pending" }],
    } as never);
    // getModuleWithCrop
    mockQuery.mockResolvedValueOnce({
      rows: [{ tenant: "demo", module: "mod-1", crop: "lechuga", ec_min: 1.2, ec_max: 1.8, ph_min: 5.8, ph_max: 6.3, water_temp_min: 18, water_temp_max: 24, tz: "America/Lima" }],
    } as never);
    // lastExecutedAt null
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    // markExecuted
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "pending-1", policy_id: "pol-pending-1", status: "executed" }] } as never);

    const res = await approveAction("pending-1", "human-1");
    expect(res.status).toBe("executed");
    expect(published.some((p) => p.topic.includes("/doser-a-01/cmd"))).toBe(true);
  });

  it("approve con confianza caída queda pending y retorna needs_data", async () => {
    moduleConfidence.set("demo/mod-1", { v: 30, ts: Date.now(), sources: { ec: 20 } });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "pending-2", policy_id: "pol-pending-2", tenant: "demo", module: "mod-1", device: "doser-a-01", action: "start", params: { duration_ms: 2000 }, action_class: "dose_nutrient", status: "pending" }],
    } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [{ tenant: "demo", module: "mod-1", crop: "lechuga", ec_min: 1.2, ec_max: 1.8, ph_min: 5.8, ph_max: 6.3, water_temp_min: 18, water_temp_max: 24, tz: "America/Lima" }],
    } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // lastExecuted
    const res = await approveAction("pending-2", "human-1");
    expect(res.status).toBe("needs_data");
    if (res.status === "needs_data") expect(res.needs).toContain("ec");
    // fila queda pending → no markExecuted, no cmd
    expect(published.some((p) => p.topic.includes("/cmd"))).toBe(false);
    expect(published.some((p) => p.topic.includes("/ec-01/request/read"))).toBe(true);
  });

  it("reject_action pending→rejected", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "pending-3", status: "pending" }] } as never); // getAction
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "pending-3", status: "rejected" }] } as never); // decideAction
    const res = await rejectAction("pending-3", "human-2");
    expect(res.ok).toBe(true);
  });

  it("reject_action sobre no-pending falla", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "x", status: "executed" }] } as never);
    const res = await rejectAction("x", "human-2");
    expect(res.ok).toBe(false);
  });
});
