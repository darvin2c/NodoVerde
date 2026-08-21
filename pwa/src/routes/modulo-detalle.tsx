import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Pencil, PlugZap, Archive } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Sparkline } from "@/components/sparkline.tsx";
import { healthVariant } from "@/lib/live.ts";
import { remediationFor } from "@/lib/remediation.ts";
import { formatDateTime, formatMetric, timeAgo } from "@/lib/format.ts";
import { useTenant } from "@/components/tenant-provider.tsx";

type Range = { min: number | null; max: number | null };

function rangeTone(v: number | null, r: Range): "ok" | "warn" | "neutral" {
  if (v == null || r.min == null || r.max == null) return "neutral";
  if (v < r.min || v > r.max) return "warn";
  return "ok";
}

export function ModuloDetallePage() {
  const { moduleId } = useParams({ strict: false }) as { moduleId: string };
  const { active } = useTenant();

  // Tenant: la finca activa; en modo "Todas" el servidor resuelve si el id no es ambiguo (ADR-0023)
  const { data, isLoading, error } = useQuery({
    queryKey: ["modules.detail", active, moduleId],
    queryFn: () => trpc.modules.detail.query(active ? { tenant: active, id: moduleId } : { id: moduleId }),
    refetchInterval: 15000,
    retry: false
  });

  // Las series necesitan el tenant resuelto — sale de la respuesta del detalle
  const resolvedTenant = (data?.module as Record<string, unknown> | undefined)?.tenant as string | undefined;

  const { data: ecSeries } = useQuery({
    queryKey: ["field.series", resolvedTenant, moduleId, "ec"],
    queryFn: () => trpc.field.series.query({ tenant: resolvedTenant!, module: moduleId, metric: "ec", hours: 24 }),
    refetchInterval: 60000,
    enabled: !!resolvedTenant
  });
  const { data: phSeries } = useQuery({
    queryKey: ["field.series", resolvedTenant, moduleId, "ph"],
    queryFn: () => trpc.field.series.query({ tenant: resolvedTenant!, module: moduleId, metric: "ph", hours: 24 }),
    refetchInterval: 60000,
    enabled: !!resolvedTenant
  });
  const { data: levelSeries } = useQuery({
    queryKey: ["field.series", resolvedTenant, moduleId, "level"],
    queryFn: () => trpc.field.series.query({ tenant: resolvedTenant!, module: moduleId, metric: "level", hours: 24 }),
    refetchInterval: 60000,
    enabled: !!resolvedTenant
  });

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;

  if (error || !data) {
    return (
      <Card>
        <CardHeader><CardTitle>{moduleId}</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {error ? (error as Error).message : "Módulo no encontrado en la DB."}
          </p>
          <Button variant="link" className="px-0" render={<Link to="/modulos" />}>← volver a módulos</Button>
        </CardContent>
      </Card>
    );
  }

  const m = data.module as Record<string, unknown>;
  const readings: Record<string, (typeof data.readings)[number]> = {};
  for (const r of data.readings) readings[r.metric] = r;
  const conf = data.confidence;
  const health = data.health;
  const displayName = (m.name as string | null) ?? moduleId;
  const retired = m.retired_at != null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" render={<Link to="/modulos" />} aria-label="volver">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold tracking-tight">
            {displayName}{" "}
            <span className="text-sm font-normal text-muted-foreground">· {moduleId} · {String(m.crop)}</span>
          </h1>
        </div>
        {retired && <Badge variant="outline">retirado</Badge>}
        <Badge variant={healthVariant(health?.state)}>{health?.state ?? "sin health"}</Badge>
      </div>

      {/* Configuración: nombre, fierro vinculado, retiro (escrituras gobernadas vía MCP, ADR-0022) */}
      <ConfigCard
        tenant={resolvedTenant ?? ""}
        moduleId={moduleId}
        name={(m.name as string | null) ?? null}
        retired={retired}
        hardware={data.hardware}
      />

      {/* Lecturas vs rangos del perfil */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReadingCard
          label="EC" unit="mS/cm"
          value={readings.ec?.value ?? null}
          time={readings.ec?.time}
          range={{ min: m.ec_min as number | null, max: m.ec_max as number | null }}
          series={ecSeries ?? []}
        />
        <ReadingCard
          label="pH"
          value={readings.ph?.value ?? null}
          time={readings.ph?.time}
          range={{ min: m.ph_min as number | null, max: m.ph_max as number | null }}
          series={phSeries ?? []}
        />
        <ReadingCard
          label="Temperatura agua" unit="°C"
          value={readings.temp?.value ?? null}
          time={readings.temp?.time}
          range={{ min: m.water_temp_min as number | null, max: m.water_temp_max as number | null }}
        />
        <ReadingCard
          label="Nivel tanque" unit="%"
          value={readings.level?.value ?? null}
          time={readings.level?.time}
          range={{ min: null, max: null }}
          series={levelSeries ?? []}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Confianza + dispositivos */}
        <Card>
          <CardHeader>
            <CardTitle>Confianza y dispositivos</CardTitle>
            <CardDescription>termómetro por fuente (ADR-0010) · estado por dispositivo</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>confianza global</span>
                <span>{conf ? `${Math.round(conf.v)}%` : "sin dato"}</span>
              </div>
              <Progress value={conf?.v ?? 0} />
            </div>
            {conf?.sources && Object.keys(conf.sources).length > 0 && (
              <div className="space-y-1.5">
                {Object.entries(conf.sources).map(([src, v]) => (
                  <div key={src} className="flex items-center gap-2">
                    <span className="w-20 text-xs text-muted-foreground">{src}</span>
                    <Progress value={v} className="h-1.5" />
                    <span className="w-10 text-right text-xs font-mono">{Math.round(v)}%</span>
                  </div>
                ))}
              </div>
            )}
            {health?.devices && Object.keys(health.devices).length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {Object.entries(health.devices).map(([dev, st]) => (
                  <Badge key={dev} variant={healthVariant(st)} className="text-[10px]">{dev}: {st}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Alertas del módulo */}
        <Card>
          <CardHeader>
            <CardTitle>Alertas recientes del módulo</CardTitle>
            <CardDescription>últimas 10 — con estado abierto/resuelto</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.alerts.length === 0 && (
              <p className="text-sm text-muted-foreground">Este módulo no ha generado alertas.</p>
            )}
            {data.alerts.map((a, i) => {
              const rem = remediationFor(a.name);
              return (
                <div key={i} className="flex items-center justify-between gap-3 rounded-lg border p-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{rem.title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {a.device ?? a.name} · {timeAgo(a.time)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!a.open && <Badge variant="outline">resuelta</Badge>}
                    <Badge variant={a.severity === "critical" ? "destructive" : a.severity === "warn" ? "warn" : "secondary"}>
                      {a.severity}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      {/* Perfil de cultivo */}
      <Card>
        <CardHeader>
          <CardTitle>Perfil de cultivo: {String(m.crop)}</CardTitle>
          <CardDescription>rangos objetivo — solo cambian con aprobación humana (ADR-0019)</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3 text-sm">
          <RangeRow label="EC" min={m.ec_min as number | null} max={m.ec_max as number | null} unit="mS/cm" />
          <RangeRow label="pH" min={m.ph_min as number | null} max={m.ph_max as number | null} />
          <RangeRow label="Temp. agua" min={m.water_temp_min as number | null} max={m.water_temp_max as number | null} unit="°C" />
          {typeof m.crop_notes === "string" && m.crop_notes && (
            <p className="text-xs text-muted-foreground sm:col-span-3 pt-1">{m.crop_notes}</p>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        análisis histórico profundo en <a className="underline text-primary" href="http://localhost:3001" target="_blank" rel="noreferrer">Grafana ↗</a>
        {" · "}verdad física vs publicado en el <a className="underline text-primary" href="http://localhost:1880/dashboard/lab" target="_blank" rel="noreferrer">laboratorio ↗</a>
      </p>
      <p className="sr-only">{formatDateTime(Date.now())}</p>
    </div>
  );
}

function ReadingCard({ label, value, unit, time, range, series }: {
  label: string;
  value: number | null;
  unit?: string;
  time?: string;
  range: Range;
  series?: Array<{ t: string; v: number }>;
}) {
  const tone = rangeTone(value, range);
  return (
    <Card className={tone === "warn" ? "border-warning/60" : ""}>
      <CardHeader className="pb-1">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-mono">
          {value != null ? formatMetric(value) : "—"}{value != null && unit ? <span className="text-sm text-muted-foreground"> {unit}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {tone === "warn" && (
          <Badge variant="warn">fuera de rango {range.min}–{range.max}{unit ? ` ${unit}` : ""}</Badge>
        )}
        {tone === "ok" && range.min != null && (
          <p className="text-xs text-muted-foreground">rango {range.min}–{range.max}{unit ? ` ${unit}` : ""}</p>
        )}
        {series && series.length > 1 && <Sparkline points={series} width={220} height={40} className="w-full" />}
        {time && <p className="text-[10px] text-muted-foreground">{timeAgo(time)}</p>}
      </CardContent>
    </Card>
  );
}

function RangeRow({ label, min, max, unit }: { label: string; min: number | null; max: number | null; unit?: string }) {
  return (
    <div className="flex justify-between rounded-md border px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{min ?? "?"} – {max ?? "?"}{unit ? ` ${unit}` : ""}</span>
    </div>
  );
}

// — Configuración del módulo (ADR-0022): renombrar, vincular fierro, retirar —
// Las escrituras van al MCP de dominio (gobernadas); la PWA nunca escribe la DB.

function ConfigCard({ tenant, moduleId, name, retired, hardware }: {
  tenant: string;
  moduleId: string;
  name: string | null;
  retired: boolean;
  hardware: { hw_id: string; claimed_by: string | null; claimed_at: string } | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [renameOpen, setRenameOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [newName, setNewName] = useState(name ?? "");
  const [hwId, setHwId] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["modules.detail", moduleId] });
    queryClient.invalidateQueries({ queryKey: ["modules.list"] });
    queryClient.invalidateQueries({ queryKey: ["overview.kpis"] });
  };

  const renameMut = useMutation({
    mutationFn: () => trpc.modules.update.mutate({ tenant, module: moduleId, name: newName.trim() }),
    onSuccess: () => {
      toast.success("Módulo renombrado", { description: "Home Assistant actualiza el área en segundos (evento meta)" });
      invalidate();
      setRenameOpen(false);
    },
    onError: (err) => toast.error("No se pudo renombrar", { description: (err as Error).message })
  });

  const claimMut = useMutation({
    mutationFn: () => trpc.modules.claim.mutate({ tenant, module: moduleId, hw_id: hwId.trim() }),
    onSuccess: () => {
      toast.success("Fierro vinculado", { description: `${hwId} → ${moduleId} — aparece en HA al primer mensaje` });
      invalidate();
      setClaimOpen(false);
      setHwId("");
    },
    onError: (err) => toast.error("No se pudo vincular", { description: (err as Error).message })
  });

  const retireMut = useMutation({
    mutationFn: () => trpc.modules.retire.mutate({ tenant, module: moduleId }),
    onSuccess: () => {
      toast.success("Módulo retirado", { description: "historia conservada — nada se borra (ADR-0011)" });
      invalidate();
      setRetireOpen(false);
      navigate({ to: "/modulos" });
    },
    onError: (err) => {
      toast.error("No se pudo retirar", { description: (err as Error).message });
      setRetireOpen(false);
    }
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Configuración</CardTitle>
        <CardDescription>provisionamiento gobernado — el portero de dominio valida cada cambio</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-48 text-sm">
          <span className="text-muted-foreground">Fierro: </span>
          {hardware ? (
            <span className="font-mono">{hardware.hw_id} <span className="text-xs text-muted-foreground">(claim {hardware.claimed_by ?? "?"})</span></span>
          ) : (
            <span className="text-muted-foreground">sin hardware vinculado</span>
          )}
        </div>
        {!retired && (
          <>
            <Button variant="outline" size="sm" onClick={() => { setNewName(name ?? ""); setRenameOpen(true); }}>
              <Pencil className="size-3.5" /> Renombrar
            </Button>
            {!hardware && (
              <Button variant="outline" size="sm" onClick={() => setClaimOpen(true)}>
                <PlugZap className="size-3.5" /> Vincular fierro
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setRetireOpen(true)}>
              <Archive className="size-3.5" /> Retirar
            </Button>
          </>
        )}
        {retired && <p className="text-xs text-muted-foreground">módulo retirado — solo lectura histórica</p>}

        <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Renombrar {moduleId}</DialogTitle>
              <DialogDescription>El nombre aparece en la PWA, el área de Home Assistant y el reporte del cerebro.</DialogDescription>
            </DialogHeader>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Mesa Norte" autoFocus />
            <DialogFooter>
              <Button onClick={() => renameMut.mutate()} disabled={newName.trim().length === 0 || renameMut.isPending}>
                {renameMut.isPending ? "Guardando…" : "Guardar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={claimOpen} onOpenChange={setClaimOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Vincular fierro a {moduleId}</DialogTitle>
              <DialogDescription>
                hw_id de fábrica del ESP32: 12 hex minúsculas (MAC sin dos puntos). Lo imprime el nodo al arrancar.
              </DialogDescription>
            </DialogHeader>
            <Input value={hwId} onChange={(e) => setHwId(e.target.value)} placeholder="020000000005" className="font-mono" autoFocus />
            <DialogFooter>
              <Button onClick={() => claimMut.mutate()} disabled={!/^[0-9a-f]{12}$/.test(hwId.trim()) || claimMut.isPending}>
                {claimMut.isPending ? "Vinculando…" : "Vincular"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={retireOpen} onOpenChange={setRetireOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Retirar {moduleId}</DialogTitle>
              <DialogDescription>
                Deja de aceptar telemetría y sale de Home Assistant. Su historia (telemetría, alertas, gastos) se conserva — nada se borra.
                Bloqueado si está en la campaña abierta.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRetireOpen(false)}>Cancelar</Button>
              <Button variant="destructive" onClick={() => retireMut.mutate()} disabled={retireMut.isPending}>
                {retireMut.isPending ? "Retirando…" : "Retirar módulo"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
