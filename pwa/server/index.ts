import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { getDb } from "./db.js";
import { appRouter } from "./trpc.js";
import { mqttBus } from "./mqtt.js";

const PORT = Number(process.env.PWA_SERVER_PORT ?? 7780);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";

// Frontend compilado (vite build → dist/). En imagen docker: WORKDIR=/app, dist/ junto a dist-server/.
// En dev local (`pnpm dev`) el frontend lo sirve vite con proxy /trpc; esto es solo producción.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // dist-server/server
const CLIENT_DIR = process.env.PWA_CLIENT_DIR ?? path.resolve(HERE, "../../dist");

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!existsSync(CLIENT_DIR)) return false;
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = path.join(CLIENT_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403).end(); return true; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(CLIENT_DIR, "index.html"); // SPA fallback
  if (!existsSync(file)) return false;
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
  return true;
}

// Iniciar bus MQTT (no bloqueante)
mqttBus.start();

const handler = createHTTPHandler({
  router: appRouter,
  basePath: "/trpc/",
  createContext: () => ({ db: getDb() })
});

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, trpc-accept, x-tenant, x-kind, x-note");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Proxy de evidencia hacia services/finance (único dueño de MinIO/ledger, ADR-0027)
  if (req.url === "/api/evidence" && req.method === "POST") {
    void proxyEvidenceUpload(req, res);
    return;
  }
  const evFile = (req.url ?? "").match(/^\/api\/evidence\/([0-9a-fA-F-]{36})\/file$/);
  if (evFile && req.method === "GET") {
    void proxyEvidenceFile(res, evFile[1]);
    return;
  }

  // tRPC handler
  if ((req.url ?? "").startsWith("/trpc")) {
    (handler as unknown as (req: http.IncomingMessage, res: http.ServerResponse) => void)(req, res);
    return;
  }
  // Resto: frontend estático (producción)
  if (!serveStatic(req, res)) { res.writeHead(404).end(); }
});

const FINANCE_BASE = (process.env.MCP_FINANCE_URL ?? "http://localhost:7761/mcp").replace(/\/mcp$/, "");

// Sube bytes tal cual al finance (máx 15 MB allá); la PWA añade canal/autor.
async function proxyEvidenceUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const tenant = req.headers["x-tenant"];
  if (typeof tenant !== "string" || !tenant) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "x-tenant requerido" }));
    return;
  }
  const kind = typeof req.headers["x-kind"] === "string" ? req.headers["x-kind"] : "otro";
  const note = typeof req.headers["x-note"] === "string" ? (req.headers["x-note"] as string) : "";
  let upstream: Response;
  try {
    upstream = await fetch(`${FINANCE_BASE}/api/evidence`, {
      method: "POST",
      headers: {
        "content-type": req.headers["content-type"] ?? "application/octet-stream",
        "x-tenant": tenant,
        "x-uploaded-by": "pwa",
        "x-channel": "pwa",
        "x-kind": kind,
        ...(note ? { "x-note": note } : {})
      },
      body: req as never, // stream del request al upstream (Node fetch exige duplex half)
      ...({ duplex: "half" } as Record<string, unknown>)
    });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "finance inalcanzable", message: String(err) }));
    return;
  }
  const body = await upstream.text();
  res.writeHead(upstream.status, { "content-type": "application/json" }).end(body);
}

async function proxyEvidenceFile(res: http.ServerResponse, id: string): Promise<void> {
  try {
    const upstream = await fetch(`${FINANCE_BASE}/api/evidence/${id}/file`);
    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status).end();
      return;
    }
    res.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "private, max-age=3600"
    });
    const reader = (upstream.body as unknown as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
  }
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[pwa-server] tRPC en http://localhost:${PORT}/trpc  (DB ${DATABASE_URL.replace(/:[^@]+@/, ":***@")}, MQTT ${MQTT_URL})`);
});

process.on("SIGTERM", () => { mqttBus.stop(); server.close(); });
process.on("SIGINT", () => { mqttBus.stop(); server.close(); process.exit(0); });
