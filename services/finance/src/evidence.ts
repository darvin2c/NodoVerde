// src/evidence.ts — almacén de evidencia en MinIO (ADR-0027 §5)
// Los bytes viven aquí; la DB (movement_evidence) solo guarda metadata + referencia.
// object_key content-addressed: evidence/{tenant}/{sha256}[.ext] — dedup natural.
import crypto from "node:crypto";
import { Client } from "minio";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "localhost";
const MINIO_PORT = parseInt(process.env.MINIO_PORT ?? "9000", 10);
const MINIO_USE_SSL = (process.env.MINIO_USE_SSL ?? "false") === "true";
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD ?? "minioadmin";
export const EVIDENCE_BUCKET = process.env.MINIO_BUCKET ?? "terra-media";

export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024; // 15 MB por archivo

let client: Client | null = null;
export function getMinio(): Client {
  if (client) return client;
  client = new Client({
    endPoint: MINIO_ENDPOINT,
    port: MINIO_PORT,
    useSSL: MINIO_USE_SSL,
    accessKey: MINIO_ACCESS_KEY,
    secretKey: MINIO_SECRET_KEY,
  });
  return client;
}

/** Garantiza el bucket (idempotente; minio-init también lo crea al levantar el stack). */
export async function ensureBucket(): Promise<void> {
  const c = getMinio();
  const exists = await c.bucketExists(EVIDENCE_BUCKET).catch(() => false);
  if (!exists) await c.makeBucket(EVIDENCE_BUCKET);
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
};

export function sha256Of(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function objectKeyFor(tenant: string, sha256: string, mimeType: string): string {
  const ext = EXT_BY_MIME[mimeType] ?? "";
  return `evidence/${tenant}/${sha256}${ext}`;
}

export async function putEvidence(objectKey: string, buf: Buffer, mimeType: string): Promise<void> {
  await ensureBucket();
  await getMinio().putObject(EVIDENCE_BUCKET, objectKey, buf, buf.length, { "content-type": mimeType });
}

/** Stream de lectura para servir el archivo (proxy HTTP, sin presigns públicos). */
export async function getEvidenceStream(objectKey: string): Promise<NodeJS.ReadableStream> {
  return getMinio().getObject(EVIDENCE_BUCKET, objectKey);
}
