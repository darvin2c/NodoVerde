import { EventEmitter } from "node:events";
import mqtt from "mqtt";

export type ConfidencePayload = {
  v: number;
  ts: number;
  sources: Record<string, number>;
};

export type HealthPayload = {
  state: "ok" | "degraded" | "offline" | "blind";
  ts: number;
  devices: Record<string, string>;
};

// Bus interno: el servidor se suscribe a MQTT y reemite vía EventEmitter.
// Esto alimenta las subscriptions tRPC (fan-out a N clientes).
class MqttBus extends EventEmitter {
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  private lastConfidence: Map<string, ConfidencePayload & { tenant: string; module: string }> = new Map();
  private lastHealth: Map<string, HealthPayload & { tenant: string; module: string }> = new Map();

  isConnected(): boolean {
    return this.connected;
  }

  getLastConfidence(): Map<string, ConfidencePayload & { tenant: string; module: string }> {
    return this.lastConfidence;
  }

  getLastHealth(): Map<string, HealthPayload & { tenant: string; module: string }> {
    return this.lastHealth;
  }

  start() {
    const url = process.env.MQTT_URL ?? "mqtt://localhost:1883";
    // No bloquear si el broker no está: reconexión automática
    this.client = mqtt.connect(url, { reconnectPeriod: 5000, connectTimeout: 5000 });

    this.client.on("connect", () => {
      this.connected = true;
      this.client?.subscribe("terra/+/+/confidence", { qos: 1 });
      this.client?.subscribe("terra/+/+/health", { qos: 1 });
      // eslint-disable-next-line no-console
      console.log(`[pwa-mqtt] conectado a ${url}`);
    });

    this.client.on("close", () => {
      this.connected = false;
    });

    this.client.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[pwa-mqtt] error", err.message);
    });

    this.client.on("message", (topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        const parts = topic.split("/");
        // terra/{tenant}/{module}/confidence  -> 4 segmentos
        // terra/{tenant}/{module}/health
        if (parts.length !== 4) return;
        const [, tenant, mod, kind] = parts;
        const key = `${tenant}/${mod}`;
        if (kind === "confidence") {
          const shaped = shapeConfidence(data);
          if (!shaped) return;
          const enriched = { ...shaped, tenant, module: mod };
          this.lastConfidence.set(key, enriched);
          this.emit("confidence", enriched);
        } else if (kind === "health") {
          const shaped = shapeHealth(data);
          if (!shaped) return;
          const enriched = { ...shaped, tenant, module: mod };
          this.lastHealth.set(key, enriched);
          this.emit("health", enriched);
        }
      } catch {
        // payload malformado: ignorar
      }
    });
  }

  stop() {
    this.client?.end(true);
  }
}

// Validación y shaping de confianza (defensivo — el servicio confidence es la fuente autoritativa)
export function shapeConfidence(raw: unknown): ConfidencePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const v = Number(r.v);
  const ts = Number(r.ts);
  if (!Number.isFinite(v) || !Number.isFinite(ts)) return null;
  // Nunca 100 (ADR-0010), clamp 0-99
  const clamped = Math.max(0, Math.min(99, v));
  const sources: Record<string, number> = {};
  if (r.sources && typeof r.sources === "object") {
    for (const [k, val] of Object.entries(r.sources as Record<string, unknown>)) {
      const n = Number(val);
      if (Number.isFinite(n)) sources[k] = n;
    }
  }
  return { v: clamped, ts, sources };
}

export function shapeHealth(raw: unknown): HealthPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const state = r.state as string;
  const ts = Number(r.ts);
  if (!["ok", "degraded", "offline", "blind"].includes(state)) return null;
  if (!Number.isFinite(ts)) return null;
  const devices: Record<string, string> = {};
  if (r.devices && typeof r.devices === "object") {
    for (const [k, val] of Object.entries(r.devices as Record<string, unknown>)) {
      if (typeof val === "string") devices[k] = val;
    }
  }
  return { state: state as HealthPayload["state"], ts, devices };
}

export const mqttBus = new MqttBus();
