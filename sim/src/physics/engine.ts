#!/usr/bin/env node
// Motor de física — la VERDAD del mundo simulado (ADR-0017).
// No toca MQTT: expone un canal HTTP de LABORATORIO (equivalente al bus de pines
// que conectaría la física con los chips emulados). Jamás es consumido por el producto.
import { createServer } from "node:http";
import { loadFinca, loadAllCrops, loadCrop } from "../config.js";
import {
  createInitialModule,
  stepModule,
  mulberry32,
  DEFAULT_PARAMS,
  triggerValve,
  triggerDoserA,
  triggerDoserB,
  triggerDoserPh,
} from "../model.js";
import type { ModuleState } from "../model.js";
import { SimClock } from "../clock.js";
import { saveState, loadState } from "../state.js";
import { fetchWeather, weatherAt, syntheticWeather } from "../weather.js";
import type { WeatherSeries } from "../weather.js";
import { loadScenario } from "../scenario.js";
import type { Scenario } from "../scenario.js";
import {
  getCatchUpConfig,
  computeGapSimMs,
  shouldCatchUp,
  catchUpPlan,
} from "./catchup.js";

// --- CLI parsing ---
const args = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

const speed = parseInt(getFlag("--speed") ?? "1", 10);
const seed = parseInt(getFlag("--seed") ?? "42", 10);
const offline = hasFlag("--offline");
let scenarioName = getFlag("--scenario") ?? "normal";
const port = parseInt(process.env.PHYSICS_PORT ?? "7751", 10);

console.log(`[physics] start speed=${speed} seed=${seed} scenario=${scenarioName} offline=${offline} port=${port}`);

// --- load config ---
const finca = loadFinca();
// ADR-0025: los objetivos del cultivo viven en crop_profiles (DB, escritos desde la
// PWA). El yaml solo precarga targets de laboratorio; la verdad la empuja el
// supervisor desde la DB con cada sync de lotes.
type CropTargets2 = { ec_target: [number, number]; ph_target: [number, number] };
const crops = new Map<string, CropTargets2>(
  [...loadAllCrops(finca).entries()].map(([k, c]) => [k, { ec_target: c.ec_target, ph_target: c.ph_target }])
);
let scenario: Scenario = loadScenario(scenarioName);
console.log(`[physics] mundo: nodes=${finca.modules.map((m) => m.hw_id).join(",")}`);

// --- Clima (serie real Open-Meteo o sintética offline) ---
let weather: WeatherSeries = syntheticWeather(finca.location.lat, finca.location.lon);
if (!offline) {
  weather = await fetchWeather(finca.location.lat, finca.location.lon, { offline: false });
}
console.log(weather.synthetic ? "[physics] clima SINTÉTICO" : "[physics] clima REAL Open-Meteo");

// --- restore or init state ---
let simClock: SimClock;
let modules: ModuleState[];
let startMs: number;

const persisted = loadState();
if (persisted) {
  console.log(`[physics] restoring persisted state simMs=${persisted.simMs}`);
  simClock = new SimClock(persisted.simMs, speed);
  // migración ADR-0015: estados viejos guardaban id como "mod-N"; ahora es hw_id
  modules = persisted.modules.map((m, idx) => {
    let id = m.id;
    if (/^mod-\d+$/.test(id) && finca.modules[idx]) id = finca.modules[idx].hw_id;
    return { ...m, id, pendingEc: m.pendingEc ?? 0, pendingPh: m.pendingPh ?? 0 };
  });
  startMs = persisted.startMs ?? persisted.simMs;
  // merge: nodos declarados en finca.yaml que el estado persistido no conoce
  // (el estado no puede ganarle silenciosamente al YAML, fuente de verdad)
  for (const m of finca.modules) {
    if (!modules.some((x) => x.id === m.hw_id)) {
      const crop = m.crop ? crops.get(m.crop) : undefined;
      modules.push(createInitialModule(m.hw_id, m.crop ?? null, crop?.ec_target ?? [1.2, 2.0]));
      console.log(`[physics] nodo declarado ausente en estado restaurado: ${m.hw_id} — agregado`);
    }
  }
} else {
  const startFlag = getFlag("--start");
  const initialMs = startFlag ? Date.parse(startFlag) : Date.now();
  simClock = new SimClock(initialMs, speed);
  startMs = initialMs;
  modules = finca.modules.map((m) => {
    const crop = m.crop ? crops.get(m.crop) : undefined;
    return createInitialModule(m.hw_id, m.crop ?? null, crop?.ec_target ?? [1.2, 2.0]);
  });
}

