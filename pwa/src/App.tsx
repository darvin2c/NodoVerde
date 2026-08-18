import { useQuery } from "@tanstack/react-query";
import { trpc } from "./trpc.ts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./components/ui/card.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Progress } from "./components/ui/progress.tsx";
import { useEffect, useState } from "react";

// Tipos locales para confianza/health suscritos
type ConfidenceMsg = { tenant: string; module: string; v: number; ts: number; sources: Record<string, number> };
type HealthMsg = { tenant: string; module: string; state: string; ts: number; devices: Record<string, string> };

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-10 border-b bg-slate-950/80 backdrop-blur px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold tracking-tight">terraOS <span className="text-emerald-400">— portada</span></h1>
        <span className="text-xs text-slate-400">read-only · Fase 1</span>
      </header>

      <main className="mx-auto max-w-6xl p-4 grid gap-4 md:grid-cols-2">
        <SistemaSection />
        <FinanzasSection />
        <ModulosSection />
        <CampoSection />
        <PendientesSection />
        <CamarasSection />
      </main>

      <footer className="mx-auto max-w-6xl px-4 py-6 text-xs text-slate-500 flex flex-wrap gap-4">
        <a className="underline hover:text-slate-300" href="http://localhost:8124" target="_blank" rel="noreferrer">Home Assistant :8124</a>
        <a className="underline hover:text-slate-300" href="http://localhost:3001" target="_blank" rel="noreferrer">Grafana :3001</a>
        <span>·</span>
        <span>DB :5432 · MQTT :1883</span>
      </footer>
    </div>
  );
}

