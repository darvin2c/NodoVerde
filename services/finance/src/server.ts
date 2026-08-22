// src/server.ts — MCP server terra-finance (dueño único de movements, ADR-0011/0027)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  pool,
  CATEGORIES,
  CHANNELS,
  SCOPES,
  validateAttributionAmounts,
  splitEqual,
  modulesExist,
  findDuplicateByExternalRef,
  findDuplicateSameDay,
  insertMovement,
  voidMovementDb,
  editMovementDb,
  listMovementsDb,
  costSummaryDb,
  attachEvidenceDb,
  listSuppliesDb,
  setSupplyCostDb,
  type Kind,
  type Category,
  type Scope,
  type Channel,
} from "./db.js";

function summaryText(obj: unknown, maxLen = 4000): string {
  const s = JSON.stringify(obj, null, 2);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n…(truncado)";
}

const attributionInput = z
  .array(z.object({
    module: z.string().describe("id de módulo (mod-N)"),
    amount: z.number().positive().describe("Monto en plata para este módulo (no porcentaje)"),
  }))
  .describe("Imputación por módulo en MONTOS; la suma debe igualar el total (ADR-0027)");

const registerFields = {
  tenant: z.string().optional().describe("Tenant; default demo"),
  kind: z.enum(["gasto", "ingreso"]).describe("Tipo de movimiento"),
  amount: z.number().positive().describe("Monto total positivo; el LLM pasa el número tal cual, sin calcular"),
  currency: z.string().optional().describe("Moneda, default PEN"),
  category: z.string().describe(`Categoría: ${CATEGORIES.join("|")}`),
  scope: z.enum(SCOPES).optional().describe("'finca' = general de finca (default si no hay módulos); 'modulos' = con imputación"),
  attribution: attributionInput.optional().describe("Requerida si scope='modulos'. Omítela para gasto general de finca"),
  note: z.string().optional(),
  occurred_at: z.string().optional().describe("Fecha del gasto declarada (ISO). Default: ahora. Úsala para 'gasté ayer…'"),
  channel: z.enum(CHANNELS).optional().describe("Canal de origen: telegram|whatsapp|webchat|pwa|auto"),
  raw_payload: z.string().optional().describe("Mensaje original verbatim del humano (traza de procedencia)"),
  external_ref: z.string().optional().describe("Nro. de operación externo (Yape/Plin/banco) — dedup fuerte"),
  supplier: z.string().optional().describe("Proveedor: a quién se le compró/pagó"),
  evidence_ids: z.array(z.string()).optional().describe("IDs de evidencia ya subida (POST /api/evidence) a adjuntar"),
  created_by: z.string().describe("Quién registra (usuario o agent id)"),
  force: z.boolean().optional().describe("Si true, ignora deduplicación (external_ref y same-day)"),
};

