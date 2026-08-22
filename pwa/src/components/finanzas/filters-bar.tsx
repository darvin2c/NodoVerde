import { Check, ChevronDown, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command.tsx";
import { cn } from "@/lib/utils.ts";
import { CATEGORY_LABELS } from "./types.ts";
import { DateRangePicker } from "./date-range-picker.tsx";

export type FinanceFilterState = {
  desde?: string;
  hasta?: string;
  tipo?: "gasto" | "ingreso";
  cat?: string;
  camp?: string;
  lote?: string;
  mod?: string;
};

export type FilterOptions = {
  campaigns: string[];
  lotes: Array<{ code: string; crop: string; campaign: string | null; modules: string[]; state: string }>;
};

type Props = {
  value: FinanceFilterState;
  options: FilterOptions | undefined;
  includeVoided: boolean;
  onChange: (patch: Partial<FinanceFilterState & { includeVoided: boolean }>) => void;
  onClear: () => void;
};

type ComboItem = { value: string; label: string; hint?: string };

/** Picker buscable Popover+Command (estructura cmdk: input de búsqueda dentro del popup). */
function FilterCombobox({
  items,
  value,
  onChange,
  placeholder,
  allLabel,
  className,
}: {
  items: ComboItem[];
  value?: string;
  onChange: (v: string | undefined) => void;
  placeholder: string;
  allLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = items.find((i) => i.value === value) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            data-empty={!selected}
            className={cn("h-8 w-[170px] justify-between gap-1.5 px-2.5 text-xs font-normal data-[empty=true]:text-muted-foreground", className)}
          />
        }
      >
        <span className="truncate">
          {selected ? selected.label + (selected.hint ?? "") : placeholder}
        </span>
        <span className="flex items-center gap-0.5 shrink-0">
          {selected && (
            <span
              role="button"
              aria-label="Quitar filtro"
              className="rounded-sm opacity-60 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onChange(undefined);
              }}
            >
              <X className="size-3" />
            </span>
          )}
          <ChevronDown className="size-3.5 opacity-50" />
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar…" />
          <CommandList>
            <CommandEmpty>Sin coincidencias.</CommandEmpty>
            <CommandGroup>
              {selected && (
                <CommandItem
                  value="__clear__"
                  className="text-xs text-muted-foreground"
                  onSelect={() => {
                    onChange(undefined);
                    setOpen(false);
                  }}
                >
                  {allLabel}
                </CommandItem>
              )}
              {items.map((item) => (
                <CommandItem
                  key={item.value}
                  value={`${item.label} ${item.value}`}
                  className="text-xs"
                  onSelect={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                >
                  <span className="flex-1 truncate">
                    {item.label}
                    {item.hint && <span className="text-muted-foreground">{item.hint}</span>}
                  </span>
                  {item.value === value && <Check className="size-3.5 shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Barra de filtros con cascada campaña → lote → módulo (ADR-0027 addendum). */
export function FiltersBar({ value, options, includeVoided, onChange, onClear }: Props) {
  const campaigns = options?.campaigns ?? [];
  const lotesAll = options?.lotes ?? [];
  // Cascada: la campaña reduce los lotes; el lote reduce los módulos
  const lotes = value.camp ? lotesAll.filter((l) => l.campaign === value.camp) : lotesAll;
  const selectedLote = lotesAll.find((l) => l.code === value.lote);
  const modules = value.lote && selectedLote ? selectedLote.modules : [...new Set(lotes.flatMap((l) => l.modules))].sort();

  const hasFilters = !!(value.desde || value.hasta || value.tipo || value.cat || value.camp || value.lote || value.mod);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangePicker
        desde={value.desde}
        hasta={value.hasta}
        onChange={(patch) => onChange(patch)}
      />

      <Select
        items={[
          { label: "Tipo: todos", value: "" },
          { label: "Gastos", value: "gasto" },
          { label: "Ingresos", value: "ingreso" },
        ]}
        value={value.tipo ?? ""}
        onValueChange={(v) => onChange({ tipo: (v || undefined) as "gasto" | "ingreso" | undefined })}
      >
        <SelectTrigger className="h-8 w-[120px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="" className="text-xs">Tipo: todos</SelectItem>
          <SelectItem value="gasto" className="text-xs">Gastos</SelectItem>
          <SelectItem value="ingreso" className="text-xs">Ingresos</SelectItem>
        </SelectContent>
      </Select>

      <Select
        items={[{ label: "Categoría: todas", value: "" }, ...Object.entries(CATEGORY_LABELS).map(([k, l]) => ({ label: l, value: k }))]}
        value={value.cat ?? ""}
        onValueChange={(v) => onChange({ cat: (v as string) || undefined })}
      >
        <SelectTrigger className="h-8 w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="" className="text-xs">Categoría: todas</SelectItem>
          {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
            <SelectItem key={k} value={k} className="text-xs">{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FilterCombobox
        placeholder="Campaña: todas"
        allLabel="Todas las campañas"
        items={[...campaigns.map((c) => ({ value: c, label: c })), { value: "sin_campana", label: "Sin campaña" }]}
        value={value.camp}
        onChange={(c) => onChange({ camp: c, lote: undefined, mod: undefined })}
      />

      <FilterCombobox
        placeholder="Lote: todos"
        allLabel="Todos los lotes"
        className="w-[210px]"
        items={[...lotes.map((l) => ({
          value: l.code,
          label: l.code,
          hint: ` · ${l.crop}${l.state === "closed" ? " · cerrado" : ""}`,
        })), { value: "sin_lote", label: "General de finca", hint: " · sin lote" }]}
        value={value.lote}
        onChange={(l) => onChange({ lote: l, mod: undefined })}
      />

      <FilterCombobox
        placeholder="Módulo: todos"
        allLabel="Todos los módulos"
        className="w-[150px]"
        items={modules.map((m) => ({ value: m, label: m }))}
        value={value.mod}
        onChange={(m) => onChange({ mod: m })}
      />

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
        <Switch
          checked={includeVoided}
          onCheckedChange={(checked) => onChange({ includeVoided: checked })}
          size="sm"
        />
        Mostrar anulados
      </label>

      {hasFilters && (
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={onClear}>
          <X className="size-3.5 mr-1" /> Limpiar
        </Button>
      )}
    </div>
  );
}
