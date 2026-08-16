import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// ET0 hourly (mm/h) cache
export type Et0Cache = {
  lat: number;
  lon: number;
  fetchedAt: string;
  hourly: number[]; // length 24, mm/h
};

const FIXED_CURVE: number[] = (() => {
  // campana diaria pico 1.0 mm/h 13h, 0 nocturna
  const arr = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    if (h < 6 || h > 19) {
      arr[h] = 0;
    } else {
      // raised cosine from 6 to 19, peak at 13
      // peak 1.0 at 13, 0 at 6 and 19
      // use sin shape
      // distance from peak
      const peak = 13;
      const halfWidth = 7; // 6->13 =7, 13->19=6 approx 7
      const dist = Math.abs(h - peak);
      // cos shape: 1 at 0, 0 at halfWidth
      arr[h] = Math.max(0, Math.cos((dist / halfWidth) * (Math.PI / 2))) * 1.0;
      // Alternative more bell: sin((h-6)/13 * PI)
      // keep cos for smooth
    }
  }
  // fine tune: ensure 13 is 1.0
  arr[13] = 1.0;
  return arr;
})();

export function fixedEt0Curve(): number[] {
  return [...FIXED_CURVE];
}

function cachePath(): string {
  // resolve relative to repo root or cwd
  const candidates = [
    resolve(process.cwd(), "data/et0-cache.json"),
    resolve(process.cwd(), "sim/data/et0-cache.json"),
    resolve(dirname(new URL(import.meta.url).pathname), "../data/et0-cache.json"),
    resolve(dirname(new URL(import.meta.url).pathname), "../../data/et0-cache.json"),
  ];
  // pick first that exists or first
  for (const c of candidates) {
    try {
      if (existsSync(dirname(c))) return c;
    } catch {}
  }
  return candidates[0];
}

export async function fetchEt0(
  lat: number,
  lon: number,
  opts: { offline?: boolean } = {},
): Promise<number[]> {
  const cacheFile = cachePath();

  if (opts.offline) {
    // try cache first, else fixed
    if (existsSync(cacheFile)) {
      try {
        const cached: Et0Cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
        if (cached.hourly && cached.hourly.length === 24) return cached.hourly;
      } catch {}
    }
    return fixedEt0Curve();
  }

  // try cache if fresh? always try fetch first
  try {
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("start_date", "2024-08-01");
    url.searchParams.set("end_date", "2024-08-02");
    url.searchParams.set("hourly", "et0_fao_evapotranspiration");
    url.searchParams.set("timezone", "auto");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      hourly?: { et0_fao_evapotranspiration?: number[] };
    };
    const vals = json.hourly?.et0_fao_evapotranspiration;
    if (vals && vals.length >= 24) {
      const hourly = vals.slice(0, 24).map((v) => (v == null || isNaN(v) ? 0 : Math.max(0, v)));
      // ensure peak ~ normalized but keep real values; if all zero fallback
      const max = Math.max(...hourly);
      if (max < 0.01) throw new Error("ET0 all zero");
      // cache
      try {
        mkdirSync(dirname(cacheFile), { recursive: true });
        const cache: Et0Cache = { lat, lon, fetchedAt: new Date().toISOString(), hourly };
        writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      } catch {}
      return hourly;
    }
    throw new Error("invalid response");
  } catch {
    // fallback to cache or fixed
    if (existsSync(cacheFile)) {
      try {
        const cached: Et0Cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
        if (cached.hourly && cached.hourly.length === 24) return cached.hourly;
      } catch {}
    }
    return fixedEt0Curve();
  }
}

export function et0ForHour(hourly: number[], simMs: number): number {
  const h = Math.floor((simMs / 3_600_000) % 24);
  return hourly[((h % 24) + 24) % 24] ?? 0;
}
