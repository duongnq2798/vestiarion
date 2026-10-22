import { latestDecision } from "./added-details";
import { readFrozenPayees } from "./address-change-check";
import { transferExists, type IntentState } from "./agent/approvals";
import { isReclaimable } from "./agent/claim-age";
import { twoApprovalsFacts } from "./agent/second-approval";
import { readPaymentPolicies } from "./approval-policy";
import { bankAccountsOf } from "./bank-payouts/store";
import { cosignState, type CosignFacts, type CosignState } from "./cosign-state-rules";
import { addressUnconfirmed } from "./counterparty-address";
import { db, unwrap, type OrgDb } from "./dal";
import { listLedgerEntriesForTargets } from "./ledger";
import { inCoolingOff, type PayeeLock } from "./payee-lock-rules";
import { needsTwoApprovals, weighedUsdc } from "./two-approvals";
import { verdictHolds } from "./verdicts";

export * from "./cosign-state-rules";

/**
 * Whether an accountant can co-sign a bill now (docs/superpowers/specs/2026-10-22-accountant-queue-design.md AQ1): one
 * answer, so the accountant console's queue and the approval card never promise a co-sign that `approveAndPay({ cosign:
 * true })` would refuse. `cosignState` is the rule, pure, in ./cosign-state-rules and re-exported here; `readCosignStates`
 * reads its facts for many bills at once, in the workspace in scope, through its tenant client.
 *
 * Who co-signs at all (an accountant, while an owner lets accountants co-sign) is the caller's check, as it is for the
 * co-sign itself. Left to the card's own refusal: a first payment to an address whose confirmation leaves the accountant
 * out, a bill the accountant entered, and the refusals no held bill is likely to meet (payments switched off, a
 * sanctioned address, a payee off the network).
 */

/** A bill waiting for a person, as the console and Approvals list it, for `readCosignStates`. */
export interface CosignPayable {
  id: string;
  amount: number;
  currency: "USDC" | "EURC";
  /** `held`, `flagged`, `awaiting_info`, or `processing` while someone's claim is on it. */
  status: string;
  /** When a `processing` row was claimed; null for any other. */
  reviewedAt: string | null;
  counterpartyId: string;
  riskLevel: string | null;
  /** The payee's address now: what an approval of it is bound to. Never shown. */
  address: string | null;
}

/** The ids per request, so a long list never makes one address too long to send. */
const CHUNK = 100;

function chunks<T>(values: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(values.length / CHUNK) }, (_, index) => values.slice(index * CHUNK, (index + 1) * CHUNK));
}

async function intentsOf(orgDb: OrgDb, ids: readonly string[]): Promise<Map<string, IntentState>> {
  const found = new Map<string, IntentState>();
  for (const part of chunks(ids)) {
    const rows = unwrap(
      await orgDb
        .from("payment_intents")
        .select("source_id, status, provider_tx_id, last_error, provider_state, updated_at, batch_key, transfer_attempt")
        .eq("source_type", "invoice")
        .in("source_id", part)
    ) as Array<IntentState & { source_id: string }>;
    for (const row of rows) found.set(row.source_id, row);
  }
  return found;
}

/**
 * Of these givers of a standing approval, the co-signing accountants: those who count (`approvers_among`) and are no
 * owner, admin or approver (`deciders_among`, migration 0138). Before 0138 nothing co-signs, so none are.
 */
async function cosigningAccountants(orgDb: OrgDb, givers: string[]): Promise<Set<string>> {
  if (givers.length === 0) return new Set();
  const result = await orgDb.rpc("deciders_among", { p_users: givers });
  if (result.error) {
    if (result.error.code === "PGRST202" || result.error.code === "42883") return new Set();
    throw new Error(result.error.message);
  }
  const deciders = new Set((result.data as string[] | null) ?? []);
  return new Set(givers.filter((giver) => !deciders.has(giver)));
}

/** What the payee lock holds each payee for (PL4, PL5), read only while it is on; a payee paid to its bank account, none. */
async function lockHolds(orgDb: OrgDb, lock: PayeeLock, counterpartyIds: string[], now: number): Promise<Map<string, "unconfirmed" | "cooling">> {
  const holds = new Map<string, "unconfirmed" | "cooling">();
  if (!lock.on || counterpartyIds.length === 0) return holds;
  const banked = await bankAccountsOf(counterpartyIds, orgDb);
  const paidToAddress = counterpartyIds.filter((id) => !banked.has(id));
  for (const part of chunks(paidToAddress)) {
    const rows = unwrap(await orgDb.from("counterparties").select("id, address_changed_at, address_confirmed_at").in("id", part)) as Array<{
      id: string;
      address_changed_at: string | null;
      address_confirmed_at: string | null;
    }>;
    for (const row of rows) {
      if (addressUnconfirmed(row.address_changed_at, row.address_confirmed_at)) holds.set(row.id, "unconfirmed");
      else if (inCoolingOff(row.address_changed_at, lock, now)) holds.set(row.id, "cooling");
    }
  }
  return holds;
}

