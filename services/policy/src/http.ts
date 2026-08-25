// src/http.ts — servidor HTTP (healthz + /mcp + /api/* con Bearer)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { listPending, getAction, decideAction, markExecuted, listWorkOrders, getWorkOrder, completeWorkOrder } from "./db.js";
import { approveAction as policyApprove } from "./policy.js";
import { POLICY_ADMIN_TOKEN } from "./config.js";
import { getConfidence, getHealth } from "./state.js";
import { checkConfidence, checkHealth } from "./rules.js";
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function bearerOk(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1] === POLICY_ADMIN_TOKEN;
}

export function createHttpServer(): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // healthz sin auth
    if (url.pathname === "/healthz" && req.method === "GET") {
      json(res, 200, { ok: true, service: "terra-policy" });
      return;
    }

    // MCP stateless
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
        console.error("[terra-policy] error handleRequest", err);
        if (!res.headersSent) json(res, 500, { error: "internal", message: String(err) });
      } finally {
        res.on("close", () => {
          void transport.close?.();
          void mcpServer.close();
        });
      }
      return;
    }

    // API protegida con Bearer
    if (url.pathname.startsWith("/api/")) {
      if (!bearerOk(req)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }

      // GET /api/approvals?tenant=
      if (url.pathname === "/api/approvals" && req.method === "GET") {
        const tenant = url.searchParams.get("tenant") ?? undefined;
        const actions = await listPending(tenant);
        json(res, 200, { actions });
        return;
      }

      // POST /api/approvals/{id}/approve {by}
      const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (approveMatch && req.method === "POST") {
        const id = decodeURIComponent(approveMatch[1]);
        const body = await readJsonBody(req);
        const by = (body.by as string | undefined) ?? (body.decided_by as string | undefined) ?? "";
        if (!by || typeof by !== "string") {
          json(res, 400, { error: "by requerido" });
          return;
        }
        const row = await getAction(id);
        if (!row) {
          json(res, 404, { error: "not_found" });
          return;
        }
        if (row.status !== "pending") {
          json(res, 409, { error: "conflict", status: row.status });
          return;
        }
        const result = await policyApprove(id, by);
        if (result.status === "not_found") {
          json(res, 404, { error: "not_found" });
          return;
        }
        if (result.status === "conflict") {
          json(res, 409, { error: "conflict", reason: result.reason });
          return;
        }
        if (result.status === "needs_data") {
          // queda pending, devolver 409 con needs para que PWA lo muestre
          json(res, 409, { error: "needs_data", needs: result.needs, action_id: result.action_id });
          return;
        }
        if (result.status === "rejected") {
          json(res, 409, { error: "rejected", reason: result.reason });
          return;
        }
        // executed
        const updated = await getAction(id);
        json(res, 200, updated);
        return;
      }

      // POST /api/approvals/{id}/reject {by,reason?}
      const rejectMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
      if (rejectMatch && req.method === "POST") {
        const id = decodeURIComponent(rejectMatch[1]);
        const body = await readJsonBody(req);
        const by = (body.by as string | undefined) ?? (body.decided_by as string | undefined) ?? "";
        const reason = (body.reason as string | undefined) ?? null;
        if (!by || typeof by !== "string") {
          json(res, 400, { error: "by requerido" });
          return;
        }
        const row = await getAction(id);
        if (!row) {
          json(res, 404, { error: "not_found" });
          return;
        }
        if (row.status !== "pending") {
          json(res, 409, { error: "conflict", status: row.status });
          return;
        }
        const updated = await decideAction(id, "rejected", by);
        if (!updated) {
          json(res, 409, { error: "conflict" });
          return;
        }
        json(res, 200, updated);
        return;
      }

      // GET /api/work-orders?tenant=&status=
      if (url.pathname === "/api/work-orders" && req.method === "GET") {
        const tenant = url.searchParams.get("tenant") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        const orders = await listWorkOrders(tenant, status);
        json(res, 200, { orders });
        return;
      }

      // POST /api/work-orders/{id}/complete {by,note?}
      const completeMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/complete$/);
      if (completeMatch && req.method === "POST") {
        const id = decodeURIComponent(completeMatch[1]);
        const body = await readJsonBody(req);
        const by = (body.by as string | undefined) ?? (body.done_by as string | undefined) ?? "";
        const note = (body.note as string | undefined) ?? null;
        if (!by || typeof by !== "string") {
          json(res, 400, { error: "by requerido" });
          return;
        }
        const existing = await getWorkOrder(id);
        if (!existing) {
          json(res, 404, { error: "not_found" });
          return;
        }
        if (existing.status !== "pending") {
          json(res, 409, { error: "conflict", status: existing.status });
          return;
        }
        const updated = await completeWorkOrder(id, by, note);
        if (!updated) {
          json(res, 409, { error: "conflict" });
          return;
        }
        json(res, 200, updated);
        return;
      }

      json(res, 404, { error: "not_found" });
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  return server;
}
