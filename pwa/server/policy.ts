export const POLICY_URL = process.env.POLICY_URL ?? "http://localhost:7762";
export const POLICY_ADMIN_TOKEN = process.env.POLICY_ADMIN_TOKEN ?? "dev-admin-token";

export class PolicyError extends Error {
  status?: number;
  body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson<T>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | undefined>;
  } = {}
): Promise<T> {
  let url = `${POLICY_URL}${path}`;
  if (opts.params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== null && v !== "") sp.set(k, v);
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${POLICY_ADMIN_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else {
      data = null;
    }

    if (!res.ok) {
      let msg: string;
      if (data && typeof data === "object" && data !== null) {
        const o = data as Record<string, unknown>;
        msg = String(o.error ?? o.message ?? o.reason ?? text ?? `policy ${res.status}`);
      } else {
        msg = String((data as string) ?? text ?? `policy ${res.status}`);
      }
      throw new PolicyError(msg, res.status, data);
    }

    return data as T;
  } catch (err) {
    if (err instanceof PolicyError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new PolicyError("timeout al contactar al portero (5s)", 504);
    }
    throw new PolicyError((err as Error)?.message ?? String(err));
  } finally {
    clearTimeout(timeout);
  }
}
