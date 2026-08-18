import { describe, it, expect } from "vitest";
import { buildDailyReportData } from "../src/report.js";
import type { CropProfile, TelemetryRow } from "../src/report.js";

// Helpers
function mkProfile(overrides: Partial<CropProfile> = {}): CropProfile {
  return {
    ec_min: 1.2,
    ec_max: 1.8,
    ph_min: 5.8,
    ph_max: 6.3,
    water_temp_min: 18,
    water_temp_max: 24,
    ...overrides,
  };
}

function row(
  tenant: string,
  mod: string,
  metric: string,
  value: number,
  iso: string,
  device?: string,
): TelemetryRow {
  const dev = device ?? ({ ec: "ec-01", ph: "ph-01", temp: "temp-01", level: "level-01", flow: "flow-01", air_temp: "climate-01", humidity: "climate-01", photo: "cam-01" } as Record<string, string>)[metric] ?? `${metric}-01`;
  return { tenant, module: mod, device: dev, metric, value, time: iso };
}

describe("buildDailyReportData — honestidad y aritmética", () => {
  // (a) 7 días de telemetría sintética con números conocidos → min/avg/max EXACTOS
  it("(a) stats exactos con telemetría sintética conocida", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-1", crop: "lechuga" }];
    const profiles = new Map<string, CropProfile>([["lechuga", mkProfile()]]);

    // ec: 3 lecturas conocidas 1.0, 1.5, 2.0 => min 1, avg 1.5, max 2
    const telemetry: TelemetryRow[] = [
      row("demo", "mod-1", "ec", 1.0, "2026-08-10T08:00:00.000Z"),
      row("demo", "mod-1", "ec", 1.5, "2026-08-10T12:00:00.000Z"),
      row("demo", "mod-1", "ec", 2.0, "2026-08-10T18:00:00.000Z"),
      row("demo", "mod-1", "ph", 6.0, "2026-08-10T10:00:00.000Z"),
      row("demo", "mod-1", "ph", 6.0, "2026-08-10T11:00:00.000Z"),
      row("demo", "mod-1", "ph", 6.0, "2026-08-10T12:00:00.000Z"),
    ];

    const data = buildDailyReportData({
      date,
      modules,
      profiles,
      telemetry,
      confidence: new Map([["demo/mod-1", { v: 88, sources: { ec: 90 } }]]),
      alerts: [],
      nowMs,
    });

    const m = data.modules[0];
    expect(m.stats.ec).toEqual({ min: 1, avg: 1.5, max: 2, count: 3 });
    expect(m.stats.ph).toEqual({ min: 6, avg: 6, max: 6, count: 3 });
    // latest es la última por tiempo
    expect(m.confidence?.v).toBe(88);
  });

  it("(a-extra) 7 días: stats exactos cada día", () => {
    const modules = [{ tenant: "demo", id: "mod-1", crop: "lechuga" }];
    const profiles = new Map<string, CropProfile>([["lechuga", mkProfile()]]);
    // Genera 7 días, cada día ec = [1,2,3] con min 1 max 3 avg 2
    for (let d = 1; d <= 7; d++) {
      const date = `2026-08-${String(d).padStart(2, "0")}`;
      const nowMs = Date.parse(`${date}T23:00:00.000Z`);
      const telemetry: TelemetryRow[] = [
        row("demo", "mod-1", "ec", 1, `${date}T08:00:00.000Z`),
        row("demo", "mod-1", "ec", 2, `${date}T12:00:00.000Z`),
        row("demo", "mod-1", "ec", 3, `${date}T16:00:00.000Z`),
      ];
      const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence: new Map(), alerts: [], nowMs });
      expect(data.modules[0].stats.ec).toEqual({ min: 1, avg: 2, max: 3, count: 3 });
    }
  });

  // (b) sensor_muerto: módulo sin lecturas de ec-01 → latest sin ec + missing incluye ec-01
  it("(b) sensor muerto: ec ausente no se inventa", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-1", crop: "lechuga" }];
    const profiles = new Map([["lechuga", mkProfile()]]);
    const telemetry: TelemetryRow[] = [
      row("demo", "mod-1", "ph", 6.0, "2026-08-10T10:00:00.000Z"),
      row("demo", "mod-1", "temp", 22, "2026-08-10T10:00:00.000Z"),
      // ec deliberadamente ausente todo el día
    ];
    const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence: new Map(), alerts: [], nowMs });
    const m = data.modules[0];
    expect(m.latest.ec).toBeUndefined();
    expect(m.missing).toContain("ec-01");
    expect(m.stats.ec).toBeUndefined();
    // ph y temp sí presentes
    expect(m.latest.ph).toBeDefined();
    expect(m.latest.temp).toBeDefined();
    expect(m.missing).not.toContain("ph-01");
  });

  // (c) módulo completamente ciego → latest vacío, missing completo
  it("(c) módulo ciego: sin telemetría en el día", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-3", crop: "tomate" }];
    const profiles = new Map([["tomate", mkProfile({ ec_min: 2.0, ec_max: 3.5 })]]);
    const telemetry: TelemetryRow[] = []; // vacío
    const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence: new Map(), alerts: [], nowMs });
    const m = data.modules[0];
    expect(Object.keys(m.latest)).toHaveLength(0);
    // debe listar todos los dispositivos esperados
    expect(m.missing).toContain("ec-01");
    expect(m.missing).toContain("ph-01");
    expect(m.missing).toContain("temp-01");
    expect(m.missing).toContain("level-01");
    expect(m.missing).toContain("flow-01");
    expect(m.missing).toContain("climate-01");
    expect(m.missing).toContain("cam-01");
    expect(Object.keys(m.stats)).toHaveLength(0);
    expect(Object.keys(m.pctTimeInRange)).toHaveLength(0);
  });

  // Verifica que también filtra por día: fila de otro día no contamina
  it("honestidad: lecturas fuera de la ventana no aparecen en latest/stats", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-1", crop: "lechuga" }];
    const profiles = new Map([["lechuga", mkProfile()]]);
    const telemetry: TelemetryRow[] = [
      row("demo", "mod-1", "ec", 9.99, "2026-08-09T10:00:00.000Z"), // día anterior, no debe contar
      row("demo", "mod-1", "ec", 1.4, "2026-08-10T10:00:00.000Z"),
    ];
    const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence: new Map(), alerts: [], nowMs });
    const m = data.modules[0];
    expect(m.latest.ec?.value).toBe(1.4);
    expect(m.stats.ec?.count).toBe(1);
    expect(m.stats.ec?.min).toBe(1.4);
  });

  // (d) pctTimeInRange con mitad fuera de rango
  it("(d) pctTimeInRange: 50% fuera de rango", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-1", crop: "lechuga" }];
    const profiles = new Map([["lechuga", mkProfile({ ec_min: 1.2, ec_max: 1.8, ph_min: 5.8, ph_max: 6.3 })]]);
    // ec: 4 lecturas, 2 dentro [1.2,1.8], 2 fuera
    const telemetry: TelemetryRow[] = [
      row("demo", "mod-1", "ec", 1.5, "2026-08-10T08:00:00.000Z"), // dentro
      row("demo", "mod-1", "ec", 1.6, "2026-08-10T09:00:00.000Z"), // dentro
      row("demo", "mod-1", "ec", 2.5, "2026-08-10T10:00:00.000Z"), // fuera alto
      row("demo", "mod-1", "ec", 0.8, "2026-08-10T11:00:00.000Z"), // fuera bajo
      // ph: 2 dentro, 2 fuera
      row("demo", "mod-1", "ph", 6.0, "2026-08-10T08:00:00.000Z"), // dentro
      row("demo", "mod-1", "ph", 6.1, "2026-08-10T09:00:00.000Z"), // dentro
      row("demo", "mod-1", "ph", 7.0, "2026-08-10T10:00:00.000Z"), // fuera
      row("demo", "mod-1", "ph", 5.0, "2026-08-10T11:00:00.000Z"), // fuera
    ];
    const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence: new Map(), alerts: [], nowMs });
    const m = data.modules[0];
    expect(m.pctTimeInRange.ec).toBe(50);
    expect(m.pctTimeInRange.ph).toBe(50);
  });

  it("día sin datos: módulo sin perfil → pct vacío y sin crash", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-x", crop: "cactus_inexistente" }];
    const profiles = new Map<string, CropProfile>(); // vacío, sin perfil
    const telemetry: TelemetryRow[] = [
      row("demo", "mod-x", "ec", 1.5, "2026-08-10T10:00:00.000Z"),
    ];
    const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence: new Map(), alerts: [], nowMs });
    const m = data.modules[0];
    expect(m.crop).toBe("cactus_inexistente");
    expect(Object.keys(m.pctTimeInRange)).toHaveLength(0);
    expect(m.stats.ec).toBeDefined();
  });

  it("redondeos a 2 decimales en stats y latest", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-1", crop: "lechuga" }];
    const profiles = new Map([["lechuga", mkProfile()]]);
    const telemetry: TelemetryRow[] = [
      row("demo", "mod-1", "ec", 1.111, "2026-08-10T08:00:00.000Z"),
      row("demo", "mod-1", "ec", 2.222, "2026-08-10T09:00:00.000Z"),
      row("demo", "mod-1", "ec", 3.333, "2026-08-10T10:00:00.000Z"),
    ];
    const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence: new Map(), alerts: [], nowMs });
    const s = data.modules[0].stats.ec;
    expect(s.min).toBe(1.11);
    expect(s.max).toBe(3.33);
    // avg = (1.111+2.222+3.333)/3 = 2.222
    expect(s.avg).toBe(2.22);
  });

  it("ageMinutes declarada en latest", () => {
    const date = "2026-08-10";
    // nowMs 30 min después de la última lectura
    const nowMs = Date.parse("2026-08-10T11:30:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-1", crop: "lechuga" }];
    const profiles = new Map([["lechuga", mkProfile()]]);
    const telemetry: TelemetryRow[] = [row("demo", "mod-1", "ec", 1.5, "2026-08-10T11:00:00.000Z")];
    const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence: new Map(), alerts: [], nowMs });
    expect(data.modules[0].latest.ec.ageMinutes).toBe(30);
  });

  it("confidence lookup por tenant/module y por módulo", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [
      { tenant: "demo", id: "mod-1", crop: "lechuga" },
      { tenant: "demo", id: "mod-2", crop: "lechuga" },
    ];
    const profiles = new Map([["lechuga", mkProfile()]]);
    const telemetry: TelemetryRow[] = [];
    const confidence = new Map<string, { v: number; sources: Record<string, number> }>([
      ["demo/mod-1", { v: 90, sources: { ec: 95 } }],
      ["mod-2", { v: 70, sources: { ph: 60 } }],
    ]);
    const data = buildDailyReportData({ date, modules, profiles, telemetry, confidence, alerts: [], nowMs });
    expect(data.modules[0].confidence?.v).toBe(90);
    expect(data.modules[1].confidence?.v).toBe(70);
  });

  it("alerts filtradas por módulo y día", () => {
    const date = "2026-08-10";
    const nowMs = Date.parse("2026-08-10T23:00:00.000Z");
    const modules = [{ tenant: "demo", id: "mod-1", crop: "lechuga" }];
    const profiles = new Map([["lechuga", mkProfile()]]);
    const alerts = [
      { time: "2026-08-10T10:00:00.000Z", tenant: "demo", module: "mod-1", name: "device_silence", severity: "warn" as const, device: "ec-01" },
      { time: "2026-08-09T10:00:00.000Z", tenant: "demo", module: "mod-1", name: "device_silence", severity: "warn" as const, device: "ec-01" }, // día anterior
      { time: "2026-08-10T11:00:00.000Z", tenant: "demo", module: "mod-2", name: "device_silence", severity: "warn" as const, device: "ec-01" }, // otro módulo
    ];
    const data = buildDailyReportData({ date, modules, profiles, telemetry: [], confidence: new Map(), alerts, nowMs });
    expect(data.modules[0].alerts).toHaveLength(1);
    expect(data.modules[0].alerts[0].name).toBe("device_silence");
  });
});

describe("buildDailyReportData — identidad de finca (agnóstica, desde DB)", () => {
  it("farm presente → se propaga tal cual; ausente → null (nunca inventada)", () => {
    const base = {
      date: "2026-08-10",
      modules: [{ tenant: "demo", id: "mod-1", crop: "lechuga" }],
      profiles: new Map<string, CropProfile>(),
      telemetry: [] as TelemetryRow[],
      confidence: new Map(),
      alerts: [] as never[],
      nowMs: Date.parse("2026-08-10T23:00:00.000Z"),
    };
    const farm = { tenant: "demo", name: "Finca Demo", location_name: "Lambayeque, Perú", lat: -6.486, lon: -79.647, tz: "America/Lima" };
    expect(buildDailyReportData({ ...base, farm }).farm).toEqual(farm);
    expect(buildDailyReportData(base).farm).toBeNull();
    // campos de ubicación ausentes se reportan null, no cero ni placeholder
    const partial = { ...farm, lat: null, lon: null };
    expect(buildDailyReportData({ ...base, farm: partial }).farm?.lat).toBeNull();
  });
});
