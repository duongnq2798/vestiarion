import { utcDay } from "./copy";
import type { MilestoneRow } from "./queries";

/**
 * The date a milestone's row leads with, on Contractors and on a counterparty's page, where Payments are ordered by it
 * (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL9): when it was paid, closed or held, when it was
 * verified, or that it waits for verification. Pure. `decidedAt` is the row's own time: when it was paid, or when the
 * agent last decided it. Null when that was not read: the row then names its state without a day, never a guessed one.
 */
export function milestoneDate(
  milestone: Pick<MilestoneRow, "status" | "closed_at" | "verified_at"> | undefined,
  decidedAt: string | null
): { label: string; tone?: "held" } | null {
  if (!milestone) return null;
  const on = (word: string, at: string | null | undefined) => (at ? `${word} ${utcDay(at)}` : word);
  if (milestone.status === "paid") return { label: on("Paid", decidedAt) };
  if (milestone.status === "closed") return { label: on("Closed", milestone.closed_at ?? decidedAt) };
  if (milestone.status === "held") return { label: on("Held", decidedAt), tone: "held" };
  if (milestone.status === "verified") return { label: on("Verified", milestone.verified_at) };
  return { label: "Awaiting verification" };
}
