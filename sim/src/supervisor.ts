#!/usr/bin/env node
// Supervisor del mundo simulado (ADR-0017): levanta el motor de física + un proceso
// emulador por nodo, y expone el control del laboratorio (add/remove nodo).
// Uso: pnpm dev [--speed N] [--seed N] [--offline] [--scenario NAME] [--start ISO]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { loadFinca } from "./config.js";
import { nextHwId, } from "./lab.js";
import { ensureWorld, claimNode, unclaimNode, waitMcp } from "./provision.js";

const args = process.argv.slice(2);
const port = parseInt(process.env.SUPERVISOR_PORT ?? "7750", 10);
const physicsPort = process.env.PHYSICS_PORT ?? "7751";
const physicsUrl = `http://127.0.0.1:${physicsPort}`;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";
const here = dirname(fileURLToPath(import.meta.url));

const finca = loadFinca();
const tenant = finca.tenant ?? "demo";
const pool = new pg.Pool({ connectionString: databaseUrl });

type Child = ReturnType<typeof spawn>;
const children = new Map<string, Child>(); // "physics" | hw_id → proceso

function spawnChild(label: string, script: string, extraArgs: string[]): Child {
  // Un solo proceso por hijo (node + tsx loader, sin cadena pnpm→tsx→node) y SIN
  // detached: mismo grupo que el supervisor → Ctrl-C y kills de árbol (hub/systemd)
  // alcanzan a todo el mundo; no quedan emuladores huérfanos republicando.
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args.filter((a) => a !== "--no-spawn"), ...extraArgs], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PHYSICS_PORT: physicsPort, PHYSICS_URL: physicsUrl },
    cwd: resolve(here, ".."),
  });
  child.on("exit", (code, signal) => {
    console.log(`[supervisor] ${label} salió (code=${code} signal=${signal})`);
    if (children.get(label) === child) children.delete(label);
    if (label === "physics") {
      console.error("[supervisor] la física murió — el mundo se detiene; reinicia el supervisor");
    }
  });
  children.set(label, child);
  console.log(`[supervisor] ${label} levantado (pid=${child.pid})`);
  return child;
}

