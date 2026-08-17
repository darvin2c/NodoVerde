import { type MqttClient } from "mqtt";
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

// topic helpers — plano dispositivo (5 segmentos, por hw_id)
// El fierro solo conoce su hw_id; jamás tenant/módulo (ADR-0015)
export function readingTopic(hwId: string, device: string, metric: string): string {
  return `terra/${hwId}/${device}/${metric}/reading`;
}
export function eventTopic(hwId: string, device: string, metric: string): string {
  return `terra/${hwId}/${device}/${metric}/event`;
}
export function statusTopic(hwId: string, device: string): string {
  return `terra/${hwId}/${device}/status/status`;
}
export function confidenceTopic(hwId: string, device: string): string {
  return `terra/${hwId}/${device}/confidence/confidence`;
}
export function requestTopic(hwId: string, device: string, action: string): string {
  return `terra/${hwId}/${device}/request/${action}`;
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
