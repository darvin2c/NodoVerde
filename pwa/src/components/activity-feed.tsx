import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TriangleAlert, Wallet, Zap, ClipboardList } from "lucide-react";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { remediationFor } from "@/lib/remediation.ts";
import { formatMoney, timeAgo } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

// Feed de actividad unificado (overview.activity): qué pasó mientras no mirabas.
// Cada item lleva su tenant; en modo Todas se etiqueta la finca.

type ActivityItem = {
  time: string;
  tenant: string;
  kind: "alert" | "movement" | "action" | "work_order";
  ref: string;
  severity: string | null;   // alert: info|warn|critical · movement: gasto|ingreso · action/order: status
  module: string | null;
  device: string | null;
  meta: Record<string, unknown>;
};

const ACTION_LABEL: Record<string, string> = {
  dose_nutrient: "Dosificar nutriente",
  dose_ph: "Dosificar pH-down",
  fill_water: "Rellenar tanque",
  recirculate: "Recircular"
};

const ORDER_LABEL: Record<string, string> = {
  podar: "Podar",
  mezclar_nutrientes: "Mezclar nutrientes",
  trasplantar: "Trasplantar",
  cosechar: "Cosechar",
  otro: "Tarea"
};

function describe(item: ActivityItem): { title: string; badge: { text: string; variant: "destructive" | "warn" | "outline" | "secondary" | "success" }; strike?: boolean } {
  switch (item.kind) {
    case "alert": {
      const resolved = (item.meta.state as string | undefined) === "resolved";
      return {
        title: remediationFor(item.ref).title,
        badge: resolved
          ? { text: "resuelta", variant: "success" }
          : { text: item.severity ?? "info", variant: item.severity === "critical" ? "destructive" : item.severity === "warn" ? "warn" : "outline" }
      };
    }
    case "movement": {
      const isGasto = item.severity === "gasto";
      const amount = Number(item.meta.amount ?? 0);
      const currency = String(item.meta.currency ?? "PEN");
      const voided = item.meta.voided === true;
      return {
        title: `${isGasto ? "−" : "+"} ${formatMoney(amount, currency)} · ${item.ref}${item.meta.note ? ` — ${String(item.meta.note).slice(0, 40)}` : ""}`,
        badge: { text: voided ? "anulado" : isGasto ? "gasto" : "ingreso", variant: voided ? "outline" : isGasto ? "secondary" : "success" },
        strike: voided
      };
    }
    case "action": {
      const status = item.severity ?? "pending";
      return {
        title: `${ACTION_LABEL[item.ref] ?? item.ref}${item.device ? ` · ${item.device}` : ""}`,
        badge: {
          text: status,
          variant: status === "executed" ? "success" : status === "rejected" || status === "failed" ? "destructive" : status === "pending" ? "warn" : "outline"
        }
      };
    }
    case "work_order": {
      const status = item.severity ?? "pending";
      return {
        title: `${ORDER_LABEL[item.ref] ?? item.ref}${item.meta.instructions ? ` — ${String(item.meta.instructions).slice(0, 50)}` : ""}`,
        badge: { text: status, variant: status === "done" ? "success" : status === "cancelled" ? "outline" : "warn" }
      };
    }
  }
}

const KIND_ICON = {
  alert: TriangleAlert,
  movement: Wallet,
  action: Zap,
  work_order: ClipboardList
} as const;

export function ActivityFeed({ active, farmName }: { active: string | null; farmName: (id: string) => string }) {
  const { data: feed } = useQuery({
    queryKey: ["overview.activity", active],
    queryFn: () => trpc.overview.activity.query({ tenant: active ?? undefined, limit: 30 }),
    refetchInterval: 20000
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Actividad reciente</CardTitle>
        <CardDescription>alertas, dinero, acciones y órdenes — últimos 7 días</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {(!feed || feed.length === 0) && (
          <p className="text-sm text-muted-foreground">Sin actividad registrada en los últimos 7 días.</p>
        )}
        {feed?.map((item, i) => {
          const Icon = KIND_ICON[item.kind];
          const d = describe(item);
          return (
            <div key={i} className="flex items-center gap-2.5 rounded-md border px-2.5 py-2">
              <Icon className={cn(
                "size-4 shrink-0",
                item.kind === "alert" && item.severity === "critical" && d.badge.variant === "destructive" ? "text-destructive" : "text-muted-foreground"
              )} />
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm truncate", d.strike && "line-through text-muted-foreground")}>{d.title}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {active === null ? `${farmName(item.tenant)} · ` : ""}
                  {item.module ? `${item.module} · ` : ""}
                  {timeAgo(item.time)}
                </p>
              </div>
              <Badge variant={d.badge.variant} className="shrink-0">{d.badge.text}</Badge>
            </div>
          );
        })}
        <Link to="/alertas" className="inline-block text-xs text-primary underline underline-offset-4 pt-1">
          ver centro de alertas →
        </Link>
      </CardContent>
    </Card>
  );
}
