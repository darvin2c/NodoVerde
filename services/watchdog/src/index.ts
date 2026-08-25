#!/usr/bin/env node
// Watchdog — servicio de salud de dispositivos (Fase 1, solo observador).
// Suscribe plano interno reading/status (6 seg), evalúa salud por módulo,
// publica health (retained, qos1) y alerts (qos1). Cero actuación (nunca cmd/request).

import mqtt from "mqtt";
import pg from "pg";
import { parseReadingTopic, parseStatusTopic, parseCmdTopic, buildHealthTopic, buildAlertTopic } from "./topics.js";
import { DeviceHealthTracker, type ExpectedDevice } from "./health.js";
import { CrossVerifier } from "./verify.js";
import { decideGap, parseGapMinMs } from "./dataGap.js";
import { RangeTracker, type CropRanges, type RangeAlert } from "./cropRange.js";

const { Pool } = pg;

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";
const SILENCE_AFTER_MS = process.env.SILENCE_AFTER_MS ? parseInt(process.env.SILENCE_AFTER_MS, 10) : 90000;
const FROZEN_READINGS = process.env.FROZEN_READINGS ? parseInt(process.env.FROZEN_READINGS, 10) : 12;
// Gracia de arranque: estados se calculan y publican desde t=0, pero las alertas se
// suprimen hasta que el servicio pudo observar al menos una ventana de lecturas.
// Sin esto, cada reinicio del watchdog dispara una tormenta de falsos device_offline/silence.
const BOOT_GRACE_MS = process.env.BOOT_GRACE_MS ? parseInt(process.env.BOOT_GRACE_MS, 10) : 30000;
const bootedAt = Date.now();
const VERIFY_WINDOW_MS = process.env.VERIFY_WINDOW_MS ? parseInt(process.env.VERIFY_WINDOW_MS, 10) : 900000;
const GAP_MIN_MS = parseGapMinMs(process.env.GAP_MIN_MS, 600000);
// Nivel bajo (%): invariante física de cavitación — independiente del cultivo (ADR-0028)
const LEVEL_LOW_PCT = process.env.LEVEL_LOW_PCT ? parseInt(process.env.LEVEL_LOW_PCT, 10) : 15;

const READING_SUB = "terra/+/+/+/+/reading";
const STATUS_SUB = "terra/+/+/+/status/status";
const CMD_SUB = "terra/+/+/+/cmd";
console.log(`[watchdog] arranque MQTT_URL=${MQTT_URL} SILENCE_AFTER_MS=${SILENCE_AFTER_MS} FROZEN_READINGS=${FROZEN_READINGS} VERIFY_WINDOW_MS=${VERIFY_WINDOW_MS} BOOT_GRACE_MS=${BOOT_GRACE_MS} GAP_MIN_MS=${GAP_MIN_MS} LEVEL_LOW_PCT=${LEVEL_LOW_PCT}`);

// ---------------------------------------------------------------------------
// DB pool
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("error", (err) => {
  console.error("[watchdog] pg pool error", err);
});

type ModuleKey = string; // `${tenant}/${module}`

function moduleKey(tenant: string, mod: string): ModuleKey {
  return `${tenant}/${mod}`;
}

// Cache de expectedDevices por módulo: tenant/module -> devices[]
let expectedByModule = new Map<ModuleKey, ExpectedDevice[]>();

async function loadExpectedDevices(): Promise<void> {
  try {
    const res = await pool.query<{ tenant: string; module: string; id: string; kind: string }>(
      "SELECT tenant, module, id, kind FROM devices",
    );
    const next = new Map<ModuleKey, ExpectedDevice[]>();
    for (const row of res.rows) {
      const key = moduleKey(row.tenant, row.module);
      const arr = next.get(key) ?? [];
      arr.push({ id: row.id, kind: row.kind });
      next.set(key, arr);
    }
    expectedByModule = next;
    console.log(`[watchdog] expectedDevices cargados: ${res.rows.length} devices en ${next.size} módulos`);
  } catch (err) {
    console.warn("[watchdog] no se pudo cargar expectedDevices", err);
  }
}
// ---------------------------------------------------------------------------
// Rangos agronómicos (ADR-0028) — el watchdog es el ÚNICO evaluador de cultivo
// ---------------------------------------------------------------------------

