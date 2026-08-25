// src/db.ts — pool pg read-only (SELECT únicamente). Invariante documentada.
// Ninguna función de este módulo ejecuta INSERT/UPDATE/DELETE/DDL.
// Toda query pasa por queryReadOnly que valida que el statement es SELECT/WITH.
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";

// Pool compartido — solo lectura. No se expone método de escritura.
export const pool = new Pool({
  connectionString: DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("[mcp-domain] pg pool error", err);
});

// ---------------------------------------------------------------------------
// Invariante read-only: valida que la query es de lectura
// ---------------------------------------------------------------------------

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER)\b/i;

// Valida que el texto SQL es solo lectura (SELECT o WITH ... SELECT).
// Lanza si detecta escritura. Esto es grep-able: no existe ningún
// string "INSERT" / "UPDATE" / "DELETE" en queries de este archivo salvo en esta validación.
export function assertReadOnly(sql: string): void {
  const trimmed = sql.trim().replace(/^\/\*[\s\S]*?\*\//, "").trim();
  // Debe empezar por SELECT o WITH (CTE de lectura)
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error(`query no es SELECT/WITH (read-only invariant): ${trimmed.slice(0, 80)}`);
  }
  if (WRITE_KEYWORDS.test(trimmed)) {
    throw new Error(`query contiene palabra clave de escritura: ${trimmed.slice(0, 120)}`);
  }
}

// Ejecuta una query de solo lectura. Valida antes de enviar a pg.
export async function queryReadOnly(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  assertReadOnly(text);
  return pool.query(text, params as never);
}

// ---------------------------------------------------------------------------
// Helpers read-only de dominio (todas SELECT)
// ---------------------------------------------------------------------------

export async function listModulesDb(tenant?: string): Promise<{ tenant: string; id: string; name: string | null; crop: string; retired_at: Date | null }[]> {
  if (tenant) {
    const r = await queryReadOnly(
      `SELECT tenant, id, name, crop, retired_at FROM modules WHERE tenant = $1 ORDER BY tenant, id`,
      [tenant],
    );
    return r.rows;
  }
  const r = await queryReadOnly(`SELECT tenant, id, name, crop, retired_at FROM modules ORDER BY tenant, id`);
  return r.rows;
}

export async function getCropProfileDb(name: string): Promise<Record<string, unknown> | null> {
  const r = await queryReadOnly(`SELECT name, ec_min, ec_max, ph_min, ph_max, water_temp_min, water_temp_max, cycle_days, notes FROM crop_profiles WHERE name = $1`, [name]);
  return r.rows[0] ?? null;
}
/** Todos los perfiles de cultivo (fuente del sync de expertos, ADR-0028: una especie por perfil). */
export async function getCropProfilesDb(): Promise<Record<string, unknown>[]> {
  const r = await queryReadOnly(`SELECT name, ec_min, ec_max, ph_min, ph_max, water_temp_min, water_temp_max, cycle_days, notes FROM crop_profiles ORDER BY name`);
  return r.rows;
}

// Identidad de la finca: tenants es la única fuente de verdad (cerebro agnóstico).
export type FarmContextRow = {
  tenant: string;
  name: string;
  location_name: string | null;
  lat: number | null;
  lon: number | null;
  tz: string | null;
};

export async function getFarmContextDb(tenant: string): Promise<FarmContextRow | null> {
  const r = await queryReadOnly(
    `SELECT id AS tenant, name, location_name, lat, lon, tz FROM tenants WHERE id = $1`,
    [tenant],
  );
  return (r.rows[0] as FarmContextRow) ?? null;
}

export async function latestReadingsDb(
  tenant: string,
  mod: string,
): Promise<{ tenant: string; module: string; device: string; metric: string; value: number; time: Date }[]> {
  // Última lectura por métrica en el módulo (ventana = últimas lecturas disponibles)
  const r = await queryReadOnly(
    `SELECT DISTINCT ON (metric) tenant, module, device, metric, value, time
     FROM telemetry
     WHERE tenant = $1 AND module = $2
     ORDER BY metric, time DESC`,
    [tenant, mod],
  );
  return r.rows;
}

