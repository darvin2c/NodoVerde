// src/bus.ts — eventos de dominio al bus MQTT (plano plataforma, contrato v0.8.0)
// Tras una escritura gobernada de módulo (create/update/retire/claim) se publica
// terra/{tenant}/{module}/meta para que el router refresque el discovery de HA
// (nombre/área) sin esperar reinicio. Best-effort: la DB es la fuente de verdad;
// si el publish falla, el router recupera el estado fresco en su próximo arranque.

import mqtt from "mqtt";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";

let client: mqtt.MqttClient | null = null;

function getClient(): mqtt.MqttClient {
  if (!client) {
    client = mqtt.connect(MQTT_URL, {
      clientId: `terra-mcp-domain-meta-${process.pid}-${Date.now()}`,
    });
    client.on("error", (err) => console.error("[mcp-domain:bus] mqtt error", err));
  }
  return client;
}

export type ModuleMetaEvent = "module_created" | "module_updated" | "module_retired" | "device_claimed" | "device_unclaimed";

/** Publica evento meta de módulo. No lanza: best-effort (ver header). Timeout 3s — si el broker no responde, la escritura DB ya quedó y el router recupera el nombre en su próximo arranque. */
export async function publishModuleMeta(tenant: string, moduleId: string, event: ModuleMetaEvent): Promise<void> {
  const topic = `terra/${tenant}/${moduleId}/meta`;
  const payload = JSON.stringify({ event, tenant, module: moduleId, ts: new Date().toISOString() });
  try {
    const c = getClient();
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        c.publish(topic, payload, { qos: 1, retain: false }, (err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("meta publish timeout 3s")), 3000)),
    ]);
    console.log(`[mcp-domain:bus] meta ${event} → ${topic}`);
  } catch (err) {
    console.warn(`[mcp-domain:bus] no se pudo publicar ${topic} (best-effort, la DB ya quedó escrita)`, err);
  }
}

/** Cierra el cliente (shutdown limpio / tests). */
export async function closeBus(): Promise<void> {
  if (client) {
    await client.endAsync();
    client = null;
  }
}
