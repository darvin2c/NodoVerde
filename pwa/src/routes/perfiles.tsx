import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Leaf } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.tsx";

// Perfiles de cultivo (ADR-0025): el catálogo biológico de la finca.
// Regla 9: solo el humano crea/edita — la PWA escribe vía MCP gobernado, jamás el LLM.
// name es inmutable: los lotes hashean el perfil al abrirse (el historial no se reescribe).

type Profile = {
  name: string;
  ec_min: number; ec_max: number;
  ph_min: number; ph_max: number;
  water_temp_min: number; water_temp_max: number;
  cycle_days: number | null;
  notes: string | null;
};

type FormState = {
  name: string;
  ec_min: string; ec_max: string;
  ph_min: string; ph_max: string;
  water_temp_min: string; water_temp_max: string;
  cycle_days: string;
  notes: string;
};

const EMPTY: FormState = {
  name: "", ec_min: "", ec_max: "", ph_min: "", ph_max: "",
  water_temp_min: "", water_temp_max: "", cycle_days: "", notes: "",
};

function fromProfile(p: Profile): FormState {
  return {
    name: p.name,
    ec_min: String(p.ec_min), ec_max: String(p.ec_max),
    ph_min: String(p.ph_min), ph_max: String(p.ph_max),
    water_temp_min: String(p.water_temp_min), water_temp_max: String(p.water_temp_max),
    cycle_days: p.cycle_days != null ? String(p.cycle_days) : "",
    notes: p.notes ?? "",
  };
}

function num(s: string): number | null {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
}

export function PerfilesPage() {
  const { data: profiles, isLoading } = useQuery({
    queryKey: ["profiles.list"],
    queryFn: () => trpc.profiles.list.query(),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Perfiles de cultivo</h1>
          <p className="text-sm text-muted-foreground">
            la receta biológica: rangos EC/pH/temperatura y días de ciclo — los lotes los congelan al abrirse
          </p>
        </div>
        <NuevoPerfilDialog />
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44" />)}
        </div>
      ) : (profiles ?? []).length === 0 ? (
        <Card>
          <CardContent>
            <Empty className="border-0 py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Leaf /></EmptyMedia>
                <EmptyTitle>Sin perfiles todavía</EmptyTitle>
                <EmptyDescription>Crea el primero para poder abrir lotes.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(profiles ?? []).map((p) => <ProfileCard key={p.name} p={p} />)}
        </div>
      )}
    </div>
  );
}

function ProfileCard({ p }: { p: Profile }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Leaf className="size-4 text-primary" /> {p.name}
          </CardTitle>
          <EditarPerfilDialog p={p} />
        </div>
        <CardDescription>
          {p.cycle_days != null ? `ciclo ${p.cycle_days} días` : "sin ciclo estimado — el lote queda sin fin esperado"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <Range label="EC" min={p.ec_min} max={p.ec_max} unit="mS/cm" />
        <Range label="pH" min={p.ph_min} max={p.ph_max} />
        <Range label="Temp. agua" min={p.water_temp_min} max={p.water_temp_max} unit="°C" />
        {p.notes && <p className="text-xs text-muted-foreground pt-1">{p.notes}</p>}
      </CardContent>
    </Card>
  );
}

