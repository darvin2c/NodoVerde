import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_DOMAIN_URL = process.env.MCP_DOMAIN_URL ?? "http://localhost:7760/mcp";

// Resolución de alertas invariantes vía MCP de dominio (ADR-0021: excepción gobernada de escritura).
// Conexión por llamada: simple y sin estado que mantener; el costo es ms contra un servicio local.
export async function resolveAlert(args: {
  tenant: string;
  alert_name: string;
  module?: string;
  fingerprint?: string;
  note?: string;
  resolved_by?: string;
}): Promise<unknown> {
  const client = new Client({ name: "terra-pwa", version: "0.2.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_DOMAIN_URL)));
  try {
    const result = await client.callTool({ name: "resolve_alert", arguments: args });
    if (result.isError) {
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "")
        .join(" ");
      throw new Error(text || "mcp-domain rechazó la resolución");
    }
    return result.structuredContent ?? result.content;
  } finally {
    await client.close();
  }
}
