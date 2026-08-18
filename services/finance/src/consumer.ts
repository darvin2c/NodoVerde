// src/consumer.ts — consumidor MQTT auto-registro de dosis → movements
import mqtt from "mqtt";
import { DEVICE_SUPPLY_MAP, DOSE_EVENT_NAMES, insertDoseMovement } from "./db.js";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://mosquitto:1883";
const TOPIC = "terra/+/+/+/+/event";

// ---------------------------------------------------------------------------
// Helpers puros (testeables)
// ---------------------------------------------------------------------------

export type ParsedDoseEvent = {
  tenant: string;
  module: string;
  device: string;
  metric: string;
  name: string;
  ts: number;
  ml: number;
  supply: string;
};

export function supplyForDevice(device: string): string | null {
  return DEVICE_SUPPLY_MAP[device] ?? null;
}

export function parseDoseMessage(
  topic: string,
  payload: Buffer | string,
): ParsedDoseEvent | null {
  // topic: terra/{tenant}/{module}/{device}/{metric}/event  (6 segmentos)
  const parts = topic.split("/");
  if (parts.length !== 6) return null;
  if (parts[0] !== "terra" || parts[5] !== "event") return null;
  const [, tenant, mod, device, metric] = parts;
  if (!tenant || !mod || !device || !metric) return null;

  let msg: { name?: string; ts?: number; detail?: Record<string, unknown> };
  try {
    const raw = typeof payload === "string" ? payload : payload.toString("utf8");
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  const name = msg.name;
  if (!name || !DOSE_EVENT_NAMES[name]) return null;
  if (typeof msg.ts !== "number" || !Number.isFinite(msg.ts)) return null;
  const detail = msg.detail;
  if (!detail || typeof detail !== "object") return null;
  const ml = (detail as Record<string, unknown>).ml;
  if (typeof ml !== "number" || !Number.isFinite(ml) || ml <= 0) return null;
  const supply = supplyForDevice(device);
  if (!supply) return null;
  return { tenant, module: mod, device, metric, name, ts: msg.ts, ml, supply };
}

export async function handleDoseEvent(
  topic: string,
  payload: Buffer | string,
): Promise<string | null> {
  const parsed = parseDoseMessage(topic, payload);
  if (!parsed) return null;
  const id = await insertDoseMovement({
    tenant: parsed.tenant,
    module: parsed.module,
    device: parsed.device,
    ml: parsed.ml,
    ts: parsed.ts,
    supply: parsed.supply,
  });
  if (id) {
    console.log(
      `[terra-finance] auto movement ${id} tenant=${parsed.tenant} module=${parsed.module} device=${parsed.device} ml=${parsed.ml} supply=${parsed.supply}`,
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Loop MQTT
// ---------------------------------------------------------------------------
export function startConsumer(): mqtt.MqttClient {
  const client = mqtt.connect(MQTT_URL);

  client.on("connect", () => {
    console.log(`[terra-finance] MQTT conectado ${MQTT_URL} subscribing ${TOPIC}`);
    client.subscribe(TOPIC, { qos: 1 }, (err) => {
      if (err) console.error("[terra-finance] subscribe error", err);
    });
  });

  client.on("message", (topic: string, payload: Buffer) => {
    void handleDoseEvent(topic, payload).catch((err) =>
      console.error("[terra-finance] handleDoseEvent error", err),
    );
  });

  client.on("error", (err) => console.error("[terra-finance] MQTT error", err));
  client.on("reconnect", () => console.log("[terra-finance] MQTT reconnecting"));
  client.on("close", () => console.log("[terra-finance] MQTT close"));

  return client;
}
