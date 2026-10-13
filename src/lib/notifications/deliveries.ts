import { createHash } from "node:crypto";
import type { OrgDb } from "../dal";
import type { EmailMessage, SendResult } from "../email/send";

/**
 * One email, sent once (docs/superpowers/specs/2026-10-13-collections-context-design.md I11). Each email the collections
 * stage sends has an idempotency key: a SHA-256 of what it is, the event it is about, its recipient and the version of
 * the customer's rules it went under. The key is claimed in `notification_deliveries` (migration 0110) before the send,
 * and the same key goes to Resend as its `Idempotency-Key`, so a retry (ours or the network's) never sends twice. Right
 * before the send, the caller's `stillWanted` reads the opt-out again (a receivable's reminders turned off, a member's
 * email switch): a change since the decision stops it. A send that fails releases its claim, so the next run tries again
 * under the same key; a sent one stays recorded.
 *
 * Before migration 0110 runs, nothing is recorded and every email goes as it did before.
 */

export type DeliveryKind = "collection_reminder" | "collection_task";

export interface DeliveryInput {
  kind: DeliveryKind;
  /** The receivable a reminder is about, or the task an email is about. */
  subjectId: string;
  /** The event: which reminder of the receivable, or which task. */
  event: string;
  /** The address it goes to; only its hash is kept. */
  recipient: string;
  /** The customer's rules it went under; 0 for the workspace's own. */
  policyVersion: number;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** The recipient as kept: a hash of the address, trimmed and lowercased. */
export const recipientHash = (recipient: string) => sha256(recipient.trim().toLowerCase());

/** The idempotency key: per recipient, event and rules' version. */
export function deliveryKey(input: Pick<DeliveryInput, "kind" | "event" | "recipient" | "policyVersion">): string {
  return sha256([input.kind, input.event, recipientHash(input.recipient), `v${input.policyVersion}`].join("\n"));
}

const MISSING = new Set(["PGRST205", "42P01"]);

export type DeliveryClaim =
  | { claimed: true; key: string; id: string | null }
  | { claimed: false; key: string; reason: "sent" | "in_flight" };

/** Claims the key before a send: false when it was sent already, or another run is sending it now. */
export async function claimDelivery(orgDb: OrgDb, input: DeliveryInput): Promise<DeliveryClaim> {
  const key = deliveryKey(input);
  const inserted = await orgDb
    .from("notification_deliveries")
    .upsert(
      { idempotency_key: key, kind: input.kind, subject_id: input.subjectId, recipient_hash: recipientHash(input.recipient), policy_version: input.policyVersion },
      { onConflict: "org_id,idempotency_key", ignoreDuplicates: true }
    )
    .select("id");
  if (inserted.error) {
    if (MISSING.has(inserted.error.code ?? "")) return { claimed: true, key, id: null };
    throw new Error(inserted.error.message);
  }
  const row = ((inserted.data ?? []) as Array<{ id: string }>)[0];
  if (row) return { claimed: true, key, id: row.id };
  const existing = await orgDb.from("notification_deliveries").select("sent_at").eq("idempotency_key", key).limit(1);
  if (existing.error) throw new Error(existing.error.message);
  const found = ((existing.data ?? []) as Array<{ sent_at: string | null }>)[0];
  return { claimed: false, key, reason: found?.sent_at ? "sent" : "in_flight" };
}

/** Marks a claimed key sent, with the provider's id. Best effort: the send happened whatever this answers. */
export async function markDelivered(orgDb: OrgDb, claim: Extract<DeliveryClaim, { claimed: true }>, providerId: string): Promise<void> {
  if (!claim.id) return;
  const marked = await orgDb.from("notification_deliveries").update({ sent_at: new Date().toISOString(), provider_id: providerId.slice(0, 200) || null }).eq("id", claim.id);
  if (marked.error) console.error("notification delivery not marked sent", claim.id, marked.error.message);
}

/** Releases a claim whose send did not happen, so the next run may try again under the same key. */
export async function releaseDelivery(orgDb: OrgDb, claim: Extract<DeliveryClaim, { claimed: true }>): Promise<void> {
  if (!claim.id) return;
  const released = await orgDb.from("notification_deliveries").delete().eq("id", claim.id).is("sent_at", null);
  if (released.error) console.error("notification delivery not released", claim.id, released.error.message);
}

export type SendOnceResult =
  | { sent: true; id: string; key: string }
  | { sent: false; key: string; reason: "sent_before" | "in_flight" | "opted_out" | "failed"; detail?: string };

/**
 * Sends `message` once for `input`: claimed, the opt-out read again (`stillWanted`), sent with the key, then marked. A
 * failed or stopped send is released. Never throws for a failed send; a database error claiming throws, before anything
 * is sent.
 */
export async function sendOnce(
  orgDb: OrgDb,
  input: DeliveryInput,
  message: EmailMessage,
  send: (message: EmailMessage) => Promise<SendResult>,
  stillWanted: () => Promise<boolean>
): Promise<SendOnceResult> {
  const claim = await claimDelivery(orgDb, input);
  if (!claim.claimed) return { sent: false, key: claim.key, reason: claim.reason === "sent" ? "sent_before" : "in_flight" };
  let wanted: boolean;
  try {
    wanted = await stillWanted();
  } catch (error) {
    await releaseDelivery(orgDb, claim);
    return { sent: false, key: claim.key, reason: "failed", detail: error instanceof Error ? error.message : "the opt-out could not be read" };
  }
  if (!wanted) {
    await releaseDelivery(orgDb, claim);
    return { sent: false, key: claim.key, reason: "opted_out" };
  }
  let result: SendResult;
  try {
    result = await send({ ...message, idempotencyKey: claim.key });
  } catch (error) {
    result = { sent: false, reason: error instanceof Error ? error.message : "send failed" };
  }
  if (!result.sent) {
    await releaseDelivery(orgDb, claim);
    return { sent: false, key: claim.key, reason: "failed", detail: result.reason };
  }
  await markDelivered(orgDb, claim, result.id);
  return { sent: true, id: result.id, key: claim.key };
}
