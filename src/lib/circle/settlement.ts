import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { TransferResult } from "./types";

export type SettlementClient = Pick<CircleDeveloperControlledWalletsClient, "getTransaction">;

type Transaction = NonNullable<
  NonNullable<Awaited<ReturnType<SettlementClient["getTransaction"]>>["data"]>["transaction"]
>;

/**
 * Circle's terminal failure states: the transfer ended without moving money
 * and, per Circle's docs, "must be re-initiated". `STUCK` is deliberately not
 * here — Circle's docs say it "is not a terminal failure": the transaction
 * was sent and can still be mined (or accelerated), so it stays `pending`.
 */
export const FAILED_STATES: readonly string[] = ["CANCELLED", "DENIED", "FAILED"] as const;

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
 * The words a payment's error carries when Circle never said what became of the request that sends it (payment
 * safety R1, docs/superpowers/specs/2026-10-05-payment-safety-design.md): the deadline ran out, the connection dropped
 * after the request left, Circle answered 5xx, or it answered with no id. Circle may hold the transfer under the
 * request's idempotency key, so nothing closes over it, and the same request sent again under that key returns it
 * rather than repeats it.
 */
export const MAY_HAVE_BEEN_ACCEPTED = "may or may not have been accepted";

/**
 * Settles `work`, or rejects once `ms` have passed. The SDK has no HTTP
 * timeout of its own — its abort signal only cuts the pause between polls —
 * so a hung request would otherwise hold the cycle indefinitely.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Logs only the transaction id and the error's message — never the request or the SDK's error object. */
function warnReadFailed(txId: string, error: unknown): void {
  console.warn("circle: settlement read failed", txId, error instanceof Error ? error.message : String(error));
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
  const waitDeadlineMs = waitMs + 5_000;
  try {
    const settled = await withDeadline(
      client.getTransaction({ id: txId, waitForState: "CONFIRMED", signal: AbortSignal.timeout(waitMs) }),
      waitDeadlineMs,
      `no answer from Circle getTransaction while waiting for confirmation within ${waitDeadlineMs} ms`
    );
    const transaction = settled.data?.transaction;
    return transaction ? { status: statusOf(transaction), transaction } : { status: "pending" };
  } catch (error) {
    // Fall through: the rejection says nothing reliable about the transfer.
    warnReadFailed(txId, error);
  }

  try {
    const rereadMs = options.rereadMs ?? REREAD_MS;
    const reread = await withDeadline(
      client.getTransaction({ id: txId }),
      rereadMs,
      `no answer from Circle getTransaction reread within ${rereadMs} ms`
    );
    const transaction = reread.data?.transaction;
    return transaction ? { status: statusOf(transaction), transaction } : { status: "pending" };
  } catch (error) {
    warnReadFailed(txId, error);
    return { status: "pending" };
  }
}
