import { useMemo, useState } from "react";
import { format, subDays, startOfMonth, endOfMonth, subMonths, parseISO } from "date-fns";
import { es } from "date-fns/locale";
import { Calendar as CalendarIcon, X } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button.tsx";
import { Calendar } from "@/components/ui/calendar.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/utils.ts";

type Props = {
  desde?: string; // ISO yyyy-mm-dd (fecha económica)
  hasta?: string;
  onChange: (patch: { desde?: string; hasta?: string }) => void;
  className?: string;
};

type Preset = { label: string; range: () => DateRange | undefined };

const today = () => new Date();

const PRESETS: Preset[] = [
  { label: "Hoy", range: () => ({ from: today(), to: today() }) },
  { label: "Ayer", range: () => ({ from: subDays(today(), 1), to: subDays(today(), 1) }) },
  { label: "Últimos 7 días", range: () => ({ from: subDays(today(), 6), to: today() }) },
  { label: "Este mes", range: () => ({ from: startOfMonth(today()), to: today() }) },
  { label: "Mes pasado", range: () => ({ from: startOfMonth(subMonths(today(), 1)), to: endOfMonth(subMonths(today(), 1)) }) },
  { label: "Últimos 90 días", range: () => ({ from: subDays(today(), 89), to: today() }) },
  { label: "Todo el historial", range: () => undefined },
];

const toIso = (d: Date) => format(d, "yyyy-MM-dd");

/** Selector de rango de fechas con calendario doble y presets (ADR-0027 addendum UX). */
export function DateRangePicker({ desde, hasta, onChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const selected: DateRange | undefined = useMemo(() => {
    if (!desde && !hasta) return undefined;
    return { from: desde ? parseISO(desde) : undefined, to: hasta ? parseISO(hasta) : undefined };
  }, [desde, hasta]);

  const apply = (range: DateRange | undefined) => {
    onChange({
      desde: range?.from ? toIso(range.from) : undefined,
      hasta: range?.to ? toIso(range.to) : undefined,
    });
  };

  const label = selected?.from
    ? selected.to
      ? `${format(selected.from, "dd MMM", { locale: es })} – ${format(selected.to, "dd MMM yy", { locale: es })}`
      : `desde ${format(selected.from, "dd MMM yy", { locale: es })}`
    : "Fechas: todas";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            data-empty={!selected?.from}
            className={cn("h-8 justify-start gap-1.5 px-2.5 text-xs font-normal data-[empty=true]:text-muted-foreground", className)}
          />
        }
      >
        <CalendarIcon className="size-3.5" />
        {label}
        {selected?.from && (
          <span
            role="button"
            aria-label="Limpiar fechas"
            className="ml-1 rounded-sm opacity-60 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              apply(undefined);
            }}
          >
            <X className="size-3" />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
          {/* Presets laterales */}
          <div className="flex flex-col gap-0.5 border-r p-2">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                className="h-7 justify-start px-2 text-xs font-normal"
                onClick={() => {
                  apply(p.range());
                  setOpen(false);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Calendar
            mode="range"
            defaultMonth={selected?.from}
            selected={selected}
            onSelect={apply}
            numberOfMonths={2}
            locale={es}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
