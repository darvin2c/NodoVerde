import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Archive, ArchiveRestore, Pencil } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "../trpc.ts";
import { useTenant } from "@/components/tenant-provider.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog.tsx";

// Gestión de fincas (ADR-0023): id = slug inmutable, name mutable, lat/lon
// obligatorias (clima/ET0), tz derivada offline, moneda por finca.
// Nada se borra: archivar = archived_at, la historia queda (ADR-0011).

type TenantRow = {
  id: string; name: string; location_name: string | null;
  lat: number | null; lon: number | null; tz: string | null;
  currency: string; archived_at: string | null; created_at: string;
};

// Catálogo espejo del servidor (tRPC + MCP dominio)
const CURRENCIES = ["PEN", "USD", "EUR"] as const;
type Currency = (typeof CURRENCIES)[number];


export function FincasPage() {
  const { data: tenants, isLoading } = useQuery({
    queryKey: ["tenants.list", "all"],
    queryFn: () => trpc.tenants.list.query({ includeArchived: true })
  });

  const activas = (tenants ?? []).filter((t) => !t.archived_at);
  const archivadas = (tenants ?? []).filter((t) => t.archived_at);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          fincas del sistema — el id (slug) es inmutable: queda gravado en topics MQTT e historia (ADR-0023)
        </p>
        <NuevaFincaDialog />
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {activas.map((t) => <FincaCard key={t.id} t={t} />)}
          </div>
          {archivadas.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Archivadas — historia conservada (nada se borra)</p>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {archivadas.map((t) => <FincaCard key={t.id} t={t} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FincaCard({ t }: { t: TenantRow }) {
  const queryClient = useQueryClient();
  const { setActive } = useTenant();

  const archive = useMutation({
    mutationFn: (archived: boolean) => trpc.tenants.archive.mutate({ id: t.id, archived }),
    onSuccess: (_d, archived) => {
      toast.success(archived ? `Finca archivada: ${t.name}` : `Finca desarchivada: ${t.name}`);
      if (archived) setActive(null); // si era la activa, vuelve a "Todas" (el provider también lo sanea)
      queryClient.invalidateQueries({ queryKey: ["tenants.list"] });
    },
    onError: (err) => toast.error("No se pudo archivar", { description: err.message })
  });

  return (
    <Card className={t.archived_at ? "opacity-60" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{t.name}</CardTitle>
          {t.archived_at
            ? <Badge variant="outline">archivada</Badge>
            : <Badge variant="secondary">{t.currency}</Badge>}
        </div>
        <CardDescription>{t.id}{t.location_name ? ` · ${t.location_name}` : ""}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>coordenadas: {t.lat ?? "—"}, {t.lon ?? "—"}</p>
          <p>zona horaria: {t.tz ?? "desconocida"}</p>
        </div>
        <div className="flex gap-2">
          <EditarFincaDialog t={t} />
          {t.archived_at ? (
            <Button variant="outline" size="sm" onClick={() => archive.mutate(false)} disabled={archive.isPending}>
              <ArchiveRestore className="size-3.5 mr-1" /> Desarchivar
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => archive.mutate(true)} disabled={archive.isPending}>
              <Archive className="size-3.5 mr-1" /> Archivar
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NuevaFincaDialog() {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [currency, setCurrency] = useState<Currency>("PEN");
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => trpc.tenants.create.mutate({
      id: id.trim(),
      name: name.trim(),
      lat: Number(lat),
      lon: Number(lon),
      location_name: location.trim() || undefined,
      currency
    }),
    onSuccess: () => {
      toast.success(`Finca creada: ${name.trim()} (${id.trim()})`);
      queryClient.invalidateQueries({ queryKey: ["tenants.list"] });
      setOpen(false);
      setId(""); setName(""); setLocation(""); setLat(""); setLon(""); setCurrency("PEN");
    },
    onError: (err) => toast.error("No se pudo crear la finca", { description: err.message })
  });

  const coordsOk = lat.trim() !== "" && lon.trim() !== "" && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  const valid = id.trim().length >= 2 && name.trim().length > 0 && coordsOk;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4 mr-1" /> Nueva finca
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva finca</DialogTitle>
          <DialogDescription>
            El id es inmutable (slug minúscula, visible en topics MQTT). Las coordenadas son obligatorias: de ellas salen el clima y la zona horaria.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">id (slug, inmutable)</span>
              <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="finca-norte" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">nombre</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Finca Norte" />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">zona (opcional)</span>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Lambayeque, Perú" />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">latitud</span>
              <Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-6.486" inputMode="decimal" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">longitud</span>
              <Input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-79.647" inputMode="decimal" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">moneda</span>
              <Select
                items={CURRENCIES.map((c) => ({ label: c, value: c }))}
                value={currency}
                onValueChange={(v) => setCurrency(v as Currency)}
              >
                <SelectTrigger className="w-full h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c} className="text-sm">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>
            Crear finca
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditarFincaDialog({ t }: { t: TenantRow }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(t.name);
  const [location, setLocation] = useState(t.location_name ?? "");
  const [lat, setLat] = useState(t.lat?.toString() ?? "");
  const [lon, setLon] = useState(t.lon?.toString() ?? "");
  const [currency, setCurrency] = useState<Currency>(
    (CURRENCIES as readonly string[]).includes(t.currency) ? (t.currency as Currency) : "PEN"
  );
  const queryClient = useQueryClient();

  const update = useMutation({
    mutationFn: () => trpc.tenants.update.mutate({
      id: t.id,
      name: name.trim(),
      location_name: location.trim() || null,
      lat: Number(lat),
      lon: Number(lon),
      currency
    }),
    onSuccess: () => {
      toast.success(`Finca actualizada: ${t.id}`);
      queryClient.invalidateQueries({ queryKey: ["tenants.list"] });
      setOpen(false);
    },
    onError: (err) => toast.error("No se pudo actualizar", { description: err.message })
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Pencil className="size-3.5 mr-1" /> Editar
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar {t.name}</DialogTitle>
          <DialogDescription>id <code>{t.id}</code> — inmutable. Si cambias las coordenadas, la zona horaria se re-deriva.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">nombre</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">zona</span>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Lambayeque, Perú" />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">latitud</span>
              <Input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">longitud</span>
              <Input value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">moneda</span>
              <Select
                items={CURRENCIES.map((c) => ({ label: c, value: c }))}
                value={currency}
                onValueChange={(v) => setCurrency(v as Currency)}
              >
                <SelectTrigger className="w-full h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c} className="text-sm">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => update.mutate()} disabled={update.isPending || !name.trim()}>
            Guardar cambios
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
