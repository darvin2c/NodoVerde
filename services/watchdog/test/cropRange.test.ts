import { describe, it, expect } from "vitest";

import { RangeTracker, type CropRanges } from "../src/cropRange.js";

// Rangos de cultivo (ADR-0028): el watchdog es el único evaluador agronómico.
// Edge-triggered: alerta solo en transición; silencio mientras el estado persiste.

const LECHUGA: CropRanges = { ec: [1.2, 1.8], ph: [5.8, 6.3], temp: [18, 24] };

function trackerConPerfil(): RangeTracker {
  const t = new RangeTracker(15);
  t.setProfiles(new Map([["demo/mod-1", { crop: "lechuga", ranges: LECHUGA }]]));
  return t;
}

describe("RangeTracker — rangos de cultivo", () => {
  it("transición in→out emite crop_out_of_range exactamente una vez", () => {
    const t = trackerConPerfil();
    expect(t.seen("demo", "mod-1", "ec", 1.5)).toEqual([]); // in (primera lectura)
    const alerts = t.seen("demo", "mod-1", "ec", 1.1); // cae bajo el piso
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe("crop_out_of_range");
    expect(alerts[0].severity).toBe("warn");
    expect(alerts[0].detail).toMatchObject({ metric: "ec", value: 1.1, min: 1.2, max: 1.8, crop: "lechuga" });
    // silencio mientras sigue fuera
    expect(t.seen("demo", "mod-1", "ec", 1.0)).toEqual([]);
    expect(t.seen("demo", "mod-1", "ec", 0.9)).toEqual([]);
  });

  it("transición out→in emite crop_in_range (info)", () => {
    const t = trackerConPerfil();
    t.seen("demo", "mod-1", "ec", 1.1); // out
    const alerts = t.seen("demo", "mod-1", "ec", 1.4); // recupera
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe("crop_in_range");
    expect(alerts[0].severity).toBe("info");
    expect(alerts[0].detail).toMatchObject({ metric: "ec", value: 1.4, crop: "lechuga" });
  });

  it("primera lectura ya fuera de rango emite (la gracia de arranque la suprime en index.ts)", () => {
    const t = trackerConPerfil();
    const alerts = t.seen("demo", "mod-1", "ph", 7.0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe("crop_out_of_range");
  });

  it("módulo sin perfil cargado no emite nada", () => {
    const t = new RangeTracker(15);
    expect(t.seen("demo", "mod-9", "ec", 0.1)).toEqual([]);
    expect(t.seen("demo", "mod-9", "ph", 9.9)).toEqual([]);
  });

  it("métrica sin rango en el perfil (flow) no emite", () => {
    const t = trackerConPerfil();
    expect(t.seen("demo", "mod-1", "flow", 999)).toEqual([]);
  });

  it("perfil retirado (setProfiles sin el módulo) deja de evaluar y olvida el estado", () => {
    const t = trackerConPerfil();
    t.seen("demo", "mod-1", "ec", 1.1); // out
    t.setProfiles(new Map()); // lote cerrado → mesa libre
    expect(t.seen("demo", "mod-1", "ec", 0.5)).toEqual([]);
    // si el perfil vuelve, la primera lectura se evalúa fresca
    t.setProfiles(new Map([["demo/mod-1", { crop: "lechuga", ranges: LECHUGA }]]));
    expect(t.seen("demo", "mod-1", "ec", 1.5)).toEqual([]); // in, sin falso crop_in_range
  });
});

describe("RangeTracker — nivel (invariante física, sin cultivo)", () => {
  it("level bajo umbral emite level_low critical y level_ok al recuperar", () => {
    const t = new RangeTracker(15); // sin perfil alguno
    expect(t.seen("demo", "mod-2", "level", 80)).toEqual([]); // in (primera)
    const low = t.seen("demo", "mod-2", "level", 12);
    expect(low).toHaveLength(1);
    expect(low[0].name).toBe("level_low");
    expect(low[0].severity).toBe("critical");
    expect(low[0].detail).toMatchObject({ value: 12, threshold: 15 });
    expect(t.seen("demo", "mod-2", "level", 10)).toEqual([]); // silencio
    const ok = t.seen("demo", "mod-2", "level", 50);
    expect(ok).toHaveLength(1);
    expect(ok[0].name).toBe("level_ok");
    expect(ok[0].severity).toBe("info");
  });

  it("level NO pierde su estado al recargar perfiles", () => {
    const t = new RangeTracker(15);
    t.seen("demo", "mod-2", "level", 12); // low
    t.setProfiles(new Map());
    expect(t.seen("demo", "mod-2", "level", 11)).toEqual([]); // sigue low, sin re-alerta
    expect(t.seen("demo", "mod-2", "level", 50)).toHaveLength(1); // level_ok
  });
});

describe("RangeTracker — parse defensivo", () => {
  it("valor no numérico o no finito no tumba el tracker", () => {
    const t = trackerConPerfil();
    expect(t.seen("demo", "mod-1", "ec", "mucho")).toEqual([]);
    expect(t.seen("demo", "mod-1", "ec", NaN)).toEqual([]);
    expect(t.seen("demo", "mod-1", "ec", Infinity)).toEqual([]);
    expect(t.seen("demo", "mod-1", "level", undefined)).toEqual([]);
    // y el tracker sigue sano después
    expect(t.seen("demo", "mod-1", "ec", 1.5)).toEqual([]);
    expect(t.seen("demo", "mod-1", "ec", 1.1)).toHaveLength(1);
  });
});
