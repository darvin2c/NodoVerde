// src/db.ts — pool pg y helpers de ledger (dueño único de movements, ADR-0011/0027)
import pg from "pg";
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";

export const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("error", (err) => console.error("[terra-finance] pg pool error", err));

// ---------------------------------------------------------------------------
// Constantes de dominio (ADR-0011/0027)
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

export const SCOPES = ["finca", "modulos"] as const;
export type Scope = (typeof SCOPES)[number];

export const CHANNELS = ["telegram", "whatsapp", "webchat", "pwa", "auto"] as const;
export type Channel = (typeof CHANNELS)[number];

export const EVIDENCE_KINDS = ["recibo", "captura_pago", "factura", "audio", "foto_producto", "otro"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

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
// Attribution (ADR-0027): montos por elemento, no porcentajes.
// El humano declara plata; la suma de los elementos debe igualar el total.
// ---------------------------------------------------------------------------
export type AttributionInput = { module: string; amount: number }[];
export type AttributionElement = { module: string; amount: number; batch: string | null };

const AMOUNT_TOLERANCE = 0.005; // al céntimo

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Reparto a partes iguales en PLATA: el último elemento absorbe el centavo. */
export function splitEqual(total: number, modules: string[]): AttributionInput {
  const n = modules.length;
  return modules.map((module, i) => ({
    module,
    amount: i === n - 1 ? round2(total - round2(total / n) * (n - 1)) : round2(total / n),
  }));
}

export function validateAttributionAmounts(
  attribution: AttributionInput,
  total: number,
): string | null {
  if (!Array.isArray(attribution) || attribution.length === 0) return "attribution vacía";
  const seen = new Set<string>();
  let sum = 0;
  for (const a of attribution) {
    if (!a.module || typeof a.module !== "string") return "attribution.module requerido";
    if (seen.has(a.module)) return `módulo repetido en attribution: ${a.module}`;
    seen.add(a.module);
    if (typeof a.amount !== "number" || !Number.isFinite(a.amount)) return "attribution.amount debe ser número finito";
    if (a.amount <= 0) return `attribution.amount debe ser > 0 (módulo ${a.module})`;
    sum += a.amount;
  }
  if (Math.abs(sum - total) > AMOUNT_TOLERANCE) {
    return `attribution suma ${round2(sum)} ≠ total ${round2(total)}`;
  }
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
// Snapshot del lote activo (ADR-0027 §3): una mesa = máx. un lote open (ADR-0025)
// ---------------------------------------------------------------------------
export async function resolveActiveBatches(
  tenant: string,
  modules: string[],
  q: { query: (text: string, params: unknown[]) => Promise<{ rows: unknown[] }> } = pool,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (modules.length === 0) return result;
  const res = await q.query(
    `SELECT u.module, l.code
     FROM unnest($2::text[]) AS u(module)
     LEFT JOIN LATERAL (
       SELECT code FROM lotes l
       WHERE l.tenant = $1 AND l.modules ? u.module AND l.state = 'open'
       ORDER BY l.started_at DESC LIMIT 1
     ) l ON true`,
    [tenant, modules],
  );
  for (const r of res.rows as { module: string; code: string | null }[]) {
    result.set(r.module, r.code ?? null);
  }
  return result;
}

// ---------------------------------------------------------------------------
// op_number: MOV-NNNN correlativo por tenant (contador atómico)
// ---------------------------------------------------------------------------
async function nextOpNumber(
  tenant: string,
  q: { query: (text: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
): Promise<string> {
  const res = await q.query(
    `INSERT INTO tenant_counters (tenant, op_seq) VALUES ($1, 1)
     ON CONFLICT (tenant) DO UPDATE SET op_seq = tenant_counters.op_seq + 1
     RETURNING op_seq`,
    [tenant],
  );
  const seq = (res.rows[0] as { op_seq: number }).op_seq;
  return `MOV-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------
export type MovementRow = {
  id: string;
  tenant: string;
  ts: Date;
  kind: string;
  amount: string;
  currency: string;
  category: string;
  scope: Scope;
  attribution: AttributionElement[] | null;
  evidence_url: string | null;
  voided_by: string | null;
  anula_a: string | null;
  replaces: string | null;
  source: string | null;
  source_event: string | null;
  channel: string | null;
  raw_payload: string | null;
  occurred_at: Date | null;
  external_ref: string | null;
  supplier: string | null;
  op_number: string | null;
  created_by: string | null;
  note: string | null;
};

export type RegisterParams = {
  tenant: string;
  kind: Kind;
  amount: number;
  currency: string;
  category: Category;
  scope: Scope;
  attribution?: AttributionInput; // requerido si scope=modulos
  note?: string;
  occurred_at?: Date;
  channel?: Channel;
  raw_payload?: string;
  external_ref?: string;
  supplier?: string;
  created_by: string;
  source: string;
  source_event?: string;
  evidence_ids?: string[];
  replaces?: string;
};

export type RegisterResult = {
  id: string;
  op_number: string;
  attribution: AttributionElement[] | null;
  warnings: string[];
};

type TxClient = { query: (text: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> };

async function insertMovementTx(client: TxClient, params: RegisterParams): Promise<RegisterResult> {
  const warnings: string[] = [];
  let attribution: AttributionElement[] | null = null;
  if (params.scope === "modulos" && params.attribution) {
    const batches = await resolveActiveBatches(
      params.tenant,
      params.attribution.map((a) => a.module),
      client,
    );
    attribution = params.attribution.map((a) => {
      const batch = batches.get(a.module) ?? null;
      if (batch === null) warnings.push(`${a.module} no tiene lote activo — imputado sin ciclo`);
      return { module: a.module, amount: a.amount, batch };
    });
  }
  const opNumber = await nextOpNumber(params.tenant, client);
  const res = await client.query(
    `INSERT INTO movements (tenant, kind, amount, currency, category, scope, attribution,
                            occurred_at, source, source_event, channel, raw_payload,
                            external_ref, supplier, op_number, replaces, created_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      params.tenant,
      params.kind,
      params.amount,
      params.currency,
      params.category,
      params.scope,
      attribution ? JSON.stringify(attribution) : null,
      params.occurred_at ?? null,
      params.source,
      params.source_event ?? null,
      params.channel ?? null,
      params.raw_payload ?? null,
      params.external_ref ?? null,
      params.supplier ?? null,
      opNumber,
      params.replaces ?? null,
      params.created_by,
      params.note ?? null,
    ],
  );
  const id = (res.rows[0] as { id: string }).id;
  if (params.evidence_ids && params.evidence_ids.length > 0) {
    const att = await client.query(
      `UPDATE movement_evidence SET movement_id = $1
       WHERE id = ANY($2) AND movement_id IS NULL AND tenant = $3`,
      [id, params.evidence_ids, params.tenant],
    );
    const attached = att.rowCount ?? 0;
    if (attached < params.evidence_ids.length) {
      warnings.push(`evidencia adjuntada ${attached}/${params.evidence_ids.length} (ids ajenos o ya adjuntos se ignoran)`);
    }
  }
  return { id, op_number: opNumber, attribution, warnings };
}

/** Inserta un movimiento completo (transacción propia). */
export async function insertMovement(params: RegisterParams): Promise<RegisterResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await insertMovementTx(client, params);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Auto-registro desde actuadores: amount = ml × cost_per_unit calculado EN SQL. */
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
  const note = `auto dosificación ${device} ${ml} ml módulo ${module}`;
  // amount, attribution (con snapshot del lote) y op_number se construyen en SQL.
  // La secuencia puede dejar huecos si hay conflicto de dedup — aceptable (no exigimos gapless).
  const res = await pool.query(
    `WITH cost AS (
       SELECT $2 * sc.cost_per_unit AS amt, sc.currency
       FROM supply_costs sc WHERE sc.supply = $6
     ),
     op AS (
       INSERT INTO tenant_counters (tenant, op_seq) VALUES ($1, 1)
       ON CONFLICT (tenant) DO UPDATE SET op_seq = tenant_counters.op_seq + 1
       RETURNING 'MOV-' || lpad(op_seq::text, 4, '0') AS op_number
     )
     INSERT INTO movements (tenant, kind, amount, currency, category, scope, attribution,
                            occurred_at, source, source_event, channel, op_number, created_by, note)
     SELECT $1, 'gasto', c.amt, c.currency, 'nutrientes', 'modulos',
            jsonb_build_array(jsonb_build_object(
              'module', $3,
              'amount', c.amt,
              'batch', (SELECT l.code FROM lotes l
                        WHERE l.tenant = $1 AND l.modules ? $3 AND l.state = 'open'
                        ORDER BY l.started_at DESC LIMIT 1)
            )),
            to_timestamp($4 / 1000.0), 'auto:doser', $5, 'auto', op.op_number, 'auto:portero', $7
     FROM cost CROSS JOIN op
     ON CONFLICT (tenant, source_event) WHERE source_event IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenant, ml, module, ts, sourceEvent, supply, note],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].id as string;
}

/** Dedup fuerte: mismo external_ref vigente en el tenant. */
export async function findDuplicateByExternalRef(params: {
  tenant: string;
  external_ref: string;
}): Promise<{ id: string; op_number: string | null } | null> {
  const res = await pool.query(
    `SELECT id, op_number FROM movements
     WHERE tenant = $1 AND external_ref = $2
       AND voided_by IS NULL AND anula_a IS NULL
     LIMIT 1`,
    [params.tenant, params.external_ref],
  );
  return (res.rows[0] as { id: string; op_number: string | null } | undefined) ?? null;
}

/** Dedup suave: mismo monto+categoría el mismo día económico (occurred_at). */
export async function findDuplicateSameDay(params: {
  tenant: string;
  amount: number;
  category: string;
}): Promise<{ id: string; op_number: string | null } | null> {
  const res = await pool.query(
    `SELECT id, op_number FROM movements
     WHERE tenant = $1 AND amount = $2 AND category = $3
       AND COALESCE(occurred_at, ts)::date = now()::date
       AND voided_by IS NULL AND anula_a IS NULL
     LIMIT 1`,
    [params.tenant, params.amount, params.category],
  );
  return (res.rows[0] as { id: string; op_number: string | null } | undefined) ?? null;
}

export async function voidMovementDb(params: {
  id: string;
  reason: string;
  created_by: string;
  channel?: Channel;
}): Promise<{ voidId: string; voidOpNumber: string } | { error: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await voidMovementTx(client, params);
    if ("error" in r) {
      await client.query("ROLLBACK");
      return r;
    }
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function voidMovementTx(
  client: TxClient,
  params: { id: string; reason: string; created_by: string; channel?: Channel },
): Promise<{ voidId: string; voidOpNumber: string; orig: MovementRow } | { error: string }> {
  const origRes = await client.query(
    `SELECT * FROM movements WHERE id = $1 FOR UPDATE`,
    [params.id],
  );
  if (origRes.rows.length === 0) return { error: "movimiento no encontrado" };
  const orig = origRes.rows[0] as MovementRow;
  if (orig.voided_by) return { error: `movimiento ${orig.op_number ?? orig.id} ya anulado` };
  if (orig.anula_a) return { error: "no se puede anular un movimiento de anulación" };
  const voidOp = await nextOpNumber(orig.tenant, client);
  // Espejo con amount negativo calculado en SQL (- orig.amount), misma fecha económica
  const voidRes = await client.query(
    `INSERT INTO movements (tenant, kind, amount, currency, category, scope, attribution,
                            occurred_at, source, channel, anula_a, note, created_by, op_number, supplier)
     SELECT tenant, kind, -amount, currency, category, scope, attribution,
            occurred_at, 'void', $4, $2, $3, $5, $6, supplier
     FROM movements WHERE id = $1
     RETURNING id`,
    [params.id, params.id, params.reason, params.channel ?? null, params.created_by, voidOp],
  );
  const voidId = (voidRes.rows[0] as { id: string }).id;
  await client.query(`UPDATE movements SET voided_by = $2 WHERE id = $1`, [params.id, voidId]);
  return { voidId, voidOpNumber: voidOp, orig };
}

/** Edición gobernada (ADR-0027 §7): anula el original y crea el nuevo en UNA transacción. */
export async function editMovementDb(params: {
  id: string;
  reason: string;
  created_by: string;
  channel?: Channel;
  newMovement: Omit<RegisterParams, "replaces" | "source" | "tenant"> & { source?: string };
}): Promise<{ voidId: string; newId: string; op_number: string; attribution: AttributionElement[] | null; warnings: string[] } | { error: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const v = await voidMovementTx(client, params);
    if ("error" in v) {
      await client.query("ROLLBACK");
      return v;
    }
    const result = await insertMovementTx(client, {
      ...params.newMovement,
      tenant: v.orig.tenant,
      source: params.newMovement.source ?? "edit",
      replaces: params.id,
    });
    await client.query("COMMIT");
    return { voidId: v.voidId, newId: result.id, op_number: result.op_number, attribution: result.attribution, warnings: result.warnings };
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
  batch?: string;
  campaign?: string;
  scope?: string;
  mes?: string;
  from?: string;
  to?: string;
  supplier?: string;
  search?: string;
  include_voided?: boolean;
  limit?: number;
  offset?: number;
}): Promise<MovementRow[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (filters.tenant) { conds.push(`tenant = $${idx++}`); params.push(filters.tenant); }
  if (filters.kind) { conds.push(`kind = $${idx++}`); params.push(filters.kind); }
  if (filters.category) { conds.push(`category = $${idx++}`); params.push(filters.category); }
  if (filters.scope) { conds.push(`scope = $${idx++}`); params.push(filters.scope); }
  if (filters.supplier) { conds.push(`supplier ILIKE $${idx++}`); params.push(`%${filters.supplier}%`); }
  if (filters.module) {
    conds.push(`attribution @> $${idx++}::jsonb`);
    params.push(JSON.stringify([{ module: filters.module }]));
  }
  if (filters.batch) {
    conds.push(`attribution @> $${idx++}::jsonb`);
    params.push(JSON.stringify([{ batch: filters.batch }]));
  }
  if (filters.campaign) {
    // campaña = etiqueta del lote (ADR-0024): join por el batch del snapshot
    conds.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(attribution) e
                        JOIN lotes l ON l.code = e->>'batch'
                        WHERE l.campaign = $${idx++})`);
    params.push(filters.campaign);
  }
  if (filters.mes) {
    // mes = YYYY-MM sobre la fecha económica (ADR-0027 §4)
    conds.push(`to_char(COALESCE(occurred_at, ts), 'YYYY-MM') = $${idx++}`);
    params.push(filters.mes);
  }
  if (filters.from) { conds.push(`COALESCE(occurred_at, ts) >= $${idx++}::timestamptz`); params.push(filters.from); }
  if (filters.to) { conds.push(`COALESCE(occurred_at, ts) <= $${idx++}::timestamptz`); params.push(filters.to); }
  if (filters.search) {
    // un campo, cuatro objetivos: op_number, nota, ref externa, autor/proveedor
    conds.push(`(op_number ILIKE $${idx} OR note ILIKE $${idx} OR external_ref ILIKE $${idx} OR created_by ILIKE $${idx} OR supplier ILIKE $${idx})`);
    params.push(`%${filters.search}%`);
    idx++;
  }
  if (!filters.include_voided) {
    conds.push(`voided_by IS NULL AND anula_a IS NULL`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const lim = Math.min(filters.limit ?? 50, 200);
  const off = Math.max(filters.offset ?? 0, 0);
  const res = await pool.query(
    `SELECT * FROM movements ${where} ORDER BY COALESCE(occurred_at, ts) DESC, ts DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, lim, off],
  );
  return res.rows as MovementRow[];
}

export type CostSummaryRow = {
  group: string;
  gasto: string;
  ingreso: string;
  neto: string;
  yield_kg?: string | null;
  costo_por_kg?: string | null; // null honesto cuando no hay rendimiento declarado
};

export async function costSummaryDb(params: {
  tenant?: string;
  from?: string;
  to?: string;
  group_by: "crop" | "module" | "category" | "batch" | "scope" | "campaign";
}): Promise<CostSummaryRow[]> {
  const conds: string[] = [`m.voided_by IS NULL`, `m.anula_a IS NULL`];
  const qParams: unknown[] = [];
  let idx = 1;
  if (params.tenant) { conds.push(`m.tenant = $${idx++}`); qParams.push(params.tenant); }
  if (params.from) { conds.push(`COALESCE(m.occurred_at, m.ts) >= $${idx++}::timestamptz`); qParams.push(params.from); }
  if (params.to) { conds.push(`COALESCE(m.occurred_at, m.ts) <= $${idx++}::timestamptz`); qParams.push(params.to); }
  const where = `WHERE ${conds.join(" AND ")}`;
  let sql: string;
  if (params.group_by === "crop") {
    // ADR-0027 §3: el cultivo se resuelve por el SNAPSHOT del lote grabado al
    // insertar — no por ventana. Sin batch → 'sin_lote' (honesto).
    sql = `
      SELECT COALESCE(l.crop, 'sin_lote') AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN (elem->>'amount')::numeric ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN (elem->>'amount')::numeric ELSE 0 END) AS ingreso
      FROM movements m
      CROSS JOIN LATERAL jsonb_array_elements(m.attribution) AS elem
      LEFT JOIN lotes l ON l.code = elem->>'batch'
      ${where} AND m.scope = 'modulos'
      GROUP BY 1 ORDER BY 1`;
  } else if (params.group_by === "module") {
    sql = `
      SELECT elem->>'module' AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN (elem->>'amount')::numeric ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN (elem->>'amount')::numeric ELSE 0 END) AS ingreso
      FROM movements m
      CROSS JOIN LATERAL jsonb_array_elements(m.attribution) AS elem
      ${where} AND m.scope = 'modulos'
      GROUP BY grp ORDER BY grp`;
  } else if (params.group_by === "batch") {
    // yield_kg del lote → costo/kg determinístico (null honesto sin báscula)
    sql = `
      SELECT COALESCE(elem->>'batch', 'sin_lote') AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN (elem->>'amount')::numeric ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN (elem->>'amount')::numeric ELSE 0 END) AS ingreso,
             MAX(l.yield_kg) AS yield_kg
      FROM movements m
      CROSS JOIN LATERAL jsonb_array_elements(m.attribution) AS elem
      LEFT JOIN lotes l ON l.code = elem->>'batch'
      ${where} AND m.scope = 'modulos'
      GROUP BY grp ORDER BY grp`;
  } else if (params.group_by === "campaign") {
    // campaña = etiqueta libre del lote; sin lote → 'sin_campana' (honesto)
    sql = `
      SELECT COALESCE(l.campaign, 'sin_campana') AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN (elem->>'amount')::numeric ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN (elem->>'amount')::numeric ELSE 0 END) AS ingreso
      FROM movements m
      CROSS JOIN LATERAL jsonb_array_elements(m.attribution) AS elem
      LEFT JOIN lotes l ON l.code = elem->>'batch'
      ${where} AND m.scope = 'modulos'
      GROUP BY 1 ORDER BY 1`;
  } else if (params.group_by === "scope") {
    sql = `
      SELECT m.scope AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN m.amount ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN m.amount ELSE 0 END) AS ingreso
      FROM movements m
      ${where}
      GROUP BY m.scope ORDER BY m.scope`;
  } else {
    sql = `
      SELECT m.category AS grp,
             SUM(CASE WHEN m.kind='gasto' THEN m.amount ELSE 0 END) AS gasto,
             SUM(CASE WHEN m.kind='ingreso' THEN m.amount ELSE 0 END) AS ingreso
      FROM movements m
      ${where}
      GROUP BY m.category ORDER BY m.category`;
  }
  const res = await pool.query(sql, qParams);
  return (res.rows as { grp: string; gasto: string; ingreso: string; yield_kg?: string | null }[]).map((r) => {
    const gasto = Number(r.gasto ?? 0);
    const yieldKg = r.yield_kg != null ? Number(r.yield_kg) : null;
    return {
      group: r.grp,
      gasto: String(r.gasto ?? "0"),
      ingreso: String(r.ingreso ?? "0"),
      neto: String(Number(r.ingreso ?? 0) - gasto),
      ...(params.group_by === "batch"
        ? {
            yield_kg: r.yield_kg ?? null,
            costo_por_kg: yieldKg && yieldKg > 0 ? (gasto / yieldKg).toFixed(4) : null,
          }
        : {}),
    };
  });
}

/** Adjunta evidencia existente a un movimiento (post-hoc). El trigger permite
 * movement_id NULL → UUID; cualquier otro cambio es inmutable. */
export async function attachEvidenceDb(params: {
  tenant: string;
  movement_id: string;
  evidence_id: string;
}): Promise<{ attached: boolean; reason?: string }> {
  const res = await pool.query(
    `UPDATE movement_evidence SET movement_id = $1
     WHERE id = $2 AND tenant = $3 AND movement_id IS NULL
     RETURNING id`,
    [params.movement_id, params.evidence_id, params.tenant],
  );
  if (res.rows.length === 0) return { attached: false, reason: "evidencia no encontrada, de otro tenant, o ya adjunta" };
  return { attached: true };
}

// ---------------------------------------------------------------------------
// Evidence (ADR-0027 §5): metadata en DB; los bytes viven en MinIO
// ---------------------------------------------------------------------------
export type EvidenceRow = {
  id: string;
  movement_id: string | null;
  tenant: string;
  object_key: string;
  sha256: string;
  mime_type: string;
  size_bytes: number;
  kind: EvidenceKind;
  channel: string | null;
  uploaded_by: string;
  uploaded_at: Date;
  note: string | null;
};

export async function insertEvidence(params: {
  tenant: string;
  object_key: string;
  sha256: string;
  mime_type: string;
  size_bytes: number;
  kind: EvidenceKind;
  channel?: string;
  uploaded_by: string;
  note?: string;
}): Promise<string> {
  const res = await pool.query(
    `INSERT INTO movement_evidence (tenant, object_key, sha256, mime_type, size_bytes, kind, channel, uploaded_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      params.tenant,
      params.object_key,
      params.sha256,
      params.mime_type,
      params.size_bytes,
      params.kind,
      params.channel ?? null,
      params.uploaded_by,
      params.note ?? null,
    ],
  );
  return (res.rows[0] as { id: string }).id;
}

