import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "../../trpc.ts";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from "@/components/ui/drawer.tsx";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  Paperclip,
  Calendar,
  Tag,
  Layers,
  ArrowUpRight,
  ArrowDownLeft,
  Ban,
  Pencil,
  Trash2,
  ExternalLink,
  Download,
  FileText,
  Music,
  Send,
  MessageSquare,
  Smartphone,
  Bot,
  Info,
  Clock,
  User
} from "lucide-react";
import { formatMoney, formatDateTime, formatShort, formatDay } from "@/lib/format.ts";
import { CATEGORY_LABELS, parseAttribution, inferEvidenceKind, type MovementItem } from "./types.ts";

type Props = {
  movementId: string | null;
  onClose: () => void;
  onEdit: (movement: MovementItem) => void;
  onVoid: (movement: MovementItem) => void;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ChannelBadge({ channel }: { channel: string | null }) {
  if (!channel) return <Badge variant="outline" className="text-xs">PWA</Badge>;
  const ch = channel.toLowerCase();
  if (ch === "telegram") {
    return <Badge variant="secondary" className="gap-1 text-xs"><Send className="h-3 w-3 text-sky-500" /> Telegram</Badge>;
  }
  if (ch === "whatsapp") {
    return <Badge variant="secondary" className="gap-1 text-xs"><MessageSquare className="h-3 w-3 text-emerald-500" /> WhatsApp</Badge>;
  }
  if (ch === "webchat") {
    return <Badge variant="secondary" className="gap-1 text-xs"><MessageSquare className="h-3 w-3 text-indigo-500" /> Webchat</Badge>;
  }
  if (ch === "pwa") {
    return <Badge variant="secondary" className="gap-1 text-xs"><Smartphone className="h-3 w-3 text-amber-500" /> PWA</Badge>;
  }
  if (ch === "auto") {
    return <Badge variant="secondary" className="gap-1 text-xs"><Bot className="h-3 w-3 text-purple-500" /> Auto</Badge>;
  }
  return <Badge variant="outline" className="text-xs">{channel}</Badge>;
}

export function MovementDetailDrawer({ movementId, onClose, onEdit, onVoid }: Props) {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isAttaching, setIsAttaching] = useState(false);
  const { data: detail, isLoading } = useQuery({
    queryKey: ["finance.movementDetail", movementId],
    queryFn: () => (movementId ? trpc.finance.movementDetail.query({ id: movementId }) : null),
    enabled: Boolean(movementId)
  });

  const mov = (detail?.movement as Record<string, unknown> | undefined) ?? null;
  const isVoided = Boolean(mov?.voided_by || mov?.anula_a);
  const isIngreso = mov?.kind === "ingreso";
  const amountNum = mov?.amount ? parseFloat(String(mov.amount)) : 0;
  const currency = String(mov?.currency ?? "PEN");
  const categoryLabel = mov?.category ? CATEGORY_LABELS[String(mov.category)] ?? String(mov.category) : "";
  const attributions = parseAttribution(mov?.attribution);

  const canModify = Boolean(mov && !mov.voided_by && !mov.anula_a);

  // Adjuntar evidencia post-hoc (ADR-0027 §5): sube a MinIO vía PWA server, luego attach vía finance MCP
  const attachMut = useMutation({
    mutationFn: async (file: File) => {
      const up = await fetch("/api/evidence", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-tenant": String(mov!.tenant),
          "x-kind": inferEvidenceKind(file.type)
        },
        body: file
      });
      if (up.status !== 201) throw new Error(`subida rechazada (${up.status})`);
      const { id } = (await up.json()) as { id: string };
      await trpc.finance.attachEvidence.mutate({ movement: String(mov!.id), evidence_id: id, tenant: String(mov!.tenant) });
    },
    onSuccess: () => {
      toast.success("Evidencia adjuntada");
      queryClient.invalidateQueries({ queryKey: ["finance.movementDetail", movementId] });
      queryClient.invalidateQueries({ queryKey: ["finance.movements"] });
      setIsAttaching(false);
    },
    onError: (err) => {
      toast.error("No se pudo adjuntar", { description: (err as Error).message });
      setIsAttaching(false);
    }
  });

  const handleAttachFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setIsAttaching(true);
    attachMut.mutate(file);
  };

  const movementItem: MovementItem | null = mov
    ? {
        id: String(mov.id),
        tenant: String(mov.tenant),
        ts: String(mov.ts),
        occurred_at: mov.occurred_at ? String(mov.occurred_at) : null,
        kind: String(mov.kind),
        amount: String(mov.amount),
        currency: String(mov.currency),
        category: String(mov.category),
        scope: String(mov.scope),
        note: mov.note ? String(mov.note) : null,
        attribution: mov.attribution,
        op_number: mov.op_number ? String(mov.op_number) : null,
        external_ref: mov.external_ref ? String(mov.external_ref) : null,
        supplier: mov.supplier ? String(mov.supplier) : null,
        channel: mov.channel ? String(mov.channel) : null,
        source: mov.source ? String(mov.source) : null,
        created_by: mov.created_by ? String(mov.created_by) : null,
        voided_by: mov.voided_by ? String(mov.voided_by) : null,
        anula_a: mov.anula_a ? String(mov.anula_a) : null,
        replaces: mov.replaces ? String(mov.replaces) : null,
        evidence_count: detail?.evidence?.length ?? 0
      }
    : null;

  return (
    <Drawer
      open={Boolean(movementId)}
      onOpenChange={(open) => !open && onClose()}
      showSwipeHandle={isMobile}
      swipeDirection={isMobile ? "down" : "right"}
    >
      <DrawerContent>
        <DrawerHeader className="sr-only">
          <DrawerTitle>Detalle del movimiento</DrawerTitle>
          <DrawerDescription>Trazabilidad, evidencias y acciones del movimiento seleccionado.</DrawerDescription>
        </DrawerHeader>
        {isLoading || !mov ? (
          <div className="p-4 space-y-4">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            {/* Header decorativo */}
            <div className="p-4 bg-muted/30 border-b space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-muted-foreground">
                    {String(mov.op_number ?? mov.id)}
                  </span>
                  {isVoided && <Badge variant="destructive">Anulado</Badge>}
                  {!isVoided && (
                    <Badge variant={isIngreso ? "default" : "secondary"}>
                      {isIngreso ? "Ingreso" : "Gasto"}
                    </Badge>
                  )}
                </div>
              </div>

              <div>
                <div
                  className={`text-3xl font-extrabold font-mono tracking-tight ${
                    isVoided
                      ? "line-through text-muted-foreground"
                      : isIngreso
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {isIngreso ? "+" : "-"}
                  {formatMoney(amountNum, currency)}
                </div>
                {Boolean(mov.note) && (
                  <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2 italic">
                    "{String(mov.note)}"
                  </p>
                )}
              </div>
            </div>

            {/* Contenido scrolleable */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Sección 1: Datos principales */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider flex items-center gap-1.5">
                  <Info className="h-3.5 w-3.5" /> Datos del movimiento
                </h4>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-muted/40 p-2.5 rounded-lg space-y-1">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3 w-3" /> Fecha gasto:
                    </span>
                    <p className="font-medium font-mono">
                      {mov.occurred_at ? formatDay(String(mov.occurred_at)) : formatShort(String(mov.ts))}
                    </p>
                  </div>
                  <div className="bg-muted/40 p-2.5 rounded-lg space-y-1">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Tag className="h-3 w-3" /> Categoría:
                    </span>
                    <p className="font-medium">{categoryLabel}</p>
                  </div>
                  <div className="bg-muted/40 p-2.5 rounded-lg space-y-1">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" /> Fecha registro:
                    </span>
                    <p className="font-medium font-mono text-[11px]">
                      {formatDateTime(String(mov.ts))}
                    </p>
                  </div>
                  {Boolean(mov.external_ref) && (
                    <div className="bg-muted/40 p-2.5 rounded-lg space-y-1">
                      <span className="text-muted-foreground flex items-center gap-1">
                        <FileText className="h-3 w-3" /> Ref. externa:
                      </span>
                      <p className="font-medium font-mono text-[11px]">{String(mov.external_ref)}</p>
                    </div>
                  )}
                  {Boolean(mov.supplier) && (
                    <div className="bg-muted/40 p-2.5 rounded-lg space-y-1">
                      <span className="text-muted-foreground flex items-center gap-1">
                        <User className="h-3 w-3" /> Proveedor:
                      </span>
                      <p className="font-medium text-[11px]">{String(mov.supplier)}</p>
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              {/* Sección 2: Imputación / Reparto */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5" /> Imputación y alcance
                </h4>
                {mov.scope === "finca" || attributions.length === 0 ? (
                  <div className="bg-muted/40 p-3 rounded-lg text-xs">
                    <span className="font-medium">General de Finca</span>
                    <p className="text-muted-foreground text-[11px] mt-0.5">
                      Este movimiento aplica a la finca completa sin imputar a un módulo específico.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {attributions.map((attr, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between bg-muted/40 p-2.5 rounded-lg text-xs"
                      >
                        <div className="space-y-0.5">
                          <span className="font-medium">{attr.module}</span>
                          {attr.batch && (
                            <p className="text-[10px] text-muted-foreground font-mono">
                              Lote: {attr.batch}
                            </p>
                          )}
                        </div>
                        <span className="font-mono font-bold">
                          {formatMoney(attr.amount, currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              {/* Sección 3: Procedencia */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" /> Procedencia
                </h4>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Canal de origen:</span>
                    <ChannelBadge channel={mov.channel ? String(mov.channel) : null} />
                  </div>
                  {Boolean(mov.created_by) && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Registrado por:</span>
                      <span className="font-mono">{String(mov.created_by)}</span>
                    </div>
                  )}
                  {Boolean(mov.source) && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Fuente:</span>
                      <span className="font-mono">{String(mov.source)}</span>
                    </div>
                  )}

                  {Boolean(mov.raw_payload) && (
                    <div className="mt-3 space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Payload original (auditoría):
                      </span>
                      <pre className="text-[10px] font-mono bg-muted p-2 rounded max-h-28 overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">
                        {typeof mov.raw_payload === "string"
                          ? mov.raw_payload
                          : JSON.stringify(mov.raw_payload, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>

              {/* Sección 4: Evidencias (siempre visible: se puede adjuntar post-hoc) */}
              <>
                <Separator />
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider flex items-center gap-1.5">
                      <Paperclip className="h-3.5 w-3.5" /> Evidencias ({detail?.evidence?.length ?? 0})
                    </h4>
                    {canModify && (
                      <>
                        <input ref={fileInputRef} type="file" className="hidden" onChange={handleAttachFile} />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs gap-1"
                          disabled={isAttaching}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Paperclip className="h-3 w-3" /> {isAttaching ? "Subiendo…" : "Adjuntar"}
                        </Button>
                      </>
                    )}
                  </div>
                  {Boolean(detail?.evidence && detail.evidence.length > 0) ? (
                    <div className="space-y-2">
                      {detail!.evidence.map((ev) => {
                        const fileUrl = `/api/evidence/${ev.id}/file`;
                        const isImg = ev.mime_type.startsWith("image/");
                        const isAudio = ev.mime_type.startsWith("audio/");

                        return (
                          <div key={ev.id} className="bg-muted/40 p-2.5 rounded-lg text-xs space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 truncate">
                                {isImg ? (
                                  <FileText className="h-4 w-4 text-sky-500 shrink-0" />
                                ) : isAudio ? (
                                  <Music className="h-4 w-4 text-purple-500 shrink-0" />
                                ) : (
                                  <Download className="h-4 w-4 text-amber-500 shrink-0" />
                                )}
                                <span className="font-mono text-muted-foreground truncate">
                                  {ev.sha256.slice(0, 12)}...
                                </span>
                              </div>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {formatFileSize(ev.size_bytes)}
                              </span>
                            </div>

                            {isImg && (
                              <div className="rounded overflow-hidden border bg-background">
                                <a href={fileUrl} target="_blank" rel="noopener noreferrer">
                                  <img
                                    src={fileUrl}
                                    alt="Evidencia"
                                    className="max-h-40 w-full object-cover hover:opacity-90 transition-opacity"
                                  />
                                </a>
                              </div>
                            )}

                            {isAudio && (
                              <audio controls src={fileUrl} className="w-full h-8 mt-1" />
                            )}

                            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1">
                              <span>Subido: {formatShort(ev.uploaded_at)}</span>
                              <a
                                href={fileUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                              >
                                Ver / Descargar <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">
                      Sin evidencias. {canModify ? "Usa «Adjuntar» para subir el voucher o foto después del registro." : ""}
                    </p>
                  )}
                </div>
              </>

              {/* Sección 5: Trazabilidad / Cadena de edición */}
              {(mov.replaces_op || mov.voided_by_op || mov.anula_a_op || (detail?.chain && detail.chain.length > 0)) && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider flex items-center gap-1.5">
                      <Ban className="h-3.5 w-3.5" /> Historia y correcciones
                    </h4>
                    <div className="space-y-1.5 text-xs">
                      {Boolean(mov.voided_by_op) && (
                        <div className="p-2 rounded bg-destructive/10 text-destructive text-xs font-medium flex items-center gap-2">
                          <Ban className="h-4 w-4" /> Anulado por {String(mov.voided_by_op)}
                        </div>
                      )}
                      {Boolean(mov.anula_a_op) && (
                        <div className="p-2 rounded bg-muted text-muted-foreground text-xs flex items-center gap-2">
                          <span>Anula al movimiento {String(mov.anula_a_op)}</span>
                        </div>
                      )}
                      {Boolean(mov.replaces_op) && (
                        <div className="p-2 rounded bg-muted text-muted-foreground text-xs flex items-center gap-2">
                          <span>Reemplaza a {String(mov.replaces_op)}</span>
                        </div>
                      )}
                      {detail?.chain?.map((c: Record<string, unknown>) => (
                        <div key={String(c.id)} className="p-2 rounded border bg-background text-[11px] space-y-0.5">
                          <div className="flex items-center justify-between font-mono font-medium">
                            <span>{String(c.op_number ?? c.id)}</span>
                            <span>{formatShort(String(c.ts))}</span>
                          </div>
                          {Boolean(c.note) && <p className="text-muted-foreground italic">"{String(c.note)}"</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Acciones */}
            {canModify && movementItem && (
              <DrawerFooter className="flex-row gap-2 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => onEdit(movementItem)}
                >
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => onVoid(movementItem)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Anular
                </Button>
              </DrawerFooter>
            )}
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}
