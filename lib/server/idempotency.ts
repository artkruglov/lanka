import { database } from "@/db";
import { uid } from "@/lib/domain/model";
import { AppError } from "./auth";
export const DB_NOW =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
export type ReceiptIntent = {
  actorId: string;
  requestId: string;
  fingerprint: string;
  action: string;
};
export type ReceiptRecord = ReceiptIntent & {
  deckId: string;
  revision: number;
};
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const object = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(object)
      .filter((k) => object[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(object[k]))
      .join(",") +
    "}"
  );
}
export async function fingerprint(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function lookupReceipt(
  intent: ReceiptIntent,
): Promise<ReceiptRecord | null> {
  const row = await database()
    .prepare(
      "SELECT actor_id AS actorId, request_id AS requestId, fingerprint, action, deck_id AS deckId, revision FROM command_receipts WHERE actor_id = ? AND request_id = ?",
    )
    .bind(intent.actorId, intent.requestId)
    .first<ReceiptRecord>();
  if (row && row.fingerprint !== intent.fingerprint)
    throw new AppError(
      409,
      "Этот идентификатор запроса уже использован для другого действия.",
    );
  return row;
}
export function receiptStatement(
  intent: ReceiptIntent,
  deckId: string,
  revision: number,
  mutationId: string,
  now: string,
) {
  return database()
    .prepare(
      "INSERT INTO command_receipts (id, actor_id, request_id, fingerprint, action, deck_id, revision, created_at) SELECT ?, ?, ?, ?, ?, id, ?, ? FROM decks WHERE id = ? AND mutation_id = ?",
    )
    .bind(
      uid(),
      intent.actorId,
      intent.requestId,
      intent.fingerprint,
      intent.action,
      revision,
      now,
      deckId,
      mutationId,
    );
}
export type RunFence = {
  id: string;
  proposalId?: string;
  totalTokens: number | null;
};
