// src/write.ts — pool de escritura gobernada (ADR-0021)
// Única excepción al invariante read-only de db.ts.
// Solo toca campaigns y alert_resolutions con statements explícitos INSERT/UPDATE.
// Telemetría, tenants, modules, crop_profiles, etc. siguen read-only.

import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";

// Pool separado — solo escritura gobernada
export const writePool = new Pool({
  connectionString: DATABASE_URL,
});

writePool.on("error", (err) => {
  console.error("[mcp-domain:write] pg pool error", err);
});

// ---------------------------------------------------------------------------
// Hashing determinístico
// ---------------------------------------------------------------------------

export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function computeProfileHash(row: Record<string, unknown>): string {
  // Serialización determinística: JSON del row tal cual llega de DB
  return computeSha256(JSON.stringify(row));
}

// Memoria del experto: $WORKSPACES_PATH/experto-<crop>/MEMORY.md
// Env WORKSPACES_PATH default ""; archivo ausente → null, honesto.
export async function computeMemoryHash(crop: string): Promise<string | null> {
  const base = process.env.WORKSPACES_PATH ?? "";
  if (!base) return null;
  const filePath = path.join(base, `experto-${crop}`, "MEMORY.md");
  try {
    const data = await fs.readFile(filePath);
    return computeSha256(data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers de parsing para list_invariant_alerts
// ---------------------------------------------------------------------------

export type InvariantAlertRow = {
  time: Date;
  tenant: string;
  module: string;
  name: string;
  severity: string;
  device: string | null;
  detail: unknown;
};

export type ResolutionRow = {
  tenant: string;
  alert_name: string;
  module: string | null;
  fingerprint: string | null;
};

export function parseDetail(detail: unknown): { state?: string; fingerprint?: string } {
  if (detail == null) return {};
  let obj: unknown = detail;
  if (typeof detail === "string") {
    try {
      obj = JSON.parse(detail);
    } catch {
      return {};
    }
  }
  if (typeof obj !== "object" || obj === null) return {};
  const rec = obj as Record<string, unknown>;
  const state = typeof rec.state === "string" ? rec.state : undefined;
  const fingerprint = typeof rec.fingerprint === "string" ? rec.fingerprint : undefined;
  return { state, fingerprint };
}

export function isAlertOpen(
  alert: InvariantAlertRow,
  allAlerts: InvariantAlertRow[],
  resolutions: ResolutionRow[],
): boolean {
  const d = parseDetail(alert.detail);
  // Solo pending puede estar abierto; resolved es marcador de cierre
  if (d.state === "resolved") return false;
  if (d.state !== "pending") return false;

  const fingerprint = d.fingerprint ?? null;

  // (a) alerta posterior mismo tenant+name+fingerprint con state=resolved
  const hasLaterResolved = allAlerts.some((other) => {
    if (other === alert) return false;
    if (other.tenant !== alert.tenant) return false;
    if (other.name !== alert.name) return false;
    const od = parseDetail(other.detail);
    if (od.state !== "resolved") return false;
    // fingerprint debe coincidir (ambos null o iguales)
    const ofp = od.fingerprint ?? null;
    if (fingerprint !== ofp) return false;
    return new Date(other.time).getTime() > new Date(alert.time).getTime();
  });
  if (hasLaterResolved) return false;

  // (b) fila en alert_resolutions que matchee
  const hasResolutionRow = resolutions.some((r) => {
    if (r.tenant !== alert.tenant) return false;
    if (r.alert_name !== alert.name) return false;
    if (r.module != null && r.module !== alert.module) return false;
    if (r.fingerprint != null && r.fingerprint !== fingerprint) return false;
    return true;
  });
  if (hasResolutionRow) return false;

  return true;
}

export function filterInvariantAlerts(
  alerts: InvariantAlertRow[],
  resolutions: ResolutionRow[],
  onlyOpen: boolean,
): Array<InvariantAlertRow & { is_open: boolean }> {
  const enriched = alerts.map((a) => ({
    ...a,
    is_open: isAlertOpen(a, alerts, resolutions),
  }));
  if (onlyOpen) return enriched.filter((a) => a.is_open);
  return enriched;
}

// ---------------------------------------------------------------------------
// DB operations — statements explícitos solo sobre campaigns y alert_resolutions
// ---------------------------------------------------------------------------

export type CampaignRow = {
  id: string;
  tenant: string;
  crop: string;
  modules: unknown;
  profile_hash: string;
  memory_hash: string | null;
  memory_hash_close: string | null;
  note: string | null;
  opened_at: Date;
  closed_at: Date | null;
  state: string;
};

export async function getCurrentCampaignDb(tenant?: string): Promise<CampaignRow | null> {
  if (tenant) {
    const r = await writePool.query(
      `SELECT id, tenant, crop, modules, profile_hash, memory_hash, memory_hash_close, note, opened_at, closed_at, state FROM campaigns WHERE tenant = $1 AND state = 'open' LIMIT 1`,
      [tenant],
    );
    return (r.rows[0] as CampaignRow) ?? null;
  }
  const r = await writePool.query(
    `SELECT id, tenant, crop, modules, profile_hash, memory_hash, memory_hash_close, note, opened_at, closed_at, state FROM campaigns WHERE state = 'open' ORDER BY opened_at DESC LIMIT 1`,
  );
  return (r.rows[0] as CampaignRow) ?? null;
}

export async function listCampaignsDb(tenant?: string): Promise<CampaignRow[]> {
  if (tenant) {
    const r = await writePool.query(
      `SELECT id, tenant, crop, modules, profile_hash, memory_hash, memory_hash_close, note, opened_at, closed_at, state FROM campaigns WHERE tenant = $1 ORDER BY opened_at DESC`,
      [tenant],
    );
    return r.rows as CampaignRow[];
  }
  const r = await writePool.query(
    `SELECT id, tenant, crop, modules, profile_hash, memory_hash, memory_hash_close, note, opened_at, closed_at, state FROM campaigns ORDER BY opened_at DESC`,
  );
  return r.rows as CampaignRow[];
}

export async function listResolutionsDb(tenant: string): Promise<ResolutionRow[]> {
  const r = await writePool.query(
    `SELECT tenant, alert_name, module, fingerprint FROM alert_resolutions WHERE tenant = $1`,
    [tenant],
  );
  return r.rows as ResolutionRow[];
}

// — Statements explícitos de escritura (solo campaigns y alert_resolutions) —

export async function insertCampaignDb(
  tenant: string,
  crop: string,
  modulesJson: string,
  profileHash: string,
  memoryHash: string | null,
  note: string | null,
): Promise<string> {
  const r = await writePool.query(
    `INSERT INTO campaigns (tenant, crop, modules, profile_hash, memory_hash, note) VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
    [tenant, crop, modulesJson, profileHash, memoryHash, note],
  );
  const first = r.rows[0] as unknown as { id: string };
  return first.id;
}

export async function closeCampaignDb(
  id: string,
  memoryHashClose: string | null,
  note: string | null,
): Promise<{ id: string; closed_at: Date }> {
  const r = await writePool.query(
    `UPDATE campaigns SET memory_hash_close = $1, closed_at = now(), state = 'closed', note = COALESCE($2, note) WHERE id = $3 RETURNING id, closed_at`,
    [memoryHashClose, note, id],
  );
  const first = r.rows[0] as unknown as { id: string; closed_at: Date };
  return { id: first.id, closed_at: first.closed_at };
}

export async function insertResolutionDb(
  tenant: string,
  alertName: string,
  module: string | null,
  fingerprint: string | null,
  note: string | null,
  resolvedBy: string,
): Promise<string> {
  const r = await writePool.query(
    `INSERT INTO alert_resolutions (tenant, alert_name, module, fingerprint, note, resolved_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenant, alertName, module, fingerprint, note, resolvedBy],
  );
  const first = r.rows[0] as unknown as { id: string };
  return first.id;
}
// For invariant alerts read (uses writePool but SELECT only; could also use read pool)
// We use writePool to keep resolutions + alerts in same connection if needed, but it's read.
export async function listInvariantAlertsDb(
  tenant?: string,
  onlyOpen?: boolean,
): Promise<Array<InvariantAlertRow & { is_open: boolean }>> {
  // Alerts invariant names
  const invariantNames = ["cmd_sin_policy", "invariant_ledger", "budget_tokens"];
  let alertRows: InvariantAlertRow[];
  if (tenant) {
    const r = await writePool.query(
      `SELECT time, tenant, module, name, severity, device, detail FROM alerts WHERE tenant = $1 AND name = ANY($2) ORDER BY time DESC LIMIT 500`,
      [tenant, invariantNames],
    );
    alertRows = r.rows.map((row: Record<string, unknown>) => ({
      time: row.time as Date,
      tenant: row.tenant as string,
      module: row.module as string,
      name: row.name as string,
      severity: row.severity as string,
      device: row.device as string | null,
      detail: row.detail,
    }));
  } else {
    const r = await writePool.query(
      `SELECT time, tenant, module, name, severity, device, detail FROM alerts WHERE name = ANY($1) ORDER BY time DESC LIMIT 500`,
      [invariantNames],
    );
    alertRows = r.rows.map((row: Record<string, unknown>) => ({
      time: row.time as Date,
      tenant: row.tenant as string,
      module: row.module as string,
      name: row.name as string,
      severity: row.severity as string,
      device: row.device as string | null,
      detail: row.detail,
    }));
  }

  // Also need resolutions for matching
  let resolutions: ResolutionRow[] = [];
  if (tenant) {
    resolutions = await listResolutionsDb(tenant);
  } else {
    const rr = await writePool.query(`SELECT tenant, alert_name, module, fingerprint FROM alert_resolutions`);
    resolutions = rr.rows as ResolutionRow[];
  }

  // Parse detail that may be TEXT JSON
  // defensivo: si detail es string JSON, parsear al evaluar pero guardar original
  return filterInvariantAlerts(alertRows, resolutions, !!onlyOpen);
}
