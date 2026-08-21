import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
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
  DialogTrigger,
} from "@/components/ui/dialog.tsx";
import { useLiveModules, healthVariant } from "@/lib/live.ts";
import { timeAgo, formatMetric } from "@/lib/format.ts";
import { useTenant } from "@/components/tenant-provider.tsx";

type ModuleRow = {
  tenant: string; id: string; name: string | null; crop: string; retired_at: string | null;
};

export function ModulosPage() {
  const { active, farmName } = useTenant();
  const { data: mods, isLoading } = useQuery({
    queryKey: ["modules.list"],
    queryFn: () => trpc.modules.list.query()
  });
  const { data: field } = useQuery({
    queryKey: ["field.latest", active],
    queryFn: () => trpc.field.latest.query(active ? { tenant: active } : undefined),
    refetchInterval: 15000
  });
  const live = useLiveModules();

  const visibles = ((mods ?? []) as ModuleRow[]).filter((m) => active === null || m.tenant === active);
  const activos = visibles.filter((m) => !m.retired_at);
  const retirados = visibles.filter((m) => m.retired_at);
  // Agrupar por finca solo en modo "Todas" (ADR-0023)
  const farmIds = [...new Set(visibles.map((m) => m.tenant))].sort();
  const groupByFarm = active === null && farmIds.length > 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          unidad lógica de cultivo: nombre humano + fierro vinculado (ADR-0022)
        </p>
        <NuevoModuloDialog />
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>
      ) : activos.length === 0 && retirados.length === 0 ? (
        <Card>
          <CardHeader><CardTitle>Módulos</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">
            {active === null
              ? "Sin módulos registrados — selecciona una finca y crea el primero con \"Nuevo módulo\"."
              : `Sin módulos en ${farmName(active)} — crea el primero con "Nuevo módulo".`}
          </p></CardContent>
        </Card>
      ) : groupByFarm ? (
        farmIds.map((farmId) => {
          const farmActivos = activos.filter((m) => m.tenant === farmId);
          const farmRetirados = retirados.filter((m) => m.tenant === farmId);
          if (farmActivos.length === 0 && farmRetirados.length === 0) return null;
          return (
            <div key={farmId} className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{farmName(farmId)}</p>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {farmActivos.map((m) => (
                  <ModuleCard key={`${m.tenant}/${m.id}`} m={m} field={field} live={live} />
                ))}
              </div>
              {farmRetirados.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {farmRetirados.map((m) => <RetiredCard key={`${m.tenant}/${m.id}`} m={m} />)}
                </div>
              )}
            </div>
          );
        })
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {activos.map((m) => (
              <ModuleCard key={`${m.tenant}/${m.id}`} m={m} field={field} live={live} />
            ))}
          </div>
          {retirados.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Retirados — historia conservada (nada se borra)</p>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {retirados.map((m) => <RetiredCard key={`${m.tenant}/${m.id}`} m={m} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RetiredCard({ m }: { m: ModuleRow }) {
  return (
    <Link to="/modulos/$moduleId" params={{ moduleId: m.id }}>
      <Card className="h-full opacity-60 hover:bg-accent/40 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{m.name ?? m.id}</CardTitle>
            <Badge variant="outline">retirado</Badge>
          </div>
          <CardDescription>{m.id} · {m.crop}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}

function ModuleCard({ m, field, live }: {
  m: ModuleRow;
  field: Record<string, Record<string, { value: number | null; time: string }>> | undefined;
  live: ReturnType<typeof useLiveModules>;
}) {
  const key = `${m.tenant}/${m.id}`;
  const conf = live.confidence[key];
  const health = live.health[key];
  const readings = field?.[key];
  const lastReading = readings
    ? Object.values(readings).map((r) => new Date(r.time).getTime()).reduce((a, b) => Math.max(a, b), 0)
    : 0;
  return (
    <Link to="/modulos/$moduleId" params={{ moduleId: m.id }}>
      <Card className="h-full hover:bg-accent/40 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{m.name ?? m.id}</CardTitle>
            <Badge variant={healthVariant(health?.state)}>{health?.state ?? "—"}</Badge>
          </div>
          <CardDescription>{m.id} · {m.crop}{lastReading ? ` · dato ${timeAgo(lastReading)}` : " · sin telemetría"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>confianza</span>
              <span>{conf ? `${Math.round(conf.v)}%` : "—"}</span>
            </div>
            <Progress value={conf?.v ?? 0} />
          </div>
          <div className="grid grid-cols-3 gap-1 text-center">
            <Metric label="EC" v={readings?.ec?.value} unit="mS/cm" />
            <Metric label="pH" v={readings?.ph?.value} />
            <Metric label="Tanque" v={readings?.level?.value} unit="%" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function NuevoModuloDialog() {
  const queryClient = useQueryClient();
  const { active, tenants } = useTenant();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [crop, setCrop] = useState("");
  const [farmId, setFarmId] = useState("");

  const { data: crops } = useQuery({
    queryKey: ["modules.crops"],
    queryFn: () => trpc.modules.crops.query()
  });

  // Finca destino: la activa en el selector, o la elegida en el diálogo (modo Todas)
  const targetFarm = active ?? farmId;

  const createMut = useMutation({
    mutationFn: () => trpc.modules.create.mutate({ tenant: targetFarm, name: name.trim(), crop }),
    onSuccess: (result) => {
      const mod = (result as { module?: { id: string } } | undefined)?.module;
      toast.success("Módulo creado", {
        description: `${mod?.id ?? ""} "${name.trim()}" — vincula su fierro desde el detalle del módulo`
      });
      queryClient.invalidateQueries({ queryKey: ["modules.list"] });
      queryClient.invalidateQueries({ queryKey: ["overview.kpis"] });
      setOpen(false);
      setName("");
      setCrop("");
      setFarmId("");
    },
    onError: (err) => {
      toast.error("No se pudo crear", { description: (err as Error).message });
    }
  });

  const valid = name.trim().length > 0 && crop.length > 0 && targetFarm.length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" /> Nuevo módulo
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo módulo</DialogTitle>
          <DialogDescription>
            Unidad lógica de cultivo. El id técnico (mod-N) se autogenera; el nombre es libre y
            aparece en la PWA, Home Assistant (área) y el reporte del cerebro.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {active === null && (
            <label className="block space-y-1">
              <span className="text-xs font-medium">Finca</span>
              <select
                value={farmId}
                onChange={(e) => setFarmId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              >
                <option value="" disabled>elige finca…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium">Nombre</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mesa Norte"
              autoFocus
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Cultivo</span>
            <select
              value={crop}
              onChange={(e) => setCrop(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            >
              <option value="" disabled>elige cultivo…</option>
              {(crops ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <DialogFooter>
          <Button onClick={() => createMut.mutate()} disabled={!valid || createMut.isPending}>
            {createMut.isPending ? "Creando…" : "Crear módulo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Metric({ label, v, unit }: { label: string; v: number | null | undefined; unit?: string }) {
  return (
    <div className="rounded-md bg-muted/60 px-1 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-mono font-medium">{v != null ? formatMetric(v) : "—"}{v != null && unit ? <span className="text-[10px] text-muted-foreground"> {unit}</span> : null}</p>
    </div>
  );
}
