import { describe, it, expect } from "vitest";
import { shouldForward, formatHookMessage, throttleKey, DEFAULT_THROTTLE_MS } from "../src/forward.js";
import type { Alert } from "../src/forward.js";

function mkAlert(overrides: Partial<Alert> & { name: string }): Alert {
  return {
    tenant: "demo",
    module: "mod-1",
    ts: Date.now(),
    severity: "critical",
    ...overrides,
  };
}

describe("shouldForward", () => {
  it("critical/warn se reenvían la primera vez", () => {
    const a = mkAlert({ name: "device_impossible", severity: "critical", device: "ec-01" });
    const { forward, newState } = shouldForward(a, new Map(), 1000);
    expect(forward).toBe(true);
    expect(newState.get(throttleKey(a))).toBe(1000);
  });

  it("warn también se reenvía", () => {
    const a = mkAlert({ name: "device_frozen", severity: "warn" });
    const { forward } = shouldForward(a, new Map(), 1000);
    expect(forward).toBe(true);
  });

  it("info se filtra (ruido)", () => {
    const a = mkAlert({ name: "device_silence", severity: "info" });
    const { forward } = shouldForward(a, new Map(), 1000);
    expect(forward).toBe(false);
  });

  it("info no muta el estado de throttle", () => {
    const a = mkAlert({ name: "device_silence", severity: "info" });
    const state = new Map<string, number>();
    const { newState } = shouldForward(a, state, 1000);
    expect(newState.size).toBe(0);
  });

  it("throttle por clave compuesta tenant/module/name", () => {
    const now = 10_000;
    const a1 = mkAlert({ name: "device_impossible", severity: "critical", tenant: "demo", module: "mod-1" });
    const a2 = mkAlert({ name: "device_impossible", severity: "critical", tenant: "demo", module: "mod-2" });
    const a3 = mkAlert({ name: "device_impossible", severity: "critical", tenant: "other", module: "mod-1" });
    const a4 = mkAlert({ name: "device_frozen", severity: "critical", tenant: "demo", module: "mod-1" });

    // Primera vez cada clave pasa
    let state = new Map<string, number>();
    let r = shouldForward(a1, state, now);
    expect(r.forward).toBe(true);
    state = r.newState;

    // Misma clave dentro de throttle → bloqueada
    r = shouldForward(a1, state, now + 1000);
    expect(r.forward).toBe(false);

    // Mismo name pero distinto módulo → no bloqueada (clave distinta)
    r = shouldForward(a2, state, now + 1000);
    expect(r.forward).toBe(true);

    // Distinto tenant → no bloqueada
    r = shouldForward(a3, state, now + 1000);
    expect(r.forward).toBe(true);

    // Distinto name mismo tenant/module → no bloqueada
    r = shouldForward(a4, state, now + 1000);
    expect(r.forward).toBe(true);
  });

  it("throttle respeta ventana THROTTLE_MS", () => {
    const throttleMs = 300_000;
    const a = mkAlert({ name: "device_impossible", severity: "critical" });
    let state = new Map<string, number>();
    let r = shouldForward(a, state, 0, throttleMs);
    expect(r.forward).toBe(true);
    state = r.newState;

    // Dentro de ventana → bloqueada
    r = shouldForward(a, state, throttleMs - 1, throttleMs);
    expect(r.forward).toBe(false);

    // Justo en el límite → pasa
    r = shouldForward(a, state, throttleMs, throttleMs);
    expect(r.forward).toBe(true);
    state = r.newState;

    // Después de ventana → pasa de nuevo
    r = shouldForward(a, state, throttleMs * 2, throttleMs);
    expect(r.forward).toBe(true);
  });

  it("THROTTLE_MS custom se respeta", () => {
    const a = mkAlert({ name: "device_impossible", severity: "critical" });
    let state = new Map<string, number>();
    let r = shouldForward(a, state, 0, 1000);
    expect(r.forward).toBe(true);
    state = r.newState;
    r = shouldForward(a, state, 500, 1000);
    expect(r.forward).toBe(false);
    r = shouldForward(a, state, 1000, 1000);
    expect(r.forward).toBe(true);
  });

  it("module_blind siempre pasa aunque sea info y aunque esté en throttle", () => {
    const a: Alert = mkAlert({ name: "module_blind", severity: "info" });
    let state = new Map<string, number>();
    let r = shouldForward(a, state, 0);
    expect(r.forward).toBe(true);
    state = r.newState;
    // Reenvío inmediato — sin throttle
    r = shouldForward(a, state, 10);
    expect(r.forward).toBe(true);
    // Incluso con critical previo en la misma clave? no aplica porque blind tiene clave distinta,
    // pero probamos que blind no se bloquea a sí mismo
    r = shouldForward(a, state, 20);
    expect(r.forward).toBe(true);
  });

  it("module_recovered siempre pasa aunque sea info", () => {
    const a = mkAlert({ name: "module_recovered", severity: "info" });
    const { forward } = shouldForward(a, new Map(), 0);
    expect(forward).toBe(true);
  });

  it("module_blind bypassa throttle incluso con critical", () => {
    const a = mkAlert({ name: "module_blind", severity: "critical" });
    let state = new Map<string, number>();
    let r = shouldForward(a, state, 0, 300_000);
    expect(r.forward).toBe(true);
    state = r.newState;
    r = shouldForward(a, state, 100, 300_000);
    expect(r.forward).toBe(true);
  });

  it("no muta el mapa original", () => {
    const a = mkAlert({ name: "device_impossible", severity: "critical" });
    const state = new Map<string, number>();
    const { newState } = shouldForward(a, state, 1000);
    expect(state.size).toBe(0);
    expect(newState.size).toBe(1);
  });

  it("DEFAULT_THROTTLE_MS es 300000", () => {
    expect(DEFAULT_THROTTLE_MS).toBe(300_000);
  });
});

