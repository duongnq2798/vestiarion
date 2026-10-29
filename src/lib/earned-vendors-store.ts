import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { readOutflowBudget } from "./agent/outflow-budget";
import { AGENT_DECISION_ACTIONS } from "./agent/shadow-hold";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import {
  earnedChanges,
  earnedLostEntry,
  earnedPaymentsSummary,
  earnedRuleFromRow,
  earnedRuleSummary,
  earnedVendorEntry,
  earnedVendors,
  validStreak,
  type EarnedChange,
  type EarnedFacts,
  type EarnedStatus,
  type EarnedTrigger,
  type EarnedVendorRule,
  type EarnedVendorsView,
  type RecordedStatus,
} from "./earned-vendors";
import { appendLedgerEntry, assertLedgerCanSign, type LedgerEntryInput } from "./ledger";
import { workspaceNetwork } from "./workspace-network";
import { allRows } from "./workspace-report-read";

export * from "./earned-vendors";

/**
 * Earned vendors, read, changed and signed (docs/superpowers/specs/2026-10-28-earned-vendors-design.md): the owner's
 * rule on the workspace's `approval_policies` row (AL11, migration 0146), changed with its signed entry or not at all
 * (AL17), and the sync that signs each change of a vendor's status (AL15, AL16). Step 3's switch beside the rule, changed
 * the same way (AL21). Every export runs inside an organization scope; who may change either (`approval.policy`, owners)
 * is the caller's check.
 *
 * The AP stage's gate (./agent/earned-gate) is what reads a status, and the switch, to decide a payment (AL22).
 */

/** The ledger's per-vendor entries, newest first per vendor: the record (AL15). */
const RECORD_ACTIONS = ["vendor_earned", "vendor_earned_lost"] as const;

/**
 * The columns are 0146's: before it runs, a select names a column the table does not have (42703, Postgres's own), and
 * an upsert one PostgREST's schema cache does not know (PGRST204). Only those codes: any other failure throws.
 */
function earnedColumnsMissing(error: { code?: string }): boolean {
  return error.code === "42703" || error.code === "PGRST204";
}

/**
 * The workspace's rule, and whether its database has it at all (`ready`, migration 0146). No row, or a database before
 * 0146, is no rule. Any other failure throws.
 */
