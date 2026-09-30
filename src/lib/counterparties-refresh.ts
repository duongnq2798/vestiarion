/**
 * How often the Counterparties page re-reads its data. A payee answers a link from
 * another browser, so while a link is out or an address waits for confirmation the
 * page checks every 15 s, and "not yet confirmed" appears without a reload; the
 * rest of the time, every minute (the Members page's rhythm for its invitations).
 *
 * A plain module, not a client component's: the server page calls it
 * (tests/client-boundary.test.ts).
 */
export function counterpartiesRefreshMs(state: { linksOut: number; unconfirmed: number }): number {
  return state.linksOut > 0 || state.unconfirmed > 0 ? 15_000 : 60_000;
}
