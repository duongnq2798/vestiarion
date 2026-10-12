import { closeDrafts, confirmInFlight, draftPostings, type BookingDeps } from "./booking-run";
import { bookingStore } from "./booking-store";
import { connectionById } from "./connections";
import { PROVIDER_LABELS, type AccountingProvider } from "./provider";
import { connectionTokenStore } from "./token-store";
import { freshAccessToken } from "./tokens";

/**
 * The bookings' part of each sync (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W3, W7), in the
 * workspace already in scope: draft the payments confirmed on Arc since the last run, refuse the drafts whose bill
 * closed in the tool, and read back what was sent. Never sends anything: only a person's approval does. The access
 * token is asked for only when a call to the provider is needed, once.
 */

export interface BookingRunSummary {
  drafted: number;
  refused: number;
  waiting: number;
  closed: number;
  confirmed: number;
}

export async function bookingInScope(connectionId: string, provider: AccountingProvider, now: () => number = Date.now): Promise<BookingRunSummary | null> {
  if (!provider.booking) return null;
  const connection = await connectionById(connectionId);
  if (!connection || connection.status !== "connected") return null;
  let token: Promise<string | null> | null = null;
  const accessToken = () => {
    token ??= freshAccessToken({ store: connectionTokenStore(connection.orgId, connection.id), refresh: provider.refresh, now }).then((outcome) => (outcome.ok ? outcome.accessToken : null));
    return token;
  };
  const deps: BookingDeps & { accessToken: () => Promise<string | null> } = {
    connection,
    booking: provider.booking,
    label: PROVIDER_LABELS[connection.provider],
    store: bookingStore,
    now,
    accessToken,
  };
  const drafted = await draftPostings(deps);
  const closed = await closeDrafts(deps);
  const { confirmed } = await confirmInFlight(deps);
  return { ...drafted, closed, confirmed };
}