export async function telemetryRangeDb(
  tenant: string,
  mod: string,
  metric: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<{ device: string; metric: string; value: number; time: Date; raw: unknown }[]> {
  const lim = Math.min(Math.max(limit, 1), 500);
  const r = await queryReadOnly(
    `SELECT device, metric, value, time, raw
     FROM telemetry
     WHERE tenant = $1 AND module = $2 AND metric = $3 AND time >= $4 AND time <= $5
     ORDER BY time ASC
     LIMIT $6`,
    [tenant, mod, metric, from, to, lim],
  );
  return r.rows;
}

// sources llega como TEXT (JSON serializado — telegraf CopyFrom no escribe jsonb). Parse defensivo.
function parseSources(raw: unknown): Record<string, number> {
  if (raw == null) return {};
  if (typeof raw === "object") return raw as Record<string, number>;
  try {
    return JSON.parse(String(raw)) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function moduleConfidenceDb(
  tenant?: string,
  mod?: string,
): Promise<{ tenant: string; module: string; value: number; sources: Record<string, number>; time: Date }[]> {
  const mapRow = (r: Record<string, unknown>) => ({
    tenant: r.tenant as string,
    module: r.module as string,
    value: r.value as number,
    sources: parseSources(r.sources),
    time: r.time as Date,
  });
  if (tenant && mod) {
    const r = await queryReadOnly(
      `SELECT tenant, module, value, sources, time
       FROM confidence_history
       WHERE tenant = $1 AND module = $2
       ORDER BY time DESC LIMIT 1`,
      [tenant, mod],
    );
    return r.rows.map(mapRow);
  }
  if (tenant) {
    const r = await queryReadOnly(
      `SELECT DISTINCT ON (module) tenant, module, value, sources, time
       FROM confidence_history
       WHERE tenant = $1
       ORDER BY module, time DESC`,
      [tenant],
    );
    return r.rows.map(mapRow);
  }
  // tenant/módulo ambos opcionales: último por módulo global
  const r = await queryReadOnly(
    `SELECT DISTINCT ON (tenant, module) tenant, module, value, sources, time
     FROM confidence_history
     ORDER BY tenant, module, time DESC`,
  );
  return r.rows.map(mapRow);
}

export async function recentAlertsDb(
  tenant?: string,
  hours?: number,
): Promise<{ time: Date; tenant: string; module: string; name: string; severity: string; device: string | null; detail: unknown }[]> {
  const h = hours != null ? Math.min(Math.max(hours, 1), 24 * 30) : 24;
  const since = new Date(Date.now() - h * 3600 * 1000);
  if (tenant) {
    const r = await queryReadOnly(
      `SELECT time, tenant, module, name, severity, device, detail
       FROM alerts
       WHERE tenant = $1 AND time >= $2
       ORDER BY time DESC LIMIT 200`,
      [tenant, since],
    );
    return r.rows;
  }
  const r = await queryReadOnly(
    `SELECT time, tenant, module, name, severity, device, detail
     FROM alerts
     WHERE time >= $1
     ORDER BY time DESC LIMIT 200`,
    [since],
  );
  return r.rows;
}

// Día (UTC) del último dato de telemetría del tenant — el reloj de los datos.
// Permite que daily_report_data siga la campaña (sim acelerado) y no el reloj del servidor.
export async function latestTelemetryDateDb(tenant: string): Promise<string | null> {
  const r = await queryReadOnly(
    `SELECT to_char(max(time), 'YYYY-MM-DD') AS day FROM telemetry WHERE tenant = $1`,
    [tenant],
  );
  return (r.rows[0]?.day as string | undefined) ?? null;
}

export async function telemetryForDateDb(
  tenant: string,
  date: string,
): Promise<{ tenant: string; module: string; device: string; metric: string; value: number; time: Date }[]> {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  const r = await queryReadOnly(
    `SELECT tenant, module, device, metric, value, time
     FROM telemetry
     WHERE tenant = $1 AND time >= $2 AND time <= $3
     ORDER BY module, metric, time ASC`,
    [tenant, start, end],
  );
  return r.rows;
}

export async function alertsForDateDb(
  tenant: string,
  date: string,
): Promise<{ time: Date; tenant: string; module: string; name: string; severity: string; device: string | null; detail: unknown }[]> {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  const r = await queryReadOnly(
    `SELECT time, tenant, module, name, severity, device, detail
     FROM alerts
     WHERE tenant = $1 AND time >= $2 AND time <= $3
     ORDER BY time DESC`,
    [tenant, start, end],
  );
  return r.rows;
}

export async function confidenceForDateDb(
  tenant: string,
): Promise<Map<string, { v: number; sources: Record<string, number> }>> {
  // Última confianza por módulo (no filtrada por fecha: la confianza es el termómetro actual del módulo)
  const rows = await moduleConfidenceDb(tenant);
  const m = new Map<string, { v: number; sources: Record<string, number> }>();
  for (const r of rows) {
    const key = `${r.tenant}/${r.module}`;
    m.set(key, { v: r.value, sources: r.sources ?? {} });
    // también por módulo solo para compatibilidad con report que indexa por módulo
    m.set(r.module, { v: r.value, sources: r.sources ?? {} });
  }
  return m;
}
