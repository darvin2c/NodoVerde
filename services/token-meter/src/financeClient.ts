import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Attribution } from "./attribution.js";

export type MovementArgs = {
  tenant: string;
  kind: "gasto";
  category: "software";
  currency: "USD";
  amount: number;
  attribution: Attribution[];
  source_event: string;
  created_by: "token-meter";
  note: string;
};

export type RegisterResult = {
  status: "registered" | "possible_duplicate" | "error";
  id?: string;
  raw: unknown;
};

export async function registerMovementViaMcp(financeMcpUrl: string, args: MovementArgs): Promise<RegisterResult> {
  const client = new Client({ name: "terra-token-meter", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(financeMcpUrl));
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "register_movement",
      arguments: {
        tenant: args.tenant,
        kind: args.kind,
        amount: args.amount,
        currency: args.currency,
        category: args.category,
        attribution: args.attribution,
        note: args.note,
        created_by: args.created_by,
        source_event: args.source_event,
      } as unknown as Record<string, unknown>,
    });
    const raw = result as unknown;
    // Detect possible_duplicate via structuredContent or text
    const maybe = result as unknown as {
      structuredContent?: Record<string, unknown>;
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    const structured = maybe.structuredContent as Record<string, unknown> | undefined;
    if (structured && structured.status === "possible_duplicate") {
      return { status: "possible_duplicate", id: structured.existing_id as string | undefined, raw };
    }
    const text = maybe.content?.[0]?.text ?? "";
    if (text.includes("possible_duplicate") || text.includes("Posible duplicado")) {
      return { status: "possible_duplicate", raw };
    }
    if (maybe.isError) {
      return { status: "error", raw };
    }
    // try extract id
    let id: string | undefined;
    if (structured && typeof structured.id === "string") id = structured.id;
    return { status: "registered", id, raw };
  } catch (err) {
    throw err;
  } finally {
    try {
      await transport.close?.();
    } catch {}
    try {
      await client.close();
    } catch {}
  }
}
