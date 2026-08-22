// src/write.ts — pool de escritura gobernada (ADR-0024 + ADR-0022 + ADR-0023 + ADR-0025)
// Única excepción al invariante read-only de db.ts.
// Solo toca lotes, alert_resolutions, modules, device_identities, tenants y
// crop_profiles con statements explícitos INSERT/UPDATE. Telemetría sigue
// read-only. Nada se borra: retiro/archivado/cierre = timestamp.
// ADR-0025: modules.crop es caché del lote — SOLO setModulesCropDb lo escribe,
// llamado desde open_batch (pone) y close_batch (limpia a NULL = mesa libre).

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
// Lotes de producción (ADR-0024) — el ciclo biológico es la entidad.
// Regla física: un módulo solo está en UN lote activo (validada en open_batch).
// ---------------------------------------------------------------------------

export type LoteRow = {
  id: string;
  code: string;
  tenant: string;
  crop: string;
  campaign: string | null;
  modules: unknown;
  started_at: Date;
  expected_end_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
  profile_hash: string;
  memory_hash: string | null;
  memory_hash_close: string | null;
  note: string | null;
  state: string;
};

const LOTE_COLS = `id, code, tenant, crop, campaign, modules, started_at, expected_end_at, closed_at, close_reason, profile_hash, memory_hash, memory_hash_close, note, state`;

export async function getBatchDb(id: string): Promise<LoteRow | null> {
  const r = await writePool.query(`SELECT ${LOTE_COLS} FROM lotes WHERE id = $1`, [id]);
  return (r.rows[0] as LoteRow) ?? null;
}

export async function listBatchesDb(tenant?: string, state?: "open" | "closed"): Promise<LoteRow[]> {
  const r = await writePool.query(
    `SELECT ${LOTE_COLS} FROM lotes
     WHERE ($1::text IS NULL OR tenant = $1) AND ($2::text IS NULL OR state = $2)
     ORDER BY state = 'open' DESC, started_at DESC`,
    [tenant ?? null, state ?? null],
  );
  return r.rows as LoteRow[];
}

/** Lotes activos que ocupan alguno de los módulos dados (regla: un módulo, un lote activo). */
export async function getOccupiedModulesDb(tenant: string, moduleIds: string[]): Promise<Array<{ code: string; modules: unknown }>> {
  if (moduleIds.length === 0) return [];
  const r = await writePool.query(
    `SELECT code, modules FROM lotes WHERE tenant = $1 AND state = 'open' AND modules ?| $2::text[]`,
    [tenant, moduleIds],
  );
  return r.rows as Array<{ code: string; modules: unknown }>;
}

/** Lote activo que incluye al módulo, o null. Congelamiento ADR-0024. */
export async function getOpenBatchWithModuleDb(tenant: string, moduleId: string): Promise<LoteRow | null> {
  const r = await writePool.query(
    `SELECT ${LOTE_COLS} FROM lotes WHERE tenant = $1 AND state = 'open' AND modules ? $2 LIMIT 1`,
    [tenant, moduleId],
  );
  return (r.rows[0] as LoteRow) ?? null;
}

export async function insertBatchDb(fields: {
  tenant: string;
  crop: string;
  campaign: string | null;
  modulesJson: string;
  startedAt: Date;
  expectedEndAt: Date | null;
  profileHash: string;
  memoryHash: string | null;
  note: string | null;
}): Promise<{ id: string; code: string }> {
  const r = await writePool.query(
    `INSERT INTO lotes (code, tenant, crop, campaign, modules, started_at, expected_end_at, profile_hash, memory_hash, note)
     VALUES ('LOTE-' || lpad(nextval('lotes_code_seq')::text, 4, '0'), $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
     RETURNING id, code`,
    [fields.tenant, fields.crop, fields.campaign, fields.modulesJson, fields.startedAt, fields.expectedEndAt, fields.profileHash, fields.memoryHash, fields.note],
  );
  return r.rows[0] as unknown as { id: string; code: string };
}

/**
 * Retira un módulo del lote sin cerrarlo (ADR-0026). UPDATE solo si el lote
 * sigue abierto; la lista nueva la calcula canRemoveModuleFromBatch (regla dura).
 */
export async function removeModuleFromBatchDb(id: string, remainingJson: string): Promise<{ id: string; code: string } | null> {
  const r = await writePool.query(
    `UPDATE lotes SET modules = $2::jsonb WHERE id = $1 AND state = 'open' RETURNING id, code`,
    [id, remainingJson],
  );
  return (r.rows[0] as unknown as { id: string; code: string }) ?? null;
}

