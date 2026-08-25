// src/policy.ts — pipeline del portero (propose / approve / reject)
import { randomUUID } from "node:crypto";
import {
  ACTION_CLASSES,
  CLASS_OBSERVED_METRIC,
  type ActionClass,
} from "./config.js";
import { getModuleCapabilities, classOfDevice } from "./capabilities.js";
import {
  checkTimeWindow,
  checkConfidence,
  checkHealth,
  checkHardCeiling,
  validateParams,
} from "./rules.js";
import {
  getModuleWithCrop,
  lastExecutedAt,
  hasPendingFor,
  insertActionRequest,
  getAction,
  markExecuted,
  decideAction,
} from "./db.js";
import {
  getConfidence,
  getHealth,
  readingsForModule,
} from "./state.js";
import { postPolicyEvent, buildPolicyMessage } from "./notify.js";

// Publisher inyectable (para tests y runtime)
export type Publisher = (
  topic: string,
  payload: string,
  opts: { qos: 0 | 1; retain: boolean },
) => Promise<void> | void;

let _publisher: Publisher | null = null;

export function setPublisher(fn: Publisher | null): void {
  _publisher = fn;
}

export function getPublisher(): Publisher | null {
  return _publisher;
}

async function publishCmd(
  tenant: string,
  mod: string,
  device: string,
  action: string,
  policyId: string,
  params: Record<string, unknown> | null,
): Promise<void> {
  if (!_publisher) return;
  const topic = `terra/${tenant}/${mod}/${device}/cmd`;
  const payload = JSON.stringify({ action, policy_id: policyId, params: params ?? undefined });
  await _publisher(topic, payload, { qos: 1, retain: false });
}

async function publishReadRequest(
  tenant: string,
  mod: string,
  sensorDevice: string,
): Promise<void> {
  if (!_publisher) return;
  const topic = `terra/${tenant}/${mod}/${sensorDevice}/request/read`;
  await _publisher(topic, JSON.stringify({}), { qos: 1, retain: false });
}

// ---------------------------------------------------------------------------
// proposeAction — usado por MCP propose_action y por intercept human request
// ---------------------------------------------------------------------------
export type ProposeInput = {
  tenant: string;
  module: string;
  device?: string; // opcional si viene action_class (ADR-0028): el portero elige el dispositivo capaz
  action_class?: ActionClass;
  action: string;
  params?: Record<string, unknown> | null;
  requested_by: string;
  reason?: string | null;
  source?: "agent" | "human";
};

export type ProposeResult =
  | { status: "pending"; action_id: string; policy_id: string }
  | { status: "executed"; action_id: string; policy_id: string }
  | { status: "needs_data"; action_id: string; policy_id: string; needs: string[] }
  | { status: "rejected"; reason: string; action_id?: string; policy_id?: string };

