#!/usr/bin/env node
// Bridge MQTT → OpenClaw (Fase 1: bus → cerebro, observador).
// - Suscribe terra/+/+/alert y terra/+/+/health (plano plataforma, 4 segmentos, interno directo).
// - Por alerta que pase shouldForward → POST al hook de OpenClaw.
// - Por health: solo log de transiciones (module_blind ya cubre el wake via alerta).
// - NUNCA publica a actuadores (Fase 1 es solo observador — sin comandos ni solicitudes).

import mqtt from "mqtt";
import pg from "pg";
import { createServer } from "node:http";
import { z } from "zod";
import { shouldForward, formatHookMessage, DEFAULT_THROTTLE_MS, formatPolicyEvent, shouldForwardPolicyEvent, parsePolicyEventBody } from "./forward.js";
import { targetAgents, extractExpertReport } from "./route.js";
import type { Alert } from "./forward.js";

// ---------------------------------------------------------------------------
// Env — validación al arranque
// ---------------------------------------------------------------------------

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const OPENCLAW_URL = process.env.OPENCLAW_URL ?? "http://localhost:18789";
const HOOKS_PATH = process.env.HOOKS_PATH ?? "/hooks/agent";
const BRIDGE_NAME = process.env.BRIDGE_NAME ?? "terra-bridge";
const THROTTLE_MS = process.env.THROTTLE_MS ? Number(process.env.THROTTLE_MS) : DEFAULT_THROTTLE_MS;
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL; // opcional: sin DB las alertas van directo al orquestador
const BRIDGE_HTTP_PORT = Number(process.env.BRIDGE_HTTP_PORT ?? 7765);

if (!OPENCLAW_HOOK_TOKEN) {
  console.error(
    "[bridge] ERROR: falta OPENCLAW_HOOK_TOKEN. " +
      "Configura el token del hook de OpenClaw (hooks.token en openclaw.json) " +
      "como variable de entorno OPENCLAW_HOOK_TOKEN. Abortando.",
  );
  process.exit(1);
}

if (Number.isNaN(THROTTLE_MS) || THROTTLE_MS < 0) {
  console.error(`[bridge] ERROR: THROTTLE_MS inválido: ${process.env.THROTTLE_MS}`);
  process.exit(1);
}

const HOOK_URL = `${OPENCLAW_URL.replace(/\/$/, "")}${HOOKS_PATH}`;

console.log(
  `[bridge] arranque MQTT_URL=${MQTT_URL} HOOK_URL=${HOOK_URL} BRIDGE_NAME=${BRIDGE_NAME} THROTTLE_MS=${THROTTLE_MS}`,
);

// ---------------------------------------------------------------------------
// Schemas defensivos (zod)
// ---------------------------------------------------------------------------

const AlertPayloadSchema = z.object({
  name: z.string().min(1),
  ts: z.number().int().nonnegative(),
  severity: z.enum(["info", "warn", "critical"]),
  device: z.string().optional(),
  detail: z.record(z.unknown()).optional(),
});

const HealthPayloadSchema = z.object({
  state: z.enum(["ok", "degraded", "offline", "blind"]),
  ts: z.number().int().nonnegative(),
  devices: z.record(z.enum(["ok", "silence", "frozen", "impossible", "offline"])).optional(),
});

// ---------------------------------------------------------------------------
// Estado de throttle (en memoria)
// ---------------------------------------------------------------------------

let throttleState: Map<string, number> = new Map();

// Para health: recordar último state por módulo y loggear solo transiciones
const lastHealthState: Map<string, string> = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAlertTopic(topic: string): { tenant: string; module: string } | null {
  // terra/{tenant}/{module}/alert  (4 segmentos)
  const parts = topic.split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "terra" || parts[3] !== "alert") return null;
  const tenant = parts[1];
  const mod = parts[2];
  if (!tenant || !mod) return null;
  return { tenant, module: mod };
}

function parseHealthTopic(topic: string): { tenant: string; module: string } | null {
  const parts = topic.split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "terra" || parts[3] !== "health") return null;
  const tenant = parts[1];
  const mod = parts[2];
  if (!tenant || !mod) return null;
  return { tenant, module: mod };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// ---------------------------------------------------------------------------
// Lookup módulo → cultivo (DB, cache 60 s) — para enrutar al experto (ADR-0019)
// ---------------------------------------------------------------------------

const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL }) : null;
const cropCache: Map<string, { crop: string | null; at: number }> = new Map();
const CROP_CACHE_TTL_MS = 60_000;

