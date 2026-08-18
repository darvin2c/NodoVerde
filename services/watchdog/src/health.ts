// DeviceHealthTracker — lógica pura (sin I/O) para salud de dispositivos.
// Detecta: impossible, frozen, silence, offline y calcula estado de módulo.

export type DeviceState = "ok" | "silence" | "frozen" | "impossible" | "offline";
export type ModuleState = "ok" | "degraded" | "offline" | "blind";

export type Alert = {
  name: string;
  ts: number;
  severity: "info" | "warn" | "critical";
  device?: string;
  detail?: Record<string, unknown>;
};

export type ModuleHealth = {
  state: ModuleState;
  ts: number;
  devices: Record<string, DeviceState>;
};

export type ExpectedDevice = { id: string; kind: string } | string;

// Rangos físicos imposibles (Context)
const PHYSICAL_RANGES: Record<string, { min: number; max: number }> = {
  ph: { min: 0, max: 14 },
  ec: { min: 0, max: 10 },
  temp: { min: -10, max: 60 },
  air_temp: { min: -30, max: 60 },
  humidity: { min: 0, max: 100 },
  level: { min: 0, max: 110 },
  flow: { min: 0, max: 50 },
};

function isImpossible(metric: string, v: unknown): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    // switches ON/OFF o strings no se evalúan como imposibles
    // photo también no numérico
    return false;
  }
  const range = PHYSICAL_RANGES[metric];
  if (!range) return false;
  return v < range.min || v > range.max;
}

function normalizeExpected(d: ExpectedDevice): { id: string; kind: string } {
  if (typeof d === "string") return { id: d, kind: "sensor" };
  return d;
}

type MetricEntry = {
  lastValue: unknown;
  consecutiveSame: number;
  isImpossible: boolean;
  isFrozen: boolean;
  lastTs: number;
};

type DeviceEntry = {
  metrics: Map<string, MetricEntry>;
  lastReadingTs: number | null; // ts del payload (reloj sim; informativo)
  lastSeenAtMs: number | null; // llegada real al watchdog (viveza — inmune a --speed N)
  statusState: string | null; // online | offline | error | null
  statusTs: number | null; // ts del payload status (informativo)
  statusSeenAtMs: number | null; // llegada real del status (precedencia LWT)
};

export class DeviceHealthTracker {
  private silenceAfterMs: number;
  private frozenThreshold: number;
  // Clave: device id (se asume tracker por módulo; si se usan múltiples tenants, la clave incluye tenant/module)
  private devices: Map<string, DeviceEntry> = new Map();
  private prevDeviceStates: Map<string, DeviceState> = new Map();
  private prevModuleState: ModuleState | null = null;

  constructor(opts?: { silenceAfterMs?: number; frozenReadings?: number }) {
    this.silenceAfterMs = opts?.silenceAfterMs ?? (process.env.SILENCE_AFTER_MS ? parseInt(process.env.SILENCE_AFTER_MS, 10) : 90000);
    // FROZEN_READINGS env opcional
    const envFrozen = process.env.FROZEN_READINGS ? parseInt(process.env.FROZEN_READINGS, 10) : undefined;
    this.frozenThreshold = opts?.frozenReadings ?? envFrozen ?? 12;
  }

