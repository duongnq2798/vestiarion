import { utcMinute } from "../copy";
import type { OrgDb } from "../dal";
import { OFAC_ADDRESS_SOURCE } from "../sanctioned-wallets";

/**
 * Whether a workspace's live screening works (docs/superpowers/specs/2026-10-22-screening-health-design.md SH3, SH4),
 * read from its own `compliance_checks` in its own scope: configured is not the same as answering. Only lookups of the
 * screening provider count. A sandbox's bundled-list checks say nothing about the service, and neither does a verdict
 * on a payout address on OFAC's list (`OFAC_ADDRESS_SOURCE`): it is written as live but calls no provider, so it is
 * left out by its source. Each read is one `limit 1` query on migration 0139's index of live checks (the same rows
 * without it, before it runs).
 */

export interface LiveCheck {
  status: "complete" | "failed";
  at: string;
}

const NEWEST_FIRST = { ascending: false } as const;

/** The workspace's newest live lookup, complete or failed, or null when it has none. A read that fails throws. */
export async function readNewestLiveCheck(orgDb: OrgDb): Promise<LiveCheck | null> {
  const result = await orgDb
    .from("compliance_checks")
    .select("status, created_at")
    .eq("screening_mode", "live")
    .neq("source", OFAC_ADDRESS_SOURCE)
    .order("created_at", NEWEST_FIRST)
    .limit(1);
  if (result.error) throw new Error(`compliance_checks not read: ${result.error.message}`);
  const row = ((result.data ?? []) as Array<{ status: string; created_at: string }>)[0];
  return row ? { status: row.status === "failed" ? "failed" : "complete", at: row.created_at } : null;
}

/** When the workspace last had a complete live lookup, or null when it never has. A read that fails throws. */
export async function readLastLiveSuccess(orgDb: OrgDb): Promise<string | null> {
  const result = await orgDb
    .from("compliance_checks")
    .select("created_at")
    .eq("screening_mode", "live")
    .neq("source", OFAC_ADDRESS_SOURCE)
    .eq("status", "complete")
    .order("created_at", NEWEST_FIRST)
    .limit(1);
  if (result.error) throw new Error(`compliance_checks not read: ${result.error.message}`);
  return ((result.data ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null;
}

/** The Compliance page's line for owners and admins (SH3). A read that fails says so, never "none yet". */
export async function lastLiveSuccessLine(orgDb: OrgDb): Promise<string> {
  try {
    const at = await readLastLiveSuccess(orgDb);
    return `Last successful live screening: ${at ? utcMinute(at) : "none yet"}`;
  } catch (error) {
    console.error("compliance: last live screening not read", error instanceof Error ? error.message : error);
    return "Last successful live screening: could not be read";
  }
}
