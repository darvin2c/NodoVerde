import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { z } from "zod";

// --- zod schemas mirroring contract/asyncapi.yaml ---
export const ReadingSchema = z.object({
  v: z.union([z.number(), z.string()]),
  ts: z.number().int(),
});

export const EventSchema = z.object({
  name: z.string(),
  ts: z.number().int(),
  detail: z.record(z.unknown()).optional(),
});

export const StatusSchema = z.object({
  state: z.enum(["online", "offline", "error"]),
  ts: z.number().int(),
  meta: z.record(z.unknown()).optional(),
});

export const ConfidenceSchema = z.object({
  v: z.number().min(0).max(100),
  ts: z.number().int(),
  sources: z.record(z.number()).optional(),
});

export const CmdSchema = z.object({
  action: z.enum(["start", "stop", "set"]),
  policy_id: z.string(),
  params: z.record(z.unknown()).optional(),
});

// payload builders (pure)
export function buildReading(v: number | string, ts: number) {
  const payload = { v, ts };
  return ReadingSchema.parse(payload);
}
export function buildStatus(state: "online" | "offline" | "error", ts: number) {
  const payload = { state, ts };
  return StatusSchema.parse(payload);
}
export function buildEvent(name: string, ts: number, detail?: Record<string, unknown>) {
  const payload = detail ? { name, ts, detail } : { name, ts };
  return EventSchema.parse(payload);
}
export function buildConfidence(v: number, ts: number, sources: Record<string, number>) {
  const payload = { v, ts, sources };
  return ConfidenceSchema.parse(payload);
}

// topic helpers
export function readingTopic(tenant: string, mod: string, device: string, metric: string): string {
  return `terra/${tenant}/${mod}/${device}/${metric}/reading`;
}
export function eventTopic(tenant: string, mod: string, device: string, metric: string): string {
  return `terra/${tenant}/${mod}/${device}/${metric}/event`;
}
export function statusTopic(tenant: string, mod: string, device: string): string {
  return `terra/${tenant}/${mod}/${device}/status/status`;
}
export function confidenceTopic(tenant: string, mod: string, device: string): string {
  return `terra/${tenant}/${mod}/${device}/confidence/confidence`;
}
export function requestTopic(tenant: string, mod: string, device: string, action: string): string {
  return `terra/${tenant}/${mod}/${device}/request/${action}`;
}

// HA discovery builders
export type HaSensorDiscovery = {
  name: string;
  unique_id: string;
  state_topic: string;
  value_template: string;
  availability_topic: string;
  payload_available: string;
  payload_not_available: string;
  device: { identifiers: string[]; name: string; manufacturer: string };
  unit_of_measurement?: string;
  device_class?: string;
  state_class?: string;
  value_json?: string;
};

export function haSensorDiscovery(opts: {
  tenant: string;
  mod: string;
  device: string;
  metric: string;
  name: string;
  unit?: string;
  deviceClass?: string;
}): { topic: string; payload: Record<string, unknown> } {
  const deviceId = `${opts.mod}-${opts.device}`;
  const uniqueId = `${opts.mod}-${opts.device}-${opts.metric}`;
  const stateTopic = readingTopic(opts.tenant, opts.mod, opts.device, opts.metric);
  const availabilityTopic = statusTopic(opts.tenant, opts.mod, opts.device);
  const payload: Record<string, unknown> = {
    name: opts.name,
    unique_id: uniqueId,
    state_topic: stateTopic,
    value_template: "{{ value_json.v }}",
    availability_topic: availabilityTopic,
    payload_available: "online",
    payload_not_available: "offline",
    availability_template: "{{ value_json.state }}",
    device: {
      identifiers: [deviceId],
      name: `${opts.mod} ${opts.device}`,
      manufacturer: "terraOS",
    },
  };
  if (opts.unit) payload.unit_of_measurement = opts.unit;
  if (opts.deviceClass) payload.device_class = opts.deviceClass;
  if (opts.metric !== "switch") payload.state_class = "measurement";
  const topic = `homeassistant/sensor/${uniqueId}/config`;
  return { topic, payload };
}

export function haSwitchDiscovery(opts: {
  tenant: string;
  mod: string;
  device: string;
  name: string;
}): { topic: string; payload: Record<string, unknown> } {
  const deviceId = `${opts.mod}-${opts.device}`;
  const uniqueId = `${opts.mod}-${opts.device}-switch`;
  const stateTopic = readingTopic(opts.tenant, opts.mod, opts.device, "switch");
  const commandTopic = requestTopic(opts.tenant, opts.mod, opts.device, "set");
  const availabilityTopic = statusTopic(opts.tenant, opts.mod, opts.device);
  const payload: Record<string, unknown> = {
    name: opts.name,
    unique_id: uniqueId,
    state_topic: stateTopic,
    value_template: "{{ value_json.v }}",
    command_topic: commandTopic,
    payload_on: "ON",
    payload_off: "OFF",
    state_on: "ON",
    state_off: "OFF",
    availability_topic: availabilityTopic,
    payload_available: "online",
    payload_not_available: "offline",
    availability_template: "{{ value_json.state }}",
    device: {
      identifiers: [deviceId],
      name: `${opts.mod} ${opts.device}`,
      manufacturer: "terraOS",
    },
  };
  const topic = `homeassistant/switch/${uniqueId}/config`;
  return { topic, payload };
}

// MQTT connection wrapper
export type MqttOptions = {
  brokerUrl: string;
  tenant: string;
  modules: string[];
};

export function createMqttClient(brokerUrl: string, clientId: string, wills?: { topic: string; payload: string }[]): MqttClient {
  const opts: IClientOptions = {
    clientId,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 2000,
  };
  if (wills && wills.length > 0) {
    // mqtt.js only supports single will; we will set first and publish others on offline handling
    // For Fase 0 we need LWT per device retendido: we set will for first device, rest via manual publish before disconnect?
    // Actually we can set will for one and handle others via explicit offline publish on SIGINT.
    // To fulfill requirement, we set will for each device by using multiple clients? Simpler: one client with will for aggregated?
    // We'll set will for the first; our publisher will also publish offline retain on graceful shutdown.
    opts.will = {
      topic: wills[0].topic,
      payload: Buffer.from(wills[0].payload),
      qos: 1 as const,
      retain: true,
    };
  }
  return mqtt.connect(brokerUrl, opts);
}

export function publishRetained(
  client: MqttClient,
  topic: string,
  payload: unknown,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const msg = JSON.stringify(payload);
  client.publish(topic, msg, { qos: 1, retain: true }, (err) => (err ? reject(err) : resolve()));
  return promise;
}

export function publish(
  client: MqttClient,
  topic: string,
  payload: unknown,
  retain = false,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const msg = JSON.stringify(payload);
  client.publish(topic, msg, { qos: 0, retain }, (err) => (err ? reject(err) : resolve()));
  return promise;
}