  // Soporta ambas firmas: seenReading(tenant, module, device, metric, v, ts) y seenReading(device, metric, v, ts)
  // arrivedAtMs (opcional, 7º arg): instante real de llegada. Default = ts del payload (tests).
  seenReading(
    tenantOrDevice: string,
    moduleOrMetric: string,
    deviceOrValue?: string | unknown,
    metricOrTs?: string | number,
    vOrTs?: unknown | number,
    tsMaybe?: number,
    arrivedAtMs?: number,
  ): void {
    let device: string;
    let metric: string;
    let v: unknown;
    let ts: number;

    if (tsMaybe !== undefined) {
      // Firma completa 6 args
      device = deviceOrValue as string;
      metric = metricOrTs as string;
      v = vOrTs;
      ts = tsMaybe;
    } else if (typeof metricOrTs === "number") {
      // Firma 4 args: (device, metric, v, ts)
      device = tenantOrDevice;
      metric = moduleOrMetric;
      v = deviceOrValue;
      ts = metricOrTs;
    } else {
      // Fallback: 4 args colapsados
      device = tenantOrDevice;
      metric = moduleOrMetric;
      v = deviceOrValue;
      ts = metricOrTs as unknown as number;
    }

    if (!device || !metric || typeof ts !== "number") return;

    let entry = this.devices.get(device);
    if (!entry) {
      entry = { metrics: new Map(), lastReadingTs: null, lastSeenAtMs: null, statusState: null, statusTs: null, statusSeenAtMs: null };
      this.devices.set(device, entry);
    }
    entry.lastReadingTs = ts;
    entry.lastSeenAtMs = arrivedAtMs ?? ts;

    // metric switch exenta de frozen/impossible
    const isSwitch = metric === "switch";

    // impossible check
    const impossible = !isSwitch && isImpossible(metric, v);

    let mEntry = entry.metrics.get(metric);
    if (!mEntry) {
      mEntry = {
        lastValue: v,
        consecutiveSame: 1,
        isImpossible: impossible,
        isFrozen: false,
        lastTs: ts,
      };
      entry.metrics.set(metric, mEntry);
      // Si es la primera lectura, no frozen (necesita 12)
      // impossible queda marcado
      return;
    }

    // actualizar impossible
    mEntry.isImpossible = impossible;
    mEntry.lastTs = ts;

    if (impossible) {
      // Si es imposible, no cuenta para frozen; reseteamos frozen
      mEntry.isFrozen = false;
      mEntry.lastValue = v;
      mEntry.consecutiveSame = 1;
      return;
    }

    if (isSwitch) {
      // switches exentos de frozen
      mEntry.lastValue = v;
      mEntry.consecutiveSame = 1;
      mEntry.isFrozen = false;
      return;
    }

    // frozen: mismo valor exacto consecutivo
    if (Object.is(mEntry.lastValue, v)) {
      mEntry.consecutiveSame += 1;
    } else {
      mEntry.consecutiveSame = 1;
      mEntry.lastValue = v;
      mEntry.isFrozen = false;
      return;
    }
    mEntry.lastValue = v;
    if (mEntry.consecutiveSame >= this.frozenThreshold) {
      mEntry.isFrozen = true;
    }
  }

  seenStatus(
    tenantOrDevice: string,
    moduleOrState: string,
    deviceOrTs?: string | number,
    stateOrTs?: string | number,
    tsMaybe?: number,
    statusArrivedAtMs?: number, // llegada real del status; default = ts (tests)
  ): void {
    let device: string;
    let state: string;
    let ts: number;

    if (tsMaybe !== undefined) {
      // 5 args: tenant, module, device, state, ts
      device = deviceOrTs as string;
      state = stateOrTs as string;
      ts = tsMaybe;
    } else if (typeof deviceOrTs === "number") {
      // 3 args: device, state, ts
      device = tenantOrDevice;
      state = moduleOrState;
      ts = deviceOrTs;
    } else if (typeof stateOrTs === "number") {
      // 4 args improbable: tenant/module/device/state como fallback
      device = tenantOrDevice;
      state = moduleOrState;
      ts = stateOrTs as unknown as number;
    } else {
      // fallback 3 args
      device = tenantOrDevice;
      state = moduleOrState;
      ts = deviceOrTs as unknown as number;
    }

    let entry = this.devices.get(device);
    if (!entry) {
      entry = { metrics: new Map(), lastReadingTs: null, lastSeenAtMs: null, statusState: null, statusTs: null, statusSeenAtMs: null };
      this.devices.set(device, entry);
    }
    entry.statusState = state;
    entry.statusTs = ts;
    entry.statusSeenAtMs = statusArrivedAtMs ?? ts;
  }

  private computeDeviceState(entry: DeviceEntry | undefined, nowMs: number, kind?: string): DeviceState {
    if (!entry) {
      // Cámara sin eventos es normal (solo publica al capturar): no declarar silence a ciegas.
      if (kind === "camera") return "ok";
      // Sin entrada: nunca visto => silence
      return "silence";
    }
    // Offline (LWT/status) solo manda si LLEGÓ después de la última lectura recibida.
    // Un status offline viejo con readings frescos = LWT stale (reinicio del broker,
    // generación anterior del emulador): la evidencia viva gana. La comparación usa
    // tiempos de LLEGADA (reloj real del watchdog), inmune a --speed N del sim.
    if (
      entry.statusState === "offline" &&
      (entry.lastSeenAtMs === null || (entry.statusSeenAtMs ?? 0) >= entry.lastSeenAtMs)
    ) {
      return "offline";
    }
    // impossible en alguna métrica
    for (const me of entry.metrics.values()) {
      if (me.isImpossible) return "impossible";
    }
    for (const me of entry.metrics.values()) {
      if (me.isFrozen) return "frozen";
    }
    if (entry.lastSeenAtMs === null) return kind === "camera" ? "ok" : "silence";
    // cámara: sin cadencia esperada de readings; su salud la da el LWT (offline arriba)
    if (kind === "camera") return "ok";
    if (nowMs - entry.lastSeenAtMs > this.silenceAfterMs) return "silence";
    return "ok";
  }

