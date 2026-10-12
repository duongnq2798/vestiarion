import { accountingProvider } from "../accounting-providers";
import { approvePosting, type BookingDeps, type LineResult } from "../connectors/booking-run";
import { billsByExternalId, bookingStore, postingById } from "../connectors/booking-store";
import { connectionById, NotSetUpError, type Connection } from "../connectors/connections";
import { hasScopes } from "../connectors/posting";
import { PROVIDER_LABELS, type AccountingProvider, type OrganisationFacts } from "../connectors/provider";
import { connectionTokenStore } from "../connectors/token-store";
import { freshAccessToken } from "../connectors/tokens";
import { assertLedgerCanSign } from "../ledger";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Booking payments made on Arc in the accounting tool, after a person reviewed each one
 * (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W6, W7, W8): `accounting.book` (owner, admin),
 * from the console only. Each ticked booking comes with the fingerprint of what the page showed; the server works it
 * out again from the rows, and a different one is stale. The connection must hold the write scope, an account must be
 * chosen, and the ledger must be able to sign before anything is sent. The organisation is read once for the whole
 * approval, for the reality rule; then each line is sent with its own checks and its own outcome.
 */

/** Each line takes four calls to the provider, which allows 60 a minute (Xero): at most this many at once. */
export const MAX_BOOKINGS = 10;

export interface BookingCounts {
  booked: number;
  refused: number;
  stale: number;
  failed: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the person reads back: how many were booked (read back from the tool), how many the tool took and has not been
 * read back yet, and what stopped the rest. Booked is said only of what the tool answered the read-back for (W10).
 */
export function bookingMessage(label: string, results: readonly LineResult[]): string {
  const booked = results.filter((result) => result.outcome === "booked").length;
  const sent = results.filter((result) => result.outcome === "sent").length;
  const others = results.filter((result) => result.outcome !== "booked" && result.outcome !== "sent");
  const parts = [
    ...(booked > 0 ? [`Booked ${plural(booked, "payment", "payments")} in ${label}.`] : []),
    ...(sent > 0 ? [`Sent ${plural(sent, "payment", "payments")} to ${label}, not read back yet: Vestiarion confirms ${sent === 1 ? "it" : "them"} at the next sync.`] : []),
  ];
  const head = parts.length > 0 ? parts.join(" ") : `Booked nothing in ${label}.`;
  if (others.length === 0) return head;
  const reasons = [...new Set(others.map((result) => result.message))];
  return `${head} ${reasons.join(" ")}`;
}

export async function bookAccountingPayments(
  actor: Actor,
  input: { connectionId: string; lines: ReadonlyArray<{ postingId: string; fingerprint: string }> },
  deps: { provider?: AccountingProvider | null; now?: () => number } = {}
): Promise<CommandOutcome<{ results: LineResult[]; counts: BookingCounts }>> {
  const refusal = gate(actor, "accounting.book_payments");
  if (refusal) return refusal;
  const lines = [...new Map(input.lines.filter((line) => UUID.test(line.postingId) && FINGERPRINT.test(line.fingerprint)).map((line) => [line.postingId, line])).values()];
  if (lines.length === 0) return refused("invalid", "Choose the payments to book.");
  if (lines.length > MAX_BOOKINGS) return refused("invalid", `Book at most ${MAX_BOOKINGS} payments at a time.`);
  if (!UUID.test(input.connectionId)) return refused("not_connected", "That connection is not this workspace's.");

  let connection: Connection | null;
  try {
    connection = await connectionById(input.connectionId);
  } catch (error) {
    if (error instanceof NotSetUpError) return refused("not_set_up", "Booking payments is not set up on this deployment yet.");
    throw error;
  }
  if (!connection || connection.status === "revoked") return refused("not_connected", "That accounting tool is not connected to this workspace.");
  const label = PROVIDER_LABELS[connection.provider];
  if (connection.status !== "connected") return refused("reconnect", `${label} needs you to reconnect. Reconnect ${label} from Settings, then try again.`);
  const provider = deps.provider === undefined ? accountingProvider(connection.provider) : deps.provider;
  const booking = provider?.booking;
  if (!provider || !booking) return refused("not_set_up", `Booking payments in ${label} is not set up on this deployment yet.`);
  if (!hasScopes(connection.scopes, booking.writeScopes)) {
    return refused("scope", `Allow Vestiarion to book payments first: choose Allow Vestiarion to book payments on the ${label} card in Settings, which reconnects ${label}.`);
  }
  const account = connection.paymentAccount;
  if (!account) return refused("no_account", `Choose where payments are booked first, on the ${label} card in Settings.`);
  try {
    assertLedgerCanSign();
  } catch {
    return refused("ledger", "The ledger cannot sign right now, so nothing is booked. Try again in a moment.");
  }

  const token = await freshAccessToken({ store: connectionTokenStore(connection.orgId, connection.id), refresh: provider.refresh });
  if (!token.ok) {
    return token.reason === "reconnect" || token.reason === "missing"
      ? refused("reconnect", `${label} needs you to reconnect. Reconnect ${label} from Settings, then try again.`)
      : refused("unavailable", `${label} did not answer. Nothing was booked. Try again in a moment.`);
  }
  let organisation: OrganisationFacts | null = null;
  try {
    organisation = await booking.organisation({ accessToken: token.accessToken, externalOrgId: connection.externalOrgId });
  } catch (error) {
    console.error("booking: the organisation was not read", connection.id, error instanceof Error ? error.message : "unknown error");
  }

  const bookingDeps: BookingDeps = { connection, booking, label, store: bookingStore, now: deps.now };
  const results: LineResult[] = [];
  try {
    const postings = await Promise.all(lines.map((line) => postingById(line.postingId)));
    const bills = await billsByExternalId(
      connection.id,
      postings.flatMap((posting) => (posting ? [posting.billExternalId] : []))
    );
    for (const [index, line] of lines.entries()) {
      const posting = postings[index];
      if (!posting || posting.connectionId !== connection.id) {
        results.push({ postingId: line.postingId, outcome: "stale", message: "That booking is not this connection's." });
        continue;
      }
      const bill = bills.get(posting.billExternalId);
      results.push(
        await approvePosting({
          deps: bookingDeps,
          accessToken: token.accessToken,
          organisation,
          posting,
          shownBill: bill ? { amountDue: bill.amountDue, status: bill.status } : null,
          account,
          shownFingerprint: line.fingerprint,
          by: actor.userId,
        })
      );
    }
  } catch (error) {
    console.error("booking payments failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    if (results.length === 0) return refused("failed", TRY_AGAIN);
  }
  const counts: BookingCounts = {
    booked: results.filter((result) => result.outcome === "booked" || result.outcome === "sent").length,
    refused: results.filter((result) => result.outcome === "refused").length,
    stale: results.filter((result) => result.outcome === "stale" || result.outcome === "busy").length,
    failed: results.filter((result) => result.outcome === "failed" || result.outcome === "unavailable").length,
  };
  const message = bookingMessage(label, results);
  if (counts.booked === 0) {
    // Nothing booked: said as a refusal, and the page shows what is there now.
    return refused(counts.stale === results.length ? "stale" : "not_booked", message, { changed: true });
  }
  return done(message, { results, counts });
}
