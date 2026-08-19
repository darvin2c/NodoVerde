#!/usr/bin/env node
// Bootstrap HTTP + MCP Streamable HTTP transport
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { pool } from "./db.js";
import { writePool } from "./write.js";

const MCP_DOMAIN_PORT = parseInt(process.env.MCP_DOMAIN_PORT ?? "7760", 10);

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
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  // Stateless (sessionIdGenerator: undefined): un McpServer+transport POR REQUEST.
  // Un singleton acumula estado de initialize y el segundo cliente recibe 500
  // (verificado en smoke: OpenClaw y un curl concurrente tumban al otro).

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // Healthz
    if (url.pathname === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok", service: "mcp-domain" });
      return;
    }
    // MCP endpoint
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
        console.error("[mcp-domain] error handleRequest", err);
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

  httpServer.listen(MCP_DOMAIN_PORT, () => {
    console.log(`[mcp-domain] escuchando :${MCP_DOMAIN_PORT} (POST /mcp, GET /healthz)`);
  });

  // Shutdown limpio
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[mcp-domain] ${signal} — cerrando`);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await pool.end();
    await writePool.end();
    console.log("[mcp-domain] cerrado");
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    console.error("[mcp-domain] unhandledRejection", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[mcp-domain] uncaughtException", err);
    void shutdown("uncaughtException");
  });
}

await main();
