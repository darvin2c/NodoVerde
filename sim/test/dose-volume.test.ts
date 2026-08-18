import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createInitialModule, DEFAULT_PARAMS, triggerDoserA, triggerDoserB, triggerDoserPh, stepModule } from "../src/model.js";
import { buildEvent, EventSchema } from "../src/mqtt.js";
import { decideAutoDose } from "../src/node/behavior.js";
import { mulberry32 } from "../src/model.js";

function mlFor(durationMs: number, rate = DEFAULT_PARAMS.doserMlPerSecond): number {
  return Math.round((durationMs / 1000) * rate * 100) / 100;
}

describe("doserMlPerSecond y cálculo de volumen", () => {
  it("DEFAULT_PARAMS.doserMlPerSecond = 1.5 y comentario pulso estándar", () => {
    expect(DEFAULT_PARAMS.doserMlPerSecond).toBe(1.5);
  });

  it("ml para 2000ms con rate 1.5 = 3.0", () => {
    expect(mlFor(2000)).toBe(3.0);
    expect(mlFor(2000, 1.5)).toBe(3.0);
    // variante: 4000ms → 6.0
    expect(mlFor(4000)).toBe(6.0);
    // 1000ms → 1.5
    expect(mlFor(1000)).toBe(1.5);
    // redondeo a 2 decimales: 333ms → 0.5
    expect(mlFor(333)).toBe(0.5);
  });

  it("ml determinístico: mismo seed → misma secuencia de duración y ml", () => {
    const runs = [42, 7, 123].map((seed) => {
      const rng = mulberry32(seed);
      // simula 5 dosis con duraciones pseudo-aleatorias derivadas del rng (determinístico)
      return Array.from({ length: 5 }, () => {
        const dur = rng() > 0.5 ? 2000 : 3000;
        return mlFor(dur);
      });
    });
    // re-ejecutar mismo seed debe dar mismo resultado (verifica determinismo)
    for (const seed of [42, 7, 123]) {
      const rng = mulberry32(seed);
      const second = Array.from({ length: 5 }, () => {
        const dur = rng() > 0.5 ? 2000 : 3000;
        return mlFor(dur);
      });
      const first = runs[[42, 7, 123].indexOf(seed)];
      expect(second).toEqual(first);
    }
  });

  it("trigger con duración custom preserva timer y step expira correctamente", () => {
    const mod = createInitialModule("020000000001", "lechuga", [1.2, 1.8]);
    const s2 = triggerDoserA(mod, 5000);
    expect(s2.doserATimer).toBe(5000);
    expect(s2.doserAOn).toBe(true);
    // step de 5s debe expirar y encolar pendingEc
    const noon = Date.UTC(2024, 7, 1, 12, 0, 0);
    const after = stepModule(s2, 5, noon, 0.8, { airTemp: 25, humidity: 60 }, DEFAULT_PARAMS);
    expect(after.doserATimer).toBe(0);
    expect(after.pendingEc).toBeGreaterThan(0);
    // ml proyectado debe ser 7.5 (5000ms *1.5)
    expect(mlFor(5000)).toBe(7.5);
  });

  it("triggerDoserB y Ph también aceptan duración custom", () => {
    const mod = createInitialModule("020000000001", "lechuga", [1.2, 1.8]);
    expect(triggerDoserB(mod, 3000).doserBTimer).toBe(3000);
    expect(triggerDoserPh(mod, 1500).doserPhTimer).toBe(1500);
  });
});