/**
 * Each bill's co-sign state for this viewer (AQ1), in the workspace in scope. A handful of requests however many bills:
 * the figure with the payee lock, then only as far as an answer is still open, a EURC bill's recorded USDC value, the
 * bills' payment intents, their standing approvals (`twoApprovalsFacts`), which of those are co-signs, frozen payees, the
 * lock's holds and the shadow-mode verdicts. It never reads a quote, a balance or Circle. A figure that cannot be read
 * throws, as every read of it does: the caller names the part as unread.
 */
export async function readCosignStates(viewerId: string, payables: readonly CosignPayable[], now: number = Date.now()): Promise<Map<string, CosignState>> {
  const states = new Map<string, CosignState>();
  if (payables.length === 0) return states;
  const orgDb = db();
  const { twoApprovalsAbove: above, payeeLock } = await readPaymentPolicies(orgDb);

  const facts = new Map<string, CosignFacts>(
    payables.map((payable) => [
      payable.id,
      {
        above,
        payment: { amount: payable.amount, currency: payable.currency },
        sent: false,
        approvals: [],
        verdict: null,
        deciding: payable.status === "processing" && !isReclaimable(payable.status, payable.reviewedAt, now),
        riskLevel: payable.riskLevel,
        frozen: false,
        lock: null,
      },
    ])
  );
  const settle = () => {
    for (const payable of payables) states.set(payable.id, cosignState(facts.get(payable.id) as CosignFacts, viewerId));
    return states;
  };
  if (above === null) return settle();

  // A EURC bill is weighed at the USDC value its latest decision recorded, and counted above when none did (two approvals
  // T2), as Approve and pay weighs it.
  const eurc = payables.filter((payable) => payable.currency === "EURC").map((payable) => payable.id);
  const [entries, intents] = await Promise.all([eurc.length > 0 ? listLedgerEntriesForTargets({ invoiceIds: eurc }) : Promise.resolve([]), intentsOf(orgDb, payables.map((payable) => payable.id))]);
  for (const payable of payables) {
    const fact = facts.get(payable.id) as CosignFacts;
    if (payable.currency === "EURC") {
      const value = latestDecision(entries, payable.id)?.detail.usdcValue;
      fact.payment = { ...fact.payment, usdcValue: typeof value === "number" ? value : null };
    }
    fact.sent = transferExists(intents.get(payable.id) ?? null);
  }
  const needing = payables.filter((payable) => {
    const fact = facts.get(payable.id) as CosignFacts;
    return !fact.sent && needsTwoApprovals(fact.payment, above);
  });
  if (needing.length === 0) return settle();

  // The approvals that stand, bound to each bill as it stands now. Nobody is left out here: who entered a bill, or gave
  // its first payment's address, is the card's to explain.
  const standing = await twoApprovalsFacts(
    "invoice",
    needing.map((payable) => ({
      id: payable.id,
      payment: { amount: payable.amount, currency: payable.currency, address: payable.address },
      weighed: weighedUsdc((facts.get(payable.id) as CosignFacts).payment),
      excluded: [],
      sent: false,
    })),
    above
  );
  const othersOf = (id: string) => (standing.get(id)?.approvals ?? []).filter((approval) => approval.by !== viewerId);
  const viewerGave = (id: string) => (standing.get(id)?.approvals ?? []).some((approval) => approval.by === viewerId);
  // Whether one other approval is a co-sign matters only where it is the only other one.
  const lone = needing.filter((payable) => !viewerGave(payable.id) && othersOf(payable.id).length === 1);
  const accountants = await cosigningAccountants(orgDb, [...new Set(lone.map((payable) => othersOf(payable.id)[0].by))]);
  for (const payable of needing) {
    (facts.get(payable.id) as CosignFacts).approvals = (standing.get(payable.id)?.approvals ?? []).map((approval) => ({ by: approval.by, cosign: accountants.has(approval.by) }));
  }

  // What could still refuse a co-sign, read only for the bills one could still be given on.
  const open = needing.filter((payable) => cosignState(facts.get(payable.id) as CosignFacts, viewerId).state === "can_cosign");
  if (open.length === 0) return settle();
  const payees = [...new Set(open.map((payable) => payable.counterpartyId))];
  const [frozen, holds, verdicts] = await Promise.all([
    readFrozenPayees(payees, orgDb),
    lockHolds(orgDb, payeeLock, payees, now),
    // A verdict holds a bill only while it is held, or claimed by someone (verdictGate).
    verdictHolds(open.filter((payable) => payable.status === "held" || payable.status === "processing").map((payable) => payable.id)),
  ]);
  for (const payable of open) {
    const fact = facts.get(payable.id) as CosignFacts;
    fact.frozen = frozen.has(payable.counterpartyId);
    fact.lock = holds.get(payable.counterpartyId) ?? null;
    fact.verdict = verdicts.waiting.has(payable.id) ? "waiting" : verdicts.disagreed.has(payable.id) ? "disagreed" : null;
  }
  return settle();
}
