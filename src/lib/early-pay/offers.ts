import crypto from "node:crypto";
import { runCycleSoon } from "../agent/cycle-soon";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { AGENT_MAX_CEILING_PCT, AGENT_MIN_CEILING_PCT } from "./agent-rules";
import { MAX_OFFER_PCT, MIN_OFFER_PCT, suggestOffer, type OfferCandidate, type OffersView } from "./offers-words";

export * from "./offers-words";

/**
 * Early-payment offers (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md): an owner or admin offers a
 * supplier earlier payment for a discount, through a one-time link; an accepted offer puts the discount on the bill,
 * ending today, and the agent pays it in a cycle started at once, after every check any bill gets.
 *
 * A token is `vxo_` and 43 base64url characters (32 random bytes). Only the SHA-256 of the secret is kept (0125); it is
 * shown once, when the offer is made.
 */

export const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN = /^vxo_([A-Za-z0-9_-]{43})$/;
const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export class OfferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferError";
  }
}

export function generateOfferToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; secretHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxo_${secret}`, secretHash: sha256hex(secret) };
}

/** The stored hash for a well-formed token; null for anything else, which is never looked up. */
export function offerTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}

export function offerUrl(origin: string, token: string): string {
  return `${origin}/offer/${token}`;
}

type InvoiceRow = { id: string; amount: string; currency: string | null; due_date: string; memo: string | null; status: string; counterparties: { name: string } | null };
type OfferRow = { id: string; invoice_id: string; discount_pct: string; offered_amount: string; counter_pct?: string | null; status: string; expires_at: string; decided_at: string | null; counterparties: { name: string } | null };

/**
 * The bills worth an offer (E1, E2), in the workspace in scope: each with its suggestion, or the offer already out for
 * it. Null before migration 0125.
 */
export async function offersView(now: Date = new Date()): Promise<OffersView | null> {
  const ready = await db().rpc("early_payment_offers_ready");
  if (ready.error) return null;
  const soonest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 3)).toISOString();
  const invoices = unwrap(
    await db()
      .from("invoices")
      .select("id, amount, currency, due_date, memo, status, counterparties(name)")
      .eq("direction", "payable")
      .in("status", ["scheduled", "pending"])
      .is("early_pay_discount_pct", null)
      .gte("due_date", soonest)
      .order("due_date", { ascending: true })
      .limit(40)
  ) as unknown as InvoiceRow[];
  const ids = invoices.map((row) => row.id);
  const started = ids.length
    ? new Set((unwrap(await db().from("payment_intents").select("source_id").eq("source_type", "invoice").in("source_id", ids)) as Array<{ source_id: string }>).map((row) => row.source_id))
    : new Set<string>();
  const offersRead = (columns: string) => db().from("early_payment_offers").select(columns).order("created_at", { ascending: false }).limit(60);
  // With each counter (0127); before that migration runs, as before.
  const withCounters = await offersRead("id, invoice_id, discount_pct, offered_amount, counter_pct, status, expires_at, decided_at, counterparties(name)");
  const offers = (withCounters.error ? unwrap(await offersRead("id, invoice_id, discount_pct, offered_amount, status, expires_at, decided_at, counterparties(name)")) : withCounters.data) as unknown as OfferRow[];
  const reserve = (unwrap(await db().from("accounts").select("apy").eq("kind", "reserve").maybeSingle()) as { apy: string | null } | null) ?? null;
  const reserveApy = reserve?.apy != null && Number.isFinite(Number(reserve.apy)) ? Number(reserve.apy) : 0;
  // An offer out, or one a supplier countered that the agent has not answered yet (offer counters N7).
  const openBy = new Map(offers.filter((row) => (row.status === "open" && Date.parse(row.expires_at) > now.getTime()) || row.status === "countered").map((row) => [row.invoice_id, row] as const));
  const agent = await agentOffersSetting();
  // The offers the agent made (0126): read best effort, so an offer out says who made it.
  const reviews = agent ? await db().from("early_payment_offer_reviews").select("offer_id").not("offer_id", "is", null).limit(500) : null;
  const byAgent = new Set(((reviews && !reviews.error ? reviews.data : []) as Array<{ offer_id: string | null }>).map((row) => row.offer_id));
  const candidates = invoices
    .filter((row) => !started.has(row.id) && Number(row.amount) > 0)
    .map((row): OfferCandidate => {
      const open = openBy.get(row.id);
      return {
        invoiceId: row.id,
        counterpartyName: row.counterparties?.name ?? "This supplier",
        reference: row.memo,
        amount: Number(row.amount),
        currency: row.currency === "EURC" ? "EURC" : "USDC",
        dueDate: row.due_date,
        suggestion: suggestOffer({ dueDate: row.due_date, now, reserveApy }),
        open: open ? { id: open.id, pct: Number(open.discount_pct), offered: Number(open.offered_amount), expiresAt: open.expires_at, byAgent: byAgent.has(open.id), counterPct: open.status === "countered" && open.counter_pct != null ? Number(open.counter_pct) : null } : null,
      };
    })
    .slice(0, 12);
  const recent = offers
    .filter((row): row is OfferRow & { status: "accepted" | "declined" | "withdrawn"; decided_at: string } => (row.status === "accepted" || row.status === "declined" || row.status === "withdrawn") && row.decided_at !== null)
    .slice(0, 5)
    .map((row) => ({ id: row.id, counterpartyName: row.counterparties?.name ?? "A supplier", pct: Number(row.discount_pct), status: row.status, decidedAt: row.decided_at, counterPct: row.counter_pct != null ? Number(row.counter_pct) : null }));
  return { reserveApy, agent, candidates, recent };
}

/** Whether the agent makes offers in the workspace in scope, and its ceiling (AO1); null before migration 0126. */
export async function agentOffersSetting(): Promise<{ on: boolean; maxPct: number | null } | null> {
  const org = await platformDb().from("orgs").select("early_offers_on_at, early_offers_max_pct").eq("id", currentOrgId()).maybeSingle<{ early_offers_on_at: string | null; early_offers_max_pct: string | null }>();
  if (org.error || !org.data) return null;
  const max = org.data.early_offers_max_pct === null ? null : Number(org.data.early_offers_max_pct);
  return { on: org.data.early_offers_on_at !== null, maxPct: max !== null && Number.isFinite(max) ? max : null };
}

/** The agent's offers turned on, with the most it asks, or off (AO1); recorded in the ledger. */
export async function setAgentOffers(input: { orgId: string; actorId: string; on: boolean; maxPct: number | null }): Promise<void> {
  if (input.on && (input.maxPct === null || !Number.isFinite(input.maxPct) || input.maxPct < AGENT_MIN_CEILING_PCT || input.maxPct > AGENT_MAX_CEILING_PCT)) {
    throw new OfferError(`Set the most to ask from ${AGENT_MIN_CEILING_PCT}% to ${AGENT_MAX_CEILING_PCT}%.`);
  }
  const maxPct = input.on ? Math.round((input.maxPct as number) * 100) / 100 : null;
  const done = await platformDb().rpc("set_agent_early_offers", { p_org_id: input.orgId, p_on: input.on, p_max_pct: maxPct, p_by: input.actorId });
  if (done.error) throw new Error(done.error.message);
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "ap",
    action: input.on ? "early_offers_on" : "early_offers_off",
    summary: input.on ? `The agent makes early-payment offers, asking at most ${(maxPct as number).toFixed(2)}%` : "The agent no longer makes early-payment offers",
    detail: { by: input.actorId, ...(input.on ? { maxPct } : {}) },
  });
}

export interface MadeOffer {
  id: string;
  invoice_id: string;
  counterparty_id: string;
  amount: string;
  offered_amount: string;
  currency: string;
  expires_at: string;
}

/** The offer row made under a new token (E3), by a person or by the agent (null); the token is returned, never kept. */
async function insertOffer(input: { orgId: string; actorId: string | null; invoiceId: string; pct: number; now?: number }): Promise<{ token: string; pct: number; row: MadeOffer }> {
  if (!Number.isFinite(input.pct) || input.pct < MIN_OFFER_PCT || input.pct > MAX_OFFER_PCT) {
    throw new OfferError(`Ask a discount from ${MIN_OFFER_PCT}% to ${MAX_OFFER_PCT}%.`);
  }
  const pct = Math.round(input.pct * 100) / 100;
  const { token, secretHash } = generateOfferToken();
  const expires = new Date((input.now ?? Date.now()) + OFFER_TTL_MS).toISOString();
  const made = await platformDb()
    .rpc("create_early_payment_offer", { p_org_id: input.orgId, p_invoice_id: input.invoiceId, p_pct: pct, p_token_hash: secretHash, p_by: input.actorId, p_expires_at: expires })
    .select("id, invoice_id, counterparty_id, amount, offered_amount, currency, expires_at")
    .single<MadeOffer>();
  if (made.error) {
    if (/^offer_not_eligible/.test(made.error.message)) {
      throw new OfferError("This bill can no longer take an offer: it changed, a payment started, or it falls due within 3 days.");
    }
    throw new Error(made.error.message);
  }
  return { token, pct, row: made.data };
}

/**
 * An offer the agent makes (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md AO4): the row and its
 * link, which the agent emails at once; the stage records it, with its decision.
 */
export async function createAgentOffer(input: { orgId: string; invoiceId: string; pct: number; origin: string; now?: number }): Promise<{ url: string; pct: number; row: MadeOffer }> {
  const { token, pct, row } = await insertOffer({ ...input, actorId: null });
  return { url: offerUrl(input.origin, token), pct, row };
}

/** An offer the agent made and could not email (AO4), withdrawn so its link never stands unseen; false when not open. */
export async function withdrawAgentOffer(orgId: string, offerId: string): Promise<boolean> {
  const done = await platformDb().rpc("withdraw_early_payment_offer", { p_org_id: orgId, p_offer_id: offerId, p_by: null });
  if (done.error) throw new Error(done.error.message);
  return done.data === true;
}

/** An offer made for a bill (E3), recorded; the link is returned once and never kept. */
export async function createOffer(input: { orgId: string; actorId: string; invoiceId: string; pct: number; origin: string; now?: number }): Promise<{ url: string; offered: number; expiresAt: string }> {
  const { token, pct, row } = await insertOffer(input);
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "ap",
    action: "early_payment_offered",
    summary: `Offered to pay early for ${pct.toFixed(2)}% off: ${row.offered_amount} ${row.currency} instead of ${row.amount}`,
    detail: { by: input.actorId, offerId: row.id, invoiceId: row.invoice_id, counterpartyId: row.counterparty_id, discountPct: pct, amount: Number(row.amount), offeredAmount: Number(row.offered_amount), currency: row.currency, expiresAt: row.expires_at },
  });
  return { url: offerUrl(input.origin, token), offered: Number(row.offered_amount), expiresAt: row.expires_at };
}

/** An open offer withdrawn (E6); false when it was not open. */
export async function withdrawOffer(input: { orgId: string; actorId: string; offerId: string }): Promise<boolean> {
  const done = await platformDb().rpc("withdraw_early_payment_offer", { p_org_id: input.orgId, p_offer_id: input.offerId, p_by: input.actorId });
  if (done.error) throw new Error(done.error.message);
  if (done.data !== true) return false;
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "ap",
    action: "early_payment_offer_withdrawn",
    summary: "Early-payment offer withdrawn",
    detail: { by: input.actorId, offerId: input.offerId },
  });
  return true;
}

export interface OfferPreview {
  orgName: string;
  counterpartyName: string;
  reference: string | null;
  amount: number;
  offered: number;
  currency: string;
  pct: number;
  dueDate: string;
  expiresAt: string;
}

/** What the supplier's page shows (E4); null for a token that is not an open offer. */
export async function previewOffer(token: string): Promise<OfferPreview | null> {
  const tokenHash = offerTokenHash(token);
  if (!tokenHash) return null;
  const read = await platformDb().rpc("early_payment_offer_preview", { p_token_hash: tokenHash });
  if (read.error) throw new Error(read.error.message);
  const row = ((read.data ?? []) as Array<{ org_name: string; counterparty_name: string; memo: string | null; amount: string; offered_amount: string; currency: string; discount_pct: string; due_date: string; expires_at: string }>)[0];
  if (!row) return null;
  return {
    orgName: row.org_name,
    counterpartyName: row.counterparty_name,
    reference: row.memo,
    amount: Number(row.amount),
    offered: Number(row.offered_amount),
    currency: row.currency,
    pct: Number(row.discount_pct),
    dueDate: row.due_date,
    expiresAt: row.expires_at,
  };
}

export type OfferDecision = "accepted" | "declined" | "bill_changed" | "not_valid";

/**
 * The supplier's answer (E5, E6), in one database step. Accepted, the bill carries the discount ending today, the ledger
 * records it in the workspace, and a cycle starts at once to decide and pay it.
 */
export async function decideOffer(token: string, accept: boolean, deps: { raise?: typeof runCycleSoon } = {}): Promise<OfferDecision> {
  const tokenHash = offerTokenHash(token);
  if (!tokenHash) return "not_valid";
  const done = await platformDb().rpc("decide_early_payment_offer", { p_token_hash: tokenHash, p_accept: accept });
  if (done.error) throw new Error(done.error.message);
  const row = ((done.data ?? []) as Array<{ outcome: OfferDecision; offer_id: string | null; org_id: string | null; invoice_id: string | null; discount_pct: string | null; offered_amount: string | null; currency: string | null }>)[0];
  if (!row || !row.org_id || (row.outcome !== "accepted" && row.outcome !== "declined")) return row?.outcome ?? "not_valid";
  const orgId = row.org_id;
  const org = unwrap(await platformDb().from("orgs").select("mode").eq("id", orgId).single()) as { mode: "sandbox" | "live" };
  await withOrg(orgId, async () => {
    await appendLedgerEntryBestEffort(orgId, {
      actor: "system",
      domain: "ap",
      action: row.outcome === "accepted" ? "early_payment_offer_accepted" : "early_payment_offer_declined",
      summary:
        row.outcome === "accepted"
          ? `The supplier accepted ${Number(row.discount_pct).toFixed(2)}% off for payment today: ${row.offered_amount} ${row.currency}`
          : "The supplier declined the early-payment offer",
      detail: {
        offerId: row.offer_id,
        invoiceId: row.invoice_id,
        ...(row.outcome === "accepted" ? { discountPct: Number(row.discount_pct), offeredAmount: Number(row.offered_amount), currency: row.currency } : {}),
        via: "offer_link",
      },
    });
  });
  if (row.outcome === "accepted") (deps.raise ?? runCycleSoon)({ orgId, sandbox: org.mode === "sandbox", kind: "early_payment_accepted" });
  return row.outcome;
}

/** Whether an open offer is the agent's, so the supplier's page offers a counter (docs/superpowers/specs/2026-10-17-offer-counters-design.md N1). */
export async function offerByAgent(token: string): Promise<boolean> {
  const tokenHash = offerTokenHash(token);
  if (!tokenHash) return false;
  const read = await platformDb().rpc("early_payment_offer_by_agent", { p_token_hash: tokenHash });
  // Before migration 0127, or on any error: no counter, the offer is answered as before.
  if (read.error) return false;
  return read.data === true;
}

export type CounterOutcome = "countered" | "not_agent" | "bad_pct" | "not_valid";

/**
 * The supplier's counter (N2), in one database step: a smaller discount on an offer the agent made. Recorded in the
 * workspace, and a cycle starts at once for the agent to answer it.
 */
export async function counterOffer(token: string, pct: number, deps: { raise?: typeof runCycleSoon } = {}): Promise<CounterOutcome> {
  const tokenHash = offerTokenHash(token);
  if (!tokenHash || !Number.isFinite(pct)) return tokenHash ? "bad_pct" : "not_valid";
  const done = await platformDb().rpc("counter_early_payment_offer", { p_token_hash: tokenHash, p_pct: Math.round(pct * 100) / 100 });
  if (done.error) throw new Error(done.error.message);
  const row = ((done.data ?? []) as Array<{ outcome: CounterOutcome; offer_id: string | null; org_id: string | null; invoice_id: string | null; counter_pct: string | null; discount_pct: string | null; currency: string | null }>)[0];
  if (!row || row.outcome !== "countered" || !row.org_id) return row?.outcome ?? "not_valid";
  const orgId = row.org_id;
  const org = unwrap(await platformDb().from("orgs").select("mode").eq("id", orgId).single()) as { mode: "sandbox" | "live" };
  await withOrg(orgId, async () => {
    await appendLedgerEntryBestEffort(orgId, {
      actor: "system",
      domain: "ap",
      action: "early_payment_offer_countered",
      summary: `The supplier proposed ${Number(row.counter_pct).toFixed(2)}% off instead of ${Number(row.discount_pct).toFixed(2)}%`,
      detail: { offerId: row.offer_id, invoiceId: row.invoice_id, counterPct: Number(row.counter_pct), discountPct: Number(row.discount_pct), currency: row.currency, via: "offer_link" },
    });
  });
  (deps.raise ?? runCycleSoon)({ orgId, sandbox: org.mode === "sandbox", kind: "early_payment_countered" });
  return "countered";
}
