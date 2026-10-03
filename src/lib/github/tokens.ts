import { currentOrgId } from "../context";
import type { GitHubPullRequestRef } from "../github-verification";
import { installationToken, repositoryInstallationId } from "./app";
import { githubInstallations } from "./installs";
import { githubAppSettingsFromEnv } from "./settings";

/**
 * For one run of the GitHub check, in a workspace's scope (docs/superpowers/specs/2026-10-04-github-app-design.md G5):
 * the token to read a pull request with. A repository in an installation the workspace connected is read with that
 * installation's token, so its private pull requests can verify; anything else gets `undefined`, which leaves the
 * check on the deployment's own token, as before. Repositories' installations and installations' tokens are looked
 * up once per run and kept in memory only (G7). Never throws: a lookup that fails falls back to the deployment's token.
 */
export async function pullRequestTokens(options: { fetchImpl?: typeof fetch } = {}): Promise<(ref: GitHubPullRequestRef) => Promise<string | undefined>> {
  const settings = githubAppSettingsFromEnv();
  if (!settings) return async () => undefined;
  let connected: Set<number>;
  try {
    connected = new Set((await githubInstallations(currentOrgId())).map((installation) => installation.installationId));
  } catch (error) {
    console.error("github: connected installations not read", error instanceof Error ? error.message : "unknown error");
    return async () => undefined;
  }
  if (connected.size === 0) return async () => undefined;

  const repositories = new Map<string, Promise<number | null>>();
  const tokens = new Map<number, Promise<string>>();
  return async (ref) => {
    const repository = `${ref.owner}/${ref.repo}`.toLowerCase();
    try {
      if (!repositories.has(repository)) repositories.set(repository, repositoryInstallationId(settings, ref.owner, ref.repo, options));
      const installationId = await repositories.get(repository);
      if (!installationId || !connected.has(installationId)) return undefined;
      if (!tokens.has(installationId)) tokens.set(installationId, installationToken(settings, installationId, options));
      return await tokens.get(installationId);
    } catch (error) {
      // The message names GitHub's status and the call, never a token.
      console.error("github: reading with the installation's token failed", repository, error instanceof Error ? error.message : "unknown error");
      return undefined;
    }
  };
}