describe("formatHookMessage", () => {
  it("formato básico con device", () => {
    const a: Alert = {
      tenant: "demo",
      module: "mod-2",
      name: "device_impossible",
      ts: Date.now(),
      severity: "critical",
      device: "ec-01",
      detail: { value: 14.2, range: "0-10" },
    };
    const msg = formatHookMessage(a);
    expect(msg).toBe("[ALERTA crítica] demo/mod-2 ec-01: valor imposible 14.2 (rango 0-10)");
  });

  it("formato sin device (alerta de módulo)", () => {
    const a: Alert = {
      tenant: "demo",
      module: "mod-1",
      name: "module_blind",
      ts: Date.now(),
      severity: "critical",
    };
    const msg = formatHookMessage(a);
    expect(msg).toBe("[ALERTA crítica] demo/mod-1: módulo a ciegas");
  });

  it("severidad warn → advertencia", () => {
    const a = mkAlert({ name: "device_frozen", severity: "warn", device: "temp-01" });
    const msg = formatHookMessage(a);
    expect(msg).toContain("[ALERTA advertencia]");
  });

  it("severidad info → informativa", () => {
    const a = mkAlert({ name: "device_silence", severity: "info", device: "ph-01" });
    const msg = formatHookMessage(a);
    expect(msg).toContain("[ALERTA informativa]");
  });

  it("detail con value y metric y rango objeto", () => {
    const a: Alert = {
      tenant: "demo",
      module: "mod-1",
      name: "device_impossible",
      ts: Date.now(),
      severity: "critical",
      device: "ph-01",
      detail: { value: 15, metric: "ph", range: { min: 0, max: 14 } },
    };
    const msg = formatHookMessage(a);
    expect(msg).toContain("15 (ph)");
    expect(msg).toContain("rango 0-14");
  });

  it("detail con range array", () => {
    const a: Alert = {
      tenant: "demo",
      module: "mod-1",
      name: "device_impossible",
      ts: Date.now(),
      severity: "critical",
      device: "ec-01",
      detail: { value: 11, range: [0, 10] },
    };
    const msg = formatHookMessage(a);
    expect(msg).toContain("rango 0-10");
  });

  it("detail con reason se usa directamente", () => {
    const a: Alert = {
      tenant: "demo",
      module: "mod-1",
      name: "device_offline",
      ts: Date.now(),
      severity: "warn",
      device: "level-01",
      detail: { reason: "sin lectura 45s" },
    };
    const msg = formatHookMessage(a);
    expect(msg).toContain("sin lectura 45s");
  });

  it("nombres no mapeados usan reemplazo de _ por espacio", () => {
    const a = mkAlert({ name: "custom_alert_xyz", severity: "critical" });
    const msg = formatHookMessage(a);
    expect(msg).toContain("custom alert xyz");
  });

  it("detail vacío no añade sufijo", () => {
    const a: Alert = {
      tenant: "demo",
      module: "mod-1",
      name: "device_recovered",
      ts: Date.now(),
      severity: "warn",
      device: "ec-01",
      detail: {},
    };
    const msg = formatHookMessage(a);
    expect(msg).toBe("[ALERTA advertencia] demo/mod-1 ec-01: dispositivo recuperado");
  });
});

describe("throttleKey", () => {
  it("clave compuesta tenant/module/name", () => {
    const a = mkAlert({ name: "device_impossible", tenant: "t1", module: "m1" });
    expect(throttleKey(a)).toBe("t1/m1/device_impossible");
  });
});
