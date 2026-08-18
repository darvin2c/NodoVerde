#!/usr/bin/env node
// Emulador de nodo — UN proceso por hw_id (ADR-0017).
// Finge ser el firmware del ESP32: mide la verdad del mundo (vía lab API del motor
// de física), aplica la capa de medición y habla MQTT por el plano dispositivo.
// Matar este proceso = desenchufar el ESP32: el broker dispara el LWT offline.
import mqtt from "mqtt";
import { flowForState, mulberry32 } from "../model.js";
import type { ModuleState } from "../model.js";
import { confidenceFor, measure } from "../sensors.js";
import {
  buildReading,
  buildStatus,
  buildEvent,
  buildConfidence,
  readingTopic,
  eventTopic,
  statusTopic,
  confidenceTopic,
  publishRetained,
  publish,
} from "../mqtt.js";
import {
  DEVICE_METRICS,
  SENSOR_DEVICES,
  SWITCH_DEVICES,
  switchOn,
  parseRequestPayload,
  parseCmdPayload,
  decideAutoDose,
} from "./behavior.js";
import type { CropTargets } from "./behavior.js";

// --- CLI parsing ---
const args = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return undefined;
}

const hwArg = getFlag("--hw");
if (!hwArg || !/^[0-9a-f]{12}$/.test(hwArg)) {
  console.error(`[node] --hw requerido (12 hex minúsculas), recibido: ${hwArg}`);
  process.exit(1);
}
const hwId: string = hwArg;
const seed = parseInt(getFlag("--seed") ?? "42", 10);
const brokerUrl = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const physicsUrl = process.env.PHYSICS_URL ?? "http://127.0.0.1:7751";

// stream de medición propio por nodo: determinístico por (seed, hw_id)
const hwTail = parseInt(hwId.slice(-8), 16);
const sensorRng = mulberry32((seed ^ hwTail) >>> 0);

type PhysicsState = {
  hw_id: string;
  crop: string;
  ts: number;
  startMs: number;
  elapsedDays: number;
  state: ModuleState;
  weather: { airTemp: number; humidity: number };
  cropTargets: CropTargets;
  disableAutoDose: boolean;
  deadDevices: string[];
  offs?: { device: string; ts: number; durationMs: number }[];
  doserMlPerSecond?: number;
};

