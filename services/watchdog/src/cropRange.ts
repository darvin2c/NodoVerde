// cropRange.ts — evaluación agronómica por rangos de cultivo (ADR-0028).
// Tracker puro sin I/O (patrón dataGap.ts): la DB/MQTT viven en index.ts.
// Los rangos vienen de crop_profiles (DB) — el watchdog es el ÚNICO evaluador
// agronómico del sistema; Grafana solo visualiza la tabla alerts.
// Edge-triggered: emite SOLO en transición (silencio mientras el estado persiste).

export type CropRanges = {
  ec: [number, number];
  ph: [number, number];
  temp: [number, number]; // water_temp del perfil
};

export type RangeAlert = {
  name: "crop_out_of_range" | "crop_in_range" | "level_low" | "level_ok";
  severity: "info" | "warn" | "critical";
  detail: Record<string, unknown>;
};

type RangeState = "in" | "out";

export class RangeTracker {
  private profiles = new Map<string, { crop: string; ranges: CropRanges }>(); // tenant/module → perfil
  private state = new Map<string, RangeState>(); // tenant/module/metric → último estado
  private readonly levelLowPct: number;

  constructor(levelLowPct = 15) {
    this.levelLowPct = levelLowPct;
  }

  /**
   * Reemplaza los perfiles cargados (módulos con cultivo activo).
   * Los estados de módulos que ya no tienen perfil se olvidan: si el perfil
   * vuelve, la primera lectura se evalúa fresca (desde unknown).
   */
  setProfiles(profiles: Map<string, { crop: string; ranges: CropRanges }>): void {
    this.profiles = profiles;
    for (const key of [...this.state.keys()]) {
      const modKey = key.slice(0, key.lastIndexOf("/"));
      if (!profiles.has(modKey) && !key.endsWith("/level")) this.state.delete(key);
    }
  }

  /**
   * Registra una lectura y devuelve las alertas de transición (0 o 1).
   * value no numérico/no finito → [] (parse defensivo, nunca tumba).
   */
  seen(tenant: string, module: string, metric: string, value: unknown): RangeAlert[] {
    if (typeof value !== "number" || !Number.isFinite(value)) return [];

    // Nivel: invariante física de cavitación — independiente del cultivo
    if (metric === "level") {
      const out = value < this.levelLowPct;
      return this.transition(`${tenant}/${module}/level`, out, () =>
        out
          ? { name: "level_low", severity: "critical", detail: { value, threshold: this.levelLowPct } }
          : { name: "level_ok", severity: "info", detail: { value, threshold: this.levelLowPct } },
      );
    }

    // Rangos de cultivo: solo si el módulo tiene perfil cargado (lote activo)
    const profile = this.profiles.get(`${tenant}/${module}`);
    if (!profile) return [];
    const range = metric === "ec" ? profile.ranges.ec : metric === "ph" ? profile.ranges.ph : metric === "temp" ? profile.ranges.temp : null;
    if (!range) return [];
    const out = value < range[0] || value > range[1];
    return this.transition(`${tenant}/${module}/${metric}`, out, () =>
      out
        ? { name: "crop_out_of_range", severity: "warn", detail: { metric, value, min: range[0], max: range[1], crop: profile.crop } }
        : { name: "crop_in_range", severity: "info", detail: { metric, value, crop: profile.crop } },
    );
  }

  /**
   * Transición de estado. Emite la alerta "out" al salir de rango (también en la
   * primera lectura — la gracia de arranque de index.ts suprime el falso arranque)
   * y la alerta "in" solo al RECUPERARSE desde fuera (prev === "out").
   */
  private transition(key: string, out: boolean, make: () => RangeAlert): RangeAlert[] {
    const prev = this.state.get(key);
    const next: RangeState = out ? "out" : "in";
    this.state.set(key, next);
    if (out && prev !== "out") return [make()];
    if (!out && prev === "out") return [make()];
    return [];
  }
}
