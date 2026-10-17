import crypto from "node:crypto";
import { z } from "zod";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { utcDay } from "../copy";
import {
  boundCustomerPct,
  cashShortfall,
  CUSTOMER_MIN_DAYS_EARLY,
  CUSTOMER_PAY_WITHIN_DAYS,
  CUSTOMER_SKIP_RETRY_DAYS,
  CUSTOMER_UNSENT_LEASE_MS,
  customerOfferAllowed,
  discountedAmount,
  payByDay,
  pickCustomerOffers,
  referenceCustomerDecision,
  suggestedCustomerPct,
  type CustomerOfferDecision,
} from "../customer-offers/rules";
import { createDiscountOffer, CustomerOfferError, withdrawDiscountOffer } from "../customer-offers/store";
import { platformDb, unwrap, type OrgDb } from "../dal";
import { customerDiscountEmail } from "../email/customer-discount";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "../email/send";
import { appendLedgerEntry } from "../ledger";
import { heldForCash } from "../next-step";
import { maskEmail } from "../payment-notices";
import { REASONING_RULE, REASONING_SHAPE } from "../reasoning-copy";
import { decide } from "./decide";
import type { CycleLogLine } from "./orchestrator";
import { agentPaused } from "./pause";

/**
 * The cycle's customer discounts stage (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md): once an
 * owner or admin turned it on (C1), while bills are held for want of cash, the agent offers customers a small discount to
 * pay open receivables within days (C2). For each receivable code allows, the model decides whether to offer and how much,
 * between 0.25% and the workspace's ceiling (C3). An offer's review is claimed before the offer is made, and its link is
 * emailed to the customer once, under the offer's own idempotency key; one not emailed is withdrawn (C7). Every decision is
 * signed. An offer changes nothing until the customer accepts it, and then only lowers what they owe until a set day (C8).
 *
 * Live workspaces only, never while the agent is paused or without email; before migration 0129 runs, nothing.
 */

const DAY_MS = 86_400_000;
/** The start of the UTC day after `day` (`YYYY-MM-DD`), for a filter on or before that day. */
const nextDayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString();
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const SYSTEM_PROMPT = `You are the receivables step of a treasury agent for a small business. Bills are held because the operating wallet cannot pay them, and the business turned on early-payment discounts for its customers: the agent may offer a customer a small discount, by email, to pay an open invoice within ${CUSTOMER_PAY_WITHIN_DAYS} days instead of on its due date. Code allows an offer on this invoice now. Decide whether to offer, and what discount to give.

- Every percent you give is money the business never receives. Give as little as will bring the money in: the suggested discount, 1% for each 30 days early, is a fair starting point.
- Give more, up to the ceiling, only when the money matters: the bills held for it are large or due soon, or the customer paid late before. A customer who accepted a discount before may take the same again.
- Skip when the money would come too late to help, the invoice is small next to the shortfall, or what you know of the customer says an offer would not be welcome.
- The written policy's answer is given as a reference: offer at the suggestion. Follow it unless the facts say otherwise, and say why when you depart from it.
- ${REASONING_RULE}

Respond with ONLY a single JSON object in the requested shape. No prose outside the JSON.`;

const offerSchema = z.object({
  action: z.enum(["offer", "skip"]),
  pct: z.coerce.number().optional(),
  reasoning: z.string().min(1).max(2000),
});