function mlForDuration(durationMs: number, doserMlPerSecond: number): number {
  return Math.round((durationMs / 1000) * doserMlPerSecond * 100) / 100;
}
async function fetchState(): Promise<PhysicsState | null> {
  try {
    const res = await fetch(`${physicsUrl}/api/nodes/${hwId}/state`);
    if (!res.ok) return null;
    return (await res.json()) as PhysicsState;
  } catch {
    return null;
  }
}
async function actuate(device: string, command: string, durationMs?: number): Promise<void> {
  try {
    await fetch(`${physicsUrl}/api/nodes/${hwId}/actuate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(durationMs !== undefined ? { device, command, durationMs } : { device, command }),
    });
  } catch (e) {
    console.error(`[node ${hwId}] actuate falló (¿física caída?):`, e);
  }
}

function defaultDurationFor(device: string): number | undefined {
  if (device === "doser-a-01" || device === "doser-b-01" || device === "doser-ph-01") return 2000;
  if (device === "valve-fill-01") return 20000;
  return undefined;
}
// --- MQTT setup: cliente principal + un cliente LWT por dispositivo ---
const devices = [...SENSOR_DEVICES, ...SWITCH_DEVICES];
let client: mqtt.MqttClient | null = null;
const willClients: mqtt.MqttClient[] = [];

async function connectMqtt(): Promise<void> {
  const firstWillTopic = statusTopic(hwId, devices[0]);
  client = mqtt.connect(brokerUrl, {
    clientId: `terra-node-${hwId}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 5000,
    will: {
      topic: firstWillTopic,
      payload: Buffer.from(JSON.stringify({ state: "offline", ts: Date.now() })),
      qos: 1,
      retain: true,
    },
  });

  client.on("connect", async () => {
    console.log(`[node ${hwId}] mqtt connected`);
    client!.subscribe(`terra/${hwId}/+/request/#`, { qos: 1 }, (err) => {
      if (err) console.error(`[node ${hwId}] subscribe request error`, err);
    });
    client!.subscribe(`terra/${hwId}/+/cmd`, { qos: 1 }, (err) => {
      if (err) console.error(`[node ${hwId}] subscribe cmd error`, err);
    });
  });

  client.on("message", async (topic, payload) => {
    const raw = payload.toString();
    const parts = topic.split("/");
    // --- cmd plano dispositivo: terra/{hw_id}/{device}/cmd (4 segmentos) — Fase 3: SOLO por cmd con policy_id ---
    if (parts.length === 4 && parts[3] === "cmd") {
      const device = parts[2];
      const parsed = parseCmdPayload(raw);
      if (!parsed) {
        console.log(`[node ${hwId}] cmd ignorado sin policy_id o inválido device=${device} raw=${raw.slice(0, 120)}`);
        return;
      }
      console.log(`[node ${hwId}] cmd ${device} ${parsed.action} policy=${parsed.policyId} v=${parsed.v ?? ""} dur=${parsed.durationMs ?? ""}`);
      const st = await fetchState();
      const ts = st?.ts ?? (lastTs || Date.now());
      const isOn = parsed.action === "start" || (parsed.action === "set" && parsed.v === "ON");
      const isOff = parsed.action === "stop" || (parsed.action === "set" && parsed.v === "OFF");
      if (parsed.action === "start") {
        const dur = parsed.durationMs ?? defaultDurationFor(device);
        await actuate(device, "ON", dur);
        if (device === "valve-fill-01") await publish(client!, eventTopic(hwId, device, "level"), buildEvent("fill_start", ts, { device }));
        else if (device === "doser-a-01") await publish(client!, eventTopic(hwId, device, "ec"), buildEvent("dose_a", ts, { device }));
        else if (device === "doser-b-01") await publish(client!, eventTopic(hwId, device, "ec"), buildEvent("dose_b", ts, { device }));
        else if (device === "doser-ph-01") await publish(client!, eventTopic(hwId, device, "ph"), buildEvent("dose_ph", ts, { device }));
        else if (device === "pump-recirc-01") {} // sin evento inicio específico
        await publishRetained(client!, readingTopic(hwId, device, "switch"), buildReading("ON", ts));
      } else if (parsed.action === "stop") {
        await actuate(device, "OFF");
        if (OFF_EVENTS[device]) {
          offsSeen.set(device, ts);
          await publish(client!, eventTopic(hwId, device, OFF_EVENTS[device].metric), buildEvent(OFF_EVENTS[device].name, ts, { device }));
        }
        await publishRetained(client!, readingTopic(hwId, device, "switch"), buildReading("OFF", ts));
      } else if (parsed.action === "set") {
        const cmd = parsed.v === "ON" ? "ON" : "OFF";
        const dur = parsed.durationMs ?? (cmd === "ON" ? defaultDurationFor(device) : undefined);
        await actuate(device, cmd, dur);
        if (isOn) {
          if (device === "valve-fill-01") await publish(client!, eventTopic(hwId, device, "level"), buildEvent("fill_start", ts, { device }));
          else if (device === "doser-a-01") await publish(client!, eventTopic(hwId, device, "ec"), buildEvent("dose_a", ts, { device }));
          else if (device === "doser-b-01") await publish(client!, eventTopic(hwId, device, "ec"), buildEvent("dose_b", ts, { device }));
          else if (device === "doser-ph-01") await publish(client!, eventTopic(hwId, device, "ph"), buildEvent("dose_ph", ts, { device }));
        } else if (isOff && OFF_EVENTS[device]) {
          offsSeen.set(device, ts);
          await publish(client!, eventTopic(hwId, device, OFF_EVENTS[device].metric), buildEvent(OFF_EVENTS[device].name, ts, { device }));
        }
        await publishRetained(client!, readingTopic(hwId, device, "switch"), buildReading(cmd, ts));
      }
      return;
    }
    // plano dispositivo request: terra/{hw_id}/{device}/request/{action} (5 segmentos)
    if (parts.length !== 5 || parts[3] !== "request") return;
    const device = parts[2];
    const action = parts[4];
    const cmd = parseRequestPayload(raw);
    console.log(`[node ${hwId}] request ${device}/${action} ${cmd}`);
    const st = await fetchState();
    const ts = st?.ts ?? (lastTs || Date.now()); // jamás mezclar reloj real si ya conocemos el sim

    if (action === "set") {
      // Fase 3: request set ya no actúa — el fierro solo obedece cmd con policy_id (defensa en profundidad)
      console.log(`[node ${hwId}] request set ignorado (usar cmd) device=${device} payload=${raw.slice(0, 80)}`);
      return;
    } else if (action === "read") {
      if (!st) return;
      const metric = DEVICE_METRICS[device] ?? "unknown";
      let v: number | string = 0;
      if (device === "ec-01") v = measure("ec", st.state.ec, st.elapsedDays, sensorRng);
      else if (device === "ph-01") v = measure("ph", st.state.ph, st.elapsedDays, sensorRng);
      else if (device === "temp-01") v = measure("temp", st.state.waterTemp, st.elapsedDays, sensorRng);
      else if (device === "level-01") v = measure("level", st.state.tankLevel, st.elapsedDays, sensorRng);
      else if (device === "flow-01") v = flowForState(st.state, sensorRng);
      else if (device === "climate-01") v = measure("air_temp", st.weather.airTemp, st.elapsedDays, sensorRng);
      else if (metric === "switch") v = switchOn(st.state, device) ? "ON" : "OFF";
      await publish(client!, readingTopic(hwId, device, metric), buildReading(v, st.ts));
    } else if (action === "capture") {
      await publish(client!, eventTopic(hwId, device, "photo"), buildEvent("photo_capture", ts, { device }));
    } else if (action === "calibrate") {
      await publish(client!, eventTopic(hwId, device, "calibration"), buildEvent("calibrate", ts, { device }));
    }
  });

  client.on("error", (e) => console.error(`[node ${hwId}] mqtt error`, e));

  // LWT por dispositivo restante (mqtt.js soporta un solo will por conexión)
  setTimeout(() => {
    for (const d of [...devices.slice(1), "cam-01"]) {
      const wc = mqtt.connect(brokerUrl, {
        clientId: `terra-node-will-${hwId}-${d}`,
        clean: true,
        will: {
          topic: statusTopic(hwId, d),
          payload: Buffer.from(JSON.stringify({ state: "offline", ts: Date.now() })),
          qos: 1,
          retain: true,
        },
      });
      wc.on("error", () => {});
      willClients.push(wc);
    }
  }, 2000);
}

