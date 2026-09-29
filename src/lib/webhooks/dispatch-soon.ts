import { after } from "next/server";

/** How long a dispatch scheduled after a request may run: a short burst, not a full run. */
export const DISPATCH_SOON_MS = 20_000;

/**
 * True while a dispatch is scheduled but has not started. Appends made in the
 * meantime — several in one request, or in concurrent requests on the same
 * instance — ride on that one dispatch: it claims whatever is due when it
 * starts, which includes their deliveries.
 */
let scheduled = false;

/**
 * Sends the webhooks a ledger append just queued, right after the response
 * (webhooks design W3, as amended): a person's request never waits on a
 * receiver, and a delivery no longer waits for the next scheduled run.
 *
 * Outside a request — a script, a test, a cycle run from the command line —
 * `after` has nowhere to run and this does nothing; the scheduled dispatcher
 * still sends those deliveries. Never throws: an append must not fail because
 * a delivery could not be scheduled.
 */
export function dispatchWebhooksSoon(): void {
  if (scheduled) return;
  try {
    after(async () => {
      scheduled = false;
      try {
        // Loaded here, not at the top: the ledger imports this module, and the
        // dispatcher has no business in every module that appends.
        const { deliverPendingWebhooks } = await import("./deliver");
        await deliverPendingWebhooks({ deadlineMs: DISPATCH_SOON_MS });
      } catch {
        console.error("webhook dispatch after the request failed");
      }
    });
    scheduled = true;
  } catch {
    // No request scope: leave it to the scheduled dispatcher.
  }
}

/** Test seam: forget a scheduled dispatch that will never run under test. */
export function resetDispatchSoonForTests(): void {
  scheduled = false;
}
