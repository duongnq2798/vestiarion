/**
 * When the Go live panel reads the operating wallet's balance again on its own
 * (first-payment design R1). Funding means leaving for Circle's faucet and
 * coming back, so while the wallet is unfunded the panel reads the balance
 * when the tab becomes visible again, and every 30 s while it is visible, for
 * 15 minutes after it opened: the person does not have to press Refresh.
 *
 * Only Settings does this; the console still makes no Circle call (G2).
 */

export const FUNDING_WATCH_INTERVAL_MS = 30_000;
export const FUNDING_WATCH_LIMIT_MS = 15 * 60_000;

export function shouldReadBalanceAgain(input: {
  /** The balance last read, or null when none has been. */
  balance: number | null;
  openedAt: number;
  now: number;
  visible: boolean;
  /** A read is already running. */
  pending: boolean;
  /** The docs screenshots' fixed balance, never read from Circle. */
  sample: boolean;
}): boolean {
  if (input.sample || input.pending || !input.visible) return false;
  if (input.balance !== null && input.balance > 0) return false;
  return input.now - input.openedAt < FUNDING_WATCH_LIMIT_MS;
}
