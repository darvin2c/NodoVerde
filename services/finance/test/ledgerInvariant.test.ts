import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

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

const { mockMqttConnect, mockPublish } = vi.hoisted(() => ({
  mockPublish: vi.fn((topic: string, payload: string, opts: unknown, cb: (err?: Error) => void) => cb()),
  mockMqttConnect: vi.fn(() => ({
    publish: mockPublish,
    on: vi.fn(),
    end: vi.fn(),
    connected: true,
    subscribe: vi.fn(),
  })),
}));

vi.mock("mqtt", async () => {
  const actual = await vi.importActual<typeof import("mqtt")>("mqtt");
  return {
    ...actual,
    default: {
      ...actual.default,
      connect: mockMqttConnect,
    },
  };
});

import {
  LEDGER_VIOLATION_SQL,
  fingerprintForIds,
  fetchViolations,
  runLedgerCheck,
  pendingAlerts,
  resetPending,
  parseLedgerCheckIntervalHours,
  getLedgerCheckIntervalMs,
  FIRST_RUN_MS,
} from "../src/ledgerInvariant.js";

function makeClient() {
  const publish = vi.fn((topic: string, payload: string, opts: unknown, cb: (err?: Error) => void) => cb());
  const client = {
    publish,
    on: vi.fn(),
    connected: true,
  } as unknown as import("mqtt").MqttClient & { publish: typeof publish };
  return { client, publish };
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

describe("ledgerInvariant — SQL de violaciones", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    resetPending();
  });

  it("SQL filtra vigentes y detecta invariantes en SQL", () => {
    expect(LEDGER_VIOLATION_SQL).toMatch(/voided_by IS NULL/);
    expect(LEDGER_VIOLATION_SQL).toMatch(/anula_a IS NULL/);
    expect(LEDGER_VIOLATION_SQL).toMatch(/attribution IS NULL/);
    expect(LEDGER_VIOLATION_SQL).toMatch(/jsonb_typeof\(attribution\)/);
    expect(LEDGER_VIOLATION_SQL).toMatch(/jsonb_array_elements/);
    expect(LEDGER_VIOLATION_SQL).toMatch(/0\.001/);
    expect(LEDGER_VIOLATION_SQL).toMatch(/btrim\(category\)/);
    expect(LEDGER_VIOLATION_SQL).toMatch(/btrim\(currency\)/);
    expect(LEDGER_VIOLATION_SQL).toMatch(/ABS/);
  });

  it("fetchViolations agrupa por tenant y ordena ids", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "b-id", tenant: "demo" },
        { id: "a-id", tenant: "demo" },
        { id: "c-id", tenant: "other" },
      ],
    } as never);
    const byTenant = await fetchViolations();
    expect(mockQuery).toHaveBeenCalledWith(LEDGER_VIOLATION_SQL);
    expect(byTenant.get("demo")).toEqual(["a-id", "b-id"]);
    expect(byTenant.get("other")).toEqual(["c-id"]);
  });

  it("fingerprint es sha256 de ids ordenados con join ,", () => {
    const ids = ["b", "a", "c"];
    expect(fingerprintForIds(ids)).toBe(sha256Hex("a,b,c"));
    expect(fingerprintForIds(["a", "b", "c"])).toBe(sha256Hex("a,b,c"));
    // orden no importa en input
    expect(fingerprintForIds(["c", "a", "b"])).toBe(fingerprintForIds(["a", "b", "c"]));
  });
});

