import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { formatDateTime } from "@/lib/format.ts";

// Aprobaciones del portero (ADR-0020: botón PWA con POLICY_ADMIN_TOKEN — cero LLM en este canal)
// + órdenes de trabajo manuales (podar, mezclar nutrientes…).

export function AprobacionesPage() {
  const queryClient = useQueryClient();

  const { data: approvals, isLoading, error } = useQuery({
    queryKey: ["pending.approvals", "demo"],
    queryFn: () => trpc.pending.approvals.query({ tenant: "demo" }),
    refetchInterval: 10000
  });
  const { data: orders } = useQuery({
    queryKey: ["pending.workOrders", "demo"],
    queryFn: () => trpc.pending.workOrders.query({ tenant: "demo", status: "pending" }),
    refetchInterval: 15000
  });

  const decideMut = useMutation({
    mutationFn: (vars: { id: string; decision: "approve" | "reject" }) => trpc.pending.decide.mutate(vars),
    onSuccess: (_d, vars) => {
      toast.success(vars.decision === "approve" ? "Acción aprobada" : "Acción rechazada", {
        description: "el portero re-validó confianza al ejecutar (ADR-0020)"
      });
      queryClient.invalidateQueries({ queryKey: ["pending.approvals"] });
      queryClient.invalidateQueries({ queryKey: ["overview.kpis"] });
    },
    onError: (err) => toast.error("El portero rechazó la operación", { description: (err as Error).message })
  });

  const completeMut = useMutation({
    mutationFn: (vars: { id: string }) => trpc.pending.completeWorkOrder.mutate(vars),
    onSuccess: () => {
      toast.success("Orden marcada como hecha");
      queryClient.invalidateQueries({ queryKey: ["pending.workOrders"] });
    },
    onError: (err) => toast.error("No se pudo completar la orden", { description: (err as Error).message })
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Aprobaciones</h1>
        <p className="text-sm text-muted-foreground">
          el portero valida cada acción — tu aprobación es el último candado antes de actuar (ADR-0020)
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Aprobaciones del portero */}
        <Card>
          <CardHeader>
            <CardTitle>Acciones propuestas</CardTitle>
            <CardDescription>agente o humano propone → portero valida → tú apruebas</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading && <Skeleton className="h-24" />}
            {error && (
              <p className="text-sm text-destructive">portero inalcanzable: {(error as Error).message}</p>
            )}
            {!isLoading && !error && (!approvals || approvals.length === 0) && (
              <p className="text-sm text-muted-foreground">Sin aprobaciones pendientes.</p>
            )}
            {approvals?.map((raw) => {
              const a = raw as Record<string, unknown>;
              const id = String(a.id ?? a.policy_id ?? "");
              const device = String(a.device ?? "—");
              const action = String(a.action ?? "—");
              const params = a.params ? JSON.stringify(a.params) : "—";
              const solicitante = String(a.requested_by ?? a.requestedBy ?? "—");
              const razon = String(a.reason ?? "—");
              const module = a.module ? String(a.module) : null;
              return (
                <div key={id} className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {device} <span className="text-xs text-muted-foreground">· {action}</span>
                      {module && <span className="text-xs text-muted-foreground"> · {module}</span>}
                    </span>
                    <Badge variant="secondary">{String(a.status ?? "pending")}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">params: <span className="font-mono">{params}</span></p>
                  <p className="text-xs text-muted-foreground">solicitante: {solicitante} · razón: {razon}</p>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" onClick={() => decideMut.mutate({ id, decision: "approve" })} disabled={decideMut.isPending}>
                      Aprobar
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => decideMut.mutate({ id, decision: "reject" })} disabled={decideMut.isPending}>
                      Rechazar
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Órdenes de trabajo manuales */}
        <Card>
          <CardHeader>
            <CardTitle>Órdenes de trabajo</CardTitle>
            <CardDescription>acciones manuales emitidas por el portero (podar, mezclar nutrientes…)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(!orders || orders.length === 0) && (
              <p className="text-sm text-muted-foreground">Sin órdenes pendientes.</p>
            )}
            {orders?.map((raw) => {
              const o = raw as Record<string, unknown>;
              const id = String(o.id ?? "");
              const kind = String(o.kind ?? "—");
              const instructions = String(o.instructions ?? "—");
              const created = o.created_at ?? o.createdAt;
              return (
                <div key={id} className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{kind}</span>
                    {created ? <span className="text-xs text-muted-foreground">{formatDateTime(String(created))}</span> : null}
                  </div>
                  <p className="text-sm text-muted-foreground">{instructions}</p>
                  <Button size="sm" variant="outline" onClick={() => completeMut.mutate({ id })} disabled={completeMut.isPending}>
                    Marcar hecha
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
