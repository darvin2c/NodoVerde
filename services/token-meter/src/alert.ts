export type AlertPayload = {
  name: "budget_tokens";
  ts: number;
  severity: "warn";
  device?: string;
  detail: Record<string, unknown>;
};

export function buildUnknownModelAlert(model: string): AlertPayload {
  return {
    name: "budget_tokens",
    ts: Date.now(),
    severity: "warn",
    detail: { reason: "unknown_model", model, state: "pending" },
  };
}

export function buildBudgetAlert(params: {
  tenant: string;
  month: string;
  costUsd: number;
  capUsd: number;
  state: "pending" | "resolved";
}): AlertPayload {
  const fingerprint = `${params.tenant}:${params.month}`;
  return {
    name: "budget_tokens",
    ts: Date.now(),
    severity: "warn",
    detail: {
      month: params.month,
      cost_usd: params.costUsd,
      cap_usd: params.capUsd,
      state: params.state,
      fingerprint,
    },
  };
}

export function alertTopic(tenant: string): string {
  return `terra/${tenant}/platform/alert`;
}

export async function publishAlert(
  mqttClient: { publish: (topic: string, payload: string, opts: { qos: 0 | 1; retain: boolean }, cb?: (err?: Error) => void) => void },
  tenant: string,
  alert: AlertPayload,
): Promise<void> {
  const topic = alertTopic(tenant);
  const payload = JSON.stringify(alert);
  await new Promise<void>((resolve, reject) => {
    mqttClient.publish(topic, payload, { qos: 1, retain: false }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
