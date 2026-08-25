#!/usr/bin/env node
// sync-experts.mjs — provisiona los expertos de especie desde crop_profiles (ADR-0028).
// El cerebro es AGNÓSTICO al cultivo: crear un perfil "fresa" en la PWA y re-correr
// este script genera experto-fresa (workspace + agent en openclaw.json + cron).
//
//   node brain/sync-experts.mjs
//
// Requiere: stack arriba (mcp-domain :7760; openclaw para config/cron), .env con
// OPENCLAW_HOOK_TOKEN (solo para crons). Idempotente: workspaces gestionados se
// reescriben; MEMORY.md jamás se pisa; openclaw.json solo se toca si cambia (con .bak).
// Sin deps (Node ≥20, fetch nativo).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN = join(ROOT, "brain");
const TEMPLATE_DIR = join(BRAIN, "workspaces", "_template-experto");
const WORKSPACES = join(BRAIN, "workspaces");
const CONFIG_PATH = join(BRAIN, "openclaw.json");
const MCP_DOMAIN_URL = (process.env.MCP_DOMAIN_URL ?? "http://localhost:7760").replace(/\/$/, "");
const HEALTHZ_URL = process.env.OPENCLAW_HEALTHZ_URL ?? "http://localhost:18789/healthz";

const log = (msg) => console.log(`[sync-experts] ${msg}`);
const warn = (msg) => console.warn(`[sync-experts] AVISO: ${msg}`);