/** Dedup por contenido: mismo sha256 ya registrado en el tenant. */
export async function findEvidenceBySha(
  tenant: string,
  sha256: string,
): Promise<{ id: string; movement_id: string | null; movement_op: string | null } | null> {
  const res = await pool.query(
    `SELECT e.id, e.movement_id, m.op_number AS movement_op
     FROM movement_evidence e
     LEFT JOIN movements m ON m.id = e.movement_id
     WHERE e.tenant = $1 AND e.sha256 = $2
     ORDER BY e.uploaded_at ASC LIMIT 1`,
    [tenant, sha256],
  );
  return (res.rows[0] as { id: string; movement_id: string | null; movement_op: string | null } | undefined) ?? null;
}

export async function getEvidence(id: string): Promise<EvidenceRow | null> {
  const res = await pool.query(`SELECT * FROM movement_evidence WHERE id = $1`, [id]);
  return (res.rows[0] as EvidenceRow | undefined) ?? null;
}

export async function listEvidenceForMovements(movementIds: string[]): Promise<Map<string, EvidenceRow[]>> {
  const map = new Map<string, EvidenceRow[]>();
  if (movementIds.length === 0) return map;
  const res = await pool.query(
    `SELECT * FROM movement_evidence WHERE movement_id = ANY($1) ORDER BY uploaded_at`,
    [movementIds],
  );
  for (const row of res.rows as EvidenceRow[]) {
    if (!row.movement_id) continue;
    const arr = map.get(row.movement_id) ?? [];
    arr.push(row);
    map.set(row.movement_id, arr);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Supplies (costo unitario de insumos — valorización de dosis)
// ---------------------------------------------------------------------------
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
