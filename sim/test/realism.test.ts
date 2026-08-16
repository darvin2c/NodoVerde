import { describe, it, expect } from "vitest";
import { syntheticWeather, weatherAt } from "../src/weather.js";
import { measure, SENSOR_SPECS } from "../src/sensors.js";
import { mulberry32, createInitialModule, stepModule, triggerDoserA, DEFAULT_PARAMS } from "../src/model.js";

describe("weather: replay de serie", () => {
  it("sintética: 24h determinísticas y replay en loop", () => {
    const w = syntheticWeather(-6.7, -79.9);
    expect(w.synthetic).toBe(true);
    expect(w.hours.airTemp).toHaveLength(24);
    // mismo instante → mismo valor (determinístico)
    const a = weatherAt(w, 13 * 3_600_000);
    const b = weatherAt(w, 13 * 3_600_000);
    expect(a).toEqual(b);
    // loop: hora 25 == hora 1
    expect(weatherAt(w, 25 * 3_600_000)).toEqual(weatherAt(w, 1 * 3_600_000));
    // ET0 nocturna cero, pico de día
    expect(weatherAt(w, 3 * 3_600_000).et0).toBe(0);
    expect(weatherAt(w, 13 * 3_600_000).et0).toBeGreaterThan(0.5);
  });

  it("serie real simulada: respeta índice y envuelve", () => {
    const w = syntheticWeather(0, 0);
    w.hours.airTemp = [10, 20, 30];
    w.hours.humidity = [50, 60, 70];
    w.hours.et0 = [0, 0.5, 1];
    expect(weatherAt(w, 0).airTemp).toBe(10);
    expect(weatherAt(w, 2 * 3_600_000).airTemp).toBe(30);
    expect(weatherAt(w, 3 * 3_600_000).airTemp).toBe(10); // wrap
  });
});

describe("sensores: capa de medición", () => {
  it("reproducible con misma semilla de stream", () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    const s1 = Array.from({ length: 20 }, () => measure("ph", 6.0, 2, r1));
    const s2 = Array.from({ length: 20 }, () => measure("ph", 6.0, 2, r2));
    expect(s1).toEqual(s2);
  });

  it("ruido acotado alrededor del valor verdadero", () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 200; i++) {
      const v = measure("ec", 1.5, 0, rng);
      expect(Math.abs(v - 1.5)).toBeLessThan(6 * SENSOR_SPECS.ec.sigma + 0.01);
    }
  });

  it("deriva de electrodo pH acumula con los días", () => {
    // sin ruido: drift día 10 > día 0
    const zero = () => 0.5; // gaussian ≈ 0 con u1=u2=0.5? Box-Muller(0.5,0.5)≈1.18 — mejor medir diferencia con mismo rng reiniciado
    const mk = () => mulberry32(3);
    void zero;
    const d0 = measure("ph", 6.0, 0, mk());
    const d10 = measure("ph", 6.0, 10, mk());
    expect(d10 - d0).toBeCloseTo(SENSOR_SPECS.ph.driftPerDay * 10, 2);
  });

  it("cuantización DS18B20: múltiplos de 0.0625", () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 50; i++) {
      const v = measure("temp", 21.3, 0, rng);
      expect(Math.abs(v / 0.0625 - Math.round(v / 0.0625))).toBeLessThan(1e-6);
    }
  });

  it("métrica desconocida pasa el valor intacto", () => {
    expect(measure("switch", 1, 0, mulberry32(1))).toBe(1);
  });
});

describe("mezcla gradual de dosis", () => {
  it("a media mezcla ≈ mitad del delta; a mezcla completa ≈ delta entero", () => {
    const clim = { airTemp: 22, humidity: 60 };
    const ts = Date.UTC(2024, 7, 1, 8, 0, 0);
    let s = { ...createInitialModule("mod-1", "lechuga", [1.2, 1.8]), ec: 1.5, ph: 6.0, tankLevel: 100 };
    s = triggerDoserA(s, 2000);
    s = stepModule(s, 2, ts, 0, clim, DEFAULT_PARAMS); // expira pulso → encola 0.12
    const base = s.ec;
    expect(s.pendingEc).toBeGreaterThan(0.1);
    // 5 min: mitad del pending restante
    s = stepModule(s, 300, ts + 300_000, 0, clim, DEFAULT_PARAMS);
    const halfApplied = s.ec - base;
    expect(halfApplied).toBeGreaterThan(0.02);
    expect(halfApplied).toBeLessThan(0.1);
    // 10 min más: casi todo incorporado
    s = stepModule(s, 600, ts + 900_000, 0, clim, DEFAULT_PARAMS);
    expect(Math.abs(s.pendingEc)).toBeLessThan(0.005);
  });
});
