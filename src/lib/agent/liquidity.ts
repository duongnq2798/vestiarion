import crypto from "node:crypto";
import type { ChainProvider } from "../circle";
import type { UsycExecution } from "../circle/types";
import { db as tenantDb, unwrap, type OrgDb } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { currentOrgId } from "../context";
import { heldBecausePausedDetail } from "./pause";
import { moveTreasuryIfNotPaused, type TreasuryMoveOutcome } from "./treasury-moves";
import { assertPaymentsEnabled } from "../payments-switch";

/**
 * Cash back from the reserve (docs/superpowers/specs/2026-10-03-reserve-cash-back-design.md): the agent brings back
 * what today's payments need before it decides them (R3), a person brings back what they choose (R2), and a payable
 * held for want of cash is decided again once the cash is there (R4).
 */

/** `execution.heldBecause` on an AP decision held because the cash it needs is not in the operating wallet (R4). */
export const HELD_FOR_CASH = "cash_shortfall";

const UNITS = 1_000_000;
/** Up to the next micro-USDC: what is brought back always covers what is needed. */
const upToUnits = (value: number) => Math.ceil(value * UNITS - 1e-6) / UNITS;
const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0));

/**
 * What the AP stage may pay today, in USDC: payables due today or overdue and not yet decided, and those scheduled for
 * today. EURC is paid from EURC and is not counted. A payable the AP stage then holds for another reason is cash
 * brought back early, which the treasury stage counts against its buffer rather than sweeping it back.
 */
export async function payablesDueToday(orgDb: OrgDb, today: string): Promise<{ total: number; count: number }> {
  const rows = unwrap(
    await orgDb
      .from("invoices")
      .select("amount, currency, status, due_date, scheduled_for")
      .eq("direction", "payable")
      .in("status", ["pending", "scheduled"])
  ) as Array<{ amount: string | number; currency: string | null; status: string; due_date: string; scheduled_for: string | null }>;
  const due = rows.filter((row) => {
    if ((row.currency ?? "USDC") !== "USDC") return false;
    const day = (row.status === "scheduled" ? row.scheduled_for : row.due_date)?.slice(0, 10);
    return day !== undefined && day <= today;
  });
  return { total: due.reduce((sum, row) => sum + num(row.amount), 0), count: due.length };
}

/**
 * The verified milestones waiting for the agent to release them, which it pays from the operating wallet too. Not one
 * whose USDC is locked in escrow, or being locked there: its release comes from the escrow, not from the wallet.
 */
export async function milestonesToRelease(orgDb: OrgDb): Promise<{ total: number; count: number }> {
  const rows = unwrap(
    await orgDb.from("milestones").select("amount, escrow_state").eq("status", "verified").eq("verified", true)
  ) as Array<{ amount: string | number; escrow_state: string | null }>;
  const due = rows.filter((row) => row.escrow_state !== "funded" && row.escrow_state !== "funding");
  return { total: due.reduce((sum, row) => sum + num(row.amount), 0), count: due.length };
}

interface CashBackMove {
  db: OrgDb;
  provider: ChainProvider;
  operatingAccountId: string;
  reserveAccountId: string;
  operatingBalance: number;
  reserveBalance: number;
  amount: number;
  reasoning: string;
  moveKey: string;
  byPerson?: boolean;
}

/** The redemption itself, and its treasury action row when it moved. */
async function redeem(move: CashBackMove): Promise<TreasuryMoveOutcome> {
  const outcome = await moveTreasuryIfNotPaused(
    { action: "redeem_from_usyc", amount: move.amount, reasoning: move.reasoning },
    {
      db: move.db,
      provider: move.provider,
      operatingAccountId: move.operatingAccountId,
      reserveAccountId: move.reserveAccountId,
      operatingBalance: move.operatingBalance,
      reserveBalance: move.reserveBalance,
      moveKey: move.moveKey,
      byPerson: move.byPerson,
    }
  );
  if (outcome.executed) {
    const res = await move.db.from("treasury_actions").insert({
      action: "redeem_from_usyc",
      amount: move.amount,
      from_account: move.reserveAccountId,
      to_account: move.operatingAccountId,
      reasoning: move.reasoning,
    });
    if (res.error) throw new Error(res.error.message);
  }
  return outcome;
}

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * The cycle's liquidity step, before the AP stage (R3): when today's payments need more than the operating wallet
 * holds and the reserve holds cash, the difference is brought back first, so the payments are decided with the cash
 * in hand rather than held for want of it. A rule, not a model's call: it moves only what today's payments need. The
 * new operating balance when it moved; null when nothing was needed, or nothing could come back.
 */