// ── SISTEMA ──
function SistemaSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["system.status"],
    queryFn: () => trpc.system.status.query(),
    refetchInterval: 10000
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>SISTEMA</CardTitle>
        <CardDescription>broker / DB / cerebro / sim — estado vivo</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading && <p className="text-slate-400">cargando…</p>}
        {error && <p className="text-red-400">sin conexión al servidor PWA</p>}
        {data && (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant={data.broker === "connected" ? "success" : "destructive"}>broker {data.broker === "connected" ? "✓" : "✗"} {data.broker}</Badge>
              <Badge variant={data.db === "ok" ? "success" : "destructive"}>DB {data.db}</Badge>
              <Badge variant="secondary">cerebro {Object.keys(data.healthSummary).length ? "observando" : "sin health"}</Badge>
            </div>
            <p className="text-slate-400">última telemetría: {data.lastTelemetry ? new Date(data.lastTelemetry).toLocaleString("es-PE") : "sin datos"}</p>
            {data.farm && (
              <p className="text-slate-400">finca: {data.farm.name}{data.farm.location_name ? ` — ${data.farm.location_name}` : ""}{data.farm.tz ? ` (${data.farm.tz})` : ""}</p>
            )}
            {Object.keys(data.healthSummary).length > 0 && (
              <p className="text-slate-400">módulos por estado: {Object.entries(data.healthSummary).map(([k, v]) => `${k}:${v}`).join(" · ")}</p>
            )}
            <div className="pt-2 flex gap-3 text-xs">
              <a className="underline text-emerald-400" href="http://localhost:8124" target="_blank" rel="noreferrer">abrir HA</a>
              <a className="underline text-emerald-400" href="http://localhost:3001" target="_blank" rel="noreferrer">abrir Grafana</a>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── MÓDULOS ──
function ModulosSection() {
  const { data: mods } = useQuery({
    queryKey: ["modules.list"],
    queryFn: () => trpc.modules.list.query()
  });
  const [conf, setConf] = useState<Record<string, ConfidenceMsg>>({});
  const [health, setHealth] = useState<Record<string, HealthMsg>>({});

  useEffect(() => {
    let cancelled = false;
    // confianza
    const subC = trpc.modules.confidence.subscribe(undefined, {
      onData(d) { if (!cancelled) setConf((prev) => ({ ...prev, [`${d.tenant}/${d.module}`]: d })); },
      onError() { /* silencio honesto */ }
    });
    const subH = trpc.modules.health.subscribe(undefined, {
      onData(d) { if (!cancelled) setHealth((prev) => ({ ...prev, [`${d.tenant}/${d.module}`]: d })); },
      onError() {}
    });
    return () => { cancelled = true; subC.unsubscribe(); subH.unsubscribe(); };
  }, []);

  const list = mods ?? [];
  // Si no hay módulos en DB, mostrar placeholder honesto
  if (list.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>MÓDULOS</CardTitle><CardDescription>confianza por módulo (ADR-0010)</CardDescription></CardHeader>
        <CardContent><p className="text-sm text-slate-400">sin módulos — verifica seed de DB</p></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>MÓDULOS</CardTitle><CardDescription>confianza global + estado health</CardDescription></CardHeader>
      <CardContent className="grid gap-3">
        {list.map((m) => {
          const key = `${m.tenant}/${m.id}`;
          const c = conf[key];
          const h = health[key];
          const val = c?.v ?? 0;
          const state = h?.state ?? "—";
          const color = state === "ok" ? "success" : state === "degraded" ? "warn" : state === "offline" || state === "blind" ? "destructive" : "secondary";
          return (
            <div key={key} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{m.id} <span className="text-xs text-slate-400">· {m.crop}</span></span>
                <Badge variant={color as never}>{state}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 w-12">{val ? `${Math.round(val)}%` : "—"}</span>
                <Progress value={val} />
              </div>
              {c?.sources && Object.keys(c.sources).length > 0 && (
                <p className="text-xs text-slate-500">fuentes: {Object.entries(c.sources).map(([k, v]) => `${k}:${Math.round(v)}%`).join(" · ")}</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── CAMPO ──
function CampoSection() {
  const { data } = useQuery({
    queryKey: ["field.latest"],
    queryFn: () => trpc.field.latest.query({ tenant: "demo" }),
    refetchInterval: 15000
  });

  const hasData = data && Object.keys(data).length > 0;

  return (
    <Card>
      <CardHeader><CardTitle>CAMPO</CardTitle><CardDescription>última lectura EC / pH / temp / tanque por módulo</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {!hasData && <p className="text-sm text-slate-400">sin telemetría reciente</p>}
        {hasData && Object.entries(data).map(([mod, metrics]) => (
          <div key={mod} className="rounded-lg border p-3">
            <p className="font-medium text-sm mb-2">{mod}</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {["ec", "ph", "temp", "level", "flow", "air_temp", "humidity"].map((k) => {
                const v = (metrics as Record<string, { value: number | null }>)[k];
                return (
                  <div key={k} className="flex justify-between border-b border-slate-800 py-1">
                    <span className="text-slate-400">{k}</span>
                    <span className="font-mono">{v?.value != null ? String(v.value) : "—"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <a className="text-xs underline text-emerald-400" href="http://localhost:3001" target="_blank" rel="noreferrer">ver en Grafana →</a>
      </CardContent>
    </Card>
  );
}

// ── FINANZAS ──
function FinanzasSection() {
  const { data } = useQuery({
    queryKey: ["finance.monthSummary"],
    queryFn: () => trpc.finance.monthSummary.query({ tenant: "demo" }),
    refetchInterval: 30000
  });

  if (!data) return (
    <Card><CardHeader><CardTitle>FINANZAS</CardTitle></CardHeader><CardContent><p className="text-sm text-slate-400">cargando…</p></CardContent></Card>
  );

  if (data.empty) {
    return (
      <Card>
        <CardHeader><CardTitle>FINANZAS</CardTitle><CardDescription>resumen del mes {data.month}</CardDescription></CardHeader>
        <CardContent><p className="text-sm text-slate-400">sin movimientos — estado vacío honesto</p></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>FINANZAS</CardTitle><CardDescription>mes {data.month} · {data.count} movimientos</CardDescription></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between"><span className="text-slate-400">ingresos</span><span className="font-mono text-emerald-400">S/ {data.ingresos.toFixed(2)}</span></div>
        <div className="flex justify-between"><span className="text-slate-400">gastos</span><span className="font-mono text-red-400">S/ {data.gastos.toFixed(2)}</span></div>
        <div className="flex justify-between border-t pt-2 font-semibold"><span>balance</span><span className="font-mono">S/ {data.balance.toFixed(2)}</span></div>
        <p className="text-xs text-slate-500">cálculo en SQL (SUM), no en el render</p>
      </CardContent>
    </Card>
  );
}

// ── PENDIENTES ──
function PendientesSection() {
  const { data } = useQuery({
    queryKey: ["pending.alerts"],
    queryFn: () => trpc.pending.alerts.query({ tenant: "demo", limit: 10 }),
    refetchInterval: 15000
  });

  return (
    <Card>
      <CardHeader><CardTitle>PENDIENTES</CardTitle><CardDescription>alertas warn/critical + aprobaciones</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {(!data || data.length === 0) && <p className="text-slate-400">sin alertas — todo tranquilo</p>}
        {data?.map((a, i) => (
          <div key={i} className="flex items-start justify-between gap-2 border-b border-slate-800 py-2">
            <div>
              <p className="font-medium">{a.name} <span className="text-xs text-slate-400">· {a.module}</span></p>
              {a.device && <p className="text-xs text-slate-500">{a.device}</p>}
            </div>
            <Badge variant={a.severity === "critical" ? "destructive" : "warn"}>{a.severity}</Badge>
          </div>
        ))}
        <div className="rounded bg-slate-900 p-2 text-xs text-slate-400">aprobaciones: Fase 3 — placeholder</div>
      </CardContent>
    </Card>
  );
}

// ── CÁMARAS ──
function CamarasSection() {
  const { data } = useQuery({
    queryKey: ["cameras.lastPhoto"],
    queryFn: () => trpc.cameras.lastPhoto.query({ tenant: "demo" }),
    refetchInterval: 30000
  });

  const empty = !data || data.length === 0;

  return (
    <Card>
      <CardHeader><CardTitle>CÁMARAS</CardTitle><CardDescription>último evento photo por módulo</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {empty && <p className="text-sm text-slate-400">sin cámara Fase 0 — sin fotos registradas</p>}
        {!empty && data.map((r) => (
          <div key={r.module} className="rounded-lg border p-3 flex justify-between items-center">
            <span className="text-sm font-medium">{r.module} · {r.device}</span>
            <span className="text-xs text-slate-400">{new Date(r.time).toLocaleString("es-PE")}</span>
          </div>
        ))}
        <a className="text-xs underline text-emerald-400" href="http://localhost:9000" target="_blank" rel="noreferrer">abrir MinIO :9000 →</a>
      </CardContent>
    </Card>
  );
}
