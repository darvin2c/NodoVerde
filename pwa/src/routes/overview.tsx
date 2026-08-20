import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Boxes, TriangleAlert, CheckSquare, Wallet, Gauge, Sprout } from "lucide-react";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useLiveModules, healthVariant } from "@/lib/live.ts";
import { remediationFor } from "@/lib/remediation.ts";
import { formatPEN, formatDateTime, timeAgo } from "@/lib/format.ts";

export function OverviewPage() {
  const { data: kpis, isLoading } = useQuery({
    queryKey: ["overview.kpis"],
    queryFn: () => trpc.overview.kpis.query({ tenant: "demo" }),
    refetchInterval: 15000
  });
  const { data: system } = useQuery({
    queryKey: ["system.status"],
    queryFn: () => trpc.system.status.query(),
    refetchInterval: 10000
  });
  const { data: openAlerts } = useQuery({
    queryKey: ["alerts.list", "open"],
    queryFn: () => trpc.alerts.list.query({ tenant: "demo", limit: 6, onlyOpen: true }),
    refetchInterval: 15000
  });
  // Nombres humanos de módulos (ADR-0022) para las tarjetas en vivo
  const { data: modulesList } = useQuery({
    queryKey: ["modules.list"],
    queryFn: () => trpc.modules.list.query()
  });
  const moduleNames = new Map((modulesList ?? []).map((m) => [`${m.tenant}/${m.id}`, m.name ?? m.id]));
  const live = useLiveModules();

  if (isLoading) {
    return <div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>;
  }

  const warnCount = kpis?.openAlerts.warn ?? 0;
  const critCount = kpis?.openAlerts.critical ?? 0;
  const modulesOk = kpis?.modules.byState.ok ?? 0;
  const modulesTotal = kpis?.modules.total ?? 0;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          icon={<Boxes className="size-4" />} title="Módulos"
          value={`${modulesOk}/${modulesTotal}`}
          hint="operativos vs registrados"
          to="/modulos"
          tone={modulesOk === modulesTotal && modulesTotal > 0 ? "ok" : "warn"}
        />
        <KpiCard
          icon={<TriangleAlert className="size-4" />} title="Alertas abiertas (24h)"
          value={String(warnCount + critCount)}
          hint={critCount > 0 ? `${critCount} críticas` : warnCount > 0 ? "solo advertencias" : "todo tranquilo"}
          to="/alertas"
          tone={critCount > 0 ? "bad" : warnCount > 0 ? "warn" : "ok"}
        />
        <KpiCard
          icon={<CheckSquare className="size-4" />} title="Aprobaciones pendientes"
          value={kpis?.policyReachable === false ? "—" : String(kpis?.pendingApprovals ?? 0)}
          hint={kpis?.policyReachable === false ? "portero inalcanzable" : "esperando tu decisión"}
          to="/aprobaciones"
          tone={kpis?.policyReachable === false ? "bad" : (kpis?.pendingApprovals ?? 0) > 0 ? "warn" : "ok"}
        />
        <KpiCard
          icon={<Wallet className="size-4" />} title="Gasto de hoy"
          value={formatPEN(kpis?.todaySpend ?? 0)}
          hint="movimientos del día (SQL)"
          to="/finanzas"
          tone="neutral"
        />
        <KpiCard
          icon={<Gauge className="size-4" />} title="Confianza media"
          value={kpis?.avgConfidence != null ? `${Math.round(kpis.avgConfidence)}%` : "—"}
          hint={kpis?.avgConfidence != null ? "módulos con dato vivo" : "sin datos de confianza"}
          to="/modulos"
          tone={kpis?.avgConfidence == null ? "neutral" : kpis.avgConfidence >= 70 ? "ok" : kpis.avgConfidence >= 40 ? "warn" : "bad"}
        />
        <KpiCard
          icon={<Sprout className="size-4" />} title="Campaña"
          value={kpis?.campaign ? kpis.campaign.crop : "sin campaña"}
          hint={kpis?.campaign ? `abierta ${timeAgo(kpis.campaign.opened_at)}` : "ninguna abierta (ADR-0021)"}
          to="/sistema"
          tone={kpis?.campaign ? "ok" : "neutral"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Alertas abiertas recientes */}
        <Card>
          <CardHeader>
            <CardTitle>Alertas que necesitan atención</CardTitle>
            <CardDescription>abiertas, más recientes primero</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(!openAlerts || openAlerts.length === 0) && (
              <p className="text-sm text-muted-foreground">Sin alertas abiertas — el sistema está sano.</p>
            )}
            {openAlerts?.map((a, i) => {
              const rem = remediationFor(a.name);
              return (
                <div key={i} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{rem.title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {a.module}{a.device ? ` · ${a.device}` : ""} · {timeAgo(a.time)}
                    </p>
                  </div>
                  <Badge variant={a.severity === "critical" ? "destructive" : "warn"}>{a.severity}</Badge>
                </div>
              );
            })}
            <Link to="/alertas" className="inline-block text-xs text-primary underline underline-offset-4 pt-1">
              ver centro de alertas →
            </Link>
          </CardContent>
        </Card>

        {/* Módulos en vivo */}
        <Card>
          <CardHeader>
            <CardTitle>Módulos</CardTitle>
            <CardDescription>salud y confianza en vivo</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.keys(live.health).length === 0 && (
              <p className="text-sm text-muted-foreground">Sin datos de salud en vivo — ¿está corriendo el watchdog?</p>
            )}
            {Object.entries(live.health).map(([key, h]) => {
              const mod = key.split("/")[1] ?? key;
              const conf = live.confidence[key];
              return (
                <Link key={key} to="/modulos/$moduleId" params={{ moduleId: mod }}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{moduleNames.get(key) ?? mod}</p>
                    <p className="text-xs text-muted-foreground">
                      {mod} · confianza {conf ? `${Math.round(conf.v)}%` : "—"}
                    </p>
                  </div>
                  <Badge variant={healthVariant(h.state)}>{h.state}</Badge>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      </div>

      {/* Estado del sistema (compacto) */}
      <Card>
        <CardHeader>
          <CardTitle>Plataforma</CardTitle>
          <CardDescription>broker · DB · telemetría</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={system?.broker === "connected" ? "success" : "destructive"}>
            broker {system?.broker === "connected" ? "conectado" : "caído"}
          </Badge>
          <Badge variant={system?.db === "ok" ? "success" : "destructive"}>DB {system?.db ?? "…"}</Badge>
          <span className="text-xs text-muted-foreground">
            última telemetría: {system?.lastTelemetry ? `${formatDateTime(system.lastTelemetry)} (${timeAgo(system.lastTelemetry)})` : "sin datos"}
          </span>
          {system?.farm && (
            <span className="text-xs text-muted-foreground">
              · {system.farm.name}{system.farm.location_name ? ` — ${system.farm.location_name}` : ""}
            </span>
          )}
          <Link to="/sistema" className="ml-auto text-xs text-primary underline underline-offset-4">detalle →</Link>
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({
  icon, title, value, hint, to, tone
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  hint: string;
  to: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}) {
  const toneClass =
    tone === "ok" ? "text-success" :
    tone === "warn" ? "text-warning" :
    tone === "bad" ? "text-destructive" :
    "text-muted-foreground";
  return (
    <Link to={to}>
      <Card className="hover:bg-accent/40 transition-colors h-full">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
          <span className={toneClass}>{icon}</span>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tracking-tight">{value}</div>
          <p className="text-xs text-muted-foreground mt-1">{hint}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
