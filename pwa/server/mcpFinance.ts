import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_FINANCE_URL = process.env.MCP_FINANCE_URL ?? "http://localhost:7761/mcp";

// Cliente MCP de finanzas (ADR-0027 §8): la PWA jamás escribe movements/evidence
// directo — todas las escrituras pasan por services/finance (un dueño, tres puertas).
export async function callFinanceTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = new Client({ name: "terra-pwa", version: "0.4.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_FINANCE_URL)));
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join(" ");
    if (result.isError) {
      throw new Error(text || `finance rechazó ${name}`);
    }
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    // possible_duplicate es una respuesta gobernada, no una excepción: la UI la muestra y ofrece forzar
    return structured ?? { status: "ok", text };
  } finally {
    await client.close();
  }
}

export type MovementInput = {
  tenant: string;
  kind: "gasto" | "ingreso";
  amount: number;
  currency?: string;
  category: string;
  scope?: "finca" | "modulos";
  attribution?: { module: string; amount: number }[];
  note?: string;
  occurred_at?: string;
  external_ref?: string;
  supplier?: string;
  evidence_ids?: string[];
};

export function registerMovement(input: MovementInput): Promise<Record<string, unknown>> {
  return callFinanceTool("register_movement", {
    ...input,
    channel: "pwa",
    created_by: "pwa",
  });
}

export function voidMovement(args: { id: string; tenant: string; reason: string }): Promise<Record<string, unknown>> {
  return callFinanceTool("void_movement", { ...args, channel: "pwa", created_by: "pwa" });
}

export function editMovement(args: { id: string; tenant: string; reason: string } & MovementInput): Promise<Record<string, unknown>> {
  return callFinanceTool("edit_movement", { ...args, channel: "pwa", created_by: "pwa" });
}

export function attachEvidence(args: { movement: string; evidence_id: string; tenant: string }): Promise<Record<string, unknown>> {
  return callFinanceTool("attach_evidence", args);
}
