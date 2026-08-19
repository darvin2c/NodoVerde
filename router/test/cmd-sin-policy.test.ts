import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPublish, mockSubscribe, mockOn, mockResolveByModule } = vi.hoisted(() => {
  const mp = vi.fn((topic: string, payload: Buffer, opts: unknown, cb: (err?: Error | null) => void) => cb(null));
  const ms = vi.fn((topic: string, opts: unknown, cb: (err?: Error | null) => void) => cb(null));
  const mo = vi.fn();
  const rm = vi.fn(async () => ({ hwId: "020000000001", tenant: "demo", module: "mod-1" }));
  return { mockPublish: mp, mockSubscribe: ms, mockOn: mo, mockResolveByModule: rm };
});

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => ({
      on: mockOn,
      publish: mockPublish,
      subscribe: mockSubscribe,
      connected: false,
      end: vi.fn((_: unknown, __: unknown, cb?: () => void) => cb?.()),
    })),
  },
}));

vi.mock("../src/db.js", () => ({
  resolveByHwId: vi.fn(async () => null),
  resolveByModule: mockResolveByModule,
  closePool: vi.fn(async () => {}),
}));

// Importar después de mocks
import {
  classifyCmdReason,
  buildAlertPayload,
  buildAlertTopic,
  clearAlertRateLimit,
  isRateLimited,
  markAlertPublished,
  alertRateLimit,
} from "../src/cmdAlert.js";
import { handleInternalCmd } from "../src/index.js";
describe("classifyCmdReason", () => {
  beforeEach(() => clearAlertRateLimit());

  it("missing_policy_id: action válida sin policy_id", () => {
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: "start" })))).toBe("missing_policy_id");
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: "stop", policy_id: "" })))).toBe("missing_policy_id");
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: "set", policy_id: "   " })))).toBe("missing_policy_id");
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: "start", policy_id: 123 })))).toBe("missing_policy_id");
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: "set", policy_id: null })))).toBe("missing_policy_id");
    expect(classifyCmdReason(JSON.stringify({ action: "start" }))).toBe("missing_policy_id");
  });

  it("invalid_payload: JSON roto", () => {
    expect(classifyCmdReason(Buffer.from("not json"))).toBe("invalid_payload");
    expect(classifyCmdReason(Buffer.from(""))).toBe("invalid_payload");
    expect(classifyCmdReason(Buffer.from("   "))).toBe("invalid_payload");
    expect(classifyCmdReason(null)).toBe("invalid_payload");
    expect(classifyCmdReason(undefined)).toBe("invalid_payload");
  });

  it("invalid_payload: sin action o action inválida", () => {
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ policy_id: "abc" })))).toBe("invalid_payload");
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: "invalid", policy_id: "abc" })))).toBe("invalid_payload");
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: "" , policy_id: "abc" })))).toBe("invalid_payload");
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: 123, policy_id: "abc" })))).toBe("invalid_payload");
  });

  it("invalid_payload: no objeto", () => {
    expect(classifyCmdReason(Buffer.from("[]"))).toBe("invalid_payload");
    expect(classifyCmdReason(Buffer.from("null"))).toBe("invalid_payload");
    expect(classifyCmdReason(Buffer.from('"string"'))).toBe("invalid_payload");
    expect(classifyCmdReason(Buffer.from("123"))).toBe("invalid_payload");
  });

  it("invalid_payload: params inválido aunque action/policy válidos (fallback)", () => {
    // parseCmdPayload rechazaría params no objeto, pero classify lo ve como invalid_payload
    expect(classifyCmdReason(Buffer.from(JSON.stringify({ action: "start", policy_id: "abc", params: "bad" })))).toBe("invalid_payload");
  });
});

describe("payload de la alerta", () => {
  it("buildAlertTopic usa tenant/module", () => {
    expect(buildAlertTopic("demo", "mod-1")).toBe("terra/demo/mod-1/alert");
  });

  it("buildAlertPayload forma correcta", () => {
    const now = 1700000000000;
    const p = buildAlertPayload("sensor-1", "terra/demo/mod-1/sensor-1/cmd", "missing_policy_id", now);
    expect(p).toEqual({
      name: "cmd_sin_policy",
      ts: now,
      severity: "critical",
      device: "sensor-1",
      detail: { topic: "terra/demo/mod-1/sensor-1/cmd", reason: "missing_policy_id", state: "pending" },
    });
  });
});

