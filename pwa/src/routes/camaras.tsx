import { useQuery } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { formatDateTime, timeAgo } from "@/lib/format.ts";

export function CamarasPage() {
  const { data } = useQuery({
    queryKey: ["cameras.lastPhoto"],
    queryFn: () => trpc.cameras.lastPhoto.query({ tenant: "demo" }),
    refetchInterval: 30000
  });
  const { data: mods } = useQuery({
    queryKey: ["modules.list"],
    queryFn: () => trpc.modules.list.query()
  });

  const photoByModule: Record<string, { module: string; device: string; time: string }> = {};
  for (const p of data ?? []) photoByModule[p.module] = p;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Cámaras</h1>
        <p className="text-sm text-muted-foreground">
          1 cámara por módulo — evidencia visual que pide la oficina activa cuando falta dato (ADR-0010)
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(mods ?? []).map((m) => {
          const photo = photoByModule[m.id];
          return (
            <Card key={m.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{m.id}</CardTitle>
                  {photo
                    ? <Badge variant="success">con foto</Badge>
                    : <Badge variant="secondary">sin foto</Badge>}
                </div>
                <CardDescription>{m.crop}</CardDescription>
              </CardHeader>
              <CardContent>
                {photo ? (
                  <div className="space-y-1">
                    <div className="flex h-32 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Camera className="size-6" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {photo.device} · {formatDateTime(photo.time)} ({timeAgo(photo.time)})
                    </p>
                  </div>
                ) : (
                  <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-md border border-dashed text-muted-foreground">
                    <Camera className="size-6" />
                    <p className="text-xs">sin cámara registrada — Fase 0</p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <a className="text-xs text-primary underline underline-offset-4" href="http://localhost:9000" target="_blank" rel="noreferrer">
        evidencia en MinIO :9000 ↗
      </a>
    </div>
  );
}