const rangeTracker = new RangeTracker(LEVEL_LOW_PCT);
// Transiciones detectadas en el handler de readings; se publican en evaluateAndPublish
const pendingRangeAlerts: Array<{ tenant: string; module: string; alert: RangeAlert }> = [];

async function loadCropProfiles(): Promise<void> {
  try {
    const res = await pool.query<{
      tenant: string;
      module: string;
      crop: string;
      ec_min: number;
      ec_max: number;
      ph_min: number;
      ph_max: number;
      water_temp_min: number;
      water_temp_max: number;
    }>(
      `SELECT m.tenant, m.id AS module, m.crop, cp.ec_min, cp.ec_max, cp.ph_min, cp.ph_max, cp.water_temp_min, cp.water_temp_max
       FROM modules m JOIN crop_profiles cp ON cp.name = m.crop WHERE m.crop IS NOT NULL`,
    );
    const next = new Map<string, { crop: string; ranges: CropRanges }>();
    for (const row of res.rows) {
      next.set(moduleKey(row.tenant, row.module), {
        crop: row.crop,
        ranges: {
          ec: [Number(row.ec_min), Number(row.ec_max)],
          ph: [Number(row.ph_min), Number(row.ph_max)],
          temp: [Number(row.water_temp_min), Number(row.water_temp_max)],
        },
      });
    }
    rangeTracker.setProfiles(next);
    console.log(`[watchdog] crop profiles cargados: ${next.size} módulos con cultivo`);
  } catch (err) {
    console.warn("[watchdog] no se pudo cargar crop profiles", err);
  }
}

// ---------------------------------------------------------------------------
// Trackers por módulo
// ---------------------------------------------------------------------------

const trackers = new Map<ModuleKey, DeviceHealthTracker>();

function getTracker(tenant: string, mod: string): DeviceHealthTracker {
  const key = moduleKey(tenant, mod);
  let t = trackers.get(key);
  if (!t) {
    t = new DeviceHealthTracker({ silenceAfterMs: SILENCE_AFTER_MS, frozenReadings: FROZEN_READINGS });
    trackers.set(key, t);
  }
  return t;
}

const verifier = new CrossVerifier({ windowMs: VERIFY_WINDOW_MS });
// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------

const clientId = `terra-watchdog-${process.pid}-${Date.now()}`;
const client = mqtt.connect(MQTT_URL, {
  clientId,
  clean: true,
  keepalive: 30,
  reconnectPeriod: 5000,
});

client.on("connect", () => {
  console.log("[watchdog] conectado al broker");
  client.subscribe(READING_SUB, { qos: 1 }, (err) => {
    if (err) console.error(`[watchdog] error subscribing ${READING_SUB}`, err);
    else console.log(`[watchdog] suscrito ${READING_SUB}`);
  });
  client.subscribe(STATUS_SUB, { qos: 1 }, (err) => {
    if (err) console.error(`[watchdog] error subscribing ${STATUS_SUB}`, err);
    else console.log(`[watchdog] suscrito ${STATUS_SUB}`);
  });
  client.subscribe(CMD_SUB, { qos: 1 }, (err) => {
    if (err) console.error(`[watchdog] error subscribing ${CMD_SUB}`, err);
    else console.log(`[watchdog] suscrito ${CMD_SUB}`);
  });
});

client.on("reconnect", () => console.log("[watchdog] reconectando..."));
client.on("error", (err) => console.error("[watchdog] mqtt error", err));
client.on("offline", () => console.log("[watchdog] mqtt offline"));
client.on("close", () => console.log("[watchdog] mqtt cerrado"));