// Guardia anti-huérfanos: si el supervisor muere por crash/salida limpia sin
// completar shutdown(), mata a los hijos restantes (mismo proceso, kill directo).
// Nota: SIGKILL al supervisor no ejecuta handlers — ese caso lo cubre el kill de
// árbol del process manager (hijos en el mismo grupo).
process.on("exit", () => {
  for (const child of children.values()) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitPhysics(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${physicsUrl}/api/nodes`);
      if (res.ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error("physics no respondió a tiempo");
}

async function spawnNode(hwId: string): Promise<void> {
  if (children.has(hwId)) return;
  spawnChild(hwId, "src/node/emulator.ts", ["--hw", hwId]);
}

// --- claiming: el acto del dueño (stand-in del chat hasta Fase 2) ---
// ADR-0025: claiming solo amarra fierro ↔ mesa. El cultivo JAMÁS se escribe aquí:
// es caché del ciclo del lote (lo pone open_batch vía MCP, lo limpia close_batch).
// Claiming/unclaiming (ADR-0028): el supervisor NO escribe SQL — toda la
// escritura pasa por las APIs gobernadas (mcp-domain) vía provision.ts.
// La DB solo se lee (syncCropsFromBatches, y las consultas read-only de provision).

// --- sync de cultivos desde lotes (ADR-0025): la única vía del cultivo al mundo ---
// Abrir lote (MCP) → plantas en la mesa; cerrar lote → cosecha, mesa libre.
// El mundo físico no adivina: el supervisor lee la verdad (lotes abiertos) y se
// la empuja al motor. Poll de 5s: la biología no cambia más rápido que eso.
async function syncCropsFromBatches(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT d.hw_id, l.crop
     FROM device_identities d
     LEFT JOIN LATERAL (
       SELECT lo.crop FROM lotes lo
       WHERE lo.tenant = d.tenant AND lo.state = 'open' AND lo.modules ? d.module
         AND lo.started_at <= now()  -- ADR-0026: lote programado (inicio futuro) aún no siembra plantas
       ORDER BY lo.started_at DESC LIMIT 1
     ) l ON true
     WHERE d.tenant = $1`,
    [tenant],
  );
  const world = (await (await fetch(`${physicsUrl}/api/nodes`)).json()) as { nodes: { hw_id: string; crop: string | null }[] };
  const current = new Map(world.nodes.map((n) => [n.hw_id, n.crop]));
  // targets desde crop_profiles (DB) — el perfil se ingresa en la PWA, no en yaml
  const desiredCrops = [...new Set((rows as { crop: string | null }[]).map((r) => r.crop).filter((c): c is string => !!c))];
  const targets = new Map<string, { ec: [number, number]; ph: [number, number] }>();
  for (const c of desiredCrops) {
    const { rows: pr } = await pool.query(
      "SELECT ec_min, ec_max, ph_min, ph_max FROM crop_profiles WHERE name = $1", [c]);
    const p = pr[0] as { ec_min: number; ec_max: number; ph_min: number; ph_max: number } | undefined;
    if (p) targets.set(c, { ec: [Number(p.ec_min), Number(p.ec_max)], ph: [Number(p.ph_min), Number(p.ph_max)] });
  }
  for (const row of rows as { hw_id: string; crop: string | null }[]) {
    const desired = row.crop ?? null;
    if (current.get(row.hw_id) !== desired) {
      const res = await fetch(`${physicsUrl}/api/nodes/${row.hw_id}/crop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ crop: desired, targets: desired ? targets.get(desired) ?? null : null }),
      }).catch((e) => { console.error(`[supervisor] sync crop ${row.hw_id} falló:`, e); return null; });
      if (res && !res.ok) {
        console.error(`[supervisor] sync crop ${row.hw_id} rechazado:`, await res.text());
      }
    }
  }
}

// --- control HTTP ---
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (cb: (b: Record<string, string>) => void) => {
    let body = "";
    req!.on("data", (c) => (body += c));
    req!.on("end", () => {
      try {
        cb(JSON.parse(body || "{}"));
      } catch {
        send(400, { error: "JSON inválido" });
      }
    });
  };

  if (req.method === "GET" && url.pathname === "/ctl/status") {
    return send(200, {
      nodes: [...children.keys()].filter((k) => k !== "physics"),
      physics: children.has("physics"),
    });
  }
  if (req.method === "POST" && url.pathname === "/ctl/add-node") {
    return readBody(async (b) => {
      try {
        const world = (await (await fetch(`${physicsUrl}/api/nodes`)).json()) as { nodes: { hw_id: string }[] };
        const hwId = b.hw_id ?? nextHwId(world.nodes.map((n) => n.hw_id));
        if (children.has(hwId) || world.nodes.some((n) => n.hw_id === hwId)) {
          return send(409, { error: `nodo ya existe: ${hwId}` });
        }
        // ADR-0025: add-node crea mesa LIBRE (sin cultivo) — el lote la ocupa luego
        const addRes = await fetch(`${physicsUrl}/api/nodes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hw_id: hwId }),
        });
        if (!addRes.ok) return send(addRes.status, await addRes.json());
        const claimed = await claimNode(pool, tenant, hwId, "ctl");
        await spawnNode(hwId);
        send(201, { hw_id: hwId, ...claimed, crop: null });
      } catch (e) {
        send(400, { error: String(e) });
      }
    });
  }
  if (req.method === "POST" && url.pathname === "/ctl/scenario") {
    // cambio de escenario en caliente: passthrough al motor de física
    return readBody(async (b) => {
      if (!b.name) return send(400, { error: "name requerido" });
      const res = await fetch(`${physicsUrl}/api/scenario`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: b.name }),
      });
      send(res.status, await res.json());
    });
  }
  if (req.method === "POST" && url.pathname === "/ctl/remove-node") {
    return readBody(async (b) => {
      try {
        const hwId = b.hw_id;
        if (!hwId) return send(400, { error: "hw_id requerido" });
        const child = children.get(hwId);
        if (child) {
          children.delete(hwId);
          // desenchufar = muerte súbita del proceso único del nodo: ejercita LWT real
          child.kill("SIGKILL");
        }
        await fetch(`${physicsUrl}/api/nodes/${hwId}`, { method: "DELETE" });
        if (b.unclaim) await unclaimNode(hwId);
        send(200, { ok: true, hw_id: hwId, unclaimed: !!b.unclaim });
      } catch (e) {
        send(400, { error: String(e) });
      }
    });
  }
  send(404, { error: "ruta desconocida" });
});

// --- arranque ---
// Aprovisionamiento (ADR-0028): el mundo entra por APIs gobernadas (MCP), no
// por SQL. La identidad de la finca (ADR-0016) la escribe create_tenant — la tz
// la deriva el servidor de lat/lon (tz-lookup, ADR-0023); el yaml ya no la provisiona.
console.log(`[supervisor] mundo: ${finca.modules.length} nodos, tenant=${tenant}`);
spawnChild("physics", "src/physics/engine.ts", []);
await waitPhysics();
// el stack compose puede ir más lento que el sim en host — esperar a ambos MCP
await waitMcp();
await waitMcp(process.env.FINANCE_URL ?? "http://localhost:7761");
await ensureWorld(finca, pool);
for (const m of finca.modules) await spawnNode(m.hw_id);
// sync inicial de cultivos desde lotes abiertos + poll cada 5s (ADR-0025)
await syncCropsFromBatches().catch((e) => console.error("[supervisor] sync crop inicial falló:", e));
const cropSync = setInterval(() => {
  syncCropsFromBatches().catch((e) => console.error("[supervisor] sync crop falló:", e));
}, 5000);
server.listen(port, "127.0.0.1", () => console.log(`[supervisor] ctl http://127.0.0.1:${port}/ctl/status`));

async function shutdown(signal: string) {
  console.log(`[supervisor] ${signal} — apagando mundo`);
  server.close();
  for (const [label, child] of children) {
    console.log(`[supervisor] SIGINT → ${label}`);
    child.kill("SIGINT");
  }
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