// rng de mundo: SOLO para física con ruido (ninguna por ahora) — reservado
const rng = mulberry32(seed);
void rng;

// escenario: sensor muerto puede venir como "mod-N" legado → hw_id
function resolveScenarioHwId(raw: string): string {
  if (/^[0-9a-f]{12}$/.test(raw)) return raw;
  const m = raw.match(/^mod-(\d+)$/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < finca.modules.length) return finca.modules[idx].hw_id;
  }
  return raw;
}
const deadSensorFrom = (sc: Scenario) =>
  sc.sensor_dead
    ? { hwId: resolveScenarioHwId(sc.sensor_dead.module), device: sc.sensor_dead.device, afterSimSec: sc.sensor_dead.after_sim_sec }
    : null;
let deadSensor = deadSensorFrom(scenario);

// el escenario persistido (pudo cambiar en caliente vía lab API) gana sobre el flag
if (persisted?.scenario && persisted.scenario !== scenarioName) {
  scenarioName = persisted.scenario;
  scenario = loadScenario(scenarioName);
  deadSensor = deadSensorFrom(scenario);
  console.log(`[physics] escenario restaurado del estado persistido: ${scenarioName}`);
}

// --- main loop tick cada 1s real: el mundo avanza, publique alguien o no ---
let lastPersistSimMs = simClock.nowSim();
// registro de apagados por timer (lab API): la física es quien sabe cuándo expira
// un pulso; el emulador lo drena y publica el evento de cierre en su plano.
// A velocidad ×60 un pulso de 2s-sim vive 33ms reales — invisible al polling.
const TIMER_DEVICES: [keyof ModuleState, string][] = [
  ["doserATimer", "doser-a-01"],
  ["doserBTimer", "doser-b-01"],
  ["doserPhTimer", "doser-ph-01"],
  ["valveTimer", "valve-fill-01"],
];
const offLog = new Map<string, { device: string; ts: number; durationMs: number }[]>();
// duración original del pulso que expiró (para calcular ml determinístico)
const pendingDurations = new Map<string, Map<string, number>>();
function setPendingDuration(hwId: string, device: string, durationMs: number) {
  let m = pendingDurations.get(hwId);
  if (!m) { m = new Map(); pendingDurations.set(hwId, m); }
  m.set(device, durationMs);
}
function takePendingDuration(hwId: string, device: string, fallbackMs: number): number {
  const m = pendingDurations.get(hwId);
  if (m?.has(device)) { const v = m.get(device)!; m.delete(device); return v; }
  return fallbackMs;
}
// --- paso de física reusable: avanza dtSimSec segundos a partir de stepSimMs ---
function physicsStep(dtSimSec: number, stepSimMs: number): void {
  const stepW = weatherAt(weather, stepSimMs - startMs);
  for (let idx = 0; idx < modules.length; idx++) {
    const prev = modules[idx];
    modules[idx] = stepModule(
      prev,
      dtSimSec,
      stepSimMs,
      stepW.et0,
      { airTemp: stepW.airTemp, humidity: stepW.humidity },
      DEFAULT_PARAMS,
      { ecConsumptionMul: scenario.ec_consumption_mul ?? 1 },
    );
    for (const [timer, device] of TIMER_DEVICES) {
      if ((prev[timer] as number) > 0 && (modules[idx][timer] as number) === 0) {
        const log = offLog.get(prev.id) ?? [];
        const durationMs = takePendingDuration(prev.id, device, 2000);
        log.push({ device, ts: stepSimMs + dtSimSec * 1000, durationMs });
        if (log.length > 100) log.shift();
        offLog.set(prev.id, log);
      }
    }
  }
}

