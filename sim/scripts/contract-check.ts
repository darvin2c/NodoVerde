// Contract test nivel 2: captura mensajes vivos del broker y los valida
// contra los schemas de contract/asyncapi.yaml. Uso: pnpm contract [segundos]
// Valida ambos planos MQTT (ADR-0015): dispositivo (5 seg) e interno (6 seg).
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

// topic → schema según kind/estructura, adaptado por nº de segmentos
// - 5 segmentos = plano dispositivo: terra/{hw_id}/{device}/{metric}/reading|event  o status/confidence, request en parts[3]
// - 6 segmentos = plano interno:    terra/{tenant}/{module}/{device}/{metric}/reading|event  o request en parts[4]
function schemaFor(topic: string): string | null {
  const parts = topic.split("/");
  if (parts[0] === "homeassistant") return null; // discovery HA: lo publica el router, no el fierro
  // plano dispositivo — 5 segmentos
  if (parts.length === 5) {
    if (parts[3] === "request") return "Request";
    if (parts[3] === "cmd" || parts[4] === "cmd") return "Cmd";
    const kind = parts[4];
    if (kind === "reading") return "Reading";
    if (kind === "event") return "Event";
    if (kind === "status") return "Status";
    if (kind === "confidence") return "Confidence";
    return null;
  }
  // plano interno — 6 segmentos (y compatibilidad 7 segmentos legada)
  if (parts.length === 6) {
    if (parts[4] === "request") return "Request";
    if (parts[5] === "cmd" || parts[4] === "cmd") return "Cmd";
    const kind = parts[5];
    if (kind === "reading") return "Reading";
    if (kind === "event") return "Event";
    if (kind === "status") return "Status";
    if (kind === "confidence") return "Confidence";
    return null;
  }
  if (parts.length === 7 && parts[5] === "request") return "Request";
  if (parts.length === 6 && parts[5] === "cmd") return "Cmd";
  // fallback legado: 6-seg con parts[5] como kind (compat)
  if (parts.length >= 6) {
    const kind = parts[5];
    if (kind === "reading") return "Reading";
    if (kind === "event") return "Event";
    if (kind === "status") return "Status";
    if (kind === "confidence") return "Confidence";
  }
  return null;
}

function planoFor(topic: string): "dispositivo" | "interno" | "otro" {
  const parts = topic.split("/");
  if (parts[0] !== "terra") return "otro";
  if (parts.length === 5) return "dispositivo";
  if (parts.length === 6) return "interno";
  if (parts.length === 7) return "interno";
  return "otro";
}

const seen = new Map<string, number>();
const seenPlano = new Map<string, number>();
const errors: string[] = [];

const client = mqtt.connect(brokerUrl);
client.on("connect", () => {
  client.subscribe("terra/#", () => {
    console.log(`[contract] capturando ${seconds}s desde ${brokerUrl}...`);
  });
});
// ejercicio activo: a los 5s dispara un set como lo haría el producto (plano interno
// → router → plano dispositivo) — garantiza que el schema Event se valide de verdad
setTimeout(() => {
  client.publish("terra/demo/mod-1/doser-a-01/request/set", "ON", { qos: 1 });
  console.log("[contract] ejercicio activo: set doser-a-01 ON en mod-1");
}, 5000);
client.on("message", (topic, payload) => {
  const schemaName = schemaFor(topic);
  if (!schemaName) return;
  seen.set(schemaName, (seen.get(schemaName) ?? 0) + 1);
  const plano = planoFor(topic);
  seenPlano.set(plano, (seenPlano.get(plano) ?? 0) + 1);
  let data: unknown;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    // Request admite crudo ("ON"/"OFF", Fase 0); el resto de schemas exige JSON
    if (schemaName === "Request") {
      data = payload.toString();
    } else {
      errors.push(`${topic}: payload no es JSON`);
      return;
    }
  }
  if (!validators[schemaName](data)) {
    errors.push(`${topic}: ${ajv.errorsText(validators[schemaName].errors)}`);
  }
});

setTimeout(() => {
  client.end();
  console.log(`[contract] mensajes validados: ${[...seen.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`[contract] desglose por plano: ${[...seenPlano.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const expected = ["Reading", "Status", "Event"];
  for (const e of expected) {
    if (!seen.has(e)) errors.push(`no se observó ningún mensaje ${e}`);
  }
  if (errors.length) {
    console.error(`[contract] FALLOS (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("[contract] OK — todo mensaje observado cumple AsyncAPI v0.4.0");
  process.exit(0);
}, seconds * 1000);