export async function bringCashForTodaysPayments(input: {
  db: OrgDb;
  provider: ChainProvider;
  operatingAccountId: string;
  reserveAccountId: string;
  operatingBalance: number;
  reserveBalance: number;
  moveKey: string;
  today: string;
}): Promise<{ operatingBalance: number; line: { domain: string; message: string } } | null> {
  // Today's payables, and the verified milestones the contractor stage releases in the same cycle.
  const [payables, milestones] = await Promise.all([payablesDueToday(input.db, input.today), milestonesToRelease(input.db)]);
  const due = { total: payables.total + milestones.total, count: payables.count + milestones.count };
  const short = upToUnits(due.total - input.operatingBalance);
  if (due.count === 0 || short <= 0 || input.reserveBalance <= 0) return null;
  const amount = Math.min(short, input.reserveBalance);
  const reasoning = `${due.count} ${due.count === 1 ? "payment" : "payments"} due today need ${AMOUNT.format(due.total)} USDC and the operating wallet holds ${AMOUNT.format(input.operatingBalance)} USDC; bringing ${AMOUNT.format(amount)} USDC back from the reserve before deciding them.`;
  const outcome = await redeem({ ...input, amount, reasoning });
  await appendLedgerEntry({
    actor: "agent",
    domain: "treasury",
    action: "cash_brought_back",
    summary: outcome.executed
      ? `Brought ${AMOUNT.format(amount)} USDC back from the reserve for payments due today`
      : `Could not bring ${AMOUNT.format(amount)} USDC back from the reserve for payments due today`,
    detail: {
      reason: "payments_due_today",
      amount,
      reasoning,
      neededUsdc: Number(due.total.toFixed(6)),
      payments: due.count,
      operatingBalance: input.operatingBalance,
      reserveBalance: input.reserveBalance,
      executed: outcome.executed,
      executionNote: outcome.executionNote,
      earnMode: input.provider.earnMode,
      ...(outcome.execution ? { execution: outcome.execution } : {}),
      ...heldBecausePausedDetail(outcome.heldBecausePaused),
    },
  });
  if (!outcome.executed) return { operatingBalance: input.operatingBalance, line: { domain: "treasury", message: `cash back for today's payments not moved (${outcome.executionNote ?? "not executed"})` } };
  return {
    operatingBalance: Number((input.operatingBalance + amount).toFixed(6)),
    line: { domain: "treasury", message: `brought ${AMOUNT.format(amount)} USDC back from the reserve for ${due.count} ${due.count === 1 ? "payment" : "payments"} due today` },
  };
}

/**
 * What a person's payment lacks in the operating wallet, when the reserve holds it (approval cash R1): the amount that
 * comes back, and the figures it was worked out from.
 */
export interface ReserveCover {
  reserveAccountId: string;
  reserveBalance: number;
  /** What the payment needs beyond the operating wallet, up to the next micro-USDC. */
  amount: number;
  neededUsdc: number;
  operatingBalance: number;
}

/**
 * Whether the reserve covers what a person's payment needs beyond the operating wallet (approval cash R1, R2): `cover`
 * when it does, and what the reserve holds either way, null when the workspace has none. A payment the wallet covers on
 * its own needs no cover.
 */
export async function reserveCover(
  orgDb: OrgDb,
  input: { neededUsdc: number; operatingBalance: number }
): Promise<{ cover: ReserveCover | null; reserveBalance: number | null }> {
  const read = await orgDb.from("accounts").select("id, balance").eq("kind", "reserve").maybeSingle();
  if (read.error) throw new Error(read.error.message);
  const reserve = read.data as { id: string; balance: string | number } | null;
  if (!reserve) return { cover: null, reserveBalance: null };
  const reserveBalance = num(reserve.balance);
  const amount = amountFromReserve(input.neededUsdc, input.operatingBalance, reserveBalance);
  if (amount === null) return { cover: null, reserveBalance };
  return {
    cover: { reserveAccountId: reserve.id, reserveBalance, amount, neededUsdc: input.neededUsdc, operatingBalance: input.operatingBalance },
    reserveBalance,
  };
}

