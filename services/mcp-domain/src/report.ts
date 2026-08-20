// src/report.ts — Puro, sin I/O. Aritmética de promedios/min/max permitida (no es financiera).
// HONESTIDAD: ausencia de dato ≠ dato cero. Sensor muerto = campo AUSENTE + missing.

export type CropProfile = {
  ec_min: number;
  ec_max: number;
  ph_min: number;
  ph_max: number;
  water_temp_min: number;
  water_temp_max: number;
  notes?: string;
};

export type TelemetryRow = {
  tenant: string;
  module: string;
  device: string;
  metric: string;
  value: number;
  time: string | Date | number;
};

export type AlertRow = {
  time: string | Date | number;
  tenant: string;
  module: string;
  name: string;
  severity: string;
  device?: string | null;
  detail?: unknown;
};

export type ConfidenceEntry = {
  v: number;
  sources: Record<string, number>;
};

// Métricas esperadas y su dispositivo canónico (para missing)
const METRIC_DEVICE: Record<string, string> = {
  ec: "ec-01",
  ph: "ph-01",
  temp: "temp-01",
  level: "level-01",
  flow: "flow-01",
  air_temp: "climate-01",
  humidity: "climate-01",
  photo: "cam-01",
};

const EXPECTED_METRICS = ["ec", "ph", "temp", "level", "flow", "air_temp", "humidity", "photo"] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toMs(t: string | Date | number): number {
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t as string);
}

function toEpochMs(t: string | Date | number): number {
  return toMs(t);
}

export type LatestEntry = { value: number; ts: number; ageMinutes: number };
export type StatsEntry = { min: number; avg: number; max: number; count: number };

export type ModuleReport = {
  tenant: string;
  module: string;
  /** Nombre humano del módulo (ADR-0022); null si sin nombre */
  name: string | null;
  crop: string;
  latest: Record<string, LatestEntry>;
  missing: string[];
  stats: Record<string, StatsEntry>;
  pctTimeInRange: Record<string, number>;
  confidence: ConfidenceEntry | null;
  alerts: AlertRow[];
};

// Identidad de la finca (desde tenants — única fuente de verdad). Campos null = ausentes,
// nunca inventados (ADR-0010). El reporte vive en la TZ de la finca.
export type FarmInfo = {
  tenant: string;
  name: string;
  location_name: string | null;
  lat: number | null;
  lon: number | null;
  tz: string | null;
} | null;

export type DailyReportData = {
  date: string;
  farm: FarmInfo;
  generatedAt: number;
  modules: ModuleReport[];
};

export type BuildInput = {
  date: string; // YYYY-MM-DD
  farm?: FarmInfo;
  modules: { tenant: string; id: string; name?: string | null; crop: string; retired?: boolean }[];
  profiles: Map<string, CropProfile>;
  telemetry: TelemetryRow[];
  confidence: Map<string, ConfidenceEntry>; // key: "tenant/module" o "module"
  alerts: AlertRow[];
  nowMs: number;
};

// ---------------------------------------------------------------------------
// buildDailyReportData — puro
// ---------------------------------------------------------------------------

