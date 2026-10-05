/**
 * What a payable waiting for a person lacks for the agent's three-way match — a purchase order on file, the goods or
 * services received — and what a person added since the agent's decision (complete held invoice, spec
 * 2026-10-03-complete-held-invoice-design R2, R6). Pure, so Approvals, Invoices and the client components that offer
 * Add details all read it the same way.
 */

/** What a person added to a payable the agent stopped on: only facts it lacked (R2). */
export interface AddedDetails {
  poReference?: string;
  goodsReceived?: true;
}

/** The two facts as they are on the invoice now. */
export interface OnFile {
  poReference: string | null;
  goodsReceived: boolean;
  /** Whether its counterparty needs a purchase order (three-way match design M2); needed when absent, as by default. */
  purchaseOrderRequired?: boolean;
}

/** The purchase order and goods receipt a decision's entry recorded in `observed`, each only when it recorded one. */
export function recordedFacts(entry: { detail: Record<string, unknown> } | null): { poReference?: string | null; goodsReceived?: boolean } {
  const observed = entry?.detail.observed;
  if (!observed || typeof observed !== "object") return {};
  const facts = observed as Record<string, unknown>;
  return {
    ...("poReference" in facts ? { poReference: typeof facts.poReference === "string" ? facts.poReference : null } : {}),
    ...("goodsReceived" in facts ? { goodsReceived: facts.goodsReceived === true } : {}),
  };
}

/** What is on the invoice now that its decision recorded as missing: the changes the follow-up reopens it on (R4). */
export function addedSince(recorded: { poReference?: string | null; goodsReceived?: boolean }, onFile: OnFile): AddedDetails | null {
  const added: AddedDetails = {};
  if (recorded.poReference === null && onFile.poReference !== null) added.poReference = onFile.poReference;
  if (recorded.goodsReceived === false && onFile.goodsReceived) added.goodsReceived = true;
  return Object.keys(added).length > 0 ? added : null;
}

/**
 * The latest decision on an invoice that recorded its facts, from its ledger entries newest first (as
 * `ledger_entries_for_targets` returns them), or null.
 */
export function latestDecision<Entry extends { detail: Record<string, unknown> }>(entries: readonly Entry[], invoiceId: string): Entry | null {
  return entries.find((entry) => entry.detail.invoiceId === invoiceId && entry.detail.observed !== undefined) ?? null;
}

/** What is missing for the three-way match, or null when nothing is: a purchase order only from a counterparty that needs one. */
export function missingDetails(onFile: OnFile): { poReference: boolean; goodsReceived: boolean } | null {
  const missing = { poReference: onFile.poReference === null && onFile.purchaseOrderRequired !== false, goodsReceived: !onFile.goodsReceived };
  return missing.poReference || missing.goodsReceived ? missing : null;
}

/** What the agent does next, once details were added. */
const DECIDES_AGAIN = "The agent decides it again at its next cycle, usually within a minute.";

/** What a card says once a person added what the agent was missing, until the agent decides the payable again (R6). */
export function addedDetailsSentence(added: AddedDetails): string {
  const what = [
    added.poReference !== undefined ? `the purchase order ${added.poReference} was added` : null,
    added.goodsReceived ? "the goods were marked received" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" and ");
  return `Since the agent stopped it, ${what}. ${DECIDES_AGAIN}`;
}

/** A waiting payable's row on Invoices, in a few words under its name: what it needs, or that it was given it. */
export function waitingHint(onFile: OnFile, added: AddedDetails | null): string | undefined {
  if (added) return "Details added · the agent decides it again";
  const missing = missingDetails(onFile);
  if (!missing) return undefined;
  if (missing.poReference && missing.goodsReceived) return "Needs a purchase order and goods received";
  return missing.poReference ? "Needs a purchase order" : "Needs goods received";
}

/** What a waiting payable's card on Invoices asks of an owner or admin, who can add what is missing. */
export function addDetailsPrompt(missing: { poReference: boolean; goodsReceived: boolean }): string {
  if (missing.poReference && missing.goodsReceived) {
    return "Add the purchase order and confirm the goods or services were received, and the agent decides it again.";
  }
  return missing.poReference
    ? "Add the purchase order, and the agent decides it again."
    : "Confirm the goods or services were received, and the agent decides it again.";
}
