#!/usr/bin/env node
// Servicio de confianza — termómetro por módulo (ADR-0010).
// Cálculo determinístico, nunca LLM. Publica terra/{tenant}/{module}/confidence (retain qos1).
// Suscribe plano interno: readings (6 seg), status y confidence por dispositivo.
// Cero actuación: jamás publica a cmd ni request/.

import mqtt from "mqtt";
import pg from "pg";
import { variableConfidence, moduleConfidence, DEFAULT_WEIGHTS } from "./thermometer.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Configuración por entorno
// ---------------------------------------------------------------------------

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";
const PUBLISH_INTERVAL_MS = parseInt(process.env.PUBLISH_INTERVAL_MS ?? "15000", 10);
const MODULE_REFRESH_MS = 60_000;
const IMMEDIATE_DELTA = 5; // puntos para disparo inmediato

console.log(
  `[confidence] arranque MQTT_URL=${MQTT_URL} PUBLISH_INTERVAL_MS=${PUBLISH_INTERVAL_MS} DATABASE_URL=${DATABASE_URL.replace(/:[^@]+@/, ":***@")}`,
);

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------

type ReadingEntry = {
  tenant: string;
  module: string;
  device: string;
  metric: string;
  ts: number;
  v: unknown;
};

type DeviceConfEntry = {
  tenant: string;
  module: string;
  device: string;
  v: number;
  ts: number;
};

type ModuleKey = string; // "tenant/module"

const readingByMetric = new Map<string, ReadingEntry>(); // key: tenant::module::metric
const confByDevice = new Map<string, DeviceConfEntry>(); // key: tenant::module::device
const lastPublished = new Map<ModuleKey, { v: number; ts: number }>();
const knownModules = new Map<ModuleKey, { tenant: string; module: string }>();

function metricKey(tenant: string, mod: string, metric: string): string {
  return `${tenant}::${mod}::${metric}`;
}
function deviceKey(tenant: string, mod: string, device: string): string {
  return `${tenant}::${mod}::${device}`;
}
function moduleKey(tenant: string, mod: string): string {
  return `${tenant}/${mod}`;
}

function parseModuleKey(k: ModuleKey): { tenant: string; module: string } {
  const [tenant, mod] = k.split("/");
  return { tenant, module: mod };
}

// Métricas esperadas (orden estable para determinismo)
const EXPECTED_METRICS = Object.keys(DEFAULT_WEIGHTS); // ec, ph, temp, level, flow, air_temp, humidity, photo

// ---------------------------------------------------------------------------
// DB — módulos conocidos
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("error", (err) => console.error("[confidence] pg pool error", err));

async function refreshModules(): Promise<void> {
  try {
    const res = await pool.query<{ tenant: string; id: string }>("SELECT tenant, id FROM modules");
    const seen = new Set<string>();
    for (const row of res.rows) {
      const k = moduleKey(row.tenant, row.id);
      seen.add(k);
      if (!knownModules.has(k)) {
        knownModules.set(k, { tenant: row.tenant, module: row.id });
        console.log(`[confidence] módulo detectado ${k}`);
      }
    }
    // Eliminar módulos que ya no existen (por si se des-aprovisiona)
    for (const k of [...knownModules.keys()]) {
      if (!seen.has(k)) {
        knownModules.delete(k);
        console.log(`[confidence] módulo removido ${k}`);
      }
    }
  } catch (err) {
    console.error("[confidence] error refrescando módulos", err);
  }
}

// Carga inicial + refresco periódico
await refreshModules();
const refreshTimer = setInterval(() => {
  void refreshModules();
}, MODULE_REFRESH_MS);
refreshTimer.unref();

// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------

const clientId = `terra-confidence-${process.pid}-${Date.now()}`;
const client = mqtt.connect(MQTT_URL, {
  clientId,
  clean: true,
  keepalive: 30,
  reconnectPeriod: 5000,
});

