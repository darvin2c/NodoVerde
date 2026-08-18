#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { pool } from "./db.js";
import { startConsumer } from "./consumer.js";

const FINANCE_PORT = parseInt(process.env.FINANCE_PORT ?? "7761", 10);

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown | undefined> {
  if (req.method === "GET" || req.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

async function main(): Promise<void> {
  // Consumer MQTT (no bloqueante; si MQTT no disponible log y sigue)
  try {
    startConsumer();
  } catch (err) {
    console.error("[terra-finance] consumer start failed", err);
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok", service: "terra-finance" });
      return;
    }
    if (url.pathname === "/mcp") {
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await mcpServer.connect(transport);
        const body = await readBody(req);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        console.error("[terra-finance] error handleRequest", err);
        if (!res.headersSent) json(res, 500, { error: "internal", message: String(err) });
      } finally {
        res.on("close", () => {
          void transport.close?.();
          void mcpServer.close();
        });
      }
      return;
    }
    json(res, 404, { error: "not_found" });
  });

  httpServer.listen(FINANCE_PORT, () => {
    console.log(`[terra-finance] escuchando :${FINANCE_PORT} (POST /mcp, GET /healthz)`);
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[terra-finance] ${signal} — cerrando`);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await pool.end();
    console.log("[terra-finance] cerrado");
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => console.error("[terra-finance] unhandledRejection", reason));
  process.on("uncaughtException", (err) => { console.error("[terra-finance] uncaughtException", err); void shutdown("uncaughtException"); });
}

await main();
