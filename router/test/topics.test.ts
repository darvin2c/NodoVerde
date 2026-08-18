import { describe, it, expect } from "vitest";
import {
  HW_ID_RE,
  isValidHwId,
  parseDeviceTopic,
  parseInternalTopic,
  parseTopic,
  buildDeviceReadingTopic,
  buildDeviceEventTopic,
  buildDeviceStatusTopic,
  buildDeviceConfidenceTopic,
  buildDeviceRequestTopic,
  buildDeviceCmdTopic,
  buildInternalReadingTopic,
  buildInternalEventTopic,
  buildInternalStatusTopic,
  buildInternalConfidenceTopic,
  buildInternalRequestTopic,
  buildInternalCmdTopic,
  deviceCmdTopic,
  deviceToInternalTopic,
  internalToDeviceTopic,
  shouldRetain,
  qosForKind,
  getKind,
  isDeviceTopic,
  isInternalTopic,
  isActuatorDevice,
  shouldForwardRequest,
  parseCmdPayload,
  ACTUATOR_DEVICES,
} from "../src/topics.js";

// Helpers de datos
const HW1 = "020000000001";
const HW2 = "020000000002";
const TENANT = "demo";
const MOD = "mod-1";

describe("validación hw_id", () => {
  it("acepta 12 hex minúsculas", () => {
    expect(isValidHwId(HW1)).toBe(true);
    expect(isValidHwId("abcdef123456")).toBe(true);
    expect(HW_ID_RE.test(HW1)).toBe(true);
  });

  it("rechaza mayúsculas, longitud incorrecta, caracteres no hex", () => {
    expect(isValidHwId("ABCDEF123456")).toBe(false);
    expect(isValidHwId("Abcdef123456")).toBe(false);
    expect(isValidHwId("02000000001")).toBe(false);
    expect(isValidHwId("0200000000011")).toBe(false);
    expect(isValidHwId("02000000000g")).toBe(false);
    expect(isValidHwId("")).toBe(false);
    expect(isValidHwId("zz0000000001")).toBe(false);
  });
});

describe("builders plano dispositivo (5 seg)", () => {
  it("reading", () => {
    expect(buildDeviceReadingTopic(HW1, "ec-01", "ec")).toBe(`terra/${HW1}/ec-01/ec/reading`);
  });
  it("event", () => {
    expect(buildDeviceEventTopic(HW1, "ec-01", "ec")).toBe(`terra/${HW1}/ec-01/ec/event`);
  });
  it("status", () => {
    expect(buildDeviceStatusTopic(HW1, "ec-01")).toBe(`terra/${HW1}/ec-01/status/status`);
  });
  it("confidence", () => {
    expect(buildDeviceConfidenceTopic(HW1, "ec-01")).toBe(`terra/${HW1}/ec-01/confidence/confidence`);
  });
  it("request", () => {
    expect(buildDeviceRequestTopic(HW1, "pump-recirc-01", "set")).toBe(`terra/${HW1}/pump-recirc-01/request/set`);
    expect(buildDeviceRequestTopic(HW1, "ec-01", "read")).toBe(`terra/${HW1}/ec-01/request/read`);
  });
});

describe("builders plano interno (6 seg)", () => {
  it("reading", () => {
    expect(buildInternalReadingTopic(TENANT, MOD, "ec-01", "ec")).toBe(`terra/${TENANT}/${MOD}/ec-01/ec/reading`);
  });
  it("event", () => {
    expect(buildInternalEventTopic(TENANT, MOD, "ec-01", "ec")).toBe(`terra/${TENANT}/${MOD}/ec-01/ec/event`);
  });
  it("status", () => {
    expect(buildInternalStatusTopic(TENANT, MOD, "ec-01")).toBe(`terra/${TENANT}/${MOD}/ec-01/status/status`);
  });
  it("confidence", () => {
    expect(buildInternalConfidenceTopic(TENANT, MOD, "ec-01")).toBe(`terra/${TENANT}/${MOD}/ec-01/confidence/confidence`);
  });
  it("request", () => {
    expect(buildInternalRequestTopic(TENANT, MOD, "pump-recirc-01", "set")).toBe(`terra/${TENANT}/${MOD}/pump-recirc-01/request/set`);
  });
  it("cmd", () => {
    expect(buildInternalCmdTopic(TENANT, MOD, "pump-recirc-01")).toBe(`terra/${TENANT}/${MOD}/pump-recirc-01/cmd`);
  });
});

