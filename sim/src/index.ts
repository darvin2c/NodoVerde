#!/usr/bin/env node
import { loadFinca, loadAllCrops } from "./config.js";
import {
  createInitialModule,
  stepModule,
  flowForState,
  mulberry32,
  DEFAULT_PARAMS,
  triggerValve,
  triggerDoserA,
  triggerDoserB,
  triggerDoserPh,
} from "./model.js";
import type { ModuleState } from "./model.js";
import { SimClock } from "./clock.js";
import { saveState, loadState } from "./state.js";
import { fetchWeather, weatherAt, syntheticWeather } from "./weather.js";
import type { WeatherSeries } from "./weather.js";
import { measure } from "./sensors.js";
import { loadScenario } from "./scenario.js";
import {
  buildReading,
  buildStatus,
  buildEvent,
  buildConfidence,
  haSensorDiscovery,
  haSwitchDiscovery,
  readingTopic,
  eventTopic,
  statusTopic,
  confidenceTopic,
  publishRetained,
  publish,
} from "./mqtt.js";
import mqtt from "mqtt";

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
const scenarioName = getFlag("--scenario") ?? "normal";

const tenant = "demo";
const brokerUrl = process.env.MQTT_URL ?? "mqtt://localhost:1883";
if (offline) console.log("[sim] offline mode: ET0 fixed curve");
console.log(`[sim] start speed=${speed} seed=${seed} scenario=${scenarioName} offline=${offline}`);

// --- load config ---
const finca = loadFinca();
const crops = loadAllCrops(finca);
const scenario = loadScenario(scenarioName);
console.log(`[sim] finca ${finca.tenant} modules=${finca.modules.map((m) => m.id).join(",")}`);

// --- Clima (serie real Open-Meteo o sintética offline) ---
let weather: WeatherSeries = syntheticWeather(finca.location.lat, finca.location.lon);
if (!offline) {
  weather = await fetchWeather(finca.location.lat, finca.location.lon, { offline: false });
}
console.log(
  weather.synthetic
    ? "[sim] clima SINTÉTICO (offline/fallback)"
    : `[sim] clima REAL Open-Meteo: ${weather.hours.airTemp.length / 24} días desde ${weather.startDate}`,
);

// --- restore or init state ---
let simClock: SimClock;
let modules: ModuleState[];
let rng = mulberry32(seed);
// stream separado para la capa de medición: la cadencia de publish no contamina la física
const sensorRng = mulberry32(seed ^ 0x9e37);

const persisted = loadState();
let startMs: number;
if (persisted) {
  console.log(`[sim] restoring persisted state simMs=${persisted.simMs}`);
  simClock = new SimClock(persisted.simMs, speed);
  modules = persisted.modules.map((m) => ({ ...m, pendingEc: m.pendingEc ?? 0, pendingPh: m.pendingPh ?? 0 }));
  startMs = persisted.startMs ?? persisted.simMs;
} else {
  // Default: el reloj sim arranca en el ahora real (a 1x ts == tiempo real → Grafana "now" funciona).
  // --start <iso> fija época determinística para escenarios/tests reproducibles.
  const startFlag = getFlag("--start");
  const initialMs = startFlag ? Date.parse(startFlag) : Date.now();
  simClock = new SimClock(initialMs, speed);
  startMs = initialMs;
  modules = finca.modules.map((m) => {
    const crop = crops.get(m.crop);
    const ecTarget = crop?.ec_target ?? [1.2, 2.0];
    return createInitialModule(m.id, m.crop, ecTarget);
  });
}

// --- MQTT setup ---
let mqttClient: mqtt.MqttClient | null = null;
const willClients: mqtt.MqttClient[] = [];
const allDevices: { mod: string; device: string; metric: string }[] = [];

