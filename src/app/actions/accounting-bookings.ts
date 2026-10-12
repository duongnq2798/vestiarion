"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { bookAccountingPayments, consoleActor, MAX_BOOKINGS } from "@/lib/commands";
import type { LineResult } from "@/lib/connectors/booking-run";
import { inOrg } from "@/lib/dal/scope";

/**
 * Approving bookings of payments made on Arc in the accounting tool, from Bills & receivables
 * (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W6): `accounting.book` (owner, admin). Each ticked
 * booking comes as `<booking id>:<fingerprint of what the page showed>`; the command works both out again on the server.
 */

export interface BookingActionResult {
  ok: boolean;
  message: string;
  /** Each line's own outcome, by booking id. */
  results?: LineResult[];
}

/** The ticked bookings, from the form: never more than a booking approval takes. */
function lines(formData: FormData): Array<{ postingId: string; fingerprint: string }> {
  return formData
    .getAll("booking")
    .filter((value): value is string => typeof value === "string")
    .slice(0, MAX_BOOKINGS + 1)
    .flatMap((value) => {
      const [postingId, fingerprint] = value.split(":");
      return postingId && fingerprint ? [{ postingId, fingerprint }] : [];
    });
}

export async function approveBookingsAction(_previous: BookingActionResult, formData: FormData): Promise<BookingActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "accounting.book");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const connectionId = formData.get("connectionId");
    const outcome = await bookAccountingPayments(consoleActor(auth), { connectionId: typeof connectionId === "string" ? connectionId : "", lines: lines(formData) });
    if (outcome.ok || outcome.changed) revalidateOrgPages();
    return outcome.ok ? { ok: true, message: outcome.message, results: outcome.results } : { ok: false, message: outcome.message };
  });
}