async function cropForModule(tenant: string, module: string): Promise<string | null> {
  if (!pool) return null;
  const key = `${tenant}/${module}`;
  const cached = cropCache.get(key);
  if (cached && Date.now() - cached.at < CROP_CACHE_TTL_MS) return cached.crop;
  try {
    const res = await pool.query("SELECT crop FROM modules WHERE tenant = $1 AND id = $2", [tenant, module]);
    const crop = (res.rows[0] as { crop?: string } | undefined)?.crop ?? null;
    cropCache.set(key, { crop, at: Date.now() });
    return crop;
  } catch (err) {
    console.error(`[bridge] crop lookup falló para ${key}: ${err instanceof Error ? err.message : err}`);
    return null; // honesto: sin dato de cultivo → orquestador
  }
}

// ---------------------------------------------------------------------------
// Hook de OpenClaw — con agentId (routing multi-agente)
// ---------------------------------------------------------------------------

async function postToHook(message: string, agentId?: string): Promise<boolean> {
  const body = JSON.stringify({ message, name: BRIDGE_NAME, ...(agentId ? { agentId } : {}) });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENCLAW_HOOK_TOKEN}`,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(HOOK_URL, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[bridge] hook POST falló intento ${attempt} (agent=${agentId ?? "default"}): ${res.status} ${text.slice(0, 500)}`);
        if (attempt < 2) {
          await delay(500);
          continue;
        }
        return false;
      }
      console.log(`[bridge] hook OK (${res.status}, agent=${agentId ?? "default"}) — ${message.slice(0, 120)}`);
      return true;
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge] hook error intento ${attempt}: ${msg}`);
      if (attempt < 2) {
        await delay(500);
        continue;
      }
      return false;
    }
  }
  return false;
}

/** Enruta al experto de la especie con respaldo al orquestador (ADR-0019). */
async function postAlertRouted(message: string, tenant: string, module: string): Promise<void> {
  const crop = await cropForModule(tenant, module);
  const targets = targetAgents(crop);
  for (const agentId of targets) {
    const ok = await postToHook(message, agentId);
    if (ok) return;
    if (agentId !== "main") {
      console.warn(`[bridge] agente ${agentId} no aceptó la alerta — cayendo al orquestador`);
    }
  }
}

// ---------------------------------------------------------------------------
// MQTT client
// ---------------------------------------------------------------------------

const clientId = `terra-bridge-${process.pid}-${Date.now()}`;
const client = mqtt.connect(MQTT_URL, {
  clientId,
  clean: true,
  reconnectPeriod: 5000,
  connectTimeout: 10000,
});

client.on("connect", () => {
  console.log(`[bridge] conectado MQTT clientId=${clientId}`);
  client.subscribe("terra/+/+/alert", { qos: 1 }, (err) => {
    if (err) console.error("[bridge] subscribe alert error", err);
    else console.log("[bridge] suscrito terra/+/+/alert");
  });
  client.subscribe("terra/+/+/health", { qos: 1 }, (err) => {
    if (err) console.error("[bridge] subscribe health error", err);
    else console.log("[bridge] suscrito terra/+/+/health");
  });
});

client.on("reconnect", () => {
  console.log("[bridge] reconectando...");
});

client.on("error", (err) => {
  console.error("[bridge] mqtt error", err);
});

client.on("offline", () => {
  console.log("[bridge] mqtt offline");
});

client.on("close", () => {
  console.log("[bridge] mqtt cerrado");
});

client.on("message", (topic: string, payload: Buffer) => {
  // No await aquí — manejamos async sin bloquear el loop, errores nunca hacen throw
  void handleMessage(topic, payload);
});

async function handleMessage(topic: string, payload: Buffer): Promise<void> {
  const raw = payload.toString("utf-8");

  // Intentar parsear tópico
  const alertCtx = parseAlertTopic(topic);
  if (alertCtx) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[bridge] alerta JSON inválido en ${topic}: ${raw.slice(0, 300)}`);
      return;
    }
    const res = AlertPayloadSchema.safeParse(parsed);
    if (!res.success) {
      console.warn(`[bridge] alerta schema inválido en ${topic}: ${res.error.message} — ${raw.slice(0, 300)}`);
      return;
    }
    const alert: Alert = {
      tenant: alertCtx.tenant,
      module: alertCtx.module,
      name: res.data.name,
      ts: res.data.ts,
      severity: res.data.severity,
      device: res.data.device,
      detail: res.data.detail as Record<string, unknown> | undefined,
    };

    const nowMs = Date.now();
    const decision = shouldForward(alert, throttleState, nowMs, THROTTLE_MS);
    throttleState = decision.newState;

    if (!decision.forward) {
      console.log(`[bridge] filtrada ${alertCtx.tenant}/${alertCtx.module} ${alert.name} severity=${alert.severity}`);
      return;
    }

    const message = formatHookMessage(alert);
    console.log(`[bridge] reenviando alerta → hook: ${message}`);
    try {
      await postAlertRouted(message, alertCtx.tenant, alertCtx.module);
    } catch (err) {
      // Nunca throw — solo log
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[bridge] postAlertRouted throw inesperado: ${m}`);
    }
    return;
  }

  const healthCtx = parseHealthTopic(topic);
  if (healthCtx) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[bridge] health JSON inválido en ${topic}: ${raw.slice(0, 300)}`);
      return;
    }
    const res = HealthPayloadSchema.safeParse(parsed);
    if (!res.success) {
      console.warn(`[bridge] health schema inválido en ${topic}: ${res.error.message} — ${raw.slice(0, 300)}`);
      return;
    }
    const key = `${healthCtx.tenant}/${healthCtx.module}`;
    const prev = lastHealthState.get(key);
    const cur = res.data.state;
    if (prev !== cur) {
      console.log(`[bridge] health transición ${key}: ${prev ?? "(nuevo)"} → ${cur} devices=${JSON.stringify(res.data.devices ?? {})}`);
      lastHealthState.set(key, cur);
    }
    // No reenvía — el alerta module_blind ya cubre el wake
    return;
  }

  console.warn(`[bridge] tópico no reconocido: ${topic}`);
}

