#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import mqtt from "mqtt";
import { createMcpServer } from "./server.js";
import { pool, insertEvidence, findEvidenceBySha, getEvidence, EVIDENCE_KINDS, type EvidenceKind } from "./db.js";
import { putEvidence, getEvidenceStream, sha256Of, objectKeyFor, MAX_EVIDENCE_BYTES } from "./evidence.js";
import { startConsumer } from "./consumer.js";
import { startLedgerInvariantChecker, type LedgerCheckerHandle } from "./ledgerInvariant.js";

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

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** POST /api/evidence — bytes crudos; metadata por headers. Cualquier mime (ADR-0027 §5). */
async function handleEvidenceUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenant = req.headers["x-tenant"];
  const uploadedBy = req.headers["x-uploaded-by"];
  if (typeof tenant !== "string" || !tenant) { json(res, 400, { error: "header x-tenant requerido" }); return; }
  if (typeof uploadedBy !== "string" || !uploadedBy) { json(res, 400, { error: "header x-uploaded-by requerido" }); return; }
  const kindRaw = req.headers["x-kind"];
  const kind: EvidenceKind = (typeof kindRaw === "string" && (EVIDENCE_KINDS as readonly string[]).includes(kindRaw))
    ? (kindRaw as EvidenceKind) : "otro";
  const channel = typeof req.headers["x-channel"] === "string" ? (req.headers["x-channel"] as string) : null;
  const note = typeof req.headers["x-note"] === "string" ? decodeURIComponent(req.headers["x-note"] as string) : undefined;
  const mimeType = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();

  const buf = await readRawBody(req, MAX_EVIDENCE_BYTES);
  if (buf === null) { json(res, 413, { error: `archivo excede ${MAX_EVIDENCE_BYTES} bytes` }); return; }
  if (buf.length === 0) { json(res, 400, { error: "cuerpo vacío" }); return; }

  const sha = sha256Of(buf);
  // Dedup por contenido: mismo archivo ya registrado en el tenant
  const dup = await findEvidenceBySha(tenant, sha);
  if (dup) {
    json(res, 409, {
      status: "duplicate_evidence",
      existing_id: dup.id,
      movement_id: dup.movement_id,
      movement_op: dup.movement_op,
    });
    return;
  }
  const objectKey = objectKeyFor(tenant, sha, mimeType);
  await putEvidence(objectKey, buf, mimeType);
  const id = await insertEvidence({
    tenant, object_key: objectKey, sha256: sha, mime_type: mimeType,
    size_bytes: buf.length, kind, channel: channel ?? undefined, uploaded_by: uploadedBy, note,
  });
  json(res, 201, { status: "stored", id, sha256: sha, object_key: objectKey, size_bytes: buf.length, kind });
}

/** GET /api/evidence/:id — metadata; GET /api/evidence/:id/file — bytes (proxy MinIO). */
async function handleEvidenceGet(res: ServerResponse, id: string, file: boolean): Promise<void> {
  const row = await getEvidence(id);
  if (!row) { json(res, 404, { error: "evidencia no encontrada" }); return; }
  if (!file) { json(res, 200, row); return; }
  try {
    const stream = await getEvidenceStream(row.object_key);
    res.writeHead(200, {
      "content-type": row.mime_type,
      "content-length": row.size_bytes,
      "content-disposition": `inline; filename="${row.id}"`,
      "cache-control": "private, max-age=3600",
    });
    stream.pipe(res);
  } catch (err) {
    console.error("[terra-finance] evidence stream error", err);
    if (!res.headersSent) json(res, 502, { error: "storage error" });
  }
}

async function main(): Promise<void> {
  let consumerClient: mqtt.MqttClient | null = null;
  try {
    consumerClient = startConsumer();
  } catch (err) {
    console.error("[terra-finance] consumer start failed", err);
  }
  let ledgerChecker: LedgerCheckerHandle | null = null;
  try {
    ledgerChecker = startLedgerInvariantChecker(consumerClient);
  } catch (err) {
    console.error("[terra-finance] ledgerInvariant start failed", err);
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok", service: "terra-finance" });
      return;
    }
    if (url.pathname === "/api/evidence" && req.method === "POST") {
      await handleEvidenceUpload(req, res).catch((err) => {
        console.error("[terra-finance] evidence upload error", err);
        if (!res.headersSent) json(res, 500, { error: "internal", message: String(err) });
      });
      return;
    }
    const evMatch = url.pathname.match(/^\/api\/evidence\/([0-9a-fA-F-]{36})(\/file)?$/);
    if (evMatch && req.method === "GET") {
      await handleEvidenceGet(res, evMatch[1], evMatch[2] === "/file").catch((err) => {
        console.error("[terra-finance] evidence get error", err);
        if (!res.headersSent) json(res, 500, { error: "internal", message: String(err) });
      });
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
    console.log(`[terra-finance] escuchando :${FINANCE_PORT} (POST /mcp, POST /api/evidence, GET /healthz)`);
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[terra-finance] ${signal} — cerrando`);
    ledgerChecker?.stop();
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
