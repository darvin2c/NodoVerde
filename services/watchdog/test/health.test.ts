import { describe, it, expect } from "vitest";
import { DeviceHealthTracker } from "../src/health.js";

const SILENCE_AFTER = 20_000;
const FROZEN_N = 12;

function sensorDevices() {
  return [
    { id: "ec-01", kind: "sensor" },
    { id: "ph-01", kind: "sensor" },
    { id: "temp-01", kind: "sensor" },
    { id: "level-01", kind: "sensor" },
    { id: "flow-01", kind: "sensor" },
    { id: "climate-01", kind: "sensor" },
  ];
}

function fullKit() {
  return [
    { id: "ec-01", kind: "sensor" },
    { id: "ph-01", kind: "sensor" },
    { id: "temp-01", kind: "sensor" },
    { id: "level-01", kind: "sensor" },
    { id: "flow-01", kind: "sensor" },
    { id: "climate-01", kind: "sensor" },
    { id: "pump-recirc-01", kind: "switch" },
    { id: "valve-fill-01", kind: "switch" },
    { id: "doser-a-01", kind: "switch" },
    { id: "doser-b-01", kind: "switch" },
    { id: "doser-ph-01", kind: "switch" },
    { id: "cam-01", kind: "camera" },
  ];
}

describe("DeviceHealthTracker", () => {
  it("detecta impossible (ph fuera de rango) -> critical", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: FROZEN_N });
    const now = 1_000_000;
    // ph 20 fuera de 0-14
    t.seenReading("demo", "mod-1", "ph-01", "ph", 20, now);
    const { moduleHealth, transitions } = t.evaluate(sensorDevices(), now + 100);
    expect(moduleHealth.devices["ph-01"]).toBe("impossible");
    expect(moduleHealth.state).toBe("degraded");
    expect(transitions.some((a) => a.name === "device_impossible" && a.device === "ph-01")).toBe(true);
    const imp = transitions.find((a) => a.name === "device_impossible");
    expect(imp?.severity).toBe("critical");
  });

  it("detecta impossible para cada métrica límite", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 1000;
    // ec 11 >10
    t.seenReading("demo", "mod-1", "ec-01", "ec", 11, base);
    // level 120 >110
    t.seenReading("demo", "mod-1", "level-01", "level", 120, base);
    // flow 60 >50
    t.seenReading("demo", "mod-1", "flow-01", "flow", 60, base);
    // temp -20 <-10
    t.seenReading("demo", "mod-1", "temp-01", "temp", -20, base);
    // air_temp -40 <-30
    t.seenReading("demo", "mod-1", "climate-01", "air_temp", -40, base);
    // humidity 150 >100
    // usar otro tracker para humidity isolado
    const t2 = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    t2.seenReading("demo", "mod-1", "climate-01", "humidity", 150, base);
    let r = t.evaluate(sensorDevices(), base + 10);
    expect(r.moduleHealth.devices["ec-01"]).toBe("impossible");
    expect(r.moduleHealth.devices["level-01"]).toBe("impossible");
    expect(r.moduleHealth.devices["flow-01"]).toBe("impossible");
    expect(r.moduleHealth.devices["temp-01"]).toBe("impossible");
    expect(r.moduleHealth.devices["climate-01"]).toBe("impossible");
    const r2 = t2.evaluate([{ id: "climate-01", kind: "sensor" }], base + 10);
    expect(r2.moduleHealth.devices["climate-01"]).toBe("impossible");
  });

  it("frozen tras 12 readings iguales (warn)", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 2_000_000;
    for (let i = 0; i < 12; i++) {
      t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base + i * 5000);
    }
    const { moduleHealth, transitions } = t.evaluate(sensorDevices(), base + 12 * 5000 + 100);
    expect(moduleHealth.devices["ec-01"]).toBe("frozen");
    expect(moduleHealth.state).toBe("degraded");
    expect(transitions.some((a) => a.name === "device_frozen" && a.device === "ec-01" && a.severity === "warn")).toBe(true);
  });

  it("no frozen con 11 repeticiones, sí con 12", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 3_000_000;
    for (let i = 0; i < 11; i++) {
      t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base + i * 1000);
    }
    let r = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + 11 * 1000 + 100);
    expect(r.moduleHealth.devices["ec-01"]).toBe("ok");
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base + 11 * 1000 + 1000);
    r = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + 12 * 1000 + 200);
    expect(r.moduleHealth.devices["ec-01"]).toBe("frozen");
  });

  it("switch exento de frozen (ON/OFF repetido no congela)", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 3 });
    const base = 4_000_000;
    for (let i = 0; i < 20; i++) {
      t.seenReading("demo", "mod-1", "pump-recirc-01", "switch", "ON", base + i * 1000);
    }
    const { moduleHealth } = t.evaluate([{ id: "pump-recirc-01", kind: "switch" }], base + 20 * 1000 + 100);
    expect(moduleHealth.devices["pump-recirc-01"]).toBe("ok");
  });

  it("silence tras > SILENCE_AFTER_MS sin reading (warn)", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 5_000_000;
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.2, base);
    // dentro de ventana: ok
    let r = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + 10_000);
    expect(r.moduleHealth.devices["ec-01"]).toBe("ok");
    // fuera de ventana: silence
    r = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + SILENCE_AFTER + 1000);
    expect(r.moduleHealth.devices["ec-01"]).toBe("silence");
    expect(r.transitions.some((a) => a.name === "device_silence" && a.device === "ec-01" && a.severity === "warn")).toBe(true);
    expect(r.moduleHealth.state).toBe("degraded");
  });

  it("status offline (LWT) -> critical", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 6_000_000;
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base);
    t.seenStatus("demo", "mod-1", "ec-01", "offline", base + 1000);
    const { moduleHealth, transitions } = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + 2000);
    expect(moduleHealth.devices["ec-01"]).toBe("offline");
    expect(moduleHealth.state).toBe("offline");
    expect(transitions.some((a) => a.name === "device_offline" && a.device === "ec-01" && a.severity === "critical")).toBe(true);
  });

  it("transiciones edge-triggered: sin alertas duplicadas si estado no cambia", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 7_000_000;
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base);
    // primera evaluación -> ok sin alertas
    let r = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + 100);
    expect(r.transitions.length).toBe(0);
    // sin cambio, segunda evaluación no debe repetir alerts
    r = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + 200);
    expect(r.transitions.length).toBe(0);

    // provocar silence
    r = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + SILENCE_AFTER + 5000);
    expect(r.transitions.some((a) => a.name === "device_silence")).toBe(true);
    // repetir silence sin publicar de nuevo
    r = t.evaluate([{ id: "ec-01", kind: "sensor" }], base + SILENCE_AFTER + 6000);
    expect(r.transitions.filter((a) => a.name === "device_silence").length).toBe(0);
  });

  it("recuperación -> device_recovered info y módulo vuelve a ok", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 8_000_000;
    // llevar a impossible
    t.seenReading("demo", "mod-1", "ph-01", "ph", 20, base);
    let r = t.evaluate(sensorDevices(), base + 100);
    expect(r.moduleHealth.devices["ph-01"]).toBe("impossible");
    // recuperación con valor válido
    t.seenReading("demo", "mod-1", "ph-01", "ph", 6.0, base + 2000);
    // también alimentar resto de sensores para que módulo no quede blind/degraded por silence
    for (const id of ["ec-01", "temp-01", "level-01", "flow-01", "climate-01"]) {
      const metric = id === "climate-01" ? "air_temp" : id.split("-")[0] === "ec" ? "ec" : id.split("-")[0];
      const v = id === "climate-01" ? 22 : 1.5;
      const m = id === "climate-01" ? "air_temp" : id === "ec-01" ? "ec" : id === "temp-01" ? "temp" : id === "level-01" ? "level" : "flow";
      t.seenReading("demo", "mod-1", id, m, v, base + 2000);
    }
    r = t.evaluate(sensorDevices(), base + 2100);
    expect(r.moduleHealth.devices["ph-01"]).toBe("ok");
    expect(r.transitions.some((a) => a.name === "device_recovered" && a.device === "ph-01" && a.severity === "info")).toBe(true);
  });

  it("módulo blind solo cuando TODOS los sensores están mudos", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 9_000_000;
    // Sin ningún reading, todos silence -> blind
    let r = t.evaluate(fullKit(), base + 1000);
    expect(r.moduleHealth.state).toBe("blind");
    expect(r.transitions.some((a) => a.name === "module_blind")).toBe(true);

    // Un solo sensor vivo -> deja de ser blind (degraded u ok)
    const t2 = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    t2.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base);
    r = t2.evaluate(fullKit(), base + 1000);
    expect(r.moduleHealth.state).not.toBe("blind");
    // Con un sensor ok pero otros mudos, estado debe ser degraded (no blind)
    expect(r.moduleHealth.state).toBe("degraded");
  });

  it("módulo blind no se activa si algún sensor está ok aunque switches estén mudos", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 10_000_000;
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base);
    const { moduleHealth } = t.evaluate(fullKit(), base + 100);
    expect(moduleHealth.state).not.toBe("blind");
  });

  it("módulo offline si algún dispositivo offline (aunque no sea blind)", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 11_000_000;
    // al menos un sensor vivo para no ser blind
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base);
    t.seenReading("demo", "mod-1", "ph-01", "ph", 6.0, base);
    t.seenReading("demo", "mod-1", "temp-01", "temp", 22, base);
    t.seenReading("demo", "mod-1", "level-01", "level", 50, base);
    t.seenReading("demo", "mod-1", "flow-01", "flow", 5, base);
    t.seenReading("demo", "mod-1", "climate-01", "air_temp", 25, base);
    t.seenStatus("demo", "mod-1", "ph-01", "offline", base + 100);
    const { moduleHealth } = t.evaluate(fullKit(), base + 200);
    expect(moduleHealth.state).toBe("offline");
    // debe ser offline aunque no blind
    expect(moduleHealth.state).not.toBe("blind");
  });

  it("recuperación de módulo blind -> module_recovered", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 12_000_000;
    // iniciar blind
    let r = t.evaluate(fullKit(), base);
    expect(r.moduleHealth.state).toBe("blind");
    // alimentar todos los sensores para salir de blind
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, base + 1000);
    t.seenReading("demo", "mod-1", "ph-01", "ph", 6.0, base + 1000);
    t.seenReading("demo", "mod-1", "temp-01", "temp", 22, base + 1000);
    t.seenReading("demo", "mod-1", "level-01", "level", 50, base + 1000);
    t.seenReading("demo", "mod-1", "flow-01", "flow", 5, base + 1000);
    t.seenReading("demo", "mod-1", "climate-01", "air_temp", 25, base + 1000);
    r = t.evaluate(fullKit(), base + 1100);
    expect(r.moduleHealth.state).not.toBe("blind");
    expect(r.transitions.some((a) => a.name === "module_recovered" && a.severity === "info")).toBe(true);
  });

  it("cero duplicados: múltiples evaluate en blind no repiten module_blind", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 12 });
    const base = 13_000_000;
    let r = t.evaluate(fullKit(), base);
    expect(r.transitions.some((a) => a.name === "module_blind")).toBe(true);
    r = t.evaluate(fullKit(), base + 1000);
    expect(r.transitions.filter((a) => a.name === "module_blind").length).toBe(0);
  });

  it("switch exento de impossible y frozen pero sí puede estar offline/silence", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: 3 });
    const base = 14_000_000;
    // switch con valor numérico fuera de rangos de sensor no debe ser impossible
    t.seenReading("demo", "mod-1", "pump-recirc-01", "switch", "ON", base);
    let r = t.evaluate([{ id: "pump-recirc-01", kind: "switch" }], base + 100);
    expect(r.moduleHealth.devices["pump-recirc-01"]).toBe("ok");
    // offline sí afecta switch
    t.seenStatus("demo", "mod-1", "pump-recirc-01", "offline", base + 200);
    r = t.evaluate([{ id: "pump-recirc-01", kind: "switch" }], base + 300);
    expect(r.moduleHealth.devices["pump-recirc-01"]).toBe("offline");
  });
});

