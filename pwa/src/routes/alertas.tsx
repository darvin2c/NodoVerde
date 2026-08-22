import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleCheck, ExternalLink } from "lucide-react";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty.tsx";
import { ShieldCheck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle
} from "@/components/ui/sheet.tsx";
import { remediationFor } from "@/lib/remediation.ts";
import { formatDateTime, timeAgo } from "@/lib/format.ts";
import { useTenant } from "@/components/tenant-provider.tsx";

type AlertRow = {
  time: string; tenant: string; module: string; name: string; severity: string;
  device: string | null; detail: unknown; open: boolean;
};

type Tab = "open" | "all";

export function AlertasPage() {
  const [tab, setTab] = React.useState<Tab>("open");
  const [selected, setSelected] = React.useState<AlertRow | null>(null);
  const queryClient = useQueryClient();
  const { active, farmName } = useTenant();

  const { data: alerts, isLoading } = useQuery({
    queryKey: ["alerts.list", tab, active],
    queryFn: () => trpc.alerts.list.query({ tenant: active ?? undefined, limit: 50, onlyOpen: tab === "open" }),
    refetchInterval: 15000
  });

  // Nombres humanos de módulos (ADR-0022)
  const { data: modulesList } = useQuery({
    queryKey: ["modules.list"],
    queryFn: () => trpc.modules.list.query()
  });
  const moduleNames = new Map((modulesList ?? []).map((m) => [`${m.tenant}/${m.id}`, m.name ?? m.id]));

  const resolveMut = useMutation({
    mutationFn: (a: AlertRow) => {
      const detail = (a.detail && typeof a.detail === "object" ? a.detail : {}) as Record<string, unknown>;
      return trpc.alerts.resolve.mutate({
        tenant: a.tenant,
        alertName: a.name,
        module: a.module === "platform" ? undefined : a.module,
        fingerprint: typeof detail.fingerprint === "string" ? detail.fingerprint : undefined,
        note: "resuelta desde PWA"
      });
    },
    onSuccess: () => {
      toast.success("Alerta marcada como resuelta", { description: "resolución registrada en alert_resolutions (ADR-0021)" });
      queryClient.invalidateQueries({ queryKey: ["alerts.list"] });
      queryClient.invalidateQueries({ queryKey: ["overview.kpis"] });
      setSelected(null);
    },
    onError: (err) => {
      toast.error("No se pudo resolver", { description: (err as Error).message });
    }
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Centro de alertas</h1>
          <p className="text-sm text-muted-foreground">
            cada alerta explica qué está pasando y cómo solucionarlo — la remediación es código, no LLM (ADR-0010)
          </p>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="open">Abiertas</TabsTrigger>
            <TabsTrigger value="all">Todas</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : !alerts || alerts.length === 0 ? (
            <Empty className="border-0 py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon"><ShieldCheck /></EmptyMedia>
                <EmptyTitle>{tab === "open" ? "Sin alertas abiertas" : "Sin alertas registradas"}</EmptyTitle>
                <EmptyDescription>
                  {tab === "open" ? "El sistema está sano — los umbrales de Grafana y el watchdog no reportan nada." : "El historial de alertas está vacío."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severidad</TableHead>
                  <TableHead>Alerta</TableHead>
                  {active === null && <TableHead>Finca</TableHead>}
                  <TableHead>Módulo</TableHead>
                  <TableHead>Dispositivo</TableHead>
                  <TableHead>Cuándo</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((a, i) => {
                  const rem = remediationFor(a.name);
                  return (
                    <TableRow key={i} className="cursor-pointer" onClick={() => setSelected(a)}>
                      <TableCell>
                        <Badge variant={a.severity === "critical" ? "destructive" : a.severity === "warn" ? "warn" : "secondary"}>
                          {a.severity}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{rem.title}</p>
                        <p className="text-xs text-muted-foreground">{a.name}</p>
                      </TableCell>
                      {active === null && <TableCell className="text-xs">{farmName(a.tenant)}</TableCell>}
                      <TableCell className="font-mono text-xs" title={a.module}>{moduleNames.get(`${a.tenant}/${a.module}`) ?? a.module}</TableCell>
                      <TableCell className="font-mono text-xs">{a.device ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground" title={formatDateTime(a.time)}>{timeAgo(a.time)}</TableCell>
                      <TableCell>
                        {a.open
                          ? <Badge variant="outline" className="border-destructive/50 text-destructive">abierta</Badge>
                          : <Badge variant="outline" className="text-muted-foreground">resuelta</Badge>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Drawer de detalle */}
      <Sheet open={selected !== null} onOpenChange={(v) => { if (!v) setSelected(null); }}>
        <SheetContent className="overflow-y-auto">
          {selected && <AlertDetail alert={selected} onResolve={() => resolveMut.mutate(selected)} resolving={resolveMut.isPending} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AlertDetail({ alert, onResolve, resolving }: { alert: AlertRow; onResolve: () => void; resolving: boolean }) {
  const rem = remediationFor(alert.name);
  const isInternalLink = rem.link?.href.startsWith("/");
  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2">
          <Badge variant={alert.severity === "critical" ? "destructive" : alert.severity === "warn" ? "warn" : "secondary"}>
            {alert.severity}
          </Badge>
          {alert.open
            ? <Badge variant="outline" className="border-destructive/50 text-destructive">abierta</Badge>
            : <Badge variant="outline" className="text-muted-foreground">resuelta</Badge>}
        </div>
        <SheetTitle>{rem.title}</SheetTitle>
        <SheetDescription>
          {alert.name} · {alert.module}{alert.device ? ` · ${alert.device}` : ""} · {formatDateTime(alert.time)} ({timeAgo(alert.time)})
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-5 p-6 pt-2">
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">Qué está pasando</h3>
          <p className="text-sm text-muted-foreground">{rem.what}</p>
          <p className="text-xs text-muted-foreground">emite: {rem.source}</p>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Cómo solucionar</h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            {rem.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {rem.link && (
            isInternalLink ? (
              <Button variant="link" className="px-0" onClick={() => window.location.assign(rem.link!.href)}>
                {rem.link.label} →
              </Button>
            ) : (
              <a href={rem.link.href} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4">
                {rem.link.label} <ExternalLink className="size-3" />
              </a>
            )
          )}
        </section>

        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">Detalle crudo</h3>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(alert.detail, null, 2) ?? "sin detalle"}
          </pre>
        </section>

        {alert.open && (
          <Button onClick={onResolve} disabled={resolving} className="w-full">
            <CircleCheck className="size-4" />
            {resolving ? "Registrando…" : "Marcar como resuelta"}
          </Button>
        )}
        <p className="text-[11px] text-muted-foreground">
          la resolución queda registrada en alert_resolutions — historia inmutable, como todo en terraOS
        </p>
      </div>
    </>
  );
}