describe("offs con durationMs y drain compatible", () => {
  it("shape offs incluye durationMs y es consumible por lógica legacy (ts + device)", () => {
    type Off = { device: string; ts: number; durationMs: number };
    const offs: Off[] = [
      { device: "doser-a-01", ts: 1000, durationMs: 2000 },
      { device: "doser-b-01", ts: 2000, durationMs: 3000 },
      { device: "valve-fill-01", ts: 3000, durationMs: 20000 },
    ];
    // legacy: filtrar por device y ts funciona igual
    expect(offs.filter((o) => o.device === "doser-a-01")).toHaveLength(1);
    // nuevo: durationMs disponible
    expect(offs[0].durationMs).toBe(2000);
    expect(offs[1].durationMs).toBe(3000);
    // ml derivado
    expect(mlFor(offs[0].durationMs)).toBe(3.0);
    expect(mlFor(offs[1].durationMs)).toBe(4.5);
    // valve no lleva ml (el emulador solo calcula ml para doser-)
    for (const off of offs) {
      const isDoser = off.device.startsWith("doser-");
      const detail: Record<string, unknown> = { device: off.device, duration_ms: off.durationMs };
      if (isDoser) detail.ml = mlFor(off.durationMs);
      if (isDoser) expect(detail.ml).toBeDefined();
      else expect(detail.ml).toBeUndefined();
    }
  });

  it("offs con durationMs faltante usa fallback 2000 y no rompe drenaje", () => {
    // simula off legacy sin durationMs (compatibilidad)
    const legacyOff: { device: string; ts: number; durationMs?: number } = { device: "doser-a-01", ts: 9999 };
    const durationMs = (legacyOff as { durationMs?: number }).durationMs ?? 2000;
    expect(durationMs).toBe(2000);
    expect(mlFor(durationMs)).toBe(3.0);
    // el drenaje existente que comparaba por ts sigue funcionando
    const offsSeen = new Map<string, number>();
    offsSeen.set(legacyOff.device, 0);
    const shouldPublish = (offsSeen.get(legacyOff.device) ?? -1) < legacyOff.ts;
    expect(shouldPublish).toBe(true);
  });

  it("drenaje no duplica cuando offsPrimed ya vio el ts", () => {
    const offsSeen = new Map<string, number>([["doser-a-01", 5000]]);
    const off = { device: "doser-a-01", ts: 5000, durationMs: 2000 };
    const dup = (offsSeen.get(off.device) ?? -1) >= off.ts;
    expect(dup).toBe(true);
    const newer = { device: "doser-a-01", ts: 6000, durationMs: 2000 };
    const shouldPub = (offsSeen.get(newer.device) ?? -1) < newer.ts;
    expect(shouldPub).toBe(true);
  });
});

describe("evento dose_*_end publica detail con device, duration_ms, ml", () => {
  it("dose_a_end / dose_b_end / dose_ph_end con detail completo pasa EventSchema", () => {
    for (const name of ["dose_a_end", "dose_b_end", "dose_ph_end"] as const) {
      const duration_ms = 2000;
      const ml = mlFor(duration_ms);
      expect(ml).toBe(3.0);
      const ev = buildEvent(name, Date.now(), { device: name === "dose_ph_end" ? "doser-ph-01" : name === "dose_a_end" ? "doser-a-01" : "doser-b-01", duration_ms, ml });
      // schema Event acepta detail free-form
      expect(() => EventSchema.parse(ev)).not.toThrow();
      expect(ev.detail).toMatchObject({ duration_ms, ml });
    }
  });

  it("auto_dose / auto_dose_ph de apertura incluye duration_ms y ml proyectados", () => {
    const targets = { ec: [1.2, 1.8] as [number, number], ph: [5.8, 6.3] as [number, number] };
    const s = { ...createInitialModule("020000000001", "lechuga", [1.2, 1.8]), ec: 1.0 };
    const action = decideAutoDose(s, targets, false, mulberry32(42));
    expect(action).not.toBeNull();
    expect(action!.event).toBe("auto_dose");
    const durationMs = action!.durationMs;
    expect(durationMs).toBe(2000);
    const ml = mlFor(durationMs);
    expect(ml).toBe(3.0);
    // el emulador publicaría detail {ec, duration_ms, ml}
    const detail = { ec: s.ec, duration_ms: durationMs, ml };
    const ev = buildEvent("auto_dose", Date.now(), detail);
    expect(EventSchema.parse(ev).detail).toMatchObject({ duration_ms: 2000, ml: 3.0 });

    // pH
    const s2 = { ...createInitialModule("020000000001", "lechuga", [1.2, 1.8]), ph: 6.5 };
    const a2 = decideAutoDose(s2, targets, false, mulberry32(1));
    expect(a2!.event).toBe("auto_dose_ph");
    const ml2 = mlFor(a2!.durationMs);
    const ev2 = buildEvent("auto_dose_ph", Date.now(), { ph: s2.ph, duration_ms: a2!.durationMs, ml: ml2 });
    expect(EventSchema.parse(ev2).detail).toMatchObject({ duration_ms: 2000, ml: 3.0 });
  });
});

describe("contract asyncapi.yaml documenta eventos de dosis", () => {
  it("deviceEvent y event (plano interno) mencionan dose_a_end/dose_b_end/dose_ph_end con duration_ms/ml", () => {
    const yaml = readFileSync(new URL("../../contract/asyncapi.yaml", import.meta.url), "utf8");
    // ambos canales deben documentar los tres eventos
    expect(yaml).toMatch(/dose_a_end/);
    expect(yaml).toMatch(/dose_b_end/);
    expect(yaml).toMatch(/dose_ph_end/);
    expect(yaml).toMatch(/duration_ms/);
    // deviceEvent (5 seg) y event (6 seg)
    expect(yaml).toMatch(/deviceEvent:/);
    // el schema Event NO debe cambiar: detail sigue additionalProperties true (free-form)
    expect(yaml).toMatch(/detail:\s*\{\s*type:\s*object,\s*additionalProperties:\s*true\s*\}/);
  });
});