await connectMqtt().catch((e) => console.error(`[node ${hwId}] mqtt connect failed`, e));

// --- loop principal: medir y publicar con cadencia sim (30s lecturas, 300s confianza) ---
let lastReadingSimMs = 0;
let lastConfidenceSimMs = 0;
let lastTs = 0;
let onlinePublished = false;
const deadPublished = new Set<string>();
// apagados por timer ya publicados (por dispositivo → último ts drenado)
const offsSeen = new Map<string, number>();
let offsPrimed = false;
// evento de cierre simétrico al de apertura (auto-dosis / llenado por timer)
const OFF_EVENTS: Record<string, { name: string; metric: string }> = {
  "valve-fill-01": { name: "fill_end", metric: "level" },
  "doser-a-01": { name: "dose_a_end", metric: "ec" },
  "doser-b-01": { name: "dose_b_end", metric: "ec" },
  "doser-ph-01": { name: "dose_ph_end", metric: "ph" },
};
// dispositivo -> métrica cuya deriva manda en su confianza (climate: la peor de las dos)
const CONFIDENCE_METRICS: Record<string, string[]> = {
  "ec-01": ["ec"],
  "ph-01": ["ph"],
  "temp-01": ["temp"],
  "level-01": ["level"],
  "flow-01": [],
  "climate-01": ["air_temp", "humidity"],
};