// --- catch-up honesto tras pausa (ADR-0021) — corre ANTES de aceptar requests ---
if (persisted) {
  if (persisted.savedAtMs == null) {
    console.log("[physics] estado sin savedAtMs — sin catch-up (estado viejo)");
  } else {
    const { minSimMs, maxSteps } = getCatchUpConfig();
    const gapSimMs = computeGapSimMs(persisted.savedAtMs, Date.now(), speed);
    if (!shouldCatchUp(gapSimMs, minSimMs)) {
      const gapH = gapSimMs != null ? (gapSimMs / 3_600_000).toFixed(2) : "0";
      console.log(`[physics] catch-up no necesario: gap ${gapH}h sim < umbral ${(minSimMs / 60000).toFixed(1)} min`);
    } else {
      const gap = gapSimMs!;
      const { steps, truncated } = catchUpPlan(gap, maxSteps);
      const realHours = (Date.now() - persisted.savedAtMs) / 3_600_000;
      const simHours = (steps * 1000) / 3_600_000;
      console.log(`[physics] catch-up: +${simHours.toFixed(2)}h sim (apagado ${realHours.toFixed(2)}h reales) — ${steps} pasos`);
      if (truncated) {
        console.warn(`[physics] catch-up truncado: gap ${(gap / 3_600_000).toFixed(2)}h sim requiere ${Math.ceil(gap / 1000)} pasos > cap ${maxSteps} — se aplican ${steps}`);
      }
      let remainingMs = steps * 1000;
      for (let i = 0; i < steps; i++) {
        const dt = remainingMs >= 1000 ? 1 : remainingMs / 1000;
        const stepSimMs = simClock.nowSim();
        physicsStep(dt, stepSimMs);
        simClock.advanceSim(dt * 1000);
        remainingMs -= dt * 1000;
        if (remainingMs <= 0) break;
      }
      console.log(`[physics] catch-up completado: simMs ${persisted.simMs} → ${simClock.nowSim()}`);
      // el reloj ya quedó resincronizado; la próxima persistencia parte del nuevo simMs
      lastPersistSimMs = simClock.nowSim();
    }
  }
}

const interval = setInterval(() => {
  const dtRealMs = 1000;
  const dtSimSec = simClock.dtSimSec(dtRealMs);
  simClock.tick(dtRealMs);
  const nowSim = simClock.nowSim();

  const subSteps = Math.max(1, Math.round(dtSimSec));
  const subDt = dtSimSec / subSteps;
  for (let s = 0; s < subSteps; s++) {
    const stepSimMs = nowSim - dtSimSec * 1000 + s * subDt * 1000;
    physicsStep(subDt, stepSimMs);
  }

  if (nowSim - lastPersistSimMs >= 30_000) {
    lastPersistSimMs = nowSim;
    saveState({ simMs: nowSim, startMs, seed, speed, modules, scenario: scenarioName });
  }
}, 1000);

