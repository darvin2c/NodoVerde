// src/server.ts — MCP server terra-policy (dueño único de cmd)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { proposeAction, approveAction, rejectAction } from "./policy.js";
import { listPending, listHistory, getAction, insertWorkOrder, completeWorkOrder, listWorkOrders } from "./db.js";
import { postPolicyEvent, buildPolicyMessage } from "./notify.js";

function summaryText(obj: unknown, maxLen = 4000): string {
  const s = JSON.stringify(obj, null, 2);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n…(truncado)";
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "terra-policy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // — propose_action -------------------------------------------------------
  server.registerTool(
    "propose_action",
    {
      title: "Proponer acción",
      description:
        "Propone una acción de actuador al portero. Valida salud/confianza/techo/rate/ventana y encola o ejecuta según autonomía.",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        module: z.string().describe("Módulo"),
        device: z.string().describe("Dispositivo actuador (pump-recirc-01, valve-fill-01, doser-*-01)"),
        action: z.enum(["start", "stop", "set"]).describe("Acción"),
        params: z.record(z.unknown()).optional().describe("Parámetros: {duration_ms} para start o {v: ON|OFF} para set"),
        requested_by: z.string().describe("Quién propone (agentId)"),
        reason: z.string().optional().describe("Justificación"),
      },
    },
    async (args) => {
      const res = await proposeAction({
        tenant: args.tenant as string,
        module: args.module as string,
        device: args.device as string,
        action: args.action as string,
        params: (args.params as Record<string, unknown> | undefined) ?? null,
        requested_by: args.requested_by as string,
        reason: (args.reason as string | undefined) ?? null,
        source: "agent",
      });
      const isError = res.status === "rejected";
      const payload = res as unknown as Record<string, unknown>;
      return {
        content: [{ type: "text", text: summaryText(payload) }],
        structuredContent: payload,
        isError: isError ? true : undefined,
      };
    },
  );

  // — approve_action -------------------------------------------------------
  server.registerTool(
    "approve_action",
    {
      title: "Aprobar acción",
      description: "Aprueba una acción pendiente. Re-valida confianza/health/rate antes de ejecutar.",
      inputSchema: {
        id: z.string().describe("ID de la acción (action_requests.id)"),
        decided_by: z.string().describe("Quién aprueba"),
      },
    },
    async ({ id, decided_by }) => {
      const res = await approveAction(id as string, decided_by as string);
      if (res.status === "not_found") {
        return { content: [{ type: "text", text: res.reason ?? "no encontrada" }], isError: true };
      }
      if (res.status === "conflict") {
        return { content: [{ type: "text", text: res.reason ?? "conflicto de estado" }], isError: true };
      }
      if (res.status === "needs_data") {
        const payload = res as unknown as Record<string, unknown>;
        return {
          content: [{ type: "text", text: `Confianza insuficiente — falta ${res.needs?.join(", ")}\n${summaryText(payload)}` }],
          structuredContent: payload,
        };
      }
      if (res.status === "rejected") {
        return { content: [{ type: "text", text: res.reason ?? "rechazada" }], isError: true };
      }
      const payload = res as unknown as Record<string, unknown>;
      return {
        content: [{ type: "text", text: `Aprobada y ejecutada ${id}\n${summaryText(payload)}` }],
        structuredContent: payload,
      };
    },
  );

  // — reject_action --------------------------------------------------------
  server.registerTool(
    "reject_action",
    {
      title: "Rechazar acción",
      description: "Rechaza una acción pendiente.",
      inputSchema: {
        id: z.string().describe("ID de la acción"),
        decided_by: z.string().describe("Quién rechaza"),
        reason: z.string().optional().describe("Motivo"),
      },
    },
    async ({ id, decided_by, reason }) => {
      const res = await rejectAction(id as string, decided_by as string, (reason as string | undefined) ?? null);
      if (!res.ok) {
        const isNotFound = res.reason === "not_found";
        return {
          content: [{ type: "text", text: res.reason ?? "error" }],
          isError: true,
        };
      }
      const payload = { status: "rejected", id };
      return {
        content: [{ type: "text", text: `Rechazada ${id}\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_pending_actions -------------------------------------------------
  server.registerTool(
    "list_pending_actions",
    {
      title: "Listar acciones pendientes",
      description: "Lista action_requests con status pending.",
      inputSchema: {
        tenant: z.string().optional().describe("Filtrar por tenant"),
      },
    },
    async ({ tenant }) => {
      const rows = await listPending((tenant as string | undefined) ?? undefined);
      const payload = { actions: rows };
      return {
        content: [{ type: "text", text: summaryText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_action_history --------------------------------------------------
  server.registerTool(
    "list_action_history",
    {
      title: "Historial de acciones",
      description: "Historial de action_requests.",
      inputSchema: {
        tenant: z.string().optional(),
        module: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Límite (default 50, max 100)"),
      },
    },
    async ({ tenant, module, limit }) => {
      const rows = await listHistory(
        (tenant as string | undefined) ?? undefined,
        (module as string | undefined) ?? undefined,
        (limit as number | undefined) ?? 50,
      );
      const payload = { history: rows };
      return {
        content: [{ type: "text", text: summaryText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — create_work_order ----------------------------------------------------
  server.registerTool(
    "create_work_order",
    {
      title: "Crear orden de trabajo",
      description: "Crea una orden de trabajo manual (podar, mezclar, cosechar...).",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        module: z.string().describe("Módulo"),
        kind: z.string().describe("Tipo (podar|mezclar_nutrientes|trasplantar|cosechar|otro)"),
        instructions: z.string().describe("Instrucciones concretas"),
        created_by: z.string().describe("Quién crea"),
      },
    },
    async ({ tenant, module, kind, instructions, created_by }) => {
      const row = await insertWorkOrder({
        tenant: tenant as string,
        module: module as string,
        kind: kind as string,
        instructions: instructions as string,
        created_by: created_by as string,
      });
      const msg = buildPolicyMessage("work_order_created", tenant as string, module as string, { kindDetail: kind as string });
      void postPolicyEvent("work_order_created", tenant as string, module as string, msg);
      const payload = { status: "created", order: row };
      return {
        content: [{ type: "text", text: `Orden creada ${row.id}\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — complete_work_order --------------------------------------------------
  server.registerTool(
    "complete_work_order",
    {
      title: "Completar orden de trabajo",
      description: "Marca una orden como done.",
      inputSchema: {
        id: z.string().describe("ID de la orden"),
        done_by: z.string().describe("Quién completa"),
        note: z.string().optional().describe("Observación"),
      },
    },
    async ({ id, done_by, note }) => {
      const row = await completeWorkOrder(id as string, done_by as string, (note as string | undefined) ?? null);
      if (!row) {
        return { content: [{ type: "text", text: "orden no encontrada o no está pending" }], isError: true };
      }
      const payload = { status: "done", order: row };
      return {
        content: [{ type: "text", text: `Orden completada ${id}\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_work_orders -----------------------------------------------------
  server.registerTool(
    "list_work_orders",
    {
      title: "Listar órdenes de trabajo",
      description: "Lista work_orders con filtros opcionales.",
      inputSchema: {
        tenant: z.string().optional(),
        status: z.enum(["pending", "done", "cancelled"]).optional(),
      },
    },
    async ({ tenant, status }) => {
      const rows = await listWorkOrders(
        (tenant as string | undefined) ?? undefined,
        (status as string | undefined) ?? undefined,
      );
      const payload = { orders: rows };
      return {
        content: [{ type: "text", text: summaryText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
