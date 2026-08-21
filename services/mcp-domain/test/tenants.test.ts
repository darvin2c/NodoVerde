import { describe, it, expect } from "vitest";
import tzLookup from "tz-lookup";

import { isValidTenantId, isValidCurrency, isValidLatLon } from "../src/write.js";

// Lógica pura de la gestión de fincas (ADR-0023).
// Reglas duras: id = slug inmutable elegido por el usuario; lat/lon obligatorias
// (clima/ET0); moneda ISO 4217 para no mezclar monedas en resúmenes; nada se
// borra (archivar = archived_at, ADR-0011).

describe("isValidTenantId — slug inmutable visible en topics MQTT", () => {
  it("slugs válidos", () => {
    expect(isValidTenantId("demo")).toBe(true);
    expect(isValidTenantId("finca-norte")).toBe(true);
    expect(isValidTenantId("el-roble-2")).toBe(true);
  });

  it("rechaza mayúsculas, espacios, tildes y guion inicial", () => {
    expect(isValidTenantId("Demo")).toBe(false);
    expect(isValidTenantId("finca norte")).toBe(false);
    expect(isValidTenantId("niña")).toBe(false);
    expect(isValidTenantId("-norte")).toBe(false);
    expect(isValidTenantId("")).toBe(false);
    expect(isValidTenantId("a")).toBe(false); // mínimo 2 chars
  });

  it("rechaza slugs largos (>48 chars)", () => {
    expect(isValidTenantId("a".repeat(49))).toBe(false);
  });
});

describe("isValidCurrency — ISO 4217, nunca mezclar monedas", () => {
  it("3 letras mayúsculas", () => {
    expect(isValidCurrency("PEN")).toBe(true);
    expect(isValidCurrency("USD")).toBe(true);
  });

  it("rechaza minúsculas, símbolos y largos incorrectos", () => {
    expect(isValidCurrency("pen")).toBe(false);
    expect(isValidCurrency("S/")).toBe(false);
    expect(isValidCurrency("PENS")).toBe(false);
    expect(isValidCurrency("PE")).toBe(false);
  });
});

describe("isValidLatLon — coordenadas obligatorias (clima/ET0)", () => {
  it("coordenadas terrestres válidas", () => {
    expect(isValidLatLon(-6.486, -79.647)).toBe(true); // Lambayeque
    expect(isValidLatLon(0, 0)).toBe(true);
    expect(isValidLatLon(90, 180)).toBe(true);
    expect(isValidLatLon(-90, -180)).toBe(true);
  });

  it("rechaza fuera de rango y no-números", () => {
    expect(isValidLatLon(91, 0)).toBe(false);
    expect(isValidLatLon(0, 181)).toBe(false);
    expect(isValidLatLon(NaN, 0)).toBe(false);
    expect(isValidLatLon(0, Infinity)).toBe(false);
  });
});

describe("tz-lookup — derivación offline de zona horaria", () => {
  it("Lambayeque → America/Lima", () => {
    expect(tzLookup(-6.486, -79.647)).toBe("America/Lima");
  });

  it("coordenadas en océano → zona náutica Etc/GMT±N (no lanza)", () => {
    expect(tzLookup(0, -140)).toBe("Etc/GMT+9");
  });

  it("coordenadas fuera de rango → lanza (el tool las rechaza antes con isValidLatLon)", () => {
    expect(() => tzLookup(91, 0)).toThrow();
  });
});
