import { parseGitHubPullRequestUrl, verifyGitHubPullRequest } from "./github-verification";
import { appendLedgerEntry } from "./ledger";
import { supabase, unwrap } from "./supabase";

interface MilestoneVerificationRow {
  id: string;
  title: string;
  verification_source: string | null;
  verification_method: string;
  verification_status: string;
  verified: boolean;
  status: string;
}

export interface VerificationRefreshResult {
  checked: number;
  verified: number;
  unavailable: number;
  failed: number;
}

/** Refresh GitHub-backed evidence before the contractor release pass. */
export async function refreshGitHubMilestones(): Promise<VerificationRefreshResult> {
  const db = supabase();
  const rows = unwrap(
    await db
      .from("milestones")
      .select("id, title, verification_source, verification_method, verification_status, verified, status")
      .neq("status", "paid")
  ) as MilestoneVerificationRow[];

  const candidates = rows
    .map((row) => ({ row, ref: parseGitHubPullRequestUrl(row.verification_source) }))
    .filter((candidate) => candidate.ref !== null && candidate.row.verification_method !== "manual");
  const totals: VerificationRefreshResult = { checked: 0, verified: 0, unavailable: 0, failed: 0 };

  for (const { row, ref } of candidates) {
    if (!ref) continue;
    const result = await verifyGitHubPullRequest(ref);
    totals.checked += 1;
    if (result.status === "verified") totals.verified += 1;
    if (result.status === "unavailable") totals.unavailable += 1;
    if (result.status === "failed") totals.failed += 1;

    const checkedAt = new Date().toISOString();
    const isVerified = result.status === "verified";
    const keepsPreviousVerdict = result.status === "unavailable" || result.status === "failed";
    const nextVerified = keepsPreviousVerdict ? row.verified : isVerified;
    const nextStatus = keepsPreviousVerdict
      ? row.status
      : row.status === "paid"
        ? "paid"
        : isVerified
          ? "verified"
          : "pending";
    const verificationStatus = result.status;
    const detail = result.status === "verified" || result.status === "not_merged"
      ? { pullRequest: ref.url, state: result.state, mergedAt: result.mergedAt }
      : { pullRequest: ref.url, error: result.reason };

    const update = await db.from("milestones").update({
      verified: nextVerified,
      status: nextStatus,
      verification_method: "github",
      verification_status: verificationStatus,
      verification_checked_at: checkedAt,
      verified_at: isVerified ? result.mergedAt : keepsPreviousVerdict ? undefined : null,
      verification_detail: detail,
    }).eq("id", row.id);
    if (update.error) throw new Error(update.error.message);

    const changed = row.verified !== nextVerified || row.verification_status !== verificationStatus;
    if (changed) {
      await appendLedgerEntry({
        actor: "system",
        domain: "contractor",
        action: result.status === "verified" ? "verify_milestone_github" : "github_verification_update",
        summary: result.status === "verified"
          ? `GitHub verified merged PR for milestone “${row.title}”`
          : `GitHub verification ${result.status.replace("_", " ")} for milestone “${row.title}”`,
        detail: {
          milestoneId: row.id,
          verificationSource: ref.url,
          verificationMethod: "github",
          verificationStatus,
          complete: result.status !== "unavailable" && result.status !== "failed",
          previousVerified: row.verified,
          verified: nextVerified,
          ...detail,
        },
      });
    }
  }

  return totals;
}
