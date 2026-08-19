// Smoke manual Fase 4: open/current/close campaign + list_invariant_alerts contra el servicio vivo.
// Uso: pnpm exec tsx scripts/smoke-campaign.ts  (requiere stack vivo)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_DOMAIN_URL ?? "http://localhost:7760/mcp");
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(url));

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const opened = await client.callTool({ name: "open_campaign", arguments: { tenant: "demo", crop: "lechuga", note: "smoke Fase 4" } });
console.log("open:", JSON.stringify(opened.structuredContent ?? opened.content).slice(0, 400));

const current = await client.callTool({ name: "current_campaign", arguments: { tenant: "demo" } });
console.log("current:", JSON.stringify(current.structuredContent ?? current.content).slice(0, 400));

const inv = await client.callTool({ name: "list_invariant_alerts", arguments: { tenant: "demo" } });
console.log("invariants:", JSON.stringify(inv.structuredContent ?? inv.content).slice(0, 400));

const closed = await client.callTool({ name: "close_campaign", arguments: { tenant: "demo", note: "smoke ok" } });
console.log("close:", JSON.stringify(closed.structuredContent ?? closed.content).slice(0, 300));

await client.close();
