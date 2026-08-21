import { describe, it, expect } from "vitest";

import { isValidHwId, nextModuleId, moduleInBatch, computeExpectedEnd, canRemoveModuleFromBatch } from "../src/write.js";

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

import { isValidCropName, isValidProfileRanges } from "../src/write.js";

// Perfiles de cultivo gobernados (ADR-0025, regla 9: solo humano vía PWA)

describe("isValidCropName — slug de cultivo", () => {
  it("acepta especie y especie_variedad", () => {
    expect(isValidCropName("lechuga")).toBe(true);
    expect(isValidCropName("lechuga_romana")).toBe(true);
  });

  it("rechaza mayúsculas, espacios, guiones y cortos", () => {
    expect(isValidCropName("Lechuga")).toBe(false);
    expect(isValidCropName("lechuga romana")).toBe(false);
    expect(isValidCropName("lechuga-romana")).toBe(false);
    expect(isValidCropName("l")).toBe(false);
  });
});

describe("isValidProfileRanges — coherencia biológica", () => {
  const ok = { ec_min: 1.2, ec_max: 1.8, ph_min: 5.8, ph_max: 6.3, water_temp_min: 18, water_temp_max: 24 };

  it("acepta rangos coherentes", () => {
    expect(isValidProfileRanges(ok)).toBe(true);
  });

  it("rechaza min >= max en cualquier variable", () => {
    expect(isValidProfileRanges({ ...ok, ec_min: 2.0, ec_max: 1.8 })).toBe(false);
    expect(isValidProfileRanges({ ...ok, ph_min: 6.3, ph_max: 6.3 })).toBe(false);
    expect(isValidProfileRanges({ ...ok, water_temp_min: 30, water_temp_max: 24 })).toBe(false);
  });

  it("rechaza pH fuera de 0-14 y valores no finitos", () => {
    expect(isValidProfileRanges({ ...ok, ph_max: 15 })).toBe(false);
    expect(isValidProfileRanges({ ...ok, ec_min: NaN })).toBe(false);
  });
});

describe("computeExpectedEnd — fechas gobernadas por el humano (ADR-0026)", () => {
  const start = new Date("2026-08-21T12:00:00Z");

  it("override manual gana sobre el cálculo del perfil", () => {
    const override = new Date("2026-10-01T00:00:00Z");
    expect(computeExpectedEnd(start, 35, override)).toEqual(override);
  });

  it("sin override: inicio + cycle_days", () => {
    const end = computeExpectedEnd(start, 35, null);
    expect(end).toEqual(new Date(start.getTime() + 35 * 86400000));
  });

  it("perfil sin ciclo y sin override → null (honesto: sin fin estimado)", () => {
    expect(computeExpectedEnd(start, null, null)).toBeNull();
  });

  it("inicio pasado (registro tardío) empuja el fin al pasado correspondiente", () => {
    const past = new Date("2026-08-01T00:00:00Z");
    expect(computeExpectedEnd(past, 10, null)).toEqual(new Date("2026-08-11T00:00:00Z"));
  });
});

describe("canRemoveModuleFromBatch — retiro sin cerrar el lote (ADR-0026)", () => {
  it("retira una mesa y devuelve las restantes", () => {
    const r = canRemoveModuleFromBatch(["mod-1", "mod-2", "mod-3"], "mod-2");
    expect(r).toEqual({ ok: true, remaining: ["mod-1", "mod-3"] });
  });

  it("acepta modules como string JSONB (tal cual viene de pg)", () => {
    const r = canRemoveModuleFromBatch('["mod-1","mod-2"]', "mod-1");
    expect(r).toEqual({ ok: true, remaining: ["mod-2"] });
  });

  it("la última mesa NO se retira — el lote se cierra con close_batch", () => {
    expect(canRemoveModuleFromBatch(["mod-1"], "mod-1")).toEqual({ ok: false, reason: "last_module" });
  });

  it("módulo ajeno al lote → module_not_in_batch", () => {
    expect(canRemoveModuleFromBatch(["mod-1", "mod-2"], "mod-9")).toEqual({ ok: false, reason: "module_not_in_batch" });
  });

  it("modules corrupto → module_not_in_batch (defensivo)", () => {
    expect(canRemoveModuleFromBatch("no-json", "mod-1")).toEqual({ ok: false, reason: "module_not_in_batch" });
  });
});