describe("parseDeviceTopic", () => {
  it("parsea reading", () => {
    const p = parseDeviceTopic(`terra/${HW1}/ec-01/ec/reading`);
    expect(p).toEqual({ plane: "device", hwId: HW1, device: "ec-01", metric: "ec", kind: "reading" });
  });

  it("parsea event", () => {
    const p = parseDeviceTopic(`terra/${HW1}/ec-01/ec/event`);
    expect(p).toEqual({ plane: "device", hwId: HW1, device: "ec-01", metric: "ec", kind: "event" });
  });

  it("parsea status", () => {
    const p = parseDeviceTopic(`terra/${HW1}/ec-01/status/status`);
    expect(p).toEqual({ plane: "device", hwId: HW1, device: "ec-01", kind: "status" });
  });

  it("parsea confidence", () => {
    const p = parseDeviceTopic(`terra/${HW1}/ec-01/confidence/confidence`);
    expect(p).toEqual({ plane: "device", hwId: HW1, device: "ec-01", kind: "confidence" });
  });

  it("parsea request", () => {
    const p = parseDeviceTopic(`terra/${HW1}/pump-recirc-01/request/set`);
    expect(p).toEqual({ plane: "device", hwId: HW1, device: "pump-recirc-01", action: "set", kind: "request" });
  });

  it("rechaza hw_id inválido", () => {
    expect(parseDeviceTopic(`terra/INVALID/ec-01/ec/reading`)).toBeNull();
    expect(parseDeviceTopic(`terra/02000000000G/ec-01/ec/reading`)).toBeNull();
  });

  it("rechaza número incorrecto de segmentos", () => {
    expect(parseDeviceTopic(`terra/${HW1}/ec-01/ec/reading/extra`)).toBeNull();
    expect(parseDeviceTopic(`terra/${HW1}/ec-01`)).toBeNull();
    expect(parseDeviceTopic(`terra/${HW1}/ec-01/ec`)).toBeNull();
  });

  it("rechaza tópicos internos (6 seg) como dispositivo", () => {
    expect(parseDeviceTopic(`terra/${TENANT}/${MOD}/ec-01/ec/reading`)).toBeNull();
  });

  it("climate-01 con air_temp/humidity", () => {
    expect(parseDeviceTopic(`terra/${HW1}/climate-01/air_temp/reading`)).toEqual({
      plane: "device",
      hwId: HW1,
      device: "climate-01",
      metric: "air_temp",
      kind: "reading",
    });
    expect(parseDeviceTopic(`terra/${HW1}/climate-01/humidity/reading`)).toEqual({
      plane: "device",
      hwId: HW1,
      device: "climate-01",
      metric: "humidity",
      kind: "reading",
    });
  });
});