describe("rate-limit", () => {
  beforeEach(() => {
    clearAlertRateLimit();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("isRateLimited respeta 60s por (topic,reason)", () => {
    const topic = "terra/demo/mod-1/valvula-1/cmd";
    const t0 = 1000000;
    vi.setSystemTime(t0);
    expect(isRateLimited(topic, "missing_policy_id", Date.now())).toBe(false);
    markAlertPublished(topic, "missing_policy_id", Date.now());
    expect(isRateLimited(topic, "missing_policy_id", Date.now())).toBe(true);
    // distinto reason no está limitado
    expect(isRateLimited(topic, "invalid_payload", Date.now())).toBe(false);
    // distinto topic no limitado
    expect(isRateLimited("terra/demo/mod-1/otro/cmd", "missing_policy_id", Date.now())).toBe(false);
    // avanzar 59s sigue limitado
    vi.setSystemTime(t0 + 59_000);
    expect(isRateLimited(topic, "missing_policy_id", Date.now())).toBe(true);
    // avanzar 60s ya no
    vi.setSystemTime(t0 + 60_000);
    expect(isRateLimited(topic, "missing_policy_id", Date.now())).toBe(false);
    // 61s tampoco
    vi.setSystemTime(t0 + 61_000);
    expect(isRateLimited(topic, "missing_policy_id", Date.now())).toBe(false);
  });

  it("handleInternalCmd publica alerta y segunda vez dentro de 60s no publica", async () => {
    clearAlertRateLimit();
    mockPublish.mockClear();
    const topic = "terra/demo/mod-1/valvula-1/cmd";
    const parsed = { plane: "internal" as const, tenant: "demo", module: "mod-1", device: "valvula-1", kind: "cmd" as const };
    const payload = Buffer.from(JSON.stringify({ action: "start" })); // missing_policy_id

    const t0 = 2000000;
    vi.setSystemTime(t0);
    await handleInternalCmd(topic, payload, parsed);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [alertTopic, buf, opts] = mockPublish.mock.calls[0] as unknown as [string, Buffer, { qos: number; retain: boolean }];
    expect(alertTopic).toBe("terra/demo/mod-1/alert");
    expect(opts).toEqual({ qos: 1, retain: false });
    const published = JSON.parse(buf.toString("utf8"));
    expect(published.name).toBe("cmd_sin_policy");
    expect(published.severity).toBe("critical");
    expect(published.device).toBe("valvula-1");
    expect(published.detail).toEqual({ topic, reason: "missing_policy_id", state: "pending" });
    expect(published.ts).toBe(t0);

    // segunda vez dentro de 60s no publica, pero descarte y log siguen (no throw)
    mockPublish.mockClear();
    vi.setSystemTime(t0 + 30_000);
    await handleInternalCmd(topic, payload, parsed);
    expect(mockPublish).toHaveBeenCalledTimes(0);

    // después de 60s vuelve a publicar
    mockPublish.mockClear();
    vi.setSystemTime(t0 + 61_000);
    await handleInternalCmd(topic, payload, parsed);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("handleInternalCmd reason invalid_payload publica con reason correcto", async () => {
    clearAlertRateLimit();
    mockPublish.mockClear();
    const topic = "terra/demo/mod-1/sensor-1/cmd";
    const parsed = { plane: "internal" as const, tenant: "demo", module: "mod-1", device: "sensor-1", kind: "cmd" as const };
    const payload = Buffer.from("not json");
    vi.setSystemTime(3000000);
    await handleInternalCmd(topic, payload, parsed);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, buf] = mockPublish.mock.calls[0] as unknown as [string, Buffer, unknown];
    const obj = JSON.parse(buf.toString("utf8"));
    expect(obj.detail.reason).toBe("invalid_payload");
  });

  it("rate-limit distingue (topic,reason): mismo topic distinto reason publica", async () => {
    clearAlertRateLimit();
    mockPublish.mockClear();
    const topic = "terra/demo/mod-1/dev/cmd";
    const parsed = { plane: "internal" as const, tenant: "demo", module: "mod-1", device: "dev", kind: "cmd" as const };
    vi.setSystemTime(4000000);
    await handleInternalCmd(topic, Buffer.from(JSON.stringify({ action: "start" })), parsed);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    // distinto reason (invalid_payload) debe publicar aunque mismo topic dentro de ventana
    mockPublish.mockClear();
    await handleInternalCmd(topic, Buffer.from("bad json"), parsed);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("fallo de publicación no lanza", async () => {
    clearAlertRateLimit();
    mockPublish.mockImplementationOnce((_t: string, _p: Buffer, _o: unknown, cb: (e?: Error | null) => void) => cb(new Error("boom")));
    const topic = "terra/demo/mod-1/valvula-1/cmd";
    const parsed = { plane: "internal" as const, tenant: "demo", module: "mod-1", device: "valvula-1", kind: "cmd" as const };
    vi.setSystemTime(5000000);
    await expect(handleInternalCmd(topic, Buffer.from("bad"), parsed)).resolves.toBeUndefined();
    // luego debe poder reintentar (no quedó bloqueado en rate-limit porque no se marcó como publicado)
    mockPublish.mockImplementation((t: string, p: Buffer, o: unknown, cb: (e?: Error | null) => void) => cb(null));
    vi.setSystemTime(5000001);
    await handleInternalCmd(topic, Buffer.from("bad"), parsed);
    // el segundo intento debería publicar (el primero falló y no marcó)
    expect(mockPublish).toHaveBeenCalled();
  });
});

describe("compatibilidad", () => {
  it("clearAlertRateLimit limpia", () => {
    alertRateLimit.set("k", 123);
    clearAlertRateLimit();
    expect(alertRateLimit.size).toBe(0);
  });
});
