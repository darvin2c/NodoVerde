import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchJson, PolicyError } from "../server/policy.js";
import { appRouter } from "../server/trpc.js";

function mockDb(rows: unknown[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  } as unknown as never;
}
function callerWith(db: unknown) {
  return appRouter.createCaller({ db: db as never });
}

const originalFetch = globalThis.fetch;

describe("policy fetchJson", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("envía Authorization Bearer y parsea JSON exitoso", async () => {
    const mockRes = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ actions: [{ id: "a1" }] }),
    } as unknown as Response;

    const fetchMock = vi.fn().mockResolvedValue(mockRes);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const data = await fetchJson<{ actions: Array<{ id: string }> }>("/api/approvals", {
      params: { tenant: "demo" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/approvals");
    expect(url).toContain("tenant=demo");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dev-admin-token");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(data.actions[0].id).toBe("a1");
  });

  it("lanza PolicyError con mensaje del body en error HTTP", async () => {
    const mockRes = {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "bad request" }),
    } as unknown as Response;
    globalThis.fetch = vi.fn().mockResolvedValue(mockRes) as unknown as typeof fetch;

    await expect(fetchJson("/api/approvals")).rejects.toThrow(PolicyError);
    await expect(fetchJson("/api/approvals")).rejects.toThrow("bad request");
    try {
      await fetchJson("/api/approvals");
    } catch (e) {
      expect((e as PolicyError).status).toBe(400);
    }
  });

  it("convierte AbortError en PolicyError timeout 504", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    globalThis.fetch = vi.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;

    await expect(fetchJson("/api/approvals")).rejects.toThrow(PolicyError);
    try {
      await fetchJson("/api/approvals");
    } catch (e) {
      expect((e as PolicyError).message).toMatch(/timeout/i);
      expect((e as PolicyError).status).toBe(504);
    }
  });

  it("usa timeout 5s (AbortController) y envía body JSON", async () => {
    const mockRes = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(mockRes);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const data = await fetchJson<{ ok: boolean }>("/api/approvals/123/approve", {
      method: "POST",
      body: { by: "pwa", reason: "test" },
    });
    expect(data.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ by: "pwa", reason: "test" }));
    // signal debe estar presente (AbortController)
    expect(init.signal).toBeDefined();
  });
});

describe("pending procedures con fetch mockeado", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("approvals retorna lista desde {actions: [...]}", async () => {
    const actions = [
      { id: "11111111-1111-1111-1111-111111111111", device: "doser-a-01", action: "start", params: { duration_ms: 2000 }, requested_by: "agent", reason: "test" },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ actions }),
    } as unknown as Response) as unknown as typeof fetch;

    const caller = callerWith(mockDb());
    const res = await caller.pending.approvals({ tenant: "demo" });
    // Cada acción queda etiquetada con su finca (fan-out multi-finca, ADR-0023)
    expect(res).toEqual(actions.map((a) => ({ ...a, tenant: "demo" })));
  });

  it("approvals sin tenant itera las fincas activas de la DB", async () => {
    const actions = [{ id: "a2" }];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(actions),
    } as unknown as Response) as unknown as typeof fetch;
    const caller = callerWith(mockDb([{ id: "demo" }]));
    const res = await caller.pending.approvals();
    expect(res).toEqual([{ id: "a2", tenant: "demo" }]);
  });

  it("decide hace POST a /api/approvals/{id}/approve con by pwa", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "abc", status: "executed" }),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const caller = callerWith(mockDb());
    const res = await caller.pending.decide({ id: "abc-123", decision: "approve" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/approvals/abc-123/approve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ by: "pwa" });
    expect(res).toEqual({ id: "abc", status: "executed" });
  });

  it("decide reject envía reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "abc", status: "rejected" }),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const caller = callerWith(mockDb());
    await caller.pending.decide({ id: "abc-123", decision: "reject", reason: "no confiable" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ by: "pwa", reason: "no confiable" });
  });

  it("workOrders retorna orders", async () => {
    const orders = [{ id: "w1", kind: "manual", instructions: "revisar", status: "pending" }];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ orders }),
    } as unknown as Response) as unknown as typeof fetch;
    const caller = callerWith(mockDb());
    const res = await caller.pending.workOrders({ tenant: "demo", status: "pending" });
    expect(res).toEqual(orders.map((o) => ({ ...o, tenant: "demo" })));
  });

  it("completeWorkOrder hace POST con by pwa y note", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "w1", status: "done" }),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const caller = callerWith(mockDb());
    await caller.pending.completeWorkOrder({ id: "w1", note: "hecho" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/work-orders/w1/complete");
    expect(JSON.parse(init.body as string)).toEqual({ by: "pwa", note: "hecho" });
  });

  it("propaga error del portero como TRPCError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: "portero caído" }),
    } as unknown as Response) as unknown as typeof fetch;
    const caller = callerWith(mockDb());
    await expect(caller.pending.approvals({ tenant: "demo" })).rejects.toThrow("portero caído");
  });
});