export async function closeBatchDb(
  id: string,
  reason: string,
  memoryHashClose: string | null,
  note: string | null,
  yieldKg: number | null = null,
): Promise<{ id: string; code: string; closed_at: Date } | null> {
  const r = await writePool.query(
    `UPDATE lotes SET memory_hash_close = $1, closed_at = now(), close_reason = $2, state = 'closed', note = COALESCE($3, note), yield_kg = $5
     WHERE id = $4 AND state = 'open' RETURNING id, code, closed_at`,
    [memoryHashClose, reason, note, id, yieldKg],
  );
  return (r.rows[0] as unknown as { id: string; code: string; closed_at: Date }) ?? null;
}

export async function listResolutionsDb(tenant: string): Promise<ResolutionRow[]> {
  const r = await writePool.query(
    `SELECT tenant, alert_name, module, fingerprint FROM alert_resolutions WHERE tenant = $1`,
    [tenant],
  );
  return r.rows as ResolutionRow[];
}

// — Statements explícitos de escritura (lotes, alert_resolutions, modules, tenants, crop_profiles) —

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

// ---------------------------------------------------------------------------
// Módulos — provisionamiento gobernado (ADR-0022)
// modules.name = identificación humana; modules.retired_at = retiro (nada se borra).
// Reglas duras aquí (código, jamás en skill):
//  - cultivo y retiro bloqueados si el módulo está en la campaña abierta (ADR-0021)
//  - id técnico mod-N autogenerado (max+1, nunca reutiliza ids de retirados)
// ---------------------------------------------------------------------------

export type ModuleRow = {
  tenant: string;
  id: string;
  name: string | null;
  crop: string;
  retired_at: Date | null;
  created_at: Date;
};

const HW_ID_RE = /^[0-9a-f]{12}$/;

/** hw_id = 12 hex minúsculas (MAC sin dos puntos) — mismo formato que el router (ADR-0015). */
export function isValidHwId(hwId: string): boolean {
  return HW_ID_RE.test(hwId);
}

/** Siguiente id técnico: max(mod-N)+1 sobre TODOS los ids del tenant (retirados incluidos — un id jamás se reutiliza). */
export function nextModuleId(existingIds: string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^mod-(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `mod-${max + 1}`;
}

/** true si el módulo está en la lista congelada de un lote (lotes.modules = JSONB array de ids). */
export function moduleInBatch(batchModules: unknown, moduleId: string): boolean {
  try {
    const arr = typeof batchModules === "string" ? JSON.parse(batchModules) : batchModules;
    return Array.isArray(arr) && arr.includes(moduleId);
  } catch {
    return false;
  }
}

/**
 * Fin esperado del lote (ADR-0026): el override manual del humano gana;
 * sin override, inicio + cycle_days del perfil; null si el perfil no tiene ciclo.
 */
export function computeExpectedEnd(startedAt: Date, cycleDays: number | null, overrideEnd: Date | null): Date | null {
  if (overrideEnd) return overrideEnd;
  if (cycleDays == null) return null;
  return new Date(startedAt.getTime() + cycleDays * 86400000);
}

/**
 * Retiro de un módulo sin cerrar el lote (ADR-0026). La última mesa no se
 * retira — un lote sin mesas no es un lote: se cierra con close_batch.
 */
export function canRemoveModuleFromBatch(
  batchModules: unknown,
  moduleId: string,
): { ok: true; remaining: string[] } | { ok: false; reason: "module_not_in_batch" | "last_module" } {
  try {
    const arr = typeof batchModules === "string" ? JSON.parse(batchModules) : batchModules;
    if (!Array.isArray(arr) || !arr.includes(moduleId)) return { ok: false, reason: "module_not_in_batch" };
    if (arr.length === 1) return { ok: false, reason: "last_module" };
    return { ok: true, remaining: arr.filter((m) => m !== moduleId) };
  } catch {
    return { ok: false, reason: "module_not_in_batch" };
  }
}

export async function getModuleDb(tenant: string, id: string): Promise<ModuleRow | null> {
  const r = await writePool.query(
    `SELECT tenant, id, name, crop, retired_at, created_at FROM modules WHERE tenant = $1 AND id = $2`,
    [tenant, id],
  );
  return (r.rows[0] as ModuleRow) ?? null;
}

export async function listModuleIdsDb(tenant: string): Promise<string[]> {
  const r = await writePool.query(`SELECT id FROM modules WHERE tenant = $1`, [tenant]);
  return r.rows.map((row: { id: string }) => row.id);
}

/** Inserta módulo LIBRE (sin cultivo — ADR-0025) con id mod-N autogenerado. Reintenta una vez ante race de creación concurrente. */
export async function insertModuleDb(tenant: string, name: string): Promise<ModuleRow> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ids = await listModuleIdsDb(tenant);
    const id = nextModuleId(ids);
    try {
      const r = await writePool.query(
        `INSERT INTO modules (tenant, id, name) VALUES ($1, $2, $3)
         RETURNING tenant, id, name, crop, retired_at, created_at`,
        [tenant, id, name],
      );
      return r.rows[0] as ModuleRow;
    } catch (err) {
      // Race: otro cliente tomó el mismo mod-N entre el SELECT y el INSERT → recalcular una vez
      if (attempt === 0 && (err as { code?: string }).code === "23505") continue;
      throw err;
    }
  }
  throw new Error("insertModuleDb: unreachable");
}

