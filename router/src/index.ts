#!/usr/bin/env node
// Router de identidad — ADR-0015: traduce plano dispositivo (hw_id, 5 seg) ↔ plano interno (tenant/módulo, 6 seg).
// - device→interno: terra/{hw_id}/{device}/{metric}/reading|event, status, confidence → terra/{tenant}/{module}/...
// - interno→device: terra/{tenant}/{module}/{device}/request/{action} → terra/{hw_id}/{device}/request/{action}
// - HA discovery: al resolver un hw_id conocido por primera vez (o si cambia la asignación), publica configs con topics internos.

import mqtt from "mqtt";
import { resolveByHwId, resolveByModule, closePool } from "./db.js";
import {
  parseDeviceTopic,
  parseInternalTopic,
  deviceToInternalTopic,
  internalToDeviceTopic,
  shouldRetain,
  qosForKind,
  parseCmdPayload,
  shouldForwardRequest,
  buildDeviceCmdTopic,
  type DeviceParsed,
  type InternalParsed,
} from "./topics.js";
import { buildDiscoveryConfigs } from "./discovery.js";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";

// Suscripciones
const DEVICE_SUBS = [
  "terra/+/+/+/reading",
  "terra/+/+/+/event",
  "terra/+/+/status/status",
  "terra/+/+/confidence/confidence",
] as const;

const INTERNAL_SUB = "terra/+/+/+/request/#";
const INTERNAL_CMD_SUB = "terra/+/+/+/cmd";

// Estado de discovery publicado por hw_id (para detectar re-asignación)
const discoveryPublished = new Map<string, string>(); // hw_id → "tenant/module"

// ---------------------------------------------------------------------------
// MQTT client
// ---------------------------------------------------------------------------

const clientId = `terra-router-${process.pid}-${Date.now()}`;
console.log(`[router] arranque MQTT_URL=${MQTT_URL} clientId=${clientId}`);

const client = mqtt.connect(MQTT_URL, {
  clientId,
  clean: true,
  keepalive: 30,
  reconnectPeriod: 5000,
});

client.on("connect", () => {
  console.log("[router] conectado al broker");

  for (const topic of DEVICE_SUBS) {
    client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) console.error(`[router] error subscribing ${topic}`, err);
      else console.log(`[router] suscrito ${topic}`);
    });
  }

  client.subscribe(INTERNAL_SUB, { qos: 1 }, (err) => {
    if (err) console.error(`[router] error subscribing ${INTERNAL_SUB}`, err);
    else console.log(`[router] suscrito ${INTERNAL_SUB}`);
  });

  client.subscribe(INTERNAL_CMD_SUB, { qos: 1 }, (err) => {
    if (err) console.error(`[router] error subscribing ${INTERNAL_CMD_SUB}`, err);
    else console.log(`[router] suscrito ${INTERNAL_CMD_SUB}`);
  });
});

client.on("reconnect", () => {
  console.log("[router] reconectando...");
});

client.on("error", (err) => {
  console.error("[router] mqtt error", err);
});

client.on("offline", () => {
  console.log("[router] mqtt offline");
});

client.on("close", () => {
  console.log("[router] mqtt cerrado");
});

// ---------------------------------------------------------------------------
// Helpers de publicación
// ---------------------------------------------------------------------------

