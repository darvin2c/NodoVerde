import { describe, it, expect } from "vitest";
import { decideGap, parseGapMinMs } from "../src/dataGap.js";

describe("decideGap", () => {
  const GAP = 600_000; // default 10 min

  it("sin telemetría (null) → no publica", () => {
    expect(decideGap(null, 1_000_000, GAP)).toEqual({ shouldAlert: false });
    expect(decideGap(undefined, 1_000_000, GAP)).toEqual({ shouldAlert: false });
  });

  it("gap bajo el umbral → no publica", () => {
    const now = 1_000_000;
    const max = now - 300_000; // 5 min, gap < 10 min
    expect(decideGap(max, now, GAP)).toEqual({ shouldAlert: false });
  });

  it("gap exactamente en el umbral → no publica (strictly >)", () => {
    const now = 1_000_000;
    const max = now - GAP; // gap == 600000
    const res = decideGap(max, now, GAP);
    expect(res.shouldAlert).toBe(false);
  });

  it("gap sobre el umbral → publica con detail correcto", () => {
    const now = 1_000_000;
    const max = now - 1_200_000; // 20 min gap
    const res = decideGap(max, now, GAP);
    expect(res.shouldAlert).toBe(true);
    if (res.shouldAlert) {
      expect(res.detail.from_ms).toBe(max);
      expect(res.detail.to_ms).toBe(now);
      expect(res.detail.duration_min).toBe(20); // 1_200_000 / 60000 = 20
    }
  });

  it("duration_min redondeado (round)", () => {
    const now = 1_000_000;
    // gap 610_000 ms = 10.166 min => round 10
    let res = decideGap(now - 610_000, now, GAP);
    expect(res.shouldAlert).toBe(true);
    if (res.shouldAlert) expect(res.detail.duration_min).toBe(10);

    // gap 650_000 => 10.833 => 11
    res = decideGap(now - 650_000, now, GAP);
    expect(res.shouldAlert).toBe(true);
    if (res.shouldAlert) expect(res.detail.duration_min).toBe(11);

    // gap 900_000 => 15
    res = decideGap(now - 900_000, now, GAP);
    expect(res.shouldAlert).toBe(true);
    if (res.shouldAlert) expect(res.detail.duration_min).toBe(15);
  });

  it("gap justo por encima del umbral → alerta con duration_min redondeado", () => {
    const now = 1_000_000;
    const max = now - 600_001;
    const res = decideGap(max, now, GAP);
    expect(res.shouldAlert).toBe(true);
    if (res.shouldAlert) expect(res.detail.duration_min).toBe(10);
  });

  it("gap negativo (reloj atrás) → no publica", () => {
    expect(decideGap(2_000_000, 1_000_000, GAP)).toEqual({ shouldAlert: false });
  });

  it("parseGapMinMs defensivo", () => {
    expect(parseGapMinMs(undefined)).toBe(600000);
    expect(parseGapMinMs("")).toBe(600000);
    expect(parseGapMinMs("600000")).toBe(600000);
    expect(parseGapMinMs("abc")).toBe(600000);
    expect(parseGapMinMs("0")).toBe(600000);
    expect(parseGapMinMs("-100")).toBe(600000);
    expect(parseGapMinMs("300000")).toBe(300000);
  });
});
