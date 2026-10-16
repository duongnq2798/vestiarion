import crypto from "node:crypto";
import { z } from "zod";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { utcDay } from "../copy";
import { platformDb, unwrap, type OrgDb } from "../dal";
import {
  AGENT_OFFERS_PER_RUN,
  agentOfferAllowed,
  boundOfferPct,
  CASH_HORIZON_DAYS,
  cashForOffers,
  referenceOfferDecision,
  SKIP_RETRY_DAYS,
  UNSENT_LEASE_MS,
  type AgentOfferDecision,
} from "../early-pay/agent-rules";
import { createAgentOffer, OfferError, withdrawAgentOffer } from "../early-pay/offers";
import { offeredAmount, suggestOffer } from "../early-pay/offers-words";
import { earlyPaymentOfferEmail } from "../email/early-payment-offer";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "../email/send";
import { appendLedgerEntry } from "../ledger";
import { maskEmail } from "../payment-notices";
import { REASONING_RULE, REASONING_SHAPE } from "../reasoning-copy";
import { decide } from "./decide";
import type { CycleLogLine } from "./orchestrator";
import { agentPaused } from "./pause";

/**
 * The cycle's early-payment offers stage (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md): once
 * an owner or admin turned it on (AO1), for each bill the agent scheduled for later where code allows an offer now (AO2),
 * the model decides whether to offer the supplier payment today for a discount, and how much, between the suggested
 * discount and the workspace's ceiling (AO3). An offer's review is claimed before the offer is made, and its link is
 * emailed to the supplier once, under the offer's own idempotency key; one not emailed is withdrawn (AO4). Every
 * decision is signed (AO5). An offer changes nothing until the supplier accepts it, and the payment that follows passes
 * every check any bill gets (AO6).
 *
 * Live workspaces only, never while the agent is paused or without email; before migration 0126 runs, nothing.
 */

const DAY_MS = 86_400_000;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const SYSTEM_PROMPT = `You are the early-payment step of a treasury agent for a small business. The business scheduled a bill to pay on its due date, and turned on early-payment offers: the agent may offer the supplier payment today, for a discount, by email. Code allows an offer on this bill now. Decide whether to offer, and what discount to ask.

- The floor you are given is already twice what the cash would earn in the reserve by the due date: an accepted offer at the floor or above is worth more than keeping the cash.
- Ask between the floor and the ceiling. A higher discount saves more but is less likely to be accepted; a supplier who accepted before at some discount may take it again, and a small bill or a supplier who never answered calls for the floor.
- Skip when an offer would add little, for example a bill only a few days past the minimum, or when what you know of the supplier says it would not be welcome.
- The written policy's answer is given as a reference: offer at the floor. Follow it unless the facts say otherwise, and say why when you depart from it.
- ${REASONING_RULE}

Respond with ONLY a single JSON object in the requested shape. No prose outside the JSON.`;

const offerSchema = z.object({
  action: z.enum(["offer", "skip"]),
  pct: z.coerce.number().optional(),
  reasoning: z.string().min(1).max(2000),
});

interface PayableRow {
  id: string;
  counterparty_id: string;
  amount: string;
  currency: string | null;
  due_date: string;
  memo: string | null;
  status: string;
  direction: string;
  early_pay_discount_pct: string | null;
  counterparties: { name: string; notice_email: string | null } | null;
}

interface OfferRow {
  id: string;
  invoice_id: string;
  counterparty_id: string;
  status: string;
  discount_pct: string;
  offered_amount: string;
  decided_at: string | null;
  expires_at: string;
}

interface ReviewRow {
  id: string;
  invoice_id: string;
  action: "offer" | "skip";
  offer_id: string | null;
  decided_at: string;
  emailed_at: string | null;
}

interface SupplierHistory {
  made: number;
  accepted: number;
  declined: number;
  acceptedPcts: number[];
  lastDeclinedAt: string | null;
  hasOpen: boolean;
}

