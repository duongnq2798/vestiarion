import { siteOrigin } from "../auth/env";
import { can } from "../auth/roles";
import { memberActor, type Actor } from "../commands/actor";
import { addMilestone } from "../commands/milestones";
import { createCounterparty } from "../counterparties/create";
import { changeCounterpartyAddress, CounterpartyAddressError } from "../counterparty-address";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import type { GitHubPullRequestRef } from "../github-verification";
import { counterpartyInputSchema, usdcAmountSchema } from "../intake-validation";
import { appendLedgerEntry } from "../ledger";
import { notifyPayeeAddress } from "../notifications/payee-address";
import { createPullRequestComment, installationToken, repositoryPermission } from "./app";
import { literal } from "./markdown";
import { githubAppSettingsFromEnv, type GitHubAppSettings } from "./settings";
import { readCommentCommand } from "./webhook";
import { CHECKSUM_MISMATCH } from "../address-checksum";
import { homeChain } from "../payee-chains";
import { workspaceNetwork } from "../workspace-network";

/**
 * Bounties from a pull request comment (docs/superpowers/specs/2026-10-04-github-bounties-design.md).
 *
 * `/bounty <amount>` from someone who can write to the repository (B4) attaches a bounty: under the member who
 * connected the installation (B5), a contractor for the pull request's author (B7) and a milestone for the pull request
 * (B8), with one claimed record per pull request and per comment (B6), a ledger entry (B11) and a reply (B10).
 * `/payto <address>` from the pull request's author changes their address as a payee link does, waiting for a member
 * (B9). The agent then decides the release under every guardrail, as for any milestone (B12).
 */

/** A created comment on a pull request, as GitHub's `issue_comment` delivery describes it. */
export interface PullRequestComment {
  installationId: number;
  owner: string;
  repo: string;
  pull: { number: number; url: string; title: string; open: boolean; merged: boolean; author: string; authorIsBot: boolean };
  comment: { id: number; url: string; body: string; author: string; authorIsBot: boolean };
}

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The delivery's comment, or null unless it is a new comment on a pull request with everything this needs (B1). */
export function readPullRequestComment(payload: unknown): PullRequestComment | null {
  const delivery = payload as {
    action?: unknown;
    installation?: { id?: unknown };
    repository?: { name?: unknown; owner?: { login?: unknown } };
    issue?: {
      number?: unknown;
      title?: unknown;
      state?: unknown;
      html_url?: unknown;
      user?: { login?: unknown; type?: unknown };
      pull_request?: { merged_at?: unknown } | null;
    };
    comment?: { id?: unknown; html_url?: unknown; body?: unknown; user?: { login?: unknown; type?: unknown } };
  } | null;
  if (!delivery || delivery.action !== "created") return null;
  const { installation, repository, issue, comment } = delivery;
  if (!positiveInteger(installation?.id) || !issue?.pull_request || !comment) return null;
  if (!text(repository?.name) || !text(repository?.owner?.login)) return null;
  if (!positiveInteger(issue.number) || !text(issue.html_url) || !text(issue.user?.login)) return null;
  if (!positiveInteger(comment.id) || !text(comment.html_url) || !text(comment.user?.login)) return null;
  return {
    installationId: installation.id,
    owner: repository.owner.login,
    repo: repository.name,
    pull: {
      number: issue.number,
      url: issue.html_url,
      title: typeof issue.title === "string" ? issue.title : "",
      open: issue.state === "open",
      merged: text(issue.pull_request.merged_at),
      author: issue.user.login,
      authorIsBot: issue.user.type === "Bot",
    },
    comment: {
      id: comment.id,
      url: comment.html_url,
      body: typeof comment.body === "string" ? comment.body : "",
      author: comment.user.login,
      authorIsBot: comment.user.type === "Bot",
    },
  };
}

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const usdc = (amount: string | number) => `${AMOUNT.format(Number(amount))} USDC`;
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const FOOTER = (origin: string) => `<sub>Posted by [Vestiarion](${origin}). Every payment is a signed entry in the payer's ledger.</sub>`;

export type BountyReply =
  | { kind: "attached"; amount: string; orgName: string; author: string; merged: boolean; addressOnFile: boolean; origin: string }
  | { kind: "exists"; amount: string | number; orgName: string }
  | { kind: "not_allowed" }
  | { kind: "bounty_usage" }
  | { kind: "bot_author" }
  | { kind: "closed" }
  | { kind: "ambiguous" }
  | { kind: "reconnect" }
  | { kind: "failed" }
  | { kind: "no_bounty" }
  | { kind: "not_author"; author: string }
  | { kind: "payto_usage" }
  | { kind: "payto_checksum" }
  | { kind: "address_received"; author: string; address: string; orgName: string }
  | { kind: "address_on_file"; author: string };