function publish(topic: string, payload: string, opts: { qos: 0 | 1; retain: boolean }): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  client.publish(topic, payload, opts, (err) => {
    if (err) reject(err);
    else resolve();
  });
  return promise;
}
// ---------------------------------------------------------------------------
// data_gap — una sola vez tras BOOT_GRACE (Fase 4, ADR-0021)
// ---------------------------------------------------------------------------

async function checkDataGaps(): Promise<void> {
  const nowMs = Date.now();
  let tenants: string[];
  try {
    const res = await pool.query<{ tenant: string }>("SELECT DISTINCT tenant FROM modules");
    tenants = res.rows.map((r) => r.tenant).filter((t): t is string => typeof t === "string" && t.length > 0);
  } catch (err) {
    console.error("[watchdog] data_gap: error listando tenants", err);
    return;
  }
  if (tenants.length === 0) return;
  for (const tenant of tenants) {
    let maxMs: number | null = null;
    try {
      const res = await pool.query<{ max: Date | string | null }>("SELECT max(time) AS max FROM telemetry WHERE tenant=$1", [tenant]);
      const raw = (res.rows[0] as { max: unknown } | undefined)?.max ?? null;
      if (raw === null || raw === undefined) {
        continue;
      }
      if (raw instanceof Date) {
        const t = raw.getTime();
        if (Number.isFinite(t)) maxMs = t;
        else continue;
      } else if (typeof raw === "string") {
        const t = new Date(raw).getTime();
        if (Number.isFinite(t)) maxMs = t;
        else continue;
      } else if (typeof raw === "number" && Number.isFinite(raw)) {
        maxMs = raw;
      } else {
        continue;
      }
    } catch (err) {
      console.error(`[watchdog] data_gap: error consultando telemetry tenant=${tenant}`, err);
      continue;
    }
    const decision = decideGap(maxMs, nowMs, GAP_MIN_MS);
    if (!decision.shouldAlert) continue;
    const detail = decision.detail;
    const alert = {
      name: "data_gap",
      ts: nowMs,
      severity: "warn" as const,
      detail,
    };
    const topic = buildAlertTopic(tenant, "platform");
    try {
      await publish(topic, JSON.stringify(alert), { qos: 1, retain: false });
      console.log(`[watchdog] data_gap tenant=${tenant} from=${detail.from_ms} to=${detail.to_ms} duration_min=${detail.duration_min}`);
    } catch (err) {
      console.error(`[watchdog] data_gap: error publicando alert tenant=${tenant}`, err);
    }
  }
}


// Último health publicado por módulo para detectar cambios + heartbeat
const lastHealthJson = new Map<ModuleKey, string>();
const lastHealthState = new Map<ModuleKey, string>();