/**
 * Whether the reserve can stand behind a person's payment (approval cash R1): a real USYC reserve where payments are
 * real, and any reserve in a sandbox, whose payments are simulated too. A simulated reserve in a workspace that pays for
 * real holds a figure only: redeeming it moves nothing on chain, so the payment would fail at Circle.
 */
export function reserveFundsPayments(provider: Pick<ChainProvider, "mode" | "earnMode">): boolean {
  return provider.mode !== "live" || provider.earnMode === "live";
}

/**
 * What a payment needing `neededUsdc` lacks beyond what the operating wallet holds, up to the next micro-USDC, when the
 * reserve holds that much (approval cash R1); null when nothing is lacking, or the reserve cannot cover it.
 */
export function amountFromReserve(neededUsdc: number, operatingBalance: number, reserveBalance: number): number | null {
  const amount = upToUnits(neededUsdc - operatingBalance);
  return amount > 0 && amount <= reserveBalance + 0.0000005 ? amount : null;
}

/**
 * Why a person's payment from the operating wallet is refused (approval cash R2): what the wallet holds, and what the
 * reserve holds when it holds anything, against the payment and, for a CCTP payout, its fee.
 */
export function cashShortMessage(input: { operatingUsdc: number; reserveUsdc: number | null; feeUsdc: number | null; what: "invoice" | "milestone" }): string {
  const reserve = input.reserveUsdc !== null && input.reserveUsdc > 0 ? ` and the USYC reserve ${input.reserveUsdc} USDC` : "";
  const fee = input.feeUsdc !== null ? ` and its ${input.feeUsdc} USDC CCTP fee` : "";
  return `The operating account holds ${input.operatingUsdc} USDC${reserve}, less than this ${input.what}${fee}.`;
}

/**
 * The redemption a person's payment needs (approval cash R1, R3, R4): what `cover` says, from the reserve to the
 * operating wallet, now, while the agent is paused too, since the pause holds the agent and not a person. Recorded as
 * `cash_brought_back` by them, with reason `approval` and what it pays. Nothing came back: a `CashBackError`, and nothing
 * recorded.
 */
export async function bringCashForApproval(input: {
  actorId: string;
  cover: ReserveCover;
  operatingAccountId: string;
  provider: ChainProvider;
  source: { type: "invoice" | "milestone"; id: string };
  /** Who the payment goes to, for the entry's summary. */
  payee: string;
}): Promise<{ amount: number; execution: UsycExecution | null }> {
  // Nothing moves while the platform has payments switched off (payment safety S4).
  await assertPaymentsEnabled();
  const orgId = currentOrgId();
  const { cover, source } = input;
  const outcome = await redeem({
    db: tenantDb(),
    provider: input.provider,
    operatingAccountId: input.operatingAccountId,
    reserveAccountId: cover.reserveAccountId,
    operatingBalance: cover.operatingBalance,
    reserveBalance: cover.reserveBalance,
    amount: cover.amount,
    reasoning: `A person's approval brought ${AMOUNT.format(cover.amount)} USDC back from the reserve to pay ${input.payee}.`,
    moveKey: `approval/${source.type}/${source.id}/${crypto.randomUUID()}`,
    byPerson: true,
  });
  if (!outcome.executed) throw new CashBackError("not_moved", `Nothing came back from the reserve: ${outcome.executionNote ?? "the redemption did not go through"}.`);
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "treasury",
    action: "cash_brought_back",
    summary: `Brought ${AMOUNT.format(cover.amount)} USDC back from the reserve to pay ${input.payee}`,
    detail: {
      by: input.actorId,
      reason: "approval",
      ...(source.type === "invoice" ? { invoiceId: source.id } : { milestoneId: source.id }),
      amount: cover.amount,
      neededUsdc: cover.neededUsdc,
      operatingBalance: cover.operatingBalance,
      reserveBalance: cover.reserveBalance,
      earnMode: input.provider.earnMode,
      ...(outcome.execution ? { execution: outcome.execution } : {}),
    },
  });
  return { amount: cover.amount, execution: outcome.execution ?? null };
}

