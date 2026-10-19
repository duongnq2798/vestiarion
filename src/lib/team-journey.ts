import { z } from "zod";
import { chainById, txUrl } from "./payee-chains";
import { ruleWords } from "./rule-words";
import type { SignedLink } from "./receipts/verify";

/** Public facts only. Times describe when the workspace recorded evidence, never an inferred send/block time. */
export interface TeamJourneyEvent { seq: number; recordedAt: string; action: string; link: SignedLink }
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
const factsSchema = z.object({
  amount: number.pipe(z.number().positive()), currency: z.enum(["USDC", "EURC"]), network: z.literal("arc-mainnet"), status: z.literal("paid"),
  received: event, check: event, hold: event, approval: event, record: event,
  observed: z.object({ hasPurchaseOrder: z.boolean().nullable(), goodsReceived: z.boolean().nullable(), purchaseOrderRequired: z.boolean().nullable(), riskLevel: risk }),
  rule: marker,
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
    payment: { route: payment.route, confirmationRecordedAt: payment.confirmationRecordedAt, source, destination, feeUsdc: payment.feeUsdc }, publicKeys,
  };
}
