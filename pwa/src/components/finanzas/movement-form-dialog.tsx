import { useEffect, useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "../../trpc.ts";
import { useTenant } from "@/components/tenant-provider.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from "@/components/ui/drawer.tsx";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import {
  Plus,
  ArrowUpRight,
  ArrowDownLeft,
  Paperclip,
  X,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Calendar,
  Tag,
  DollarSign,
  Layers,
  FileText,
  HelpCircle,
  ChevronDown,
  Check
} from "lucide-react";
import {
  CATEGORY_LABELS,
  CATEGORY_DEFAULT_SCOPE,
  inferEvidenceKind,
  parseAttribution,
  type MovementItem,
  type FinanceKind,
  type FinanceScope
} from "./types.ts";

type FileAttachment = {
  localId: string;
  file: File;
  evidenceId?: string;
  duplicateNotice?: string;
  status: "uploading" | "uploaded" | "error";
  error?: string;
};

type Props = {
  open: boolean;
  mode: "create" | "edit";
  initialData?: MovementItem | null;
  onClose: () => void;
  onSuccess: () => void;
};

function toInputDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MovementFormDialog({ open, mode, initialData, onClose, onSuccess }: Props) {
  const isMobile = useIsMobile();
  const { active, farmCurrency } = useTenant();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<FinanceKind>("gasto");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("PEN");
  const [category, setCategory] = useState("nutrientes");
  const [scope, setScope] = useState<FinanceScope>("modulos");
  const [userTouchedScope, setUserTouchedScope] = useState(false);

  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState<"equal" | "manual">("equal");
  const [manualSplitAmounts, setManualSplitAmounts] = useState<Record<string, string>>({});

  const [occurredAt, setOccurredAt] = useState(toInputDate(new Date()));
  const [externalRef, setExternalRef] = useState("");
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [possibleDuplicate, setPossibleDuplicate] = useState<{
    reason: string;
    existing_id: string;
    existing_op?: string;
  } | null>(null);

  // Consulta de módulos para la finca activa
  const { data: modulesList } = useQuery({
    queryKey: ["modules.list"],
    queryFn: () => trpc.modules.list.query()
  });

  const tenantModules = useMemo(
    () => (modulesList ?? []).filter((m) => !m.retired_at && m.tenant === active),
    [modulesList, active]
  );

  // Inicialización o reset del formulario al abrir
  useEffect(() => {
    if (!open) return;
    setPossibleDuplicate(null);
    if (mode === "edit" && initialData) {
      setKind(initialData.kind as FinanceKind);
      setAmount(String(initialData.amount));
      setCurrency(initialData.currency);
      setCategory(initialData.category);
      setScope(initialData.scope as FinanceScope);
      setUserTouchedScope(true);
      setOccurredAt(
        initialData.occurred_at ? initialData.occurred_at.slice(0, 10) : toInputDate(new Date())
      );
      setExternalRef(initialData.external_ref ?? "");
      setSupplier(initialData.supplier ?? "");
      setNote(initialData.note ?? "");
      setReason("");

      const parsedAttrs = parseAttribution(initialData.attribution);
      if (parsedAttrs.length > 0) {
        setSelectedModules(parsedAttrs.map((a) => a.module));
        const manualMap: Record<string, string> = {};
        for (const a of parsedAttrs) manualMap[a.module] = String(a.amount);
        setManualSplitAmounts(manualMap);
        setSplitMode("manual");
      } else {
        setSelectedModules([]);
        setManualSplitAmounts({});
        setSplitMode("equal");
      }
      setAttachments([]);
    } else {
      setKind("gasto");
      setAmount("");
      setCurrency(active ? farmCurrency(active) : "PEN");
      setCategory("nutrientes");
      setScope(CATEGORY_DEFAULT_SCOPE["nutrientes"] ?? "modulos");
      setUserTouchedScope(false);
      setSelectedModules([]);
      setSplitMode("equal");
      setManualSplitAmounts({});
      setOccurredAt(toInputDate(new Date()));
      setExternalRef("");
      setNote("");
      setReason("");
      setAttachments([]);
    }
  }, [open, mode, initialData, active, farmCurrency]);

  // Al cambiar categoría sugerir alcance (si el usuario no lo cambió manualmente)
  const handleCategoryChange = (newCat: string) => {
    setCategory(newCat);
    if (!userTouchedScope) {
      const suggested = CATEGORY_DEFAULT_SCOPE[newCat] ?? "finca";
      setScope(suggested);
    }
  };

  // Cálculo asistido de reparto entre módulos
  const totalNum = parseFloat(amount) || 0;
  const calculatedAttribution = useMemo(() => {
    if (scope !== "modulos" || selectedModules.length === 0 || totalNum <= 0) return [];

    if (splitMode === "equal") {
      const count = selectedModules.length;
      const base = Math.floor((totalNum / count) * 100) / 100;
      let sumBase = base * count;
      const diff = Math.round((totalNum - sumBase) * 100) / 100;

      return selectedModules.map((modId, idx) => {
        const itemAmount = idx === count - 1 ? Number((base + diff).toFixed(2)) : base;
        return { module: modId, amount: itemAmount };
      });
    }

    return selectedModules.map((modId) => ({
      module: modId,
      amount: parseFloat(manualSplitAmounts[modId] ?? "0") || 0
    }));
  }, [scope, selectedModules, totalNum, splitMode, manualSplitAmounts]);

  const manualSum = useMemo(() => {
    if (splitMode !== "manual") return 0;
    return selectedModules.reduce(
      (acc, modId) => acc + (parseFloat(manualSplitAmounts[modId] ?? "0") || 0),
      0
    );
  }, [selectedModules, manualSplitAmounts, splitMode]);

  const isManualSumValid =
    splitMode !== "manual" || (totalNum > 0 && Math.abs(manualSum - totalNum) < 0.005);

  // Subida instantánea de evidencias
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0 || !active) return;

    for (const file of files) {
      const localId = Math.random().toString(36).slice(2);
      const newAtt: FileAttachment = { localId, file, status: "uploading" };
      setAttachments((prev) => [...prev, newAtt]);

      try {
        const res = await fetch("/api/evidence", {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-tenant": active,
            "x-kind": inferEvidenceKind(file.type)
          },
          body: file
        });

        if (res.status === 201) {
          const data = (await res.json()) as { id: string };
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === localId ? { ...a, status: "uploaded", evidenceId: data.id } : a
            )
          );
        } else if (res.status === 409) {
          const data = (await res.json()) as { existing_id: string; movement_op?: string };
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === localId
                ? {
                    ...a,
                    status: "uploaded",
                    evidenceId: data.existing_id,
                    duplicateNotice: `Este archivo ya está en ${data.movement_op ?? "otro movimiento"}`
                  }
                : a
            )
          );
        } else {
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === localId ? { ...a, status: "error", error: "Error en servidor" } : a
            )
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Error de red";
        setAttachments((prev) =>
          prev.map((a) => (a.localId === localId ? { ...a, status: "error", error: msg } : a))
        );
      }
    }

    e.target.value = "";
  };

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  };

  // Mutations tRPC
  const registerMutation = useMutation({
    mutationFn: async (force?: boolean) => {
      if (!active) throw new Error("Debes seleccionar una finca activa.");
      const evidence_ids = attachments.map((a) => a.evidenceId).filter(Boolean) as string[];

      return trpc.finance.register.mutate({
        tenant: active,
        kind,
        amount: totalNum,
        currency,
        category,
        scope,
        attribution: scope === "modulos" ? calculatedAttribution : undefined,
        note: note.trim() || undefined,
        occurred_at: occurredAt || undefined,
        external_ref: externalRef.trim() || undefined,
        supplier: supplier.trim() || undefined,
        evidence_ids: evidence_ids.length > 0 ? evidence_ids : undefined,
        force
      });
    },
    onSuccess: (res) => {
      if (res && res.status === "possible_duplicate") {
        setPossibleDuplicate({
          reason: String(res.reason ?? "Registro similar detectado"),
          existing_id: String(res.existing_id ?? ""),
          existing_op: res.existing_op ? String(res.existing_op) : undefined
        });
        return;
      }

      const opNum = (res as { op_number?: string } | undefined)?.op_number;
      toast.success(`Registrado ${opNum ?? "movimiento correctamente"}`);
      void queryClient.invalidateQueries({ queryKey: ["finance"] });
      onSuccess();
      onClose();
    },
    onError: (err: Error) => {
      toast.error(`Error al registrar: ${err.message}`);
    }
  });

  const editMutation = useMutation({
    mutationFn: async () => {
      if (!active || !initialData) throw new Error("Finca o movimiento inválido.");
      const evidence_ids = attachments.map((a) => a.evidenceId).filter(Boolean) as string[];

      return trpc.finance.edit.mutate({
        id: initialData.id,
        reason: reason.trim(),
        tenant: active,
        kind,
        amount: totalNum,
        currency,
        category,
        scope,
        attribution: scope === "modulos" ? calculatedAttribution : undefined,
        note: note.trim() || undefined,
        occurred_at: occurredAt || undefined,
        external_ref: externalRef.trim() || undefined,
        supplier: supplier.trim() || undefined,
        evidence_ids: evidence_ids.length > 0 ? evidence_ids : undefined
      });
    },
    onSuccess: (res) => {
      const newOp = (res as { new_op?: string } | undefined)?.new_op;
      toast.success(`Movimiento corregido${newOp ? ` (${newOp})` : ""}`);
      void queryClient.invalidateQueries({ queryKey: ["finance"] });
      onSuccess();
      onClose();
    },
    onError: (err: Error) => {
      toast.error(`Error al editar: ${err.message}`);
    }
  });

  const handleSubmit = (e: React.FormEvent, force = false) => {
    e.preventDefault();
    if (!active) return;
    if (totalNum <= 0) {
      toast.error("Ingresa un monto mayor a cero.");
      return;
    }
    if (scope === "modulos") {
      if (selectedModules.length === 0) {
        toast.error("Selecciona al menos un módulo para el reparto.");
        return;
      }
      if (!isManualSumValid) {
        toast.error("La suma manual por módulo debe ser exactamente igual al monto total.");
        return;
      }
    }
    if (mode === "edit" && !reason.trim()) {
      toast.error("El motivo de corrección es obligatorio.");
      return;
    }

    if (mode === "create") {
      registerMutation.mutate(force);
    } else {
      editMutation.mutate();
    }
  };

  const isPending = registerMutation.isPending || editMutation.isPending;

  if (!active) {
    return (
      <Drawer open={open} onOpenChange={(val) => !val && onClose()} swipeDirection={isMobile ? "down" : "right"} showSwipeHandle={isMobile}>
        <DrawerContent className="data-[swipe-axis=x]:sm:max-w-md text-center space-y-3 p-6">
          <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
          <DrawerTitle className="text-base">Selecciona una finca</DrawerTitle>
          <DrawerDescription className="text-xs">
            Debes seleccionar una finca específica en el menú superior para registrar un movimiento financiero.
          </DrawerDescription>
          <Button variant="outline" size="sm" onClick={onClose}>
            Entendido
          </Button>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Drawer open={open} onOpenChange={(val) => !val && onClose()} swipeDirection={isMobile ? "down" : "right"} showSwipeHandle={isMobile}>
      <DrawerContent className="data-[swipe-axis=x]:sm:max-w-lg max-h-[92dvh] overflow-y-auto p-6">
        <DrawerHeader className="px-0">
          <DrawerTitle className="text-base flex items-center gap-2">
            {mode === "create" ? (
              <>
                <Plus className="h-4 w-4 text-emerald-500" /> Registrar Movimiento Financiero
              </>
            ) : (
              <>Corregir Movimiento {initialData?.op_number ?? initialData?.id}</>
            )}
          </DrawerTitle>
          <DrawerDescription className="text-xs">
            {mode === "create"
              ? "Registra un gasto o ingreso. ADR-0027: Historia inmutable vía services/finance."
              : "La edición anula la operación previa y crea un nuevo registro vinculado con trazabilidad."}
          </DrawerDescription>
        </DrawerHeader>

        {/* Warning de duplicado si ocurre */}
        {possibleDuplicate && (
          <div className="border border-amber-500/50 bg-amber-500/10 text-amber-950 dark:text-amber-200 p-3 rounded-lg text-xs flex gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-2 flex-1">
              <p>
                <strong>¿Ya lo habías registrado?</strong> {possibleDuplicate.reason}
                {possibleDuplicate.existing_op && (
                  <span className="font-mono font-bold ml-1">[{possibleDuplicate.existing_op}]</span>
                )}
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="default"
                  onClick={(e) => handleSubmit(e, true)}
                  disabled={isPending}
                  className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                  Registrar de todas formas
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPossibleDuplicate(null)}
                  className="h-7 text-xs"
                >
                  Cancelar
                </Button>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={(e) => handleSubmit(e, false)} className="space-y-4 py-2">
          {/* Toggle Gasto / Ingreso */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-muted rounded-lg">
            <button
              type="button"
              onClick={() => setKind("gasto")}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-md text-xs font-semibold transition-all ${
                kind === "gasto"
                  ? "bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30 shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ArrowDownLeft className="h-4 w-4" /> Gasto
            </button>
            <button
              type="button"
              onClick={() => setKind("ingreso")}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-md text-xs font-semibold transition-all ${
                kind === "ingreso"
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ArrowUpRight className="h-4 w-4" /> Ingreso
            </button>
          </div>

          {/* Monto y Moneda */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Monto</label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                className="font-mono text-base font-bold tracking-tight h-10"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Moneda</label>
              <Select
                items={[
                  { label: "PEN (S/)", value: "PEN" },
                  { label: "USD ($)", value: "USD" },
                  { label: "EUR (€)", value: "EUR" },
                ]}
                value={currency}
                onValueChange={(v) => setCurrency(v as string)}
              >
                <SelectTrigger className="w-full h-10 text-xs font-mono font-medium">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PEN" className="text-xs">PEN (S/)</SelectItem>
                  <SelectItem value="USD" className="text-xs">USD ($)</SelectItem>
                  <SelectItem value="EUR" className="text-xs">EUR (€)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Categoría y Alcance */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Categoría</label>
              <Select
                items={Object.entries(CATEGORY_LABELS).map(([k, l]) => ({ label: l, value: k }))}
                value={category}
                onValueChange={(v) => handleCategoryChange(v as string)}
              >
                <SelectTrigger className="w-full h-9 text-xs font-medium">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key} className="text-xs">{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Alcance</label>
              <div className="grid grid-cols-2 gap-1 p-0.5 bg-muted rounded-md h-9">
                <button
                  type="button"
                  onClick={() => {
                    setScope("finca");
                    setUserTouchedScope(true);
                  }}
                  className={`text-[11px] font-medium rounded px-2 transition-all ${
                    scope === "finca" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground"
                  }`}
                >
                  Finca general
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScope("modulos");
                    setUserTouchedScope(true);
                  }}
                  className={`text-[11px] font-medium rounded px-2 transition-all ${
                    scope === "modulos" ? "bg-background text-foreground shadow-xs font-semibold" : "text-muted-foreground"
                  }`}
                >
                  Módulos
                </button>
              </div>
            </div>
          </div>

          {/* Selector de Módulos y Reparto */}
          {scope === "modulos" && (
            <div className="space-y-3 p-3 bg-muted/40 rounded-lg border">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Seleccionar Módulos Imputados</span>
                <div className="flex items-center gap-1 bg-background rounded border p-0.5 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setSplitMode("equal")}
                    className={`px-2 py-0.5 rounded ${
                      splitMode === "equal" ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground"
                    }`}
                  >
                    Partes iguales
                  </button>
                  <button
                    type="button"
                    onClick={() => setSplitMode("manual")}
                    className={`px-2 py-0.5 rounded ${
                      splitMode === "manual" ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground"
                    }`}
                  >
                    Manual
                  </button>
                </div>
              </div>

              {/* Módulos: picker multi-select Popover+Command (cmdk); chips con botón de quitar debajo */}
              {tenantModules.length === 0 ? (
                <p className="text-xs text-muted-foreground">No hay módulos activos en esta finca.</p>
              ) : (
                <div className="space-y-2">
                  <Popover>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full h-9 justify-between px-3 text-xs font-normal"
                        />
                      }
                    >
                      <span className={selectedModules.length === 0 ? "text-muted-foreground" : ""}>
                        {selectedModules.length === 0
                          ? "Buscar y elegir módulos…"
                          : `${selectedModules.length} módulo${selectedModules.length === 1 ? "" : "s"} imputado${selectedModules.length === 1 ? "" : "s"}`}
                      </span>
                      <ChevronDown className="size-3.5 opacity-50 shrink-0" />
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Buscar módulo…" />
                        <CommandList>
                          <CommandEmpty>Sin coincidencias.</CommandEmpty>
                          <CommandGroup>
                            {tenantModules.map((mod) => {
                              const isSelected = selectedModules.includes(mod.id);
                              return (
                                <CommandItem
                                  key={mod.id}
                                  value={`${mod.name ?? mod.id} ${mod.id}`}
                                  className="text-xs"
                                  onSelect={() =>
                                    setSelectedModules(
                                      isSelected
                                        ? selectedModules.filter((id) => id !== mod.id)
                                        : [...selectedModules, mod.id]
                                    )
                                  }
                                >
                                  <span className="flex-1 truncate">{mod.name ?? mod.id}</span>
                                  <span className="text-[10px] text-muted-foreground font-mono">
                                    {mod.occupied_by ? `ocupado por ${mod.occupied_by}` : "sin lote"}
                                  </span>
                                  {isSelected && <Check className="size-3.5 shrink-0" />}
                                </CommandItem>
                              );
                            })}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  {selectedModules.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {selectedModules.map((modId) => {
                        const modObj = tenantModules.find((m) => m.id === modId);
                        return (
                          <Badge key={modId} variant="secondary" className="gap-1 text-xs">
                            {modObj?.name ?? modId}
                            <button
                              type="button"
                              aria-label={`Quitar ${modObj?.name ?? modId}`}
                              className="rounded-sm opacity-60 hover:opacity-100"
                              onClick={() => setSelectedModules(selectedModules.filter((id) => id !== modId))}
                            >
                              <X className="size-3" />
                            </button>
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Reparto Manual de Montos */}
              {splitMode === "manual" && selectedModules.length > 0 && (
                <div className="space-y-2 pt-2 border-t">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground font-medium">Asignación por módulo:</span>
                    <span
                      className={`font-mono font-bold ${
                        isManualSumValid ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                      }`}
                    >
                      Suma: {currency} {manualSum.toFixed(2)} de {totalNum.toFixed(2)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {selectedModules.map((modId) => {
                      const modObj = tenantModules.find((m) => m.id === modId);
                      return (
                        <div key={modId} className="flex items-center gap-1.5 bg-background p-1.5 rounded border">
                          <span className="text-xs font-medium truncate flex-1">{modObj?.name ?? modId}</span>
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            value={manualSplitAmounts[modId] ?? ""}
                            onChange={(e) =>
                              setManualSplitAmounts((prev) => ({ ...prev, [modId]: e.target.value }))
                            }
                            className="w-20 h-7 text-xs font-mono text-right"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Fecha del gasto y Ref externa */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Fecha del gasto</label>
              <Input
                type="date"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                required
                className="text-xs h-9"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">Nro. Operación / Ref</label>
              <Input
                type="text"
                placeholder="Ej: Yape 83749"
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
                className="text-xs h-9"
              />
            </div>
          </div>

          {/* Proveedor */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground">Proveedor <span className="font-normal">(opcional)</span></label>
            <Input
              type="text"
              placeholder="Ej: Agrovet, Mercado Central…"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              className="text-xs h-9"
            />
          </div>

          {/* Nota */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground">Nota / Comprobante</label>
            <Textarea
              placeholder="Detalles adicionales del gasto o ingreso..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="text-xs"
            />
          </div>

          {/* Campo obligatorio de motivo si es edición */}
          {mode === "edit" && (
            <div className="space-y-1 bg-amber-500/10 p-3 rounded-lg border border-amber-500/30">
              <label className="text-xs font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" /> Motivo de la corrección <span className="text-destructive">*</span>
              </label>
              <Input
                type="text"
                placeholder="Explica por qué estás editando este registro..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                className="text-xs h-9 bg-background"
              />
            </div>
          )}

          {/* Zona de Evidencias */}
          <div className="space-y-2 pt-1 border-t">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                <Paperclip className="h-3.5 w-3.5" /> Evidencias adjuntas
              </label>
              <span className="text-[10px] text-muted-foreground">Recibos, facturas, fotos, audio</span>
            </div>

            {/* Dropzone / Upload button */}
            <div className="relative border-2 border-dashed rounded-lg p-3 text-center hover:bg-muted/40 transition-colors">
              <input
                type="file"
                multiple
                onChange={handleFileSelect}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              />
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Upload className="h-4 w-4" />
                <span>Haz clic o arrastra archivos aquí para adjuntar</span>
              </div>
            </div>

            {/* Lista de adjuntos */}
            {attachments.length > 0 && (
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {attachments.map((att) => (
                  <div
                    key={att.localId}
                    className="flex items-center justify-between p-2 rounded bg-muted/50 text-xs"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate max-w-[180px] font-medium">{att.file.name}</span>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        ({formatFileSize(att.file.size)})
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {att.status === "uploading" && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                      )}
                      {att.status === "uploaded" && (
                        <div className="flex items-center gap-1">
                          {att.duplicateNotice ? (
                            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                              ⚠️ {att.duplicateNotice}
                            </span>
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          )}
                        </div>
                      )}
                      {att.status === "error" && (
                        <span className="text-[10px] text-destructive font-medium">{att.error}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeAttachment(att.localId)}
                        className="text-muted-foreground hover:text-destructive p-0.5"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DrawerFooter className="gap-2 px-0 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isPending || (scope === "modulos" && (!isManualSumValid || selectedModules.length === 0))}
              className="gap-1.5"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "create"
                ? kind === "gasto"
                  ? "Registrar Gasto"
                  : "Registrar Ingreso"
                : "Guardar Corrección"}
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}
