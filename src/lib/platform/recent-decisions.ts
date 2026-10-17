import { z } from "zod";
import { platformDb } from "../dal";
import { recentDecisionView, type DecisionFacts, type RecentDecisionView } from "../latest-decision";
import { NETWORK_IDS } from "../network";

/**
 * What the landing reads for the agent's earlier decisions (docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md
 * D2): the service role's `recent_team_decisions()` (migration 0100), from the same workspaces as the latest decision and
 * on the same terms, one decision per bill, newest first, with how many decisions each network saw in the past week.
 * It carries no workspace id and no signature. Until the migration runs, or when the read fails, there is nothing to
 * show and the latest decision stands alone.
 */

export interface RecentDecisions {
  decisions: RecentDecisionView[];
  /** The agent's decisions in the team's workspaces in the last 7 days, each network on its own, never added together. */
  pastWeek: { mainnet: number; testnet: number };
}

const nullableNumber = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]).nullable();
const count = z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]);

const decisionSchema = z.object({
  seq: z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]),
  ts: z.string(),
  action: z.string(),
  network: z.enum(NETWORK_IDS),
  amount: nullableNumber,
  currency: z.string(),
  decisionMode: z.string().nullable(),
  agreedWithReference: z.boolean().nullable(),
  guardrailBlocked: z.boolean().nullable(),
  guardrailRule: z.string().nullable(),
  heldBecause: z.string().nullable(),
  resultingStatus: z.string().nullable(),
  txRef: z.string().nullable(),
  payOn: z.string().nullable(),
  verdict: z.enum(["agree", "disagree"]).nullable(),
  paidTxHash: z.string().nullable(),
  paymentFailed: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
});

const foundSchema = z.object({
  decisions: z.array(decisionSchema),
  pastWeek: z.object({ "arc-mainnet": count, "arc-testnet": count }),
});

type Found = { decisions: DecisionFacts[]; pastWeek: RecentDecisions["pastWeek"] };

/**
 * Enough to find a refusal by code among the newest: the newest is the latest decision, shown above them, and the
 * landing lists `SHOWN` of the rest.
 */
const READ = 12;
/** How many earlier decisions the landing lists: a few, with the full count on Open numbers. */
export const SHOWN = 3;
const MEMO_MS = 60_000;
let memo: { at: number; value: Promise<Found> } | null = null;

async function fetchRecent(): Promise<Found> {
  const result = await platformDb().rpc("recent_team_decisions", { p_limit: READ });
  if (result.error) throw new Error(result.error.message);
  const found = foundSchema.parse(result.data);
  return { decisions: found.decisions, pastWeek: { mainnet: found.pastWeek["arc-mainnet"], testnet: found.pastWeek["arc-testnet"] } };
}

/** The agent's earlier decisions in the team's workspaces, read at most once a minute on this instance; null when they cannot be read. */
export async function readRecentDecisions(now: number = Date.now()): Promise<RecentDecisions | null> {
  if (!memo || now - memo.at > MEMO_MS) {
    const value = fetchRecent();
    memo = { at: now, value };
    // A failed read is not kept: the next page load tries again.
    value.catch(() => {
      if (memo?.value === value) memo = null;
    });
  }
  try {
    const found = await memo.value;
    return { decisions: found.decisions.map((facts) => recentDecisionView(facts, now)), pastWeek: found.pastWeek };
  } catch (error) {
    console.error("recent decisions not read", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The decisions to list under the latest one: strictly older than it, so the latest never shows twice and a list read
 * a moment later never shows a newer one beneath it, at most `limit`, newest first. When none of those was refused by
 * code but an older one read was, the newest refusal takes the last place: the list then shows the rules in code
 * stopping a payment, not only payments going out.
 */
export function earlierThan(decisions: RecentDecisionView[], latestSeq: number, limit = SHOWN): RecentDecisionView[] {
  const older = decisions.filter((decision) => decision.seq < latestSeq);
  const newest = older.slice(0, limit);
  if (newest.length < limit || newest.some((decision) => decision.outcome.kind === "refused")) return newest;
  const refusal = older.slice(limit).find((decision) => decision.outcome.kind === "refused");
  return refusal ? [...newest.slice(0, limit - 1), refusal] : newest;
}
