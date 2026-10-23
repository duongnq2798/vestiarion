import type { ActivityItem } from "../agent-activity";
import { usdcValueOfLatestDecision } from "../agent/second-approval";
import { readAccountantCosign, readTwoApprovalsAbove } from "../approval-policy";
import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { NOTICE_MAX_BILLS, type NoticePolicy, type WaitingBill } from "./waiting-notice";

/**
 * What a chat's notice of the bills waiting for approval is built from
 * (docs/superpowers/specs/2026-10-23-telegram-review-links-design.md TG1): the payables the agent stopped among the
 * activity a stage read, re-read in one query and kept while they still wait, the workspace's rules for what each needs,
 * and a EURC bill's USDC value where a figure makes it matter. Discord and Telegram read them here, the same bills the
 * same way, and each says them in its own markup from `buildWaitingNotice`. Runs inside the workspace's scope.
 */

/** As Slack's notifier posts them: held or flagged, or asked for details (a purchase order, a receipt) a person adds. */
const WAITING = ["held", "flagged", "awaiting_info"];

interface BillRow {
  id: string;
  amount: string | number;
  currency: string | null;
  status: string;
  direction: string;
  agent_reasoning: string | null;
  counterparties: { name: string } | null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

/**
 * The payables the agent stopped for a person among what was read, still held or flagged now, in the order it stopped
 * them: a bill a person decided since is left out, and so is a payment held for a verdict in shadow mode, which the
 * activity gives no `invoiceId`.
 */
export async function waitingBills(items: readonly ActivityItem[]): Promise<WaitingBill[]> {
  const ids = [
    ...new Set(items.filter((item) => item.tone === "stopped" && item.invoiceId).map((item) => item.invoiceId as string)),
  ];
  if (ids.length === 0) return [];
  const rows = unwrap(
    await db().from("invoices").select("id, amount, currency, status, direction, agent_reasoning, counterparties(name)").in("id", ids)
  ) as unknown as BillRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id): WaitingBill[] => {
    const row = byId.get(id);
    if (!row || row.direction !== "payable" || !WAITING.includes(row.status)) return [];
    return [
      {
        id,
        payee: row.counterparties?.name ?? "a payee",
        amount: Number(row.amount),
        currency: row.currency === "EURC" ? "EURC" : "USDC",
        status: row.status as WaitingBill["status"],
        reasoning: row.agent_reasoning,
      },
    ];
  });
}

/**
 * The figure for two approvals and whether accountants co-sign, for what the notice says each bill needs. A rule that
 * cannot be read leaves that out of the notice rather than stop it: the bills still wait, and Approvals says the rest.
 * `label` starts each log line with the chat that read it ("discord", "telegram").
 */
export async function noticePolicy(label: string): Promise<NoticePolicy> {
  let twoApprovalsAbove: number | null = null;
  try {
    twoApprovalsAbove = await readTwoApprovalsAbove(db());
  } catch (error) {
    console.error(`${label}: the figure for two approvals was not read`, currentOrgId(), messageOf(error));
  }
  let accountantCosigns = false;
  if (twoApprovalsAbove !== null) {
    try {
      accountantCosigns = (await readAccountantCosign(db())).on;
    } catch (error) {
      console.error(`${label}: accountant co-sign was not read`, currentOrgId(), messageOf(error));
    }
  }
  return { twoApprovalsAbove, accountantCosigns };
}

/** Each listed EURC bill's USDC value as the agent last weighed it, where a figure makes it matter (two approvals T2). */
export async function withUsdcValues(bills: WaitingBill[], policy: NoticePolicy): Promise<WaitingBill[]> {
  if (policy.twoApprovalsAbove === null) return bills;
  return Promise.all(
    bills.map(async (bill, index) => {
      if (bill.currency !== "EURC" || index >= NOTICE_MAX_BILLS) return bill;
      try {
        return { ...bill, usdcValue: await usdcValueOfLatestDecision(bill.id) };
      } catch {
        return bill;
      }
    })
  );
}
