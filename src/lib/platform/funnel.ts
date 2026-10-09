import { z } from "zod";
import { platformDb, unwrap } from "../dal";
import type { Network } from "../network";
import type { SideKey } from "./open-numbers";

/**
 * The activation funnel (docs/superpowers/specs/2026-10-09-activation-funnel-design.md): how far the workspaces opened
 * since a day got, from `open_funnel(p_since, p_network)` (migration 0089), customers apart from ours. Counts of
 * workspaces only, read by `npm run numbers`; nothing shows it on /open yet.
 */

export const FUNNEL_STEPS = ["opened", "withRealBill", "withDecision", "withPayment", "paidOnTwoDays", "withVerdict", "withTwoPeople"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export type FunnelSide = Record<FunnelStep, number>;

/** Each step in words, for the table `npm run numbers` prints. */
export const FUNNEL_WORDS: Record<FunnelStep, string> = {
  opened: "Workspaces opened",
  withRealBill: "with a real bill (not sample data)",
  withDecision: "with the agent's decision on one",
  withPayment: "with a confirmed payment",
  paidOnTwoDays: "with payments on two days or more",
  withVerdict: "with a verdict in shadow mode",
  withTwoPeople: "with two people or more",
};

const sideSchema = z.object(Object.fromEntries(FUNNEL_STEPS.map((step) => [step, z.coerce.number()])) as Record<FunnelStep, z.ZodNumber>);
const funnelSchema = z.object({ sides: z.object({ customers: sideSchema, ours: sideSchema, total: sideSchema }) });

/** One network's funnel for the workspaces opened since `since` (all of them when null). */
export async function readFunnel(since: Date | null, network: Network): Promise<Record<SideKey, FunnelSide>> {
  const read = await platformDb().rpc("open_funnel", { p_since: since ? since.toISOString() : null, p_network: network });
  return funnelSchema.parse(unwrap(read)).sides;
}

const dropOrNull = (lost: number) => (lost >= 0 ? lost : null);

/** The funnel as rows for a table: each step with customers', ours and the total, and the customers' drop from the step before. */
export function funnelRows(sides: Record<SideKey, FunnelSide>): Array<{ step: string; customers: number; ours: number; total: number; customersLost: number | null }> {
  return FUNNEL_STEPS.map((step, index) => ({
    step: FUNNEL_WORDS[step],
    customers: sides.customers[step],
    ours: sides.ours[step],
    total: sides.total[step],
    // Only the first steps nest (a decision needs a real bill); a milestone can be paid with no bill, and the later
    // steps are not nested at all, so a drop is shown only where it can be one.
    customersLost: index > 0 && index <= 3 ? dropOrNull(sides.customers[FUNNEL_STEPS[index - 1]] - sides.customers[step]) : null,
  }));
}
