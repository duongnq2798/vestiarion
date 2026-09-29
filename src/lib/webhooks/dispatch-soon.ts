import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";

/** How long a dispatch scheduled after a request may run: a short burst, not a full run. */
export const DISPATCH_SOON_MS = 20_000;

/**
 * Appends within this long of a scheduled dispatch that has not started ride
 * on it instead of scheduling their own: it claims whatever is due when it
 * starts, their deliveries included. A window, not a flag held until the
 * dispatch runs, because a dispatch runs only when its request's response
 * closes — a long request (a manual cycle) would otherwise hold back every
 * other request's deliveries on this instance for minutes, and one whose
 * callback never ran would hold them back for good. Sharing only saves claim
 * calls; correctness never depends on it.
 */
export const DISPATCH_SHARE_WINDOW_MS = 10_000;

let scheduledAt: number | null = null;

/** Set by `withoutDispatchSoon`: the caller dispatches itself, within its own budget. */
const suppressed = new AsyncLocalStorage<true>();

/**
 * Sends the webhooks a ledger append just queued, right after the response
 * (webhooks design W3, as amended): a person's request never waits on a
 * receiver, and a delivery no longer waits for the next scheduled run.
 *
 * Outside a request — a script, a test, a cycle run from the command line —
 * `after` throws, and this does nothing; the scheduled dispatcher still sends
 * those deliveries. Never throws: an append must not fail because a delivery
 * could not be scheduled.
 */
export function dispatchWebhooksSoon(): void {
  if (suppressed.getStore()) return;
  const now = Date.now();
  if (scheduledAt !== null && now - scheduledAt < DISPATCH_SHARE_WINDOW_MS) return;
  try {
    after(async () => {
      scheduledAt = null;
      try {
        const { deliverPendingWebhooks } = await import("./deliver");
        await deliverPendingWebhooks({ deadlineMs: DISPATCH_SOON_MS });
      } catch {
        console.error("webhook dispatch after the request failed");
      }
    });
    scheduledAt = now;
  } catch {
    // No request scope: leave it to the scheduled dispatcher.
  }
}

/**
 * Runs `fn` with dispatch-soon off, for a caller that dispatches the
 * deliveries it queued itself, inside its own time budget: the tick, whose
 * route skips the dispatch deliberately when too little of `maxDuration` is
 * left — a dispatch after its response would run into that limit instead.
 */
export function withoutDispatchSoon<T>(fn: () => Promise<T>): Promise<T> {
  return suppressed.run(true, fn);
}

/** Test seam: forget a scheduled dispatch that will never run under test. */
export function resetDispatchSoonForTests(): void {
  scheduledAt = null;
}
