import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fixedEt0Curve } from "./et0.js";

// Serie meteorológica horaria (real u offline sintética) para replay en el sim.
export type WeatherSeries = {
  lat: number;
  lon: number;
  fetchedAt: string; // ISO; "synthetic" si es fallback
  startDate: string; // YYYY-MM-DD del primer elemento
  hours: {
    airTemp: number[]; // °C
    humidity: number[]; // %
    et0: number[]; // mm/h
  };
  synthetic: boolean;
};

function cachePath(): string {
  const candidates = [
    resolve(process.cwd(), "data/weather-cache.json"),
    resolve(process.cwd(), "sim/data/weather-cache.json"),
    resolve(dirname(new URL(import.meta.url).pathname), "../data/weather-cache.json"),
  ];
  for (const c of candidates) {
    if (existsSync(dirname(c))) return c;
  }
  return candidates[0];
}

// Clima base sintético (determinístico, sin ruido — el ruido vive en la capa de sensores)
function baseClimateHour(hour: number): { airTemp: number; humidity: number } {
  let airTemp: number;
  if (hour >= 5 && hour <= 14) {
    const frac = (hour - 5) / 9;
    airTemp = 16 + (30 - 16) * (0.5 - 0.5 * Math.cos(Math.PI * frac));
  } else {
    const h2 = hour < 5 ? hour + 24 : hour;
    const frac = (h2 - 14) / 15;
    airTemp = 30 + (16 - 30) * (0.5 - 0.5 * Math.cos(Math.PI * frac));
  }
  const humidity = 85 - ((airTemp - 16) / 14) * 45;
  return { airTemp, humidity: Math.max(25, Math.min(95, humidity)) };
}

// Fallback offline: 1 día sintético que el replay repite en loop.
export function syntheticWeather(lat: number, lon: number): WeatherSeries {
  const et0 = fixedEt0Curve();
  const airTemp: number[] = [];
  const humidity: number[] = [];
  for (let h = 0; h < 24; h++) {
    const c = baseClimateHour(h);
    airTemp.push(Number(c.airTemp.toFixed(2)));
    humidity.push(Number(c.humidity.toFixed(1)));
  }
  return { lat, lon, fetchedAt: "synthetic", startDate: "synthetic", hours: { airTemp, humidity, et0 }, synthetic: true };
}

function loadCache(file: string): WeatherSeries | null {
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf-8")) as WeatherSeries;
    if (c.hours?.airTemp?.length > 0 && c.hours.airTemp.length === c.hours.et0.length) return c;
  } catch {}
  return null;
}

// Open-Meteo archive: 30 días terminando hace 6 (el archive tiene ~5 días de rezago).
export async function fetchWeather(
  lat: number,
  lon: number,
  opts: { offline?: boolean } = {},
): Promise<WeatherSeries> {
  const file = cachePath();
  if (opts.offline) {
    return loadCache(file) ?? syntheticWeather(lat, lon);
  }
  try {
    const end = new Date(Date.now() - 6 * 86400_000);
    const start = new Date(end.getTime() - 29 * 86400_000);
    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("start_date", fmt(start));
    url.searchParams.set("end_date", fmt(end));
    url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,et0_fao_evapotranspiration");
    url.searchParams.set("timezone", "auto");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      hourly?: { temperature_2m?: (number | null)[]; relative_humidity_2m?: (number | null)[]; et0_fao_evapotranspiration?: (number | null)[] };
    };
    const t = json.hourly?.temperature_2m;
    const rh = json.hourly?.relative_humidity_2m;
    const et = json.hourly?.et0_fao_evapotranspiration;
    if (!t || !rh || !et || t.length < 48) throw new Error("respuesta incompleta");
    const n = Math.min(t.length, rh.length, et.length);
    const clean = (arr: (number | null)[], fill: number): number[] =>
      arr.slice(0, n).map((v) => (v == null || isNaN(v) ? fill : v));
    const series: WeatherSeries = {
      lat,
      lon,
      fetchedAt: new Date().toISOString(),
      startDate: fmt(start),
      hours: {
        airTemp: clean(t, 22),
        humidity: clean(rh, 60).map((v) => Math.max(5, Math.min(100, v))),
        et0: clean(et, 0).map((v) => Math.max(0, v)),
      },
      synthetic: false,
    };
    if (Math.max(...series.hours.et0) < 0.01) throw new Error("ET0 todo cero");
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(series));
    } catch {}
    return series;
  } catch {
    return loadCache(file) ?? syntheticWeather(lat, lon);
  }
}

// Replay: índice = horas simuladas transcurridas desde el arranque, en loop sobre la serie.
export function weatherAt(
  series: WeatherSeries,
  elapsedSimMs: number,
): { airTemp: number; humidity: number; et0: number } {
  const len = series.hours.airTemp.length;
  const idx = ((Math.floor(elapsedSimMs / 3_600_000) % len) + len) % len;
  return {
    airTemp: series.hours.airTemp[idx],
    humidity: series.hours.humidity[idx],
    et0: series.hours.et0[idx],
  };
}