function Range({ label, min, max, unit }: { label: string; min: number; max: number; unit?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-xs">
        {min} – {max}{unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}

function ProfileForm({ state, setState, editing }: {
  state: FormState;
  setState: (s: FormState) => void;
  editing: boolean;
}) {
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setState({ ...state, [k]: e.target.value });
  const field = (k: keyof FormState, label: string, placeholder: string, step = "0.1") => (
    <label className="block space-y-1" key={k}>
      <span className="text-xs font-medium">{label}</span>
      <Input type="number" step={step} value={state[k]} onChange={set(k)} placeholder={placeholder} />
    </label>
  );
  return (
    <div className="space-y-3 py-2">
      <label className="block space-y-1">
        <span className="text-xs font-medium">Nombre (slug inmutable)</span>
        <Input
          value={state.name}
          onChange={set("name")}
          placeholder="lechuga_romana"
          disabled={editing}
          autoFocus={!editing}
        />
        {editing && (
          <span className="text-xs text-muted-foreground">
            el nombre no se edita: los lotes abiertos lo referencian
          </span>
        )}
      </label>
      <div className="grid grid-cols-2 gap-3">
        {field("ec_min", "EC mín (mS/cm)", "1.2")}
        {field("ec_max", "EC máx (mS/cm)", "1.8")}
        {field("ph_min", "pH mín", "5.8")}
        {field("ph_max", "pH máx", "6.3")}
        {field("water_temp_min", "Temp. agua mín (°C)", "18", "1")}
        {field("water_temp_max", "Temp. agua máx (°C)", "24", "1")}
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Días de ciclo (trasplante → cosecha; vacío = sin estimación)</span>
        <Input type="number" step="1" value={state.cycle_days} onChange={set("cycle_days")} placeholder="45" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Notas</span>
        <Input value={state.notes} onChange={set("notes")} placeholder="receta, observaciones…" />
      </label>
    </div>
  );
}

function validateRanges(s: FormState): string | null {
  const ecMin = num(s.ec_min), ecMax = num(s.ec_max);
  const phMin = num(s.ph_min), phMax = num(s.ph_max);
  const tMin = num(s.water_temp_min), tMax = num(s.water_temp_max);
  if (ecMin == null || ecMax == null || phMin == null || phMax == null || tMin == null || tMax == null) {
    return "todos los rangos son obligatorios y numéricos";
  }
  if (ecMin >= ecMax) return "EC: mín debe ser menor que máx";
  if (phMin >= phMax) return "pH: mín debe ser menor que máx";
  if (phMin < 0 || phMax > 14) return "pH fuera de 0–14";
  if (tMin >= tMax) return "temperatura: mín debe ser menor que máx";
  if (s.cycle_days.trim() !== "" && (!Number.isInteger(Number(s.cycle_days)) || Number(s.cycle_days) <= 0)) {
    return "días de ciclo: entero positivo o vacío";
  }
  return null;
}

function NuevoPerfilDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FormState>(EMPTY);

  const createMut = useMutation({
    mutationFn: () => trpc.profiles.create.mutate({
      name: state.name.trim(),
      ec_min: num(state.ec_min)!, ec_max: num(state.ec_max)!,
      ph_min: num(state.ph_min)!, ph_max: num(state.ph_max)!,
      water_temp_min: num(state.water_temp_min)!, water_temp_max: num(state.water_temp_max)!,
      cycle_days: state.cycle_days.trim() !== "" ? Number(state.cycle_days) : undefined,
      notes: state.notes.trim() || undefined,
    }),
    onSuccess: () => {
      toast.success("Perfil creado", { description: `'${state.name.trim()}' ya puede usarse al abrir lotes` });
      queryClient.invalidateQueries({ queryKey: ["profiles.list"] });
      queryClient.invalidateQueries({ queryKey: ["modules.crops"] });
      setOpen(false);
      setState(EMPTY);
    },
    onError: (err) => toast.error("No se pudo crear", { description: (err as Error).message }),
  });

  const rangeError = validateRanges(state);
  const valid = /^[a-z][a-z0-9_]{1,31}$/.test(state.name.trim()) && rangeError === null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" /> Nuevo perfil
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo perfil de cultivo</DialogTitle>
          <DialogDescription>
            La receta biológica del cultivo. El nombre es inmutable: los lotes lo hashean al abrirse.
          </DialogDescription>
        </DialogHeader>
        <ProfileForm state={state} setState={setState} editing={false} />
        {rangeError && <p className="text-xs text-destructive">{rangeError}</p>}
        <DialogFooter>
          <Button onClick={() => createMut.mutate()} disabled={!valid || createMut.isPending}>
            {createMut.isPending ? "Creando…" : "Crear perfil"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditarPerfilDialog({ p }: { p: Profile }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FormState>(() => fromProfile(p));

  const updateMut = useMutation({
    mutationFn: () => trpc.profiles.update.mutate({
      name: p.name,
      ec_min: num(state.ec_min)!, ec_max: num(state.ec_max)!,
      ph_min: num(state.ph_min)!, ph_max: num(state.ph_max)!,
      water_temp_min: num(state.water_temp_min)!, water_temp_max: num(state.water_temp_max)!,
      cycle_days: state.cycle_days.trim() !== "" ? Number(state.cycle_days) : null,
      notes: state.notes.trim() || null,
    }),
    onSuccess: () => {
      toast.success("Perfil actualizado", { description: `'${p.name}' — los lotes ya abiertos conservan su hash original` });
      queryClient.invalidateQueries({ queryKey: ["profiles.list"] });
      queryClient.invalidateQueries({ queryKey: ["modules.list"] });
      setOpen(false);
    },
    onError: (err) => toast.error("No se pudo actualizar", { description: (err as Error).message }),
  });

  const rangeError = validateRanges(state);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setState(fromProfile(p)); }}>
      <DialogTrigger render={<Button variant="ghost" size="icon" aria-label={`editar ${p.name}`} />}>
        <Pencil className="size-4" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar perfil: {p.name}</DialogTitle>
          <DialogDescription>
            Cambia rangos/ciclo/notas. Los lotes abiertos con la versión anterior conservan su hash (historia inmutable).
          </DialogDescription>
        </DialogHeader>
        <ProfileForm state={state} setState={setState} editing />
        {rangeError && <p className="text-xs text-destructive">{rangeError}</p>}
        <DialogFooter>
          <Button onClick={() => updateMut.mutate()} disabled={rangeError !== null || updateMut.isPending}>
            {updateMut.isPending ? "Guardando…" : "Guardar cambios"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Badge reutilizable por si se quiere marcar perfiles en uso (futuro)
export function PerfilEnUsoBadge() {
  return <Badge variant="outline">en uso</Badge>;
}