describe("parseInternalTopic", () => {
  it("parsea reading", () => {
    const p = parseInternalTopic(`terra/${TENANT}/${MOD}/ec-01/ec/reading`);
    expect(p).toEqual({ plane: "internal", tenant: TENANT, module: MOD, device: "ec-01", metric: "ec", kind: "reading" });
  });

  it("parsea event", () => {
    const p = parseInternalTopic(`terra/${TENANT}/${MOD}/ec-01/ec/event`);
    expect(p).toEqual({ plane: "internal", tenant: TENANT, module: MOD, device: "ec-01", metric: "ec", kind: "event" });
  });

  it("parsea status", () => {
    const p = parseInternalTopic(`terra/${TENANT}/${MOD}/ec-01/status/status`);
    expect(p).toEqual({ plane: "internal", tenant: TENANT, module: MOD, device: "ec-01", kind: "status" });
  });

  it("parsea confidence", () => {
    const p = parseInternalTopic(`terra/${TENANT}/${MOD}/ec-01/confidence/confidence`);
    expect(p).toEqual({ plane: "internal", tenant: TENANT, module: MOD, device: "ec-01", kind: "confidence" });
  });

  it("parsea request", () => {
    const p = parseInternalTopic(`terra/${TENANT}/${MOD}/pump-recirc-01/request/set`);
    expect(p).toEqual({ plane: "internal", tenant: TENANT, module: MOD, device: "pump-recirc-01", action: "set", kind: "request" });
  });

  it("parsea cmd (5 seg interno)", () => {
    const p = parseInternalTopic(`terra/${TENANT}/${MOD}/pump-recirc-01/cmd`);
    expect(p).toEqual({ plane: "internal", tenant: TENANT, module: MOD, device: "pump-recirc-01", kind: "cmd" });
  });

  it("rechaza tópicos dispositivo (5 seg hw_id) como interno", () => {
    // 5 seg con hw_id no es interno (excepto cmd, pero cmd requiere tenant/module/device/cmd)
    expect(parseInternalTopic(`terra/${HW1}/ec-01/ec/reading`)).toBeNull();
  });

  it("rechaza segmentos incorrectos", () => {
    expect(parseInternalTopic(`terra/${TENANT}/${MOD}/ec-01`)).toBeNull();
    expect(parseInternalTopic(`terra/${TENANT}/${MOD}/ec-01/ec`)).toBeNull();
    expect(parseInternalTopic(`terra/${TENANT}/${MOD}/ec-01/ec/reading/extra`)).toBeNull();
  });
});

describe("parseTopic general", () => {
  it("distingue planos por segmentos", () => {
    expect(parseTopic(`terra/${HW1}/ec-01/ec/reading`)?.plane).toBe("device");
    expect(parseTopic(`terra/${TENANT}/${MOD}/ec-01/ec/reading`)?.plane).toBe("internal");
  });

  it("retorna null para tópicos desconocidos", () => {
    expect(parseTopic("homeassistant/sensor/foo/config")).toBeNull();
    expect(parseTopic("terra/bad")).toBeNull();
  });
});

describe("isDeviceTopic / isInternalTopic", () => {
  it("clasifica correctamente", () => {
    expect(isDeviceTopic(`terra/${HW1}/ec-01/ec/reading`)).toBe(true);
    expect(isDeviceTopic(`terra/${TENANT}/${MOD}/ec-01/ec/reading`)).toBe(false);

    expect(isInternalTopic(`terra/${TENANT}/${MOD}/ec-01/ec/reading`)).toBe(true);
    expect(isInternalTopic(`terra/${HW1}/ec-01/ec/reading`)).toBe(false);
    expect(isInternalTopic(`terra/${TENANT}/${MOD}/pump-recirc-01/cmd`)).toBe(true);
  });
});

describe("getKind", () => {
  it("detecta kind en ambos planos", () => {
    expect(getKind(`terra/${HW1}/ec-01/ec/reading`)).toBe("reading");
    expect(getKind(`terra/${HW1}/ec-01/ec/event`)).toBe("event");
    expect(getKind(`terra/${HW1}/ec-01/status/status`)).toBe("status");
    expect(getKind(`terra/${HW1}/ec-01/confidence/confidence`)).toBe("confidence");
    expect(getKind(`terra/${HW1}/pump-recirc-01/request/set`)).toBe("request");

    expect(getKind(`terra/${TENANT}/${MOD}/ec-01/ec/reading`)).toBe("reading");
    expect(getKind(`terra/${TENANT}/${MOD}/ec-01/status/status`)).toBe("status");
    expect(getKind(`terra/${TENANT}/${MOD}/pump-recirc-01/request/set`)).toBe("request");
    expect(getKind(`terra/${TENANT}/${MOD}/pump-recirc-01/cmd`)).toBe("cmd");
  });

  it("retorna null para tópico no reconocido", () => {
    expect(getKind("homeassistant/sensor/x/config")).toBeNull();
  });
});

