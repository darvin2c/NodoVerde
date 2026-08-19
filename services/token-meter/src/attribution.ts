import type { Pool } from "pg";

export type Attribution = { module: string; pct: number };

/**
 * Split igualitario entre módulos con 2 decimales; residual en el último para sumar exacto 100.
 * Ej: 3 módulos -> 33.33,33.33,33.34
 */
export function buildAttribution(modules: string[]): Attribution[] {
  const n = modules.length;
  if (n === 0) return [];
  if (n === 1) return [{ module: modules[0], pct: 100 }];
  const sorted = [...modules].sort();
  const out: Attribution[] = [];
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    const pct = Math.round((100 / n) * 100) / 100;
    out.push({ module: sorted[i], pct });
    sum += pct;
  }
  const lastPct = Math.round((100 - sum) * 100) / 100;
  out.push({ module: sorted[n - 1], pct: lastPct });
  return out;
}

export async function fetchTenantModules(pool: Pool, tenant: string): Promise<string[]> {
  try {
    const res = await pool.query<{ id: string }>("SELECT id FROM modules WHERE tenant=$1 ORDER BY id", [tenant]);
    return res.rows.map((r) => r.id);
  } catch (err) {
    console.warn(`[token-meter] fetchTenantModules error tenant=${tenant}`, err);
    return [];
  }
}

export async function fetchAllTenants(pool: Pool): Promise<string[]> {
  try {
    const res = await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
    return res.rows.map((r) => r.id);
  } catch {
    return [];
  }
}