export async function proposeAction(input: ProposeInput): Promise<ProposeResult> {
  const tenant = input.tenant;
  const mod = input.module;
  const rawAction = input.action;
  const requestedBy = input.requested_by;
  const source = input.source ?? "agent";

  // 0. exactamente uno de device/action_class es requerido (si vienen ambos,
  //    device manda y se valida coherencia contra su clase provisionada)
  if (!input.device && !input.action_class) {
    return { status: "rejected", reason: "device o action_class requerido" };
  }

  // audit: la fila rechazada guarda el MOTIVO del rechazo (y la justificación original si hubo)
  const auditReason = (motive: string): string =>
    input.reason ? `${motive} | propuesta: ${input.reason}` : motive;

  // 1. classify
  // 1. resolución desde capabilities provisionadas (ADR-0028 — DB, no constante)
  const caps = await getModuleCapabilities(tenant, mod);
  let device: string;
  let actionClass: ActionClass;
  if (input.device) {
    const cls = classOfDevice(caps, input.device);
    if (!cls) {
      return { status: "rejected", reason: `unknown_device_capability: ${input.device}` };
    }
    if (input.action_class && input.action_class !== cls) {
      return { status: "rejected", reason: `class_mismatch: ${input.device} es ${cls}, no ${input.action_class}` };
    }
    device = input.device;
    actionClass = cls;
  } else {
    actionClass = input.action_class!; // validado arriba: exactamente uno presente
    const capable = caps.classToDevices.get(actionClass)?.[0];
    if (!capable) {
      return { status: "rejected", reason: `no_capable_device: ${actionClass} en ${tenant}/${mod}` };
    }
    device = capable;
  }
  const cfg = ACTION_CLASSES[actionClass];

  // 2. validate params (normaliza duration_ms, default, etc.)
  const vres = validateParams(actionClass, rawAction, input.params as Record<string, unknown> | null);
  if (!vres.ok) {
    const policyId = `pol-${randomUUID()}`;
    const row = await insertActionRequest({
      tenant,
      module: mod,
      device,
      action: rawAction,
      params: (input.params as Record<string, unknown> | null) ?? null,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: auditReason(vres.reason),
      status: "rejected",
      confidence: null,
    }).catch(() => null);
    return { status: "rejected", reason: vres.reason, action_id: row?.id, policy_id: row?.policy_id ?? policyId };
  }
  const normParams = vres.params;
  const normAction = rawAction.trim().toLowerCase(); // ya validado

  // stop / set OFF nunca energizan: apagar es siempre seguro — no aplican techo duro,
  // ventana horaria, confianza mínima ni rate limit (salud sí: si el edge está caído
  // el cmd no llega al fierro y el rechazo es honesto).
  const energizes = normAction === "start" || (normAction === "set" && normParams.v === "ON");

  // 3. módulo + crop + tz
  const modInfo = await getModuleWithCrop(tenant, mod);
  if (!modInfo) {
    const policyId = `pol-${randomUUID()}`;
    const row = await insertActionRequest({
      tenant,
      module: mod,
      device,
      action: normAction,
      params: normParams,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: auditReason(`módulo no existe: ${tenant}/${mod}`),
      status: "rejected",
      confidence: null,
    }).catch(() => null);
    return { status: "rejected", reason: `módulo no existe: ${tenant}/${mod}`, action_id: row?.id, policy_id: row?.policy_id ?? policyId };
  }

  // ADR-0025: actuación BIOLÓGICA (dosificar nutriente/pH) exige lote activo.
  // Mesa libre (crop null = sin lote) → rechazo honesto: no hay cultivo que
  // alimentar. La infraestructura (bomba/válvula) sigue libre para mantenimiento,
  // y stop/OFF siempre pasa (apagar es seguro).
  const biological = actionClass === "dose_nutrient" || actionClass === "dose_ph";
  if (biological && energizes && modInfo.crop === null) {
    const policyId = `pol-${randomUUID()}`;
    const reason = `no_active_batch: ${mod} está libre (sin lote activo) — no se dosifica sin cultivo`;
    const row = await insertActionRequest({
      tenant,
      module: mod,
      device,
      action: normAction,
      params: normParams,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: auditReason(reason),
      status: "rejected",
      confidence: null,
    }).catch(() => null);
    return { status: "rejected", reason, action_id: row?.id, policy_id: row?.policy_id ?? policyId };
  }

  // snapshots para decision
  const healthState = getHealth(tenant, mod);
  const confEntry = getConfidence(tenant, mod);
  const confidenceSources = confEntry?.sources ?? null;
  const confidenceSnapshot = confEntry ? { v: confEntry.v, sources: confEntry.sources, ts: confEntry.ts } : null;
  const readings = readingsForModule(tenant, mod);

  // 4. health (blind/offline → rejected)
  const hres = checkHealth(healthState ?? null);
  if (!hres.ok) {
    const row = await insertActionRequest({
      tenant,
      module: mod,
      device,
      action: normAction,
      params: normParams,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: auditReason(hres.reason),
      status: "rejected",
      confidence: confidenceSnapshot as unknown as Record<string, unknown> | null,
    });
    return { status: "rejected", reason: hres.reason, action_id: row.id, policy_id: row.policy_id };
  }

  // 5. techo duro (solo acciones que energizan; rangos null si mesa libre —
  //    checkHardCeiling ya tolera crop null, y el techo de nivel no depende del cultivo)
  const ceiling = energizes
    ? checkHardCeiling(actionClass, readings,
        modInfo.crop === null
          ? null
          : { ec_min: modInfo.ec_min!, ec_max: modInfo.ec_max!, ph_min: modInfo.ph_min!, ph_max: modInfo.ph_max! })
    : ({ ok: true } as const);
  if (!ceiling.ok) {
    const row = await insertActionRequest({
      tenant,
      module: mod,
      device,
      action: normAction,
      params: normParams,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: auditReason(ceiling.reason),
      status: "rejected",
      confidence: confidenceSnapshot as unknown as Record<string, unknown> | null,
    });
    return { status: "rejected", reason: ceiling.reason, action_id: row.id, policy_id: row.policy_id };
  }

  // 6. serialización (pending mismo device)
  const pending = await hasPendingFor(tenant, mod, device);
  if (pending) {
    const row = await insertActionRequest({
      tenant,
      module: mod,
      device,
      action: normAction,
      params: normParams,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: auditReason("already_pending"),
      status: "rejected",
      confidence: confidenceSnapshot as unknown as Record<string, unknown> | null,
    });
    return { status: "rejected", reason: "already_pending", action_id: row.id, policy_id: row.policy_id };
  }

  // 7. rate limit — solo acciones que ENERGIZAN (start / set ON). stop y set OFF siempre
  // pasan: en modo manual, quien abrió la válvula debe poder cerrarla.
  const last = energizes ? await lastExecutedAt(tenant, mod, actionClass) : null;
  if (last) {
    const elapsed = Date.now() - last.getTime();
    if (elapsed < cfg.rateLimitMs) {
      const row = await insertActionRequest({
        tenant,
        module: mod,
        device,
        action: normAction,
        params: normParams,
        action_class: actionClass,
        source,
        requested_by: requestedBy,
        reason: auditReason("rate_limited"),
        status: "rejected",
        confidence: confidenceSnapshot as unknown as Record<string, unknown> | null,
      });
      return { status: "rejected", reason: "rate_limited", action_id: row.id, policy_id: row.policy_id };
    }
  }

  // 8. ventana horaria (solo energizantes)
  const farmNow = new Date();
  const wres = energizes
    ? checkTimeWindow(actionClass, farmNow, modInfo.tz ?? undefined)
    : ({ ok: true } as const);
  if (!wres.ok) {
    const row = await insertActionRequest({
      tenant,
      module: mod,
      device,
      action: normAction,
      params: normParams,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: auditReason(wres.reason),
      status: "rejected",
      confidence: confidenceSnapshot as unknown as Record<string, unknown> | null,
    });
    return { status: "rejected", reason: wres.reason, action_id: row.id, policy_id: row.policy_id };
  }

  // 9. confianza (solo energizantes: apagar no requiere saber EC/nivel)
  const cres = energizes
    ? checkConfidence(confidenceSources, actionClass)
    : ({ ok: true } as const);
  if (!cres.ok) {
    const row = await insertActionRequest({
      tenant,
      module: mod,
      device,
      action: normAction,
      params: normParams,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: auditReason(`needs_data: faltan ${cres.needs.join(", ")}`),
      status: "needs_data",
      confidence: confidenceSnapshot as unknown as Record<string, unknown> | null,
    });
    // publicar request/read al sensor de la clase
    const sensor = caps.metricToDevice.get(CLASS_OBSERVED_METRIC[actionClass]);
    if (sensor) {
      await publishReadRequest(tenant, mod, sensor).catch(() => {});
    }
    const msg = buildPolicyMessage("needs_data", tenant, mod, {
      needs: cres.needs,
      actionClass: actionClass,
    });
    void postPolicyEvent("needs_data", tenant, mod, msg);
    return { status: "needs_data", action_id: row.id, policy_id: row.policy_id, needs: cres.needs };
  }

  // 10. autonomy
  if (cfg.autonomy === "autonomous") {
    const policyId = `pol-${randomUUID()}`;
    // publicar ANTES de auditar como executed: si el bus falla, la fila queda failed (nunca executed sin cmd)
    let publishError: unknown = null;
    try {
      await publishCmd(tenant, mod, device, normAction, policyId, normParams);
    } catch (err) {
      publishError = err;
    }
    const row = await insertActionRequest({
      policy_id: policyId,
      tenant,
      module: mod,
      device,
      action: normAction,
      params: normParams,
      action_class: actionClass,
      source,
      requested_by: requestedBy,
      reason: publishError ? auditReason("publish_cmd_falló") : (input.reason ?? null),
      status: publishError ? "failed" : "executed",
      confidence: confidenceSnapshot as unknown as Record<string, unknown> | null,
      decided_by: source === "human" ? requestedBy : null,
    });
    if (publishError) {
      return { status: "rejected", reason: "publish_cmd_falló", action_id: row.id, policy_id: row.policy_id };
    }
    const msg = buildPolicyMessage("action_executed", tenant, mod, {
      device,
      action: normAction,
    });
    void postPolicyEvent("action_executed", tenant, mod, msg);
    return { status: "executed", action_id: row.id, policy_id: row.policy_id };
  }

  // supervised → pending
  const row = await insertActionRequest({
    tenant,
    module: mod,
    device,
    action: normAction,
    params: normParams,
    action_class: actionClass,
    source,
    requested_by: requestedBy,
    reason: input.reason ?? null,
    status: "pending",
    confidence: confidenceSnapshot as unknown as Record<string, unknown> | null,
  });
  const msg = buildPolicyMessage("proposal_pending", tenant, mod, {
    actionId: row.id,
    device,
    action: normAction,
  });
  void postPolicyEvent("proposal_pending", tenant, mod, msg);
  return { status: "pending", action_id: row.id, policy_id: row.policy_id };
}

