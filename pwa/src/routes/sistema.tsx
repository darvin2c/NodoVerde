import { useQuery } from "@tanstack/react-query";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { formatDateTime, timeAgo } from "@/lib/format.ts";

const SERVICE_LABELS: Record<string, string> = {
  policy: "Portero (policy)",
  "mcp-domain": "MCP dominio",
  finance: "Finanzas (MCP)",
  "sim-lab": "Simulador (lab API)"
};

export function SistemaPage() {
  const { data: status } = useQuery({
    queryKey: ["system.status"],
    queryFn: () => trpc.system.status.query(),
    refetchInterval: 10000
  });
  const { data: services, isLoading } = useQuery({
    queryKey: ["system.services"],
    queryFn: () => trpc.system.services.query(),
    refetchInterval: 15000
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Sistema</h1>
        <p className="text-sm text-muted-foreground">salud de la plataforma — quién está vivo y quién no</p>
      </div>

      {/* Núcleo */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Núcleo</CardTitle>
            <CardDescription>broker MQTT + base de datos</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge variant={status?.broker === "connected" ? "success" : "destructive"}>
              broker {status?.broker === "connected" ? "conectado" : "desconectado"}
            </Badge>
            <Badge variant={status?.db === "ok" ? "success" : "destructive"}>TimescaleDB {status?.db ?? "…"}</Badge>
            <p className="w-full pt-1 text-xs text-muted-foreground">
              última telemetría: {status?.lastTelemetry ? `${formatDateTime(status.lastTelemetry)} (${timeAgo(status.lastTelemetry)})` : "sin datos"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Finca</CardTitle>
            <CardDescription>identidad desde DB (única fuente de verdad)</CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            {status?.farm ? (
              <>
                <p className="font-medium">{status.farm.name}</p>
                <p className="text-xs text-muted-foreground">
                  {status.farm.location_name ?? "sin ubicación"}{status.farm.tz ? ` · ${status.farm.tz}` : ""}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">sin tenant legible</p>
            )}
            {status && Object.keys(status.healthSummary).length > 0 && (
              <p className="text-xs text-muted-foreground">
                módulos por estado: {Object.entries(status.healthSummary).map(([k, v]) => `${k}:${v}`).join(" · ")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Servicios */}
      <Card>
        <CardHeader>
          <CardTitle>Servicios del stack</CardTitle>
          <CardDescription>sonda HTTP cada 15s — cualquier respuesta &lt;500 prueba que el servicio vive</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Servicio</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>Latencia</TableHead>
                  <TableHead>URL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">Broker MQTT</TableCell>
                  <TableCell><Badge variant={services?.broker.ok ? "success" : "destructive"}>{services?.broker.ok ? "vivo" : "caído"}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="font-mono text-xs">mqtt://localhost:1883</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">TimescaleDB</TableCell>
                  <TableCell><Badge variant={services?.db.ok ? "success" : "destructive"}>{services?.db.ok ? "viva" : "caída"}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="font-mono text-xs">postgres://localhost:5432</TableCell>
                </TableRow>
                {services?.services.map((s) => (
                  <TableRow key={s.name}>
                    <TableCell className="font-medium">{SERVICE_LABELS[s.name] ?? s.name}</TableCell>
                    <TableCell><Badge variant={s.ok ? "success" : "destructive"}>{s.ok ? "vivo" : "caído"}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{s.status ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{s.ms} ms</TableCell>
                    <TableCell className="font-mono text-xs truncate max-w-52">{s.url}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Herramientas externas</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4 text-sm">
          <a className="text-primary underline underline-offset-4" href="http://localhost:8124" target="_blank" rel="noreferrer">Home Assistant :8124 ↗</a>
          <a className="text-primary underline underline-offset-4" href="http://localhost:3001" target="_blank" rel="noreferrer">Grafana :3001 ↗</a>
          <a className="text-primary underline underline-offset-4" href="http://localhost:1880/dashboard/lab" target="_blank" rel="noreferrer">Laboratorio (Node-RED) ↗</a>
          <a className="text-primary underline underline-offset-4" href="http://localhost:9000" target="_blank" rel="noreferrer">MinIO :9000 ↗</a>
        </CardContent>
      </Card>
    </div>
  );
}
