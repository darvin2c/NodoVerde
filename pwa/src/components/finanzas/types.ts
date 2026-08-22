import type { ElementType } from "react";
import {
  Droplets,
  Zap,
  Sprout,
  Users,
  Package,
  Truck,
  ShoppingBag,
  Cpu,
  MoreHorizontal,
  Leaf
} from "lucide-react";

export type FinanceKind = "gasto" | "ingreso";
export type FinanceScope = "finca" | "modulos";

export const CATEGORY_LABELS: Record<string, string> = {
  nutrientes: "Nutrientes",
  energia: "Energía",
  agua: "Agua",
  plantulas: "Plántulas",
  mano_obra: "Mano de obra",
  empaque: "Empaque",
  transporte: "Transporte",
  venta_cosecha: "Venta cosecha",
  software: "Software (agente)",
  otro: "Otro"
};

export const CATEGORY_DEFAULT_SCOPE: Record<string, FinanceScope> = {
  nutrientes: "modulos",
  energia: "finca",
  agua: "finca",
  plantulas: "modulos",
  mano_obra: "finca",
  empaque: "modulos",
  transporte: "finca",
  venta_cosecha: "modulos",
  software: "finca",
  otro: "finca"
};

export const CATEGORY_ICONS: Record<string, ElementType> = {
  nutrientes: Leaf,
  energia: Zap,
  agua: Droplets,
  plantulas: Sprout,
  mano_obra: Users,
  empaque: Package,
  transporte: Truck,
  venta_cosecha: ShoppingBag,
  software: Cpu,
  otro: MoreHorizontal
};

export function inferEvidenceKind(mimeType: string): string {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "factura";
  if (mimeType.startsWith("image/")) return "recibo";
  return "otro";
}

export type MovementItem = {
  id: string;
  tenant: string;
  ts: string;
  occurred_at: string | null;
  kind: string;
  amount: string;
  currency: string;
  category: string;
  scope: string;
  note: string | null;
  attribution: unknown;
  op_number: string | null;
  external_ref: string | null;
  supplier: string | null;
  channel: string | null;
  source: string | null;
  created_by: string | null;
  voided_by: string | null;
  anula_a: string | null;
  replaces: string | null;
  evidence_count: number;
};

export type AttributionItem = {
  module: string;
  amount: number;
  batch?: string | null;
};

export function parseAttribution(attr: unknown): AttributionItem[] {
  if (!attr) return [];
  if (Array.isArray(attr)) {
    return attr.map((item) => ({
      module: String(item.module ?? ""),
      amount: Number(item.amount ?? 0),
      batch: item.batch ? String(item.batch) : null
    }));
  }
  if (typeof attr === "string") {
    try {
      const parsed = JSON.parse(attr);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => ({
          module: String(item.module ?? ""),
          amount: Number(item.amount ?? 0),
          batch: item.batch ? String(item.batch) : null
        }));
      }
    } catch {
      return [];
    }
  }
  return [];
}
