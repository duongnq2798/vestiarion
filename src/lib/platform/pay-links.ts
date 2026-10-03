import crypto from "node:crypto";
import { z } from "zod";
import { runCycleSoon } from "../agent/cycle-soon";
import { recordIncomingTransfers } from "../agent/receipts";
import { getChainProvider } from "../circle";
import type { ReminderTone, SentReminder } from "../collections";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntry } from "../ledger";
import { publicOrigin } from "../public-origin";
import { takePayCheckToken } from "../rate-limit";
import { decryptSecret, encryptSecret, masterKeysFromEnv, type MasterKey, type SecretEnvelope } from "../secrets";

/**
 * Pay links (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2).
 *
 * An owner or admin makes a link for an open receivable and sends it to the client. The link opens
 * a public page with what the client needs to pay: who asks, how much, by when, for what, and the
 * operating wallet's Arc testnet address (R2). A token is `vxr_` and 43 base64url characters; only
 * the SHA-256 of its secret is stored (migration 0050), and making a new link replaces the old one.
 *
 * "I have paid" never marks anything paid (R5): it asks Vestiarion to read the wallet's inbound
 * transfers now rather than at the next cycle, at most a few times a minute per link, and starts a
 * cycle once Circle shows the receivable paid.
 *
 * A link also keeps its token encrypted under the platform master key (collections R2), so its card can show it again
 * and the agent's reminders can carry it. A link made before that keeps only the hash.
 */

const TOKEN = /^vxr_([A-Za-z0-9_-]{43})$/;
const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export type PayLinkErrorCode = "not_found" | "closed" | "no_email" | "not_kept";

const MESSAGES: Record<PayLinkErrorCode, string> = {
  not_found: "That receivable was not found.",
  closed: "That receivable is already settled or rejected; it needs no pay link.",
  no_email: "Add the client's billing email on Counterparties first: reminders go to it.",
  not_kept: "This link cannot be kept for reminders here. Try again in a moment.",
};

/** The column a link's encrypted token is bound to, with its workspace (secrets AAD). */
const TOKEN_COLUMN = "receivable_links.token_enc";

/** The master keys, or none when this deployment has none: the link is then not kept (R2). */
function keysOrNone(keys?: MasterKey[]): MasterKey[] | null {
  if (keys) return keys;
  try {
    return masterKeysFromEnv();
  } catch {
    return null;
  }
}

