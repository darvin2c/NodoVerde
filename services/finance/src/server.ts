// src/server.ts — MCP server terra-finance (dueño único de movements)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CATEGORIES,
  validateAttribution,
  modulesExist,
  findDuplicateSameDay,
  insertChatMovement,
  voidMovementDb,
  listMovementsDb,
  costSummaryDb,
  listSuppliesDb,
  setSupplyCostDb,
} from "./db.js";

function summaryText(obj: unknown, maxLen = 4000): string {
  const s = JSON.stringify(obj, null, 2);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n…(truncado)";
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "terra-finance", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // — register_movement ------------------------------------------------------
  server.registerTool(
    "register_movement",
    {
      title: "Registrar movimiento",
      description:
        "Registra un movimiento financiero. El LLM nunca calcula montos; pasa los datos crudos y el sistema valida e inserta. Categoría debe ser válida, attribution debe sumar 100%, módulos deben existir.",
      inputSchema: {
        tenant: z.string().optional().describe("Tenant; default demo"),
        kind: z.enum(["gasto", "ingreso"]).describe("Tipo de movimiento"),
        amount: z.number().positive().describe("Monto positivo; el LLM pasa el número tal cual, sin calcular"),
        currency: z.string().optional().describe("Moneda, default PEN"),
        category: z.string().describe(`Categoría: ${CATEGORIES.join("|")}`),
        attribution: z
          .array(z.object({ module: z.string(), pct: z.number() }))
          .describe("Imputación por módulo; suma debe ser 100 (tolerancia 0.001)"),
        note: z.string().optional(),
        evidence_url: z.string().optional(),
        created_by: z.string().describe("Quién registra (usuario o agent id)"),
        force: z.boolean().optional().describe("Si true, ignora deduplicación same-day"),
      },
    },
    async (args) => {
      const tenant = args.tenant ?? "demo";
      const kind = args.kind as "gasto" | "ingreso";
      const amount = args.amount;
      const currency = args.currency ?? "PEN";
      const category = args.category;
      const attribution = args.attribution as { module: string; pct: number }[];
      const note = args.note;
      const evidence_url = args.evidence_url;
      const created_by = args.created_by;
      const force = args.force ?? false;

      // Validaciones determinísticas EN CÓDIGO antes del insert
      if (!Number.isFinite(amount) || amount <= 0) {
        return { content: [{ type: "text", text: "amount debe ser número finito positivo" }], isError: true };
      }
      if (!(CATEGORIES as readonly string[]).includes(category)) {
        return { content: [{ type: "text", text: `categoría inválida: ${category}. Válidas: ${CATEGORIES.join(", ")}` }], isError: true };
      }
      const attrErr = validateAttribution(attribution);
      if (attrErr) {
        return { content: [{ type: "text", text: attrErr }], isError: true };
      }
      const missing = await modulesExist(tenant, attribution.map((a) => a.module));
      if (missing.length > 0) {
        return { content: [{ type: "text", text: `módulos inexistentes: ${missing.join(", ")}` }], isError: true };
      }
      if (!force) {
        const dup = await findDuplicateSameDay({ tenant, amount, category });
        if (dup) {
          const payload = { status: "possible_duplicate", existing_id: dup };
          return {
            content: [{ type: "text", text: `Posible duplicado mismo día\n${summaryText(payload)}` }],
            structuredContent: payload as unknown as Record<string, unknown>,
          };
        }
      }
      const id = await insertChatMovement({ tenant, kind, amount, currency, category: category as typeof CATEGORIES[number], attribution, note, evidence_url, created_by });
      const echo = { tenant, kind, amount, currency, category, attribution, note, evidence_url, created_by };
      const payload = { status: "registered", id, echo };
      return {
        content: [{ type: "text", text: `Movimiento registrado ${id}\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — void_movement ----------------------------------------------------------
  server.registerTool(
    "void_movement",
    {
      title: "Anular movimiento",
      description:
        "Anula un movimiento vigente. Crea movimiento espejo con amount negativo y marca original voided_by. El LLM nunca calcula el monto de anulación; SQL hace amount = -orig.amount.",
      inputSchema: {
        id: z.string().describe("ID del movimiento a anular"),
        reason: z.string().describe("Motivo de anulación"),
        created_by: z.string().describe("Quién anula"),
      },
    },
    async ({ id, reason, created_by }) => {
      const res = await voidMovementDb({ id, reason, created_by });
      if ("error" in res) {
        return { content: [{ type: "text", text: res.error }], isError: true };
      }
      const payload = { status: "voided", original_id: id, void_id: res.voidId };
      return {
        content: [{ type: "text", text: `Movimiento anulado: ${id} → ${res.voidId}\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_movements ---------------------------------------------------------
  server.registerTool(
    "list_movements",
    {
      title: "Listar movimientos",
      description:
        "Lista movimientos con filtros. Por defecto solo vigentes (voided_by IS NULL AND anula_a IS NULL). Límite 50.",
      inputSchema: {
        tenant: z.string().optional(),
        kind: z.enum(["gasto", "ingreso"]).optional(),
        category: z.string().optional(),
        module: z.string().optional().describe("Filtra por módulo en attribution"),
        mes: z.string().optional().describe("Mes YYYY-MM"),
        include_voided: z.boolean().optional().describe("Si true incluye anulados"),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => {
      const rows = await listMovementsDb({
        tenant: args.tenant,
        kind: args.kind,
        category: args.category,
        module: args.module,
        mes: args.mes,
        include_voided: args.include_voided ?? false,
        limit: args.limit ?? 50,
      });
      const text = `Movimientos: ${rows.length}`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(rows)}` }],
        structuredContent: { movements: rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — cost_summary -----------------------------------------------------------
  server.registerTool(
    "cost_summary",
    {
      title: "Resumen de costos",
      description:
        "Totales gasto/ingreso/neto por grupo (crop|module|category). El LLM pasa filtros crudos; SQL hace todas las sumas. Responde ¿cuánto costó X?",
      inputSchema: {
        tenant: z.string().optional(),
        from: z.string().optional().describe("ISO fecha desde"),
        to: z.string().optional().describe("ISO fecha hasta"),
        group_by: z.enum(["crop", "module", "category"]).describe("Agrupación"),
      },
    },
    async ({ tenant, from, to, group_by }) => {
      const rows = await costSummaryDb({ tenant, from, to, group_by });
      const text = `Cost summary group_by=${group_by}: ${rows.length} grupos`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(rows)}` }],
        structuredContent: { summary: rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_supplies ----------------------------------------------------------
  server.registerTool(
    "list_supplies",
    {
      title: "Listar insumos",
      description: "Lista insumos y su costo por unidad (supply_costs).",
      inputSchema: {},
    },
    async () => {
      const rows = await listSuppliesDb();
      return {
        content: [{ type: "text", text: `Insumos: ${rows.length}\n${summaryText(rows)}` }],
        structuredContent: { supplies: rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — set_supply_cost --------------------------------------------------------
  server.registerTool(
    "set_supply_cost",
    {
      title: "Actualizar costo de insumo",
      description: "Crea o actualiza costo por unidad de un insumo (UPSERT). El LLM pasa costo crudo, SQL lo guarda.",
      inputSchema: {
        supply: z.string().describe("Nombre del insumo ej. nutriente_a"),
        cost_per_unit: z.number().positive().describe("Costo por unidad (>0)"),
        currency: z.string().optional().describe("Moneda, default PEN"),
        unit: z.string().optional().describe("Unidad, default ml"),
      },
    },
    async ({ supply, cost_per_unit, currency, unit }) => {
      if (!Number.isFinite(cost_per_unit) || cost_per_unit <= 0) {
        return { content: [{ type: "text", text: "cost_per_unit debe ser >0" }], isError: true };
      }
      await setSupplyCostDb({ supply, cost_per_unit, currency, unit });
      const payload = { status: "ok", supply, cost_per_unit, currency: currency ?? "PEN" };
      return {
        content: [{ type: "text", text: `Costo actualizado ${supply}\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
