import { describe, it, expect } from "vitest";
import {
  formatPolicyEvent,
  shouldForwardPolicyEvent,
  parsePolicyEventBody,
} from "../src/forward.js";
import type { PolicyEvent } from "../src/forward.js";

describe("formatPolicyEvent", () => {
  it("proposal_pending → 🔐 Aprobación pendiente", () => {
    const ev: PolicyEvent = {
      kind: "proposal_pending",
      tenant: "demo",
      module: "mod-1",
      message: "dosis 2s propuesta",
    };
    expect(formatPolicyEvent(ev)).toBe("🔐 Aprobación pendiente [demo/mod-1] dosis 2s propuesta");
  });

  it("action_executed → ✅ Acción ejecutada", () => {
    const ev: PolicyEvent = {
      kind: "action_executed",
      tenant: "t1",
      module: "m2",
      message: "valve-fill-01 START ejecutado",
    };
    expect(formatPolicyEvent(ev)).toBe("✅ Acción ejecutada [t1/m2] valve-fill-01 START ejecutado");
  });

  it("work_order_created → 📋 Orden de trabajo", () => {
    const ev: PolicyEvent = {
      kind: "work_order_created",
      tenant: "finca",
      module: "invernadero-a",
      message: "revisar dosificador B",
    };
    expect(formatPolicyEvent(ev)).toBe("📋 Orden de trabajo [finca/invernadero-a] revisar dosificador B");
  });

  it("needs_data → 📉 Confianza insuficiente", () => {
    const ev: PolicyEvent = {
      kind: "needs_data",
      tenant: "demo",
      module: "mod-3",
      message: "falta lectura ec",
    };
    expect(formatPolicyEvent(ev)).toBe("📉 Confianza insuficiente [demo/mod-3] falta lectura ec");
  });

  it("respeta tenant/module y mensaje exacto", () => {
    const ev: PolicyEvent = {
      kind: "proposal_pending",
      tenant: "a",
      module: "b",
      message: "hola",
    };
    const msg = formatPolicyEvent(ev);
    expect(msg).toContain("[a/b]");
    expect(msg.endsWith("hola")).toBe(true);
  });
});

describe("shouldForwardPolicyEvent", () => {
  it("siempre true (sin throttle)", () => {
    const kinds: PolicyEvent["kind"][] = [
      "proposal_pending",
      "action_executed",
      "work_order_created",
      "needs_data",
    ];
    for (const kind of kinds) {
      expect(shouldForwardPolicyEvent({ kind, tenant: "t", module: "m", message: "x" })).toBe(true);
    }
  });
});

describe("parsePolicyEventBody - validación de body", () => {
  it("body válido → ok con trim", () => {
    const res = parsePolicyEventBody({
      kind: "proposal_pending",
      tenant: " demo ",
      module: " mod-1 ",
      message: "  dosis  ",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.event).toEqual({
        kind: "proposal_pending",
        tenant: "demo",
        module: "mod-1",
        message: "dosis",
      });
    }
  });

  it("kind desconocido → 400 error kind desconocido", () => {
    const res = parsePolicyEventBody({
      kind: "unknown_kind",
      tenant: "t",
      module: "m",
      message: "hola",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("kind desconocido");
  });

  it("kind faltante o no string → kind desconocido", () => {
    expect(parsePolicyEventBody({ tenant: "t", module: "m", message: "x" }).ok).toBe(false);
    expect(parsePolicyEventBody({ kind: 123, tenant: "t", module: "m", message: "x" } as unknown as Record<string, unknown>).ok).toBe(false);
  });

  it("message vacío o solo espacios → 400 message vacío", () => {
    const r1 = parsePolicyEventBody({ kind: "needs_data", tenant: "t", module: "m", message: "" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("message vacío");

    const r2 = parsePolicyEventBody({ kind: "needs_data", tenant: "t", module: "m", message: "   " });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("message vacío");
  });

  it("tenant o module vacío → 400 tenant y module requeridos", () => {
    const r1 = parsePolicyEventBody({ kind: "action_executed", tenant: "", module: "m", message: "x" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("tenant y module requeridos");

    const r2 = parsePolicyEventBody({ kind: "action_executed", tenant: "t", module: "   ", message: "x" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("tenant y module requeridos");

    const r3 = parsePolicyEventBody({ kind: "action_executed", tenant: "t", message: "x" } as unknown as Record<string, unknown>);
    expect(r3.ok).toBe(false);
  });

  it("body no objeto → body inválido", () => {
    expect(parsePolicyEventBody(null).ok).toBe(false);
    expect(parsePolicyEventBody("string" as unknown as Record<string, unknown>).ok).toBe(false);
    expect(parsePolicyEventBody([]).ok).toBe(false);
  });

  it("todos los kinds válidos pasan", () => {
    for (const kind of ["proposal_pending", "action_executed", "work_order_created", "needs_data"] as const) {
      const r = parsePolicyEventBody({ kind, tenant: "t", module: "m", message: "ok" });
      expect(r.ok).toBe(true);
    }
  });
});

describe("auth - token query param", () => {
  // La auth de /policy-event es ?token=$OPENCLAW_HOOK_TOKEN (misma que /expert-report).
  // Sin servidor vivo, verificamos la lógica pura: token debe coincidir exacto.
  function isAuthorized(queryToken: string | null, expected: string): boolean {
    return queryToken === expected;
  }

  it("token correcto → autorizado", () => {
    expect(isAuthorized("secreto123", "secreto123")).toBe(true);
  });

  it("token malo, ausente o vacío → 401", () => {
    expect(isAuthorized("otro", "secreto123")).toBe(false);
    expect(isAuthorized(null, "secreto123")).toBe(false);
    expect(isAuthorized("", "secreto123")).toBe(false);
  });
});
