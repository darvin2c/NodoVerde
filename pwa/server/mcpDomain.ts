import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_DOMAIN_URL = process.env.MCP_DOMAIN_URL ?? "http://localhost:7760/mcp";

// Cliente MCP de dominio: escrituras gobernadas (ADR-0021 resoluciones/campañas,
// ADR-0022 provisionamiento de módulos). Conexión por llamada: simple y sin estado
// que mantener; el costo es ms contra un servicio local.
export async function callDomainTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = new Client({ name: "terra-pwa", version: "0.3.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_DOMAIN_URL)));
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "")
        .join(" ");
      throw new Error(text || `mcp-domain rechazó ${name}`);
    }
    // Errores gobernados llegan 200 con structuredContent.error — también son rechazo
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    if (structured?.error) {
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "")
        .join(" ");
      throw new Error(text || String(structured.error));
    }
    return structured ?? result.content;
  } finally {
    await client.close();
  }
}

export function resolveAlert(args: {
  tenant: string;
  alert_name: string;
  module?: string;
  fingerprint?: string;
  note?: string;
  resolved_by?: string;
}): Promise<unknown> {
  return callDomainTool("resolve_alert", args);
}

// — Provisionamiento de módulos (ADR-0022) —

export function createModule(args: { tenant: string; name: string; crop: string }): Promise<unknown> {
  return callDomainTool("create_module", args);
}

export function updateModule(args: {
  tenant: string;
  module: string;
  name?: string;
  crop?: string;
}): Promise<unknown> {
  return callDomainTool("update_module", args);
}

export function retireModule(args: { tenant: string; module: string }): Promise<unknown> {
  return callDomainTool("retire_module", args);
}

export function claimDevice(args: {
  tenant: string;
  module: string;
  hw_id: string;
  claimed_by?: string;
}): Promise<unknown> {
  return callDomainTool("claim_device", args);
}

// — Gestión de fincas (ADR-0023) —

export function createTenant(args: {
  id: string;
  name: string;
  lat: number;
  lon: number;
  location_name?: string;
  currency?: string;
}): Promise<unknown> {
  return callDomainTool("create_tenant", args);
}

export function updateTenant(args: {
  id: string;
  name?: string;
  location_name?: string | null;
  lat?: number;
  lon?: number;
  currency?: string;
}): Promise<unknown> {
  return callDomainTool("update_tenant", args);
}

export function archiveTenant(args: { id: string; archived: boolean }): Promise<unknown> {
  return callDomainTool("archive_tenant", args);
}
