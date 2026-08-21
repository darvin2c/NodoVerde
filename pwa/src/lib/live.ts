import { useEffect, useState } from "react";
import { trpc } from "../trpc.ts";

export type ConfidenceMsg = { tenant: string; module: string; v: number; ts: number; sources: Record<string, number> };
export type HealthMsg = { tenant: string; module: string; state: string; ts: number; devices: Record<string, string> };

export type LiveMaps = {
  confidence: Record<string, ConfidenceMsg>;
  health: Record<string, HealthMsg>;
};

// Suscripción viva a confianza + salud por módulo (SSE vía tRPC subscription).
// Clave: `${tenant}/${module}`. Reconecta solo al desmontar.
export function useLiveModules(): LiveMaps {
  const [confidence, setConfidence] = useState<Record<string, ConfidenceMsg>>({});
  const [health, setHealth] = useState<Record<string, HealthMsg>>({});

  useEffect(() => {
    let cancelled = false;
    const subC = trpc.modules.confidence.subscribe(undefined, {
      onData(d) { if (!cancelled) setConfidence((prev) => ({ ...prev, [`${d.tenant}/${d.module}`]: d })); },
      onError() { /* silencio honesto: sin stream, las páginas muestran lo último conocido */ }
    });
    const subH = trpc.modules.health.subscribe(undefined, {
      onData(d) { if (!cancelled) setHealth((prev) => ({ ...prev, [`${d.tenant}/${d.module}`]: d })); },
      onError() {}
    });
    return () => { cancelled = true; subC.unsubscribe(); subH.unsubscribe(); };
  }, []);

  return { confidence, health };
}

export type HealthState = "ok" | "degraded" | "offline" | "blind";

export function healthVariant(state: string | undefined): "success" | "warn" | "destructive" | "secondary" {
  if (state === "ok") return "success";
  if (state === "degraded") return "warn";
  if (state === "offline" || state === "blind") return "destructive";
  return "secondary";
}