describe("deviceToInternalTopic", () => {
  it("traduce reading", () => {
    const dev = `terra/${HW1}/ec-01/ec/reading`;
    expect(deviceToInternalTopic(dev, TENANT, MOD)).toBe(`terra/${TENANT}/${MOD}/ec-01/ec/reading`);
  });

  it("traduce event", () => {
    const dev = `terra/${HW1}/ec-01/ec/event`;
    expect(deviceToInternalTopic(dev, TENANT, MOD)).toBe(`terra/${TENANT}/${MOD}/ec-01/ec/event`);
  });

  it("traduce status", () => {
    const dev = `terra/${HW1}/ec-01/status/status`;
    expect(deviceToInternalTopic(dev, TENANT, MOD)).toBe(`terra/${TENANT}/${MOD}/ec-01/status/status`);
  });

  it("traduce confidence", () => {
    const dev = `terra/${HW1}/ec-01/confidence/confidence`;
    expect(deviceToInternalTopic(dev, TENANT, MOD)).toBe(`terra/${TENANT}/${MOD}/ec-01/confidence/confidence`);
  });

  it("traduce request", () => {
    const dev = `terra/${HW1}/pump-recirc-01/request/set`;
    expect(deviceToInternalTopic(dev, TENANT, MOD)).toBe(`terra/${TENANT}/${MOD}/pump-recirc-01/request/set`);
  });

  it("retorna null para topic dispositivo inválido", () => {
    expect(deviceToInternalTopic("terra/bad/topic", TENANT, MOD)).toBeNull();
  });

  it("mapea todos los dispositivos del contrato", () => {
    const cases: [string, string, string][] = [
      [HW1, "ec-01", "ec"],
      [HW1, "ph-01", "ph"],
      [HW1, "temp-01", "temp"],
      [HW1, "level-01", "level"],
      [HW1, "flow-01", "flow"],
      [HW1, "climate-01", "air_temp"],
      [HW1, "climate-01", "humidity"],
      [HW1, "pump-recirc-01", "switch"],
      [HW1, "valve-fill-01", "switch"],
      [HW1, "doser-a-01", "switch"],
      [HW1, "doser-b-01", "switch"],
      [HW1, "doser-ph-01", "switch"],
    ];
    for (const [hw, dev, metric] of cases) {
      const t = `terra/${hw}/${dev}/${metric}/reading`;
      const internal = deviceToInternalTopic(t, TENANT, MOD);
      expect(internal).toBe(`terra/${TENANT}/${MOD}/${dev}/${metric}/reading`);
    }
  });
});

describe("internalToDeviceTopic", () => {
  it("traduce reading", () => {
    const internal = `terra/${TENANT}/${MOD}/ec-01/ec/reading`;
    expect(internalToDeviceTopic(internal, HW1)).toBe(`terra/${HW1}/ec-01/ec/reading`);
  });

  it("traduce status", () => {
    const internal = `terra/${TENANT}/${MOD}/ec-01/status/status`;
    expect(internalToDeviceTopic(internal, HW1)).toBe(`terra/${HW1}/ec-01/status/status`);
  });

  it("traduce request", () => {
    const internal = `terra/${TENANT}/${MOD}/pump-recirc-01/request/set`;
    expect(internalToDeviceTopic(internal, HW1)).toBe(`terra/${HW1}/pump-recirc-01/request/set`);
  });

  it("no traduce cmd (sin equivalente en dispositivo)", () => {
    const internal = `terra/${TENANT}/${MOD}/pump-recirc-01/cmd`;
    expect(internalToDeviceTopic(internal, HW1)).toBeNull();
  });

  it("retorna null para topic interno inválido", () => {
    expect(internalToDeviceTopic("terra/bad/topic", HW1)).toBeNull();
  });

  it("roundtrip device→interno→device es identidad", () => {
    const original = `terra/${HW1}/climate-01/humidity/reading`;
    const internal = deviceToInternalTopic(original, TENANT, MOD)!;
    const back = internalToDeviceTopic(internal, HW1)!;
    expect(back).toBe(original);
  });

  it("roundtrip interno→device→interno es identidad", () => {
    const original = `terra/${TENANT}/${MOD}/pump-recirc-01/request/set`;
    const device = internalToDeviceTopic(original, HW1)!;
    const back = deviceToInternalTopic(device, TENANT, MOD)!;
    expect(back).toBe(original);
  });
});