// --- actuación: la ÚNICA forma de cambiar el mundo (equivalente a mover un pin) ---
function actuate(hwId: string, device: string, cmd: string, durationMs?: number): ModuleState | null {
  const idx = modules.findIndex((m) => m.id === hwId);
  if (idx === -1) return null;
  const mod = modules[idx];
  if (cmd === "ON") {
    const dur = durationMs ?? 2000;
    if (device === "pump-recirc-01") { mod.pumpOn = true; }
    else if (device === "valve-fill-01") {
      const next = triggerValve(mod, dur);
      if (next !== mod) { modules[idx] = next; setPendingDuration(hwId, device, dur); }
    } else if (device === "doser-a-01") {
      const next = triggerDoserA(mod, dur);
      if (next !== mod) { modules[idx] = next; setPendingDuration(hwId, device, dur); }
    } else if (device === "doser-b-01") {
      const next = triggerDoserB(mod, dur);
      if (next !== mod) { modules[idx] = next; setPendingDuration(hwId, device, dur); }
    } else if (device === "doser-ph-01") {
      const next = triggerDoserPh(mod, dur);
      if (next !== mod) { modules[idx] = next; setPendingDuration(hwId, device, dur); }
    }
  } else if (cmd === "OFF") {
    if (device === "pump-recirc-01") mod.pumpOn = false;
    if (device.includes("doser") || device.includes("valve")) {
      mod.doserATimer = 0;
      mod.doserBTimer = 0;
      mod.doserPhTimer = 0;
      mod.valveTimer = 0;
      const m = pendingDurations.get(hwId);
      if (m) m.delete(device);
    }
  }
  return modules[idx];
}
function nodeState(hwId: string): Record<string, unknown> | null {
  const mod = modules.find((m) => m.id === hwId);
  if (!mod) return null;
  const nowSim = simClock.nowSim();
  const w = weatherAt(weather, nowSim - startMs);
  const crop = mod.crop ? crops.get(mod.crop) : undefined;
  const faults: string[] = [];
  if (deadSensor && deadSensor.hwId === hwId && nowSim - startMs >= deadSensor.afterSimSec * 1000) {
    faults.push(deadSensor.device);
  }
  return {
    hw_id: hwId,
    crop: mod.crop,
    ts: nowSim,
    startMs,
    elapsedDays: (nowSim - startMs) / 86_400_000,
    state: mod,
    weather: { airTemp: w.airTemp, humidity: w.humidity },
    // ADR-0025: mesa libre → sin objetivos (null honesto); el emulador no auto-dosifica
    cropTargets: crop ? { ec: crop.ec_target, ph: crop.ph_target } : null,
    disableAutoDose: scenario.disable_auto_dose ?? false,
    deadDevices: faults,
    offs: (offLog.get(hwId) ?? []).slice(-20),
    doserMlPerSecond: DEFAULT_PARAMS.doserMlPerSecond,
  };
}
function addNode(hwId: string): Record<string, unknown> {
  if (!/^[0-9a-f]{12}$/.test(hwId)) throw new Error(`hw_id inválido: ${hwId}`);
  if (modules.some((m) => m.id === hwId)) throw new Error(`nodo ya existe: ${hwId}`);
  // ADR-0025: la mesa nace LIBRE — sin plantas hasta que un lote la ocupe
  modules.push(createInitialModule(hwId, null, [1.2, 2.0]));
  offLog.delete(hwId); // nodo nuevo: sin historia de apagados de encarnaciones anteriores
  return { hw_id: hwId, crop: null };
}

// ADR-0025: el supervisor sincroniza el cultivo desde los lotes abiertos (DB).
// Abrir lote = plantas llegan a la mesa; cerrar lote = cosecha, mesa libre.
// Los targets vienen de crop_profiles (DB) en el payload — el yaml es solo
// fallback de laboratorio offline.
function setCrop(hwId: string, crop: string | null, targets?: { ec?: [number, number]; ph?: [number, number] } | null): Record<string, unknown> {
  const mod = modules.find((m) => m.id === hwId);
  if (!mod) throw new Error(`nodo no existe: ${hwId}`);
  if (crop !== null) {
    if (!/^[a-z0-9_]+$/.test(crop)) throw new Error(`crop inválido: ${crop}`);
    if (targets?.ec && targets?.ph) {
      crops.set(crop, { ec_target: targets.ec, ph_target: targets.ph });
    } else if (!crops.has(crop)) {
      const c = loadCrop(crop); // fallback yaml (laboratorio sin DB)
      crops.set(crop, { ec_target: c.ec_target, ph_target: c.ph_target });
    }
  }
  mod.crop = crop;
  console.log(`[physics] ${hwId}: cultivo → ${crop ?? "LIBRE (sin lote)"}`);
  return { hw_id: hwId, crop: mod.crop };
}

