import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mulberry32, createInitialModule, stepModule, climateForTime } from "../src/model.js";
import { fixedEt0Curve, et0ForHour } from "../src/et0.js";
import { SimClock } from "../src/clock.js";
import { saveState, loadState, statePathForTest } from "../src/state.js";
import {
  buildReading,
  buildStatus,
  buildEvent,
  buildConfidence,
  readingTopic,
  eventTopic,
  statusTopic,
  confidenceTopic,
  requestTopic,
  ReadingSchema,
  StatusSchema,
  EventSchema,
  ConfidenceSchema,
} from "../src/mqtt.js";

describe("reloj dual", () => {
  it("1x vs 10x mismo estado tras 1 día-sim (< epsilon)", () => {
    const seed = 42;
    const et0 = fixedEt0Curve();

    function run(speed: number): number {
      const rng = mulberry32(seed);
      const initial = createInitialModule("mod-1", "lechuga", [1.2, 1.8]);
      initial.ec = 1.5;
      initial.ph = 6.0;
      initial.waterTemp = 22;
      initial.tankLevel = 80;
      const clock = new SimClock(Date.UTC(2024, 7, 1, 0, 0, 0), speed);
      let state = initial;
      const totalSimSec = 24 * 3600;
      const steps = Math.ceil(totalSimSec / speed);
      for (let i = 0; i < steps; i++) {
        const dtRealMs = 1000;
        const dtSimSec = clock.dtSimSec(dtRealMs);
        const beforeSim = clock.nowSim();
        clock.tick(dtRealMs);
        // substep integration matching index.ts
        const subSteps = Math.max(1, Math.round(dtSimSec));
        const subDt = dtSimSec / subSteps;
        for (let s = 0; s < subSteps; s++) {
          const simMs = beforeSim + s * subDt * 1000;
          const clim = climateForTime(simMs, rng);
          state = stepModule(state, subDt, simMs, et0ForHour(et0, simMs), clim);
        }
        // avoid extra tick beyond 1 day
        if (clock.nowSim() >= Date.UTC(2024, 7, 1, 0, 0, 0) + totalSimSec * 1000) break;
      }
      return state.ec;
    }

    const ec1 = run(1);
    const ec10 = run(10);
    // epsilon 0.02 mS/cm
    expect(Math.abs(ec1 - ec10)).toBeLessThan(0.02);
  });
});

describe("reproducibilidad", () => {
  it("dos corridas misma semilla → secuencia idéntica", () => {
    function seq(seed: number): number[] {
      const rng = mulberry32(seed);
      const out: number[] = [];
      for (let i = 0; i < 10; i++) out.push(rng());
      return out;
    }
    expect(seq(123)).toEqual(seq(123));
    expect(seq(123)).not.toEqual(seq(124));
  });

  it("clima reproducible con misma semilla", () => {
    const ts = Date.UTC(2024, 7, 1, 12, 0, 0);
    function climateSeq(seed: number): number[] {
      const rng = mulberry32(seed);
      return [climateForTime(ts, rng).airTemp, climateForTime(ts, rng).airTemp];
    }
    expect(climateSeq(42)).toEqual(climateSeq(42));
    expect(climateSeq(42)).not.toEqual(climateSeq(43));
  });
});

describe("persistencia roundtrip", () => {
  it("save/load conserva estado", () => {
    const dir = mkdtempSync(join(tmpdir(), "terra-sim-"));
    try {
      const p = statePathForTest(dir);
      const state = {
        simMs: 1234567890000,
        seed: 42,
        speed: 5,
        modules: [createInitialModule("mod-1", "lechuga", [1.2, 1.8])],
        scenario: "normal",
      };
      saveState(state, p);
      const loaded = loadState(p);
      expect(loaded).not.toBeNull();
      expect(loaded!.simMs).toBe(state.simMs);
      expect(loaded!.seed).toBe(state.seed);
      expect(loaded!.modules[0].ec).toBe(state.modules[0].ec);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("payload builders cumplen schema zod del contrato", () => {
  it("reading", () => {
    const r = buildReading(1.23, Date.now());
    expect(() => ReadingSchema.parse(r)).not.toThrow();
    const r2 = buildReading("ON", Date.now());
    expect(() => ReadingSchema.parse(r2)).not.toThrow();
  });
  it("status", () => {
    const s = buildStatus("online", Date.now());
    expect(() => StatusSchema.parse(s)).not.toThrow();
    const off = buildStatus("offline", Date.now());
    expect(off.state).toBe("offline");
  });
  it("event", () => {
    const e = buildEvent("dose_a", Date.now(), { device: "doser-a-01" });
    expect(() => EventSchema.parse(e)).not.toThrow();
  });
  it("confidence", () => {
    const c = buildConfidence(100, Date.now(), { self: 100 });
    expect(() => ConfidenceSchema.parse(c)).not.toThrow();
    expect(c.v).toBe(100);
  });
});

describe("topics plano dispositivo (5 segmentos, hw_id)", () => {
  const hwId = "020000000001";
  it("readingTopic es 5 segmentos por hw_id", () => {
    const t = readingTopic(hwId, "ec-01", "ec");
    expect(t).toBe(`terra/${hwId}/ec-01/ec/reading`);
    expect(t.split("/")).toHaveLength(5);
  });
  it("eventTopic es 5 segmentos", () => {
    const t = eventTopic(hwId, "doser-a-01", "ec");
    expect(t).toBe(`terra/${hwId}/doser-a-01/ec/event`);
    expect(t.split("/")).toHaveLength(5);
  });
  it("statusTopic es 5 segmentos terra/hw_id/device/status/status", () => {
    const t = statusTopic(hwId, "ec-01");
    expect(t).toBe(`terra/${hwId}/ec-01/status/status`);
    expect(t.split("/")).toHaveLength(5);
  });
  it("confidenceTopic es 5 segmentos", () => {
    const t = confidenceTopic(hwId, "ec-01");
    expect(t).toBe(`terra/${hwId}/ec-01/confidence/confidence`);
    expect(t.split("/")).toHaveLength(5);
  });
  it("requestTopic es 5 segmentos terra/hw_id/device/request/action", () => {
    const t = requestTopic(hwId, "pump-recirc-01", "set");
    expect(t).toBe(`terra/${hwId}/pump-recirc-01/request/set`);
    expect(t.split("/")).toHaveLength(5);
    expect(t.split("/")[3]).toBe("request");
  });
  it("ningún topic contiene tenant o módulo lógico", () => {
    const topics = [
      readingTopic(hwId, "ec-01", "ec"),
      statusTopic(hwId, "ec-01"),
      requestTopic(hwId, "ec-01", "read"),
    ];
    for (const t of topics) {
      expect(t).not.toContain("demo");
      expect(t).not.toContain("mod-1");
    }
  });
});