describe("shouldRetain", () => {
  it("status siempre retenido", () => {
    expect(shouldRetain(`terra/${TENANT}/${MOD}/ec-01/status/status`)).toBe(true);
    expect(shouldRetain(`terra/${HW1}/ec-01/status/status`)).toBe(true);
  });

  it("reading switch retenido", () => {
    expect(shouldRetain(`terra/${TENANT}/${MOD}/pump-recirc-01/switch/reading`)).toBe(true);
    expect(shouldRetain(`terra/${HW1}/pump-recirc-01/switch/reading`)).toBe(true);
  });

  it("reading sensor no retenido", () => {
    expect(shouldRetain(`terra/${TENANT}/${MOD}/ec-01/ec/reading`)).toBe(false);
    expect(shouldRetain(`terra/${TENANT}/${MOD}/climate-01/air_temp/reading`)).toBe(false);
    expect(shouldRetain(`terra/${HW1}/ec-01/ec/reading`)).toBe(false);
  });

  it("event, confidence, request, cmd no retenidos", () => {
    expect(shouldRetain(`terra/${TENANT}/${MOD}/ec-01/ec/event`)).toBe(false);
    expect(shouldRetain(`terra/${TENANT}/${MOD}/ec-01/confidence/confidence`)).toBe(false);
    expect(shouldRetain(`terra/${TENANT}/${MOD}/pump-recirc-01/request/set`)).toBe(false);
    expect(shouldRetain(`terra/${TENANT}/${MOD}/pump-recirc-01/cmd`)).toBe(false);
  });
});

describe("qosForKind", () => {
  it("sensores reading qos 0", () => {
    expect(qosForKind("reading", "ec")).toBe(0);
    expect(qosForKind("reading", "ph")).toBe(0);
    expect(qosForKind("reading", "temp")).toBe(0);
    expect(qosForKind("reading", "level")).toBe(0);
    expect(qosForKind("reading", "flow")).toBe(0);
    expect(qosForKind("reading", "air_temp")).toBe(0);
    expect(qosForKind("reading", "humidity")).toBe(0);
  });

  it("switch reading qos 1", () => {
    expect(qosForKind("reading", "switch")).toBe(1);
  });

  it("status, event, confidence, request, cmd qos 1", () => {
    expect(qosForKind("status")).toBe(1);
    expect(qosForKind("event")).toBe(1);
    expect(qosForKind("confidence")).toBe(1);
    expect(qosForKind("request")).toBe(1);
    expect(qosForKind("cmd")).toBe(1);
  });
});

describe("contrato — 5 vs 6 segmentos distinguibles", () => {
  it("plano dispositivo tiene 5 segmentos, interno 6", () => {
    const deviceTopic = `terra/${HW1}/ec-01/ec/reading`;
    const internalTopic = `terra/${TENANT}/${MOD}/ec-01/ec/reading`;
    expect(deviceTopic.split("/").length).toBe(5);
    expect(internalTopic.split("/").length).toBe(6);
  });

  it("suscripción device no matchea interno y viceversa (simulación)", () => {
    // El router subscribe device con patrones de 5 seg y interno request con 6 seg.
    // Verificamos que los parsers discriminan correctamente por conteo.
    const deviceTopics = [
      `terra/${HW1}/ec-01/ec/reading`,
      `terra/${HW1}/ec-01/ec/event`,
      `terra/${HW1}/ec-01/status/status`,
      `terra/${HW1}/ec-01/confidence/confidence`,
    ];
    for (const t of deviceTopics) {
      expect(parseDeviceTopic(t)).not.toBeNull();
      expect(parseInternalTopic(t)).toBeNull();
    }

    const internalTopics = [
      `terra/${TENANT}/${MOD}/ec-01/ec/reading`,
      `terra/${TENANT}/${MOD}/ec-01/status/status`,
      `terra/${TENANT}/${MOD}/pump-recirc-01/request/set`,
    ];
    for (const t of internalTopics) {
      expect(parseInternalTopic(t)).not.toBeNull();
      expect(parseDeviceTopic(t)).toBeNull();
    }
  });

  it("hw_ids demo determinísticos", () => {
    const demoHwIds = ["020000000001", "020000000002", "020000000003", "020000000004"];
    for (const hw of demoHwIds) {
      expect(isValidHwId(hw)).toBe(true);
      const t = `terra/${hw}/ec-01/ec/reading`;
      expect(parseDeviceTopic(t)?.hwId).toBe(hw);
      const internal = deviceToInternalTopic(t, TENANT, "mod-1")!;
      expect(internal).toContain(TENANT);
    }
  });
});

