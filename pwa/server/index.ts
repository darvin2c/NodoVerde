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
  res.setHeader("Access-Control-Allow-Headers", "content-type, trpc-accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // tRPC handler
  if ((req.url ?? "").startsWith("/trpc")) {
    (handler as unknown as (req: http.IncomingMessage, res: http.ServerResponse) => void)(req, res);
    return;
  }
  // Resto: frontend estático (producción)
  if (!serveStatic(req, res)) { res.writeHead(404).end(); }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[pwa-server] tRPC en http://localhost:${PORT}/trpc  (DB ${DATABASE_URL.replace(/:[^@]+@/, ":***@")}, MQTT ${MQTT_URL})`);
});

process.on("SIGTERM", () => { mqttBus.stop(); server.close(); });
process.on("SIGINT", () => { mqttBus.stop(); server.close(); process.exit(0); });