/**
 * What the app says on the pull request (B10). A workspace's name is escaped; a GitHub login is mentioned on purpose,
 * so its owner is notified, and GitHub's logins hold only letters, digits and dashes. Never an email, a link or a
 * secret.
 */
export function bountyReply(reply: BountyReply): string {
  switch (reply.kind) {
    case "attached": {
      const org = literal(reply.orgName);
      const when = reply.merged ? "This pull request is already merged, so the agent pays it at its next run" : "The agent pays it once this pull request is merged";
      const where = reply.addressOnFile
        ? `It is paid to the address ${org} has on file for @${reply.author}.`
        : `@${reply.author}, reply with \`/payto\` and your Arc address to say where you are paid, for example \`/payto 0x…\`. ${org} confirms the address before the first payment.`;
      return [`**Bounty: ${usdc(reply.amount)} on Arc testnet** from ${org}, for this pull request.`, "", `${where} ${when}, under the limits ${org} set.`, "", FOOTER(reply.origin)].join("\n");
    }
    case "exists":
      return `This pull request already has a bounty of ${usdc(reply.amount)} from ${literal(reply.orgName)}. To change it, edit its milestone in Vestiarion.`;
    case "not_allowed":
      return "Only someone who can write to this repository can attach a bounty.";
    case "bounty_usage":
      return "To attach a bounty, comment `/bounty` and an amount in USDC with at most 6 decimals, for example `/bounty 25`.";
    case "bot_author":
      return "A bounty pays a person, and this pull request was opened by a bot. Nothing was attached.";
    case "closed":
      return "This pull request was closed without being merged, so no bounty was attached.";
    case "ambiguous":
      return "This repository is connected to more than one Vestiarion workspace, so a bounty cannot be attached from a comment. Add it in Vestiarion instead.";
    case "reconnect":
      return "The Vestiarion workspace connected to this repository cannot add work from here right now. Someone there connects GitHub again in Settings. Nothing was attached.";
    case "failed":
      return "Something went wrong on Vestiarion's side. Nothing was attached; try again in a moment.";
    case "no_bounty":
      return "There is no bounty on this pull request.";
    case "not_author":
      return `Only @${reply.author}, who opened this pull request, can say where its bounty is paid.`;
    case "payto_checksum":
      return `${CHECKSUM_MISMATCH} Copy it again from your wallet and comment \`/payto\` with it.`;
    case "payto_usage":
      return "To say where you are paid, comment `/payto` and your Arc address: 0x followed by 40 hex characters.";
    case "address_received":
      return `Got it, @${reply.author}: the bounty is to be paid to \`${shortAddress(reply.address)}\` on Arc testnet. ${literal(reply.orgName)} confirms new addresses before paying them.`;
    case "address_on_file":
      return `That address is already on file for @${reply.author}.`;
  }
}

export type BountyOutcome =
  | { kind: "ignored" }
  /** A comment this already handled, delivered again: nothing is done or said twice (B6). */
  | { kind: "duplicate" }
  | { kind: "replied"; result: "attached" | "address" | "refused" };

const IGNORED: BountyOutcome = { kind: "ignored" };
const DUPLICATE: BountyOutcome = { kind: "duplicate" };

interface Options {
  settings?: GitHubAppSettings | null;
  fetchImpl?: typeof fetch;
  origin?: string;
}