// ---------------------------------------------------------------------------
// Fase 3 — actuadores y enforcement de cmd
// ---------------------------------------------------------------------------

describe("isActuatorDevice", () => {
  it("reconoce los 5 actuadores del lazo cerrado", () => {
    expect(ACTUATOR_DEVICES).toHaveLength(5);
    for (const dev of ACTUATOR_DEVICES) {
      expect(isActuatorDevice(dev)).toBe(true);
    }
    expect(isActuatorDevice("pump-recirc-01")).toBe(true);
    expect(isActuatorDevice("valve-fill-01")).toBe(true);
    expect(isActuatorDevice("doser-a-01")).toBe(true);
    expect(isActuatorDevice("doser-b-01")).toBe(true);
    expect(isActuatorDevice("doser-ph-01")).toBe(true);
  });

  it("rechaza sensores y dispositivos no actuadores", () => {
    expect(isActuatorDevice("ec-01")).toBe(false);
    expect(isActuatorDevice("ph-01")).toBe(false);
    expect(isActuatorDevice("temp-01")).toBe(false);
    expect(isActuatorDevice("level-01")).toBe(false);
    expect(isActuatorDevice("flow-01")).toBe(false);
    expect(isActuatorDevice("climate-01")).toBe(false);
    expect(isActuatorDevice("cam-01")).toBe(false);
    expect(isActuatorDevice("")).toBe(false);
    expect(isActuatorDevice("pump-recirc-02")).toBe(false);
    expect(isActuatorDevice("PUMP-RECIRC-01")).toBe(false);
  });
});

describe("shouldForwardRequest", () => {
  it("bloquea set/start/stop hacia actuadores (intercepta el portero)", () => {
    for (const dev of ACTUATOR_DEVICES) {
      expect(shouldForwardRequest(dev, "set")).toBe(false);
      expect(shouldForwardRequest(dev, "start")).toBe(false);
      expect(shouldForwardRequest(dev, "stop")).toBe(false);
    }
  });

  it("permite read/capture/calibrate hacia actuadores", () => {
    for (const dev of ACTUATOR_DEVICES) {
      expect(shouldForwardRequest(dev, "read")).toBe(true);
      expect(shouldForwardRequest(dev, "capture")).toBe(true);
      expect(shouldForwardRequest(dev, "calibrate")).toBe(true);
    }
  });

  it("permite todo hacia sensores (no actuadores)", () => {
    const sensors = ["ec-01", "ph-01", "level-01", "temp-01", "flow-01"];
    for (const dev of sensors) {
      expect(shouldForwardRequest(dev, "set")).toBe(true);
      expect(shouldForwardRequest(dev, "start")).toBe(true);
      expect(shouldForwardRequest(dev, "stop")).toBe(true);
      expect(shouldForwardRequest(dev, "read")).toBe(true);
      expect(shouldForwardRequest(dev, "capture")).toBe(true);
      expect(shouldForwardRequest(dev, "calibrate")).toBe(true);
    }
  });

  it("action desconocida hacia actuador se permite (solo bloquea set/start/stop)", () => {
    expect(shouldForwardRequest("pump-recirc-01", "unknown")).toBe(true);
    expect(shouldForwardRequest("doser-a-01", "")).toBe(true);
  });
});

