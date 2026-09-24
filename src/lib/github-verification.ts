import { z } from "zod";

export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export type GitHubVerificationResult =
  | { status: "verified"; ref: GitHubPullRequestRef; mergedAt: string; state: string }
  | { status: "not_merged"; ref: GitHubPullRequestRef; mergedAt: null; state: string }
  | { status: "unavailable"; ref: GitHubPullRequestRef; reason: string }
  | { status: "failed"; ref: GitHubPullRequestRef; reason: string };

const pullRequestSchema = z.object({
  merged: z.boolean(),
  merged_at: z.string().datetime({ offset: true }).nullable(),
  state: z.string(),
});

export function parseGitHubPullRequestUrl(value: string | null | undefined): GitHubPullRequestRef | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: match[1], repo: match[2], number, url: `https://github.com/${match[1]}/${match[2]}/pull/${number}` };
}

export async function verifyGitHubPullRequest(
  ref: GitHubPullRequestRef,
  options: { token?: string; fetchImpl?: typeof fetch } = {}
): Promise<GitHubVerificationResult> {
  const token = options.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return { status: "unavailable", ref, reason: "GITHUB_TOKEN is not configured" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "vestiarion-agent",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) return { status: "failed", ref, reason: `GitHub returned HTTP ${response.status}` };
    const parsed = pullRequestSchema.safeParse(await response.json());
    if (!parsed.success) return { status: "failed", ref, reason: "GitHub returned an invalid pull request response" };
    if (parsed.data.merged && parsed.data.merged_at) {
      return { status: "verified", ref, mergedAt: parsed.data.merged_at, state: parsed.data.state };
    }
    return { status: "not_merged", ref, mergedAt: null, state: parsed.data.state };
  } catch (error) {
    return { status: "failed", ref, reason: error instanceof Error ? error.message : "GitHub request failed" };
  }
}
