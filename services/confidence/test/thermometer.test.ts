import { describe, it, expect } from "vitest";
import {
  variableConfidence,
  moduleConfidence,
  HALF_LIVES_MS,
  DEFAULT_WEIGHTS,
  DEFAULT_HALF_LIFE_MS,
} from "../src/thermometer.js";

// Helper: ahora fijo para determinismo
const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

describe("variableConfidence — fuente × edad (plan de pruebas Fase 1)", () => {
  it("sensor fresco → ~95 (nunca 100)", () => {
    const v = variableConfidence({ source: "sensor", metric: "ec", publishedAtMs: NOW, nowMs: NOW });
    expect(v).toBe(95);
    expect(v).toBeLessThanOrEqual(95);
  });

  it("foto fresca → 75", () => {
    const v = variableConfidence({ source: "photo", metric: "photo", publishedAtMs: NOW, nowMs: NOW });
    expect(v).toBe(75);
  });

  it("reporte humano fresco → 65", () => {
    const v = variableConfidence({ source: "human", metric: "ec", publishedAtMs: NOW, nowMs: NOW });
    expect(v).toBe(65);
  });

  it("ausencia de dato → 0 explícito (null)", () => {
    expect(variableConfidence({ source: "sensor", metric: "ec", publishedAtMs: null, nowMs: NOW })).toBe(0);
    expect(variableConfidence({ source: "sensor", metric: "ec", publishedAtMs: undefined, nowMs: NOW })).toBe(0);
  });

  it("edad 0 → base (sin decaimiento)", () => {
    const v = variableConfidence({ source: "sensor", metric: "ec", publishedAtMs: NOW, nowMs: NOW });
    expect(v).toBe(95);
  });

  it("edad = semivida → base/2 (ec 2h)", () => {
    const half = HALF_LIVES_MS.ec; // 2h
    const v = variableConfidence({
      source: "sensor",
      metric: "ec",
      publishedAtMs: NOW - half,
      nowMs: NOW,
    });
    expect(v).toBe(47.5); // 95/2
  });

  it("edad = semivida → base/2 (level 10min)", () => {
    const half = HALF_LIVES_MS.level;
    const v = variableConfidence({
      source: "sensor",
      metric: "level",
      publishedAtMs: NOW - half,
      nowMs: NOW,
    });
    expect(v).toBe(47.5);
  });

  it("edad = semivida foto → 37.5 (75/2, photo 6h)", () => {
    const half = HALF_LIVES_MS.photo;
    const v = variableConfidence({
      source: "photo",
      metric: "photo",
      publishedAtMs: NOW - half,
      nowMs: NOW,
    });
    expect(v).toBe(37.5);
  });

  it("decaimiento a 3 semividas → base × 0.125", () => {
    const half = HALF_LIVES_MS.ec;
    const v = variableConfidence({
      source: "sensor",
      metric: "ec",
      publishedAtMs: NOW - 3 * half,
      nowMs: NOW,
    });
    // 95 * 0.125 = 11.875 → 11.9 redondeado a 1 decimal
    expect(v).toBe(11.9);
  });

  it("decaimiento 3 semividas foto → 9.4 (75×0.125=9.375→9.4)", () => {
    const half = HALF_LIVES_MS.photo;
    const v = variableConfidence({
      source: "photo",
      metric: "photo",
      publishedAtMs: NOW - 3 * half,
      nowMs: NOW,
    });
    expect(v).toBe(9.4);
  });

  it("nunca 100 — sensor con baseOverride >95 sigue en 95", () => {
    const v = variableConfidence({
      source: "sensor",
      metric: "ec",
      publishedAtMs: NOW,
      nowMs: NOW,
      baseOverride: 100,
    });
    expect(v).toBe(95);
    expect(v).toBeLessThanOrEqual(95);
  });

  it("nunca 100 — incluso con baseOverride 99 y edad 0", () => {
    const v = variableConfidence({
      source: "sensor",
      metric: "temp",
      publishedAtMs: NOW,
      nowMs: NOW,
      baseOverride: 99,
    });
    expect(v).toBe(95);
  });

  it("sensor con baseOverride menor (deriva del sim) usa el menor", () => {
    // El sim publica confianza 70 por deriva acumulada → base 70
    const v = variableConfidence({
      source: "sensor",
      metric: "ec",
      publishedAtMs: NOW,
      nowMs: NOW,
      baseOverride: 70,
    });
    expect(v).toBe(70);
  });

  it("sensor con baseOverride 80 a 1 semivida → 40", () => {
    const half = HALF_LIVES_MS.ec;
    const v = variableConfidence({
      source: "sensor",
      metric: "ec",
      publishedAtMs: NOW - half,
      nowMs: NOW,
      baseOverride: 80,
    });
    expect(v).toBe(40);
  });

  it("métrica desconocida → semivida default 1h", () => {
    const half = DEFAULT_HALF_LIFE_MS;
    const v = variableConfidence({
      source: "sensor",
      metric: "metrica_rara",
      publishedAtMs: NOW - half,
      nowMs: NOW,
    });
    expect(v).toBe(47.5);
  });

  it("edad muy grande → tiende a 0", () => {
    const tenHalfLives = 10 * HALF_LIVES_MS.ec;
    const v = variableConfidence({
      source: "sensor",
      metric: "ec",
      publishedAtMs: NOW - tenHalfLives,
      nowMs: NOW,
    });
    expect(v).toBeCloseTo(0.1, 1); // 95 * 0.5^10 ≈ 0.09 → 0.1
  });

  it("edad negativa (reloj adelantado) → trata como fresca (base)", () => {
    const v = variableConfidence({
      source: "sensor",
      metric: "ec",
      publishedAtMs: NOW + 10000,
      nowMs: NOW,
    });
    expect(v).toBe(95);
  });

  it("determinismo: misma entrada → misma salida", () => {
    const opts = { source: "sensor" as const, metric: "ph", publishedAtMs: NOW - 123456, nowMs: NOW };
    expect(variableConfidence(opts)).toBe(variableConfidence(opts));
  });

  it("decays específicos por métrica (flow 5min, air_temp 30min)", () => {
    const flowHalf = HALF_LIVES_MS.flow; // 5min
    const tempHalf = HALF_LIVES_MS.air_temp; // 30min
    const flowConf = variableConfidence({
      source: "sensor",
      metric: "flow",
      publishedAtMs: NOW - flowHalf,
      nowMs: NOW,
    });
    const airConf = variableConfidence({
      source: "sensor",
      metric: "air_temp",
      publishedAtMs: NOW - tempHalf,
      nowMs: NOW,
    });
    expect(flowConf).toBe(47.5);
    expect(airConf).toBe(47.5);
  });
});