export async function updateModuleDb(
  tenant: string,
  id: string,
  fields: { name?: string },
): Promise<ModuleRow | null> {
  // ADR-0025: crop NO es editable aquí — lo escribe solo el ciclo del lote (setModulesCropDb)
  const sets: string[] = [];
  const params: unknown[] = [tenant, id];
  if (fields.name !== undefined) {
    params.push(fields.name);
    sets.push(`name = $${params.length}`);
  }
  if (sets.length === 0) return getModuleDb(tenant, id);
  const r = await writePool.query(
    `UPDATE modules SET ${sets.join(", ")} WHERE tenant = $1 AND id = $2
     RETURNING tenant, id, name, crop, retired_at, created_at`,
    params,
  );
  return (r.rows[0] as ModuleRow) ?? null;
}

/**
 * ÚNICA escritora de modules.crop (ADR-0025): el ciclo del lote.
 * open_batch la llama con el cultivo; close_batch con null (mesa libre).
 */
export async function setModulesCropDb(tenant: string, moduleIds: string[], crop: string | null): Promise<void> {
  if (moduleIds.length === 0) return;
  await writePool.query(
    `UPDATE modules SET crop = $3 WHERE tenant = $1 AND id = ANY($2)`,
    [tenant, moduleIds, crop],
  );
}

/** Retiro gobernado: UPDATE solo si aún activo. Retorna null si ya estaba retirado o no existe. */
export async function retireModuleDb(tenant: string, id: string): Promise<ModuleRow | null> {
  const r = await writePool.query(
    `UPDATE modules SET retired_at = now() WHERE tenant = $1 AND id = $2 AND retired_at IS NULL
     RETURNING tenant, id, name, crop, retired_at, created_at`,
    [tenant, id],
  );
  return (r.rows[0] as ModuleRow) ?? null;
}

/** Claiming (ADR-0015): vincula hw_id a módulo. Retorna false si el hw_id ya estaba claimeado. */
export async function claimDeviceDb(
  hwId: string,
  tenant: string,
  moduleId: string,
  claimedBy: string,
): Promise<boolean> {
  const r = await writePool.query(
    `INSERT INTO device_identities (hw_id, tenant, module, claimed_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (hw_id) DO NOTHING RETURNING hw_id`,
    [hwId, tenant, moduleId, claimedBy],
  );
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Tenants (fincas) — gestión gobernada desde PWA (ADR-0023)
// id = slug elegido por el usuario, INMUTABLE (está gravado en topics MQTT,
// telemetría histórica, claims y campañas). name/location/lat/lon/currency
// son mutables. Nada se borra: archivar = archived_at.
// ---------------------------------------------------------------------------

export type TenantRow = {
  id: string;
  name: string;
  location_name: string | null;
  lat: number | null;
  lon: number | null;
  tz: string | null;
  currency: string;
  archived_at: Date | null;
  created_at: Date;
};

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** id de tenant = slug minúscula (ej: "demo", "finca-norte") — visible en topics MQTT. */
export function isValidTenantId(id: string): boolean {
  return id.length >= 2 && id.length <= 48 && TENANT_ID_RE.test(id);
}

/** Moneda ISO 4217 (3 letras mayúsculas). */
export function isValidCurrency(currency: string): boolean {
  return CURRENCY_RE.test(currency);
}

/** Valida coordenadas terrestres (lat/lon obligatorias al crear — ADR-0023). */
export function isValidLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

const TENANT_COLS = `id, name, location_name, lat, lon, tz, currency, archived_at, created_at`;

export async function listTenantsDb(includeArchived = false): Promise<TenantRow[]> {
  const r = await writePool.query(
    `SELECT ${TENANT_COLS} FROM tenants ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY id`,
  );
  return r.rows as TenantRow[];
}

export async function getTenantDb(id: string): Promise<TenantRow | null> {
  const r = await writePool.query(`SELECT ${TENANT_COLS} FROM tenants WHERE id = $1`, [id]);
  return (r.rows[0] as TenantRow) ?? null;
}

export async function insertTenantDb(fields: {
  id: string;
  name: string;
  location_name: string | null;
  lat: number;
  lon: number;
  tz: string | null;
  currency: string;
}): Promise<TenantRow | null> {
  const r = await writePool.query(
    `INSERT INTO tenants (id, name, location_name, lat, lon, tz, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${TENANT_COLS}`,
    [fields.id, fields.name, fields.location_name, fields.lat, fields.lon, fields.tz, fields.currency],
  );
  return (r.rows[0] as TenantRow) ?? null;
}

/** Actualiza campos mutables de la finca. El id jamás se toca. */
export async function updateTenantDb(
  id: string,
  fields: { name?: string; location_name?: string | null; lat?: number; lon?: number; tz?: string | null; currency?: string },
): Promise<TenantRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const key of ["name", "location_name", "lat", "lon", "tz", "currency"] as const) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return getTenantDb(id);
  const r = await writePool.query(
    `UPDATE tenants SET ${sets.join(", ")} WHERE id = $1 RETURNING ${TENANT_COLS}`,
    params,
  );
  return (r.rows[0] as TenantRow) ?? null;
}

