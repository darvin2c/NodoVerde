// src/notify.ts — postPolicyEvent fire-and-forget al bridge
import { BRIDGE_URL, OPENCLAW_HOOK_TOKEN } from "./config.js";

export type PolicyEventKind =
  | "proposal_pending"
  | "action_executed"
  | "work_order_created"
  | "needs_data";

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function buildPolicyMessage(
  kind: PolicyEventKind,
  tenant: string,
  mod: string,
  opts: {
    actionId?: string;
    policyId?: string;
    device?: string;
    action?: string;
    kindDetail?: string;
    needs?: string[];
    actionClass?: string;
  } = {},
): string {
  if (kind === "proposal_pending") {
    const sid = opts.actionId ? shortId(opts.actionId) : opts.policyId ? shortId(opts.policyId) : mod;
    const dev = opts.device ?? opts.actionClass ?? "acción";
    const act = opts.action ?? "";
    const tail = act ? ` ${act}` : "";
    return `🔐 Aprobación pendiente [${sid}]: ${dev}${tail} en ${tenant}/${mod} — requiere aprobación`;
  }
  if (kind === "action_executed") {
    const dev = opts.device ?? opts.actionClass ?? "acción";
    const act = opts.action ?? "";
    return `✅ Ejecutado: ${dev} ${act} en ${tenant}/${mod}`;
  }
  if (kind === "work_order_created") {
    const k = opts.kindDetail ?? "tarea";
    return `📋 Orden de trabajo [${mod}]: ${k} — instrucciones`;
  }
  if (kind === "needs_data") {
    const needs = opts.needs && opts.needs.length > 0 ? opts.needs.join(", ") : "datos";
    const act = opts.actionClass ?? opts.device ?? "acción";
    return `📉 Confianza insuficiente para ${act}: falta ${needs} en ${tenant}/${mod}`;
  }
  return `evento ${kind} en ${tenant}/${mod}`;
}

export async function postPolicyEvent(
  kind: PolicyEventKind,
  tenant: string,
  mod: string,
  message?: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!BRIDGE_URL) return;
  const token = OPENCLAW_HOOK_TOKEN ?? "";
  const url = `${BRIDGE_URL}/policy-event?token=${encodeURIComponent(token)}`;
  const body = {
    kind,
    tenant,
    module: mod,
    message: message ?? buildPolicyMessage(kind, tenant, mod, extra as never),
    ...(extra ?? {}),
  };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).catch((e) => {
      // fetch catch ya loguea abajo
      throw e;
    });
    clearTimeout(t);
  } catch (err) {
    console.warn("[terra-policy] bridge postPolicyEvent falló (ignorado)", kind, String(err));
  }
}