async function evaluateAndPublish(nowMs: number): Promise<void> {
  for (const [key, devices] of expectedByModule.entries()) {
    const [tenant, mod] = key.split("/");
    const tracker = getTracker(tenant, mod);
    const { moduleHealth, transitions } = tracker.evaluate(devices, nowMs);

    // Publicar health si cambió o heartbeat (el caller decide frecuencia)
    const healthJson = JSON.stringify(moduleHealth);
    const prevJson = lastHealthJson.get(key);
    const shouldPublishHealth = healthJson !== prevJson;
    // Guardamos para heartbeat: si no cambió pero toca heartbeat, igual publicamos
    if (shouldPublishHealth) {
      lastHealthJson.set(key, healthJson);
      lastHealthState.set(key, moduleHealth.state);
      const topic = buildHealthTopic(tenant, mod);
      try {
        await publish(topic, healthJson, { qos: 1, retain: true });
        console.log(`[watchdog] health ${key} -> ${moduleHealth.state}`);
      } catch (err) {
        console.error(`[watchdog] error publicando health ${topic}`, err);
      }
    }

    // Alerts: solo en transiciones, y nunca durante la gracia de arranque
    const inBootGrace = nowMs - bootedAt < BOOT_GRACE_MS;
    for (const alert of transitions) {
      if (inBootGrace) {
        console.log(`[watchdog] alert suprimida (gracia arranque) ${key} ${alert.name} ${alert.device ?? ""}`);
        continue;
      }
      const alertTopic = buildAlertTopic(tenant, mod);
      try {
        await publish(alertTopic, JSON.stringify(alert), { qos: 1, retain: false });
        console.log(`[watchdog] alert ${key} ${alert.name} ${alert.severity} ${alert.device ?? ""}`);
      } catch (err) {
        console.error(`[watchdog] error publicando alert ${alertTopic}`, err);
      }
    }
  }
  // Verificación cruzada comando→efecto (Fase 3)
  const verifAlerts = verifier.tick(nowMs);
  for (const a of verifAlerts) {
    const topic = buildAlertTopic(a.tenant, a.module);
    try {
      await publish(topic, JSON.stringify(a), { qos: 1, retain: false });
      console.log(`[watchdog] alert ${a.tenant}/${a.module} verification_failed ${a.device} kind=${a.detail.kind}`);
    } catch (err) {
      console.error(`[watchdog] error publicando alert ${topic}`, err);
    }
  }
  // Alertas agronómicas pendientes (rangos de cultivo + nivel, ADR-0028) —
  // mismo canal terra/{tenant}/{module}/alert, misma gracia de arranque
  const inBootGraceRanges = nowMs - bootedAt < BOOT_GRACE_MS;
  for (const p of pendingRangeAlerts.splice(0)) {
    if (inBootGraceRanges) {
      console.log(`[watchdog] alert suprimida (gracia arranque) ${p.tenant}/${p.module} ${p.alert.name}`);
      continue;
    }
    const topic = buildAlertTopic(p.tenant, p.module);
    try {
      await publish(topic, JSON.stringify({ name: p.alert.name, ts: nowMs, severity: p.alert.severity, detail: p.alert.detail }), { qos: 1, retain: false });
      console.log(`[watchdog] alert ${p.tenant}/${p.module} ${p.alert.name} ${p.alert.severity}`);
    } catch (err) {
      console.error(`[watchdog] error publicando alert ${topic}`, err);
    }
  }
}
client.on("message", (topic: string, payload: Buffer) => {
  // Intentar parsear JSON defensivo (para reading/status); cmd lo maneja tolerante vía verify
  let data: unknown;
  let jsonOk = true;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    jsonOk = false;
    data = null;
  }

  // Reading
  const reading = parseReadingTopic(topic);
  if (reading) {
    if (!jsonOk) {
      console.warn(`[watchdog] JSON inválido en ${topic}, descartado`);
      return;
    }
    // Payload esperado: {v, ts}
    const obj = data as Record<string, unknown>;
    const v = obj?.v;
    const ts = typeof obj?.ts === "number" ? obj.ts : Date.now();
    // validar v existe; si no, log warn pero no throw
    if (v === undefined) {
      console.warn(`[watchdog] reading sin v en ${topic}`);
      return;
    }
    const tracker = getTracker(reading.tenant, reading.module);
    try {
      tracker.seenReading(reading.tenant, reading.module, reading.device, reading.metric, v, ts, Date.now());
    } catch (err) {
      console.warn(`[watchdog] error seenReading ${topic}`, err);
    }
    // Verificación cruzada: alimentar última lectura
    if (typeof v === "number" && Number.isFinite(v)) {
      try {
        verifier.onReading(reading.tenant, reading.module, reading.metric, v, Date.now());
      } catch (err) {
        console.warn(`[watchdog] error verifier onReading ${topic}`, err);
      }
      // Rangos agronómicos (ADR-0028): cultivo (ec/ph/temp vs perfil) + nivel
      try {
        for (const alert of rangeTracker.seen(reading.tenant, reading.module, reading.metric, v)) {
          pendingRangeAlerts.push({ tenant: reading.tenant, module: reading.module, alert });
        }
      } catch (err) {
        console.warn(`[watchdog] error rangeTracker ${topic}`, err);
      }
    }
    return;
  }

  const status = parseStatusTopic(topic);
  if (status) {
    if (!jsonOk) {
      console.warn(`[watchdog] JSON inválido en ${topic}, descartado`);
      return;
    }
    const obj = data as Record<string, unknown>;
    const state = typeof obj?.state === "string" ? obj.state : undefined;
    const ts = typeof obj?.ts === "number" ? obj.ts : Date.now();
    if (!state) {
      console.warn(`[watchdog] status sin state en ${topic}`);
      return;
    }
    const tracker = getTracker(status.tenant, status.module);
    try {
      tracker.seenStatus(status.tenant, status.module, status.device, state, ts, Date.now());
    } catch (err) {
      console.warn(`[watchdog] error seenStatus ${topic}`, err);
    }
    return;
  }

  // Cmd (Fase 3) — verificación cruzada
  const cmd = parseCmdTopic(topic);
  if (cmd) {
    // payload puede ser Buffer/string/objeto; verifier es tolerante
    const raw = jsonOk ? data : payload.toString();
    try {
      verifier.onCmd(cmd.tenant, cmd.module, cmd.device, raw as unknown, Date.now());
    } catch (err) {
      console.warn(`[watchdog] error verifier onCmd ${topic}`, err);
    }
    return;
  }

  // Ignorar otros topics
});

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

