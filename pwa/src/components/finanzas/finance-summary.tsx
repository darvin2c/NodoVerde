import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { ArrowUpRight, ArrowDownLeft, Scale, Building2 } from "lucide-react";
import { formatMoney } from "@/lib/format.ts";
import { useTenant } from "@/components/tenant-provider.tsx";

type SummaryData = {
  ingresos: number;
  gastos: number;
  balance: number;
  count?: number;
  currency?: string;
  byTenant?: Array<{
    tenant: string;
    currency: string;
    ingresos: number;
    gastos: number;
    balance: number;
    count: number;
  }>;
};

type Props = {
  summary?: SummaryData;
  isLoading?: boolean;
  filtered?: boolean;
};

export function FinanceSummary({ summary, isLoading, filtered }: Props) {
  const { active, farmName, farmCurrency } = useTenant();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 rounded-xl bg-muted/50 animate-pulse" />
        ))}
      </div>
    );
  }

  const currency = (active ? farmCurrency(active) : "PEN") ?? summary?.currency ?? "PEN";
  const periodoLabel = filtered ? "en el filtro" : "del período";

  // Modo Finca Activa: 3 KPI Cards
  if (active !== null) {
    const ingresos = summary?.ingresos ?? 0;
    const gastos = summary?.gastos ?? 0;
    const balance = summary?.balance ?? 0;
    const count = summary?.count ?? 0;

    return (
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-950/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Ingresos {periodoLabel}</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <ArrowUpRight className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight text-emerald-600 dark:text-emerald-400">
              +{formatMoney(ingresos, currency)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {count > 0 ? `${count} movimiento${count > 1 ? "s" : ""} registrado${count > 1 ? "s" : ""}` : "Sin ingresos en el periodo"}
            </p>
          </CardContent>
        </Card>

        <Card className="border-red-500/20 bg-red-500/5 dark:bg-red-950/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Gastos {periodoLabel}</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">
              <ArrowDownLeft className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight text-red-600 dark:text-red-400">
              -{formatMoney(gastos, currency)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {count > 0 ? "Total ejecutado en el período" : "Sin gastos en el periodo"}
            </p>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Balance Neto</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Scale className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold font-mono tracking-tight ${
                balance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
              }`}
            >
              {balance >= 0 ? "+" : ""}
              {formatMoney(balance, currency)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Ingresos − Gastos</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Modo "Todas las fincas": Tabla por Finca
  const byTenant = summary?.byTenant ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" /> Resumen Financiero por Finca
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              ADR-0023: Monedas independientes por finca (sin suma agregada multi-moneda).
            </CardDescription>
          </div>
          <Badge variant="outline" className="font-mono text-xs">
            {byTenant.length} fincas
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {byTenant.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No hay información financiera registrada para este mes.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Finca</TableHead>
                <TableHead>Moneda</TableHead>
                <TableHead className="text-right">Ingresos</TableHead>
                <TableHead className="text-right">Gastos</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-center">Movs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byTenant.map((row) => (
                <TableRow key={row.tenant}>
                  <TableCell className="font-medium">{farmName(row.tenant)}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {row.currency}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-emerald-600 dark:text-emerald-400 font-medium">
                    +{formatMoney(row.ingresos, row.currency)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-red-600 dark:text-red-400 font-medium">
                    -{formatMoney(row.gastos, row.currency)}
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono font-bold ${
                      row.balance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {row.balance >= 0 ? "+" : ""}
                    {formatMoney(row.balance, row.currency)}
                  </TableCell>
                  <TableCell className="text-center font-mono text-xs text-muted-foreground">
                    {row.count}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
