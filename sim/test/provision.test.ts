import { describe, it, expect } from "vitest";

import { buildKit, KIT_CAPABILITIES } from "../src/provision.js";
import { SENSOR_DEVICES, SWITCH_DEVICES, ALL_DEVICES } from "../src/node/behavior.js";

// Kit declarativo del nodo (ADR-0028): capability por dispositivo, sin ids
// duplicados — la fuente de verdad de los ids es behavior.ts (firmware emulado).

describe("buildKit — kit declarativo del nodo", () => {
  it("cubre exactamente los 12 dispositivos del firmware emulado", () => {
    const kit = buildKit();
    expect(kit.map((d) => d.id).sort()).toEqual([...ALL_DEVICES].sort());
    expect(kit).toHaveLength(12);
  });

  it("kinds correctos: sensores, switches y cámara", () => {
    const kit = buildKit();
    for (const id of SENSOR_DEVICES) expect(kit.find((d) => d.id === id)?.kind).toBe("sensor");
    for (const id of SWITCH_DEVICES) expect(kit.find((d) => d.id === id)?.kind).toBe("switch");
    expect(kit.find((d) => d.id === "cam-01")?.kind).toBe("camera");
  });

  it("sensores alimentan su métrica; actuadores declaran clase de acción; cámara NULL", () => {
    expect(KIT_CAPABILITIES["ec-01"]).toBe("ec");
    expect(KIT_CAPABILITIES["level-01"]).toBe("level");
    expect(KIT_CAPABILITIES["doser-a-01"]).toBe("dose_nutrient");
    expect(KIT_CAPABILITIES["doser-b-01"]).toBe("dose_nutrient");
    expect(KIT_CAPABILITIES["doser-ph-01"]).toBe("dose_ph");
    expect(KIT_CAPABILITIES["valve-fill-01"]).toBe("fill_water");
    expect(KIT_CAPABILITIES["pump-recirc-01"]).toBe("recirculate");
    expect(KIT_CAPABILITIES["cam-01"]).toBeNull();
  });

  it("ningún dispositivo queda sin entrada en KIT_CAPABILITIES", () => {
    for (const id of ALL_DEVICES) expect(Object.hasOwn(KIT_CAPABILITIES, id)).toBe(true);
  });
});