/** Acts on one created pull request comment. Never throws for what GitHub sent; a failed reply is only logged (B10). */
export async function handlePullRequestComment(event: PullRequestComment, options: Options = {}): Promise<BountyOutcome> {
  const command = readCommentCommand(event.comment.body);
  // The app's own replies, and any other bot's comments, are never commands.
  if (!command || event.comment.authorIsBot) return IGNORED;
  const settings = options.settings === undefined ? githubAppSettingsFromEnv() : options.settings;
  if (!settings) return IGNORED;

  const workspaces = unwrap(
    await platformDb().from("github_installations").select("org_id, connected_by").eq("installation_id", event.installationId)
  ) as Array<{ org_id: string; connected_by: string | null }>;
  // Installed, but no workspace asked to act here: nothing is said (B3).
  if (workspaces.length === 0) return IGNORED;

  const deps = { fetchImpl: options.fetchImpl };
  const ref: GitHubPullRequestRef = { owner: event.owner, repo: event.repo, number: event.pull.number, url: event.pull.url };
  let token: string | null = null;
  const installation = async () => (token ??= await installationToken(settings, event.installationId, deps));
  const reply = async (body: BountyReply, result: "attached" | "address" | "refused"): Promise<BountyOutcome> => {
    try {
      await createPullRequestComment(await installation(), ref, bountyReply(body), deps);
    } catch (error) {
      console.error("github: bounty reply not posted", `${event.owner}/${event.repo}#${event.pull.number}`, error instanceof Error ? error.message : "unknown error");
    }
    return { kind: "replied", result };
  };

  if (workspaces.length > 1) return reply({ kind: "ambiguous" }, "refused");
  const { org_id: orgId, connected_by: connectedBy } = workspaces[0];
  const orgName = (unwrap(await platformDb().from("orgs").select("name").eq("id", orgId).single()) as { name: string }).name;
  const repository = `${event.owner}/${event.repo}`.toLowerCase();

  if (command.kind === "payto" || command.kind === "payto_invalid") {
    const bounty = (
      unwrap(
        await platformDb()
          .from("github_bounties")
          .select("author_login, counterparty_id")
          .eq("org_id", orgId)
          .eq("repository", repository)
          .eq("pull_number", event.pull.number)
          .not("counterparty_id", "is", null)
          .limit(1)
      ) as Array<{ author_login: string; counterparty_id: string }>
    )[0];
    if (!bounty) return reply({ kind: "no_bounty" }, "refused");
    if (bounty.author_login.toLowerCase() !== event.comment.author.toLowerCase()) return reply({ kind: "not_author", author: bounty.author_login }, "refused");
    if (command.kind === "payto_invalid") return reply({ kind: "payto_usage" }, "refused");
    try {
      const changed = await withOrg(orgId, () =>
        changeCounterpartyAddress({
          github: { installationId: event.installationId, login: event.comment.author, commentUrl: event.comment.url },
          counterpartyId: bounty.counterparty_id,
          raw: command.address,
        })
      );
      // Nothing is paid to it until a member confirms it, and they are told it arrived, as for a payee link.
      await notifyPayeeAddress({ orgId, orgName, payeeName: changed.name, address: command.address });
    } catch (error) {
      if (error instanceof CounterpartyAddressError && error.code === "unchanged") return reply({ kind: "address_on_file", author: event.comment.author }, "refused");
      // A mistyped address is told apart from one that is no address (payment safety A3).
      if (error instanceof CounterpartyAddressError && error.code === "checksum") return reply({ kind: "payto_checksum" }, "refused");
      console.error("github: address from a pull request comment not saved", orgId, error instanceof Error ? error.message : "unknown error");
      return reply({ kind: "failed" }, "refused");
    }
    return reply({ kind: "address_received", author: event.comment.author, address: command.address, orgName }, "address");
  }

  // A comment GitHub delivers again was handled once already (B6).
  const seen = unwrap(await platformDb().from("github_bounties").select("id").eq("comment_id", event.comment.id).limit(1)) as Array<{ id: string }>;
  if (seen.length > 0) return DUPLICATE;

  const permission = await repositoryPermission(await installation(), event.owner, event.repo, event.comment.author, deps);
  if (permission !== "admin" && permission !== "write") return reply({ kind: "not_allowed" }, "refused");
  if (command.kind === "bounty_invalid") return reply({ kind: "bounty_usage" }, "refused");
  const amount = usdcAmountSchema.safeParse(command.amount);
  if (!amount.success) return reply({ kind: "bounty_usage" }, "refused");
  if (event.pull.authorIsBot) return reply({ kind: "bot_author" }, "refused");
  if (!event.pull.open && !event.pull.merged) return reply({ kind: "closed" }, "refused");

  const actor: Actor | null = connectedBy
    ? await memberActor(orgId, connectedBy, { kind: "github", installationId: event.installationId, login: event.comment.author })
    : null;
  if (!actor || !can(actor.role, "records.write")) return reply({ kind: "reconnect" }, "refused");

  // Claimed before anything is made: two comments at once never make two milestones (B6).
  const claimed = await platformDb()
    .from("github_bounties")
    .insert({
      org_id: orgId,
      installation_id: event.installationId,
      repository,
      pull_number: event.pull.number,
      pull_url: event.pull.url,
      author_login: event.pull.author,
      amount: amount.data,
      attached_by_login: event.comment.author,
      comment_id: event.comment.id,
      comment_url: event.comment.url,
    })
    .select("id");
  if (claimed.error) {
    if (claimed.error.code === "23505" && claimed.error.message.includes("github_bounties_comment_key")) return DUPLICATE;
    if (claimed.error.code === "23505") {
      const onFile = (
        unwrap(
          await platformDb().from("github_bounties").select("amount").eq("org_id", orgId).eq("repository", repository).eq("pull_number", event.pull.number).limit(1)
        ) as Array<{ amount: string | number }>
      )[0];
      return reply({ kind: "exists", amount: onFile?.amount ?? amount.data, orgName }, "refused");
    }
    throw new Error(claimed.error.message);
  }
  const bountyId = (claimed.data as Array<{ id: string }>)[0].id;

  let attached: { counterpartyId: string; milestoneId: string; addressOnFile: boolean } | null = null;
  try {
    attached = await withOrg(orgId, () => attach(event, actor, amount.data, bountyId), { userId: actor.userId });
  } catch (error) {
    console.error("github: bounty not attached", orgId, error instanceof Error ? error.message : "unknown error");
  }
  if (!attached) {
    // Released, so the pull request can be given a bounty again.
    await platformDb().from("github_bounties").delete().eq("id", bountyId);
    return reply({ kind: "failed" }, "refused");
  }
  return reply(
    { kind: "attached", amount: amount.data, orgName, author: event.pull.author, merged: event.pull.merged, addressOnFile: attached.addressOnFile, origin: options.origin ?? siteOrigin() },
    "attached"
  );
}