interface ReceivableRow {
  id: string;
  counterparty_id: string;
  amount: string;
  currency: string | null;
  due_date: string;
  memo: string | null;
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
  pay_by: string;
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

/** When a review is claimed: the clock's time, so a slow model call before it never shortens its lease; never before `now`. */
const claimedAt = (now: number) => new Date(Math.max(now, Date.now())).toISOString();

/** Whether the agent signed this offer as emailed (customer_discount_offered): the email went, whatever its review says. */
async function signedAsEmailed(orgDb: OrgDb, offerId: string): Promise<boolean> {
  const read = await orgDb.from("ledger_entries").select("seq").eq("action", "customer_discount_offered").eq("detail->>offerId", offerId).limit(1);
  return !read.error && Array.isArray(read.data) && read.data.length > 0;
}

const startOfDay = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** The stage: see the module comment. `operatingBalance` is the operating USDC left after this cycle's payments. */
export async function makeCustomerOffers(
  orgDb: OrgDb,
  input: { operatingBalance: number },
  options: { now?: number; send?: (message: EmailMessage) => Promise<SendResult>; origin?: string } = {}
): Promise<CycleLogLine[]> {
  const orgId = currentOrgId();
  const org = await platformDb()
    .from("orgs")
    .select("name, mode, customer_offers_on_at, customer_offers_max_pct")
    .eq("id", orgId)
    .single<{ name: string; mode: string; customer_offers_on_at: string | null; customer_offers_max_pct: string | null }>();
  // Before migration 0129 the columns are not there: nothing to do.
  if (org.error || !org.data) return [];
  const { name: orgName, mode, customer_offers_on_at: onAt } = org.data;
  const ceiling = Number(org.data.customer_offers_max_pct);
  // A sandbox has no wallet to receive a payment in, and its customers are sample data (C1).
  if (mode !== "live") return [];
  const on = onAt !== null && Number.isFinite(ceiling) && ceiling > 0;
  if (await agentPaused()) return [];
  const ready = await orgDb.rpc("customer_discounts_ready");
  if (ready.error) return [];
  const settings = options.send ? null : emailSettingsFromEnv();
  const send = options.send ?? (settings ? (message: EmailMessage) => sendEmail({ ...message, meter: "customer_discount" }, settings) : null);
  if (!send) return [];
  const now = options.now ?? Date.now();
  const origin = options.origin ?? siteOrigin();
  const today = new Date(startOfDay(now)).toISOString().slice(0, 10);
  const lines: CycleLogLine[] = [];

  const offers = unwrap(
    await orgDb.from("customer_discount_offers").select("id, invoice_id, counterparty_id, status, discount_pct, offered_amount, pay_by, decided_at, expires_at").order("created_at", { ascending: false }).limit(1000)
  ) as OfferRow[];

  // Reviews: an offer left unsent by a stopped run is withdrawn and its receivable weighed again; a skip, after 7 days (C7).
  const reviews = unwrap(await orgDb.from("customer_discount_reviews").select("id, invoice_id, action, offer_id, decided_at, emailed_at").limit(2000)) as ReviewRow[];
  const reviewed = new Set<string>();
  for (const review of reviews) {
    const age = now - Date.parse(review.decided_at);
    if (review.action === "offer" && !review.emailed_at && age > CUSTOMER_UNSENT_LEASE_MS) {
      // The offer it made: the one it names, or, when the run stopped before naming it, the receivable's open one.
      const offerId = review.offer_id ?? offers.find((row) => row.invoice_id === review.invoice_id && row.status === "open")?.id ?? null;
      // An offer signed as emailed went out, though its review was not marked so: marked now, never withdrawn.
      if (offerId && (await signedAsEmailed(orgDb, offerId))) {
        await orgDb.from("customer_discount_reviews").update({ offer_id: offerId, emailed_at: new Date(now).toISOString() }).eq("id", review.id);
        reviewed.add(review.invoice_id);
        continue;
      }
      if (offerId && (await withdrawDiscountOffer(orgId, offerId))) {
        const row = offers.find((offer) => offer.id === offerId);
        if (row) row.status = "withdrawn";
        await appendLedgerEntry({
          actor: "agent",
          domain: "ar",
          action: "customer_discount_withdrawn",
          summary: "Early-payment discount offer withdrawn: its email never went",
          detail: { offerId, invoiceId: review.invoice_id, reason: "not_emailed" },
        });
      }
      await orgDb.from("customer_discount_reviews").delete().eq("id", review.id);
      continue;
    }
    if (review.action === "skip" && age > CUSTOMER_SKIP_RETRY_DAYS * DAY_MS) {
      await orgDb.from("customer_discount_reviews").delete().eq("id", review.id);
      continue;
    }
    reviewed.add(review.invoice_id);
  }
  if (!on) return lines;

  // The shortfall (C2): the bills whose latest decision held them for want of cash, beyond the operating USDC and the
  // discounts already accepted and not yet paid. The cash set for a bill scheduled before the last of them falls due is
  // not there for a held one, and the reserve, which the policy counts for a later day, is (cash ahead A5).
  const held = unwrap(
    await orgDb.from("invoices").select("id, amount, currency, due_date").eq("direction", "payable").eq("status", "held").limit(500)
  ) as Array<{ id: string; amount: string; currency: string | null; due_date: string }>;
  const heldUsdc = held.filter((row) => (row.currency ?? "USDC") === "USDC");
  if (heldUsdc.length === 0) return lines;
  const decisions = unwrap(
    await orgDb
      .from("ledger_entries")
      .select("seq, detail")
      .in("action", ["ap_pay", "ap_hold"])
      .in("detail->>invoiceId", heldUsdc.map((row) => row.id))
      .order("seq", { ascending: false })
      .limit(1000)
  ) as Array<{ seq: number; detail: Record<string, unknown> }>;
  const latest = new Map<string, Record<string, unknown>>();
  for (const entry of decisions) {
    const id = typeof entry.detail.invoiceId === "string" ? entry.detail.invoiceId : null;
    if (id && !latest.has(id)) latest.set(id, entry.detail);
  }
  const heldForCashRows = heldUsdc.filter((row) => heldForCash(latest.get(row.id)));
  const heldForCashTotal = heldForCashRows.reduce((sum, row) => sum + Number(row.amount), 0);

  // What is already set for bills scheduled on or before the last held bill falls due, and the reserve (cash ahead A5).
  // A read that fails counts neither, as before.
  const lastHeldDay = heldForCashRows.map((row) => String(row.due_date).slice(0, 10)).sort().at(-1) ?? null;
  const [scheduledRead, reserveRead] = lastHeldDay
    ? await Promise.all([
        orgDb.from("invoices").select("amount, currency, scheduled_for").eq("direction", "payable").eq("status", "scheduled").lt("scheduled_for", nextDayStart(lastHeldDay)).limit(1000),
        orgDb.from("accounts").select("balance").eq("kind", "reserve").limit(1),
      ])
    : [null, null];
  const scheduledUsdc = ((scheduledRead?.error ? [] : (scheduledRead?.data ?? [])) as Array<{ amount: string; currency: string | null }>)
    .filter((row) => (row.currency ?? "USDC") === "USDC")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const reserveUsdc = reserveRead?.error ? 0 : Number((reserveRead?.data as Array<{ balance: string }> | null)?.[0]?.balance ?? 0) || 0;

  // Discounts accepted and still to come in (C2): their receivable still open, and their pay-by day not passed. One paid
  // in full instead, or by a person's allocation, is in the operating USDC already, or owed in full again.
  const acceptedRows = offers.filter((row) => row.status === "accepted" && String(row.pay_by).slice(0, 10) >= today);
  const stillOpen = acceptedRows.length
    ? new Set(
        (
          unwrap(await orgDb.from("invoices").select("id").in("id", acceptedRows.map((row) => row.invoice_id)).in("status", ["pending", "matched"])) as Array<{ id: string }>
        ).map((row) => row.id)
      )
    : new Set<string>();
  const acceptedUnpaid = acceptedRows.filter((row) => stillOpen.has(row.invoice_id)).reduce((sum, row) => sum + Number(row.offered_amount), 0);
  const shortfall = cashShortfall({ heldForCash: heldForCashTotal, scheduled: scheduledUsdc, operating: input.operatingBalance, reserve: reserveUsdc, acceptedUnpaid });
  if (shortfall <= 0) return lines;

  // A withdrawn offer is one whose email never went (C7): the customer never saw it, so it counts for nothing, and its
  // receivable is weighed again.
  const seenOffers = offers.filter((row) => row.status !== "withdrawn");
  const offeredInvoices = new Set(seenOffers.map((row) => row.invoice_id));
  const customer = (id: string) => {
    const mine = seenOffers.filter((row) => row.counterparty_id === id);
    const declined = mine.filter((row) => row.status === "declined" && row.decided_at).map((row) => row.decided_at as string).sort();
    return {
      made: mine.length,
      accepted: mine.filter((row) => row.status === "accepted" || row.status === "paid").length,
      paid: mine.filter((row) => row.status === "paid").length,
      declined: declined.length,
      acceptedPcts: mine.filter((row) => row.status === "accepted" || row.status === "paid").map((row) => Number(row.discount_pct)),
      lastDeclinedAt: declined.at(-1) ?? null,
      hasOpen: mine.some((row) => row.status === "open" && Date.parse(row.expires_at) > now),
    };
  };

  const soonest = new Date(startOfDay(now) + CUSTOMER_MIN_DAYS_EARLY * DAY_MS).toISOString();
  const receivables = unwrap(
    await orgDb
      .from("invoices")
      .select("id, counterparty_id, amount, currency, due_date, memo, early_pay_discount_pct, counterparties(name, notice_email)")
      .eq("direction", "receivable")
      .in("status", ["pending", "matched"])
      .is("early_pay_discount_pct", null)
      .gte("due_date", soonest)
      .order("due_date", { ascending: true })
      .limit(300)
  ) as unknown as ReceivableRow[];
  if (receivables.length === 0) return lines;
  const ids = receivables.map((row) => row.id);
  const [linksRead, appliedRead, matchedRead] = await Promise.all([
    orgDb.from("receivable_links").select("invoice_id, token_enc, revoked_at").in("invoice_id", ids),
    orgDb.from("receivable_allocations").select("invoice_id").in("invoice_id", ids),
    orgDb.from("incoming_transfers").select("invoice_id").in("invoice_id", ids),
  ]);
  const kept = new Set(
    ((linksRead.error ? [] : linksRead.data) as Array<{ invoice_id: string; token_enc: unknown; revoked_at: string | null }>)
      .filter((row) => row.token_enc && !row.revoked_at)
      .map((row) => row.invoice_id)
  );
  const partPaid = new Set([
    ...((appliedRead.error ? [] : appliedRead.data) as Array<{ invoice_id: string }>).map((row) => row.invoice_id),
    ...((matchedRead.error ? [] : matchedRead.data) as Array<{ invoice_id: string }>).map((row) => row.invoice_id),
  ]);

  const daysEarly = (row: ReceivableRow) => Math.round((startOfDay(Date.parse(row.due_date)) - startOfDay(now)) / DAY_MS);
  const allowed = receivables
    .filter((row) => {
      const history = customer(row.counterparty_id);
      return customerOfferAllowed({
        shortfall,
        open: true,
        currency: row.currency,
        daysEarly: daysEarly(row),
        partPaid: partPaid.has(row.id),
        offeredBefore: offeredInvoices.has(row.id),
        reviewed: reviewed.has(row.id),
        billingEmail: row.counterparties?.notice_email ?? null,
        payLink: kept.has(row.id),
        customerHasOpenOffer: history.hasOpen,
        customerDeclinedAt: history.lastDeclinedAt,
        now,
      }).allowed;
    })
    .map((row) => ({ row, amount: Number(row.amount) }));

  // One offer per customer in a run: a second would be its "other open offer" once the first goes out.
  const seen = new Set<string>();
  const onePerCustomer = allowed.sort((a, b) => b.amount - a.amount).filter(({ row }) => (seen.has(row.counterparty_id) ? false : (seen.add(row.counterparty_id), true)));
  let stillShort = shortfall;
  for (const { row, amount } of pickCustomerOffers(onePerCustomer, shortfall, ceiling)) {
    const customerName = row.counterparties?.name ?? "the customer";
    const email = row.counterparties?.notice_email as string;
    const history = customer(row.counterparty_id);
    const days = daysEarly(row);
    const suggested = suggestedCustomerPct(days, ceiling);
    const payBy = payByDay(today, new Date(row.due_date).toISOString().slice(0, 10));
    const reference = referenceCustomerDecision({ suggestedPct: suggested, daysEarly: days, shortfall: Number(stillShort.toFixed(6)) });
    const decided = await decide<CustomerOfferDecision>({
      purpose: "customer_discount",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to offer this customer a discount to pay this invoice early, and what discount to give.",
        invoice: { amount, currency: "USDC", dueDate: utcDay(row.due_date), daysEarly: days, payBy, reference: row.memo },
        customer: { name: customerName, offersBefore: { made: history.made, accepted: history.accepted, paidAtDiscount: history.paid, declined: history.declined, acceptedDiscountsPct: history.acceptedPcts } },
        cash: {
          billsHeldForCash: heldForCashRows.length,
          heldForCashUsdc: Number(heldForCashTotal.toFixed(6)),
          scheduledBeforeHeldBillsFallDueUsdc: Number(scheduledUsdc.toFixed(6)),
          operatingAfterTodaysPayments: input.operatingBalance,
          reserveUsdc,
          discountsAcceptedNotYetPaid: Number(acceptedUnpaid.toFixed(6)),
          shortfall: Number(stillShort.toFixed(6)),
        },
        discount: { suggestedPct: suggested, minPct: 0.25, ceilingPct: ceiling },
        writtenPolicy: reference,
        responseShape: { action: "offer | skip", pct: `0.25 to ${ceiling}, when offering`, reasoning: REASONING_SHAPE },
      }),
      schema: offerSchema,
      fallback: () => reference,
    });
    const value = decided.value;
    const referenceDecision = { action: reference.action, pct: reference.pct ?? null };

