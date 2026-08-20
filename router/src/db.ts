import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type DeviceIdentity = {
  hwId: string;
  tenant: string;
  module: string;
  claimedBy: string | null;
  claimedAt: Date;
  /** Nombre humano del módulo (modules.name, ADR-0022) — null si sin nombre */
  moduleName: string | null;
  /** true si el módulo está retirado: no acepta telemetría ni discovery */
  moduleRetired: boolean;
};

// ---------------------------------------------------------------------------
// Cache en memoria con TTL 30s (claiming dinámico)
// ---------------------------------------------------------------------------

const TTL_MS = 30_000;

type HwCacheEntry = { identity: DeviceIdentity | null; expiresAt: number };
type ModuleCacheEntry = { hwId: string | null; identity: DeviceIdentity | null; expiresAt: number };

const cacheByHwId = new Map<string, HwCacheEntry>();
const cacheByModule = new Map<string, ModuleCacheEntry>();

function moduleKey(tenant: string, mod: string): string {
  return `${tenant}/${mod}`;
}

export function clearCache(): void {
  cacheByHwId.clear();
  cacheByModule.clear();
}

// ---------------------------------------------------------------------------
// Pool pg
// ---------------------------------------------------------------------------

export const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Log de errores idle
pool.on("error", (err) => {
  console.error("[router] pg pool error", err);
});

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * Resuelve hw_id → (tenant, module) consultando device_identities.
 * Cachea el resultado (incluido null) por 30s.
 */
export async function resolveByHwId(hwId: string): Promise<DeviceIdentity | null> {
  const now = Date.now();
  const cached = cacheByHwId.get(hwId);
  if (cached && cached.expiresAt > now) {
    return cached.identity;
  }

  try {
    const { rows } = await pool.query(
      `SELECT d.hw_id, d.tenant, d.module, d.claimed_by, d.claimed_at,
              m.name AS module_name, m.retired_at AS module_retired_at
       FROM device_identities d
       LEFT JOIN modules m ON m.tenant = d.tenant AND m.id = d.module
       WHERE d.hw_id = $1
       LIMIT 1`,
      [hwId],
    );

    if (rows.length === 0) {
      cacheByHwId.set(hwId, { identity: null, expiresAt: now + TTL_MS });
      return null;
    }

    const row = rows[0] as {
      hw_id: string;
      tenant: string;
      module: string;
      claimed_by: string | null;
      claimed_at: string | Date;
      module_name: string | null;
      module_retired_at: string | Date | null;
    };

    const identity: DeviceIdentity = {
      hwId: row.hw_id,
      tenant: row.tenant,
      module: row.module,
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at instanceof Date ? row.claimed_at : new Date(row.claimed_at),
      moduleName: row.module_name,
      moduleRetired: row.module_retired_at != null,
    };

    cacheByHwId.set(hwId, { identity, expiresAt: now + TTL_MS });
    // También poblar cache inversa para acelerar resolveByModule
    cacheByModule.set(moduleKey(identity.tenant, identity.module), {
      hwId: identity.hwId,
      identity,
      expiresAt: now + TTL_MS,
    });

    return identity;
  } catch (err) {
    console.error(`[router] resolveByHwId error hw_id=${hwId}`, err);
    // No cachear errores transitorios; permitir reintento inmediato
    return null;
  }
}

/**
 * Resuelve (tenant, module) → hw_id consultando device_identities.
 * Cachea el resultado (incluido null) por 30s.
 */
export async function resolveByModule(tenant: string, mod: string): Promise<DeviceIdentity | null> {
  const key = moduleKey(tenant, mod);
  const now = Date.now();
  const cached = cacheByModule.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.identity;
  }

  try {
    const { rows } = await pool.query(
      `SELECT d.hw_id, d.tenant, d.module, d.claimed_by, d.claimed_at,
              m.name AS module_name, m.retired_at AS module_retired_at
       FROM device_identities d
       LEFT JOIN modules m ON m.tenant = d.tenant AND m.id = d.module
       WHERE d.tenant = $1 AND d.module = $2
       LIMIT 1`,
      [tenant, mod],
    );

    if (rows.length === 0) {
      cacheByModule.set(key, { hwId: null, identity: null, expiresAt: now + TTL_MS });
      return null;
    }

    const row = rows[0] as {
      hw_id: string;
      tenant: string;
      module: string;
      claimed_by: string | null;
      claimed_at: string | Date;
      module_name: string | null;
      module_retired_at: string | Date | null;
    };

    const identity: DeviceIdentity = {
      hwId: row.hw_id,
      tenant: row.tenant,
      module: row.module,
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at instanceof Date ? row.claimed_at : new Date(row.claimed_at),
      moduleName: row.module_name,
      moduleRetired: row.module_retired_at != null,
    };

    cacheByModule.set(key, { hwId: identity.hwId, identity, expiresAt: now + TTL_MS });
    cacheByHwId.set(identity.hwId, { identity, expiresAt: now + TTL_MS });

    return identity;
  } catch (err) {
    console.error(`[router] resolveByModule error tenant=${tenant} module=${mod}`, err);
    return null;
  }
}

/**
 * Variante que retorna solo el hw_id (string) para el flujo interno→device.
 * Conveniencia sobre resolveByModule.
 */
export async function resolveHwIdForModule(tenant: string, mod: string): Promise<string | null> {
  const identity = await resolveByModule(tenant, mod);
  return identity?.hwId ?? null;
}

/**
 * Cierra el pool (shutdown limpio).
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