describe("reloj de llegada (inmune a --speed N del sim)", () => {
  it("status offline STALE (llegó antes que readings frescos) NO marca offline", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: FROZEN_N });
    // LWT viejo: status offline llegó en t=1000 (payload ts real de la muerte anterior)
    t.seenStatus("demo", "mod-1", "ec-01", "offline", 1000, 1000);
    // readings frescos llegan después, con ts de payload de reloj sim muy adelantado
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, 9_000_000, 5000);
    const { moduleHealth, transitions } = t.evaluate(sensorDevices(), 5100);
    expect(moduleHealth.devices["ec-01"]).toBe("ok");
    expect(transitions.some((a) => a.name === "device_offline" && a.device === "ec-01")).toBe(false);
  });

  it("LWT FRESCO (llega después de la última lectura) sí marca offline", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: FROZEN_N });
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, 9_000_000, 5000);
    // el dispositivo muere: el LWT llega en t=7000 (payload ts es Date.now() real del broker)
    t.seenStatus("demo", "mod-1", "ec-01", "offline", 7000, 7000);
    const { moduleHealth, transitions } = t.evaluate(sensorDevices(), 7100);
    expect(moduleHealth.devices["ec-01"]).toBe("offline");
    expect(transitions.some((a) => a.name === "device_offline" && a.device === "ec-01" && a.severity === "critical")).toBe(true);
  });

  it("silencio se mide por llegada real: payload sim-ts adelantado no enmascara silencio", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: FROZEN_N });
    // reading con ts de payload MUY adelantado (speed 60) pero llegó hace 30s reales
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, 99_000_000, 10_000);
    const { moduleHealth } = t.evaluate(sensorDevices(), 10_000 + SILENCE_AFTER + 1);
    expect(moduleHealth.devices["ec-01"]).toBe("silence");
  });

  it("recuperación tras LWT: vuelve online cuando llegan readings nuevos", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: FROZEN_N });
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, 1000, 1000);
    t.seenStatus("demo", "mod-1", "ec-01", "offline", 2000, 2000);
    let r = t.evaluate(sensorDevices(), 2100);
    expect(r.moduleHealth.devices["ec-01"]).toBe("offline");
    // resucita: readings con llegada posterior al LWT
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.6, 3000, 3000);
    r = t.evaluate(sensorDevices(), 3100);
    expect(r.moduleHealth.devices["ec-01"]).toBe("ok");
    expect(r.transitions.some((a) => a.name === "device_recovered" && a.device === "ec-01")).toBe(true);
  });
});

describe("cámara (sin cadencia de readings)", () => {
  it("cam-01 nunca vista NO es silence; su salud es solo LWT", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: FROZEN_N });
    const kit = [{ id: "ec-01", kind: "sensor" }, { id: "ph-01", kind: "sensor" }, { id: "cam-01", kind: "camera" }];
    t.seenReading("demo", "mod-1", "ec-01", "ec", 1.5, 1000);
    t.seenReading("demo", "mod-1", "ph-01", "ph", 6.1, 1000);
    const { moduleHealth, transitions } = t.evaluate(kit, 2000);
    expect(moduleHealth.devices["cam-01"]).toBe("ok");
    expect(moduleHealth.state).toBe("ok");
    expect(transitions.some((a) => a.device === "cam-01")).toBe(false);
  });

  it("cam-01 con LWT offline sí se marca offline", () => {
    const t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER, frozenReadings: FROZEN_N });
    t.seenStatus("demo", "mod-1", "cam-01", "offline", 1000);
    const { moduleHealth } = t.evaluate([{ id: "cam-01", kind: "camera" }], 1100);
    expect(moduleHealth.devices["cam-01"]).toBe("offline");
  });
});