export function buildDailyReportData(input: BuildInput): DailyReportData {
  const { date, modules, profiles, telemetry, confidence, alerts, nowMs } = input;

  const startMs = Date.parse(`${date}T00:00:00.000Z`);
  const endMs = Date.parse(`${date}T23:59:59.999Z`);

  // Agrupar telemetría por módulo (solo dentro del día)
  // No inventa valores: si no hay fila para una métrica en ventana, no aparece en latest/stats.
  const telemetryByModule = new Map<string, TelemetryRow[]>();
  for (const row of telemetry) {
    const ms = toMs(row.time);
    if (ms < startMs || ms > endMs) continue;
    const key = `${row.tenant}/${row.module}`;
    const arr = telemetryByModule.get(key) ?? [];
    arr.push(row);
    telemetryByModule.set(key, arr);
  }

  const result: ModuleReport[] = [];

  for (const mod of modules) {
    const key = `${mod.tenant}/${mod.id}`;
    const rows = telemetryByModule.get(key) ?? [];

    // Agrupar por métrica
    const byMetric = new Map<string, TelemetryRow[]>();
    for (const r of rows) {
      const arr = byMetric.get(r.metric) ?? [];
      arr.push(r);
      byMetric.set(r.metric, arr);
    }

    // latest: última lectura por métrica dentro de la ventana; si no hay, AUSENTE
    const latest: Record<string, LatestEntry> = {};
    const missingSet = new Set<string>();
    for (const m of EXPECTED_METRICS) {
      const arr = byMetric.get(m);
      if (!arr || arr.length === 0) {
        missingSet.add(METRIC_DEVICE[m]);
        continue;
      }
      // última por time
      let best = arr[0];
      let bestMs = toMs(best.time);
      for (let i = 1; i < arr.length; i++) {
        const ms = toMs(arr[i].time);
        if (ms > bestMs) {
          bestMs = ms;
          best = arr[i];
        }
      }
      const ageMinutes = round2((nowMs - bestMs) / 60_000);
      latest[m] = { value: round2(best.value), ts: bestMs, ageMinutes };
    }

    // Deduplicar missing ya vía Set (climate-01 solo una vez aunque falten air_temp+humidity)
    const missing = [...missingSet].sort();

    // stats por métrica
    const stats: Record<string, StatsEntry> = {};
    for (const [metric, arr] of byMetric.entries()) {
      let min = arr[0].value;
      let max = arr[0].value;
      let sum = 0;
      for (const r of arr) {
        if (r.value < min) min = r.value;
        if (r.value > max) max = r.value;
        sum += r.value;
      }
      const avg = sum / arr.length;
      stats[metric] = { min: round2(min), avg: round2(avg), max: round2(max), count: arr.length };
    }

    // pctTimeInRange vs perfil de cultivo
    const profile = profiles.get(mod.crop) ?? null;
    const pctTimeInRange: Record<string, number> = {};
    if (profile) {
      const ranges: Record<string, [number, number] | null> = {
        ec: [profile.ec_min, profile.ec_max],
        ph: [profile.ph_min, profile.ph_max],
        temp: [profile.water_temp_min, profile.water_temp_max],
      };
      for (const [metric, range] of Object.entries(ranges)) {
        if (!range) continue;
        const arr = byMetric.get(metric);
        if (!arr || arr.length === 0) continue;
        const [lo, hi] = range;
        let inside = 0;
        for (const r of arr) {
          if (r.value >= lo && r.value <= hi) inside++;
        }
        pctTimeInRange[metric] = round2((inside / arr.length) * 100);
      }
    }

    // confidence: lookup por "tenant/module" primero, fallback por "module"
    let conf: ConfidenceEntry | null = null;
    if (confidence.has(key)) conf = confidence.get(key)!;
    else if (confidence.has(mod.id)) conf = confidence.get(mod.id)!;
    else conf = null;
    // Normalizar a 2 decimales v si existe
    if (conf) {
      conf = { v: round2(conf.v), sources: { ...conf.sources } };
      for (const k of Object.keys(conf.sources)) conf.sources[k] = round2(conf.sources[k]);
    }

    // alerts del día para este módulo (ya vienen filtradas por fecha, pero re-filtramos por seguridad)
    const modAlerts = alerts.filter((a) => {
      if (a.tenant !== mod.tenant || a.module !== mod.id) return false;
      const ms = toMs(a.time);
      return ms >= startMs && ms <= endMs;
    });

    result.push({
      tenant: mod.tenant,
      module: mod.id,
      name: mod.name ?? null,
      crop: mod.crop,
      latest,
      missing,
      stats,
      pctTimeInRange,
      confidence: conf,
      alerts: modAlerts,
    });
  }

  return {
    date,
    farm: input.farm ?? null,
    generatedAt: nowMs,
    modules: result,
  };
}
