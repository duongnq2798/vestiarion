/**
 * The record that a cycle *started*, kept independently of whether it finished
 * — and the rule for which stages may still run once one of them has failed.
 *
 * `cycle_runs` used to be written once, at the very end. Everything before that
 * point — screening verdicts, reopened invoices, executed payments, ledger
 * entries — was already committed. A transient failure therefore left the book
 * moved and the telemetry insisting nothing had happened. That is not
 * hypothetical; it happened during development, when a network blip wrote four
 * escalations and then killed the run.
 *
 * Recording a failure was the first half. Surviving one is this half: a
 * screening blip used to take the treasury, the forecast and everything else
 * down with it, even though none of them depend on screening being fresh.
 *
 * The dependency rule is a safety rule, not a convenience one. A treasury agent
 * must **fail closed on anything that authorises money leaving the business,
 * and stay open on anything that only observes or records.** So a stale risk
 * verdict stops payments and releases — that is the whole point of screening —
 * while a sweep between the business's own accounts, and a read-only forecast,
 * are unaffected and still run.
 */

export const CYCLE_STAGES = [
  "reconcile",
  "receipts",
  "compliance",
  "document_checks",
  "follow_up",
  "recurring",
  "services",
  "liquidity",
  "ap",
  "contractors",
  "treasury",
  "forecast",
  "proposals",
  "collections",
  "early_offers",
  "customer_offers",
  "term_requests",
  "document_requests",
  "cash_alert",
  "notices",
  "telegram",
  "slack",
  "discord",
] as const;

export type CycleStage = (typeof CYCLE_STAGES)[number];

/**
 * Which stages must have *succeeded* for a stage to be allowed to run.
 *
 *   reconcile   Nothing. In live mode it is what makes stored balances match
 *               the chain; if it failed, the agent does not know what it holds.
 *   receipts    Nothing. It records money that arrived and settles the
 *               receivables it pays; it authorises nothing leaving, so it
 *               stays open, and nothing waits on it (receivables on Arc).
 *   compliance  Nothing. It is the source of risk truth, not a consumer of it.
 *   document_checks Nothing. It reads the documents vendors sent for bills waiting for a purchase order or
 *               goods receipt and compares them with the bill in code; a match may add the bill's purchase
 *               order, which the follow-up and AP stages after it decide again in this cycle, where a person
 *               approves it. It pays nothing, and its hold is read from the database, not from this stage,
 *               so a failed check stops nothing else (document checks DK2, DK8).
 *   follow_up   compliance — it reopens invoices by comparing today's risk tier
 *               and limit against the ones a past decision rested on.
 *   recurring   Nothing. It creates the invoice of each recurring payment's period as it comes
 *               near; it authorises nothing leaving, and the AP stage decides those invoices
 *               with every check. If it fails, the AP stage still decides everything else.
 *   ap          reconcile + compliance. Paying a counterparty needs both a
 *               current balance and a current risk verdict. Neither is
 *               negotiable; this is the fail-closed boundary.
 *   contractors reconcile + compliance, for the same reason.
 *   treasury    reconcile. Sweeping moves the business's own money between its
 *               own accounts, so it needs accurate balances but no counterparty
 *               screening at all.
 *   services    Nothing. It buys facts the decisions after it read (a payee's history over x402);
 *               a failure leaves them without those facts, never without a decision.
 *   proposals   Nothing. It proposes raising a counterparty's limit when people keep approving
 *               payments above it; a person accepts or dismisses the proposal, and nothing
 *               changes until then. Last, so it never delays a payment.
 *   collections receipts. It emails clients the reminders a person turned on; if the cycle
 *               could not read what arrived, it reminds no one who may just have paid.
 *   early_offers reconcile + ap. It offers suppliers payment today for a discount on bills the
 *               agent scheduled for later, only from cash a current balance shows after this
 *               cycle's payments; an offer moves nothing until the supplier accepts it, and the
 *               payment then passes every check (agent early-payment offers AO2, AO6).
 *   customer_offers reconcile + receipts + ap. While bills are held for want of cash, it offers
 *               customers a discount to pay open receivables early; it reads which bills AP held
 *               and what arrived, and an offer only ever lowers what a customer owes until a set
 *               day (customer discounts C2, C8).
 *   term_requests reconcile + ap. It asks suppliers for more time on bills the AP stage held for
 *               want of cash; a request only moves a due date later, and moves no money.
 *   document_requests ap. It asks vendors for the purchase order or goods receipt of bills the AP
 *               stage left waiting for information; a request changes no bill and moves no money,
 *               so it needs no balance (document requests ER2, ER7).
 *   cash_alert  reconcile. It tells the owner when the wallet will run short, from the balances
 *               reconcile read; it authorises nothing (cash short alert S1).
 *   forecast    Nothing. It reads and records; it authorises nothing. It is the
 *               stage most worth keeping alive after a failure, because it is
 *               what tells a human where the cycle left the book.
 *   telegram    Nothing. It tells each member's connected Telegram chat what the agent decided;
 *               it authorises nothing, and a chat not told now is told by the next cycle. Near
 *               the end, so it never delays a payment (Telegram bot design R8).
 *   slack       Nothing. It tells the workspace's Slack channel what the agent decided, with a
 *               stopped payable's card when deciding from Slack is on; the card itself moves
 *               nothing, and a channel not told now is told by the next cycle. Near the end, so it
 *               never delays a payment (Slack design S7).
 *   discord     Nothing. It tells the workspace's Discord channel which bills the agent stopped for
 *               a person, each with a link to review it; the link approves nothing, and a channel
 *               not told now is told by the next cycle. Last, so it never delays a payment
 *               (Discord design DC3).
 */
