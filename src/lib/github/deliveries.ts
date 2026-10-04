import { handlePullRequestComment, readPullRequestComment } from "./bounties";
import type { GitHubAppSettings } from "./settings";
import { readCommentCommand, verifyWebhookSignature } from "./webhook";

/**
 * One delivery to the app's webhook (docs/superpowers/specs/2026-10-04-github-bounties-design.md B2): checked against
 * GitHub's signature before anything is read, quiet for everything but a new pull request comment that carries a
 * command, and answered at once, with the comment handled after the response, inside GitHub's ten seconds.
 */
export async function handleGitHubDelivery(
  request: Request,
  deps: {
    settings: GitHubAppSettings;
    secret: string;
    origin: string;
    /** Runs work after the response: `after()` in the route. */
    defer: (work: () => Promise<void>) => void;
    fetchImpl?: typeof fetch;
  }
): Promise<Response> {
  const raw = await request.text();
  if (!verifyWebhookSignature(deps.secret, raw, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }
  // GitHub's ping when the webhook is set up, and every event the app does not act on.
  if (request.headers.get("x-github-event") !== "issue_comment") return new Response(null, { status: 204 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const comment = readPullRequestComment(payload);
  if (!comment || !readCommentCommand(comment.comment.body)) return new Response(null, { status: 204 });

  deps.defer(async () => {
    try {
      await handlePullRequestComment(comment, { settings: deps.settings, origin: deps.origin, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    } catch (error) {
      console.error("github: pull request comment not handled", `${comment.owner}/${comment.repo}#${comment.pull.number}`, error instanceof Error ? error.message : "unknown error");
    }
  });
  return new Response(null, { status: 202 });
}
