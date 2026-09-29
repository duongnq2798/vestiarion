import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { TransferResult } from "./types";

export type SettlementClient = Pick<CircleDeveloperControlledWalletsClient, "getTransaction">;

type Transaction = NonNullable<
  NonNullable<Awaited<ReturnType<SettlementClient["getTransaction"]>>["data"]>["transaction"]
>;

/** Circle states that end a transfer without moving money. */
export const FAILED_STATES = ["CANCELLED", "DENIED", "FAILED", "STUCK"];

export interface Settlement {
  status: TransferResult["status"];
  /** The transaction as Circle last reported it, when it could be read. */
  transaction?: Transaction;
}

function statusOf(transaction: Transaction): TransferResult["status"] {
  if (transaction.state === "CONFIRMED" || transaction.state === "COMPLETE") return "confirmed";
  if (FAILED_STATES.includes(transaction.state)) return "failed";
  return "pending";
}

/**
 * What became of a transfer Circle has accepted — it holds a transaction id.
 *
 * Waiting for confirmation can end in three ways that must not be confused.
 * Circle confirms it, or reports a terminal state; a timeout leaves it in
 * flight. Any other error from the wait — a dropped connection, a 5xx, the
 * SDK's own rejection — says nothing about the transfer itself, so the state
 * is read once more and Circle's answer is taken. Only when Circle says so is
 * the transfer failed: recording an unreadable transfer as failed would let a
 * person reject, or pay again, an invoice whose money already moved. When the
 * state cannot be read at all, the transfer stays pending and the next cycle
 * reconciles it by id.
 */
export async function awaitSettlement(
  client: SettlementClient,
  txId: string,
  options: { timeoutMs?: number } = {}
): Promise<Settlement> {
  try {
    const settled = await client.getTransaction({
      id: txId,
      waitForState: "CONFIRMED",
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
    const transaction = settled.data?.transaction;
    return transaction ? { status: statusOf(transaction), transaction } : { status: "pending" };
  } catch (error) {
    if ((error as Error).name === "TimeoutError") return { status: "pending" };
  }

  try {
    const reread = await client.getTransaction({ id: txId });
    const transaction = reread.data?.transaction;
    return transaction ? { status: statusOf(transaction), transaction } : { status: "pending" };
  } catch {
    return { status: "pending" };
  }
}