// ---------------------------------------------------------------------------
// approve / reject
// ---------------------------------------------------------------------------
export async function approveAction(
  id: string,
  decidedBy: string,
): Promise<{ status: string; action_id?: string; policy_id?: string; needs?: string[]; reason?: string }> {
  const row = await getAction(id);
  if (!row) return { status: "not_found", reason: "acción no existe" };
  if (row.status !== "pending") return { status: "conflict", reason: `estado ${row.status} no es pending` };

  const tenant = row.tenant as string;
  const mod = row.module as string;
  const device = row.device as string;
  const actionClass = row.action_class as ActionClass;
  const cfg = ACTION_CLASSES[actionClass];
  if (!cfg) return { status: "rejected", reason: `clase desconocida ${actionClass}` };

  // re-fetch module info
  const modInfo = await getModuleWithCrop(tenant, mod);
  if (!modInfo) return { status: "rejected", reason: `módulo no existe` };

  const rowParams = (row.params ?? {}) as Record<string, unknown>;
  const rowEnergizes = row.action === "start" || (row.action === "set" && rowParams.v === "ON");

  // ADR-0025: si el lote cerró mientras la acción esperaba aprobación, la mesa
  // quedó libre → la dosificación pendiente ya no tiene cultivo. Rechazo honesto.
  const biological = actionClass === "dose_nutrient" || actionClass === "dose_ph";
  if (biological && rowEnergizes && modInfo.crop === null) {
    await decideAction(id, "rejected", decidedBy).catch(() => {});
    return { status: "rejected", reason: `no_active_batch: ${mod} quedó libre mientras esperaba aprobación — no se dosifica sin cultivo` };
  }

  // re-validar health
  const healthState = getHealth(tenant, mod);
  const hres = checkHealth(healthState ?? null);
  if (!hres.ok) {
    // mantener pending? spec: approve re-valida health/confianza/rate; si falla confianza → pending. Para health, rechazar?
    // Decidimos rechazar y actualizar fila a rejected para no bloquear.
    await decideAction(id, "rejected", decidedBy).catch(() => {});
    return { status: "rejected", reason: hres.reason };
  }

  // rate limit re-check — solo acciones que energizan (start / set ON); stop/OFF siempre pasan
  const last = rowEnergizes ? await lastExecutedAt(tenant, mod, actionClass) : null;
  if (last) {
    const elapsed = Date.now() - last.getTime();
    if (elapsed < cfg.rateLimitMs) {
      return { status: "rejected", reason: "rate_limited" };
    }
  }

  // ventana / confianza / techo: solo si la acción energiza (apagar es siempre seguro)
  if (rowEnergizes) {
    // ventana
    const wres = checkTimeWindow(actionClass, new Date(), modInfo.tz ?? undefined);
    if (!wres.ok) {
      return { status: "rejected", reason: wres.reason };
    }

    // confianza
    const confEntry = getConfidence(tenant, mod);
    const cres = checkConfidence(confEntry?.sources ?? null, actionClass);
    if (!cres.ok) {
      // NO actualizar fila, queda pending
      const sensor = (await getModuleCapabilities(tenant, mod)).metricToDevice.get(CLASS_OBSERVED_METRIC[actionClass]);
      if (sensor) await publishReadRequest(tenant, mod, sensor).catch(() => {});
      const msg = buildPolicyMessage("needs_data", tenant, mod, { needs: cres.needs, actionClass });
      void postPolicyEvent("needs_data", tenant, mod, msg);
      return { status: "needs_data", needs: cres.needs, action_id: row.id, policy_id: row.policy_id as string };
    }

    // techo duro re-check (por si lectura cambió)
    const readings = readingsForModule(tenant, mod);
    const ceiling = checkHardCeiling(actionClass, readings,
      modInfo.crop === null
        ? null
        : { ec_min: modInfo.ec_min!, ec_max: modInfo.ec_max!, ph_min: modInfo.ph_min!, ph_max: modInfo.ph_max! });
    if (!ceiling.ok) {
      await decideAction(id, "rejected", decidedBy).catch(() => {});
      return { status: "rejected", reason: ceiling.reason };
    }
  }

  // ok → publicar cmd y marcar executed (si el bus falla: failed, nunca executed sin cmd)
  const params = (row.params as Record<string, unknown> | null) ?? null;
  try {
    await publishCmd(tenant, mod, device, row.action as string, row.policy_id as string, params);
  } catch {
    await decideAction(id, "failed", decidedBy).catch(() => {});
    return { status: "failed", reason: "publish_cmd_falló", action_id: row.id, policy_id: row.policy_id as string };
  }
  const updated = await markExecuted(id, decidedBy);
  if (!updated) {
    return { status: "conflict", reason: "no se pudo marcar executed (quizá ya no está pending)" };
  }
  const msg = buildPolicyMessage("action_executed", tenant, mod, { device, action: row.action as string });
  void postPolicyEvent("action_executed", tenant, mod, msg);
  return { status: "executed", action_id: updated.id, policy_id: updated.policy_id as string };
}

export async function rejectAction(
  id: string,
  decidedBy: string,
  reason?: string | null,
): Promise<{ ok: boolean; reason?: string; row?: unknown }> {
  const row = await getAction(id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") return { ok: false, reason: `estado ${row.status} no es pending` };
  const updated = await decideAction(id, "rejected", decidedBy);
  if (!updated) return { ok: false, reason: "conflict" };
  // No notificar rechazos por ahora (solo log)
  console.log(`[terra-policy] rechazada ${id} por ${decidedBy} ${reason ?? ""}`);
  return { ok: true, row: updated };
}
