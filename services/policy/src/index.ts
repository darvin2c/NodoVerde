#!/usr/bin/env node
import mqtt from "mqtt";
import { createHttpServer } from "./http.js";
import { POLICY_PORT, MQTT_URL } from "./config.js";
import { pool } from "./db.js";
import { onReading, onConfidence, onHealth } from "./state.js";
import { setPublisher } from "./policy.js";
import { parseRequestPayload, classifyDevice } from "./rules.js";
import { proposeAction } from "./policy.js";

// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------
const READING_SUB = "terra/+/+/+/+/reading";
const CONFIDENCE_SUB = "terra/+/+/confidence";
const HEALTH_SUB = "terra/+/+/health";
const HUMAN_REQUEST_SUB = "terra/+/+/+/request/#";

const clientId = `terra-policy-${process.pid}-${Date.now()}`;
const mqttClient = mqtt.connect(MQTT_URL, {
  clientId,
  clean: true,
  reconnectPeriod: 5000,
  connectTimeout: 5000,
});

setPublisher(async (topic, payload, opts) => {
  await new Promise<void>((resolve, reject) => {
    mqttClient.publish(topic, payload, opts, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

mqttClient.on("connect", () => {
  console.log(`[terra-policy] MQTT conectado ${MQTT_URL}`);
  mqttClient.subscribe(
    [READING_SUB, CONFIDENCE_SUB, HEALTH_SUB, HUMAN_REQUEST_SUB],
    { qos: 1 },
    (err) => {
      if (err) console.error("[terra-policy] subscribe error", err);
      else console.log(`[terra-policy] suscrito ${READING_SUB} ${CONFIDENCE_SUB} ${HEALTH_SUB} ${HUMAN_REQUEST_SUB}`);
    },
  );
});

mqttClient.on("reconnect", () => console.log("[terra-policy] MQTT reconectando..."));
mqttClient.on("error", (err) => console.error("[terra-policy] MQTT error", err));
mqttClient.on("offline", () => console.log("[terra-policy] MQTT offline"));
mqttClient.on("close", () => console.log("[terra-policy] MQTT cerrado"));

mqttClient.on("message", (topic: string, payload: Buffer) => {
  // Intentar handlers de cache primero
  if (onReading(topic, payload)) return;
  if (onConfidence(topic, payload)) return;
  if (onHealth(topic, payload)) return;

  // Interceptación humana: terra/{tenant}/{module}/{device}/request/#
  // Solo actuadores con action set|start|stop
  const parts = topic.split("/");
  // parts: terra / tenant / module / device / request / ... 
  if (parts.length >= 5 && parts[0] === "terra" && parts[4] === "request") {
    const tenant = parts[1];
    const mod = parts[2];
    const device = parts[3];
    // Solo actuadores
    if (!classifyDevice(device)) return;
    // Extraer payload y parsear
    const parsed = parseRequestPayload(payload, device);
    if (!parsed) {
      console.warn(`[terra-policy] request humano no parseable ${topic} → ignorado`);
      return;
    }
    // Solo interceptar set|start|stop hacia actuadores; read|capture|calibrate pasan directo (no hacer nada)
    // parsed siempre es start|stop|set así que está interceptado
    const params =
      parsed.action === "start"
        ? (parsed as { action: "start"; params?: { duration_ms?: number } }).params ?? null
        : parsed.action === "set"
          ? (parsed as { action: "set"; params: { v: string } }).params
          : null;

    void proposeAction({
      tenant,
      module: mod,
      device,
      action: parsed.action,
      params: params as Record<string, unknown> | null,
      requested_by: "ha-button",
      reason: "request humana HA",
      source: "human",
    })
      .then((r) => console.log(`[terra-policy] humana ${tenant}/${mod}/${device} ${parsed.action} → ${r.status}`))
      .catch((err) => console.error("[terra-policy] humana propose error", err));
    return;
  }
});

// ---------------------------------------------------------------------------
// HTTP + MCP
// ---------------------------------------------------------------------------
const httpServer = createHttpServer();

httpServer.listen(POLICY_PORT, () => {
  console.log(`[terra-policy] escuchando :${POLICY_PORT} (POST /mcp, GET /healthz, /api/*)`);
});

// ---------------------------------------------------------------------------
// Shutdown limpio
// ---------------------------------------------------------------------------
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[terra-policy] ${signal} — cerrando`);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await new Promise<void>((resolve) => {
    try {
      mqttClient.end(false, {}, () => resolve());
    } catch {
      resolve();
    }
  });
  await pool.end();
  console.log("[terra-policy] cerrado");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => console.error("[terra-policy] unhandledRejection", reason));
process.on("uncaughtException", (err) => {
  console.error("[terra-policy] uncaughtException", err);
  void shutdown("uncaughtException");
});
