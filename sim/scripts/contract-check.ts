// Contract test nivel 2: captura mensajes vivos del broker y los valida
// contra los schemas de contract/asyncapi.yaml. Uso: pnpm contract [segundos]
import mqtt from "mqtt";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import Ajv, { type ValidateFunction } from "ajv";

const seconds = parseInt(process.argv[2] ?? "40", 10);
const brokerUrl = process.env.MQTT_URL ?? "mqtt://localhost:1883";

const doc = parse(readFileSync(new URL("../../contract/asyncapi.yaml", import.meta.url), "utf8"));
const schemas = doc.components.schemas;
const ajv = new Ajv({ allErrors: true });
const validators: Record<string, ValidateFunction> = {};
for (const [name, schema] of Object.entries<any>(schemas)) {
  if (name === "deviceMetrics") continue;
  validators[name] = ajv.compile(schema);
}

// topic → schema según kind/estructura
function schemaFor(topic: string): string | null {
  const parts = topic.split("/");
  if (parts[0] === "homeassistant") return null; // discovery HA: formato de terceros, no validamos
  if (parts.length === 7 && parts[5] === "request") return "Request";
  if (parts.length === 6 && parts[5] === "cmd") return "Cmd";
  const kind = parts[5];
  if (kind === "reading") return "Reading";
  if (kind === "event") return "Event";
  if (kind === "status") return "Status";
  if (kind === "confidence") return "Confidence";
  return null;
}

const seen = new Map<string, number>();
const errors: string[] = [];

const client = mqtt.connect(brokerUrl);
client.on("connect", () => {
  client.subscribe("terra/#", () => {
    console.log(`[contract] capturando ${seconds}s desde ${brokerUrl}...`);
  });
});
client.on("message", (topic, payload) => {
  const schemaName = schemaFor(topic);
  if (!schemaName) return;
  seen.set(schemaName, (seen.get(schemaName) ?? 0) + 1);
  let data: unknown;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    errors.push(`${topic}: payload no es JSON`);
    return;
  }
  if (!validators[schemaName](data)) {
    errors.push(`${topic}: ${ajv.errorsText(validators[schemaName].errors)}`);
  }
});

setTimeout(() => {
  client.end();
  console.log(`[contract] mensajes validados: ${[...seen.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const expected = ["Reading", "Status"];
  for (const e of expected) {
    if (!seen.has(e)) errors.push(`no se observó ningún mensaje ${e}`);
  }
  if (errors.length) {
    console.error(`[contract] FALLOS (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("[contract] OK — todo mensaje observado cumple AsyncAPI v0.3.0");
  process.exit(0);
}, seconds * 1000);
