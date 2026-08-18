// --- RNG mulberry32 ---
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// gaussian via Box-Muller using uniform rng
export function gaussian(rng: () => number): number {
  const u1 = Math.max(1e-10, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// --- Types ---
export type ModuleState = {
  id: string;
  crop: string;
  ec: number; // mS/cm
  ph: number;
  waterTemp: number; // C
  tankLevel: number; // 0-100 %
  pumpOn: boolean;
  valveOn: boolean;
  doserAOn: boolean;
  doserBOn: boolean;
  doserPhOn: boolean;
  // timers for pulse handling (sim ms remaining)
  doserATimer: number;
  doserBTimer: number;
  doserPhTimer: number;
  valveTimer: number;
  // nutriente ya dosificado pero aún mezclándose en el tanque (mezcla gradual ~10min)
  pendingEc: number; // mS/cm por incorporar
  pendingPh: number; // delta pH por incorporar (negativo)
};

export type SimParams = {
  ecConsumptionPeak: number; // mS/cm per hour at peak radiation
  ecDoserADelta: number; // per pulse (pulso estándar 2000ms)
  ecDoserBDelta: number;
  ecEvapCoeff: number; // mS/cm per hour per (100-level)/100
  phDriftPerHour: number;
  phDoserDelta: number; // negative
  tankEt0Coeff: number; // % per mm
  valveFillRate: number; // % per second sim
  waterTauSec: number; // 7200
  mixTauSec: number; // mezcla de dosis en el tanque (600 = 10min)
  doserMlPerSecond: number; // ml/s de la bomba peristáltica (típica 1.5)
};
export const DEFAULT_PARAMS: SimParams = {
  ecConsumptionPeak: 0.018,
  ecDoserADelta: 0.12,
  ecDoserBDelta: 0.10,
  ecEvapCoeff: 0.002,
  phDriftPerHour: 0.008,
  phDoserDelta: -0.15,
  tankEt0Coeff: 2.0,
  valveFillRate: 5.0, // %/s
  waterTauSec: 7200,
  mixTauSec: 600,
  doserMlPerSecond: 1.5,
};

export function createInitialModule(id: string, crop: string, ecTarget: [number, number]): ModuleState {
  const ecMid = (ecTarget[0] + ecTarget[1]) / 2;
  return {
    id,
    crop,
    ec: ecMid,
    ph: 6.0,
    waterTemp: 22,
    tankLevel: 80,
    pumpOn: true,
    valveOn: false,
    doserAOn: false,
    doserBOn: false,
    doserPhOn: false,
    doserATimer: 0,
    doserBTimer: 0,
    doserPhTimer: 0,
    valveTimer: 0,
    pendingEc: 0,
    pendingPh: 0,
  };
}

// radiation factor 0..1, peak at 12-13h
function radiationFactor(hour: number): number {
  if (hour < 6 || hour > 18) return 0;
  // sin from 6 to 18
  return Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
}

// climate: temp aire sinusoide + ruido, HR inversa
export function climateForTime(simMs: number, rng: () => number): { airTemp: number; humidity: number } {
  const hour = ((simMs / 3_600_000) % 24 + 24) % 24;

  // piecewise temp: min 16 at 5h, max 30 at 14h
  let airTemp: number;
  if (hour >= 5 && hour <= 14) {
    const frac = (hour - 5) / 9;
    airTemp = 16 + (30 - 16) * (0.5 - 0.5 * Math.cos(Math.PI * frac));
  } else {
    const h2 = hour < 5 ? hour + 24 : hour;
    const frac = (h2 - 14) / 15;
    airTemp = 30 + (16 - 30) * (0.5 - 0.5 * Math.cos(Math.PI * frac));
  }
  // AR(1) approx: add gaussian noise *0.4
  airTemp += gaussian(rng) * 0.4;
  airTemp = Math.max(10, Math.min(35, airTemp));

  // HR inversa: 85 at 16C, 40 at 30C
  let humidity = 85 - ((airTemp - 16) / 14) * 45;
  humidity += gaussian(rng) * 2;
  humidity = Math.max(25, Math.min(95, humidity));
  return { airTemp, humidity };
}

// pure integration step
export function stepModule(
  state: ModuleState,
  dtSimSec: number,
  simMs: number,
  et0Rate: number, // mm/h actual (resuelto por el llamador desde la serie de clima)
  climate: { airTemp: number; humidity: number },
  params: SimParams = DEFAULT_PARAMS,
  scenario?: { ecConsumptionMul?: number },
): ModuleState {
  const next = { ...state };
  const dtHours = dtSimSec / 3600;
  const hour = ((simMs / 3_600_000) % 24 + 24) % 24;
  const rad = radiationFactor(hour);

  // EC consumption durante fotoperiodo
  const consMul = scenario?.ecConsumptionMul ?? 1;
  const consumption = params.ecConsumptionPeak * rad * dtHours * consMul;
  next.ec -= consumption;

  // evaporación: sube leve cuando tanque baja
  const evap = params.ecEvapCoeff * ((100 - next.tankLevel) / 100) * dtHours;
  next.ec += evap;

  // pH deriva hacia arriba con consumo (proporcional a rad)
  next.ph += params.phDriftPerHour * (0.3 + 0.7 * rad) * dtHours;

  // mezcla gradual: la dosis encolada se incorpora linealmente en ~mixTauSec
  if (next.pendingEc !== 0) {
    const applied = next.pendingEc * Math.min(1, dtSimSec / params.mixTauSec);
    next.ec += applied;
    next.pendingEc -= applied;
  }
  if (next.pendingPh !== 0) {
    const applied = next.pendingPh * Math.min(1, dtSimSec / params.mixTauSec);
    next.ph += applied;
    next.pendingPh -= applied;
  }

  // doser-a/b/ph: si timer activo, al expirar ENCOLA el delta (no aplica instantáneo)
  // handling timers
  if (next.doserATimer > 0) {
    next.doserATimer -= dtSimSec * 1000;
    next.doserAOn = true;
    if (next.doserATimer <= 0) {
      next.doserAOn = false;
      next.doserATimer = 0;
      next.pendingEc += params.ecDoserADelta;
    }
  }
  if (next.doserBTimer > 0) {
    next.doserBTimer -= dtSimSec * 1000;
    next.doserBOn = true;
    if (next.doserBTimer <= 0) {
      next.doserBOn = false;
      next.doserBTimer = 0;
      next.pendingEc += params.ecDoserBDelta;
    }
  }
  if (next.doserPhTimer > 0) {
    next.doserPhTimer -= dtSimSec * 1000;
    next.doserPhOn = true;
    if (next.doserPhTimer <= 0) {
      next.doserPhOn = false;
      next.doserPhTimer = 0;
      next.pendingPh += params.phDoserDelta;
    }
  }
  // valve
  if (next.valveTimer > 0) {
    next.valveTimer -= dtSimSec * 1000;
    next.valveOn = true;
    // while valve on, fill
    next.tankLevel = Math.min(100, next.tankLevel + params.valveFillRate * dtSimSec);
    if (next.valveTimer <= 0) {
      next.valveOn = false;
      next.valveTimer = 0;
    }
  } else {
    next.valveOn = false;
  }

  // si no está en pulso de válvula, tanque cae con ET0
  if (!next.valveOn) {
    next.tankLevel -= et0Rate * params.tankEt0Coeff * dtHours;
  }
  next.tankLevel = Math.max(0, Math.min(100, next.tankLevel));

  // temp agua relajación hacia temp aire
  const tau = params.waterTauSec;
  const factor = 1 - Math.exp(-dtSimSec / tau);
  next.waterTemp += (climate.airTemp - next.waterTemp) * factor;

  // clamp EC/pH
  next.ec = Math.max(0.2, Math.min(5.0, next.ec));
  next.ph = Math.max(3.5, Math.min(9.0, next.ph));
  next.waterTemp = Math.max(5, Math.min(40, next.waterTemp));

  return next;
}

export function triggerDoserA(state: ModuleState, durationMs = 2000): ModuleState {
  if (state.doserATimer > 0) return state;
  return { ...state, doserATimer: durationMs, doserAOn: true };
}
export function triggerDoserB(state: ModuleState, durationMs = 2000): ModuleState {
  if (state.doserBTimer > 0) return state;
  return { ...state, doserBTimer: durationMs, doserBOn: true };
}
export function triggerDoserPh(state: ModuleState, durationMs = 2000): ModuleState {
  if (state.doserPhTimer > 0) return state;
  return { ...state, doserPhTimer: durationMs, doserPhOn: true };
}
export function triggerValve(state: ModuleState, durationMs = 2000): ModuleState {
  if (state.valveTimer > 0) return state;
  return { ...state, valveTimer: durationMs, valveOn: true };
}

// Flow: L/min, 0 cuando recirculación apagada, else ~2 + ruido
export function flowForState(state: ModuleState, rng: () => number): number {
  if (!state.pumpOn) return 0;
  return 2.2 + gaussian(rng) * 0.15;
}