await loadExpectedDevices();
await loadCropProfiles();
const refreshInterval = setInterval(() => {
  void loadExpectedDevices();
  void loadCropProfiles();
}, 60_000);

// data_gap — one-shot tras BOOT_GRACE (Fase 4)
const dataGapTimeout = setTimeout(() => void checkDataGaps(), BOOT_GRACE_MS);

// Evaluación periódica cada 5s (detecta silence) + heartbeat de health cada 30s
let lastHeartbeat = Date.now();
const evalInterval = setInterval(() => {
  const now = Date.now();
  void evaluateAndPublish(now);
  // Heartbeat: cada 30s republicar health aunque no haya cambios (retained)
  if (now - lastHeartbeat >= 30_000) {
    lastHeartbeat = now;
    for (const [key] of expectedByModule.entries()) {
      const [tenant, mod] = key.split("/");
      const tracker = getTracker(tenant, mod);
      // Forzar republicación: usar el último health conocido si existe tracker previo
      const devices = expectedByModule.get(key) ?? [];
      const { moduleHealth } = tracker.evaluate(devices, now);
      const healthJson = JSON.stringify(moduleHealth);
      // Si no hay transición, evaluate ya actualizó estado pero no publicó; heartbeat debe publicar de todos modos
      const prev = lastHealthJson.get(key);
      if (prev === healthJson) {
        // republicar igual por heartbeat
        const topic = buildHealthTopic(tenant, mod);
        publish(topic, healthJson, { qos: 1, retain: true }).catch((err) =>
          console.error(`[watchdog] heartbeat error ${topic}`, err),
        );
      }
      // evaluateAndPublish ya maneja publicación si cambió; heartbeat cubre el caso sin cambio
    }
  }
}, 5_000);

// ---------------------------------------------------------------------------
// Shutdown limpio
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[watchdog] shutdown ${signal}`);
  clearInterval(refreshInterval);
  clearInterval(evalInterval);
  clearTimeout(dataGapTimeout);
  try {
    client.end(true);
  } catch {}
  try {
    await pool.end();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[watchdog] unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[watchdog] uncaughtException", err);
  void shutdown("uncaughtException");
});
