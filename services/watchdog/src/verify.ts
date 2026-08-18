// CrossVerifier — verificación cruzada comando→efecto (Fase 3)
// Pura, testeable, now inyectable.

export type VerifyAlert = {
  tenant: string;
  module: string;
  name: "verification_failed";
  severity: "critical";
  device: string;
  ts: number;
  detail: {
    kind: string;
    policy_id: string;
    metric: string;
    baseline: number | null;
    last: number | null;
  };
};

type Direction = "up" | "down";

type ExpectSpec = {
  metric: string;
  direction: Direction;
  minDelta: number;
  kind: string;
};

type Expectation = ExpectSpec & {
  tenant: string;
  module: string;
  device: string;
  policy_id: string;
  baseline: number | null;
  deadline: number;
};

function getSpec(device: string, action: string, paramsV?: string): ExpectSpec | null {
  if (device === "doser-a-01" || device === "doser-b-01") {
    if (action === "start") return { metric: "ec", direction: "up", minDelta: 0.05, kind: "dose" };
    return null;
  }
  if (device === "doser-ph-01") {
    if (action === "start") return { metric: "ph", direction: "down", minDelta: 0.05, kind: "dose" };
    return null;
  }
  if (device === "valve-fill-01") {
    if (action === "start") return { metric: "level", direction: "up", minDelta: 1.0, kind: "fill" };
    if (action === "set" && paramsV === "ON") return { metric: "level", direction: "up", minDelta: 1.0, kind: "fill" };
    return null;
  }
  if (device === "pump-recirc-01") {
    if (action === "start") return { metric: "flow", direction: "up", minDelta: 0.5, kind: "recirc" };
    if (action === "set" && paramsV === "ON") return { metric: "flow", direction: "up", minDelta: 0.5, kind: "recirc" };
    return null;
  }
  return null;
}

function parsePayload(raw: unknown): { action: string; policy_id: string; params?: Record<string, unknown> } | null {
  let obj: unknown = raw;
  if (Buffer.isBuffer(raw)) {
    try {
      obj = JSON.parse(raw.toString("utf-8"));
    } catch {
      return null;
    }
  } else if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (raw instanceof Uint8Array) {
    try {
      obj = JSON.parse(Buffer.from(raw).toString("utf-8"));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const action = typeof o.action === "string" ? o.action : null;
  const policy_id = typeof o.policy_id === "string" ? o.policy_id : null;
  if (!action || policy_id === null) {
    // Si no hay action es payload no-Cmd, ignorar.
    // policy_id vacío también es válido? La router descarta, pero para verifier
    // si no hay policy_id lo tratamos como "" o ignoramos? Lo dejamos pasar con "" si falta?
    // Especificación: detail plano con policy_id; si falta, usar "" para no romper.
    // Pero si action existe y policy_id falta → ignorar para no generar expectativa inválida?
    // Decidimos: si action presente pero policy_id no string → usar "" si es undefined, null → tratar como no-Cmd y retornar null solo si action falta.
    if (!action) return null;
    // action existe pero policy_id no string -> tolerante, usar string vacío
    if (policy_id === null) {
      // para mantener contrato, policy_id vacío → no generar expectativa si action requiere policy? Pero tests no cubren.
      // Lo permitimos con "" para no bloquear.
      const params = (o.params && typeof o.params === "object" ? (o.params as Record<string, unknown>) : undefined);
      return { action, policy_id: typeof o.policy_id === "string" ? o.policy_id : "", params };
    }
  }
  // Caso normal con policy_id string
  if (!action) return null;
  const params = (o.params && typeof o.params === "object" ? (o.params as Record<string, unknown>) : undefined);
  return { action, policy_id: policy_id as string, params };
}

export class CrossVerifier {
  private windowMs: number;
  private expectations = new Map<string, Expectation>();
  private lastReadings = new Map<string, number>(); // key tenant/module/metric

  constructor(opts?: { windowMs?: number }) {
    const envWin = process.env.VERIFY_WINDOW_MS ? parseInt(process.env.VERIFY_WINDOW_MS, 10) : undefined;
    this.windowMs = opts?.windowMs ?? envWin ?? 900_000;
  }

  private expKey(tenant: string, mod: string, device: string): string {
    return `${tenant}/${mod}/${device}`;
  }

  private readingKey(tenant: string, mod: string, metric: string): string {
    return `${tenant}/${mod}/${metric}`;
  }

  onCmd(tenant: string, mod: string, device: string, payload: unknown, now: number): void {
    const parsed = parsePayload(payload);
    if (!parsed) return;
    const { action, policy_id, params } = parsed;
    const v = params && typeof (params as Record<string, unknown>).v === "string" ? (params as Record<string, unknown>).v as string : undefined;
    const spec = getSpec(device, action, v);
    if (!spec) return;
    // stop / set OFF no genera expectativa (ya retornó null)
    const rk = this.readingKey(tenant, mod, spec.metric);
    const baseline = this.lastReadings.has(rk) ? this.lastReadings.get(rk)! : null;
    const key = this.expKey(tenant, mod, device);
    const exp: Expectation = {
      ...spec,
      tenant,
      module: mod,
      device,
      policy_id,
      baseline,
      deadline: now + this.windowMs,
    };
    // una expectativa por (tenant,module,device) — nueva reemplaza vieja
    this.expectations.set(key, exp);
  }

  onReading(tenant: string, mod: string, metric: string, value: number, _now: number): void {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const rk = this.readingKey(tenant, mod, metric);
    this.lastReadings.set(rk, value);
    // Buscar expectativas de ese (tenant,module,metric)
    for (const [key, exp] of this.expectations.entries()) {
      if (exp.tenant !== tenant || exp.module !== mod || exp.metric !== metric) continue;
      if (exp.baseline === null) {
        // primera lectura posterior fija baseline y NO satisface aún
        exp.baseline = value;
        // actualizar en mapa (referencia ya mutada)
        this.expectations.set(key, exp);
        continue;
      }
      const satisfied =
        exp.direction === "up"
          ? value >= exp.baseline + exp.minDelta
          : value <= exp.baseline - exp.minDelta;
      if (satisfied) {
        this.expectations.delete(key);
      }
    }
  }

  tick(now: number): VerifyAlert[] {
    const out: VerifyAlert[] = [];
    for (const [key, exp] of this.expectations.entries()) {
      if (now >= exp.deadline) {
        const rk = this.readingKey(exp.tenant, exp.module, exp.metric);
        const last = this.lastReadings.has(rk) ? this.lastReadings.get(rk)! : null;
        out.push({
          tenant: exp.tenant,
          module: exp.module,
          name: "verification_failed",
          severity: "critical",
          device: exp.device,
          ts: now,
          detail: {
            kind: exp.kind,
            policy_id: exp.policy_id,
            metric: exp.metric,
            baseline: exp.baseline,
            last,
          },
        });
        this.expectations.delete(key);
      }
    }
    return out;
  }

  // para tests/debug
  pendingCount(): number {
    return this.expectations.size;
  }

  clear(): void {
    this.expectations.clear();
    this.lastReadings.clear();
  }
}