client.on("connect", () => {
  console.log("[confidence] conectado al broker");
  // Plano interno: readings (6 seg) y confianza/status por dispositivo
  const subs: string[] = [
    "terra/+/+/+/+/reading",
    "terra/+/+/+/confidence/confidence",
    "terra/+/+/+/status/status",
  ];
  for (const t of subs) {
    client.subscribe(t, { qos: 1 }, (err) => {
      if (err) console.error(`[confidence] error subscribing ${t}`, err);
      else console.log(`[confidence] suscrito ${t}`);
    });
  }
});

client.on("reconnect", () => console.log("[confidence] reconectando..."));
client.on("error", (err) => console.error("[confidence] mqtt error", err));
client.on("offline", () => console.log("[confidence] mqtt offline"));
client.on("close", () => console.log("[confidence] mqtt cerrado"));

// ---------------------------------------------------------------------------
// Cálculo por módulo
// ---------------------------------------------------------------------------

function computeModuleConfidence(tenant: string, mod: string, nowMs: number): { v: number; ts: number; sources: Record<string, number> } {
  const perVariable: { metric: string; value: number }[] = [];
  const sources: Record<string, number> = {};

  for (const metric of EXPECTED_METRICS) {
    const k = metricKey(tenant, mod, metric);
    const entry = readingByMetric.get(k);

    let conf: number;
    if (!entry) {
      conf = variableConfidence({ source: metric === "photo" ? "photo" : "sensor", metric, publishedAtMs: null, nowMs });
    } else {
      // Determinar fuente y baseOverride
      const source = metric === "photo" ? "photo" : "sensor";
      let baseOverride: number | undefined;
      if (source === "sensor") {
        const dk = deviceKey(tenant, mod, entry.device);
        const devConf = confByDevice.get(dk);
        if (devConf) baseOverride = devConf.v;
      }
      conf = variableConfidence({
        source: source as "sensor" | "photo" | "human",
        metric,
        publishedAtMs: entry.ts,
        nowMs,
        baseOverride,
      });
    }

    perVariable.push({ metric, value: conf });
    sources[metric] = conf;
  }

  const v = moduleConfidence(perVariable);
  return { v, ts: nowMs, sources };
}

function confidenceTopic(tenant: string, mod: string): string {
  return `terra/${tenant}/${mod}/confidence`;
}

async function publishConfidence(tenant: string, mod: string, nowMs: number, force = false): Promise<void> {
  const k = moduleKey(tenant, mod);
  const computed = computeModuleConfidence(tenant, mod, nowMs);
  const prev = lastPublished.get(k);

  const shouldPublish = force || !prev || Math.abs(computed.v - prev.v) >= IMMEDIATE_DELTA;

  if (!shouldPublish) return;

  const topic = confidenceTopic(tenant, mod);
  const payload = JSON.stringify({ v: computed.v, ts: computed.ts, sources: computed.sources });

  await new Promise<void>((resolve, reject) => {
    client.publish(topic, payload, { qos: 1, retain: true }, (err) => (err ? reject(err) : resolve()));
  });

  lastPublished.set(k, { v: computed.v, ts: computed.ts });
  console.log(`[confidence] publicado ${topic} v=${computed.v} ${force ? "(interval)" : "(delta≥5)"}`);
}

// ---------------------------------------------------------------------------
// Handler de mensajes (parse defensivo)
// ---------------------------------------------------------------------------