/** Inside the workspace: the contractor, the milestone, the claim filled in, and the entry (B7, B8, B11). Null when the milestone was refused. */
async function attach(
  event: PullRequestComment,
  actor: Actor,
  amount: string,
  bountyId: string
): Promise<{ counterpartyId: string; milestoneId: string; addressOnFile: boolean } | null> {
  const orgId = actor.orgId;
  // The same GitHub account is the same counterparty across the workspace's bounties.
  const known = (
    unwrap(
      await platformDb()
        .from("github_bounties")
        .select("counterparty_id")
        .eq("org_id", orgId)
        .ilike("author_login", event.pull.author)
        .not("counterparty_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
    ) as Array<{ counterparty_id: string }>
  )[0];
  let counterparty: { id: string; addressOnFile: boolean } | null = null;
  if (known) {
    const row = await db().from("counterparties").select("id, address").eq("id", known.counterparty_id).maybeSingle<{ id: string; address: string | null }>();
    if (row.error) throw new Error(row.error.message);
    if (row.data) counterparty = { id: row.data.id, addressOnFile: Boolean(row.data.address) };
  }
  if (!counterparty) {
    const created = await createCounterparty({
      actorId: actor.userId,
      counterparty: counterpartyInputSchema.parse({
        name: `${event.pull.author} (GitHub)`,
        role: "contractor",
        address: "",
        chain: homeChain(workspaceNetwork().id).id,
        jurisdiction: "",
        paymentLimit: amount,
      }),
      via: "github",
      github: { installationId: event.installationId, login: event.comment.author },
    });
    counterparty = { id: created.id, addressOnFile: false };
  }

  const title = `PR #${event.pull.number}: ${event.pull.title.trim() || `${event.owner}/${event.repo}`}`.slice(0, 160).trim();
  const added = await addMilestone(actor, { milestone: { contractorId: counterparty.id, title, amount, evidence: event.pull.url } });
  if (!added.ok) {
    console.error("github: bounty milestone refused", orgId, added.code);
    return null;
  }
  unwrap(
    await platformDb().from("github_bounties").update({ counterparty_id: counterparty.id, milestone_id: added.milestoneId }).eq("id", bountyId).select("id")
  );
  await appendLedgerEntry({
    actor: "human",
    domain: "contractor",
    action: "github_bounty_attached",
    summary: `${event.comment.author} attached a bounty of ${usdc(amount)} on GitHub to ${event.owner}/${event.repo}#${event.pull.number}, for ${event.pull.author}`,
    detail: {
      by: actor.userId,
      via: "github",
      installationId: event.installationId,
      login: event.comment.author,
      pullRequest: event.pull.url,
      author: event.pull.author,
      amount: Number(amount),
      milestoneId: added.milestoneId,
      counterpartyId: counterparty.id,
      commentUrl: event.comment.url,
    },
  });
  return { counterpartyId: counterparty.id, milestoneId: added.milestoneId, addressOnFile: counterparty.addressOnFile };
}
