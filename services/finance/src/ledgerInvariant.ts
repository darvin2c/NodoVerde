// src/ledgerInvariant.ts — chequeo periódico invariante de ledger (ADR-0021/0027)
// invariant_ledger: scope='modulos' exige attribution con suma de montos = total (±0.005);
// scope='finca' exige attribution NULL; category y currency obligatorios.
// Sobre movimientos vigentes (voided_by IS NULL AND anula_a IS NULL), en SQL.
import crypto from "node:crypto";
import mqtt from "mqtt";
import { pool } from "./db.js";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://mosquitto:1883";
const ALERT_NAME = "invariant_ledger";
const ALERT_SEVERITY = "critical" as const;

export function parseLedgerCheckIntervalHours(): number {
  const raw = process.env.LEDGER_CHECK_INTERVAL_HOURS;
  if (raw === undefined || raw === "") return 24;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return n;
}

export function getLedgerCheckIntervalMs(): number {
  return parseLedgerCheckIntervalHours() * 60 * 60 * 1000;
}

export const FIRST_RUN_MS = 30_000;

export function fingerprintForIds(ids: string[]): string {
  const sorted = [...ids].sort();
  const payload = sorted.join(",");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export const LEDGER_VIOLATION_SQL = `
SELECT id::text AS id, tenant
FROM movements
WHERE voided_by IS NULL AND anula_a IS NULL
  AND (
    category IS NULL OR btrim(category) = ''
    OR currency IS NULL OR btrim(currency) = ''
    OR (scope = 'finca' AND attribution IS NOT NULL)
    OR (scope = 'modulos' AND (
      attribution IS NULL
      OR jsonb_typeof(attribution) <> 'array'
      OR jsonb_array_length(attribution) = 0
      OR ABS((SELECT COALESCE(SUM((elem->>'amount')::numeric), 0) FROM jsonb_array_elements(attribution) AS elem) - amount) > 0.005
    ))
  )
ORDER BY id
`.trim();

export type PendingInfo = {
  fingerprint: string;
  movement_ids: string;
  movement_count: number;
  reason: string;
};

export interface LedgerCheckerHandle {
  stop(): void;
  pending: Map<string, PendingInfo>;
}

export const pendingAlerts = new Map<string, PendingInfo>();

let fallbackClient: mqtt.MqttClient | null = null;
function getFallbackClient(): mqtt.MqttClient {
  if (fallbackClient) return fallbackClient;
  fallbackClient = mqtt.connect(MQTT_URL);
  fallbackClient.on("error", (err) => console.error("[terra-finance] ledgerInvariant MQTT error", err));
  fallbackClient.on("reconnect", () => console.log("[terra-finance] ledgerInvariant MQTT reconnecting"));
  return fallbackClient;
}

export function resetPending(): void {
  pendingAlerts.clear();
}
export function resetFallbackClient(): void {
  if (fallbackClient) {
    try { (fallbackClient as unknown as { end: (f:boolean)=>void }).end(true); } catch {}
    fallbackClient = null;
  }
}

export async function fetchViolations(): Promise<Map<string, string[]>> {
  const res = await pool.query(LEDGER_VIOLATION_SQL);
  const byTenant = new Map<string, string[]>();
  for (const row of res.rows as Array<{ id: string; tenant: string }>) {
    const tenant = row.tenant;
    const id = row.id;
    if (!tenant || !id) continue;
    if (!byTenant.has(tenant)) byTenant.set(tenant, []);
    byTenant.get(tenant)!.push(id);
  }
  for (const ids of byTenant.values()) ids.sort();
  return byTenant;
}

function buildAlertPayload(detail: Record<string, unknown>) {
  return {
    name: ALERT_NAME,
    ts: Date.now(),
    severity: ALERT_SEVERITY,
    detail,
  };
}

async function publishAlert(
  client: mqtt.MqttClient | null,
  tenant: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const topic = `terra/${tenant}/platform/alert`;
  const payload = JSON.stringify(buildAlertPayload(detail));
  const cl: mqtt.MqttClient | null = client ?? getFallbackClient();
  if (!cl) {
    console.error("[terra-finance] ledgerInvariant no MQTT client disponible, alerta descartada", topic);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      try {
        cl.publish(topic, payload, { qos: 1, retain: false }, (err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      } catch (e) {
        reject(e as Error);
      }
    });
    console.log(`[terra-finance] ledgerInvariant alerta ${tenant} state=${(detail as {state:string}).state} fingerprint=${(detail as {fingerprint:string}).fingerprint} count=${(detail as {movement_count:number}).movement_count}`);
  } catch (err) {
    console.error("[terra-finance] ledgerInvariant publish error", err);
  }
}

const VIOLATION_REASON = "ledger_invariant_violation";

export async function runLedgerCheck(
  client: mqtt.MqttClient | null = null,
  pending: Map<string, PendingInfo> = pendingAlerts,
): Promise<void> {
  let byTenant: Map<string, string[]>;
  try {
    byTenant = await fetchViolations();
  } catch (err) {
    console.error("[terra-finance] ledgerInvariant fetchViolations error", err);
    return;
  }

  for (const [tenant, ids] of byTenant.entries()) {
    try {
      const sortedIds = [...ids].sort();
      const movement_ids = sortedIds.join(",");
      const movement_count = sortedIds.length;
      const fingerprint = fingerprintForIds(sortedIds);
      const prev = pending.get(tenant);
      if (prev && prev.fingerprint === fingerprint) {
        continue;
      }
      if (prev && prev.fingerprint !== fingerprint) {
        const resolvedDetail = {
          reason: prev.reason,
          movement_ids: prev.movement_ids,
          movement_count: prev.movement_count,
          state: "resolved" as const,
          fingerprint: prev.fingerprint,
        };
        await publishAlert(client, tenant, resolvedDetail);
        pending.delete(tenant);
      }
      const pendingDetail = {
        reason: VIOLATION_REASON,
        movement_ids,
        movement_count,
        state: "pending" as const,
        fingerprint,
      };
      await publishAlert(client, tenant, pendingDetail);
      pending.set(tenant, {
        fingerprint,
        movement_ids,
        movement_count,
        reason: VIOLATION_REASON,
      });
    } catch (err) {
      console.error("[terra-finance] ledgerInvariant check tenant error", tenant, err);
    }
  }

  for (const [tenant, prev] of [...pending.entries()]) {
    if (!byTenant.has(tenant)) {
      try {
        const resolvedDetail = {
          reason: prev.reason,
          movement_ids: prev.movement_ids,
          movement_count: prev.movement_count,
          state: "resolved" as const,
          fingerprint: prev.fingerprint,
        };
        await publishAlert(client, tenant, resolvedDetail);
        pending.delete(tenant);
      } catch (err) {
        console.error("[terra-finance] ledgerInvariant resolved publish error", tenant, err);
      }
    }
  }
}

export function startLedgerInvariantChecker(
  client: mqtt.MqttClient | null = null,
): LedgerCheckerHandle {
  const intervalMs = getLedgerCheckIntervalMs();
  console.log(`[terra-finance] ledgerInvariant chequeo cada ${parseLedgerCheckIntervalHours()}h (primera en 30s)`);

  let interval: NodeJS.Timeout | null = null;
  const firstTimeout = setTimeout(() => {
    void runLedgerCheck(client, pendingAlerts).catch((err) =>
      console.error("[terra-finance] ledgerInvariant run error", err),
    );
    interval = setInterval(() => {
      void runLedgerCheck(client, pendingAlerts).catch((err) =>
        console.error("[terra-finance] ledgerInvariant run error", err),
      );
    }, intervalMs);
  }, FIRST_RUN_MS);

  const maybeUnref = firstTimeout as unknown as { unref?: () => void };
  if (typeof maybeUnref.unref === "function") maybeUnref.unref();

  return {
    stop: () => {
      clearTimeout(firstTimeout);
      if (interval) clearInterval(interval);
    },
    pending: pendingAlerts,
  };
}
