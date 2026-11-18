import { z } from "zod";
import { platformDb } from "../dal";
import { withOrg } from "../dal/scope";
import { latestDecisionView, type LatestDecisionFacts, type LatestDecisionView } from "../latest-decision";
import { ledgerPublicKeyPems } from "../ledger";
import { NETWORK_IDS } from "../network";
import { publicRead } from "./public-cache";

/**
 * What the landing reads for its latest decision (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R4):
 * the service role's `latest_team_decision()` (migration 0087), which looks only at the team's own live workspaces,
 * then the public keys of the workspace that signed it, read in that workspace's scope. Its id goes no further than
 * this file. Until the migration runs, or when the read fails, there is nothing to show and the landing goes on without
 * it.
 */

export interface LatestDecisionShown extends LatestDecisionView {
  /** The public halves of the signing workspace's keys, by id, as PEM: the reader's browser checks the entry with them. */
  publicKeys: Record<string, string>;
}

const nullableNumber = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]).nullable();

const foundSchema = z.object({
  orgId: z.string().uuid(),
  seq: z.number().int(),
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
  // Absent until migration 0088 runs.
  paidTxHash: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  bodyHash: z.string(),
  signature: z.string(),
  prevHash: z.string(),
  hash: z.string(),
  signingKeyId: z.string().nullable(),
});

type Found = { facts: LatestDecisionFacts; publicKeys: Record<string, string> } | null;

/** Kept a minute in the shared cache (public-cache.ts); a read that fails throws, so it is never kept. */
const readFound = publicRead("latest-team-decision", async function fetchLatest(): Promise<Found> {
  const result = await platformDb().rpc("latest_team_decision");
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) return null;
  const { orgId, bodyHash, signature, prevHash, hash, signingKeyId, ...rest } = foundSchema.parse(result.data);
  const publicKeys = await withOrg(orgId, async () => ledgerPublicKeyPems());
  return {
    facts: { ...rest, link: { body_hash: bodyHash, signature, prev_hash: prevHash, hash, signing_key_id: signingKeyId } },
    publicKeys,
  };
});

/** The team's latest decision as the landing shows it, said as of `now`; null when there is none to show or it could not be read. */
export async function readLatestDecision(now: number = Date.now()): Promise<LatestDecisionShown | null> {
  try {
    const found = await readFound();
    return found ? { ...latestDecisionView(found.facts, now), publicKeys: found.publicKeys } : null;
  } catch (error) {
    console.error("latest decision not read", error instanceof Error ? error.message : error);
    return null;
  }
}