  evaluate(
    expectedDevices: ExpectedDevice[],
    nowMs: number,
  ): { moduleHealth: ModuleHealth; transitions: Alert[] } {
    const normalized = expectedDevices.map(normalizeExpected);
    const devicesMap: Record<string, DeviceState> = {};
    const transitions: Alert[] = [];

    // Calcular estados por dispositivo esperado
    for (const exp of normalized) {
      const entry = this.devices.get(exp.id);
      const state = this.computeDeviceState(entry, nowMs, exp.kind);
      devicesMap[exp.id] = state;

      const prev = this.prevDeviceStates.get(exp.id) ?? null;
      if (prev !== state) {
        // Generar alerta edge-triggered solo si prev no es null (excepto primera vez que no sea ok?)
        // Pero si primera evaluación y estado != ok, debe alertar (transición desde nada a fallo)
        // Para evitar ruido inicial de ok->ok, solo alertar si state !== "ok" o si prev !== null
        if (state === "silence" && prev !== "silence") {
          transitions.push({
            name: "device_silence",
            ts: nowMs,
            severity: "warn",
            device: exp.id,
            detail: { kind: exp.kind },
          });
        } else if (state === "frozen" && prev !== "frozen") {
          transitions.push({
            name: "device_frozen",
            ts: nowMs,
            severity: "warn",
            device: exp.id,
            detail: { kind: exp.kind },
          });
        } else if (state === "impossible" && prev !== "impossible") {
          // detail con métrica/valor si disponible
          const entryMetrics = entry?.metrics;
          let detail: Record<string, unknown> = { kind: exp.kind };
          if (entryMetrics) {
            for (const [metric, me] of entryMetrics.entries()) {
              if (me.isImpossible) {
                detail = { ...detail, metric, value: me.lastValue };
                break;
              }
            }
          }
          transitions.push({
            name: "device_impossible",
            ts: nowMs,
            severity: "critical",
            device: exp.id,
            detail,
          });
        } else if (state === "offline" && prev !== "offline") {
          transitions.push({
            name: "device_offline",
            ts: nowMs,
            severity: "critical",
            device: exp.id,
            detail: { kind: exp.kind },
          });
        } else if (state === "ok" && prev !== null && prev !== "ok") {
          transitions.push({
            name: "device_recovered",
            ts: nowMs,
            severity: "info",
            device: exp.id,
            detail: { kind: exp.kind, from: prev },
          });
        }
        this.prevDeviceStates.set(exp.id, state);
      }
    }

    // Calcular estado de módulo
    // blind si TODOS los sensores sin dato (silence/offline) — requiere al menos 2 sensores
    // para evitar que un módulo de prueba con 1 sensor se marque blind cuando debería ser degraded/offline
    const sensorDevices = normalized.filter((d) => d.kind === "sensor");
    let moduleState: ModuleState;
    if (sensorDevices.length > 1 && sensorDevices.every((d) => {
      const st = devicesMap[d.id];
      return st === "silence" || st === "offline";
    })) {
      moduleState = "blind";
    } else if (Object.values(devicesMap).some((s) => s === "offline")) {
      moduleState = "offline";
    } else if (Object.values(devicesMap).some((s) => s === "silence" || s === "frozen" || s === "impossible")) {
      moduleState = "degraded";
    } else {
      moduleState = "ok";
    }

    // Transiciones de módulo
    if (this.prevModuleState !== moduleState) {
      if (moduleState === "blind" && this.prevModuleState !== "blind") {
        transitions.push({
          name: "module_blind",
          ts: nowMs,
          severity: "warn",
          detail: { from: this.prevModuleState ?? undefined },
        });
      } else if (this.prevModuleState === "blind" && moduleState !== "blind") {
        transitions.push({
          name: "module_recovered",
          ts: nowMs,
          severity: "info",
          detail: { to: moduleState },
        });
      }
      this.prevModuleState = moduleState;
    }

    const moduleHealth: ModuleHealth = {
      state: moduleState,
      ts: nowMs,
      devices: devicesMap,
    };

    return { moduleHealth, transitions };
  }

  // Para tests: reset interno
  reset(): void {
    this.devices.clear();
    this.prevDeviceStates.clear();
    this.prevModuleState = null;
  }
}
