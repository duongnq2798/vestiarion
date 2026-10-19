import { z } from "zod";
import { chainById, txUrl } from "./payee-chains";
import { utcDay } from "./copy";
import { ruleWords } from "./rule-words";
import type { SignedLink } from "./receipts/verify";

/** Public facts only. Times describe when the workspace recorded evidence, never an inferred send/block time. */
export interface TeamJourneyEvent { seq: number; recordedAt: string; action: string; link: SignedLink }
export interface TeamJourneyDecision { payOn: string; reason: "no_early_payment_discount" | null }
export interface TeamJourney {
  amount: number;
  currency: string;
  network: "arc-mainnet";
  status: "paid";
  received: TeamJourneyEvent | null;
  check: TeamJourneyEvent | null;
  hold: TeamJourneyEvent | null;
  approval: TeamJourneyEvent | null;
  record: TeamJourneyEvent | null;
  observed: { hasPurchaseOrder: boolean | null; goodsReceived: boolean | null; purchaseOrderRequired: boolean | null; riskLevel: "unscreened" | "clear" | "medium" | "high" | null };
  rule: string | null;
  decision?: TeamJourneyDecision | null;
  payment: {
    route: "direct" | "cctp";
    confirmationRecordedAt: string | null;
    source: { chain: "ARC"; hash: string; url: string };
    destination: { chain: "ARC" | "BASE"; hash: string; url: string };
    feeUsdc: number | null;
  };
  publicKeys: Record<string, string>;
}
export interface TeamJourneys { direct: TeamJourney | null; base: TeamJourney | null }

/** Ranks the two validated RPC candidates by a complete, readable story; both views must use the same selection. */
export function selectTeamJourneys(journeys: TeamJourneys | null | undefined): { primary: TeamJourney | null; secondary: TeamJourney | null } {
  const direct = journeys?.direct?.payment.route === "direct" && journeys.direct.payment.destination.chain === "ARC" ? journeys.direct : null;
  const base = journeys?.base?.payment.route === "cctp" && journeys.base.payment.destination.chain === "BASE" ? journeys.base : null;
  function complete(bill: TeamJourney | null) {
    if (!bill?.check || !bill.hold || !bill.approval || !bill.record || !ruleWords(bill.rule) || !bill.payment.confirmationRecordedAt) return false;
    return bill.check.action === "ap_schedule" ? !!bill.decision
      : ["ap_pay", "ap_hold", "ap_request_info", "ap_flag_fraud"].includes(bill.check.action);
  }
  const primary = complete(base) ? base : complete(direct) ? direct : direct ?? base;
  return { primary, secondary: primary === base ? direct : primary ? base : null };
}

const instant = z.iso.datetime({ offset: true });
const hex = (length: number) => z.string().regex(new RegExp(`^[a-f0-9]{${length}}$`, "i"));
const hash = z.string().regex(/^0x[0-9a-f]{64}$/i);
const number = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)]).pipe(z.number().finite());
const eventSchema = z.object({
  seq: number.pipe(z.number().int().positive()), recordedAt: instant,
  action: z.enum(["create_invoice", "ap_pay", "ap_schedule", "ap_hold", "ap_request_info", "ap_flag_fraud", "approval_given", "approval_paid", "ap_reconcile"]),
  link: z.object({ body_hash: hex(64), signature: hex(128), prev_hash: hex(64), hash: hex(64), signing_key_id: hex(16).nullable() }),
});
const event = z.unknown().transform(value => eventSchema.safeParse(value).data ?? null);
const risk = z.unknown().transform(value => z.enum(["unscreened", "clear", "medium", "high"]).safeParse(value).data ?? null);
const marker = z.unknown().transform(value => typeof value === "string" && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value) && ruleWords(value) ? value : null);
const decisionSchema = z.object({ payOn: z.iso.date(), reason: z.unknown().transform(value => value === "no_early_payment_discount" ? value : null) });
const decision = z.unknown().optional().transform(value => decisionSchema.safeParse(value).data ?? null);
const factsSchema = z.object({
  amount: number.pipe(z.number().positive()), currency: z.enum(["USDC", "EURC"]), network: z.literal("arc-mainnet"), status: z.literal("paid"),
  received: event, check: event, hold: event, approval: event, record: event,
  observed: z.object({ hasPurchaseOrder: z.boolean().nullable(), goodsReceived: z.boolean().nullable(), purchaseOrderRequired: z.boolean().nullable(), riskLevel: risk }),
  rule: marker,
  decision,
  payment: z.object({ route: z.enum(["direct", "cctp"]), confirmationRecordedAt: instant.nullable(), txHash: hash, mintTxHash: hash.nullable(), destinationChain: z.enum(["ARC", "BASE"]), feeUsdc: number.pipe(z.number().nonnegative()).nullable() }),
});

/** Validates a sanitized RPC row, strips extras and builds explorer URLs from the recorded chains. Missing events stay unknown. */
export function teamJourneyView(value: unknown, publicKeys: Record<string, string>): TeamJourney | null {
  const parsed = factsSchema.safeParse(value);
  if (!parsed.success) return null;
  const { payment, ...facts } = parsed.data;
  if (payment.route === "cctp" ? payment.destinationChain !== "BASE" || !payment.mintTxHash || facts.currency !== "USDC" : payment.destinationChain !== "ARC") return null;
  const source = { chain: "ARC" as const, hash: payment.txHash, url: txUrl("arc-mainnet", payment.txHash) };
  const destination = payment.route === "direct" ? source : { chain: "BASE" as const, hash: payment.mintTxHash!, url: `${chainById("BASE").explorerTx}${payment.mintTxHash}` };
  return {
    ...facts,
    observed: facts.check ? facts.observed : { hasPurchaseOrder: null, goodsReceived: null, purchaseOrderRequired: null, riskLevel: null },
    rule: facts.hold ? facts.rule : null,
    decision: facts.check?.action === "ap_schedule" ? facts.decision : null,
    payment: { route: payment.route, confirmationRecordedAt: payment.confirmationRecordedAt, source, destination, feeUsdc: payment.feeUsdc }, publicKeys,
  };
}

/** Condenses a recorded schedule without publishing its free text. Unsupported explanations remain unknown. */
export function teamJourneyDecision(value: unknown, currency: string): TeamJourneyDecision | null {
  const object = (item: unknown): Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const detail = object(value);
  const recorded = object(detail.decision);
  const payOn = z.iso.date().safeParse(recorded.payOn).data;
  if (recorded.action !== "schedule" || !payOn) return null;
  const timing = object(detail.timing);
  const today = z.iso.date().safeParse(timing.today).data;
  const amount = typeof timing.amountDueAtTarget === "number" && Number.isFinite(timing.amountDueAtTarget) && timing.amountDueAtTarget > 0 ? timing.amountDueAtTarget : null;
  const noDiscount = today && payOn > today && timing.dueOn === payOn && timing.targetOn === payOn
    && timing.discountValue === null && timing.shortfall === false && amount !== null && ["USDC", "EURC"].includes(currency)
    && timing.reason === `No early-payment discount; paying on the due date, ${utcDay(payOn)}, keeps ${amount} ${currency} available until then.`;
  return { payOn, reason: noDiscount ? "no_early_payment_discount" : null };
}
