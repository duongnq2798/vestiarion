import crypto from "node:crypto";
import { z } from "zod";
import { runCycleSoon } from "../agent/cycle-soon";
import { recordIncomingTransfers } from "../agent/receipts";
import { getChainProvider } from "../circle";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntry } from "../ledger";
import { takePayCheckToken } from "../rate-limit";

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
 */

const TOKEN = /^vxr_([A-Za-z0-9_-]{43})$/;
const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export type PayLinkErrorCode = "not_found" | "closed";

const MESSAGES: Record<PayLinkErrorCode, string> = {
  not_found: "That receivable was not found.",
  closed: "That receivable is already settled or rejected; it needs no pay link.",
};

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
export async function createPayLink(input: { actorId: string; invoiceId: string }): Promise<{ token: string; linkId: string }> {
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
  const link = unwrap(
    await db()
      .from("receivable_links")
      .upsert(
        { invoice_id: invoice.id, token_hash: sha256hex(secret), created_by: input.actorId, created_at: new Date().toISOString(), revoked_at: null },
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
  return { token: `vxr_${secret}`, linkId: link.id };
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