const startOfDay = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** The stage: see the module comment. `operatingBalance` is the operating USDC left after this cycle's payments. */
export async function makeEarlyPaymentOffers(
  orgDb: OrgDb,
  input: { operatingBalance: number; reserveApy: number },
  options: { now?: number; send?: (message: EmailMessage) => Promise<SendResult>; origin?: string } = {}
): Promise<CycleLogLine[]> {
  const orgId = currentOrgId();
  const org = await platformDb().from("orgs").select("name, mode, early_offers_on_at, early_offers_max_pct").eq("id", orgId).single<{ name: string; mode: string; early_offers_on_at: string | null; early_offers_max_pct: string | null }>();
  // Before migration 0126 the columns are not there: nothing to do.
  if (org.error || !org.data) return [];
  const { name: orgName, mode, early_offers_on_at: onAt } = org.data;
  const ceiling = Number(org.data.early_offers_max_pct);
  // A sandbox's suppliers are sample data: it never emails them (AO1).
  if (mode !== "live" || !onAt || !Number.isFinite(ceiling) || ceiling <= 0) return [];
  if (await agentPaused()) return [];
  const ready = await orgDb.rpc("early_payment_offer_reviews_ready");
  if (ready.error) return [];
  const settings = options.send ? null : emailSettingsFromEnv();
  const send = options.send ?? (settings ? (message: EmailMessage) => sendEmail({ ...message, meter: "early_offer" }, settings) : null);
  if (!send) return [];
  const now = options.now ?? Date.now();
  const origin = options.origin ?? siteOrigin();
  const lines: CycleLogLine[] = [];

  // Reviews: an offer left unsent by a stopped run is withdrawn and its bill weighed again; a skip, after SKIP_RETRY_DAYS.
  const reviews = unwrap(await orgDb.from("early_payment_offer_reviews").select("id, invoice_id, action, offer_id, decided_at, emailed_at").limit(2000)) as ReviewRow[];
  const reviewed = new Set<string>();
  for (const review of reviews) {
    const age = now - Date.parse(review.decided_at);
    if (review.action === "offer" && !review.emailed_at && age > UNSENT_LEASE_MS) {
      if (review.offer_id && (await withdrawAgentOffer(orgId, review.offer_id))) {
        await appendLedgerEntry({
          actor: "agent",
          domain: "ap",
          action: "early_payment_offer_withdrawn",
          summary: "Early-payment offer withdrawn: its email never went",
          detail: { offerId: review.offer_id, invoiceId: review.invoice_id, via: "agent", reason: "not_emailed" },
        });
      }
      await orgDb.from("early_payment_offer_reviews").delete().eq("id", review.id);
      continue;
    }
    if (review.action === "skip" && age > SKIP_RETRY_DAYS * DAY_MS) {
      await orgDb.from("early_payment_offer_reviews").delete().eq("id", review.id);
      continue;
    }
    reviewed.add(review.invoice_id);
  }

  const payables = (
    unwrap(
      await orgDb
        .from("invoices")
        .select("id, counterparty_id, amount, currency, due_date, memo, status, direction, early_pay_discount_pct, counterparties(name, notice_email)")
        .eq("direction", "payable")
        .in("status", ["pending", "scheduled"])
        .order("due_date", { ascending: true })
        .limit(500)
    ) as unknown as PayableRow[]
  ).filter((row) => row.direction === "payable");
  if (payables.length === 0) return lines;

  const offers = unwrap(
    await orgDb.from("early_payment_offers").select("id, invoice_id, counterparty_id, status, discount_pct, offered_amount, decided_at, expires_at").order("created_at", { ascending: false }).limit(1000)
  ) as OfferRow[];
  const offeredInvoices = new Set(offers.map((row) => row.invoice_id));
  const isOpen = (row: OfferRow) => row.status === "open" && Date.parse(row.expires_at) > now;
  const history = new Map<string, SupplierHistory>();
  for (const row of offers) {
    const entry = history.get(row.counterparty_id) ?? { made: 0, accepted: 0, declined: 0, acceptedPcts: [], lastDeclinedAt: null, hasOpen: false };
    entry.made += 1;
    if (row.status === "accepted") {
      entry.accepted += 1;
      entry.acceptedPcts.push(Number(row.discount_pct));
    }
    if (row.status === "declined") {
      entry.declined += 1;
      if (row.decided_at && (!entry.lastDeclinedAt || row.decided_at > entry.lastDeclinedAt)) entry.lastDeclinedAt = row.decided_at;
    }
    if (isOpen(row)) entry.hasOpen = true;
    history.set(row.counterparty_id, entry);
  }

  // The cash code leaves for offers (AO2): what falls due within the horizon comes first, then the offers already out.
  const horizon = startOfDay(now) + CASH_HORIZON_DAYS * DAY_MS;
  const dueSoon = payables.filter((row) => (row.currency ?? "USDC") === "USDC" && Date.parse(row.due_date) < horizon).reduce((sum, row) => sum + Number(row.amount), 0);
  const openOffered = offers.filter(isOpen).reduce((sum, row) => sum + Number(row.offered_amount), 0);
  let available = cashForOffers({ operating: input.operatingBalance, dueSoon, openOffers: openOffered });

  const scheduled = payables.filter((row) => row.status === "scheduled" && row.early_pay_discount_pct === null);
  const started = scheduled.length
    ? new Set(
        (unwrap(await orgDb.from("payment_intents").select("source_id").eq("source_type", "invoice").in("source_id", scheduled.map((row) => row.id))) as Array<{ source_id: string }>).map((row) => row.source_id)
      )
    : new Set<string>();
  const candidates = scheduled
    .filter((row) => !started.has(row.id) && Number(row.amount) > 0)
    .map((row) => ({ row, suggestion: suggestOffer({ dueDate: row.due_date, now: new Date(now), reserveApy: input.reserveApy }) }))
    // The most days early first: where an offer is worth the most.
    .sort((a, b) => b.suggestion.days - a.suggestion.days);

  let made = 0;
  for (const { row, suggestion } of candidates) {
    if (made >= AGENT_OFFERS_PER_RUN) break;
    const supplier = history.get(row.counterparty_id) ?? { made: 0, accepted: 0, declined: 0, acceptedPcts: [], lastDeclinedAt: null, hasOpen: false };
    const amount = Number(row.amount);
    const email = row.counterparties?.notice_email ?? null;
    const allowance = agentOfferAllowed({
      status: row.status,
      currency: row.currency,
      daysEarly: suggestion.days,
      offeredBefore: offeredInvoices.has(row.id),
      reviewed: reviewed.has(row.id),
      noticeEmail: email,
      supplierHasOpenOffer: supplier.hasOpen,
      supplierDeclinedAt: supplier.lastDeclinedAt,
      floorPct: suggestion.pct,
      ceilingPct: ceiling,
      offeredAtFloor: offeredAmount(amount, suggestion.pct),
      cashForOffers: available,
      now,
    });
    if (!allowance.allowed) continue;
    const supplierName = row.counterparties?.name ?? "the supplier";
    const reference = referenceOfferDecision({ floorPct: suggestion.pct, daysEarly: suggestion.days, annualPct: suggestion.annualPct });
    const decided = await decide<AgentOfferDecision>({
      purpose: "early_offer",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to offer this supplier payment today for a discount, and what discount to ask.",
        bill: { amount, currency: "USDC", dueDate: utcDay(row.due_date), daysEarly: suggestion.days, reference: row.memo },
        supplier: { name: supplierName, offersBefore: { made: supplier.made, accepted: supplier.accepted, declined: supplier.declined, acceptedDiscountsPct: supplier.acceptedPcts } },
        reserve: { apy: input.reserveApy, earnsByDueDatePct: suggestion.breakEvenPct },
        discount: { floorPct: suggestion.pct, ceilingPct: ceiling, floorWorthAYearPct: suggestion.annualPct },
        cash: { operatingAfterTodaysPayments: input.operatingBalance, dueWithinSevenDays: Number(dueSoon.toFixed(6)), offersAlreadyOut: Number(openOffered.toFixed(6)), leftForOffers: available },
        writtenPolicy: reference,
        responseShape: { action: "offer | skip", pct: `${suggestion.pct} to ${ceiling}, when offering`, reasoning: REASONING_SHAPE },
      }),
      schema: offerSchema,
      fallback: () => reference,
    });
    const value = decided.value;
    const referenceDecision = { action: reference.action, pct: reference.pct ?? null };

    if (value.action === "skip") {
      const claim = await orgDb.from("early_payment_offer_reviews").insert({ invoice_id: row.id, action: "skip", decided_at: new Date(now).toISOString() }).select("id").single<{ id: string }>();
      if (claim.error?.code === "23505") continue;
      if (claim.error) throw new Error(claim.error.message);
      await appendLedgerEntry({
        actor: "agent",
        domain: "ap",
        action: "early_payment_offer_skipped",
        summary: `Decided not to offer ${supplierName} early payment on ${AMOUNT.format(amount)} USDC due ${utcDay(row.due_date)}`,
        detail: { invoiceId: row.id, counterpartyId: row.counterparty_id, daysEarly: suggestion.days, decision: { action: "skip", reasoning: value.reasoning }, referenceDecision, decisionMode: decided.mode, agreedWithReference: decided.agreedWithReference },
      });
      lines.push({ domain: "ap", message: `${supplierName}: no early-payment offer, weighed again in ${SKIP_RETRY_DAYS} days` });
      continue;
    }

    const bounded = boundOfferPct(value.pct, suggestion.pct, ceiling);
    const offered = offeredAmount(amount, bounded.pct);
    if (offered > available) continue;
    // Claimed before the offer is made: two runs at once never offer the same bill twice (AO4).
    const claim = await orgDb.from("early_payment_offer_reviews").insert({ invoice_id: row.id, action: "offer", discount_pct: bounded.pct, decided_at: new Date(now).toISOString() }).select("id").single<{ id: string }>();
    if (claim.error?.code === "23505") continue;
    if (claim.error) throw new Error(claim.error.message);
    const release = () => orgDb.from("early_payment_offer_reviews").delete().eq("id", claim.data.id);

    let offer: Awaited<ReturnType<typeof createAgentOffer>>;
    try {
      offer = await createAgentOffer({ orgId, invoiceId: row.id, pct: bounded.pct, origin, now });
    } catch (error) {
      await release();
      if (error instanceof OfferError) continue;
      throw error;
    }
    const linked = await orgDb.from("early_payment_offer_reviews").update({ offer_id: offer.row.id }).eq("id", claim.data.id);
    if (linked.error) console.error("early-payment offer review not linked", row.id, linked.error.message);

    const message = earlyPaymentOfferEmail({
      orgName,
      supplierName,
      reference: row.memo,
      amount: AMOUNT.format(Number(offer.row.amount)),
      offered: AMOUNT.format(Number(offer.row.offered_amount)),
      token: offer.row.currency,
      pct: offer.pct,
      dueOn: utcDay(row.due_date),
      until: utcDay(offer.row.expires_at),
      url: offer.url,
      origin,
    });
    const idempotencyKey = crypto.createHash("sha256").update(`early_payment_offer\n${offer.row.id}`, "utf8").digest("hex");
    const result = await send({ to: email as string, ...message, idempotencyKey });
    if (!result.sent) {
      // Never a link the supplier did not get: withdrawn, and the bill weighed again at the next cycle (AO4).
      await withdrawAgentOffer(orgId, offer.row.id);
      await release();
      console.error("early-payment offer email not sent", row.id, result.reason);
      lines.push({ domain: "ap", message: `Early-payment offer to ${supplierName} not sent (${result.reason}); tried again at the next cycle` });
      continue;
    }
    const emailed = await orgDb.from("early_payment_offer_reviews").update({ emailed_at: new Date().toISOString() }).eq("id", claim.data.id);
    if (emailed.error) console.error("early-payment offer review not marked emailed", row.id, emailed.error.message);
    available = Number((available - Number(offer.row.offered_amount)).toFixed(6));
    made += 1;
    const reasoning = bounded.limited
      ? `${value.reasoning} [The model asked ${value.pct}%; code allows ${suggestion.pct}% to ${ceiling}%, so the offer asks ${bounded.pct}%.]`
      : value.reasoning;
    await appendLedgerEntry({
      actor: "agent",
      domain: "ap",
      action: "early_payment_offered",
      summary: `Offered ${supplierName} early payment for ${bounded.pct.toFixed(2)}% off: ${offer.row.offered_amount} ${offer.row.currency} today instead of ${offer.row.amount} on ${utcDay(row.due_date)}`,
      detail: {
        via: "agent",
        offerId: offer.row.id,
        invoiceId: row.id,
        counterpartyId: row.counterparty_id,
        to: maskEmail(email as string),
        discountPct: bounded.pct,
        amount: Number(offer.row.amount),
        offeredAmount: Number(offer.row.offered_amount),
        currency: offer.row.currency,
        expiresAt: offer.row.expires_at,
        daysEarly: suggestion.days,
        decision: { action: "offer", pct: bounded.pct, reasoning },
        referenceDecision,
        decisionMode: decided.mode,
        agreedWithReference: decided.agreedWithReference,
        ...(bounded.limited ? { pctLimited: { chosen: value.pct, sent: bounded.pct } } : {}),
      },
    });
    lines.push({ domain: "ap", message: `Offered ${supplierName} early payment by email: ${bounded.pct.toFixed(2)}% off, ${offer.row.offered_amount} USDC today` });
  }
  return lines;
}
