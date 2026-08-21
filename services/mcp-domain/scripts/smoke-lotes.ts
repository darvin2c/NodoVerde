// Smoke manual ADR-0024: open/list/close batch + list_invariant_alerts contra el servicio vivo.
// Uso: pnpm exec tsx scripts/smoke-lotes.ts  (requiere stack vivo)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_DOMAIN_URL ?? "http://localhost:7760/mcp";
const client = new Client({ name: "smoke-lotes", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const opened = await client.callTool({
  name: "open_batch",
  arguments: { tenant: "demo", crop: "lechuga", modules: ["mod-1"], campaign: "smoke-2026", note: "smoke ADR-0024" }
});
console.log("open:", JSON.stringify(opened.structuredContent ?? opened.content).slice(0, 500));
const batchId = (opened.structuredContent as { id?: string } | undefined)?.id;

const list = await client.callTool({ name: "list_batches", arguments: { tenant: "demo", state: "open" } });
console.log("list open:", JSON.stringify(list.structuredContent ?? list.content).slice(0, 400));

// Regla física: mod-1 ocupado → un segundo lote sobre mod-1 debe ser rechazado
const blocked = await client.callTool({
  name: "open_batch",
  arguments: { tenant: "demo", crop: "lechuga", modules: ["mod-1"] }
});
console.log("occupied:", JSON.stringify(blocked.structuredContent ?? blocked.content).slice(0, 300));

const inv = await client.callTool({ name: "list_invariant_alerts", arguments: { tenant: "demo" } });
console.log("invariant_alerts:", JSON.stringify(inv.structuredContent ?? inv.content).slice(0, 300));

if (batchId) {
  const closed = await client.callTool({ name: "close_batch", arguments: { id: batchId, reason: "cosecha", note: "smoke ok" } });
  console.log("close:", JSON.stringify(closed.structuredContent ?? closed.content).slice(0, 300));
}

await client.close();
