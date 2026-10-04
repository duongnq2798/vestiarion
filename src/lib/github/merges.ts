import { runCycleSoon } from "../agent/cycle-soon";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { parseGitHubPullRequestUrl } from "../github-verification";

/**
 * A merged pull request starts a cycle (docs/superpowers/specs/2026-10-04-github-bounties-design.md B13). The GitHub
 * check verifies a milestone at its workspace's next cycle; without this, a bounty the app said is paid "once this pull
 * request is merged" would wait for the six-hourly schedule. Every workspace that connected the delivery's installation
 * and has a pending milestone for the pull request gets a cycle within a minute, under the member who connected it.
 */

export interface MergedPullRequest {
  installationId: number;
  owner: string;
  repo: string;
  number: number;
  url: string;
}

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A `pull_request` delivery for a pull request that was just merged, or null. */
export function readMergedPullRequest(payload: unknown): MergedPullRequest | null {
  const delivery = payload as {
    action?: unknown;
    installation?: { id?: unknown };
    repository?: { name?: unknown; owner?: { login?: unknown } };
    pull_request?: { number?: unknown; html_url?: unknown; merged?: unknown };
  } | null;
  if (!delivery || delivery.action !== "closed" || delivery.pull_request?.merged !== true) return null;
  const { installation, repository, pull_request: pull } = delivery;
  if (!positiveInteger(installation?.id) || !positiveInteger(pull.number) || !text(pull.html_url)) return null;
  if (!text(repository?.name) || !text(repository?.owner?.login)) return null;
  return { installationId: installation.id, owner: repository.owner.login, repo: repository.name, number: pull.number, url: pull.html_url };
}

/** Starts a cycle for each workspace waiting on this pull request, and says which ones. */
export async function handlePullRequestMerged(pull: MergedPullRequest): Promise<string[]> {
  const workspaces = unwrap(
    await platformDb().from("github_installations").select("org_id, connected_by").eq("installation_id", pull.installationId)
  ) as Array<{ org_id: string; connected_by: string | null }>;
  const owner = pull.owner.toLowerCase();
  const repo = pull.repo.toLowerCase();
  const started: string[] = [];
  for (const workspace of workspaces) {
    // A cycle runs as someone: the member who connected GitHub, as a bounty is added under their name.
    if (!workspace.connected_by) continue;
    const waiting = await withOrg(workspace.org_id, async () => {
      const pending = unwrap(
        await db().from("milestones").select("verification_source").eq("status", "pending").not("verification_source", "is", null)
      ) as Array<{ verification_source: string | null }>;
      // However its link was written: GitHub's names are case-insensitive, and a link may go on past the number.
      return pending.some((row) => {
        const ref = parseGitHubPullRequestUrl(row.verification_source);
        return ref !== null && ref.owner.toLowerCase() === owner && ref.repo.toLowerCase() === repo && ref.number === pull.number;
      });
    });
    if (!waiting) continue;
    const org = unwrap(await platformDb().from("orgs").select("mode").eq("id", workspace.org_id).single()) as { mode: string };
    runCycleSoon({ orgId: workspace.org_id, userId: workspace.connected_by, sandbox: org.mode === "sandbox", kind: "pull_request_merged" });
    started.push(workspace.org_id);
  }
  return started;
}