describe("moduleConfidence — promedio ponderado", () => {
  it("global ponderado con pesos default (ec 3, ph 3, temp 2...)", () => {
    // ec 90 (w3), ph 90 (w3), temp 60 (w2) → (270+270+120)/8=82.5
    const v = moduleConfidence(
      [
        { metric: "ec", value: 90 },
        { metric: "ph", value: 90 },
        { metric: "temp", value: 60 },
      ],
      { ec: 3, ph: 3, temp: 2 },
    );
    expect(v).toBe(82.5);
  });

  it("pesos default completos — todos 95 → 95 (no 100)", () => {
    const perVar = Object.keys(DEFAULT_WEIGHTS).map((m) => ({ metric: m, value: 95 }));
    const v = moduleConfidence(perVar);
    expect(v).toBe(95);
    expect(v).toBeLessThan(100);
  });

  it("nunca 100 — incluso con entradas 100 se capa", () => {
    const perVar = Object.keys(DEFAULT_WEIGHTS).map((m) => ({ metric: m, value: 100 }));
    const v = moduleConfidence(perVar);
    expect(v).toBeLessThan(100);
    expect(v).toBe(99.9); // cap por flotante
  });

  it("módulo sin datos → 0 (arreglo vacío)", () => {
    expect(moduleConfidence([])).toBe(0);
  });

  it("módulo sin datos → 0 (todas en 0)", () => {
    const perVar = Object.keys(DEFAULT_WEIGHTS).map((m) => ({ metric: m, value: 0 }));
    expect(moduleConfidence(perVar)).toBe(0);
  });

  it("ausencia arrastra: ec 95 + resto 0 → <40", () => {
    // solo ec presente, resto 0 con pesos → (95*3 + 0*11)/14 = 20.4
    const perVar = [
      { metric: "ec", value: 95 },
      { metric: "ph", value: 0 },
      { metric: "temp", value: 0 },
      { metric: "level", value: 0 },
      { metric: "flow", value: 0 },
      { metric: "air_temp", value: 0 },
      { metric: "humidity", value: 0 },
      { metric: "photo", value: 0 },
    ];
    const v = moduleConfidence(perVar);
    expect(v).toBe(20.4);
    expect(v).toBeGreaterThan(0);
  });

  it("redondeo a 1 decimal", () => {
    // (95*3 + 94*3)/6 = 94.5 exacto; probar caso con decimal largo
    // ec 95 w3, ph 95 w3, temp 95 w2, level 95 w2, flow 95 w1, air_temp 0 w1, humidity 0 w1, photo 0 w1
    // sum=95*11=1045 /14=74.642... →74.6
    const perVar = [
      { metric: "ec", value: 95 },
      { metric: "ph", value: 95 },
      { metric: "temp", value: 95 },
      { metric: "level", value: 95 },
      { metric: "flow", value: 95 },
      { metric: "air_temp", value: 0 },
      { metric: "humidity", value: 0 },
      { metric: "photo", value: 0 },
    ];
    const v = moduleConfidence(perVar);
    expect(v).toBe(74.6);
  });

  it("weights custom: si solo se proveen dos métricas, usa solo esos pesos", () => {
    // único peso ec 3 y level 2 → avg = (90*3+60*2)/5=78
    const v = moduleConfidence(
      [
        { metric: "ec", value: 90 },
        { metric: "level", value: 60 },
      ],
      { ec: 3, level: 2 },
    );
    expect(v).toBe(78);
  });

  it("métrica desconocida usa peso 1 por defecto", () => {
    const v = moduleConfidence([
      { metric: "ec", value: 90 }, // w 3
      { metric: "foo", value: 60 }, // w 1 default
    ]);
    // (270+60)/4=82.5
    expect(v).toBe(82.5);
  });

  it("determinismo: misma entrada → misma salida", () => {
    const input = [
      { metric: "ec", value: 47.5 },
      { metric: "ph", value: 11.9 },
    ];
    expect(moduleConfidence(input)).toBe(moduleConfidence(input));
  });
});