async function doRegister(args: {
  tenant?: string; kind: Kind; amount: number; currency?: string; category: string;
  scope?: Scope; attribution?: { module: string; amount: number }[];
  note?: string; occurred_at?: string; channel?: Channel; raw_payload?: string;
  external_ref?: string; supplier?: string; evidence_ids?: string[]; created_by: string; force?: boolean;
}) {
  const tenant = args.tenant ?? "demo";
  const amount = args.amount;
  const currency = args.currency ?? "PEN";
  const category = args.category;
  const force = args.force ?? false;

  if (!Number.isFinite(amount) || amount <= 0) {
    return { content: [{ type: "text" as const, text: "amount debe ser número finito positivo" }], isError: true };
  }
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    return { content: [{ type: "text" as const, text: `categoría inválida: ${category}. Válidas: ${CATEGORIES.join(", ")}` }], isError: true };
  }
  // scope default: sin attribution → finca (ADR-0027 §1)
  const scope: Scope = args.scope ?? (args.attribution && args.attribution.length > 0 ? "modulos" : "finca");
  if (scope === "modulos") {
    if (!args.attribution || args.attribution.length === 0) {
      return { content: [{ type: "text" as const, text: "scope='modulos' exige attribution (o usa scope='finca')" }], isError: true };
    }
    const attrErr = validateAttributionAmounts(args.attribution, amount);
    if (attrErr) {
      return { content: [{ type: "text" as const, text: attrErr }], isError: true };
    }
    const missing = await modulesExist(tenant, args.attribution.map((a) => a.module));
    if (missing.length > 0) {
      return { content: [{ type: "text" as const, text: `módulos inexistentes: ${missing.join(", ")}` }], isError: true };
    }
  }
  if (!force) {
    if (args.external_ref) {
      const dup = await findDuplicateByExternalRef({ tenant, external_ref: args.external_ref });
      if (dup) {
        const payload = { status: "possible_duplicate", reason: "external_ref", existing_id: dup.id, existing_op: dup.op_number };
        return {
          content: [{ type: "text" as const, text: `Posible duplicado: ya existe ${dup.op_number ?? dup.id} con external_ref ${args.external_ref}\n${summaryText(payload)}` }],
          structuredContent: payload as unknown as Record<string, unknown>,
        };
      }
    }
    const dup = await findDuplicateSameDay({ tenant, amount, category });
    if (dup) {
      const payload = { status: "possible_duplicate", reason: "same_day_amount_category", existing_id: dup.id, existing_op: dup.op_number };
      return {
        content: [{ type: "text" as const, text: `Posible duplicado mismo día (${dup.op_number ?? dup.id}). Reenvía con force=true si es otro gasto real\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
  }
  let occurredAt: Date | undefined;
  if (args.occurred_at) {
    // date-only ("2026-08-21") → mediodía UTC: en cualquier tz civil cae en el día correcto
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(args.occurred_at) ? `${args.occurred_at}T12:00:00Z` : args.occurred_at;
    occurredAt = new Date(iso);
    if (Number.isNaN(occurredAt.getTime())) {
      return { content: [{ type: "text" as const, text: `occurred_at inválido: ${args.occurred_at}` }], isError: true };
    }
  }
  const result = await insertMovement({
    tenant,
    kind: args.kind,
    amount,
    currency,
    category: category as Category,
    scope,
    attribution: args.attribution,
    note: args.note,
    occurred_at: occurredAt,
    channel: args.channel,
    raw_payload: args.raw_payload,
    external_ref: args.external_ref,
    supplier: args.supplier,
    evidence_ids: args.evidence_ids,
    created_by: args.created_by,
    source: args.channel === "pwa" ? "pwa" : "chat",
  });
  const payload = { status: "registered", ...result, tenant, kind: args.kind, amount, currency, category, scope };
  return {
    content: [{ type: "text" as const, text: `Movimiento registrado ${result.op_number} (${result.id})\n${summaryText(payload)}` }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "terra-finance", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  // — register_movement ------------------------------------------------------
  server.registerTool(
    "register_movement",
    {
      title: "Registrar movimiento",
      description:
        "Registra un gasto o ingreso. Dos niveles (ADR-0027): scope='finca' (general, sin attribution) o scope='modulos' " +
        "(attribution en MONTOS por módulo, la suma debe igualar amount; el lote activo se deriva y graba como snapshot). " +
        "El LLM nunca calcula montos; pasa los datos crudos y el sistema valida e inserta.",
      inputSchema: registerFields,
    },
    async (args) => doRegister(args as Parameters<typeof doRegister>[0]),
  );

  // — split_equal (ayuda determinística de reparto) ---------------------------
  server.registerTool(
    "split_equal",
    {
      title: "Reparto a partes iguales",
      description:
        "Calcula en CÓDIGO el reparto a partes iguales de un monto entre módulos (el último absorbe el centavo). " +
        "El LLM nunca hace esta aritmética: llama aquí y pasa el resultado a register_movement.",
      inputSchema: {
        amount: z.number().positive(),
        modules: z.array(z.string()).min(1),
      },
    },
    async ({ amount, modules }) => {
      if (!Number.isFinite(amount) || amount <= 0) {
        return { content: [{ type: "text" as const, text: "amount debe ser positivo" }], isError: true };
      }
      const split = splitEqual(amount, modules);
      const payload = { amount, modules, split };
      return {
        content: [{ type: "text" as const, text: summaryText(payload) }],
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
        "Anula un movimiento vigente. Crea movimiento espejo con amount negativo y marca original voided_by. El LLM nunca calcula el monto de anulación; SQL hace amount = -orig.amount. Acepta id UUID u op_number (MOV-NNNN).",
      inputSchema: {
        id: z.string().describe("ID UUID u op_number (MOV-NNNN) del movimiento a anular"),
        tenant: z.string().optional().describe("Requerido si se pasa op_number"),
        reason: z.string().describe("Motivo de anulación"),
        created_by: z.string().describe("Quién anula"),
        channel: z.enum(CHANNELS).optional(),
      },
    },
    async ({ id, tenant, reason, created_by, channel }) => {
      const resolved = await resolveMovementId(id, tenant);
      if ("error" in resolved) {
        return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
      }
      const res = await voidMovementDb({ id: resolved.id, reason, created_by, channel });
      if ("error" in res) {
        return { content: [{ type: "text" as const, text: res.error }], isError: true };
      }
      const payload = { status: "voided", original_id: resolved.id, void_id: res.voidId, void_op: res.voidOpNumber };
      return {
        content: [{ type: "text" as const, text: `Movimiento anulado: ${id} → ${res.voidOpNumber}\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — edit_movement (ADR-0027 §7: anulación + recreación en una transacción) --
  server.registerTool(
    "edit_movement",
    {
      title: "Editar movimiento",
      description:
        "Corrige un movimiento: anula el original y crea el nuevo con replaces→original, en UNA transacción. " +
        "La historia jamás se edita in-place (regla 8); la cadena de corrección queda grabada.",
      inputSchema: {
        id: z.string().describe("ID UUID u op_number del movimiento a corregir"),
        reason: z.string().describe("Motivo de la corrección"),
        ...registerFields,
      },
    },
    async (args) => {
      const resolved = await resolveMovementId(args.id, args.tenant);
      if ("error" in resolved) {
        return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
      }
      // Reusar validación de register sobre el nuevo payload
      const tenant = resolved.tenant;
      const category = args.category;
      if (!(CATEGORIES as readonly string[]).includes(category)) {
        return { content: [{ type: "text" as const, text: `categoría inválida: ${category}` }], isError: true };
      }
      const scope: Scope = args.scope ?? (args.attribution && args.attribution.length > 0 ? "modulos" : "finca");
      if (scope === "modulos") {
        if (!args.attribution || args.attribution.length === 0) {
          return { content: [{ type: "text" as const, text: "scope='modulos' exige attribution" }], isError: true };
        }
        const attrErr = validateAttributionAmounts(args.attribution, args.amount);
        if (attrErr) return { content: [{ type: "text" as const, text: attrErr }], isError: true };
        const missing = await modulesExist(tenant, args.attribution.map((a) => a.module));
        if (missing.length > 0) {
          return { content: [{ type: "text" as const, text: `módulos inexistentes: ${missing.join(", ")}` }], isError: true };
        }
      }
      let occurredAt: Date | undefined;
      if (args.occurred_at) {
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(args.occurred_at) ? `${args.occurred_at}T12:00:00Z` : args.occurred_at;
        occurredAt = new Date(iso);
        if (Number.isNaN(occurredAt.getTime())) {
          return { content: [{ type: "text" as const, text: `occurred_at inválido` }], isError: true };
        }
      }
      const res = await editMovementDb({
        id: resolved.id,
        reason: args.reason,
        created_by: args.created_by,
        channel: args.channel,
        newMovement: {
          kind: args.kind,
          amount: args.amount,
          currency: args.currency ?? "PEN",
          category: category as Category,
          scope,
          attribution: args.attribution,
          note: args.note,
          occurred_at: occurredAt,
          channel: args.channel,
          raw_payload: args.raw_payload,
          external_ref: args.external_ref,
          supplier: args.supplier,
          evidence_ids: args.evidence_ids,
          created_by: args.created_by,
        },
      });
      if ("error" in res) {
        return { content: [{ type: "text" as const, text: res.error }], isError: true };
      }
      const payload = { status: "edited", original_id: resolved.id, void_id: res.voidId, new_id: res.newId, new_op: res.op_number, attribution: res.attribution, warnings: res.warnings };
      return {
        content: [{ type: "text" as const, text: `Movimiento corregido: ${args.id} → ${res.op_number}\n${summaryText(payload)}` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — attach_evidence (post-hoc: movement_id NULL → UUID) --------------------
  server.registerTool(
    "attach_evidence",
    {
      title: "Adjuntar evidencia",
      description:
        "Adjunta una evidencia ya subida (POST /api/evidence, movement_id null) a un movimiento existente. " +
        "La evidencia es inmutable: solo puede adjuntarse, jamás reasignarse.",
      inputSchema: {
        movement: z.string().describe("ID UUID u op_number (MOV-NNNN) del movimiento"),
        evidence_id: z.string().describe("ID UUID de la evidencia subida"),
        tenant: z.string().optional().describe("Requerido si movement es op_number"),
      },
    },
    async ({ movement, evidence_id, tenant }) => {
      const resolved = await resolveMovementId(movement, tenant);
      if ("error" in resolved) {
        return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
      }
      const res = await attachEvidenceDb({ tenant: resolved.tenant, movement_id: resolved.id, evidence_id });
      if (!res.attached) {
        return { content: [{ type: "text" as const, text: `No adjuntado: ${res.reason}` }], isError: true };
      }
      const payload = { status: "attached", movement: resolved.id, evidence_id };
      return {
        content: [{ type: "text" as const, text: `Evidencia ${evidence_id} adjunta a ${movement}\n${summaryText(payload)}` }],
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
        "Lista movimientos con filtros. Por defecto solo vigentes (voided_by IS NULL AND anula_a IS NULL). " +
        "Orden por fecha económica (occurred_at). Límite 50.",
      inputSchema: {
        tenant: z.string().optional(),
        kind: z.enum(["gasto", "ingreso"]).optional(),
        category: z.string().optional(),
        module: z.string().optional().describe("Filtra por módulo en attribution"),
        batch: z.string().optional().describe("Filtra por lote (LOTE-NNNN) en attribution"),
        campaign: z.string().optional().describe("Filtra por campaña (etiqueta del lote)"),
        scope: z.enum(SCOPES).optional(),
        supplier: z.string().optional().describe("Proveedor (coincidencia parcial)"),
        mes: z.string().optional().describe("Mes YYYY-MM (sobre occurred_at)"),
        from: z.string().optional().describe("Desde (ISO, sobre occurred_at)"),
        to: z.string().optional().describe("Hasta (ISO, sobre occurred_at)"),
        search: z.string().optional().describe("Busca en op_number, nota, external_ref, autor y proveedor"),
        include_voided: z.boolean().optional().describe("Si true incluye anulados"),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional().describe("Paginación"),
      },
    },
    async (args) => {
      const rows = await listMovementsDb({
        tenant: args.tenant,
        kind: args.kind,
        category: args.category,
        module: args.module,
        batch: args.batch,
        campaign: args.campaign,
        scope: args.scope,
        supplier: args.supplier,
        mes: args.mes,
        from: args.from,
        to: args.to,
        search: args.search,
        include_voided: args.include_voided,
        limit: args.limit,
        offset: args.offset,
      });
      const payload = { count: rows.length, movements: rows };
      return {
        content: [{ type: "text" as const, text: summaryText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — cost_summary -----------------------------------------------------------
  server.registerTool(
    "cost_summary",
    {
      title: "Resumen de costos",
      description:
        "Totales por cultivo (snapshot del lote), módulo, lote, scope o categoría. " +
        "Aritmética 100% SQL; el LLM interpreta, nunca calcula. Fechas sobre occurred_at.",
      inputSchema: {
        tenant: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        group_by: z.enum(["crop", "module", "category", "batch", "scope", "campaign"]).describe("Agrupación"),
      },
    },
    async ({ tenant, from, to, group_by }) => {
      const rows = await costSummaryDb({ tenant, from, to, group_by });
      const payload = { group_by, tenant: tenant ?? "demo", rows };
      return {
        content: [{ type: "text" as const, text: summaryText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_supplies ----------------------------------------------------------
  server.registerTool(
    "list_supplies",
    {
      title: "Listar costos de insumos",
      description: "Costo unitario por insumo (nutriente_a/b, ph_down) para valorización de dosis.",
      inputSchema: {},
    },
    async () => {
      const rows = await listSuppliesDb();
      const payload = { supplies: rows };
      return {
        content: [{ type: "text" as const, text: summaryText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // — set_supply_cost --------------------------------------------------------
  server.registerTool(
    "set_supply_cost",
    {
      title: "Fijar costo de insumo",
      description: "Actualiza el costo unitario de un insumo. Las dosis futuras se valorizan con este costo.",
      inputSchema: {
        supply: z.string(),
        cost_per_unit: z.number().positive(),
        currency: z.string().optional(),
        unit: z.string().optional(),
      },
    },
    async ({ supply, cost_per_unit, currency, unit }) => {
      await setSupplyCostDb({ supply, cost_per_unit, currency, unit });
      const payload = { status: "ok", supply, cost_per_unit, currency: currency ?? "PEN", unit: unit ?? "ml" };
      return {
        content: [{ type: "text" as const, text: summaryText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

/** Acepta UUID u op_number (MOV-NNNN, requiere tenant). */
async function resolveMovementId(idOrOp: string, tenant?: string): Promise<{ id: string; tenant: string } | { error: string }> {
  if (/^MOV-\d+$/i.test(idOrOp)) {
    if (!tenant) return { error: "op_number requiere tenant" };
    const res = await pool.query(
      `SELECT id, tenant FROM movements WHERE tenant = $1 AND op_number = $2`,
      [tenant, idOrOp.toUpperCase()],
    );
    if (res.rows.length === 0) return { error: `no existe ${idOrOp} en tenant ${tenant}` };
    return res.rows[0] as { id: string; tenant: string };
  }
  const res = await pool.query(`SELECT id, tenant FROM movements WHERE id = $1`, [idOrOp]);
  if (res.rows.length === 0) return { error: "movimiento no encontrado" };
  return res.rows[0] as { id: string; tenant: string };
}
