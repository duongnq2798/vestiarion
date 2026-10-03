import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { parseGitHubPullRequestUrl, type GitHubPullRequestRef } from "../github-verification";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { createPullRequestComment, installationToken, repositoryInstallationId } from "./app";
import { githubInstallations } from "./installs";
import { githubAppSettingsFromEnv, type GitHubAppSettings } from "./settings";

/**
 * A comment on the pull request a milestone was paid for (docs/superpowers/specs/2026-10-04-github-app-design.md G4).
 *
 * Which payments: a milestone's, confirmed live with a transaction on Arc testnet, within three days, after the
 * workspace first connected GitHub, and not yet commented. Where: only a pull request whose repository's installation
 * the workspace connected, so Vestiarion never comments where it was not invited. How: claimed before it is posted,
 * released if posting fails, its link kept once posted, and `pull_request_commented` recorded. What it says: the amount,
 * the network, the paying workspace and the transaction; never the payee. Runs inside a workspace's scope, in the
 * cycle's `notices` stage. Never throws for one comment.
 */

/** How long after a payment its comment is still tried. */
export const COMMENT_WINDOW_DAYS = 3;
/** The most comments one run posts: a cycle never waits on a long queue of them. */
export const COMMENTS_PER_RUN = 10;

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const ARC_TX = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Text as it is, in Markdown: every ASCII punctuation mark escaped, so a name cannot become a link or HTML. GitHub finds
 * mentions and issue references in the rendered text, after the escapes are gone, so a word joiner (U+2060) follows
 * each `@` and `#`: a name cannot mention anyone or point at an issue either.
 */
function literal(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, (mark) => (mark === "@" || mark === "#" ? `\\${mark}⁠` : `\\${mark}`));
}

/** The comment: what was paid, on which network, by whom, and the transaction. Never the payee (G4). */
export function pullRequestCommentBody(input: { amount: string; token: "USDC" | "EURC"; orgName: string; txHash: string; origin: string }): string {
  const short = `${input.txHash.slice(0, 10)}…${input.txHash.slice(-8)}`;
  return [
    `**Paid: ${input.amount} ${input.token} on Arc testnet** for this pull request, by ${literal(input.orgName)}.`,
    "",
    `Transaction: [${short}](${ARC_TX(input.txHash)})`,
    "",
    `<sub>Posted by [Vestiarion](${input.origin}) once the payment was confirmed. The payment is a signed entry in the payer's ledger.</sub>`,
  ].join("\n");
}

export interface CommentLine {
  domain: string;
  message: string;
}

interface DueIntent {
  id: string;
  source_id: string;
  amount: string | number;
  token: string | null;
  tx_hash: string | null;
  chain: string | null;
  confirmed_at: string | null;
  payout_route: string | null;
}

const where = (ref: GitHubPullRequestRef) => `${ref.owner}/${ref.repo}#${ref.number}`;

