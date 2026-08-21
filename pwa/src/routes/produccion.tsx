import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Sprout, X, Boxes } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "../trpc.ts";
import { useTenant } from "@/components/tenant-provider.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog.tsx";
import { formatDateTime, formatShort, timeAgo } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

// ── Lotes de producción (ADR-0024) ──────────────────────────────────────────
// El lote es el ciclo biológico real (programa + módulos + fechas propias);
// la campaña es solo etiqueta lógica. Regla física visible: un módulo, un lote activo.

type Lote = {
  id: string;
  code: string;
  tenant: string;
  crop: string;
  campaign: string | null;
  modules: Array<{ id: string; name: string }>;
  startedAt: string;
  expectedEndAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  note: string | null;
  state: "open" | "closed";
  cycleDays: number | null;
};

// Color por cultivo: semántico para los conocidos, hash determinístico para el resto
const CROP_COLORS = ["bg-emerald-500", "bg-red-500", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-pink-500"];
const KNOWN_CROPS: Record<string, string> = { lechuga: "bg-emerald-500", tomate: "bg-red-500" };
function cropColor(crop: string): string {
  if (KNOWN_CROPS[crop]) return KNOWN_CROPS[crop];
  let h = 0;
  for (const ch of crop) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CROP_COLORS[h % CROP_COLORS.length];
}

const DAY = 86400000;

function daysOf(lote: Lote): { elapsed: number; total: number | null; pct: number | null; overdue: boolean } {
  const start = +new Date(lote.startedAt);
  const now = Date.now();
  const elapsed = Math.max(0, Math.floor((now - start) / DAY));
  if (!lote.expectedEndAt) return { elapsed, total: null, pct: null, overdue: false };
  const total = Math.max(1, Math.round((+new Date(lote.expectedEndAt) - start) / DAY));
  return { elapsed, total, pct: Math.min(100, Math.round((elapsed / total) * 100)), overdue: now > +new Date(lote.expectedEndAt) };
}

export function ProduccionPage() {
  const { active, farmName } = useTenant();
  const { data: lotes, isLoading } = useQuery({
    queryKey: ["batches.list", active],
    queryFn: () => trpc.batches.list.query({ tenant: active ?? undefined }),
    refetchInterval: 30000
  });
  const { data: modulesList } = useQuery({
    queryKey: ["modules.list"],
    queryFn: () => trpc.modules.list.query()
  });

  const open = useMemo(() => (lotes ?? []).filter((l) => l.state === "open"), [lotes]);
  const closed = useMemo(() => (lotes ?? []).filter((l) => l.state === "closed"), [lotes]);

  // Etiquetas de campaña presentes entre los lotes activos (agrupación lógica, no gobierna)
  const campaignChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of open) counts.set(l.campaign ?? "sin campaña", (counts.get(l.campaign ?? "sin campaña") ?? 0) + 1);
    return [...counts.entries()];
  }, [open]);

  // Escala del timeline: desde el lote más viejo hasta el fin esperado más lejano (o hoy +7d)
  const scale = useMemo(() => {
    if (open.length === 0) return null;
    const now = Date.now();
    const t0 = Math.min(...open.map((l) => +new Date(l.startedAt)), now - DAY);
    const t1 = Math.max(...open.map((l) => (l.expectedEndAt ? +new Date(l.expectedEndAt) : now + 7 * DAY)), now + 3 * DAY);
    return { t0, t1, pct: (t: number) => ((t - t0) / (t1 - t0)) * 100 };
  }, [open]);

  // Ocupación: módulo → lote activo
  const occupancy = useMemo(() => {
    const map = new Map<string, Lote>();
    for (const l of open) for (const m of l.modules) map.set(`${l.tenant}/${m.id}`, l);
    return map;
  }, [open]);

  const visibleModules = useMemo(
    () => (modulesList ?? []).filter((m) => !m.retired_at && (active === null || m.tenant === active)),
    [modulesList, active]
  );

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Encabezado + acción principal */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Sprout className="size-5" /> Producción
          </h1>
          <p className="text-sm text-muted-foreground">
            {open.length === 0
              ? "Sin lotes activos — abre el primero cuando trasplantes"
              : `${open.length} ${open.length === 1 ? "lote activo" : "lotes activos"}${active === null ? " en todas las fincas" : ` en ${farmName(active!)}`}`}
          </p>
        </div>
        <AbrirLoteDialog openLotes={open} />
      </div>

      {/* Etiquetas de campaña: agrupación lógica, texto libre (ADR-0024) */}
      {campaignChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-muted-foreground uppercase">campañas</span>
          {campaignChips.map(([label, n]) => (
            <Badge key={label} variant={label === "sin campaña" ? "outline" : "secondary"}>
              {label} · {n}
            </Badge>
          ))}
        </div>
      )}

      {/* Timeline de lotes activos */}
      <Card>
        <CardHeader>
          <CardTitle>Línea de tiempo</CardTitle>
          <CardDescription>cada barra es un lote: inicio → cosecha esperada · la línea vertical es hoy</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(!scale || open.length === 0) && (
            <p className="text-sm text-muted-foreground">
              Nada en producción. Un lote nace cuando trasplantas, compras o siembras — y muere con la cosecha.
            </p>
          )}
          {scale && open.map((l) => {
            const d = daysOf(l);
            const startPct = scale.pct(+new Date(l.startedAt));
            const endPct = l.expectedEndAt ? scale.pct(+new Date(l.expectedEndAt)) : scale.pct(Date.now() + 7 * DAY);
            return (
              <div key={l.id} className="flex items-center gap-3">
                <div className="w-52 shrink-0 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {l.code} · {l.crop}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {active === null ? `${farmName(l.tenant)} · ` : ""}
                    {l.modules.map((m) => m.name).join(", ")}
                    {l.campaign ? ` · ${l.campaign}` : ""}
                  </p>
                </div>
                <div className="relative flex-1 h-11 rounded-md bg-muted/50">
                  {/* Barra del lote */}
                  <div
                    className={cn("absolute top-1.5 bottom-1.5 rounded-md overflow-hidden", cropColor(l.crop), d.overdue && "ring-2 ring-destructive")}
                    style={{ left: `${startPct}%`, width: `${Math.max(2, endPct - startPct)}%` }}
                    title={`${l.code}: ${formatShort(l.startedAt)} → ${l.expectedEndAt ? formatShort(l.expectedEndAt) : "sin fin estimado"}`}
                  >
                    {/* Progreso: porción ya vivida más oscura */}
                    {d.pct != null && (
                      <div className="absolute inset-y-0 left-0 bg-black/25" style={{ width: `${d.pct}%` }} />
                    )}
                  </div>
                  {/* Etiqueta de días sobre la barra */}
                  <span
                    className="absolute top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground whitespace-nowrap"
                    style={{ left: `calc(${Math.min(endPct, 96)}% + 4px)` }}
                  >
                    {d.total != null
                      ? d.overdue
                        ? `día ${d.elapsed} de ${d.total} — pasado`
                        : `día ${d.elapsed} de ${d.total}`
                      : `día ${d.elapsed} · sin fin estimado`}
                  </span>
                </div>
                <CerrarLoteDialog lote={l} />
              </div>
            );
          })}
          {/* Línea de hoy */}
          {scale && open.length > 0 && (
            <div className="flex items-center gap-3">
              <div className="w-52 shrink-0" />
              <div className="relative flex-1 h-4">
                <div className="absolute inset-y-0 w-px bg-primary" style={{ left: `${scale.pct(Date.now())}%` }} />
                <span
                  className="absolute -top-1 text-[10px] text-primary font-medium -translate-x-1/2"
                  style={{ left: `${scale.pct(Date.now())}%` }}
                >
                  hoy
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ocupación de módulos: la regla física hecha visible */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Boxes className="size-4" /> Ocupación de módulos</CardTitle>
          <CardDescription>un módulo solo aloja un lote a la vez — los libres están listos para el siguiente trasplante</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleModules.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin módulos activos en esta finca.</p>
          )}
          {visibleModules.map((m) => {
            const lote = occupancy.get(`${m.tenant}/${m.id}`);
            if (!lote) {
              return (
                <div key={`${m.tenant}/${m.id}`} className="rounded-lg border border-dashed p-3 text-sm">
                  <p className="font-medium">{m.name ?? m.id}</p>
                  <p className="text-xs text-muted-foreground">
                    {active === null ? `${farmName(m.tenant)} · ` : ""}{m.id} · sin cultivo
                  </p>
                  <Badge variant="outline" className="mt-2">libre</Badge>
                </div>
              );
            }
            const d = daysOf(lote);
            return (
              <div key={`${m.tenant}/${m.id}`} className="rounded-lg border p-3 text-sm space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium truncate">{m.name ?? m.id}</p>
                  <span className={cn("size-2.5 rounded-full shrink-0", cropColor(lote.crop))} />
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {lote.code} · {lote.crop}
                  {d.total != null ? ` · día ${d.elapsed} de ${d.total}` : ` · día ${d.elapsed}`}
                </p>
                {d.pct != null && <Progress value={d.pct} />}
                {d.overdue && <Badge variant="destructive">cosecha pasada</Badge>}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Historial: lotes cerrados (nada se borra — ADR-0011) */}
      {closed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Historial</CardTitle>
            <CardDescription>lotes cerrados — la razón de cierre es el aprendizaje entre ciclos</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {closed.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    <span className={cn("inline-block size-2 rounded-full mr-1.5", cropColor(l.crop))} />
                    {l.code} · {l.crop}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {active === null ? `${farmName(l.tenant)} · ` : ""}
                    {l.modules.map((m) => m.name).join(", ")}
                    {l.campaign ? ` · ${l.campaign}` : ""}
                    {l.note ? ` — ${l.note}` : ""}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <Badge variant={l.closeReason === "cosecha" || l.closeReason === "venta" ? "success" : l.closeReason === "perdida" ? "destructive" : "outline"}>
                    {l.closeReason ?? "cerrado"}
                  </Badge>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatShort(l.startedAt)} → {l.closedAt ? formatShort(l.closedAt) : "—"}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Diálogo: abrir lote ─────────────────────────────────────────────────────
function AbrirLoteDialog({ openLotes }: { openLotes: Lote[] }) {
  const queryClient = useQueryClient();
  const { active, tenants, farmName } = useTenant();
  const [open, setOpen] = useState(false);
  const [farmId, setFarmId] = useState("");
  const [crop, setCrop] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [campaign, setCampaign] = useState("");
  const [note, setNote] = useState("");

  const { data: crops } = useQuery({ queryKey: ["modules.crops"], queryFn: () => trpc.modules.crops.query() });
  const { data: modulesList } = useQuery({ queryKey: ["modules.list"], queryFn: () => trpc.modules.list.query() });

  const targetFarm = active ?? farmId;

  // Módulos elegibles (ADR-0025): de la finca, activos y LIBRES. Las mesas son
  // infraestructura fungible — cualquier mesa libre acepta cualquier cultivo.
  const occupiedIds = useMemo(() => {
    const s = new Set<string>();
    for (const l of openLotes) for (const m of l.modules) s.add(`${l.tenant}/${m.id}`);
    return s;
  }, [openLotes]);

  const eligible = useMemo(
    () => (modulesList ?? []).filter((m) =>
      m.tenant === targetFarm && !m.retired_at && !occupiedIds.has(`${m.tenant}/${m.id}`)),
    [modulesList, targetFarm, occupiedIds]
  );

  // Etiquetas de campaña ya usadas (datalist — texto libre con sugerencias)
  const knownCampaigns = useMemo(() => {
    const s = new Set<string>();
    for (const l of openLotes) if (l.campaign) s.add(l.campaign);
    return [...s];
  }, [openLotes]);

  const openMut = useMutation({
    mutationFn: () => trpc.batches.open.mutate({
      tenant: targetFarm, crop, modules: selected,
      campaign: campaign.trim() || undefined, note: note.trim() || undefined
    }),
    onSuccess: (result) => {
      const r = result as { code?: string; expected_end_at?: string | null } | undefined;
      toast.success("Lote abierto", {
        description: `${r?.code ?? ""} · ${crop} en ${selected.join(", ")}${r?.expected_end_at ? ` — cosecha esperada ${formatDateTime(r.expected_end_at)}` : ""}`
      });
      queryClient.invalidateQueries({ queryKey: ["batches.list"] });
      queryClient.invalidateQueries({ queryKey: ["overview.kpis"] });
      setOpen(false);
      setCrop(""); setSelected([]); setCampaign(""); setNote(""); setFarmId("");
    },
    onError: (err) => toast.error("No se pudo abrir", { description: (err as Error).message })
  });

  const valid = targetFarm.length > 0 && crop.length > 0 && selected.length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" /> Abrir lote
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Abrir lote de producción</DialogTitle>
          <DialogDescription>
            El ciclo nace hoy. La cosecha esperada se calcula del perfil del cultivo;
            la campaña es solo una etiqueta para agrupar después (ej: invierno-2026).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {active === null && (
            <label className="block space-y-1">
              <span className="text-xs font-medium">Finca</span>
              <select
                value={farmId}
                onChange={(e) => { setFarmId(e.target.value); setSelected([]); }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              >
                <option value="" disabled>elige finca…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium">Cultivo / programa</span>
            <select
              value={crop}
              onChange={(e) => { setCrop(e.target.value); setSelected([]); }}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            >
              <option value="" disabled>elige cultivo…</option>
              {(crops ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {crop && targetFarm && (
            <div className="space-y-1">
              <span className="text-xs font-medium">Mesas que ocupará (cualquier mesa libre acepta el cultivo)</span>
              {eligible.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Ninguna mesa libre en {farmName(targetFarm)} — crea una en Módulos o cierra el lote que la ocupa.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {eligible.map((m) => {
                  const on = selected.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setSelected(on ? selected.filter((x) => x !== m.id) : [...selected, m.id])}
                      className={cn(
                        "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                        on ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"
                      )}
                    >
                      {m.name ?? m.id}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium">Campaña (etiqueta opcional)</span>
            <Input
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              placeholder="invierno-2026"
              list="campaign-labels"
            />
            <datalist id="campaign-labels">
              {knownCampaigns.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Nota (opcional)</span>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="trasplante de semillero propio" rows={2} />
          </label>
        </div>
        <DialogFooter>
          <Button onClick={() => openMut.mutate()} disabled={!valid || openMut.isPending}>
            {openMut.isPending ? "Abriendo…" : "Abrir lote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Diálogo: cerrar lote ────────────────────────────────────────────────────
function CerrarLoteDialog({ lote }: { lote: Lote }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");

  const closeMut = useMutation({
    mutationFn: () => trpc.batches.close.mutate({ id: lote.id, reason: reason as "cosecha" | "venta" | "perdida" | "otro", note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success("Lote cerrado", { description: `${lote.code} · ${reason}` });
      queryClient.invalidateQueries({ queryKey: ["batches.list"] });
      queryClient.invalidateQueries({ queryKey: ["overview.kpis"] });
      setOpen(false);
      setReason(""); setNote("");
    },
    onError: (err) => toast.error("No se pudo cerrar", { description: (err as Error).message })
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="ghost" />}>
        <X className="size-3.5" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cerrar {lote.code}</DialogTitle>
          <DialogDescription>
            {lote.crop} · {lote.modules.map((m) => m.name).join(", ")} · abierto {timeAgo(lote.startedAt)}.
            La razón de cierre es el dato que alimenta el margen y el aprendizaje entre ciclos.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium">Razón de cierre</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            >
              <option value="" disabled>elige razón…</option>
              <option value="cosecha">cosecha — ciclo completado</option>
              <option value="venta">venta — salida comercial (pecuario)</option>
              <option value="perdida">pérdida — el ciclo fracasó</option>
              <option value="otro">otro</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Nota (opcional)</span>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="rendimiento, kg cosechados, observaciones" rows={2} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={() => closeMut.mutate()} disabled={!reason || closeMut.isPending}>
            {closeMut.isPending ? "Cerrando…" : "Cerrar lote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