    if (value.action === "skip") {
      const claim = await orgDb.from("customer_discount_reviews").insert({ invoice_id: row.id, action: "skip", decided_at: claimedAt(now) }).select("id").single<{ id: string }>();
      if (claim.error?.code === "23505") continue;
      if (claim.error) throw new Error(claim.error.message);
      await appendLedgerEntry({
        actor: "agent",
        domain: "ar",
        action: "customer_discount_skipped",
        summary: `Decided not to offer ${customerName} a discount on ${AMOUNT.format(amount)} USDC due ${utcDay(row.due_date)}`,
        detail: { invoiceId: row.id, counterpartyId: row.counterparty_id, daysEarly: days, shortfall: Number(stillShort.toFixed(6)), decision: { action: "skip", reasoning: value.reasoning }, referenceDecision, decisionMode: decided.mode, agreedWithReference: decided.agreedWithReference },
      });
      lines.push({ domain: "ar", message: `${customerName}: no early-payment discount, weighed again in ${CUSTOMER_SKIP_RETRY_DAYS} days` });
      continue;
    }

    const bounded = boundCustomerPct(value.pct, suggested, ceiling);
    // Claimed before the offer is made: two runs at once never offer the same receivable twice (C7).
    const claim = await orgDb.from("customer_discount_reviews").insert({ invoice_id: row.id, action: "offer", discount_pct: bounded.pct, decided_at: claimedAt(now) }).select("id").single<{ id: string }>();
    if (claim.error?.code === "23505") continue;
    if (claim.error) throw new Error(claim.error.message);
    const release = () => orgDb.from("customer_discount_reviews").delete().eq("id", claim.data.id);

