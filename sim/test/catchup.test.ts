import { describe, it, expect } from "vitest";
import {
  DEFAULT_CATCHUP_MIN_SIM_MS,
  DEFAULT_CATCHUP_MAX_STEPS,
  computeGapSimMs,
  shouldCatchUp,
  catchUpPlan,
  decideCatchUp,
} from "../src/physics/catchup.js";
import { createInitialModule, stepModule, DEFAULT_PARAMS } from "../src/model.js";
import { syntheticWeather, weatherAt } from "../src/weather.js";
import { SimClock } from "../src/clock.js";

// --- decisión pura ---
describe("catch-up: decisión pura", () => {
  it("gap < min → no", () => {
    const gap = 60_000; // 1 min
    expect(shouldCatchUp(gap, DEFAULT_CATCHUP_MIN_SIM_MS)).toBe(false);
    expect(decideCatchUp({ savedAtMs: 1000, nowMs: 1000 + 60_000, speed: 1, minSimMs: DEFAULT_CATCHUP_MIN_SIM_MS, maxSteps: DEFAULT_CATCHUP_MAX_STEPS }).should).toBe(false);
  });

  it("gap grande → sí", () => {
    const gap = 600_000; // 10 min > 5 min
    expect(shouldCatchUp(gap, DEFAULT_CATCHUP_MIN_SIM_MS)).toBe(true);
  });

  it("gap exactamente en el umbral → no (requiere >)", () => {
    expect(shouldCatchUp(DEFAULT_CATCHUP_MIN_SIM_MS, DEFAULT_CATCHUP_MIN_SIM_MS)).toBe(false);
    expect(shouldCatchUp(DEFAULT_CATCHUP_MIN_SIM_MS + 1, DEFAULT_CATCHUP_MIN_SIM_MS)).toBe(true);
  });

  it("sin savedAtMs → no", () => {
    expect(computeGapSimMs(undefined, Date.now(), 1)).toBeNull();
    expect(shouldCatchUp(null, DEFAULT_CATCHUP_MIN_SIM_MS)).toBe(false);
    expect(decideCatchUp({ savedAtMs: undefined, nowMs: Date.now(), speed: 1 }).should).toBe(false);
  });

  it("truncamiento por cap", () => {
    const gap = 10_000_000; // 10M ms sim → 10k pasos necesidad
    const max = 5000;
    const { steps, truncated } = catchUpPlan(gap, max);
    expect(steps).toBe(max);
    expect(truncated).toBe(true);
    const { steps: s2, truncated: t2 } = catchUpPlan(gap, 20_000);
    expect(t2).toBe(false);
    expect(s2).toBe(Math.ceil(gap / 1000));
  });

  it("decideCatchUp integra truncamiento", () => {
    const now = 1_000_000;
    const saved = now - 20_000; // 20s real * speed 100 → 2_000_000 sim
    const res = decideCatchUp({ savedAtMs: saved, nowMs: now, speed: 100, minSimMs: 300_000, maxSteps: 500 });
    expect(res.gapSimMs).toBe(2_000_000);
    expect(res.should).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.steps).toBe(500);
  });

  it("speed multiplica el gap", () => {
    const now = 10_000;
    const saved = 0;
    expect(computeGapSimMs(saved, now, 1)).toBe(10_000);
    expect(computeGapSimMs(saved, now, 60)).toBe(600_000);
  });
});

// --- integración ligera con semilla fija ---
describe("catch-up: integración 3h", () => {
  it("estado persistido 3 h atrás → simMs avanza ~3h*speed y el tanque evoluciona", () => {
    const speed = 60; // campaña acelerada típica
    const seed = 42;
    const nowReal = Date.UTC(2026, 7, 18, 12, 0, 0);
    const savedAtMs = nowReal - 3 * 3600_000; // apagado 3h real
    const gapSimMs = computeGapSimMs(savedAtMs, nowReal, speed)!;
    expect(gapSimMs).toBe(3 * 3600_000 * speed); // 648_000_000 ms sim

    // estado inicial determinístico (como lo haría engine al restaurar)
    const startMs = Date.UTC(2026, 7, 18, 0, 0, 0);
    const simMs0 = startMs + 2 * 3600_000; // 02:00 sim al guardar
    const cropEc: [number, number] = [1.2, 1.8];
    const init = createInitialModule("020000000001", "lechuga", cropEc);
    // forzar un nivel alto para que la caída por ET0 sea visible
    init.tankLevel = 90;

    const weather = syntheticWeather(-12.0, -77.0);
    const clock = new SimClock(simMs0, speed);
    const plan = catchUpPlan(gapSimMs, DEFAULT_CATCHUP_MAX_STEPS);
    expect(plan.truncated).toBe(true);
    expect(plan.steps).toBe(DEFAULT_CATCHUP_MAX_STEPS);
    // si 3h*speed = 180h sim, supera el cap de 7 días? 180h = 7.5 días → truncado. Esperamos truncado.
    // Con speed 60, 3h real = 180h sim = 648k pasos > 604800 → truncado. Esperamos truncado.
    // Para test de evolución, usar speed menor o gap menor para no truncar cenital.
    // Re-calcular con 3h y speed 10 → 30h sim → 108k pasos, no trunca.
    const speed2 = 10;
    const gap2 = computeGapSimMs(savedAtMs, nowReal, speed2)!;
    const plan2 = catchUpPlan(gap2, DEFAULT_CATCHUP_MAX_STEPS);
    expect(plan2.truncated).toBe(false);
    expect(plan2.steps).toBe(Math.ceil(gap2 / 1000));

    const clock2 = new SimClock(simMs0, speed2);
    const beforeTank = init.tankLevel;
    const beforeEc = init.ec;
    let mod = { ...init };
    // integrar 1s sim pasos igual que engine (reusa stepModule + weatherAt)
    for (let i = 0; i < plan2.steps; i++) {
      const stepSimMs = clock2.nowSim() + 1000;
      const w = weatherAt(weather, stepSimMs - startMs);
      mod = stepModule(mod, 1, stepSimMs, w.et0, { airTemp: w.airTemp, humidity: w.humidity }, DEFAULT_PARAMS);
      clock2.advanceSim(1000);
    }

    // simMs avanzó ~3h*speed2
    expect(clock2.nowSim() - simMs0).toBe(gap2);
    // el tanque cayó por ET0 (u otro estado físico evolucionó)
    expect(mod.tankLevel).not.toBe(beforeTank);
    // EC también debe haber cambiado (consumo o evaporación)
    // puede subir o bajar según hora, pero no quedar idéntico al inicio
    expect(mod.ec).not.toBe(beforeEc);

    void seed; // semilla fija garantizada por weather sintético determinístico + no RNG en step
  });
});