describe("ledgerInvariant — parse env", () => {
  const orig = process.env.LEDGER_CHECK_INTERVAL_HOURS;
  afterEach(() => {
    if (orig === undefined) delete process.env.LEDGER_CHECK_INTERVAL_HOURS;
    else process.env.LEDGER_CHECK_INTERVAL_HOURS = orig;
  });

  it("default 24 si no hay env", () => {
    delete process.env.LEDGER_CHECK_INTERVAL_HOURS;
    expect(parseLedgerCheckIntervalHours()).toBe(24);
    expect(getLedgerCheckIntervalMs()).toBe(24 * 3600 * 1000);
  });

  it("parsea valor válido", () => {
    process.env.LEDGER_CHECK_INTERVAL_HOURS = "12";
    expect(parseLedgerCheckIntervalHours()).toBe(12);
  });

  it("fallback 24 si inválido o <=0", () => {
    process.env.LEDGER_CHECK_INTERVAL_HOURS = "0";
    expect(parseLedgerCheckIntervalHours()).toBe(24);
    process.env.LEDGER_CHECK_INTERVAL_HOURS = "-5";
    expect(parseLedgerCheckIntervalHours()).toBe(24);
    process.env.LEDGER_CHECK_INTERVAL_HOURS = "not-a-number";
    expect(parseLedgerCheckIntervalHours()).toBe(24);
  });

  it("FIRST_RUN_MS es 30s", () => {
    expect(FIRST_RUN_MS).toBe(30_000);
  });
});

