import crypto from "node:crypto";
import { runCycleSoon } from "../agent/cycle-soon";
import { amountToPay, discountApplies, invoiceDiscount } from "../agent/payment-timing";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { payLinkToken } from "../platform/pay-links";
import { CUSTOMER_MAX_CEILING_PCT, CUSTOMER_MIN_CEILING_PCT, CUSTOMER_MIN_PCT } from "./rules";

/**
 * Discounts offered to customers for paying early (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md):
 * the agent offers a customer a small discount to pay an open receivable within days, through a one-time link; an
 * accepted offer puts the discount on the receivable, ending on its pay-by day, and the customer pays through the
 * receivable's pay link.
 *
 * A token is `vxd_` and 43 base64url characters (32 random bytes). Only the SHA-256 of the secret is kept (0129); the
 * agent emails it once and never keeps it.
 */

const TOKEN = /^vxd_([A-Za-z0-9_-]{43})$/;
const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export class CustomerOfferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerOfferError";
  }
}

export function generateDiscountToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; secretHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxd_${secret}`, secretHash: sha256hex(secret) };
}

/** The stored hash for a well-formed token; null for anything else, which is never looked up. */
export function discountTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}

export function discountUrl(origin: string, token: string): string {
  return `${origin}/discount/${token}`;
}

export interface CustomerOffersSetting {
  on: boolean;
  maxPct: number | null;
  sandbox: boolean;
}

/** Whether the agent offers customers discounts in the workspace in scope, and its ceiling (C1); null before migration 0129. */
export async function customerOffersSetting(): Promise<CustomerOffersSetting | null> {
  const org = await platformDb()
    .from("orgs")
    .select("mode, customer_offers_on_at, customer_offers_max_pct")
    .eq("id", currentOrgId())
    .maybeSingle<{ mode: string; customer_offers_on_at: string | null; customer_offers_max_pct: string | null }>();
  if (org.error || !org.data) return null;
  const max = org.data.customer_offers_max_pct === null ? null : Number(org.data.customer_offers_max_pct);
  return { on: org.data.customer_offers_on_at !== null, maxPct: max !== null && Number.isFinite(max) ? max : null, sandbox: org.data.mode === "sandbox" };
}

/** The agent's discount offers turned on, with the most it gives, or off (C1); signed. */
export async function setCustomerOffers(input: { orgId: string; actorId: string; on: boolean; maxPct: number | null }): Promise<void> {
  if (input.on && (input.maxPct === null || !Number.isFinite(input.maxPct) || input.maxPct < CUSTOMER_MIN_CEILING_PCT || input.maxPct > CUSTOMER_MAX_CEILING_PCT)) {
    throw new CustomerOfferError(`Set the most to give from ${CUSTOMER_MIN_CEILING_PCT}% to ${CUSTOMER_MAX_CEILING_PCT}%.`);
  }
  const maxPct = input.on ? Math.round((input.maxPct as number) * 100) / 100 : null;
  const done = await platformDb().rpc("set_customer_offers", { p_org_id: input.orgId, p_on: input.on, p_max_pct: maxPct, p_by: input.actorId });
  if (done.error) throw new Error(done.error.message);
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "ar",
    action: input.on ? "customer_offers_on" : "customer_offers_off",
    summary: input.on ? `The agent offers customers up to ${(maxPct as number).toFixed(2)}% off for paying early while cash is short` : "The agent no longer offers customers discounts for paying early",
    detail: { by: input.actorId, ...(input.on ? { maxPct } : {}) },
  });
}

export interface MadeDiscountOffer {
  id: string;
  invoice_id: string;
  counterparty_id: string;
  amount: string;
  offered_amount: string;
  pay_by: string;
  expires_at: string;
}

/**
 * An offer the agent makes (C4): the row and its link, which the agent emails at once; the stage records it, with its
 * decision. Throws CustomerOfferError when the receivable can no longer take one.
 */
export async function createDiscountOffer(input: { orgId: string; invoiceId: string; pct: number; payBy: string; origin: string }): Promise<{ url: string; pct: number; row: MadeDiscountOffer }> {
  if (!Number.isFinite(input.pct) || input.pct < CUSTOMER_MIN_PCT || input.pct > CUSTOMER_MAX_CEILING_PCT) {
    throw new CustomerOfferError(`Give a discount from ${CUSTOMER_MIN_PCT}% to ${CUSTOMER_MAX_CEILING_PCT}%.`);
  }
  const pct = Math.round(input.pct * 100) / 100;
  const { token, secretHash } = generateDiscountToken();
  const made = await platformDb()
    .rpc("create_customer_discount_offer", { p_org_id: input.orgId, p_invoice_id: input.invoiceId, p_pct: pct, p_token_hash: secretHash, p_pay_by: input.payBy })
    .select("id, invoice_id, counterparty_id, amount, offered_amount, pay_by, expires_at")
    .single<MadeDiscountOffer>();
  if (made.error) {
    if (/^discount_(not_eligible|pay_by)/.test(made.error.message)) {
      throw new CustomerOfferError("This receivable can no longer take a discount offer: it changed, money was applied to it, or it falls due within 7 days.");
    }
    throw new Error(made.error.message);
  }
  return { url: discountUrl(input.origin, token), pct, row: made.data };
}

/** An offer the agent made and could not email (C7), withdrawn so its link never stands unseen; false when not open. */
export async function withdrawDiscountOffer(orgId: string, offerId: string): Promise<boolean> {
  const done = await platformDb().rpc("withdraw_customer_discount_offer", { p_org_id: orgId, p_offer_id: offerId });
  if (done.error) throw new Error(done.error.message);
  return done.data === true;
}

export interface DiscountPreview {
  orgName: string;
  customerName: string;
  reference: string | null;
  amount: number;
  discounted: number;
  currency: string;
  pct: number;
  dueDate: string;
  payBy: string;
}

/** What the customer's page shows (C4); null for a token that is not an open offer. */
export async function previewDiscount(token: string): Promise<DiscountPreview | null> {
  const tokenHash = discountTokenHash(token);
  if (!tokenHash) return null;
  const read = await platformDb().rpc("customer_discount_preview", { p_token_hash: tokenHash });
  if (read.error) throw new Error(read.error.message);
  const row = ((read.data ?? []) as Array<{ org_name: string; counterparty_name: string; memo: string | null; amount: string; offered_amount: string; currency: string; discount_pct: string; due_date: string; pay_by: string }>)[0];
  if (!row) return null;
  return {
    orgName: row.org_name,
    customerName: row.counterparty_name,
    reference: row.memo,
    amount: Number(row.amount),
    discounted: Number(row.offered_amount),
    currency: row.currency,
    pct: Number(row.discount_pct),
    dueDate: row.due_date,
    payBy: row.pay_by,
  };
}

export type DiscountDecision = { outcome: "accepted"; payUrl: string | null } | { outcome: "declined" | "changed" | "not_valid" };

/**
 * The customer's answer (C5), in one database step. Accepted, the receivable carries the discount until its pay-by day,
 * the ledger records it in the workspace, and the answer names the receivable's pay link for the page to send them on.
 */
export async function decideDiscount(token: string, accept: boolean, deps: { raise?: typeof runCycleSoon; origin?: string } = {}): Promise<DiscountDecision> {
  const tokenHash = discountTokenHash(token);
  if (!tokenHash) return { outcome: "not_valid" };
  const done = await platformDb().rpc("decide_customer_discount", { p_token_hash: tokenHash, p_accept: accept });
  if (done.error) throw new Error(done.error.message);
  const row = ((done.data ?? []) as Array<{ outcome: "accepted" | "declined" | "changed" | "not_valid"; offer_id: string | null; org_id: string | null; invoice_id: string | null; discount_pct: string | null; offered_amount: string | null; pay_by: string | null }>)[0];
  if (!row || !row.org_id || (row.outcome !== "accepted" && row.outcome !== "declined")) return { outcome: row?.outcome === "changed" ? "changed" : "not_valid" };
  const orgId = row.org_id;
  const invoiceId = row.invoice_id as string;
  let payUrl: string | null = null;
  await withOrg(orgId, async () => {
    await appendLedgerEntryBestEffort(orgId, {
      actor: "system",
      domain: "ar",
      action: row.outcome === "accepted" ? "customer_discount_accepted" : "customer_discount_declined",
      summary:
        row.outcome === "accepted"
          ? `The customer accepted ${Number(row.discount_pct).toFixed(2)}% off for paying by ${row.pay_by}: ${row.offered_amount} USDC`
          : "The customer declined the early-payment discount",
      detail: {
        offerId: row.offer_id,
        invoiceId,
        ...(row.outcome === "accepted" ? { discountPct: Number(row.discount_pct), offeredAmount: Number(row.offered_amount), payBy: row.pay_by, currency: "USDC" } : {}),
        via: "discount_link",
      },
    });
    if (row.outcome === "accepted") {
      const link = await db().from("receivable_links").select("token_enc, revoked_at").eq("invoice_id", invoiceId).maybeSingle<{ token_enc: unknown; revoked_at: string | null }>();
      const kept = !link.error && link.data && !link.data.revoked_at ? payLinkToken(orgId, link.data.token_enc) : null;
      payUrl = kept ? `${deps.origin ?? ""}/pay/${kept}` : null;
    }
  });
  if (row.outcome === "accepted") {
    const org = unwrap(await platformDb().from("orgs").select("mode").eq("id", orgId).single()) as { mode: "sandbox" | "live" };
    (deps.raise ?? runCycleSoon)({ orgId, sandbox: org.mode === "sandbox", kind: "customer_discount_accepted" });
    return { outcome: "accepted", payUrl };
  }
  return { outcome: "declined" };
}

/** What a receivable is owed at now, with the discount it carries while it applies (C6). Pure. */
export function owedNow(row: { amount: number; early_pay_discount_pct?: string | number | null; discount_due_date?: string | null }, now: Date): { owed: number; discount: { pct: number; payBy: string; full: number } | null } {
  const discount = invoiceDiscount(row);
  if (!discount || !discountApplies(discount, now)) return { owed: row.amount, discount: null };
  return { owed: amountToPay(row.amount, discount, now).amountPaid, discount: { pct: discount.pct, payBy: discount.deadline.slice(0, 10), full: row.amount } };
}

/** The discount a pay link's receivable carries now, for the pay page (C5); null when none applies. */
export async function payLinkDiscount(orgId: string, invoiceId: string, now: Date = new Date()): Promise<{ owed: number; pct: number; payBy: string; full: number } | null> {
  const read = await withOrg(orgId, async () =>
    db()
      .from("invoices")
      .select("amount, early_pay_discount_pct, discount_due_date")
      .eq("id", invoiceId)
      .eq("direction", "receivable")
      .maybeSingle<{ amount: string; early_pay_discount_pct: string | null; discount_due_date: string | null }>()
  );
  if (read.error || !read.data) return null;
  const { owed, discount } = owedNow({ ...read.data, amount: Number(read.data.amount) }, now);
  return discount ? { owed, ...discount } : null;
}

/**
 * What arrived for a receivable paid at the discount its customer accepted (C6), for the pay page's paid view: the
 * transfer matched to it, when the receivable carries a discount and that transfer was less than its amount. Null
 * otherwise, and the page says what it always said.
 */
export async function paidAtDiscount(orgId: string, invoiceId: string): Promise<number | null> {
  return withOrg(orgId, async () => {
    const invoice = await db()
      .from("invoices")
      .select("amount, early_pay_discount_pct")
      .eq("id", invoiceId)
      .eq("direction", "receivable")
      .maybeSingle<{ amount: string; early_pay_discount_pct: string | null }>();
    if (invoice.error || !invoice.data || invoice.data.early_pay_discount_pct === null) return null;
    const matched = await db().from("incoming_transfers").select("amount").eq("invoice_id", invoiceId);
    if (matched.error || !matched.data || matched.data.length !== 1) return null;
    const arrived = Number((matched.data[0] as { amount: string }).amount);
    return Number.isFinite(arrived) && arrived < Number(invoice.data.amount) ? arrived : null;
  });
}

export interface CustomerOffersView {
  setting: CustomerOffersSetting;
  recent: Array<{ id: string; customerName: string; pct: number; amount: number; discounted: number; status: string; payBy: string; at: string }>;
}

/** The setting and the latest offers, for Bills & receivables (C1); null before migration 0129. */
export async function customerOffersView(): Promise<CustomerOffersView | null> {
  const ready = await db().rpc("customer_discounts_ready");
  if (ready.error) return null;
  const setting = await customerOffersSetting();
  if (!setting) return null;
  const rows = unwrap(
    await db()
      .from("customer_discount_offers")
      .select("id, discount_pct, amount, offered_amount, status, pay_by, created_at, decided_at, paid_at, counterparties(name)")
      .order("created_at", { ascending: false })
      .limit(6)
  ) as unknown as Array<{ id: string; discount_pct: string; amount: string; offered_amount: string; status: string; pay_by: string; created_at: string; decided_at: string | null; paid_at: string | null; counterparties: { name: string } | null }>;
  return {
    setting,
    recent: rows.map((row) => ({
      id: row.id,
      customerName: row.counterparties?.name ?? "A customer",
      pct: Number(row.discount_pct),
      amount: Number(row.amount),
      discounted: Number(row.offered_amount),
      status: row.status,
      payBy: row.pay_by,
      at: row.paid_at ?? row.decided_at ?? row.created_at,
    })),
  };
}
