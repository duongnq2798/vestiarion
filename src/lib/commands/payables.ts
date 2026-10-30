import { addInvoiceDetails, approveAndPay, approveAndPayMany, ApprovalError, rejectInvoice, returnInvoice, type SelectionDecision } from "../agent/approvals";
import { runCycleSoon } from "../agent/cycle-soon";
import { fromReserveNote, fromReserveStaysNote } from "../agent/liquidity";
import { sendNoticesSoon } from "../payment-notices-soon";
import { accessOf, cycleEventOf, provenanceOf, type Actor } from "./actor";
import { checkChatDecision, type ShownCard } from "./chat-decisions";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";
import { APPROVAL_RECORDED } from "../two-approvals";
import { activityAmount } from "../agent-activity";
import { recordDecisionReason } from "../decision-reasons";
import { txUrl } from "../payee-chains";
import { SIMULATED_NETWORK, type PaymentReceipt } from "../payment-receipt";
import { workspaceNetwork } from "../workspace-network";

/**
 * A person's decisions on a payable the agent stopped (integrations design §9, Phase 0): the console's Approvals
 * buttons, and any surface allowed to run them. Each calls the approvals library as the console always has; what
 * follows a decision (the payee's notice, the agent's next look) is raised here, so every surface gets it (R5).
 *
 * A decision from any surface but the console answers a card the surface showed (`card`), and passes the chat's rules
 * first (src/lib/commands/chat-decisions.ts, Slack design S10); an approval then pays the address those rules checked.
 * A payable held in shadow mode for a person's verdict is settled through one (shadow mode S4): the verdict's own
 * settling passes `forVerdict`, and the approvals library refuses every other before a verdict is given.
 *
 * Paying, rejecting or returning what the agent stopped goes against it: a reason the person gave, which is never
 * required, is kept once the decision is made (capability and reasons R10, R11). Only the console's: it is the one
 * surface that says, where the reason is typed, that Vestiarion's team reads it. Slack sends no reason today, and the
 * other surfaces decide no payable; a reason one ever sends still goes into the decision's own ledger entry, as before,
 * and nowhere else. A verdict keeps its own (src/lib/verdicts.ts), so a decision settling one keeps none here.
 */

/** The chat's rules for a decision from any surface but the console; the console's decisions pass untouched. */
async function chatRules(actor: Actor, decision: "approve" | "reject" | "return", invoiceId: string, card: ShownCard | undefined) {
  if (actor.surface.kind === "console") return { ok: true as const, address: undefined };
  const check = await checkChatDecision(actor, decision, invoiceId, card);
  return check.ok ? { ok: true as const, address: check.address ?? undefined } : check;
}

/** The verdict's own settling of a payable held for one, passed on only when it is that (shadow mode S4). */
const verdictSettles = (input: { forVerdict?: boolean }) => (input.forVerdict ? { forVerdict: true } : {});

/**
 * Keeps the reason given in the console for a decision on a payable, unless a verdict settles it, which keeps its own.
 * Never throws.
 */
async function keepReason(actor: Actor, source: "approvals.pay_held" | "approvals.reject" | "approvals.return", input: { invoiceId: string; reason?: string | null; forVerdict?: boolean }) {
  if (input.forVerdict || actor.surface.kind !== "console") return;
  await recordDecisionReason({ source, surface: actor.surface.kind, subject: "invoice", subjectId: input.invoiceId, reason: input.reason, givenBy: actor.userId });
}

/** A transaction on chain, which the explorer opens; Circle's own ids before it is on chain are not. */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

type Paid = NonNullable<Awaited<ReturnType<typeof approveAndPay>>["paid"]>;

/**
 * A person's confirmation of a payment in words: what went out, to whom and on which network, and who said so (settlement
 * lifecycle I17). Paid only once Circle confirmed it, or simulated in a sandbox; submitted while Circle has not
 * confirmed it; and, with no Circle id, a send Circle never answered, whose outcome is unknown. A send in flight is
 * never called simulated (L4).
 */