    let offer: Awaited<ReturnType<typeof createDiscountOffer>>;
    try {
      offer = await createDiscountOffer({ orgId, invoiceId: row.id, pct: bounded.pct, payBy, origin });
    } catch (error) {
      await release();
      if (error instanceof CustomerOfferError) continue;
      throw error;
    }
    const linked = await orgDb.from("customer_discount_reviews").update({ offer_id: offer.row.id }).eq("id", claim.data.id);
    if (linked.error) console.error("customer discount review not linked", row.id, linked.error.message);

    const message = customerDiscountEmail({
      orgName,
      customerName,
      reference: row.memo,
      amount: AMOUNT.format(Number(offer.row.amount)),
      discounted: AMOUNT.format(Number(offer.row.offered_amount)),
      token: "USDC",
      pct: offer.pct,
      dueOn: utcDay(row.due_date),
      payBy: utcDay(`${offer.row.pay_by}T12:00:00Z`),
      url: offer.url,
      origin,
    });
    const idempotencyKey = crypto.createHash("sha256").update(`customer_discount\n${offer.row.id}`, "utf8").digest("hex");
    const result = await send({ to: email, ...message, idempotencyKey });
    if (!result.sent) {
      // Never a link the customer did not get: withdrawn, and the receivable weighed again at the next cycle (C7).
      await withdrawDiscountOffer(orgId, offer.row.id);
      await release();
      console.error("customer discount email not sent", row.id, result.reason);
      lines.push({ domain: "ar", message: `Early-payment discount offer to ${customerName} not sent (${result.reason}); tried again at the next cycle` });
      continue;
    }
    // Marked emailed, tried twice: an emailed offer left unmarked is recognised by its signed entry, never withdrawn.
    const markEmailed = () => orgDb.from("customer_discount_reviews").update({ emailed_at: new Date().toISOString() }).eq("id", claim.data.id);
    const emailed = (await markEmailed()).error ? await markEmailed() : null;
    if (emailed?.error) console.error("customer discount review not marked emailed", row.id, emailed.error.message);
    stillShort = Math.max(0, stillShort - Number(offer.row.offered_amount));
    const reasoning = bounded.limited
      ? `${value.reasoning} [The model chose ${value.pct}%; code allows 0.25% to ${ceiling}%, so the offer gives ${bounded.pct}%.]`
      : value.reasoning;
    await appendLedgerEntry({
      actor: "agent",
      domain: "ar",
      action: "customer_discount_offered",
      summary: `Offered ${customerName} ${bounded.pct.toFixed(2)}% off for paying by ${utcDay(`${offer.row.pay_by}T12:00:00Z`)}: ${offer.row.offered_amount} USDC instead of ${offer.row.amount} on ${utcDay(row.due_date)}`,
      detail: {
        offerId: offer.row.id,
        invoiceId: row.id,
        counterpartyId: row.counterparty_id,
        to: maskEmail(email),
        discountPct: bounded.pct,
        amount: Number(offer.row.amount),
        offeredAmount: Number(offer.row.offered_amount),
        currency: "USDC",
        payBy: offer.row.pay_by,
        daysEarly: days,
        shortfall: Number(shortfall.toFixed(6)),
        decision: { action: "offer", pct: bounded.pct, reasoning },
        referenceDecision,
        decisionMode: decided.mode,
        agreedWithReference: decided.agreedWithReference,
        ...(bounded.limited ? { pctLimited: { chosen: value.pct, sent: bounded.pct } } : {}),
      },
    });
    lines.push({ domain: "ar", message: `Offered ${customerName} ${bounded.pct.toFixed(2)}% off by email for paying by ${offer.row.pay_by}: ${offer.row.offered_amount} USDC` });
  }
  return lines;
}

/** The discounted amount of a receivable at a percent, for callers that show it before an offer exists. */
export const customerDiscounted = discountedAmount;
