import { describe, it, expect } from "vitest";

import { isValidHwId, nextModuleId, moduleInBatch } from "../src/write.js";

// Lógica pura del provisionamiento gobernado de módulos (ADR-0022).
// Las reglas duras (bloqueo por lote activo, un fierro por módulo) viven en
// código aquí y en los statements de write.ts — jamás en una skill (ADR-0019).

describe("isValidHwId — formato de fábrica", () => {
  it("12 hex minúsculas válido", () => {
    expect(isValidHwId("020000000005")).toBe(true);
    expect(isValidHwId("aabbccddeeff")).toBe(true);
  });

  it("rechaza mayúsculas, cortos, largos y no-hex", () => {
    expect(isValidHwId("02000000000A")).toBe(false); // mayúscula
    expect(isValidHwId("02000000005")).toBe(false); // 11 chars
    expect(isValidHwId("0200000000055")).toBe(false); // 13 chars
    expect(isValidHwId("zz0000000005")).toBe(false); // no-hex
    expect(isValidHwId("")).toBe(false);
  });
});

describe("nextModuleId — id técnico autogenerado", () => {
  it("sin módulos → mod-1", () => {
    expect(nextModuleId([])).toBe("mod-1");
  });

  it("max+1 sobre ids existentes", () => {
    expect(nextModuleId(["mod-1", "mod-2", "mod-4"])).toBe("mod-5");
  });

  it("nunca reutiliza el id de un módulo retirado", () => {
    // mod-3 retirado: el hueco NO se rellena — un id jamás vuelve a la vida
    expect(nextModuleId(["mod-1", "mod-2", "mod-4"])).toBe("mod-5");
  });

  it("ignora ids que no siguen el patrón mod-N (legacy o manuales)", () => {
    expect(nextModuleId(["mod-1", "mesa-vieja", "mod-2"])).toBe("mod-3");
  });

  it("mod-10+ parsea bien (no lexicográfico)", () => {
    expect(nextModuleId(["mod-9", "mod-10"])).toBe("mod-11");
  });
});

describe("moduleInBatch — congelamiento ADR-0024", () => {
  it("módulo dentro de la lista congelada → true", () => {
    expect(moduleInBatch(["mod-1", "mod-2"], "mod-2")).toBe(true);
  });

  it("módulo fuera de la lista → false", () => {
    expect(moduleInBatch(["mod-1", "mod-2"], "mod-3")).toBe(false);
  });

  it("acepta modules como string JSON (pg TEXT) o array (pg JSONB)", () => {
    expect(moduleInBatch('["mod-1"]', "mod-1")).toBe(true);
    expect(moduleInBatch(["mod-1"], "mod-1")).toBe(true);
  });

  it("payload roto → false (defensivo, nunca lanza)", () => {
    expect(moduleInBatch("no-json", "mod-1")).toBe(false);
    expect(moduleInBatch(null, "mod-1")).toBe(false);
    expect(moduleInBatch({ a: 1 }, "mod-1")).toBe(false);
  });
});