function removeNode(hwId: string): boolean {
  const idx = modules.findIndex((m) => m.id === hwId);
  if (idx === -1) return false;
  modules.splice(idx, 1);
  offLog.delete(hwId);
  pendingDurations.delete(hwId);
  return true;
}

// --- HTTP de laboratorio ---
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const nodeMatch = url.pathname.match(/^\/api\/nodes\/([0-9a-f]{12})(\/state|\/actuate)?$/);
  const cropMatch = url.pathname.match(/^\/api\/nodes\/([0-9a-f]{12})\/crop$/);

  if (req.method === "GET" && url.pathname === "/api/nodes") {
    return send(200, { nodes: modules.map((m) => ({ hw_id: m.id, crop: m.crop })), ts: simClock.nowSim() });
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    // vista agregada del mundo — alimenta el monitor de laboratorio (Node-RED)
    const nowSim = simClock.nowSim();
    const w = weatherAt(weather, nowSim - startMs);
    return send(200, {
      ts: nowSim,
      startMs,
      elapsedDays: (nowSim - startMs) / 86_400_000,
      speed,
      seed,
      offline,
      scenario: scenarioName,
      weather: { airTemp: w.airTemp, humidity: w.humidity, et0: w.et0 },
      nodes: modules.map((m) => nodeState(m.id)),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/nodes") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { hw_id } = JSON.parse(body);
        send(201, addNode(hw_id));
      } catch (e) {
        send(400, { error: String(e) });
      }
    });
    return;
  }
  if (req.method === "POST" && cropMatch) {
    // sync de cultivo desde lotes (lo llama el supervisor; jamás el producto)
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { crop, targets } = JSON.parse(body);
        send(200, setCrop(cropMatch[1], crop ?? null, targets ?? null));
      } catch (e) {
        send(400, { error: String(e) });
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/scenario") {
    // cambio de escenario en caliente: recarga el YAML y re-resuelve el sensor muerto
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body);
        scenario = loadScenario(name);
        deadSensor = deadSensorFrom(scenario);
        scenarioName = scenario.name ?? name;
        console.log(`[physics] escenario cambiado en caliente: ${scenarioName}`);
        send(200, { scenario: scenarioName });
      } catch (e) {
        send(400, { error: String(e) });
      }
    });
    return;
  }
  if (nodeMatch && req.method === "GET" && nodeMatch[2] === "/state") {
    const st = nodeState(nodeMatch[1]);
    return st ? send(200, st) : send(404, { error: "nodo desconocido" });
  }
  if (nodeMatch && req.method === "POST" && nodeMatch[2] === "/actuate") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { device, command, durationMs } = JSON.parse(body) as { device: string; command: string; durationMs?: number };
        const st = actuate(nodeMatch[1], device, command, typeof durationMs === "number" ? durationMs : undefined);
        if (!st) return send(404, { error: "nodo desconocido" });
        send(200, { ok: true, state: st });
      } catch (e) {
        send(400, { error: String(e) });
      }
    });
    return;
  }
  if (nodeMatch && req.method === "DELETE" && !nodeMatch[2]) {
    return removeNode(nodeMatch[1]) ? send(200, { ok: true }) : send(404, { error: "nodo desconocido" });
  }
  send(404, { error: "ruta desconocida" });
});

server.listen(port, "127.0.0.1", () => console.log(`[physics] lab API http://127.0.0.1:${port}/api/nodes`));

async function shutdown(signal: string) {
  console.log(`[physics] ${signal} shutdown`);
  clearInterval(interval);
  saveState({ simMs: simClock.nowSim(), startMs, seed, speed, modules, scenario: scenarioName });
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