/** A kept link's token, read back; null for a link made before tokens were kept, or one that cannot be read. */
export function payLinkToken(orgId: string, envelope: unknown, keys?: MasterKey[]): string | null {
  const ring = keysOrNone(keys);
  if (!ring || !envelope || typeof envelope !== "object") return null;
  try {
    const token = decryptSecret(envelope as SecretEnvelope, { orgId, column: TOKEN_COLUMN }, ring);
    return TOKEN.test(token) ? token : null;
  } catch (error) {
    console.error("pay link token not read", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

/** The public URL of a pay link's token. */
export const payLinkUrl = (token: string) => `${publicOrigin()}/pay/${token}`;

export class PayLinkError extends Error {
  constructor(readonly code: PayLinkErrorCode) {
    super(MESSAGES[code]);
    this.name = "PayLinkError";
  }
}

/** The stored hash for a well-formed token; null for anything else, which is never looked up. */
export function payLinkHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}

/** Makes (or replaces) the pay link of an open receivable in the workspace in scope, and records it. */
export async function createPayLink(input: { actorId: string; invoiceId: string; keys?: MasterKey[] }): Promise<{ token: string; linkId: string; kept: boolean }> {
  const found = await db()
    .from("invoices")
    .select("id, direction, status")
    .eq("id", input.invoiceId)
    .maybeSingle<{ id: string; direction: string; status: string }>();
  if (found.error) throw new Error(found.error.message);
  const invoice = found.data;
  if (!invoice || invoice.direction !== "receivable") throw new PayLinkError("not_found");
  if (invoice.status !== "pending" && invoice.status !== "matched") throw new PayLinkError("closed");

  const secret = crypto.randomBytes(32).toString("base64url");
  const token = `vxr_${secret}`;
  const keys = keysOrNone(input.keys);
  const tokenEnc = keys ? encryptSecret(token, { orgId: currentOrgId(), column: TOKEN_COLUMN }, keys) : null;
  const link = unwrap(
    await db()
      .from("receivable_links")
      .upsert(
        {
          invoice_id: invoice.id,
          token_hash: sha256hex(secret),
          token_enc: tokenEnc,
          created_by: input.actorId,
          created_at: new Date().toISOString(),
          revoked_at: null,
        },
        { onConflict: "org_id,invoice_id" }
      )
      .select("id")
      .single<{ id: string }>()
  );
  await appendLedgerEntry({
    actor: "human",
    domain: "ar",
    action: "pay_link_created",
    summary: "Created a link for a client to pay a receivable on Arc testnet",
    detail: { by: input.actorId, invoiceId: invoice.id, linkId: link.id },
  });
  return { token, linkId: link.id, kept: tokenEnc !== null };
}

/** What a receivable's card shows about its link and reminders (collections R1, R2). */
export interface PayLinkState {
  /** The link, read back; null when there is none, or it was made before links were kept. */
  url: string | null;
  /** A link exists that cannot be shown again: making a new one replaces it. */
  legacy: boolean;
  remindersOnAt: string | null;
  deferredUntil: string | null;
  sent: SentReminder[];
}

/** The link and reminders of each of these receivables, in the workspace in scope. */
export async function payLinkStates(invoiceIds: string[], keys?: MasterKey[]): Promise<Map<string, PayLinkState>> {
  const states = new Map<string, PayLinkState>();
  if (invoiceIds.length === 0) return states;
  const orgId = currentOrgId();
  const [links, reminders] = await Promise.all([
    db().from("receivable_links").select("invoice_id, token_enc, revoked_at, reminders_on_at, reminder_deferred_until").in("invoice_id", invoiceIds),
    db().from("ar_reminders").select("invoice_id, number, tone, sent_at").in("invoice_id", invoiceIds).order("number", { ascending: true }),
  ]);
  const sentBy = new Map<string, SentReminder[]>();
  for (const row of unwrap(reminders) as Array<{ invoice_id: string; number: number; tone: ReminderTone; sent_at: string }>) {
    sentBy.set(row.invoice_id, [...(sentBy.get(row.invoice_id) ?? []), { number: row.number, tone: row.tone, sentAt: row.sent_at }]);
  }
  for (const row of unwrap(links) as Array<{ invoice_id: string; token_enc: unknown; revoked_at: string | null; reminders_on_at: string | null; reminder_deferred_until: string | null }>) {
    if (row.revoked_at) continue;
    const token = row.token_enc ? payLinkToken(orgId, row.token_enc, keys) : null;
    states.set(row.invoice_id, {
      url: token ? payLinkUrl(token) : null,
      legacy: token === null,
      remindersOnAt: row.reminders_on_at,
      deferredUntil: row.reminder_deferred_until,
      sent: sentBy.get(row.invoice_id) ?? [],
    });
  }
  return states;
}

/**
 * Turns the agent's reminders on or off for an open receivable (collections R1). On needs the client's billing email,
 * and a link the reminders can carry: one made before links were kept is replaced by a new one (R2). Signed as
 * `ar_reminders_on` or `ar_reminders_off`.
 */
export async function setReminders(input: { actorId: string; invoiceId: string; on: boolean; keys?: MasterKey[] }): Promise<{ madeNewLink: boolean; counterpartyName: string }> {
  const found = await db()
    .from("invoices")
    .select("id, direction, status, counterparty_id, counterparties(name, notice_email)")
    .eq("id", input.invoiceId)
    .maybeSingle<{ id: string; direction: string; status: string; counterparty_id: string; counterparties: { name: string; notice_email: string | null } | null }>();
  if (found.error) throw new Error(found.error.message);
  const invoice = found.data;
  if (!invoice || invoice.direction !== "receivable") throw new PayLinkError("not_found");
  const client = invoice.counterparties ?? { name: "the client", notice_email: null };
  const now = new Date().toISOString();

  if (!input.on) {
    unwrap(await db().from("receivable_links").update({ reminders_on_at: null, reminders_on_by: null, reminder_deferred_until: null }).eq("invoice_id", invoice.id).select("id"));
    await appendLedgerEntry({
      actor: "human",
      domain: "ar",
      action: "ar_reminders_off",
      summary: `Turned off the agent's reminders to ${client.name}`,
      detail: { by: input.actorId, invoiceId: invoice.id, counterpartyId: invoice.counterparty_id },
    });
    return { madeNewLink: false, counterpartyName: client.name };
  }

  if (invoice.status !== "pending" && invoice.status !== "matched") throw new PayLinkError("closed");
  if (!client.notice_email) throw new PayLinkError("no_email");
  const existing = (
    await db().from("receivable_links").select("id, token_enc, revoked_at").eq("invoice_id", invoice.id).maybeSingle<{ id: string; token_enc: unknown; revoked_at: string | null }>()
  ).data;
  let linkId = existing?.id ?? null;
  let madeNewLink = false;
  if (!existing || existing.revoked_at || !payLinkToken(currentOrgId(), existing.token_enc, input.keys)) {
    const made = await createPayLink({ actorId: input.actorId, invoiceId: invoice.id, keys: input.keys });
    if (!made.kept) throw new PayLinkError("not_kept");
    linkId = made.linkId;
    madeNewLink = true;
  }
  unwrap(
    await db().from("receivable_links").update({ reminders_on_at: now, reminders_on_by: input.actorId, reminder_deferred_until: null }).eq("invoice_id", invoice.id).select("id")
  );
  await appendLedgerEntry({
    actor: "human",
    domain: "ar",
    action: "ar_reminders_on",
    summary: `Turned on the agent's reminders to ${client.name}`,
    detail: { by: input.actorId, invoiceId: invoice.id, counterpartyId: invoice.counterparty_id, linkId, madeNewLink },
  });
  return { madeNewLink, counterpartyName: client.name };
}

const previewSchema = z.object({
  orgId: z.string(),
  invoiceId: z.string(),
  createdBy: z.string().nullable(),
  orgName: z.string(),
  clientName: z.string(),
  amount: z.coerce.number(),
  currency: z.enum(["USDC", "EURC"]),
  dueDate: z.string(),
  memo: z.string().nullable(),
  status: z.enum(["open", "received"]),
  payTo: z.string().nullable(),
  chain: z.string(),
});

export type PayLinkPreview = z.infer<typeof previewSchema>;

/** What the public pay page shows for a live link; null for a malformed, unknown or revoked one. */
export async function previewPayLink(token: string): Promise<PayLinkPreview | null> {
  const hash = payLinkHash(token);
  if (!hash) return null;
  const result = await platformDb().rpc("pay_link_preview", { p_token_hash: hash });
  if (result.error) throw new Error(result.error.message);
  return result.data == null ? null : previewSchema.parse(result.data);
}

/**
 * "I have paid": reads the workspace's inbound transfers now and says whether the receivable is
 * received (R5). `wait` when this link was checked too often just now; `invalid` for a dead link.
 */
export async function checkPayLink(token: string, now: number = Date.now()): Promise<"received" | "not_yet" | "wait" | "invalid"> {
  const before = await previewPayLink(token);
  if (!before) return "invalid";
  if (before.status === "received") return "received";
  if (!takePayCheckToken(before.invoiceId, now)) return "wait";

  await withOrg(before.orgId, async () => {
    const operating = (unwrap(await db().from("accounts").select("id").eq("kind", "operating").limit(1)) as Array<{ id: string }>)[0];
    if (operating) await recordIncomingTransfers(db(), getChainProvider(), operating.id);
  });

  const after = await previewPayLink(token);
  if (after?.status !== "received") return "not_yet";
  // Cash arrived: the agent decides with it within a minute rather than at the next scheduled cycle.
  if (after.createdBy) runCycleSoon({ orgId: after.orgId, userId: after.createdBy, sandbox: false, kind: "payment_received" });
  return "received";
}
