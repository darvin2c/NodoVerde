// Contract test nivel 2: captura mensajes vivos del broker y los valida
// contra los schemas de contract/asyncapi.yaml. Uso: pnpm contract [segundos]
// Valida tres planos MQTT (ADR-0015 + ADR-0010 Fase 1 + Fase 3 v0.7.0):
//   - dispositivo (4-5 seg) — terra/{hw_id}/{device}/{metric}/reading|event|status|confidence, request, cmd (Fase 3)
//   - interno (5-6 seg)     — terra/{tenant}/{module}/{device}/{metric}/reading|event|status|confidence, request/cmd
//   - plataforma (4 seg)    — terra/{tenant}/{module}/confidence|health|alert (servicios de dominio DIRECTO, sin hw_id)
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
// - 4 segmentos = plano plataforma (4) o dispositivo cmd (Fase 3: terra/{hw}/{device}/cmd)
// - 5 segmentos = plano dispositivo (5) o interno cmd (Fase 3: terra/{tenant}/{module}/{device}/cmd)
// - 6 segmentos = plano interno (6)
function schemaFor(topic: string): string | null {
  const parts = topic.split("/");
  if (parts[0] === "homeassistant") return null; // discovery HA: lo publica el router, no el fierro
  // plano plataforma — 4 segmentos, o dispositivo cmd 4-seg
  if (parts.length === 4) {
    if (parts[3] === "cmd") return "Cmd"; // Fase 3 dispositivo
    const kind = parts[3];
    if (kind === "confidence") return "Confidence";
    if (kind === "health") return "Health";
    if (kind === "alert") return "Alert";
    return null;
  }
  // plano dispositivo — 5 segmentos (o interno cmd 5-seg)
  if (parts.length === 5) {
    if (parts[3] === "request") return "Request";
    if (parts[4] === "cmd" || parts[3] === "cmd") return "Cmd";
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

function planoFor(topic: string): "plataforma" | "dispositivo" | "interno" | "otro" {
  const parts = topic.split("/");
  if (parts[0] !== "terra") return "otro";
  if (parts.length === 4) {
    if (parts[3] === "cmd") return "dispositivo"; // Fase 3 device cmd
    return "plataforma";
  }
  if (parts.length === 5) {
    if (parts[4] === "cmd") return "interno"; // Fase 3 internal cmd
    return "dispositivo";
  }
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
// ejercicio activo Fase 3: a los ~5s publica cmd interno con policy_id al actuador
// (terra/demo/mod-1/doser-a-01/cmd) — el router lo traduce a plano dispositivo
// SOLO si policy_id no vacío (sin portero jamás llega al fierro). Documenta que
// cmd con policy_id lo traduce el router sin portero (defensa en profundidad en el fierro).
setTimeout(() => {
  const payload = JSON.stringify({ action: "start", policy_id: "pol-contract-check", params: { duration_ms: 1000 } });
  client.publish("terra/demo/mod-1/doser-a-01/cmd", payload, { qos: 1 });
  console.log("[contract] ejercicio activo: cmd start doser-a-01 (policy pol-contract-check) en mod-1");
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
  console.log("[contract] OK — todo mensaje observado cumple AsyncAPI v0.7.0");
}, seconds * 1000);
