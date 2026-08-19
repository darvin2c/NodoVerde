import type { Pool } from "pg";

export function monthStrFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function monthBoundsUtc(month: string): { from: Date; to: Date } {
  const [yStr, mStr] = month.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)); // next month
  // to is first day next month; we use < to
  return { from, to };
}

export async function queryMonthSoftwareCost(pool: Pool, tenant: string, month: string): Promise<number> {
  const { from, to } = monthBoundsUtc(month);
  try {
    const res = await pool.query<{ sum: string | null }>(
      `SELECT COALESCE(SUM(amount),0)::text AS sum
       FROM movements
       WHERE tenant=$1 AND category='software'
         AND ts >= $2 AND ts < $3
         AND voided_by IS NULL AND anula_a IS NULL`,
      [tenant, from.toISOString(), to.toISOString()],
    );
    const raw = res.rows[0]?.sum ?? "0";
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.warn(`[token-meter] queryMonthSoftwareCost error tenant=${tenant} month=${month}`, err);
    return 0;
  }
}

export function decideBudgetState(monthCost: number, cap: number): boolean {
  return monthCost > cap;
}

/**
 * Dado estado actual overCap y estado previo (undefined = nunca visto),
 * decide si publicar pending/resolved o nada.
 * - over true && prev !== true  => pending
 * - over false && prev === true => resolved
 * - else null
 */
export function shouldPublishBudgetAlert(currentOver: boolean, previousOver: boolean | undefined): "pending" | "resolved" | null {
  if (currentOver && previousOver !== true) return "pending";
  if (!currentOver && previousOver === true) return "resolved";
  return null;
}
