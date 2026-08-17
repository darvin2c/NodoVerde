// Tests de la lógica pura del laboratorio: asignación de identidades (lab.ts).
import { describe, it, expect } from "vitest";
import { nextHwId, nextModuleId } from "../src/lab.js";

describe("nextModuleId", () => {
  it("empieza en mod-1 con mundo vacío", () => {
    expect(nextModuleId([])).toBe("mod-1");
  });

  it("extiende correlativo cuando no hay huecos", () => {
    expect(nextModuleId([1, 2, 3, 4])).toBe("mod-5");
  });

  it("rellena el primer hueco antes de extender", () => {
    expect(nextModuleId([1, 3, 4])).toBe("mod-2");
    expect(nextModuleId([2])).toBe("mod-1");
  });
});

describe("nextHwId", () => {
  it("arranca en la base +1 con mundo vacío", () => {
    expect(nextHwId([])).toBe("020000000001");
  });

  it("usa max+1 en hex y mantiene 12 dígitos", () => {
    expect(nextHwId(["020000000001", "020000000004"])).toBe("020000000005");
  });

  it("ignora ids no hex", () => {
    expect(nextHwId(["mod-1", "020000000002"])).toBe("020000000003");
  });
});