client.on("message", async (topic: string, payload: Buffer) => {
  // Parse defensivo: nunca tirar el proceso por payload malformado
  let data: unknown;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    console.warn(`[confidence] payload no JSON ${topic}`);
    return;
  }

  const parts = topic.split("/");

  // Dos formas: reading (6 seg) vs confidence/status por dispositivo (6 seg)
  // reading:  terra/{tenant}/{module}/{device}/{metric}/reading  → parts[5]=reading
  // confidence: terra/{tenant}/{module}/{device}/confidence/confidence → parts[4]=confidence, parts[5]=confidence
  // status:    terra/{tenant}/{module}/{device}/status/status          → parts[4]=status, parts[5]=status
  // confidence global (4 seg) es lo que NOSOTROS publicamos, no lo consumimos.

  if (parts.length !== 6 || parts[0] !== "terra") return;

  const tenant = parts[1];
  const mod = parts[2];
  const device = parts[3];
  const metricOrKind = parts[4];
  const kind = parts[5];

  // Solo procesamos módulos conocidos? Si viene de módulo desconocido, lo ignoramos pero
  // podríamos agregarlo dinámicamente si aparece (no en cache). Para robustez, lo aceptamos
  // si el tópico parsea, y el cómputo lo descubrirá en el próximo refresh o al vuelo.
  // Aquí registramos lectura aunque el módulo aún no esté en knownModules, pero no publicaremos
  // para desconocidos hasta que existan en DB (o los agregamos optimistamente).

  if (kind === "reading") {
    const metric = metricOrKind;
    // Payload esperado: {v, ts}
    const rec = data as { v?: unknown; ts?: unknown };
    const ts = typeof rec.ts === "number" ? rec.ts : Date.now();
    // Guardar última lectura
    const key = metricKey(tenant, mod, metric);
    readingByMetric.set(key, { tenant, module: mod, device, metric, ts, v: rec.v });

    // Disparo inmediato si el delta lo exige (recomputar solo ese módulo)
    try {
      const mk = moduleKey(tenant, mod);
      // Solo disparar si el módulo es conocido o si queremos aprenderlo al vuelo
      if (knownModules.has(mk)) {
        await publishConfidence(tenant, mod, Date.now(), false);
      }
    } catch (err) {
      console.error("[confidence] error publicando inmediato reading", err);
    }
    return;
  }

  if (metricOrKind === "confidence" && kind === "confidence") {
    // Confidence por dispositivo: terra/{tenant}/{module}/{device}/confidence/confidence
    // Payload: {v, ts, sources}
    const rec = data as { v?: unknown; ts?: unknown };
    if (typeof rec.v !== "number" || typeof rec.ts !== "number") {
      console.warn(`[confidence] confidence inválido ${topic} ${payload.toString().slice(0, 200)}`);
      return;
    }
    const v = Math.max(0, Math.min(100, rec.v));
    const ts = rec.ts;
    const dk = deviceKey(tenant, mod, device);
    confByDevice.set(dk, { tenant, module: mod, device, v, ts });

    // La confianza del dispositivo afecta el cálculo del módulo (baseOverride)
    try {
      const mk = moduleKey(tenant, mod);
      if (knownModules.has(mk)) {
        await publishConfidence(tenant, mod, Date.now(), false);
      }
    } catch (err) {
      console.error("[confidence] error publicando inmediato confidence", err);
    }
    return;
  }

  if (metricOrKind === "status" && kind === "status") {
    // Status por dispositivo: terra/{tenant}/{module}/{device}/status/status
    // Payload: {state, ts}
    // Por ahora solo logueamos defensivamente; no afecta confianza directamente.
    // Podría usarse en el futuro para marcar dispositivos offline con confianza 0.
    // No disparamos publicación para no amplificar ruido de LWT.
    return;
  }

  // Otros topics (event, etc.) se ignoran silenciosamente
});

// ---------------------------------------------------------------------------
// Loop de publicación periódica
// ---------------------------------------------------------------------------

const publishTimer = setInterval(() => {
  const now = Date.now();
  for (const { tenant, module } of knownModules.values()) {
    void publishConfidence(tenant, module, now, true).catch((err) =>
      console.error(`[confidence] error publish interval ${tenant}/${module}`, err),
    );
  }
}, PUBLISH_INTERVAL_MS);
publishTimer.unref();

// ---------------------------------------------------------------------------
// Shutdown limpio
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[confidence] ${signal} — cierre limpio...`);
  clearInterval(publishTimer);
  clearInterval(refreshTimer);
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
  console.error("[confidence] unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[confidence] uncaughtException", err);
  void shutdown("uncaughtException");
});
