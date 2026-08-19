import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useLiveModules, healthVariant } from "@/lib/live.ts";
import { timeAgo, formatMetric } from "@/lib/format.ts";

export function ModulosPage() {
  const { data: mods, isLoading } = useQuery({
    queryKey: ["modules.list"],
    queryFn: () => trpc.modules.list.query()
  });
  const { data: field } = useQuery({
    queryKey: ["field.latest"],
    queryFn: () => trpc.field.latest.query({ tenant: "demo" }),
    refetchInterval: 15000
  });
  const live = useLiveModules();

  if (isLoading) {
    return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>;
  }

  if (!mods || mods.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Módulos</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Sin módulos registrados — verifica el seed de la DB.</p></CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {mods.map((m) => {
        const key = `${m.tenant}/${m.id}`;
        const conf = live.confidence[key];
        const health = live.health[key];
        const readings = field?.[m.id];
        const lastReading = readings
          ? Object.values(readings).map((r) => new Date(r.time).getTime()).reduce((a, b) => Math.max(a, b), 0)
          : 0;
        return (
          <Link key={key} to="/modulos/$moduleId" params={{ moduleId: m.id }}>
            <Card className="h-full hover:bg-accent/40 transition-colors">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{m.id}</CardTitle>
                  <Badge variant={healthVariant(health?.state)}>{health?.state ?? "—"}</Badge>
                </div>
                <CardDescription>{m.crop}{lastReading ? ` · dato ${timeAgo(lastReading)}` : " · sin telemetría"}</CardDescription>
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
      })}
    </div>
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
