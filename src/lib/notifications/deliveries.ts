import { createHash } from "node:crypto";
import type { OrgDb } from "../dal";
import { IDEMPOTENCY_KEY_USED, type EmailMessage, type SendResult } from "../email/send";

/**
 * One email, sent once (docs/superpowers/specs/2026-10-13-collections-context-design.md I11). Each email the collections
 * stage sends has an idempotency key: a SHA-256 of what it is, the event it is about and its recipient. The version of
 * the customer's rules it went under is kept beside it, never in it: a retry after the rules changed is the same email,
 * under the same key. The key is claimed in `notification_deliveries` (migration 0110) before the send, and the same key
 * goes to Resend as its `Idempotency-Key`, so a retry (ours or the network's) never sends twice. Right before the send,
 * the caller's `stillWanted` reads the opt-out again (a receivable's reminders turned off, a member's email switch): a
 * change since the decision stops it. A send that fails releases its claim, so the next run tries again under the same
 * key; a sent one stays recorded, and so does one Resend says it took under the key before. A claim a stopped run left
 * unsent is taken over after `CLAIM_LEASE_MS`, while Resend still keeps the key.
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
  /** The customer's rules it went under; 0 for the workspace's own. Recorded beside the key, never part of it. */
  policyVersion: number;
}

/** A claim no run marked sent after this long is its stopped run's (a cycle runs at most 5 minutes): it is taken over. */
export const CLAIM_LEASE_MS = 15 * 60_000;
/** Only while Resend still keeps the key (24 hours), so a retry of an email it took is never a second one. */
export const CLAIM_TAKEOVER_MAX_MS = 23 * 60 * 60_000;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** The recipient as kept: a hash of the address, trimmed and lowercased. */
export const recipientHash = (recipient: string) => sha256(recipient.trim().toLowerCase());

/** The idempotency key: per kind, event and recipient. Never the rules' version: a rules change is not a new email. */
export function deliveryKey(input: Pick<DeliveryInput, "kind" | "event" | "recipient">): string {
  return sha256([input.kind, input.event, recipientHash(input.recipient)].join("\n"));
}

const MISSING = new Set(["PGRST205", "42P01"]);

export type DeliveryClaim =
  | { claimed: true; key: string; id: string | null }
  | { claimed: false; key: string; reason: "sent" | "in_flight" };

/**
 * Claims the key before a send: false when it was sent already, or another run is sending it now. A claim left unsent
 * for longer than `CLAIM_LEASE_MS` (and less than `CLAIM_TAKEOVER_MAX_MS`) is its stopped run's: it is released and
 * claimed again, once, so the email is retried under the same key rather than lost.
 */
export async function claimDelivery(orgDb: OrgDb, input: DeliveryInput, now: number = Date.now()): Promise<DeliveryClaim> {
  const key = deliveryKey(input);
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
    const existing = await orgDb.from("notification_deliveries").select("id, sent_at, claimed_at").eq("idempotency_key", key).limit(1);
    if (existing.error) throw new Error(existing.error.message);
    const found = ((existing.data ?? []) as Array<{ id: string; sent_at: string | null; claimed_at: string }>)[0];
    // Released between the two reads: claim it again.
    if (!found) continue;
    if (found.sent_at) return { claimed: false, key, reason: "sent" };
    const age = now - Date.parse(found.claimed_at);
    if (attempt > 0 || !(age >= CLAIM_LEASE_MS && age < CLAIM_TAKEOVER_MAX_MS)) return { claimed: false, key, reason: "in_flight" };
    // Its run stopped between the claim and the mark: released, so this run claims it under the same key.
    const released = await orgDb
      .from("notification_deliveries")
      .delete()
      .eq("id", found.id)
      .is("sent_at", null)
      .lt("claimed_at", new Date(now - CLAIM_LEASE_MS).toISOString());
    if (released.error) throw new Error(released.error.message);
  }
  return { claimed: false, key, reason: "in_flight" };
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
    // Resend took an email under this key before (a send that timed out, or a run that stopped, after it was accepted):
    // it is kept as sent, and never sent again.
    if (result.reason === IDEMPOTENCY_KEY_USED) {
      await markDelivered(orgDb, claim, "");
      return { sent: false, key: claim.key, reason: "sent_before", detail: IDEMPOTENCY_KEY_USED };
    }
    await releaseDelivery(orgDb, claim);
    return { sent: false, key: claim.key, reason: "failed", detail: result.reason };
  }
  await markDelivered(orgDb, claim, result.id);
  return { sent: true, id: result.id, key: claim.key };
}