export async function sendPullRequestComments(
  options: { settings?: GitHubAppSettings | null; now?: number; fetchImpl?: typeof fetch; origin?: string } = {}
): Promise<CommentLine[]> {
  const settings = options.settings === undefined ? githubAppSettingsFromEnv() : options.settings;
  if (!settings) return [];
  const orgId = currentOrgId();
  const installations = await githubInstallations(orgId);
  if (installations.length === 0) return [];
  const connected = new Set(installations.map((installation) => installation.installationId));
  const now = options.now ?? Date.now();
  const deps = { fetchImpl: options.fetchImpl, now: () => now };

  // Nothing paid before the workspace connected GitHub is commented: connecting never posts on older pull requests.
  const windowStart = now - COMMENT_WINDOW_DAYS * 86_400_000;
  const firstConnected = Math.min(...installations.map((installation) => Date.parse(installation.connectedAt)));
  const since = new Date(Math.max(windowStart, Number.isFinite(firstConnected) ? firstConnected : windowStart)).toISOString();

  const due = (
    unwrap(
      await db()
        .from("payment_intents")
        .select("id, source_id, amount, token, tx_hash, chain, confirmed_at, payout_route")
        .eq("source_type", "milestone")
        .eq("status", "confirmed")
        .eq("provider_mode", "live")
        .is("pr_comment_at", null)
        .gte("confirmed_at", since)
        // Newest first: what was just paid is said first.
        .order("confirmed_at", { ascending: false })
        .limit(COMMENTS_PER_RUN * 5)
    ) as DueIntent[]
  )
    // Paid on Arc testnet, with its transaction: the comment links it.
    .filter((intent) => (intent.chain ?? "ARC-TESTNET") === "ARC-TESTNET" && !intent.payout_route && TX_HASH.test(intent.tx_hash ?? ""));
  if (due.length === 0) return [];

  const milestones = unwrap(
    await db().from("milestones").select("id, title, verification_source").in("id", [...new Set(due.map((intent) => intent.source_id))])
  ) as Array<{ id: string; title: string; verification_source: string | null }>;
  const pullRequests = new Map(milestones.map((row) => [row.id, parseGitHubPullRequestUrl(row.verification_source)]));
  if (![...pullRequests.values()].some(Boolean)) return [];
  const org = unwrap(await platformDb().from("orgs").select("name").eq("id", orgId).single()) as { name: string };
  const origin = options.origin ?? siteOrigin();

  // Looked up once per run: a repository's installation, and an installation's token, kept in memory only (G7).
  const repositoryInstallations = new Map<string, number | null>();
  const tokens = new Map<number, string>();
  const lines: CommentLine[] = [];
  let posted = 0;
  for (const intent of due) {
    if (posted >= COMMENTS_PER_RUN) break;
    const ref = pullRequests.get(intent.source_id);
    if (!ref) continue;

    const repository = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (!repositoryInstallations.has(repository)) {
      try {
        repositoryInstallations.set(repository, await repositoryInstallationId(settings, ref.owner, ref.repo, deps));
      } catch (error) {
        console.error("github: installation not found", repository, error instanceof Error ? error.message : "unknown error");
        repositoryInstallations.set(repository, null);
      }
    }
    const installationId = repositoryInstallations.get(repository);
    // Only where the workspace connected the app: another workspace's installation of the same repository is not this one's.
    if (!installationId || !connected.has(installationId)) continue;

    // Claimed before it is posted: two runs at once never comment twice.
    const claimed = unwrap(
      await db().from("payment_intents").update({ pr_comment_at: new Date(now).toISOString() }).eq("id", intent.id).is("pr_comment_at", null).select("id")
    ) as Array<{ id: string }>;
    if (claimed.length === 0) continue;

    const token = intent.token === "EURC" ? "EURC" : "USDC";
    const amount = AMOUNT.format(Number(intent.amount));
    let comment: { id: number; url: string };
    try {
      const installation = tokens.get(installationId) ?? (await installationToken(settings, installationId, deps));
      tokens.set(installationId, installation);
      comment = await createPullRequestComment(
        installation,
        ref,
        pullRequestCommentBody({ amount, token, orgName: org.name, txHash: intent.tx_hash as string, origin }),
        deps
      );
    } catch (error) {
      // Released, so the next run tries again within the window. The message names GitHub's status, never a token.
      await db().from("payment_intents").update({ pr_comment_at: null }).eq("id", intent.id);
      const reason = error instanceof Error ? error.message : "posting failed";
      console.error("github: pull request comment not posted", intent.id, reason);
      lines.push({ domain: "contractor", message: `Comment on ${where(ref)} not posted (${reason}); tried again at the next cycle` });
      continue;
    }
    posted += 1;
    await db().from("payment_intents").update({ pr_comment_url: comment.url }).eq("id", intent.id);
    await appendLedgerEntryBestEffort(orgId, {
      actor: "system",
      domain: "contractor",
      action: "pull_request_commented",
      summary: `Said on ${where(ref)} that ${amount} ${token} was paid`,
      detail: { milestoneId: intent.source_id, pullRequest: ref.url, commentUrl: comment.url, amount: Number(intent.amount), token, txHash: intent.tx_hash },
    });
    lines.push({ domain: "contractor", message: `Commented on ${where(ref)}: ${amount} ${token} paid` });
  }
  return lines;
}
