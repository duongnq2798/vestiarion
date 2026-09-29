import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { TransferResult } from "./types";

export type SettlementClient = Pick<CircleDeveloperControlledWalletsClient, "getTransaction">;

type Transaction = NonNullable<
  NonNullable<Awaited<ReturnType<SettlementClient["getTransaction"]>>["data"]>["transaction"]
>;

/** Circle states that end a transfer without moving money. */
export const FAILED_STATES: readonly string[] = ["CANCELLED", "DENIED", "FAILED", "STUCK"] as const;

const WAIT_MS = 45_000;
const REREAD_MS = 15_000;

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
 * Settles `work`, or rejects once `ms` have passed. The SDK has no HTTP
 * timeout of its own — its abort signal only cuts the pause between polls —
 * so a hung request would otherwise hold the cycle indefinitely.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from Circle within ${ms} ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * What became of a transfer Circle has accepted — it holds a transaction id.
 *
 * The SDK's wait rejects for three different reasons, and none of them is
 * proof that the transfer failed: a terminal state (a plain Error naming it),
 * the wait running out (an AbortError), or the request itself failing. So on
 * any rejection the state is read once more and Circle's answer is taken:
 * confirmed, failed, or still in flight. Only Circle's own terminal state
 * makes a transfer failed — recording an unreadable one as failed would let a
 * person reject, or pay again, an invoice whose money already moved. When the
 * state cannot be read at all, the transfer stays pending and the next cycle
 * reconciles it by id.
 */
export async function awaitSettlement(
  client: SettlementClient,
  txId: string,
  options: { waitMs?: number; rereadMs?: number } = {}
): Promise<Settlement> {
  const waitMs = options.waitMs ?? WAIT_MS;
  try {
    const settled = await withDeadline(
      client.getTransaction({ id: txId, waitForState: "CONFIRMED", signal: AbortSignal.timeout(waitMs) }),
      waitMs + 5_000
    );
    const transaction = settled.data?.transaction;
    return transaction ? { status: statusOf(transaction), transaction } : { status: "pending" };
  } catch {
    // Fall through: the rejection says nothing reliable about the transfer.
  }

  try {
    const reread = await withDeadline(client.getTransaction({ id: txId }), options.rereadMs ?? REREAD_MS);
    const transaction = reread.data?.transaction;
    return transaction ? { status: statusOf(transaction), transaction } : { status: "pending" };
  } catch {
    return { status: "pending" };
  }
}