describe("ledgerInvariant — runLedgerCheck publish logic", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockPublish.mockReset();
    resetPending();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("violation detectada → alerta pending critical a terra/{tenant}/platform/alert con detail correcto", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "id-2", tenant: "demo" },
        { id: "id-1", tenant: "demo" },
      ],
    } as never);
    const { client, publish } = makeClient();
    await runLedgerCheck(client, pendingAlerts);
    expect(publish).toHaveBeenCalledTimes(1);
    const firstCall = publish.mock.calls[0] as unknown as [string, string, { qos: number; retain: boolean }, unknown];
    const [topic, payload, opts] = firstCall;
    expect(topic).toBe("terra/demo/platform/alert");
    expect(opts).toEqual({ qos: 1, retain: false });
    const msg = JSON.parse(payload);
    expect(msg.name).toBe("invariant_ledger");
    expect(msg.severity).toBe("critical");
    expect(typeof msg.ts).toBe("number");
    expect(msg.detail.state).toBe("pending");
    expect(msg.detail.reason).toBeDefined();
    expect(msg.detail.movement_ids).toBe("id-1,id-2");
    expect(msg.detail.movement_count).toBe(2);
    expect(msg.detail.fingerprint).toBe(sha256Hex("id-1,id-2"));
    // pendiente en memoria
    expect(pendingAlerts.get("demo")?.fingerprint).toBe(sha256Hex("id-1,id-2"));
  });

  it("ledger sano sin pending previo → no publica", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    const { client, publish } = makeClient();
    await runLedgerCheck(client, pendingAlerts);
    expect(publish).not.toHaveBeenCalled();
    expect(pendingAlerts.size).toBe(0);
  });

  it("transición pending→resolved: primera corrida pending, segunda sano → resolved mismo fingerprint", async () => {
    // primera corrida con violaciones
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "id-1", tenant: "demo" },
        { id: "id-2", tenant: "demo" },
      ],
    } as never);
    const { client, publish } = makeClient();
    const pending = new Map<string, import("../src/ledgerInvariant.js").PendingInfo>();
    await runLedgerCheck(client, pending);
    expect(publish).toHaveBeenCalledTimes(1);
    const firstPayload = JSON.parse(publish.mock.calls[0][1] as string);
    const fingerprint = firstPayload.detail.fingerprint as string;
    expect(firstPayload.detail.state).toBe("pending");
    expect(firstPayload.detail.movement_ids).toBe("id-1,id-2");

    // segunda corrida sin violaciones → resolved
    publish.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await runLedgerCheck(client, pending);
    expect(publish).toHaveBeenCalledTimes(1);
    const secondCall = publish.mock.calls[0] as unknown as [string, string, { qos: number; retain: boolean }, unknown];
    const [topic2, payload2, opts2] = secondCall;
    expect(topic2).toBe("terra/demo/platform/alert");
    expect(opts2).toEqual({ qos: 1, retain: false });
    const msg2 = JSON.parse(payload2);
    expect(msg2.severity).toBe("critical");
    expect(msg2.detail.state).toBe("resolved");
    expect(msg2.detail.fingerprint).toBe(fingerprint);
    expect(msg2.detail.movement_ids).toBe("id-1,id-2");
    expect(msg2.detail.movement_count).toBe(2);
    expect(pending.size).toBe(0);
  });

  it("no republica pending si fingerprint idéntico", async () => {
    const pending = new Map<string, import("../src/ledgerInvariant.js").PendingInfo>();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "a", tenant: "demo" }],
    } as never);
    const { client, publish } = makeClient();
    await runLedgerCheck(client, pending);
    expect(publish).toHaveBeenCalledTimes(1);
    publish.mockClear();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "a", tenant: "demo" }],
    } as never);
    await runLedgerCheck(client, pending);
    expect(publish).not.toHaveBeenCalled();
  });

  it("violación cambia fingerprint → resuelve anterior y publica nuevo pending", async () => {
    const pending = new Map<string, import("../src/ledgerInvariant.js").PendingInfo>();
    const { client, publish } = makeClient();
    // primera
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "id-1", tenant: "demo" }] } as never);
    await runLedgerCheck(client, pending);
    const fp1 = sha256Hex("id-1");
    expect(pending.get("demo")?.fingerprint).toBe(fp1);
    publish.mockClear();
    // segunda con ids distintos
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "id-2", tenant: "demo" }] } as never);
    await runLedgerCheck(client, pending);
    expect(publish).toHaveBeenCalledTimes(2);
    const msgResolved = JSON.parse(publish.mock.calls[0][1] as string);
    const msgPending = JSON.parse(publish.mock.calls[1][1] as string);
    expect(msgResolved.detail.state).toBe("resolved");
    expect(msgResolved.detail.fingerprint).toBe(fp1);
    expect(msgPending.detail.state).toBe("pending");
    expect(msgPending.detail.fingerprint).toBe(sha256Hex("id-2"));
    expect(pending.get("demo")?.fingerprint).toBe(sha256Hex("id-2"));
  });

  it("multi-tenant: publica por cada tenant afectado", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "id-a", tenant: "demo" },
        { id: "id-b", tenant: "other" },
      ],
    } as never);
    const { client, publish } = makeClient();
    const pending = new Map<string, import("../src/ledgerInvariant.js").PendingInfo>();
    await runLedgerCheck(client, pending);
    expect(publish).toHaveBeenCalledTimes(2);
    const topics = publish.mock.calls.map((c) => c[0] as string).sort();
    expect(topics).toEqual(["terra/demo/platform/alert", "terra/other/platform/alert"].sort());
    const payloads = publish.mock.calls.map((c) => JSON.parse(c[1] as string));
    for (const p of payloads) {
      expect(p.name).toBe("invariant_ledger");
      expect(p.detail.state).toBe("pending");
      expect(typeof p.detail.fingerprint).toBe("string");
      expect(p.detail.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("fallo de query no tumba proceso y no publica", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    const { client, publish } = makeClient();
    const pending = new Map<string, import("../src/ledgerInvariant.js").PendingInfo>();
    await expect(runLedgerCheck(client, pending)).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it("fallo de publish no tumba proceso, sigue al siguiente tenant", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "id-1", tenant: "demo" },
        { id: "id-2", tenant: "other" },
      ],
    } as never);
    const publish = vi.fn((topic: string, payload: string, opts: unknown, cb: (err?: Error) => void) => {
      if (topic.includes("demo")) cb(new Error("mqtt fail"));
      else cb();
    });
    const client = { publish, on: vi.fn(), connected: true } as unknown as import("mqtt").MqttClient & { publish: typeof publish };
    const pending = new Map<string, import("../src/ledgerInvariant.js").PendingInfo>();
    await expect(runLedgerCheck(client, pending)).resolves.toBeUndefined();
    // aunque demo falló, other debería intentarse
    expect(publish).toHaveBeenCalledTimes(2);
    // demo no queda en pending porque falló publish pero lo intentamos guardar solo si no throw? En nuestro código pending.set ocurre después de publish aunque publish haga log y no throw. Así que queda.
    // Verificamos que no tumba.
  });
});
