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
import { nextHwId, nextModuleId } from "./lab.js";

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
  const child = spawn("pnpm", ["exec", "tsx", script, ...args.filter((a) => a !== "--no-spawn"), ...extraArgs], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PHYSICS_PORT: physicsPort, PHYSICS_URL: physicsUrl },
    cwd: resolve(here, ".."),
    detached: true, // grupo de proceso propio: kill(-pid) mata pnpm+tsx+node completos
  });
  child.on("exit", (code, signal) => {
    console.log(`[supervisor] ${label} salió (code=${code} signal=${signal})`);
    if (label === "physics") {
      console.error("[supervisor] la física murió — el mundo se detiene; reinicia el supervisor");
    }
  });
  children.set(label, child);
  console.log(`[supervisor] ${label} levantado (pid=${child.pid})`);
  return child;
}

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
async function claim(hwId: string, crop: string): Promise<{ tenant: string; module: string }> {
  // módulo libre = existe como config de cultivo pero NINGÚN hardware lo ocupa;
  // se toma el de menor número (rellena huecos); si no hay, se crea el siguiente
  const { rows: free } = await pool.query(
    `SELECT m.id FROM modules m
      WHERE m.tenant = $1
        AND NOT EXISTS (SELECT 1 FROM device_identities d WHERE d.tenant = m.tenant AND d.module = m.id)
      ORDER BY m.id LIMIT 1`,
    [tenant],
  );
  let moduleId: string;
  if (free.length) {
    moduleId = free[0].id;
    await pool.query("UPDATE modules SET crop = $3 WHERE tenant = $1 AND id = $2", [tenant, moduleId, crop]);
  } else {
    const { rows } = await pool.query(
      `SELECT id FROM (SELECT id FROM modules WHERE tenant = $1
                       UNION SELECT module AS id FROM device_identities WHERE tenant = $1) t`,
      [tenant],
    );
    const nums = rows.map((r: { id: string }) => parseInt(r.id.replace("mod-", ""), 10)).filter((n: number) => !isNaN(n));
    moduleId = nextModuleId(nums);
    await pool.query("INSERT INTO modules (tenant, id, crop) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [tenant, moduleId, crop]);
  }
  await pool.query(
    "INSERT INTO device_identities (hw_id, tenant, module, claimed_by) VALUES ($1, $2, $3, 'ctl') ON CONFLICT (hw_id) DO UPDATE SET tenant = $2, module = $3, claimed_by = 'ctl'",
    [hwId, tenant, moduleId],
  );
  return { tenant, module: moduleId };
}

async function unclaim(hwId: string): Promise<void> {
  await pool.query("DELETE FROM device_identities WHERE hw_id = $1", [hwId]);
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
        const crop = b.crop ?? "lechuga";
        if (children.has(hwId) || world.nodes.some((n) => n.hw_id === hwId)) {
          return send(409, { error: `nodo ya existe: ${hwId}` });
        }
        const addRes = await fetch(`${physicsUrl}/api/nodes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hw_id: hwId, crop }),
        });
        if (!addRes.ok) return send(addRes.status, await addRes.json());
        const claimed = await claim(hwId, crop);
        await spawnNode(hwId);
        send(201, { hw_id: hwId, ...claimed, crop });
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
          // desenchufar = muerte súbita de TODO el grupo (pnpm→tsx→node): ejercita LWT real
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
        await fetch(`${physicsUrl}/api/nodes/${hwId}`, { method: "DELETE" });
        if (b.unclaim) await unclaim(hwId);
        send(200, { ok: true, hw_id: hwId, unclaimed: !!b.unclaim });
      } catch (e) {
        send(400, { error: String(e) });
      }
    });
  }
  send(404, { error: "ruta desconocida" });
});

// --- arranque ---
console.log(`[supervisor] mundo: ${finca.modules.length} nodos, tenant=${tenant}`);
spawnChild("physics", "src/physics/engine.ts", []);
await waitPhysics();
for (const m of finca.modules) await spawnNode(m.hw_id);
server.listen(port, "127.0.0.1", () => console.log(`[supervisor] ctl http://127.0.0.1:${port}/ctl/status`));

async function shutdown(signal: string) {
  console.log(`[supervisor] ${signal} — apagando mundo`);
  server.close();
  for (const [label, child] of children) {
    console.log(`[supervisor] SIGINT → ${label}`);
    try {
      process.kill(-child.pid!, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
  }
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