export const STAGE_REQUIRES: Record<CycleStage, readonly CycleStage[]> = {
  reconcile: [],
  receipts: [],
  compliance: [],
  // Compares vendors' documents with their bills; it pays nothing, and the AP stage reads its hold from the database (document checks DK2).
  document_checks: [],
  follow_up: ["compliance"],
  recurring: [],
  services: [],
  // Brings cash back from the reserve for today's payments: it needs the balances reconcile read (reserve cash back R3).
  liquidity: ["reconcile"],
  ap: ["reconcile", "compliance"],
  contractors: ["reconcile", "compliance"],
  treasury: ["reconcile"],
  forecast: [],
  proposals: [],
  // Reminds clients of open receivables: never before reading what they may just have paid (collections R9).
  collections: ["receipts"],
  // Offers suppliers early payment from the cash left after the payments AP decided (agent early-payment offers AO2).
  early_offers: ["reconcile", "ap"],
  // Offers customers a discount while bills are held for cash: never before knowing what AP held and what arrived (customer discounts C2).
  customer_offers: ["reconcile", "receipts", "ap"],
  // Asks suppliers for more time on bills AP held for want of cash, from the balance reconcile read (term requests X2).
  term_requests: ["reconcile", "ap"],
  // Asks vendors for the documents of the bills AP left waiting for information (document requests ER2).
  document_requests: ["ap"],
  // Tells the owner when the wallet will run short: never from balances reconcile did not read (cash short alert S1).
  cash_alert: ["reconcile"],
  notices: [],
  telegram: [],
  slack: [],
  discord: [],
};

export interface StageRecord {
  stage: CycleStage;
  status: "completed" | "failed" | "skipped";
  ms: number;
  error?: string;
  /** Why a stage never ran. Always the stage that actually failed. */
  skippedBecause?: string;
}

/** How the cycle as a whole ended. */
export type CycleOutcome = "completed" | "partial" | "failed";

/**
 * Tracks stage outcomes and answers whether the next stage may run.
 *
 * Pure and in-memory: the caller decides when to persist, because a journal
 * that needed the database in order to record a database failure would be
 * useless at exactly the moment it mattered.
 */
export class CycleJournal {
  private records = new Map<CycleStage, StageRecord>();

  /**
   * Whether a stage may run, and if not, which failure is responsible. The
   * reason names the stage that actually broke rather than the nearest
   * dependency, so a skipped forecast does not send an operator hunting
   * through a chain of consequences to find the cause.
   */
  gate(stage: CycleStage): { run: true } | { run: false; because: string } {
    for (const required of STAGE_REQUIRES[stage]) {
      const record = this.records.get(required);
      if (record?.status === "completed") continue;
      const cause =
        record?.status === "skipped" && record.skippedBecause
          ? record.skippedBecause
          : `${required} ${record?.status ?? "did not run"}`;
      return { run: false, because: cause };
    }
    return { run: true };
  }

  completed(stage: CycleStage, ms: number): void {
    this.records.set(stage, { stage, status: "completed", ms: Math.max(0, ms) });
  }

  failed(stage: CycleStage, error: unknown, ms: number): void {
    this.records.set(stage, {
      stage,
      status: "failed",
      ms: Math.max(0, ms),
      error: messageOf(error),
    });
  }

  skipped(stage: CycleStage, because: string): void {
    this.records.set(stage, { stage, status: "skipped", ms: 0, skippedBecause: because });
  }

  /** Every stage that threw, in cycle order. */
  failures(): StageRecord[] {
    return this.stages().filter((record) => record.status === "failed");
  }

  /** The first stage to fail — the cause, as opposed to its consequences. */
  failedStage(): CycleStage | null {
    return this.failures()[0]?.stage ?? null;
  }

  /**
   * `completed` only when every stage ran and succeeded. A cycle that skipped
   * work is `partial`, never `completed`: its counts are real but they stop
   * where the failure stopped them, and reading it as a clean run would
   * understate the book and hide the fault in the same glance.
   */
  outcome(): CycleOutcome {
    const records = this.stages();
    if (records.length === 0) return "failed";
    if (records.every((record) => record.status === "completed")) return "completed";
    return "partial";
  }

  /** One line an operator can act on, or null when nothing went wrong. */
  summary(): string | null {
    const failed = this.failures();
    if (failed.length === 0) return null;
    const skipped = this.stages().filter((record) => record.status === "skipped");
    const head = failed.map((record) => `${record.stage}: ${record.error}`).join("; ");
    return skipped.length === 0
      ? head
      : `${head} (skipped ${skipped.map((record) => record.stage).join(", ")})`;
  }

  stages(): StageRecord[] {
    return CYCLE_STAGES.flatMap((stage) => {
      const record = this.records.get(stage);
      return record ? [{ ...record }] : [];
    });
  }
}

/**
 * Error text fit for an operator and for a database column: never an empty
 * string, never a stack trace, never unbounded. "TypeError: fetch failed"
 * carries no cause, so the stage name beside it is doing most of the work.
 */
export function messageOf(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message || error.name
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const text = (raw ?? "").trim();
  if (text.length === 0) return "unknown error";
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
