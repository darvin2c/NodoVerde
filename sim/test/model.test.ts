import { describe, it, expect } from "vitest";
import {
  createInitialModule,
  stepModule,
  triggerDoserA,
  triggerDoserPh,
  triggerValve,
  climateForTime,
  mulberry32,
  DEFAULT_PARAMS,
  flowForState,
} from "../src/model.js";

describe("modelo hidropónico", () => {
  it("EC sube con dosificación (mezcla gradual) y cae con consumo", () => {
    const rng = mulberry32(42);
    const mod = createInitialModule("mod-1", "lechuga", [1.2, 1.8]);
    // fotoperiodo 12h, consumo debe bajar EC
    const noonMs = Date.UTC(2024, 7, 1, 12, 0, 0);
    const climNoon = climateForTime(noonMs, rng);
    // simular 6h a mediodía sin dosificar
    let s = { ...mod, ec: 1.5 };
    for (let i = 0; i < 6; i++) {
      s = stepModule(s, 3600, noonMs + i * 3600000, 0.8, climNoon, DEFAULT_PARAMS);
    }
    expect(s.ec).toBeLessThan(1.5);
    const afterConsumption = s.ec;

    // dosificar: el pulso dura 2s y encola; la mezcla tarda ~mixTauSec (600s)
    s = triggerDoserA(s, 2000);
    s = stepModule(s, 2, noonMs + 6 * 3600000, 0.8, climNoon, DEFAULT_PARAMS);
    expect(s.ec - afterConsumption).toBeLessThan(0.05); // aún no se mezcla todo
    expect(s.pendingEc).toBeGreaterThan(0);
    // 30 min de mezcla: llega el delta entero
    for (let i = 0; i < 30; i++) {
      s = stepModule(s, 60, noonMs + 6 * 3600000 + (i + 1) * 60000, 0.8, climNoon, DEFAULT_PARAMS);
    }
    expect(s.ec).toBeGreaterThan(afterConsumption + 0.1);
    expect(Math.abs(s.pendingEc)).toBeLessThan(0.01);
  });

  it("pH baja con doser-ph (tras mezcla completa)", () => {
    const rng = mulberry32(1);
    const mod = createInitialModule("mod-1", "lechuga", [1.2, 1.8]);
    const ts = Date.UTC(2024, 7, 1, 10, 0, 0);
    const clim = climateForTime(ts, rng);
    let s = { ...mod, ph: 6.5 };
    const before = s.ph;
    s = triggerDoserPh(s, 2000);
    s = stepModule(s, 2, ts, 0, clim, DEFAULT_PARAMS);
    expect(s.pendingPh).toBeLessThan(0); // encolado, aún no mezclado
    // mezcla completa (~30min): delta total, descontando la deriva natural
    for (let i = 0; i < 30; i++) {
      s = stepModule(s, 60, ts + (i + 1) * 60000, 0, clim, DEFAULT_PARAMS);
    }
    expect(s.ph).toBeLessThan(before);
    const drift = DEFAULT_PARAMS.phDriftPerHour * (0.3 + 0.7 * 1) * (602 / 3600);
    expect(s.ph).toBeCloseTo(before - 0.15 + drift, 1);
    expect(Math.abs(s.pendingPh)).toBeLessThan(0.008); // <5% del delta sin mezclar
  });

  it("tanque cae con ET y sube a 100 con fill", () => {
    const rng = mulberry32(99);
    const mod = createInitialModule("mod-1", "lechuga", [1.2, 1.8]);
    const tsNoon = Date.UTC(2024, 7, 1, 13, 0, 0);
    const clim = climateForTime(tsNoon, rng);
    let s = { ...mod, tankLevel: 80 };
    // 2h con ET0 1.0 mm/h => debe bajar ~4%
    s = stepModule(s, 7200, tsNoon, 1.0, clim, DEFAULT_PARAMS);
    expect(s.tankLevel).toBeLessThan(80);
    const afterEt = s.tankLevel;

    // valve fill
    s = triggerValve(s, 20000); // 20s
    // simulate 20s fill
    for (let i = 0; i < 20; i++) {
      s = stepModule(s, 1, tsNoon + 7200 * 1000 + i * 1000, 1.0, clim, DEFAULT_PARAMS);
    }
    expect(s.tankLevel).toBeGreaterThan(afterEt);
    // long fill should reach 100 (sin ET para evitar caída inmediata)
    let s2 = { ...mod, tankLevel: 30 };
    s2 = triggerValve(s2, 20000);
    for (let i = 0; i < 20; i++) {
      s2 = stepModule(s2, 1, tsNoon + i * 1000, 0, clim, DEFAULT_PARAMS);
    }
    expect(s2.tankLevel).toBe(100);
  });

  it("flow 0 si pump off", () => {
    const rng = mulberry32(5);
    const mod = createInitialModule("mod-1", "lechuga", [1.2, 1.8]);
    const off = { ...mod, pumpOn: false };
    expect(flowForState(off, rng)).toBe(0);
    expect(flowForState(mod, rng)).toBeGreaterThan(0);
  });

  it("temp agua relaja hacia aire", () => {
    const mod = createInitialModule("mod-1", "lechuga", [1.2, 1.8]);
    const ts = Date.UTC(2024, 7, 1, 12, 0, 0);
    const clim = { airTemp: 30, humidity: 40 };
    let s = { ...mod, waterTemp: 18 };
    // tau 2h, after 2h should be ~63% of way to 30
    s = stepModule(s, 7200, ts, 0, clim, DEFAULT_PARAMS);
    expect(s.waterTemp).toBeGreaterThan(18);
    expect(s.waterTemp).toBeLessThan(30);
    // after long time converge
    for (let i = 0; i < 10; i++) {
      s = stepModule(s, 3600, ts + (i + 2) * 3600000, 0, clim, DEFAULT_PARAMS);
    }
    expect(s.waterTemp).toBeCloseTo(30, 0);
  });
});
