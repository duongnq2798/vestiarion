import { utcDay } from "./copy";
import type { MilestoneRow } from "./queries";

/**
 * The date a milestone's row leads with, on Contractors and on a counterparty's page, where Payments are ordered by it
 * (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL9): when it was paid, closed or held, when it was
 * verified, or that it waits for verification. Pure. `decidedAt` is when the agent last decided it, the row's own time.
 */
export function milestoneDate(
  milestone: Pick<MilestoneRow, "status" | "closed_at" | "verified_at"> | undefined,
  decidedAt: string
): { label: string; tone?: "held" } | null {
  if (!milestone) return null;
  const day = (at: string) => utcDay(at);
  if (milestone.status === "paid") return { label: `Paid ${day(decidedAt)}` };
  if (milestone.status === "closed") return { label: `Closed ${day(milestone.closed_at ?? decidedAt)}` };
  if (milestone.status === "held") return { label: `Held ${day(decidedAt)}`, tone: "held" };
  if (milestone.status === "verified") return { label: milestone.verified_at ? `Verified ${day(milestone.verified_at)}` : "Verified" };
  return { label: "Awaiting verification" };
}