/** Archiva (archived=true) o desarchiva (archived=false). Historia conservada — nada se borra. */
export async function archiveTenantDb(id: string, archived: boolean): Promise<TenantRow | null> {
  const r = await writePool.query(
    `UPDATE tenants SET archived_at = ${archived ? "now()" : "NULL"} WHERE id = $1 RETURNING ${TENANT_COLS}`,
    [id],
  );
  return (r.rows[0] as TenantRow) ?? null;
}

// ---------------------------------------------------------------------------
// Perfiles de cultivo — escritura gobernada (ADR-0025, regla 9: solo humano)
// La PWA (el humano) crea/edita; el LLM jamás toca rangos biológicos.
// name = PK inmutable una vez creado (los lotes hashean el perfil al abrir).
// ---------------------------------------------------------------------------

export type CropProfileRow = {
  name: string;
  ec_min: number;
  ec_max: number;
  ph_min: number;
  ph_max: number;
  water_temp_min: number;
  water_temp_max: number;
  cycle_days: number | null;
  notes: string | null;
};

const CROP_NAME_RE = /^[a-z0-9][a-z0-9_]*$/;

/** name = slug minúscula con guiones bajos (especie o especie_variedad, ADR-0019). */
export function isValidCropName(name: string): boolean {
  return name.length >= 2 && name.length <= 64 && CROP_NAME_RE.test(name);
}

/** Rangos coherentes: min < max en las tres variables. */
export function isValidProfileRanges(p: { ec_min: number; ec_max: number; ph_min: number; ph_max: number; water_temp_min: number; water_temp_max: number }): boolean {
  return (
    Number.isFinite(p.ec_min) && Number.isFinite(p.ec_max) && p.ec_min < p.ec_max && p.ec_min >= 0 &&
    Number.isFinite(p.ph_min) && Number.isFinite(p.ph_max) && p.ph_min < p.ph_max && p.ph_min >= 0 && p.ph_max <= 14 &&
    Number.isFinite(p.water_temp_min) && Number.isFinite(p.water_temp_max) && p.water_temp_min < p.water_temp_max
  );
}

const PROFILE_COLS = `name, ec_min, ec_max, ph_min, ph_max, water_temp_min, water_temp_max, cycle_days, notes`;

export async function insertCropProfileDb(p: CropProfileRow): Promise<CropProfileRow | null> {
  const r = await writePool.query(
    `INSERT INTO crop_profiles (name, ec_min, ec_max, ph_min, ph_max, water_temp_min, water_temp_max, cycle_days, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (name) DO NOTHING RETURNING ${PROFILE_COLS}`,
    [p.name, p.ec_min, p.ec_max, p.ph_min, p.ph_max, p.water_temp_min, p.water_temp_max, p.cycle_days, p.notes],
  );
  return (r.rows[0] as CropProfileRow) ?? null;
}

/** Edita rangos/ciclo/notas de un perfil existente. name jamás se toca (PK referenciada por lotes). */
export async function updateCropProfileDb(
  name: string,
  fields: { ec_min?: number; ec_max?: number; ph_min?: number; ph_max?: number; water_temp_min?: number; water_temp_max?: number; cycle_days?: number | null; notes?: string | null },
): Promise<CropProfileRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [name];
  for (const key of ["ec_min", "ec_max", "ph_min", "ph_max", "water_temp_min", "water_temp_max", "cycle_days", "notes"] as const) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return null;
  const r = await writePool.query(
    `UPDATE crop_profiles SET ${sets.join(", ")} WHERE name = $1 RETURNING ${PROFILE_COLS}`,
    params,
  );
  return (r.rows[0] as CropProfileRow) ?? null;
}