export async function readEarnedVendorRule(orgDb: OrgDb): Promise<EarnedVendorRule & { ready: boolean }> {
  const result = await orgDb.from("approval_policies").select("earned_vendor_streak, earned_vendor_payments").limit(1);
  if (result.error) {
    if (earnedColumnsMissing(result.error)) return { streak: null, payments: false, ready: false };
    throw new Error(`approval_policies not read: ${result.error.message}`);
  }
  const row = ((result.data ?? []) as Array<{ earned_vendor_streak?: number | string | null; earned_vendor_payments?: boolean | null }>)[0];
  return { ...earnedRuleFromRow(row), ready: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Changing the rule (AL11, AL17)

export type EarnedVendorsErrorCode = "invalid" | "unchanged" | "cycle_running" | "not_ready" | "mainnet" | "not_signed" | "no_rule" | "no_spending_limit";

const MESSAGES: Record<EarnedVendorsErrorCode, string> = {
  invalid: "Choose a number from 5 to 50.",
  unchanged: "It is set to that already.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  not_ready: "Not available in this workspace yet.",
  mainnet: "Earned vendors are counted from your verdicts in shadow mode, which runs on Arc testnet.",
  not_signed: "The change could not be signed in the ledger, so nothing changed. Try again in a moment.",
  no_rule: "Set a rule first: how many agreed verdicts in a row a vendor needs.",
  no_spending_limit: "Set the agent's spending limit first, in Settings: the agent's own payments always count against it.",
};

export class EarnedVendorsError extends Error {
  constructor(readonly code: EarnedVendorsErrorCode) {
    super(MESSAGES[code]);
    this.name = "EarnedVendorsError";
  }
}

/** Writes the rule to the workspace's row; turning it off turns the step 3 switch off too, as 0146's check needs. */
async function writeRule(streak: number | null, actorId: string): Promise<void> {
  const write = await db()
    .from("approval_policies")
    .upsert(
      {
        earned_vendor_streak: streak,
        ...(streak === null ? { earned_vendor_payments: false } : {}),
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id" }
    );
  if (write.error) {
    if (earnedColumnsMissing(write.error)) throw new EarnedVendorsError("not_ready");
    throw new Error(write.error.message);
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

/** A sync that runs best effort (AL16) logs its failure and changes nothing else. */
const logSync = (error: unknown) => {
  console.error("earned vendors: statuses not signed", currentOrgId(), messageOf(error));
};

/** The rule the ledger names (AL17): the newest `earned_vendor_rule_changed` entry's `to`, or none before the first. */
async function signedRule(): Promise<number | null> {
  const rows = unwrap(
    await db().from("ledger_entries").select("detail").eq("action", "earned_vendor_rule_changed").order("seq", { ascending: false }).limit(1)
  ) as Array<{ detail: { to?: number | string | null } | null }>;
  return earnedRuleFromRow({ earned_vendor_streak: rows[0]?.detail?.to ?? null }).streak;
}

/** The switch the ledger names (AL21): the newest `earned_vendor_payments_changed` entry's `to`, or off before the first. */
async function signedPayments(): Promise<boolean> {
  const rows = unwrap(
    await db().from("ledger_entries").select("detail").eq("action", "earned_vendor_payments_changed").order("seq", { ascending: false }).limit(1)
  ) as Array<{ detail: { to?: boolean | null } | null }>;
  return rows[0]?.detail?.to === true;
}

const paymentsEntry = (by: string, from: boolean, to: boolean): LedgerEntryInput => ({
  actor: "human",
  domain: "system",
  action: "earned_vendor_payments_changed",
  summary: earnedPaymentsSummary(to),
  detail: { by, from, to },
});

const ruleEntry = (by: string, from: number | null, to: number | null): LedgerEntryInput => ({
  actor: "human",
  domain: "system",
  action: "earned_vendor_rule_changed",
  summary: earnedRuleSummary(to),
  detail: { by, from, to },
});

/**
 * An owner sets the rule, changes it, or turns it off (AL11), signed strictly as `earned_vendor_rule_changed` (AL17):
 * the key is checked before anything is written, and a change whose entry still cannot be signed is put back, only
 * from its own write, and refused, as the mirror address is undone when its entry fails. A put-back that fails too is
 * logged and refused as any failure is, never as one that changed nothing, and leaves that rule in force without its
 * entry: so every change first signs the rule in force where the ledger does not name it, and, as the mirror address
 * is recorded when asked again, asking for that rule again signs it rather than being refused as unchanged. Refused on
 * Arc mainnet, where there are no verdicts, and while a cycle runs, which signs statuses as it starts. Setting a rule
 * where there was none first signs any loss the rule's turning off could not sign, and is refused with nothing written
 * while one cannot be signed (AL16); then the statuses under the new rule are signed, best effort.
 */
export async function changeEarnedVendorRule(input: { actorId: string; streak: number | null }): Promise<{ from: number | null; to: number | null }> {
  const to = input.streak;
  if (to !== null && !validStreak(to)) throw new EarnedVendorsError("invalid");
  if (workspaceNetwork().id === "arc-mainnet") throw new EarnedVendorsError("mainnet");

  const current = await readEarnedVendorRule(db());
  if (!current.ready) throw new EarnedVendorsError("not_ready");
  const from = current.streak;
  // A rule in force that the ledger does not name is one whose entry failed and could not be put back.
  const signed = await signedRule();
  if (from === to && signed === from) throw new EarnedVendorsError("unchanged");

  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new EarnedVendorsError("cycle_running");

  try {
    assertLedgerCanSign();
  } catch {
    throw new EarnedVendorsError("not_signed");
  }

  // The rule in force is signed first, by the owner asking, so the ledger's rules follow one another. Nothing is
  // written before it, so a failure here changed nothing.
  if (signed !== from) {
    try {
      await appendLedgerEntry(ruleEntry(input.actorId, signed, from));
    } catch (error) {
      console.error("earned vendors: rule in force not signed", currentOrgId(), messageOf(error));
      throw new EarnedVendorsError("not_signed");
    }
    if (from === to) {
      await syncEarnedVendors(db(), { trigger: "rule" }).catch(logSync);
      return { from: signed, to };
    }
  }

  // While there is still no rule, a vendor left recorded earned from an earlier one is signed lost (`rule_off`), so no
  // earned status runs on across a time with no rule into the new one: until each is, the new rule is refused, with
  // nothing written.
  if (from === null) {
    const off = await syncEarnedVendors(db(), { trigger: "rule" }).catch((error: unknown) => {
      logSync(error);
      return null;
    });
    if (!off || [...off.recorded.values()].some((status) => status.state === "earned")) throw new EarnedVendorsError("not_signed");
  }

  await writeRule(to, input.actorId);
  try {
    await appendLedgerEntry(ruleEntry(input.actorId, from, to));
  } catch (error) {
    console.error("earned vendors: rule change not signed", currentOrgId(), messageOf(error));
    // Put back only from this change's own write, as the mirror address is: a change another owner made since stays. The
    // switch was part of that write only when the rule went off with it, and goes back on only while the ledger still
    // names it on (AL21, AL24): one another owner turned off since, or one never signed on, stays off.
    const switchBack = to === null && current.payments && (await signedPayments().catch(() => false));
    const written = db()
      .from("approval_policies")
      .update({ earned_vendor_streak: from, ...(switchBack ? { earned_vendor_payments: true } : {}), updated_by: input.actorId, updated_at: new Date().toISOString() });
    const back = await (to === null ? written.is("earned_vendor_streak", null) : written.eq("earned_vendor_streak", to)).then(
      (result) => result.error?.message ?? null,
      (failure: unknown) => messageOf(failure)
    );
    // A change that could not be put back is in force without its entry: it is not one that changed nothing.
    if (back) {
      console.error("earned vendors: rule not put back", currentOrgId(), back);
      throw new Error(`earned vendors: rule changed without its entry, and not put back: ${back}`);
    }
    throw new EarnedVendorsError("not_signed");
  }

  // The same write turned the switch off (0146's check): its own entry says so, after the rule's (AL21). The rule is off
  // either way, so an entry that cannot be signed is logged, and signed before the switch's next change.
  if (to === null && current.payments) {
    await appendLedgerEntry(paymentsEntry(input.actorId, true, false)).catch((error: unknown) => {
      console.error("earned vendors: switch turned off with the rule, not signed", currentOrgId(), messageOf(error));
    });
  }

  await syncEarnedVendors(db(), { trigger: "rule" }).catch(logSync);
  return { from, to };
}

/**
 * An owner lets the agent pay earned vendors on their own, in shadow mode, or makes their payments wait for a verdict
 * again (AL21), signed strictly as `earned_vendor_payments_changed`, as the rule is (AL17): the key is checked before
 * anything is written, a change whose entry cannot be signed is put back from its own write and refused, and one that
 * could not be put back either is in force without its entry, so every change first signs the switch in force where the
 * ledger does not name it. On needs a rule and an agent spending limit, which the agent's own payments always count
 * against; off needs neither. Refused on Arc mainnet, where there is no shadow mode, while a cycle runs, which reads the
 * switch as it starts, and before migration 0146.
 */
export async function changeEarnedVendorPayments(input: { actorId: string; on: boolean }): Promise<{ from: boolean; to: boolean }> {
  if (workspaceNetwork().id === "arc-mainnet") throw new EarnedVendorsError("mainnet");
  const current = await readEarnedVendorRule(db());
  if (!current.ready) throw new EarnedVendorsError("not_ready");
  const from = current.payments;
  // A switch in force that the ledger does not name is one whose entry failed and could not be put back, or one the
  // rule's turning off could not sign.
  const signed = await signedPayments();
  if (from === input.on && signed === from) throw new EarnedVendorsError("unchanged");
  if (input.on && !from) {
    if (current.streak === null) throw new EarnedVendorsError("no_rule");
    const budget = await readOutflowBudget(db());
    if (!budget || (budget.dailyUsdc === null && budget.weeklyUsdc === null)) throw new EarnedVendorsError("no_spending_limit");
  }

  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new EarnedVendorsError("cycle_running");

  try {
    assertLedgerCanSign();
  } catch {
    throw new EarnedVendorsError("not_signed");
  }

  // The switch in force is signed first, by the owner asking: nothing is written before it.
  if (signed !== from) {
    try {
      await appendLedgerEntry(paymentsEntry(input.actorId, signed, from));
    } catch (error) {
      console.error("earned vendors: switch in force not signed", currentOrgId(), messageOf(error));
      throw new EarnedVendorsError("not_signed");
    }
    if (from === input.on) return { from: signed, to: from };
  }

  const write = await db()
    .from("approval_policies")
    .upsert({ earned_vendor_payments: input.on, updated_by: input.actorId, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (write.error) {
    if (earnedColumnsMissing(write.error)) throw new EarnedVendorsError("not_ready");
    throw new Error(write.error.message);
  }
  try {
    await appendLedgerEntry(paymentsEntry(input.actorId, from, input.on));
  } catch (error) {
    console.error("earned vendors: switch change not signed", currentOrgId(), messageOf(error));
    // Put back only from this change's own write: a change another owner made since stays.
    const back = await db()
      .from("approval_policies")
      .update({ earned_vendor_payments: from, updated_by: input.actorId, updated_at: new Date().toISOString() })
      .eq("earned_vendor_payments", input.on)
      .then(
        (result) => result.error?.message ?? null,
        (failure: unknown) => messageOf(failure)
      );
    if (back) {
      console.error("earned vendors: switch not put back", currentOrgId(), back);
      throw new Error(`earned vendors: switch changed without its entry, and not put back: ${back}`);
    }
    throw new EarnedVendorsError("not_signed");
  }
  return { from, to: input.on };
}

// ---------------------------------------------------------------------------------------------------------------------
// The facts and the record (AL14, AL15)

type BillRow = {
  id: string;
  amount: number | string;
  currency: string | null;
  status?: string | null;
  counterparties: {
    id: string;
    name: string;
    sample: boolean | null;
    role: string | null;
    risk_level: string | null;
    payment_limit: number | string | null;
  } | null;
};
type DecisionRow = {
  seq: number | string;
  ts: string;
  action: string;
  invoice_id: string | null;
  guardrail_blocked: boolean | null;
  guardrail_rule: string | null;
  resulting_status: string | null;
  earned?: unknown;
};
type VerdictRow = { entry_seq: number | string; verdict: "agree" | "disagree"; decided_at: string | null };
type PaidRow = { seq: number | string; action: string; invoice_id: string | null; recorded?: unknown };

/**
 * What the sync works the statuses out from (AL14): the workspace's payables with their status and their payee's role,
 * screening and payment limit, the agent's decisions on them, whether each paid on its own (AL26, AL27), every verdict
 * with its time, and a person's payments of the bills, each with whether it only recorded the transfer sent before it
 * (AL26, AL28). The report reads the same fields with the rest of its facts (`readReportFacts`); this reads only these,
 * a page at a time.
 */
export async function readEarnedFacts(orgDb: OrgDb): Promise<EarnedFacts> {
  const [bills, decisions, verdicts, paid] = await Promise.all([
    allRows<BillRow>((from, to) =>
      orgDb
        .from("invoices")
        .select("id, amount, currency, status, counterparties(id, name, sample, role, risk_level, payment_limit)")
        .eq("direction", "payable")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    allRows<DecisionRow>((from, to) =>
      orgDb
        .from("ledger_entries")
        .select(
          "seq, ts, action, invoice_id:detail->>invoiceId, guardrail_blocked:detail->guardrailBlocked, guardrail_rule:detail->>guardrailRule, resulting_status:detail->execution->>resultingStatus, earned:detail->earned"
        )
        .eq("actor", "agent")
        .in("action", [...AGENT_DECISION_ACTIONS])
        .order("seq", { ascending: true })
        .range(from, to)
    ),
    allRows<VerdictRow>((from, to) => orgDb.from("decision_verdicts").select("entry_seq, verdict, decided_at").order("entry_seq", { ascending: true }).range(from, to)),
    allRows<PaidRow>((from, to) =>
      orgDb
        .from("ledger_entries")
        .select("seq, action, invoice_id:detail->>invoiceId, recorded:detail->recorded")
        .eq("actor", "human")
        .eq("action", "approval_paid")
        .order("seq", { ascending: true })
        .range(from, to)
    ),
  ]);
  return {
    bills: bills.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      currency: row.currency ?? "USDC",
      ...(row.status ? { status: row.status } : {}),
      payee: {
        id: row.counterparties?.id ?? "",
        name: row.counterparties?.name ?? "a supplier",
        sample: row.counterparties?.sample === true,
        role: row.counterparties?.role ?? undefined,
        riskLevel: row.counterparties?.risk_level ?? undefined,
        paymentLimit: row.counterparties?.payment_limit == null ? null : Number(row.counterparties.payment_limit),
      },
    })),
    decisions: decisions.flatMap((row) =>
      row.invoice_id
        ? [
            {
              seq: Number(row.seq),
              ts: row.ts,
              action: row.action,
              invoiceId: row.invoice_id,
              guardrailBlocked: row.guardrail_blocked === true,
              guardrailRule: row.guardrail_rule,
              resultingStatus: row.resulting_status,
              ...(row.earned != null ? { onItsOwn: true } : {}),
            },
          ]
        : []
    ),
    verdicts: verdicts.map((row) => ({ entrySeq: Number(row.entry_seq), verdict: row.verdict, ...(row.decided_at ? { decidedAt: row.decided_at } : {}) })),
    personActions: paid.flatMap((row) =>
      row.invoice_id ? [{ seq: Number(row.seq), action: row.action, invoiceId: row.invoice_id, ...(row.recorded === true ? { recorded: true } : {}) }] : []
    ),
  };
}

/** Each vendor's newest signed status (AL15): its newest `vendor_earned` or `vendor_earned_lost` entry. */
export async function readEarnedRecord(orgDb: OrgDb): Promise<Map<string, RecordedStatus>> {
  const rows = await allRows<{ seq: number | string; ts: string; action: string; counterparty_id: string | null }>((from, to) =>
    orgDb
      .from("ledger_entries")
      .select("seq, ts, action, counterparty_id:detail->>counterpartyId")
      .in("action", [...RECORD_ACTIONS])
      .order("seq", { ascending: false })
      .range(from, to)
  );
  const record = new Map<string, RecordedStatus>();
  for (const row of rows) {
    if (!row.counterparty_id || record.has(row.counterparty_id)) continue;
    record.set(row.counterparty_id, { state: row.action === "vendor_earned" ? "earned" : "lost", seq: Number(row.seq), at: row.ts });
  }
  return record;
}

/** The names of the vendors a loss names when there is no rule, so no facts were read. */
async function vendorNames(orgDb: OrgDb, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = unwrap(await orgDb.from("counterparties").select("id, name").in("id", ids)) as Array<{ id: string; name: string }>;
  return new Map(rows.map((row) => [row.id, row.name]));
}

// ---------------------------------------------------------------------------------------------------------------------
// The sync (AL16)

export interface EarnedSync {
  streak: number | null;
  /** The owner's switch (AL21): off with no rule, and before 0146. */
  payments: boolean;
  statuses: EarnedStatus[];
  /** Each vendor's newest signed status, the entries this sync signed included. */
  recorded: Map<string, RecordedStatus>;
  /** The changes this sync signed. */
  signed: EarnedChange[];
}

/**
 * Signs the difference between what the facts say now and each vendor's newest signed status (AL16), one strict entry
 * per vendor (AL15): a vendor whose entry could not be signed is left as it was recorded, and the next sync signs it.
 * A second run in a row signs nothing. With no rule it reads the rule and the record, never the facts, and signs each
 * vendor still recorded earned as lost (`rule_off`): the rule change that turned it off, or, where that could not sign
 * one, whichever sync runs next. Before migration 0146 it reads the rule and stops. Callers run it best effort: a
 * failure throws to them, and they log it. The AP stage hands in shadow mode, so an earned vendor's payments made on its
 * own count as waiting only while a verdict can still be given on them (AL26).
 */
export async function syncEarnedVendors(orgDb: OrgDb, input: { trigger: EarnedTrigger; shadow?: { startedAt: string } | null }): Promise<EarnedSync> {
  const { streak, payments, ready } = await readEarnedVendorRule(orgDb);
  if (!ready) return { streak, payments: false, statuses: [], recorded: new Map(), signed: [] };

  const [recorded, read] = await Promise.all([readEarnedRecord(orgDb), streak === null ? null : readEarnedFacts(orgDb)]);
  const facts = read && input.shadow !== undefined ? { ...read, shadow: input.shadow } : read;
  const statuses = facts && streak !== null ? earnedVendors(facts, streak) : [];
  const changes = earnedChanges(statuses, recorded, streak);
  const names =
    streak === null ? await vendorNames(orgDb, changes.map((change) => change.vendorId)) : new Map(statuses.map((status) => [status.vendorId, status.name]));

  const signed: EarnedChange[] = [];
  for (const change of changes) {
    const entry =
      change.to === "earned"
        ? earnedVendorEntry(change.status, streak as number, input.trigger)
        : earnedLostEntry({ vendorId: change.vendorId, name: names.get(change.vendorId) ?? "A vendor", streak, because: change.because, since: change.since, trigger: input.trigger });
    try {
      const appended = await appendLedgerEntry(entry);
      recorded.set(change.vendorId, { state: change.to, seq: appended.seq, at: appended.ts });
      signed.push(change);
    } catch (error) {
      console.error("earned vendors: status not signed", entry.action, currentOrgId(), error instanceof Error ? error.message : "unknown error");
    }
  }
  return { streak, payments, statuses, recorded, signed };
}

/**
 * The report's view (AL18): the rule, the switch (AL28), each vendor's status worked out from the report's own facts,
 * and the vendors recorded earned. Null before migration 0146, which leaves the block out. Reads only the rule and the
 * record.
 */
export async function readEarnedView(orgDb: OrgDb, facts: EarnedFacts): Promise<EarnedVendorsView | null> {
  const rule = await readEarnedVendorRule(orgDb);
  if (!rule.ready) return null;
  if (rule.streak === null) return { streak: null, statuses: [], recorded: new Set() };
  const record = await readEarnedRecord(orgDb);
  const recorded = new Set([...record].filter(([, status]) => status.state === "earned").map(([vendorId]) => vendorId));
  return { streak: rule.streak, payments: rule.payments, statuses: earnedVendors(facts, rule.streak), recorded };
}