// ---------------------------------------------------------------------------
// HTTP listener — receptor de reportes de expertos (ADR-0019) y eventos del
// portero (Fase 3). Ambos reenvían al hook del ORQUESTADOR (única voz al humano —
// ADR-0019, agentId main). Auth: mismo OPENCLAW_HOOK_TOKEN como query param
// (solo red interna terra).
//
// POST /expert-report?token=...  → reenvío con 502 si hook falla (humano/experto).
// POST /policy-event?token=...   → body {kind,tenant,module,message}
//   Validación: kind desconocido o message vacío → 400 {error}; token malo → 401.
//   Reenvío fire-and-forget: SIEMPRE 202 {forwarded:true|false} aunque el hook
//   falle tras retry (el portero no debe bloquearse; log + forwarded:false).
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const isExpert = url.pathname === "/expert-report";
  const isPolicy = url.pathname === "/policy-event";
  if (req.method !== "POST" || (!isExpert && !isPolicy)) {
    res.writeHead(404).end("not found");
    return;
  }
  if (url.searchParams.get("token") !== OPENCLAW_HOOK_TOKEN) {
    res.writeHead(401).end("bad token");
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > 65_536) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    void (async () => {
      if (isPolicy) {
        let body: unknown;
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "JSON inválido" }),
          );
          return;
        }
        const parsed = parsePolicyEventBody(body);
        if (!parsed.ok) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: parsed.error }),
          );
          return;
        }
        const event = parsed.event;
        if (!shouldForwardPolicyEvent(event)) {
          res.writeHead(202, { "Content-Type": "application/json" }).end(
            JSON.stringify({ forwarded: false }),
          );
          return;
        }
        const hookMessage = formatPolicyEvent(event);
        console.log(`[bridge] policy-event ${event.kind} ${event.tenant}/${event.module} → hook`);
        const ok = await postToHook(hookMessage, "main");
        if (!ok) {
          console.error("[bridge] policy-event hook falló tras retry — aceptado igual (forwarded:false)");
        }
        res.writeHead(202, { "Content-Type": "application/json" }).end(
          JSON.stringify({ forwarded: ok }),
        );
        return;
      }
      // --- /expert-report (comportamiento existente) ---
      let payload: unknown = Buffer.concat(chunks).toString("utf-8");
      try {
        payload = JSON.parse(payload as string);
      } catch {
        // texto plano también es válido
      }
      const text = extractExpertReport(payload);
      if (!text) {
        res.writeHead(204).end(); // NO_REPLY o vacío: silencio explícito
        return;
      }
      const ok = await postToHook(`[reporte de experto]\n${text}`, "main");
      res.writeHead(ok ? 202 : 502).end();
    })();
  });
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(400).end();
  });
});

httpServer.listen(BRIDGE_HTTP_PORT, () => {
  console.log(`[bridge] HTTP escuchando en :${BRIDGE_HTTP_PORT} (/expert-report, /policy-event)`);
});

// ---------------------------------------------------------------------------
// Shutdown limpio
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bridge] ${signal} — cerrando...`);
  try {
    httpServer.close();
    if (pool) await pool.end();
    const { promise, resolve } = Promise.withResolvers<void>();
    client.end(false, {}, () => resolve());
    await promise;
    console.log("[bridge] mqtt cerrado limpio");
  } catch (err) {
    console.error("[bridge] error al cerrar", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("[bridge] unhandledRejection", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[bridge] uncaughtException", err);
  void shutdown("uncaughtException");
});
