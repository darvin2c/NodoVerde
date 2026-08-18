import { describe, it, expect } from "vitest";
import { createInitialModule, mulberry32 } from "../src/model.js";
import {
  DEVICE_METRICS,
  SENSOR_DEVICES,
  SWITCH_DEVICES,
  switchOn,
  parseRequestPayload,
  parseCmdPayload,
  decideAutoDose,
} from "../src/node/behavior.js";

const targets = { ec: [1.2, 1.8] as [number, number], ph: [5.8, 6.3] as [number, number] };

describe("mapa dispositivo → métrica (contrato plano dispositivo)", () => {
  it("sensores y switches cubiertos, sin tenant/module en ninguna parte", () => {
    expect(DEVICE_METRICS["ec-01"]).toBe("ec");
    expect(DEVICE_METRICS["doser-ph-01"]).toBe("switch");
    expect(SENSOR_DEVICES).toContain("climate-01");
    expect(SWITCH_DEVICES).toHaveLength(5);
  });
});

describe("switchOn refleja estado del mundo", () => {
  it("pump ON, doser OFF por defecto", () => {
    const s = createInitialModule("020000000001", "lechuga", [1.2, 1.8]);
    expect(switchOn(s, "pump-recirc-01")).toBe(true);
    expect(switchOn(s, "doser-a-01")).toBe(false);
    expect(switchOn(s, "inexistente")).toBe(false);
  });
});

describe("parseRequestPayload tolera crudo y JSON (read|capture|calibrate)", () => {
  it("crudo, JSON string, objeto v/action", () => {
    expect(parseRequestPayload("ON")).toBe("ON");
    expect(parseRequestPayload('"OFF"')).toBe("OFF");
    expect(parseRequestPayload('{"v":"ON"}')).toBe("ON");
    expect(parseRequestPayload('{"v":3}')).toBe("3");
    expect(parseRequestPayload('{"action":"calibrate"}')).toBe("calibrate");
    expect(parseRequestPayload("")).toBe("");
  });
  it("Fase 3: request set ya no actúa — se ignora en emulador, pero el parser sigue tolerante", () => {
    // el parser no decide actuación; el emulador ignora set
    expect(parseRequestPayload('{"action":"set"}')).toBe("set");
    expect(parseRequestPayload('{"v":"ON"}')).toBe("ON");
  });
});

describe("parseCmdPayload Fase 3 — fierro solo por cmd con policy_id", () => {
  it("start con policy_id y duration_ms", () => {
    const p = parseCmdPayload(JSON.stringify({ action: "start", policy_id: "pol-123", params: { duration_ms: 1000 } }));
    expect(p).not.toBeNull();
    expect(p!.action).toBe("start");
    expect(p!.policyId).toBe("pol-123");
    expect(p!.durationMs).toBe(1000);
  });
  it("set con v ON", () => {
    const p = parseCmdPayload(JSON.stringify({ action: "set", policy_id: "pol-abc", params: { v: "ON" } }));
    expect(p!.action).toBe("set");
    expect(p!.v).toBe("ON");
  });
  it("stop sin params", () => {
    const p = parseCmdPayload(JSON.stringify({ action: "stop", policy_id: "pol-xyz" }));
    expect(p!.action).toBe("stop");
    expect(p!.policyId).toBe("pol-xyz");
  });
  it("rechaza cmd sin policy_id (defensa en profundidad)", () => {
    expect(parseCmdPayload(JSON.stringify({ action: "start", params: { duration_ms: 500 } }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: "" , params: { duration_ms: 500 } }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: "   " , params: { duration_ms: 500 } }))).toBeNull();
  });
  it("rechaza action inválida o payload no JSON", () => {
    expect(parseCmdPayload(JSON.stringify({ action: "dose", policy_id: "pol-1" }))).toBeNull();
    expect(parseCmdPayload("ON")).toBeNull();
    expect(parseCmdPayload("")).toBeNull();
    expect(parseCmdPayload("not json")).toBeNull();
  });
  it("acepta policyId camelCase y duration en raíz", () => {
    const p = parseCmdPayload(JSON.stringify({ action: "start", policyId: "pol-camel", duration_ms: 2000 }));
    expect(p!.policyId).toBe("pol-camel");
    expect(p!.durationMs).toBe(2000);
  });
});
describe("auto-dosis del firmware (protección de cultivo)", () => {
  it("EC bajo el rango → dosifica nutriente", () => {
    const s = { ...createInitialModule("020000000001", "lechuga", [1.2, 1.8]), ec: 1.0 };
    const a = decideAutoDose(s, targets, false, mulberry32(1));
    expect(a).not.toBeNull();
    expect(["doser-a-01", "doser-b-01"]).toContain(a!.device);
    expect(a!.event).toBe("auto_dose");
  });

  it("pH sobre el rango → dosifica ácido", () => {
    const s = { ...createInitialModule("020000000001", "lechuga", [1.2, 1.8]), ph: 6.5 };
    const a = decideAutoDose(s, targets, false, mulberry32(1));
    expect(a!.device).toBe("doser-ph-01");
  });

  it("tanque bajo → abre válvula de llenado", () => {
    const s = { ...createInitialModule("020000000001", "lechuga", [1.2, 1.8]), tankLevel: 20 };
    const a = decideAutoDose(s, targets, false, mulberry32(1));
    expect(a!.device).toBe("valve-fill-01");
    expect(a!.durationMs).toBe(20000);
  });

  it("timer activo → no duplica pulsos", () => {
    const s = { ...createInitialModule("020000000001", "lechuga", [1.2, 1.8]), ec: 1.0, doserATimer: 1000 };
    const a = decideAutoDose(s, targets, false, mulberry32(1));
    expect(a).toBeNull();
  });

  it("escenario disable_auto_dose → nunca actúa", () => {
    const s = { ...createInitialModule("020000000001", "lechuga", [1.2, 1.8]), ec: 0.5, ph: 8.0, tankLevel: 10 };
    expect(decideAutoDose(s, targets, true, mulberry32(1))).toBeNull();
  });

  it("determinismo: misma semilla → misma decisión A/B", () => {
    const s = { ...createInitialModule("020000000001", "lechuga", [1.2, 1.8]), ec: 1.0 };
    expect(decideAutoDose(s, targets, false, mulberry32(7))!.device).toBe(
      decideAutoDose(s, targets, false, mulberry32(7))!.device,
    );
  });
});