for (const mod of modules) {
  allDevices.push({ mod: mod.id, device: "ec-01", metric: "ec" });
  allDevices.push({ mod: mod.id, device: "ph-01", metric: "ph" });
  allDevices.push({ mod: mod.id, device: "temp-01", metric: "temp" });
  allDevices.push({ mod: mod.id, device: "level-01", metric: "level" });
  allDevices.push({ mod: mod.id, device: "flow-01", metric: "flow" });
  allDevices.push({ mod: mod.id, device: "climate-01", metric: "air_temp" });
  allDevices.push({ mod: mod.id, device: "climate-01", metric: "humidity" });
  allDevices.push({ mod: mod.id, device: "pump-recirc-01", metric: "switch" });
  allDevices.push({ mod: mod.id, device: "valve-fill-01", metric: "switch" });
  allDevices.push({ mod: mod.id, device: "doser-a-01", metric: "switch" });
  allDevices.push({ mod: mod.id, device: "doser-b-01", metric: "switch" });
  allDevices.push({ mod: mod.id, device: "doser-ph-01", metric: "switch" });
  allDevices.push({ mod: mod.id, device: "cam-01", metric: "photo" });
}

function parseRequestPayload(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (parsed !== null && typeof parsed === "object") {
      if ("v" in parsed) {
        const v = (parsed as Record<string, unknown>).v;
        if (typeof v === "string") return v;
        if (typeof v === "number") return String(v);
      }
      if ("action" in parsed) {
        const a = (parsed as Record<string, unknown>).action;
        if (typeof a === "string") return a;
      }
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

async function connectMqtt(): Promise<void> {
  const clientId = `terra-sim-${seed}-${Date.now()}`;
  const nowTs = simClock.nowSim();
  const firstDevice = allDevices[0];
  const firstWillTopic = statusTopic(tenant, firstDevice.mod, firstDevice.device);
  const firstWillPayload = JSON.stringify(buildStatus("offline", nowTs));
  mqttClient = mqtt.connect(brokerUrl, {
    clientId,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 5000,
    will: {
      topic: firstWillTopic,
      payload: Buffer.from(firstWillPayload),
      qos: 1,
      retain: true,
    },
  });

  mqttClient.on("connect", async () => {
    console.log("[sim] mqtt connected");
    for (const mod of modules) {
      const sensorDefs: { device: string; metric: string; name: string; unit?: string }[] = [
        { device: "ec-01", metric: "ec", name: "EC", unit: "mS/cm" },
        { device: "ph-01", metric: "ph", name: "pH" },
        { device: "temp-01", metric: "temp", name: "Water Temp", unit: "°C" },
        { device: "level-01", metric: "level", name: "Tank Level", unit: "%" },
        { device: "flow-01", metric: "flow", name: "Flow", unit: "L/min" },
        { device: "climate-01", metric: "air_temp", name: "Air Temp", unit: "°C" },
        { device: "climate-01", metric: "humidity", name: "Humidity", unit: "%" },
      ];
      for (const s of sensorDefs) {
        const disc = haSensorDiscovery({
          tenant,
          mod: mod.id,
          device: s.device,
          metric: s.metric,
          name: `${mod.id} ${s.name}`,
          unit: s.unit,
        });
        await publishRetained(mqttClient!, disc.topic, disc.payload);
      }
      const switchDevices = ["pump-recirc-01", "valve-fill-01", "doser-a-01", "doser-b-01", "doser-ph-01"];
      for (const dev of switchDevices) {
        const disc = haSwitchDiscovery({ tenant, mod: mod.id, device: dev, name: `${mod.id} ${dev}` });
        await publishRetained(mqttClient!, disc.topic, disc.payload);
      }
    }
    const ts = simClock.nowSim();
    const uniqueDevices = new Map<string, { mod: string; device: string }>();
    for (const d of allDevices) uniqueDevices.set(`${d.mod}/${d.device}`, { mod: d.mod, device: d.device });
    for (const { mod, device } of uniqueDevices.values()) {
      const topic = statusTopic(tenant, mod, device);
      await publishRetained(mqttClient!, topic, buildStatus("online", ts));
    }
    const subTopic = `terra/${tenant}/+/+/request/#`;
    mqttClient!.subscribe(subTopic, { qos: 1 }, (err) => {
      if (err) console.error("[sim] subscribe error", err);
      else console.log(`[sim] subscribed ${subTopic}`);
    });
  });

  mqttClient.on("message", async (topic, payload) => {
    console.log(`[sim] request ${topic} ${payload.toString()}`);
    const parts = topic.split("/");
    if (parts.length < 6) return;
    const modId = parts[2];
    const device = parts[3];
    const action = parts[5];
    const modIdx = modules.findIndex((m) => m.id === modId);
    if (modIdx === -1) return;
    const modState = modules[modIdx];
    const cmd = parseRequestPayload(payload.toString());
    const ts = simClock.nowSim();
    if (action === "set") {
      if (cmd === "ON") {
        if (device === "pump-recirc-01") modState.pumpOn = true;
        if (device === "valve-fill-01") {
          modules[modIdx] = triggerValve(modState, 2000);
          if (mqttClient) await publish(mqttClient, eventTopic(tenant, modId, device, "level"), buildEvent("fill_start", ts, { device }));
        }
        if (device === "doser-a-01") {
          modules[modIdx] = triggerDoserA(modState, 2000);
          if (mqttClient) await publish(mqttClient, eventTopic(tenant, modId, device, "ec"), buildEvent("dose_a", ts, { device }));
        }
        if (device === "doser-b-01") {
          modules[modIdx] = triggerDoserB(modState, 2000);
          if (mqttClient) await publish(mqttClient, eventTopic(tenant, modId, device, "ec"), buildEvent("dose_b", ts, { device }));
        }
        if (device === "doser-ph-01") {
          modules[modIdx] = triggerDoserPh(modState, 2000);
          if (mqttClient) await publish(mqttClient, eventTopic(tenant, modId, device, "ph"), buildEvent("dose_ph", ts, { device }));
        }
      } else if (cmd === "OFF") {
        if (device === "pump-recirc-01") modState.pumpOn = false;
        if (device.includes("doser") || device.includes("valve")) {
          modState.doserATimer = 0;
          modState.doserBTimer = 0;
          modState.doserPhTimer = 0;
          modState.valveTimer = 0;
        }
      }
      if (mqttClient) {
        const topic = readingTopic(tenant, modId, device, "switch");
        const v = cmd === "ON" || cmd === "OFF" ? cmd : "OFF";
        await publishRetained(mqttClient, topic, buildReading(v, ts));
      }
    } else if (action === "read") {
      if (!mqttClient) return;
      const metricMap: Record<string, string> = {
        "ec-01": "ec",
        "ph-01": "ph",
        "temp-01": "temp",
        "level-01": "level",
        "flow-01": "flow",
        "climate-01": "air_temp",
        "pump-recirc-01": "switch",
        "valve-fill-01": "switch",
        "doser-a-01": "switch",
        "doser-b-01": "switch",
        "doser-ph-01": "switch",
      };
      const metric = metricMap[device] ?? "unknown";
      const elapsedDays = (ts - startMs) / 86_400_000;
      let v: number | string = 0;
      if (device === "ec-01") v = measure("ec", modState.ec, elapsedDays, sensorRng);
      else if (device === "ph-01") v = measure("ph", modState.ph, elapsedDays, sensorRng);
      else if (device === "temp-01") v = measure("temp", modState.waterTemp, elapsedDays, sensorRng);
      else if (device === "level-01") v = measure("level", modState.tankLevel, elapsedDays, sensorRng);
      else if (device === "flow-01") v = flowForState(modState, rng);
      else if (device === "climate-01") {
        v = measure("air_temp", weatherAt(weather, ts - startMs).airTemp, elapsedDays, sensorRng);
      } else if (metric === "switch") {
        const onMap: Record<string, boolean> = {
          "pump-recirc-01": modState.pumpOn,
          "valve-fill-01": modState.valveOn,
          "doser-a-01": modState.doserAOn,
          "doser-b-01": modState.doserBOn,
          "doser-ph-01": modState.doserPhOn,
        };
        v = onMap[device] ? "ON" : "OFF";
      }
      await publish(mqttClient, readingTopic(tenant, modId, device, metric), buildReading(v, ts));
    } else if (action === "capture") {
      if (!mqttClient) return;
      await publish(mqttClient, eventTopic(tenant, modId, device, "photo"), buildEvent("photo_capture", ts, { device }));
    } else if (action === "calibrate") {
      if (mqttClient) await publish(mqttClient, eventTopic(tenant, modId, device, "calibration"), buildEvent("calibrate", ts, { device }));
    }
  });

  mqttClient.on("error", (e) => console.error("[sim] mqtt error", e));
  mqttClient.on("offline", () => console.log("[sim] mqtt offline"));

  setTimeout(() => {
    for (let i = 1; i < allDevices.length; i++) {
      const d = allDevices[i];
      if (i > 0 && allDevices[i - 1].mod === d.mod && allDevices[i - 1].device === d.device) continue;
      const willTopic = statusTopic(tenant, d.mod, d.device);
      const willPayload = JSON.stringify(buildStatus("offline", simClock.nowSim()));
      const wc = mqtt.connect(brokerUrl, {
        clientId: `terra-sim-will-${d.mod}-${d.device}-${seed}`,
        clean: true,
        will: { topic: willTopic, payload: Buffer.from(willPayload), qos: 1, retain: true },
      });
      wc.on("connect", () => {});
      wc.on("error", () => {});
      willClients.push(wc);
    }
  }, 2000);
}

await connectMqtt().catch((e) => console.error("[sim] mqtt connect failed", e));

// --- timing state ---
let lastReadingSimMs = simClock.nowSim();
let lastConfidenceSimMs = simClock.nowSim();
let lastPersistSimMs = simClock.nowSim();

let deadPublished = false;

// --- main loop tick cada 1s real ---
const interval = setInterval(async () => {
  const dtRealMs = 1000;
  const dtSimSec = simClock.dtSimSec(dtRealMs);
  simClock.tick(dtRealMs);
  const nowSim = simClock.nowSim();

  const subSteps = Math.max(1, Math.round(dtSimSec));
  const subDt = dtSimSec / subSteps;
  for (let s = 0; s < subSteps; s++) {
    const stepSimMs = simClock.nowSim() - dtSimSec * 1000 + s * subDt * 1000;
    const stepW = weatherAt(weather, stepSimMs - startMs);
    for (let idx = 0; idx < modules.length; idx++) {
      const scenarioOpts = {
        ecConsumptionMul: scenario.ec_consumption_mul ?? 1,
        disableAutoDose: false,
      };
      modules[idx] = stepModule(
        modules[idx],
        subDt,
        stepSimMs,
        stepW.et0,
        { airTemp: stepW.airTemp, humidity: stepW.humidity },
        DEFAULT_PARAMS,
        scenarioOpts,
      );
    }
  }

  if (!scenario.disable_auto_dose) {
    for (let idx = 0; idx < modules.length; idx++) {
      const mod = modules[idx];
      const crop = crops.get(mod.crop);
      if (!crop) continue;
      if (mod.ec < crop.ec_target[0] && mod.doserATimer === 0 && mod.doserBTimer === 0) {
        if (rng() > 0.5) modules[idx] = triggerDoserA(mod, 2000);
        else modules[idx] = triggerDoserB(mod, 2000);
        if (mqttClient) {
          const dev = rng() > 0.5 ? "doser-a-01" : "doser-b-01";
          await publish(mqttClient, eventTopic(tenant, mod.id, dev, "ec"), buildEvent("auto_dose", nowSim, { ec: mod.ec }));
        }
      }
      if (mod.ph > crop.ph_target[1] && mod.doserPhTimer === 0) {
        modules[idx] = triggerDoserPh(mod, 2000);
        if (mqttClient) await publish(mqttClient, eventTopic(tenant, mod.id, "doser-ph-01", "ph"), buildEvent("auto_dose_ph", nowSim, { ph: mod.ph }));
      }
      if (mod.tankLevel < 25 && mod.valveTimer === 0) {
        modules[idx] = triggerValve(mod, 20000);
        if (mqttClient) await publish(mqttClient, eventTopic(tenant, mod.id, "valve-fill-01", "level"), buildEvent("auto_fill", nowSim, { level: mod.tankLevel }));
      }
    }
  }

  let skipEcMod2 = false;
  if (scenario.sensor_dead) {
    const elapsed = nowSim - startMs;
    if (elapsed >= scenario.sensor_dead.after_sim_sec * 1000) {
      skipEcMod2 = true;
      if (!deadPublished && mqttClient) {
        deadPublished = true;
        const ts = nowSim;
        await publishRetained(mqttClient, statusTopic(tenant, scenario.sensor_dead.module, scenario.sensor_dead.device), buildStatus("offline", ts));
        console.log(`[sim] sensor ${scenario.sensor_dead.module}/${scenario.sensor_dead.device} marked offline`);
      }
    }
  }

  if (nowSim - lastReadingSimMs >= 30_000) {
    lastReadingSimMs = nowSim;
    if (mqttClient) {
      const elapsedDays = (nowSim - startMs) / 86_400_000;
      for (const mod of modules) {
        const wNow = weatherAt(weather, nowSim - startMs);
        const flow = flowForState(mod, rng);
        const readings: { device: string; metric: string; v: number | string }[] = [
          { device: "ec-01", metric: "ec", v: measure("ec", mod.ec, elapsedDays, sensorRng) },
          { device: "ph-01", metric: "ph", v: measure("ph", mod.ph, elapsedDays, sensorRng) },
          { device: "temp-01", metric: "temp", v: measure("temp", mod.waterTemp, elapsedDays, sensorRng) },
          { device: "level-01", metric: "level", v: measure("level", mod.tankLevel, elapsedDays, sensorRng) },
          { device: "flow-01", metric: "flow", v: Number(flow.toFixed(2)) },
          { device: "climate-01", metric: "air_temp", v: measure("air_temp", wNow.airTemp, elapsedDays, sensorRng) },
          { device: "climate-01", metric: "humidity", v: measure("humidity", wNow.humidity, elapsedDays, sensorRng) },
        ];
        const switches: { device: string; v: string }[] = [
          { device: "pump-recirc-01", v: mod.pumpOn ? "ON" : "OFF" },
          { device: "valve-fill-01", v: mod.valveOn ? "ON" : "OFF" },
          { device: "doser-a-01", v: mod.doserAOn ? "ON" : "OFF" },
          { device: "doser-b-01", v: mod.doserBOn ? "ON" : "OFF" },
          { device: "doser-ph-01", v: mod.doserPhOn ? "ON" : "OFF" },
        ];

        for (const r of readings) {
          if (skipEcMod2 && mod.id === scenario.sensor_dead?.module && r.device === scenario.sensor_dead.device && r.metric === "ec") continue;
          await publish(mqttClient, readingTopic(tenant, mod.id, r.device, r.metric), buildReading(r.v, nowSim));
        }
        for (const s of switches) {
          await publishRetained(mqttClient, readingTopic(tenant, mod.id, s.device, "switch"), buildReading(s.v, nowSim));
        }
      }
    }
  }

  if (nowSim - lastConfidenceSimMs >= 300_000) {
    lastConfidenceSimMs = nowSim;
    if (mqttClient) {
      for (const mod of modules) {
        for (const device of ["ec-01", "ph-01", "temp-01", "level-01", "flow-01", "climate-01"]) {
          await publish(mqttClient, confidenceTopic(tenant, mod.id, device), buildConfidence(100, nowSim, { self: 100 }));
        }
      }
    }
  }

  if (nowSim - lastPersistSimMs >= 30_000) {
    lastPersistSimMs = nowSim;
    saveState({ simMs: nowSim, startMs, seed, speed, modules, scenario: scenarioName });
  }
}, 1000);

async function shutdown(signal: string) {
  console.log(`[sim] ${signal} shutdown`);
  clearInterval(interval);
  const ts = simClock.nowSim();
  saveState({ simMs: ts, startMs, seed, speed, modules, scenario: scenarioName });
  if (mqttClient) {
    const uniqueDevices = new Map<string, { mod: string; device: string }>();
    for (const d of allDevices) uniqueDevices.set(`${d.mod}/${d.device}`, { mod: d.mod, device: d.device });
    for (const { mod, device } of uniqueDevices.values()) {
      try {
        await publishRetained(mqttClient, statusTopic(tenant, mod, device), buildStatus("offline", ts));
      } catch {}
    }
    mqttClient.end(true);
  }
  for (const wc of willClients) try { wc.end(true); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
