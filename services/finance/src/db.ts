// src/db.ts — pool pg y helpers de ledger (dueño único de movements)
import pg from "pg";
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";

export const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("error", (err) => console.error("[terra-finance] pg pool error", err));

// ---------------------------------------------------------------------------
// Constantes de dominio (ADR-0011)
// ---------------------------------------------------------------------------
export const CATEGORIES = [
  "nutrientes",
  "energia",
  "agua",
  "plantulas",
  "mano_obra",
  "empaque",
  "transporte",
  "venta_cosecha",
  "software",
  "otro",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const KINDS = ["gasto", "ingreso"] as const;
export type Kind = (typeof KINDS)[number];

export const DEVICE_SUPPLY_MAP: Record<string, string> = {
  "doser-a-01": "nutriente_a",
  "doser-b-01": "nutriente_b",
  "doser-ph-01": "ph_down",
};
export const DOSE_EVENT_NAMES: Record<string, true> = {
  dose_a_end: true,
  dose_b_end: true,
  dose_ph_end: true,
};
// ---------------------------------------------------------------------------
// Validación determinística de attribution
// ---------------------------------------------------------------------------
export function validateAttribution(
  attribution: { module: string; pct: number }[],
): string | null {
  if (!Array.isArray(attribution) || attribution.length === 0) return "attribution vacía";
  for (const a of attribution) {
    if (!a.module || typeof a.module !== "string") return "attribution.module requerido";
    if (typeof a.pct !== "number" || !Number.isFinite(a.pct)) return "attribution.pct debe ser número finito";
    if (a.pct < 0 || a.pct > 100) return "attribution.pct debe estar entre 0 y 100";
  }
  const sum = attribution.reduce((acc, a) => acc + a.pct, 0);
  if (Math.abs(sum - 100) > 0.001) return `attribution suma ${sum} ≠ 100`;
  return null;
}

export async function modulesExist(
  tenant: string,
  modules: string[],
): Promise<string[]> {
  if (modules.length === 0) return [];
  const res = await pool.query(
    `SELECT id FROM modules WHERE tenant = $1 AND id = ANY($2)`,
    [tenant, modules],
  );
  const found = new Set(res.rows.map((r: { id: string }) => r.id));
  return modules.filter((m) => !found.has(m));
}

// ---------------------------------------------------------------------------
// Helpers de movements
// ---------------------------------------------------------------------------
export type MovementRow = {
  id: string;
  tenant: string;
  ts: Date;
  kind: string;
  amount: string;
  currency: string;
  category: string;
  attribution: unknown;
  evidence_url: string | null;
  voided_by: string | null;
  anula_a: string | null;
  source: string | null;
  source_event: string | null;
  created_by: string | null;
  note: string | null;
};

export async function insertDoseMovement(params: {
  tenant: string;
  module: string;
  device: string;
  ml: number;
  ts: number;
  supply: string;
}): Promise<string | null> {
  const { tenant, module, ml, ts, supply } = params;
  const device = params.device;
  const sourceEvent = `${tenant}/${module}/${device}/${ts}`;
  const attribution = JSON.stringify([{ module, pct: 100 }]);
  const note = `auto dosificación ${device} ${ml} ml módulo ${module}`;
  // IMPORTANTE: amount = ml * cost_per_unit se calcula en SQL, NUNCA en TS
  const res = await pool.query(
    `INSERT INTO movements (tenant, kind, amount, currency, category, attribution, source, source_event, note)
     SELECT $1, 'gasto', $2 * sc.cost_per_unit, sc.currency, 'nutrientes', $3::jsonb, 'auto:doser', $4, $5
     FROM supply_costs sc WHERE sc.supply = $6
     ON CONFLICT (tenant, source_event) WHERE source_event IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenant, ml, attribution, sourceEvent, note, supply],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].id as string;
}

export async function findDuplicateSameDay(params: {
  tenant: string;
  amount: number;
  category: string;
}): Promise<string | null> {
  const res = await pool.query(
    `SELECT id FROM movements
     WHERE tenant = $1 AND amount = $2 AND category = $3
       AND ts::date = now()::date
       AND voided_by IS NULL AND anula_a IS NULL
     LIMIT 1`,
    [params.tenant, params.amount, params.category],
  );
  return res.rows[0]?.id ?? null;
}

export async function insertChatMovement(params: {
  tenant: string;
  kind: Kind;
  amount: number;
  currency: string;
  category: Category;
  attribution: { module: string; pct: number }[];
  note?: string;
  evidence_url?: string;
  created_by: string;
}): Promise<string> {
  const res = await pool.query(
    `INSERT INTO movements (tenant, kind, amount, currency, category, attribution, source, source_event, note, evidence_url, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'chat',NULL,$7,$8,$9)
     RETURNING id`,
    [
      params.tenant,
      params.kind,
      params.amount,
      params.currency,
      params.category,
      JSON.stringify(params.attribution),
      params.note ?? null,
      params.evidence_url ?? null,
      params.created_by,
    ],
  );
  return res.rows[0].id as string;
}

export async function voidMovementDb(params: {
  id: string;
  reason: string;
  created_by: string;
}): Promise<{ voidId: string } | { error: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const origRes = await client.query(
      `SELECT id, tenant, kind, amount, currency, category, attribution, voided_by, anula_a
       FROM movements WHERE id = $1 FOR UPDATE`,
      [params.id],
    );
    if (origRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "movimiento no encontrado" };
    }
    const orig = origRes.rows[0] as MovementRow & { amount: string };
    if (orig.voided_by) {
      await client.query("ROLLBACK");
      return { error: "movimiento ya anulado" };
    }
    if (orig.anula_a) {
      await client.query("ROLLBACK");
      return { error: "no se puede anular un movimiento de anulación" };
    }
    // INSERT espejo con amount negativo calculado en SQL ( - orig.amount )
    const voidRes = await client.query(
      `INSERT INTO movements (tenant, kind, amount, currency, category, attribution, source, anula_a, note, created_by)
       SELECT tenant, kind, -amount, currency, category, attribution, 'void', $2, $3, $4
       FROM movements WHERE id = $1
       RETURNING id`,
      [params.id, params.id, params.reason, params.created_by],
    );
    const voidId = voidRes.rows[0].id as string;
    await client.query(`UPDATE movements SET voided_by = $2 WHERE id = $1`, [params.id, voidId]);
    await client.query("COMMIT");
    return { voidId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function listMovementsDb(filters: {
  tenant?: string;
  kind?: string;
  category?: string;
  module?: string;
  mes?: string;
  include_voided?: boolean;
  limit?: number;
}): Promise<MovementRow[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (filters.tenant) { conds.push(`tenant = $${idx++}`); params.push(filters.tenant); }
  if (filters.kind) { conds.push(`kind = $${idx++}`); params.push(filters.kind); }
  if (filters.category) { conds.push(`category = $${idx++}`); params.push(filters.category); }
  if (filters.module) {
    conds.push(`attribution @> $${idx++}::jsonb`);
    params.push(JSON.stringify([{ module: filters.module }]));
  }
  if (filters.mes) {
    // mes = YYYY-MM
    conds.push(`to_char(ts, 'YYYY-MM') = $${idx++}`);
    params.push(filters.mes);
  }
  if (!filters.include_voided) {
    conds.push(`voided_by IS NULL AND anula_a IS NULL`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const lim = Math.min(filters.limit ?? 50, 50);
  const res = await pool.query(
    `SELECT * FROM movements ${where} ORDER BY ts DESC LIMIT $${idx}`,
    [...params, lim],
  );
  return res.rows as MovementRow[];
}

export async function costSummaryDb(params: {
  tenant?: string;
  from?: string;
  to?: string;
  group_by: "crop" | "module" | "category";
}): Promise<{ group: string; gasto: string; ingreso: string; neto: string }[]> {
  const conds: string[] = [`m.voided_by IS NULL`, `m.anula_a IS NULL`];
  const qParams: unknown[] = [];
  let idx = 1;
  if (params.tenant) { conds.push(`m.tenant = $${idx++}`); qParams.push(params.tenant); }
  if (params.from) { conds.push(`m.ts >= $${idx++}::timestamptz`); qParams.push(params.from); }
  if (params.to) { conds.push(`m.ts <= $${idx++}::timestamptz`); qParams.push(params.to); }
  const where = `WHERE ${conds.join(" AND ")}`;
  let groupExpr: string;
  let selectExpr: string;
  if (params.group_by === "crop") {
    // ADR-0025: el cultivo NO vive en el módulo (infraestructura fungible) — se
    // resuelve por la VENTANA del lote: el lote que contenía ese módulo cuando
    // ocurrió el movimiento. Sin lote en ese instante → 'sin_lote' (honesto:
    // el gasto no pertenece a ningún cultivo). Sobrevive al cierre del lote y
    // al cambio de cultivo de la mesa — comparabilidad entre ciclos (ADR-0012).
    const sql = `
      SELECT COALESCE(lote.crop, 'sin_lote') AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN m.amount * (elem->>'pct')::numeric/100 ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN m.amount * (elem->>'pct')::numeric/100 ELSE 0 END) AS ingreso
      FROM movements m
      CROSS JOIN LATERAL jsonb_array_elements(m.attribution) AS elem
      LEFT JOIN LATERAL (
        SELECT l.crop FROM lotes l
        WHERE l.tenant = m.tenant
          AND l.modules ? (elem->>'module')
          AND l.started_at <= m.ts
          AND (l.closed_at IS NULL OR m.ts <= l.closed_at)
        ORDER BY l.started_at DESC
        LIMIT 1
      ) lote ON true
      ${where}
      GROUP BY 1 ORDER BY 1`;
    const res = await pool.query(sql, qParams);
    return res.rows.map((r: { grp: string; gasto: string; ingreso: string }) => ({
      group: r.grp,
      gasto: String(r.gasto ?? "0"),
      ingreso: String(r.ingreso ?? "0"),
      neto: String(Number(r.ingreso ?? 0) - Number(r.gasto ?? 0)),
    }));
  } else if (params.group_by === "module") {
    const sql = `
      SELECT elem->>'module' AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN m.amount * (elem->>'pct')::numeric/100 ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN m.amount * (elem->>'pct')::numeric/100 ELSE 0 END) AS ingreso
      FROM movements m
      CROSS JOIN LATERAL jsonb_array_elements(m.attribution) AS elem
      ${where}
      GROUP BY grp ORDER BY grp`;
    const res = await pool.query(sql, qParams);
    return res.rows.map((r: { grp: string; gasto: string; ingreso: string }) => ({
      group: r.grp,
      gasto: String(r.gasto ?? "0"),
      ingreso: String(r.ingreso ?? "0"),
      neto: String(Number(r.ingreso ?? 0) - Number(r.gasto ?? 0)),
    }));
  } else {
    const sql = `
      SELECT m.category AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN m.amount ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN m.amount ELSE 0 END) AS ingreso
      FROM movements m
      ${where}
      GROUP BY m.category ORDER BY m.category`;
    const res = await pool.query(sql, qParams);
    return res.rows.map((r: { grp: string; gasto: string; ingreso: string }) => ({
      group: r.grp,
      gasto: String(r.gasto ?? "0"),
      ingreso: String(r.ingreso ?? "0"),
      neto: String(Number(r.ingreso ?? 0) - Number(r.gasto ?? 0)),
    }));
  }
}

export async function listSuppliesDb(): Promise<{ supply: string; unit: string; cost_per_unit: string; currency: string; updated_at: string }[]> {
  const res = await pool.query(`SELECT supply, unit, cost_per_unit, currency, updated_at FROM supply_costs ORDER BY supply`);
  return res.rows;
}

export async function setSupplyCostDb(params: { supply: string; cost_per_unit: number; currency?: string; unit?: string }): Promise<void> {
  await pool.query(
    `INSERT INTO supply_costs (supply, unit, cost_per_unit, currency, updated_at)
     VALUES ($1, COALESCE($2,'ml'), $3, COALESCE($4,'PEN'), now())
     ON CONFLICT (supply) DO UPDATE SET cost_per_unit = EXCLUDED.cost_per_unit, currency = EXCLUDED.currency, updated_at = now()`,
    [params.supply, params.unit ?? null, params.cost_per_unit, params.currency ?? null],
  );
}