function paidMessage(status: "paid" | "matched", paid: Paid | undefined, txRef: string | null): string {
  if (!paid) return status === "paid" ? "Paid." : "Payment submitted; waiting for Circle to confirm it.";
  const what = `${activityAmount(paid.amount, paid.currency)} to ${paid.payee}`;
  const network = workspaceNetwork().label;
  if (status === "paid") return paid.simulated ? `Paid ${what} in the sandbox (simulated).` : `Paid ${what}; Circle confirmed it on ${network}.`;
  return txRef
    ? `Submitted ${what}; waiting for Circle to confirm it on ${network}.`
    : `Submitted ${what}; Circle has not answered yet, so the outcome is unknown and nothing goes out again until it does.`;
}

/**
 * The same confirmation for a screen to lay out (payment confirmation): confirmed only once Circle says so, an unknown
 * outcome when Circle never answered the send (no Circle id), the transaction once it has a hash, and whether the person
 * approved the agent's stop or agreed with its decision. Only a confirmed payment is called simulated (L4).
 */
function paymentReceipt(status: "paid" | "matched", paid: Paid, txRef: string | null, fromReserveUsdc: number | undefined, forVerdict: boolean): PaymentReceipt {
  const network = workspaceNetwork();
  return {
    state: status === "paid" ? "confirmed" : "confirming",
    ...(status === "matched" && !txRef ? { outcomeUnknown: true as const } : {}),
    amount: paid.amount,
    currency: paid.currency,
    payee: paid.payee,
    network: paid.simulated && status === "paid" ? SIMULATED_NETWORK : network.label,
    decidedBy: forVerdict ? "verdict" : "approval",
    txUrl: !paid.simulated && txRef && TX_HASH.test(txRef) ? txUrl(network.id, txRef) : null,
    fromReserve: fromReserveNote(fromReserveUsdc).trim() || null,
  };
}

/** An `ApprovalError` carries a message safe to show; anything else goes to the server log. */
function approvalRefusal(error: unknown): Refused {
  if (error instanceof ApprovalError) return refused(error.code, error.message);
  console.error("approval action failed", error);
  return refused("failed", TRY_AGAIN);
}

/**
 * `payInvoice`'s note on a failed transfer reads ` [transfer failed: <reason>]`, or ` [execution failed: <reason>]`
 * for one that never reached the provider. The reason, for the person who pressed Approve and pay; a note in neither
 * shape is shown trimmed, whole, rather than dropped.
 */
export function heldMessage(note: string): string {
  const match = /\[(?:transfer|execution) failed:\s*(.+?)\]\s*$/.exec(note);
  const reason = match ? match[1] : note.trim();
  return `The transfer failed: ${reason}. The invoice is held.`;
}

export async function approvePayable(
  actor: Actor,
  input: { invoiceId: string; shownAddress?: string; card?: ShownCard; forVerdict?: boolean; reason?: string }
): Promise<CommandOutcome<{ status: "paid" | "matched" | "approved"; txRef: string | null; receipt?: PaymentReceipt }>> {
  const refusal = gate(actor, "payable.approve");
  if (refusal) return refusal;
  let result: Awaited<ReturnType<typeof approveAndPay>>;
  try {
    const chat = await chatRules(actor, "approve", input.invoiceId, input.card);
    if (!chat.ok) return chat.refusal;
    const shownAddress = actor.surface.kind === "console" ? input.shownAddress : chat.address;
    result = await approveAndPay({ actorId: actor.userId, invoiceId: input.invoiceId, shownAddress, ...provenanceOf(actor), ...verdictSettles(input) });
  } catch (error) {
    return approvalRefusal(error);
  }
  // A failed transfer leaves the invoice held with the provider's reason: something changed, and it is still a failure.
  // Cash brought back from the reserve for it stays in the operating wallet, which is said too (review finding 8).
  if (result.status === "held") return refused("transfer_failed", `${heldMessage(result.note)}${fromReserveStaysNote(result.fromReserveUsdc)}`, { changed: true });
  // A reason for paying a held bill, only where this approval decided a new payment: not where it read an earlier transfer,
  // or asked Circle for it again under its key, which pays nothing new (payment exceptions E3).
  if (!result.checkedFirst) await keepReason(actor, "approvals.pay_held", input);
  // Above the workspace's figure, the first of two approvals is recorded and sends nothing (two approvals T4, T8).
  if (result.status === "approved") return done(APPROVAL_RECORDED, { status: "approved", txRef: null });
  // A confirmed payment's payee hears of it now, not at the next cycle (payment notices R5).
  if (result.status === "paid") sendNoticesSoon(accessOf(actor));
  // What went out, to whom and on which network, in words and laid out with its transaction one click away; cash
  // brought back from the reserve to pay it is said too (approval cash R4).
  const message = paidMessage(result.status, result.paid, result.txRef);
  const receipt = result.paid ? paymentReceipt(result.status, result.paid, result.txRef, result.fromReserveUsdc, input.forVerdict === true) : null;
  return done(`${message}${fromReserveNote(result.fromReserveUsdc)}`, { status: result.status, txRef: result.txRef, ...(receipt ? { receipt } : {}) });
}

