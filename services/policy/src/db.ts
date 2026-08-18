// src/db.ts — pool pg y helpers del portero (dueño único de action_requests/work_orders)
import pg from "pg";
import { randomUUID } from "node:crypto";
import { DATABASE_URL } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("error", (err) => console.error("[terra-policy] pg pool error", err));

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
export type ActionRequestRow = {
  id: string;
  policy_id: string;
  tenant: string;
  module: string;
  device: string;
  action: string;
  params: unknown;
  action_class: string;
  source: string;
  requested_by: string;
  reason: string | null;
  status: string;
  confidence: unknown;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  created_at: string;
};

export type WorkOrderRow = {
  id: string;
  tenant: string;
  module: string;
  kind: string;
  instructions: string;
  status: string;
  created_by: string;
  created_at: string;
  done_by: string | null;
  done_at: string | null;
  note: string | null;
};

export type ModuleCropInfo = {
  tenant: string;
  module: string;
  crop: string;
  ec_min: number;
  ec_max: number;
  ph_min: number;
  ph_max: number;
  water_temp_min: number;
  water_temp_max: number;
  tz: string | null;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function getModuleWithCrop(tenant: string, module: string): Promise<ModuleCropInfo | null> {
  const res = await pool.query(
    `SELECT m.tenant, m.id as module, m.crop,
            cp.ec_min, cp.ec_max, cp.ph_min, cp.ph_max, cp.water_temp_min, cp.water_temp_max,
            t.tz
     FROM modules m
     JOIN crop_profiles cp ON cp.name = m.crop
     JOIN tenants t ON t.id = m.tenant
     WHERE m.tenant = $1 AND m.id = $2`,
    [tenant, module],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as Record<string, unknown>;
  return {
    tenant: r.tenant as string,
    module: r.module as string,
    crop: r.crop as string,
    ec_min: Number(r.ec_min),
    ec_max: Number(r.ec_max),
    ph_min: Number(r.ph_min),
    ph_max: Number(r.ph_max),
    water_temp_min: Number(r.water_temp_min),
    water_temp_max: Number(r.water_temp_max),
    tz: (r.tz as string | null) ?? null,
  };
}

export async function lastExecutedAt(
  tenant: string,
  module: string,
  actionClass: string,
): Promise<Date | null> {
  const res = await pool.query(
    `SELECT executed_at FROM action_requests
     WHERE tenant=$1 AND module=$2 AND action_class=$3 AND status='executed'
     ORDER BY executed_at DESC LIMIT 1`,
    [tenant, module, actionClass],
  );
  if (res.rows.length === 0) return null;
  const v = res.rows[0].executed_at as string | Date | null;
  if (!v) return null;
  return v instanceof Date ? v : new Date(v as string);
}

export async function hasPendingFor(tenant: string, module: string, device: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM action_requests WHERE tenant=$1 AND module=$2 AND device=$3 AND status='pending' LIMIT 1`,
    [tenant, module, device],
  );
  return res.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Writes — action_requests
// ---------------------------------------------------------------------------
export type InsertActionRequestParams = {
  id?: string;
  policy_id?: string;
  tenant: string;
  module: string;
  device: string;
  action: string;
  params?: Record<string, unknown> | null;
  action_class: string;
  source: "agent" | "human";
  requested_by: string;
  reason?: string | null;
  status?: string;
  confidence?: Record<string, unknown> | null;
  decided_by?: string | null;
};

export async function insertActionRequest(p: InsertActionRequestParams): Promise<ActionRequestRow> {
  const id = p.id ?? randomUUID();
  const policyId = p.policy_id ?? `pol-${randomUUID()}`;
  const status = p.status ?? "pending";
  const paramsJson = p.params !== undefined && p.params !== null ? JSON.stringify(p.params) : null;
  const confidenceJson =
    p.confidence !== undefined && p.confidence !== null ? JSON.stringify(p.confidence) : null;

  const res = await pool.query(
    `INSERT INTO action_requests
      (id, policy_id, tenant, module, device, action, params, action_class, source, requested_by, reason, status, confidence, decided_by, decided_at, executed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,
             CASE WHEN $12 <> 'pending' THEN now() ELSE NULL END,
             CASE WHEN $12 = 'executed' THEN now() ELSE NULL END)
     RETURNING *`,
    [
      id,
      policyId,
      p.tenant,
      p.module,
      p.device,
      p.action,
      paramsJson,
      p.action_class,
      p.source,
      p.requested_by,
      p.reason ?? null,
      status,
      confidenceJson,
      p.decided_by ?? null,
    ],
  );
  return res.rows[0] as ActionRequestRow;
}

export async function getAction(id: string): Promise<ActionRequestRow | null> {
  const res = await pool.query(`SELECT * FROM action_requests WHERE id=$1`, [id]);
  if (res.rows.length === 0) return null;
  return res.rows[0] as ActionRequestRow;
}

export async function decideAction(
  id: string,
  status: "rejected" | "failed",
  decidedBy: string,
): Promise<ActionRequestRow | null> {
  const res = await pool.query(
    `UPDATE action_requests
     SET status=$2, decided_by=$3, decided_at=now()
     WHERE id=$1 AND status='pending'
     RETURNING *`,
    [id, status, decidedBy],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0] as ActionRequestRow;
}

export async function markExecuted(id: string, decidedBy: string | null): Promise<ActionRequestRow | null> {
  const res = await pool.query(
    `UPDATE action_requests
     SET status='executed', decided_by=COALESCE($2, decided_by), decided_at=now(), executed_at=now()
     WHERE id=$1 AND status='pending'
     RETURNING *`,
    [id, decidedBy],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0] as ActionRequestRow;
}

export async function listPending(tenant?: string): Promise<ActionRequestRow[]> {
  if (tenant) {
    const res = await pool.query(
      `SELECT * FROM action_requests WHERE status='pending' AND tenant=$1 ORDER BY created_at DESC`,
      [tenant],
    );
    return res.rows as ActionRequestRow[];
  }
  const res = await pool.query(`SELECT * FROM action_requests WHERE status='pending' ORDER BY created_at DESC`);
  return res.rows as ActionRequestRow[];
}

export async function listHistory(
  tenant?: string,
  module?: string,
  limit = 50,
): Promise<ActionRequestRow[]> {
  const lim = Math.min(Math.max(limit, 1), 100);
  if (tenant && module) {
    const res = await pool.query(
      `SELECT * FROM action_requests WHERE tenant=$1 AND module=$2 ORDER BY created_at DESC LIMIT $3`,
      [tenant, module, lim],
    );
    return res.rows as ActionRequestRow[];
  }
  if (tenant) {
    const res = await pool.query(
      `SELECT * FROM action_requests WHERE tenant=$1 ORDER BY created_at DESC LIMIT $2`,
      [tenant, lim],
    );
    return res.rows as ActionRequestRow[];
  }
  const res = await pool.query(`SELECT * FROM action_requests ORDER BY created_at DESC LIMIT $1`, [lim]);
  return res.rows as ActionRequestRow[];
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------
export async function insertWorkOrder(p: {
  tenant: string;
  module: string;
  kind: string;
  instructions: string;
  created_by: string;
}): Promise<WorkOrderRow> {
  const res = await pool.query(
    `INSERT INTO work_orders (tenant, module, kind, instructions, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [p.tenant, p.module, p.kind, p.instructions, p.created_by],
  );
  return res.rows[0] as WorkOrderRow;
}

export async function getWorkOrder(id: string): Promise<WorkOrderRow | null> {
  const res = await pool.query(`SELECT * FROM work_orders WHERE id=$1`, [id]);
  if (res.rows.length === 0) return null;
  return res.rows[0] as WorkOrderRow;
}

export async function completeWorkOrder(
  id: string,
  doneBy: string,
  note?: string | null,
): Promise<WorkOrderRow | null> {
  const res = await pool.query(
    `UPDATE work_orders SET status='done', done_by=$2, done_at=now(), note=$3
     WHERE id=$1 AND status='pending' RETURNING *`,
    [id, doneBy, note ?? null],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0] as WorkOrderRow;
}

export async function listWorkOrders(tenant?: string, status?: string): Promise<WorkOrderRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (tenant) {
    clauses.push(`tenant=$${idx++}`);
    params.push(tenant);
  }
  if (status) {
    clauses.push(`status=$${idx++}`);
    params.push(status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const res = await pool.query(`SELECT * FROM work_orders ${where} ORDER BY created_at DESC`, params);
  return res.rows as WorkOrderRow[];
}