/** What a person is told after paying, when cash came back from the reserve first (approval cash R4); empty otherwise. */
export function fromReserveNote(amount: number | undefined): string {
  return amount === undefined ? "" : ` ${amount} USDC came back from the USYC reserve first.`;
}

/** How long the treasury stage sweeps nothing after a person brings cash back (approval cash R6). */
const PERSON_CASH_BACK_STAYS_MS = 24 * 60 * 60 * 1000;

/**
 * A person's latest Bring cash back within the last 24 hours (approval cash R6): what came back, when, and until when
 * the treasury stage sweeps nothing. Null when there is none. Cash brought back for an approval does not count: it left
 * with the payment.
 */
export async function recentPersonCashBack(orgDb: OrgDb, now: number): Promise<{ amount: number; at: string; until: string } | null> {
  const rows = unwrap(
    await orgDb
      .from("ledger_entries")
      .select("ts, detail")
      .eq("action", "cash_brought_back")
      .eq("actor", "human")
      .eq("detail->>reason", "person")
      .gte("ts", new Date(now - PERSON_CASH_BACK_STAYS_MS).toISOString())
      .order("seq", { ascending: false })
      .limit(1)
  ) as Array<{ ts: string; detail: { amount?: unknown } | null }>;
  const latest = rows[0];
  if (!latest) return null;
  const at = Date.parse(latest.ts);
  return { amount: num(latest.detail?.amount), at: new Date(at).toISOString(), until: new Date(at + PERSON_CASH_BACK_STAYS_MS).toISOString() };
}

export class CashBackError extends Error {
  constructor(
    readonly code: "no_reserve" | "empty" | "too_much" | "not_moved",
    message: string
  ) {
    super(message);
    this.name = "CashBackError";
  }
}

/**
 * A person's Bring cash back (R2): the amount they ask, or all of it, from the reserve to the operating wallet now.
 * Redemptions are open at any hour. Recorded as `cash_brought_back` by them; their payment holds for want of cash are
 * decided again at the cycle that follows (R4).
 */
export async function bringCashBackByPerson(input: {
  actorId: string;
  /** USDC; null for everything the reserve holds. */
  amount: number | null;
  provider: ChainProvider;
}): Promise<{ amount: number; execution: UsycExecution | null }> {
  // Nothing moves while the platform has payments switched off (payment safety S4).
  await assertPaymentsEnabled();
  const orgId = currentOrgId();
  const orgDb = tenantDb();
  const accounts = unwrap(await orgDb.from("accounts").select("id, kind, balance")) as Array<{ id: string; kind: string; balance: string | number }>;
  const operating = accounts.find((row) => row.kind === "operating");
  const reserve = accounts.find((row) => row.kind === "reserve");
  if (!operating || !reserve) throw new CashBackError("no_reserve", "This workspace has no reserve to bring cash back from.");
  const reserveBalance = num(reserve.balance);
  if (reserveBalance <= 0) throw new CashBackError("empty", "The reserve holds nothing to bring back.");
  const amount = input.amount === null ? reserveBalance : input.amount;
  if (amount > reserveBalance + 0.0000005) {
    throw new CashBackError("too_much", `The reserve holds ${AMOUNT.format(reserveBalance)} USDC; bring back that much or less.`);
  }
  const reasoning = input.amount === null ? "A person brought everything in the reserve back to the operating wallet." : `A person brought ${AMOUNT.format(amount)} USDC back to the operating wallet.`;
  const outcome = await redeem({
    db: orgDb,
    provider: input.provider,
    operatingAccountId: operating.id,
    reserveAccountId: reserve.id,
    operatingBalance: num(operating.balance),
    reserveBalance,
    amount,
    reasoning,
    moveKey: `cash-back/${crypto.randomUUID()}`,
    byPerson: true,
  });
  if (!outcome.executed) throw new CashBackError("not_moved", `Nothing came back: ${outcome.executionNote ?? "the redemption did not go through"}.`);
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "treasury",
    action: "cash_brought_back",
    summary: `Brought ${AMOUNT.format(amount)} USDC back from the reserve`,
    detail: {
      by: input.actorId,
      reason: "person",
      amount,
      all: input.amount === null,
      reserveBalance,
      earnMode: input.provider.earnMode,
      ...(outcome.execution ? { execution: outcome.execution } : {}),
    },
  });
  return { amount, execution: outcome.execution ?? null };
}
