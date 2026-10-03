import crypto from "node:crypto";
import type { ChainProvider } from "../circle";
import type { UsycExecution } from "../circle/types";
import { db as tenantDb, unwrap, type OrgDb } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { currentOrgId } from "../context";
import { heldBecausePausedDetail } from "./pause";
import { moveTreasuryIfNotPaused, type TreasuryMoveOutcome } from "./treasury-moves";

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
  const due = await payablesDueToday(input.db, input.today);
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