// --- .env (patrón automations.sh) -------------------------------------------
function envFromFile(key) {
  if (process.env[key]) return process.env[key];
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return "";
  const line = readFileSync(envPath, "utf-8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

// --- MCP (mismo patrón HTTP que automations.sh: sin auth, JSON-RPC tools/call) ---
async function mcpCall(tool, args = {}) {
  const res = await fetch(`${MCP_DOMAIN_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (!res.ok) throw new Error(`MCP ${tool} HTTP ${res.status}`);
  const text = await res.text();
  // streamable-http puede responder SSE (líneas "data: {...}") o JSON plano
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const raw = dataLine ? dataLine.slice(5).trim() : text;
  const msg = JSON.parse(raw);
  if (msg.error) throw new Error(`MCP ${tool}: ${JSON.stringify(msg.error)}`);
  return msg.result?.structuredContent ?? {};
}

// --- especies desde perfiles (convención ADR-0019: especie = name.split("_")[0]) ---
async function listSpecies() {
  const { profiles } = await mcpCall("list_crop_profiles");
  if (!Array.isArray(profiles)) throw new Error("list_crop_profiles sin profiles[]");
  const species = [...new Set(profiles.map((p) => String(p.name).split("_")[0]))].sort();
  return species;
}

// --- timezone de la finca (fallback UTC con aviso, patrón automations.sh) ----
async function farmTz() {
  try {
    const sc = await mcpCall("get_farm_context");
    // get_farm_context: structuredContent.location.tz (ADR-0010, null honesto si ausente)
    const loc = sc.location;
    const tz = loc && typeof loc === "object" ? loc.tz : null;
    if (typeof tz === "string" && tz) return tz;
  } catch (e) {
    warn(`get_farm_context falló (${e.message})`);
  }
  warn("no pude leer la timezone de la finca vía MCP — usando UTC");
  return "UTC";
}

// --- workspaces desde template ------------------------------------------------
// Gestionados (se reescriben): SOUL.md, IDENTITY.md, TOOLS.md, skills/.
// MEMORY.md: solo se CREA si no existe — es memoria experiencial, jamás se pisa
// (la lee mcp-domain para memory_hash de lotes vía mount /workspaces:ro).
function renderWorkspace(species) {
  const dest = join(WORKSPACES, `experto-${species}`);
  mkdirSync(dest, { recursive: true });
  for (const f of ["SOUL.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md"]) {
    const content = readFileSync(join(TEMPLATE_DIR, f), "utf-8").replaceAll("{{ESPECIE}}", species);
    const target = join(dest, f);
    if (f === "MEMORY.md" && existsSync(target)) continue; // nunca se pisa
    writeFileSync(target, content);
  }
  const skillSrc = join(TEMPLATE_DIR, "skills", "cultivo-{{ESPECIE}}");
  const skillDest = join(dest, "skills", `cultivo-${species}`);
  mkdirSync(skillDest, { recursive: true });
  for (const f of readdirSync(skillSrc)) {
    writeFileSync(join(skillDest, f), readFileSync(join(skillSrc, f), "utf-8").replaceAll("{{ESPECIE}}", species));
  }
  log(`workspace experto-${species} renderizado`);
}

// --- openclaw.json (parse → mutar → .bak → escribir) ---------------------------
const TOOLS_DENY = ["message", "exec", "process", "browser", "gateway", "sessions_spawn", "apply_patch"];

function patchConfig(species) {
  if (!existsSync(CONFIG_PATH)) {
    warn("brain/openclaw.json no existe (¿corriste brain/setup.sh?) — workspaces generados, config NO tocada");
    return false;
  }
  const before = readFileSync(CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(before);
  const expertIds = species.map((s) => `experto-${s}`);

  cfg.agents ??= {};
  cfg.agents.list = (cfg.agents.list ?? []).filter((a) => a && !String(a.id ?? "").startsWith("experto-"));
  for (const s of species) {
    cfg.agents.list.push({
      id: `experto-${s}`,
      name: `Experto ${s.charAt(0).toUpperCase()}${s.slice(1)}`,
      workspace: `/home/node/.openclaw/workspaces/experto-${s}`,
      skills: [`cultivo-${s}`],
      tools: { deny: TOOLS_DENY },
    });
  }
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.subagents ??= {};
  cfg.agents.defaults.subagents.allowAgents = expertIds;
  cfg.hooks ??= {};
  cfg.hooks.allowedAgentIds = ["main", ...expertIds];

  const after = JSON.stringify(cfg, null, 2) + "\n";
  if (after === before) return false;
  copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  writeFileSync(CONFIG_PATH, after);
  log(`openclaw.json actualizado (${expertIds.length} expertos: ${expertIds.join(", ") || "ninguno"}) — .bak guardado`);
  return true;
}

// --- openclaw CLI dentro del contenedor ----------------------------------------
const OC = ["compose", "exec", "-T", "openclaw", "node", "openclaw.mjs"];

function ocCli(args) {
  const r = spawnSync("docker", [...OC, ...args], { cwd: ROOT, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`openclaw ${args[0]} falló: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function cronExists(name) {
  try {
    const out = ocCli(["cron", "list", "--json"]);
    if (out.includes(`"name"`) && out.includes(`"${name}"`)) return true;
  } catch {
    // fallback sin --json
  }
  try {
    return ocCli(["cron", "list"]).includes(name);
  } catch {
    return false;
  }
}

// minuto determinístico por especie (hash simple % 60) — crons repartidos
function speciesMinute(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return h % 60;
}

const PROMPT = (s) =>
  `Revisión programada de tus módulos. Lista los módulos con list_modules, quédate con los de crop '${s}' o variedades '${s}_*'. Para cada uno: latest_readings, module_confidence y recent_alerts (24 h), y compara contra los rangos de get_crop_profile del perfil exacto del módulo. Si todo está en rango y con confianza suficiente, responde exactamente NO_REPLY. Si hay anomalía, desvío sostenido, baja confianza o falta dato: redacta un reporte breve para el orquestador — módulo, variable, valor, rango del perfil, confianza y frescura del dato, acción sugerida. No actúas ni hablas con el humano.`;

function ensureCrons(species, tz, hookToken) {
  if (!hookToken) {
    warn("falta OPENCLAW_HOOK_TOKEN (.env o entorno) — crons NO creados");
    return;
  }
  const webhook = `http://bridge:7765/expert-report?token=${hookToken}`;
  for (const s of species) {
    const name = `revision-${s}`;
    if (cronExists(name)) {
      log(`= ${name} (ya existe)`);
      continue;
    }
    ocCli([
      "cron", "add", `${speciesMinute(s)} */6 * * *`, PROMPT(s),
      "--name", name, "--agent", `experto-${s}`, "--session", "isolated",
      "--tz", tz, "--webhook", webhook,
    ]);
    log(`+ ${name} creada (agent=experto-${s}, min=${speciesMinute(s)} */6h ${tz})`);
  }
}

// --- restart + healthz cuando la config cambió ---------------------------------
function restartOpenclaw() {
  const r = spawnSync("docker", ["compose", "restart", "openclaw"], { cwd: ROOT, encoding: "utf-8" });
  if (r.status !== 0) {
    warn(`docker compose restart openclaw falló: ${r.stderr || r.stdout} — reinicia a mano`);
    return;
  }
  log("openclaw reiniciado — esperando healthz…");
}

async function waitHealthz(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTHZ_URL);
      if (res.ok) {
        log("openclaw sano (healthz OK)");
        return;
      }
    } catch {
      // aún no responde
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  warn(`healthz no respondió en ${timeoutMs}ms — verifica con: docker compose logs openclaw`);
}

// --- main ----------------------------------------------------------------------
const species = await listSpecies();
log(`especies con perfil: ${species.join(", ") || "(ninguna)"}`);

if (!existsSync(TEMPLATE_DIR)) throw new Error(`template no encontrado: ${TEMPLATE_DIR}`);
for (const s of species) renderWorkspace(s);

const changed = patchConfig(species);
if (changed) {
  restartOpenclaw();
  await waitHealthz();
}

if (species.length > 0) {
  const tz = await farmTz();
  ensureCrons(species, tz, envFromFile("OPENCLAW_HOOK_TOKEN"));
}
log("listo");