/** One bill's line in what a selection's confirmation says (docs/superpowers/specs/2026-10-30-approve-many-design.md AM11). */
export interface SelectionLine {
  invoiceId: string;
  /** Whom it pays, and what: what went out once it did, the bill's amount otherwise; null for a bill not read as waiting. */
  payee: string | null;
  amount: number | null;
  currency: string | null;
  /** Paid; submitted, awaiting confirmation; approved, one more approval pays it; held after a failed transfer; refused. */
  outcome: "paid" | "submitted" | "approved" | "held" | "refused";
  /** In the words `approvePayable` uses for one bill: what went out, or why it was not paid. */
  message: string;
  txRef: string | null;
}

/** The one Arc transaction several bills of a selection shared, said once with its link (AM11). */
export interface SharedTransaction {
  txRef: string | null;
  /** How many bills it carried. */
  size: number;
  /** Its transaction on the explorer, once it has a hash; null in a sandbox. */
  txUrl: string | null;
  message: string;
}

/**
 * Several held payables approved with one confirmation, from the console's Approvals page only (approve many AM1, AM13):
 * each decided as `approvePayable` decides one, through `approveAndPayMany`. What follows is raised once for the
 * selection: the reason, kept for each bill whose approval went against the agent's hold and decided a new payment
 * (AM9), and one `sendNoticesSoon` for the payees of confirmed payments (AM10). A selection refused whole (AM3, AM4) is
 * one refusal; otherwise one line per bill, in order, and the transaction bills shared, when they did (AM11).
 */