function publish(topic: string, payload: Buffer, opts: { qos: 0 | 1; retain: boolean }): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  client.publish(topic, payload, opts, (err) => {
    if (err) reject(err);
    else resolve();
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

client.on("message", async (topic: string, payload: Buffer) => {
  // 1) ¿Es plano dispositivo? (5 seg, hw_id)
  const deviceParsed = parseDeviceTopic(topic);
  if (deviceParsed) {
    await handleDeviceMessage(topic, payload, deviceParsed);
    return;
  }

  // 2) ¿Es plano interno request o cmd? (cmd es 5 seg interno)
  const internalParsed = parseInternalTopic(topic);
  if (internalParsed) {
    if (internalParsed.kind === "request") {
      await handleInternalRequest(topic, payload, internalParsed);
      return;
    }
    if (internalParsed.kind === "cmd") {
      await handleInternalCmd(topic, payload, internalParsed);
      return;
    }
  }

  // Descartar silenciosamente otros topics (podrían ser plano interno reading/status que no debemos reenviar)
  // console.debug(`[router] ignorado ${topic}`);
});

// ---------------------------------------------------------------------------
// device → interno
// ---------------------------------------------------------------------------

async function handleDeviceMessage(
  topic: string,
  payload: Buffer,
  parsed: DeviceParsed,
): Promise<void> {
  // El plano dispositivo solo publica reading/event/status/confidence; request es escucha del fierro
  if (parsed.kind === "request") {
    console.warn(`[router] request inesperado en plano dispositivo ${topic} — ignorado`);
    return;
  }

  const hwId = parsed.hwId;

  const identity = await resolveByHwId(hwId);
  if (!identity) {
    console.warn(`[router] hw_id desconocido ${hwId} — descartando ${topic}`);
    return;
  }

  const internalTopic = deviceToInternalTopic(topic, identity.tenant, identity.module);
  if (!internalTopic) {
    console.warn(`[router] no se pudo mapear ${topic} → interno`);
    return;
  }

  const retain = shouldRetain(internalTopic);
  const metric = "metric" in parsed ? parsed.metric : undefined;
  const qos = qosForKind(parsed.kind, metric);

  try {
    await publish(internalTopic, payload, { qos, retain });
    console.log(`[router] device→interno ${topic} → ${internalTopic} retain=${retain} qos=${qos}`);
  } catch (err) {
    console.error(`[router] error publicando ${internalTopic}`, err);
    return;
  }

  // HA discovery: publicar al resolver por primera vez o si cambió la asignación
  const key = `${identity.tenant}/${identity.module}`;
  const prevKey = discoveryPublished.get(hwId);
  if (prevKey !== key) {
    // marcar ANTES del await: mensajes concurrentes del mismo hw_id no republican
    discoveryPublished.set(hwId, key);
    if (prevKey !== undefined) {
      console.log(`[router] hw_id ${hwId} reasignado ${prevKey} → ${key} — republicando discovery`);
    } else {
      console.log(`[router] hw_id ${hwId} resuelto ${key} — publicando HA discovery`);
    }
    await publishDiscovery(identity.tenant, identity.module);
  }
}

async function publishDiscovery(tenant: string, mod: string): Promise<void> {
  const configs = buildDiscoveryConfigs(tenant, mod);
  for (const { topic, payload } of configs) {
    const msg = Buffer.from(JSON.stringify(payload));
    try {
      await publish(topic, msg, { qos: 1, retain: true });
      console.log(`[router] discovery ${topic}`);
    } catch (err) {
      console.error(`[router] error discovery ${topic}`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// interno → device
// ---------------------------------------------------------------------------

async function handleInternalRequest(
  topic: string,
  payload: Buffer,
  parsed: InternalParsed,
): Promise<void> {
  if (parsed.kind !== "request") return;

  const { tenant, module: mod, device, action } = parsed;

  // Fase 3: interceptar solicitudes de actuación hacia actuadores — las valida el portero
  if (!shouldForwardRequest(device, action)) {
    console.debug(`[router] request interceptada por portero ${topic} device=${device} action=${action} — no traducida`);
    return;
  }

  const identity = await resolveByModule(tenant, mod);
  if (!identity) {
    console.warn(`[router] (tenant,module) desconocido ${tenant}/${mod} — descartando ${topic}`);
    return;
  }

  const deviceTopic = internalToDeviceTopic(topic, identity.hwId);
  if (!deviceTopic) {
    console.warn(`[router] no se pudo mapear interno→device ${topic}`);
    return;
  }

  try {
    await publish(deviceTopic, payload, { qos: 1, retain: false });
    console.log(`[router] interno→device ${topic} → ${deviceTopic} qos=1`);
  } catch (err) {
    console.error(`[router] error publicando ${deviceTopic}`, err);
  }
}

async function handleInternalCmd(
  topic: string,
  payload: Buffer,
  parsed: InternalParsed,
): Promise<void> {
  if (parsed.kind !== "cmd") return;

  const { tenant, module: mod, device } = parsed;

  // Exigir payload Cmd con policy_id no vacío — sin portero no hay actuación
  const cmd = parseCmdPayload(payload);
  if (!cmd) {
    console.warn(`[router] cmd descartado sin policy_id o payload inválido ${topic}`);
    return;
  }

  const identity = await resolveByModule(tenant, mod);
  if (!identity) {
    console.warn(`[router] (tenant,module) desconocido ${tenant}/${mod} — descartando ${topic}`);
    return;
  }

  const deviceTopic = buildDeviceCmdTopic(identity.hwId, device);

  try {
    await publish(deviceTopic, payload, { qos: 1, retain: false });
    console.log(`[router] cmd interno→device ${topic} → ${deviceTopic} policy_id=${cmd.policy_id} qos=1`);
  } catch (err) {
    console.error(`[router] error publicando cmd ${deviceTopic}`, err);
  }
}

export { handleInternalRequest, handleInternalCmd };

// ---------------------------------------------------------------------------
// Shutdown limpio
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[router] ${signal} — cerrando`);

  try {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (!client.connected) resolve();
    else client.end(false, {}, () => resolve());
    await promise;
    console.log("[router] mqtt desconectado");
  } catch (e) {
    console.error("[router] error cerrando mqtt", e);
  }

  try {
    await closePool();
    console.log("[router] db pool cerrado");
  } catch (e) {
    console.error("[router] error cerrando db", e);
  }

  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Manejo de excepciones no capturadas para no dejar conexiones colgando
process.on("unhandledRejection", (reason) => {
  console.error("[router] unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[router] uncaughtException", err);
  void shutdown("uncaughtException");
});