describe("parseCmdPayload", () => {
  it("válido con policy_id y action start + params", () => {
    const raw = JSON.stringify({ action: "start", policy_id: "pol-123", params: { duration_ms: 2000 } });
    expect(parseCmdPayload(raw)).toEqual({ action: "start", policy_id: "pol-123", params: { duration_ms: 2000 } });
  });

  it("válido con Buffer y con Uint8Array", () => {
    const obj = { action: "set", policy_id: "pol-abc", params: { v: "ON" } };
    const str = JSON.stringify(obj);
    expect(parseCmdPayload(Buffer.from(str))).toEqual(obj);
    expect(parseCmdPayload(new TextEncoder().encode(str))).toEqual(obj);
  });

  it("válido sin params", () => {
    const raw = JSON.stringify({ action: "stop", policy_id: "pol-xyz" });
    expect(parseCmdPayload(raw)).toEqual({ action: "stop", policy_id: "pol-xyz" });
  });

  it("rechaza sin policy_id", () => {
    expect(parseCmdPayload(JSON.stringify({ action: "start", params: {} }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start" }))).toBeNull();
  });

  it("rechaza policy_id vacío o solo espacios", () => {
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: "" }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: "   " }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: " " }))).toBeNull();
  });

  it("rechaza policy_id no string", () => {
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: 123 }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: null }))).toBeNull();
  });

  it("rechaza action inválida", () => {
    expect(parseCmdPayload(JSON.stringify({ action: "invalid", policy_id: "pol-1" }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "read", policy_id: "pol-1" }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "", policy_id: "pol-1" }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: null, policy_id: "pol-1" }))).toBeNull();
  });

  it("rechaza JSON roto", () => {
    expect(parseCmdPayload("{not json")).toBeNull();
    expect(parseCmdPayload("{")).toBeNull();
    expect(parseCmdPayload("")).toBeNull();
    expect(parseCmdPayload("   ")).toBeNull();
  });

  it("rechaza crudo no-JSON y tipos inválidos", () => {
    expect(parseCmdPayload("ON")).toBeNull();
    expect(parseCmdPayload("OFF")).toBeNull();
    expect(parseCmdPayload(null)).toBeNull();
    expect(parseCmdPayload(undefined)).toBeNull();
    expect(parseCmdPayload(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseCmdPayload(JSON.stringify("string"))).toBeNull();
    expect(parseCmdPayload(JSON.stringify(123))).toBeNull();
  });

  it("rechaza params no objeto", () => {
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: "pol-1", params: "ON" }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: "pol-1", params: 123 }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: "pol-1", params: [] }))).toBeNull();
    expect(parseCmdPayload(JSON.stringify({ action: "start", policy_id: "pol-1", params: null }))).toBeNull();
  });

  it("tolera whitespace alrededor de JSON", () => {
    const raw = '  \n' + JSON.stringify({ action: "stop", policy_id: "pol-1" }) + '  \n';
    expect(parseCmdPayload(raw)).toEqual({ action: "stop", policy_id: "pol-1" });
  });
});

describe("buildDeviceCmdTopic / deviceCmdTopic", () => {
  it("construye topic dispositivo cmd (4 segmentos)", () => {
    expect(buildDeviceCmdTopic(HW1, "pump-recirc-01")).toBe(`terra/${HW1}/pump-recirc-01/cmd`);
    expect(deviceCmdTopic(HW1, "doser-a-01")).toBe(`terra/${HW1}/doser-a-01/cmd`);
    // alias buildDeviceCmd
  });

  it("buildInternalCmdTopic roundtrip vía parseInternalTopic", () => {
    const topic = buildInternalCmdTopic(TENANT, MOD, "valve-fill-01");
    expect(topic).toBe(`terra/${TENANT}/${MOD}/valve-fill-01/cmd`);
    const parsed = parseInternalTopic(topic);
    expect(parsed).toEqual({ plane: "internal", tenant: TENANT, module: MOD, device: "valve-fill-01", kind: "cmd" });
    expect(parseTopic(topic)?.plane).toBe("internal");
  });

  it("deviceCmdTopic formato distinguible de internal cmd", () => {
    const devTopic = buildDeviceCmdTopic(HW1, "doser-b-01");
    const intTopic = buildInternalCmdTopic(TENANT, MOD, "doser-b-01");
    expect(devTopic.split("/").length).toBe(4);
    expect(intTopic.split("/").length).toBe(5);
    expect(devTopic).not.toBe(intTopic);
  });
});