export async function approvePayables(
  actor: Actor,
  input: { items: Array<{ invoiceId: string; shownAddress?: string }>; reason?: string }
): Promise<CommandOutcome<{ bills: SelectionLine[]; transaction: SharedTransaction | null }>> {
  const refusal = gate(actor, "payable.approve_many");
  if (refusal) return refusal;
  let decisions: SelectionDecision[];
  try {
    decisions = await approveAndPayMany({ actorId: actor.userId, items: input.items, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  // As `approvePayable` keeps it: not for a failed transfer, nor for an approval that only checked an earlier one (R10).
  for (const decision of decisions) {
    const outcome = decision.outcome;
    if (!outcome || outcome.status === "held" || outcome.checkedFirst || !decision.overridesHold) continue;
    await keepReason(actor, "approvals.pay_held", { invoiceId: decision.invoiceId, reason: input.reason });
  }
  // Confirmed payments' payees hear of them now, once for the selection (payment notices R5).
  if (decisions.some((decision) => decision.outcome?.status === "paid")) sendNoticesSoon(accessOf(actor));
  const bills = decisions.map(selectionLine);
  return done(selectionSummary(bills), { bills, transaction: sharedTransaction(decisions) });
}

/** A bill's line, in the words `approvePayable` gives it alone (AM11). */
function selectionLine(decision: SelectionDecision): SelectionLine {
  const bill = { invoiceId: decision.invoiceId, payee: decision.bill?.payee ?? null, amount: decision.bill?.amount ?? null, currency: decision.bill?.currency ?? null };
  const outcome = decision.outcome;
  if (!outcome) return { ...bill, outcome: "refused", message: approvalRefusal(decision.error).message, txRef: null };
  if (outcome.status === "held") return { ...bill, outcome: "held", message: heldMessage(outcome.note), txRef: outcome.txRef };
  if (outcome.status === "approved") return { ...bill, outcome: "approved", message: APPROVAL_RECORDED, txRef: null };
  return {
    ...bill,
    ...(outcome.paid ? { amount: outcome.paid.amount, currency: outcome.paid.currency } : {}),
    outcome: outcome.status === "paid" ? "paid" : "submitted",
    message: paidMessage(outcome.status, outcome.paid, outcome.txRef),
    txRef: outcome.txRef,
  };
}

/** "4 bills: 2 paid, 1 approved, 1 not paid." Each line says the rest. */
function selectionSummary(lines: SelectionLine[]): string {
  const count = (...outcomes: Array<SelectionLine["outcome"]>) => lines.filter((line) => outcomes.includes(line.outcome)).length;
  const parts: Array<[number, string]> = [
    [count("paid"), "paid"],
    [count("submitted"), "submitted"],
    [count("approved"), "approved"],
    [count("held", "refused"), "not paid"],
  ];
  return `${lines.length} bills: ${parts
    .filter(([n]) => n > 0)
    .map(([n, words]) => `${n} ${words}`)
    .join(", ")}.`;
}

/**
 * The transaction bills shared, when their transfers went out together (AM11): "Paid N bills in one Arc transaction"
 * once Circle confirmed it, submitted until then; never called sent or paid while Circle has not answered (I17). Null
 * when none shared one, or the one they shared failed, which each bill's line says.
 */
function sharedTransaction(decisions: SelectionDecision[]): SharedTransaction | null {
  const members = decisions.filter((decision) => decision.outcome?.batch && (decision.outcome.status === "paid" || decision.outcome.status === "matched"));
  if (members.length === 0) return null;
  const first = members[0].outcome as NonNullable<SelectionDecision["outcome"]>;
  const size = (first.batch as { size: number }).size;
  const txRef = first.txRef;
  const simulated = first.paid?.simulated === true;
  const network = workspaceNetwork();
  const message = members.every((member) => member.outcome?.status === "paid")
    ? simulated
      ? `Paid ${size} bills in one transaction in the sandbox (simulated).`
      : `Paid ${size} bills in one Arc transaction.`
    : txRef
      ? `Submitted ${size} bills in one Arc transaction; waiting for Circle to confirm it.`
      : `Submitted ${size} bills in one Arc transaction; Circle has not answered yet, so the outcome is unknown and nothing goes out again until it does.`;
  return { txRef, size, txUrl: !simulated && txRef && TX_HASH.test(txRef) ? txUrl(network.id, txRef) : null, message };
}

export async function rejectPayable(actor: Actor, input: { invoiceId: string; reason: string; card?: ShownCard; forVerdict?: boolean }): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.reject");
  if (refusal) return refusal;
  try {
    const chat = await chatRules(actor, "reject", input.invoiceId, input.card);
    if (!chat.ok) return chat.refusal;
    await rejectInvoice({ actorId: actor.userId, invoiceId: input.invoiceId, reason: input.reason, ...provenanceOf(actor), ...verdictSettles(input) });
  } catch (error) {
    return approvalRefusal(error);
  }
  await keepReason(actor, "approvals.reject", input);
  return done("Rejected.");
}

export async function returnPayable(actor: Actor, input: { invoiceId: string; card?: ShownCard; forVerdict?: boolean; reason?: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.return");
  if (refusal) return refusal;
  try {
    const chat = await chatRules(actor, "return", input.invoiceId, input.card);
    if (!chat.ok) return chat.refusal;
    await returnInvoice({ actorId: actor.userId, invoiceId: input.invoiceId, ...(input.reason ? { reason: input.reason } : {}), ...provenanceOf(actor), ...verdictSettles(input) });
  } catch (error) {
    return approvalRefusal(error);
  }
  await keepReason(actor, "approvals.return", input);
  runCycleSoon(cycleEventOf(actor, "payable_returned"));
  return done("Returned to the agent. It usually decides it again within a minute.");
}

/**
 * Adds the purchase order or goods receipt a held payable was missing (complete held invoice). Entering facts is a
 * records write, for owners and admins: an approver decides payments, and does not enter them (R1). The cycle the
 * event starts reopens the payable on the changed facts and decides it again (R4).
 */
export async function addPayableDetails(
  actor: Actor,
  input: { invoiceId: string; poReference: string | null; goodsReceived: boolean }
): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.add_details");
  if (refusal) return refusal;
  try {
    await addInvoiceDetails({
      actorId: actor.userId,
      invoiceId: input.invoiceId,
      poReference: input.poReference,
      goodsReceived: input.goodsReceived,
      ...provenanceOf(actor),
    });
  } catch (error) {
    return approvalRefusal(error);
  }
  runCycleSoon(cycleEventOf(actor, "details_added"));
  return done("Details added. The agent usually decides it again within a minute.");
}