const interval = setInterval(async () => {
  const st = await fetchState();
  if (!st) return; // física caída: el firmware real seguiría midiendo local; aquí simplemente esperamos
  const nowSim = st.ts;
  lastTs = nowSim;

  // status online: recién aquí conocemos el reloj sim (determinismo de campaña)
  if (!onlinePublished && client) {
    onlinePublished = true;
    for (const d of [...devices, "cam-01"]) {
      await publishRetained(client, statusTopic(hwId, d), buildStatus("online", nowSim));
    }
  }

  // auto-dosis: protección de cultivo del firmware (una acción por ciclo)
  const action = decideAutoDose(st.state, st.cropTargets, st.disableAutoDose, sensorRng);
  if (action) {
    await actuate(action.device, "ON", action.durationMs);
    const metric = action.device === "valve-fill-01" ? "level" : action.device === "doser-ph-01" ? "ph" : "ec";
    const rate = st.doserMlPerSecond ?? 1.5;
    let detail: Record<string, unknown>;
    if (action.event === "auto_dose") {
      detail = { ec: st.state.ec, duration_ms: action.durationMs, ml: mlForDuration(action.durationMs, rate) };
    } else if (action.event === "auto_dose_ph") {
      detail = { ph: st.state.ph, duration_ms: action.durationMs, ml: mlForDuration(action.durationMs, rate) };
    } else {
      detail = { level: st.state.tankLevel };
    }
    if (client) await publish(client, eventTopic(hwId, action.device, metric), buildEvent(action.event, nowSim, detail));
  }

  // fallos inyectados: dispositivo muerto → offline una vez + silencio de lecturas.
  // El escenario puede cambiar EN CALIENTE: si el dispositivo sale de deadDevices,
  // "resucita" → republica online (si no, queda offline retenido publicando readings)
  for (const dead of st.deadDevices) {
    if (!deadPublished.has(dead) && client) {
      deadPublished.add(dead);
      await publishRetained(client, statusTopic(hwId, dead), buildStatus("offline", nowSim));
      console.log(`[node ${hwId}] sensor ${dead} marcado offline (fault injection)`);
    }
  }
  for (const prev of [...deadPublished]) {
    if (!st.deadDevices.includes(prev)) {
      deadPublished.delete(prev);
      if (client) {
        await publishRetained(client, statusTopic(hwId, prev), buildStatus("online", nowSim));
        console.log(`[node ${hwId}] sensor ${prev} resucitado (escenario cambió)`);
      }
    }
  }

  // apagados por timer (auto-dosis/llenado): la física los registra, aquí se publican.
  // Al boot el backlog histórico se marca como visto: un nodo recién enchufado no
  // "repite" apagados de una encarnación anterior.
  if (!offsPrimed) {
    offsPrimed = true;
    for (const off of st.offs ?? []) offsSeen.set(off.device, Math.max(offsSeen.get(off.device) ?? -1, off.ts));
  }
  for (const off of st.offs ?? []) {
    if ((offsSeen.get(off.device) ?? -1) < off.ts && client && OFF_EVENTS[off.device] && !st.deadDevices.includes(off.device)) {
      offsSeen.set(off.device, off.ts);
      const rate = st.doserMlPerSecond ?? 1.5;
      const durationMs = off.durationMs ?? 2000;
      const detail: Record<string, unknown> = { device: off.device, duration_ms: durationMs };
      // ml solo para dosificadores (valve-fill no dosifica)
      if (off.device.startsWith("doser-")) detail.ml = mlForDuration(durationMs, rate);
      await publish(client, eventTopic(hwId, off.device, OFF_EVENTS[off.device].metric), buildEvent(OFF_EVENTS[off.device].name, off.ts, detail));
    }
  }
  if (nowSim - lastReadingSimMs >= 30_000) {
    lastReadingSimMs = nowSim;
    if (!client) return;
    const readings: { device: string; metric: string; v: number | string }[] = [
      { device: "ec-01", metric: "ec", v: measure("ec", st.state.ec, st.elapsedDays, sensorRng) },
      { device: "ph-01", metric: "ph", v: measure("ph", st.state.ph, st.elapsedDays, sensorRng) },
      { device: "temp-01", metric: "temp", v: measure("temp", st.state.waterTemp, st.elapsedDays, sensorRng) },
      { device: "level-01", metric: "level", v: measure("level", st.state.tankLevel, st.elapsedDays, sensorRng) },
      { device: "flow-01", metric: "flow", v: Number(flowForState(st.state, sensorRng).toFixed(2)) },
      { device: "climate-01", metric: "air_temp", v: measure("air_temp", st.weather.airTemp, st.elapsedDays, sensorRng) },
      { device: "climate-01", metric: "humidity", v: measure("humidity", st.weather.humidity, st.elapsedDays, sensorRng) },
    ];
    for (const r of readings) {
      if (st.deadDevices.includes(r.device)) continue;
      await publish(client, readingTopic(hwId, r.device, r.metric), buildReading(r.v, nowSim));
    }
    for (const d of SWITCH_DEVICES) {
      if (st.deadDevices.includes(d)) continue;
      await publishRetained(client, readingTopic(hwId, d, "switch"), buildReading(switchOn(st.state, d) ? "ON" : "OFF", nowSim));
    }
  }

  if (nowSim - lastConfidenceSimMs >= 300_000) {
    lastConfidenceSimMs = nowSim;
    if (!client) return;
    for (const d of SENSOR_DEVICES) {
      if (st.deadDevices.includes(d)) continue;
      const metrics = CONFIDENCE_METRICS[d] ?? [];
      const conf = metrics.length ? Math.min(...metrics.map((m) => confidenceFor(m, st.elapsedDays))) : 100;
      await publish(client, confidenceTopic(hwId, d), buildConfidence(conf, nowSim, { self: conf }));
    }
  }
}, 1000);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return; // mismo grupo que el supervisor: SIGINT llega por ambas vías
  shuttingDown = true;
  console.log(`[node ${hwId}] ${signal} shutdown`);
  clearInterval(interval);
  if (client) {
    for (const d of [...devices, "cam-01"]) {
      try {
        await publishRetained(client, statusTopic(hwId, d), buildStatus("offline", lastTs || Date.now()));
      } catch {}
    }
    client.end(true);
  }
  for (const wc of willClients) try { wc.end(true); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[node ${hwId}] emulador de nodo iniciado (física: ${physicsUrl})`);
