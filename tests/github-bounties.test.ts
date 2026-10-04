import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { bountyReply, handlePullRequestComment, readPullRequestComment, type PullRequestComment } from "@/lib/github/bounties";
import { githubAppSettingsFromEnv, type GitHubAppSettings } from "@/lib/github/settings";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

/**
 * Bounties from a pull request comment (docs/superpowers/specs/2026-10-04-github-bounties-design.md B1, B3–B11): a
 * maintainer's `/bounty` becomes a milestone for the pull request's author, under the member who connected GitHub, and
 * the author's `/payto` becomes their address, waiting for a member. GitHub is a recorded fetch; the steps inside the
 * workspace (adding the counterparty and the milestone, changing the address, the ledger, the email) are spies.
 */

const mocks = vi.hoisted(() => ({
  createCounterparty: vi.fn(),
  addMilestone: vi.fn(),
  changeCounterpartyAddress: vi.fn(),
  notifyPayeeAddress: vi.fn(),
  memberActor: vi.fn(),
  appendLedgerEntry: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/counterparties/create", () => ({ createCounterparty: mocks.createCounterparty }));
vi.mock("@/lib/commands/milestones", () => ({ addMilestone: mocks.addMilestone }));
vi.mock("@/lib/counterparty-address", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/counterparty-address")>()),
  changeCounterpartyAddress: mocks.changeCounterpartyAddress,
}));
vi.mock("@/lib/notifications/payee-address", () => ({ notifyPayeeAddress: mocks.notifyPayeeAddress }));
vi.mock("@/lib/commands/actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commands/actor")>()),
  memberActor: mocks.memberActor,
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: mocks.appendLedgerEntry }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b01";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b02";
const MEMBER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b3";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-00000000aaaa";
const BOUNTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000bbbb";
const ADDRESS = `0x${"ab".repeat(20)}`;
const INSTALLATION = 42;

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const settings = githubAppSettingsFromEnv({
  GITHUB_APP_ID: "1234567",
  GITHUB_APP_SLUG: "vestiarion-payments",
  GITHUB_APP_CLIENT_ID: "Iv23liAbCdEf0123456789",
  GITHUB_APP_CLIENT_SECRET: "client-secret-value",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
}) as GitHubAppSettings;
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const ORIGIN = "https://www.vestiarion.xyz";

const comment = (body: string, fields: { author?: string; pull?: Partial<PullRequestComment["pull"]>; commentAuthorIsBot?: boolean } = {}): PullRequestComment => ({
  installationId: INSTALLATION,
  owner: "Acme",
  repo: "widgets",
  pull: { number: 7, url: "https://github.com/Acme/widgets/pull/7", title: "Fix the widget", open: true, merged: false, author: "octocat", authorIsBot: false, ...fields.pull },
  comment: { id: 9001, url: "https://github.com/Acme/widgets/pull/7#issuecomment-9001", body, author: fields.author ?? "maintainer-1", authorIsBot: fields.commentAuthorIsBot ?? false },
});

interface World {
  installations?: Array<{ org_id: string; connected_by: string | null }>;
  permission?: string;
  /** Rows the bounty table holds, as PostgREST would answer a select on it. */
  bounties?: Array<Record<string, unknown>>;
  /** How the claim insert answers: a row, or a unique violation on one of the two keys. */
  claim?: "ok" | "pull_key" | "comment_key";
  counterpartyAddress?: string | null;
}

function world(input: World = {}) {
  const github: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined };
    github.push(call);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (call.url.endsWith(`/app/installations/${INSTALLATION}/access_tokens`)) return json(201, { token: "ghs_installation" });
    if (call.url.includes("/collaborators/")) return json(200, { permission: input.permission ?? "write" });
    if (call.url.endsWith("/issues/7/comments")) return json(201, { id: 5, html_url: "https://github.com/Acme/widgets/pull/7#issuecomment-5" });
    return json(404, { message: "Not Found" });
  }) as typeof fetch;

  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { name: "Northstar *Labs* @team" }) };
    if (sent.path === "/rest/v1/github_installations") return { body: input.installations ?? [{ org_id: ORG, connected_by: MEMBER }] };
    if (sent.path === "/rest/v1/github_bounties" && sent.method === "POST") {
      if (input.claim === "pull_key") return { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "github_bounties_pull_key"' } };
      if (input.claim === "comment_key") return { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "github_bounties_comment_key"' } };
      return { status: 201, body: [{ id: BOUNTY }] };
    }
    if (sent.path === "/rest/v1/github_bounties" && sent.method === "GET") {
      const rows = input.bounties ?? [];
      if (sent.params.get("comment_id")) return { body: rows.filter((row) => `eq.${row.comment_id}` === sent.params.get("comment_id")) };
      if (sent.params.get("author_login")) return { body: rows.filter((row) => row.counterparty_id) };
      return { body: rows };
    }
    if (sent.path === "/rest/v1/github_bounties") return { body: [{ id: BOUNTY }] };
    if (sent.path === "/rest/v1/counterparties") return { body: [{ id: COUNTERPARTY, name: "octocat (GitHub)", address: input.counterpartyAddress ?? null }] };
    return { body: [] };
  });
  const run = (event: PullRequestComment) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () => handlePullRequestComment(event, { settings, fetchImpl, origin: ORIGIN }));
  const replies = () => github.filter((call) => call.url.endsWith("/issues/7/comments")).map((call) => (JSON.parse(call.body as string) as { body: string }).body);
  const bountyWrites = () => fake.requests.filter((sent) => sent.path === "/rest/v1/github_bounties" && sent.method !== "GET");
  return { fake, github, run, replies, bountyWrites };
}

const ACTOR = { orgId: ORG, userId: MEMBER, role: "owner", mode: "live", surface: { kind: "github", installationId: INSTALLATION, login: "maintainer-1" } };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.memberActor.mockResolvedValue(ACTOR);
  mocks.createCounterparty.mockResolvedValue({ id: COUNTERPARTY, name: "octocat (GitHub)", screening: { riskLevel: "clear" } });
  mocks.addMilestone.mockResolvedValue({ ok: true, message: "Milestone added", milestoneId: MILESTONE, contractorName: "octocat (GitHub)" });
  mocks.changeCounterpartyAddress.mockResolvedValue({ name: "octocat (GitHub)", from: null, to: ADDRESS });
  mocks.notifyPayeeAddress.mockResolvedValue(1);
  mocks.appendLedgerEntry.mockResolvedValue({ seq: 1 });
});

describe("readPullRequestComment (B1)", () => {
  const payload = {
    action: "created",
    installation: { id: INSTALLATION },
    repository: { name: "widgets", owner: { login: "Acme" } },
    issue: {
      number: 7,
      title: "Fix the widget",
      state: "open",
      html_url: "https://github.com/Acme/widgets/pull/7",
      user: { login: "octocat", type: "User" },
      pull_request: { url: "https://api.github.com/repos/Acme/widgets/pulls/7", merged_at: null },
    },
    comment: { id: 9001, html_url: "https://github.com/Acme/widgets/pull/7#issuecomment-9001", body: "/bounty 5", user: { login: "maintainer-1", type: "User" } },
  };

  it("reads a new comment on a pull request", () => {
    expect(readPullRequestComment(payload)).toEqual(comment("/bounty 5"));
  });

  it("reads a merged pull request as merged, and a bot as a bot", () => {
    const merged = { ...payload, issue: { ...payload.issue, state: "closed", pull_request: { ...payload.issue.pull_request, merged_at: "2026-10-04T05:00:00Z" } } };
    expect(readPullRequestComment(merged)?.pull).toMatchObject({ open: false, merged: true });
    const byBot = { ...payload, issue: { ...payload.issue, user: { login: "dependabot[bot]", type: "Bot" } } };
    expect(readPullRequestComment(byBot)?.pull).toMatchObject({ author: "dependabot[bot]", authorIsBot: true });
  });

  it("is null for an issue, an edited comment, or a delivery without what it needs", () => {
    expect(readPullRequestComment({ ...payload, issue: { ...payload.issue, pull_request: undefined } })).toBeNull();
    expect(readPullRequestComment({ ...payload, action: "edited" })).toBeNull();
    expect(readPullRequestComment({ ...payload, installation: undefined })).toBeNull();
    expect(readPullRequestComment(null)).toBeNull();
  });
});

describe("handlePullRequestComment: /bounty", () => {
  it("attaches the bounty: a contractor for the author, a milestone for the pull request, the record and the ledger, and a reply (B5–B8, B10, B11)", async () => {
    const { run, replies, bountyWrites } = world();
    const outcome = await run(comment("Great work!\n/bounty 5"));

    expect(outcome).toEqual({ kind: "replied", result: "attached" });
    expect(mocks.memberActor).toHaveBeenCalledWith(ORG, MEMBER, { kind: "github", installationId: INSTALLATION, login: "maintainer-1" });
    expect(mocks.createCounterparty).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: MEMBER,
        via: "github",
        github: { installationId: INSTALLATION, login: "maintainer-1" },
        counterparty: expect.objectContaining({ name: "octocat (GitHub)", role: "contractor", address: null, chain: "ARC-TESTNET", paymentLimit: "5" }),
      })
    );
    expect(mocks.addMilestone).toHaveBeenCalledWith(ACTOR, {
      milestone: { contractorId: COUNTERPARTY, title: "PR #7: Fix the widget", amount: "5", evidence: "https://github.com/Acme/widgets/pull/7" },
    });

    // Claimed first with the pull request and the comment, then given its counterparty and milestone.
    const [claim, filled] = bountyWrites();
    expect(claim.method).toBe("POST");
    expect(claim.body).toMatchObject({
      org_id: ORG, installation_id: INSTALLATION, repository: "acme/widgets", pull_number: 7, pull_url: "https://github.com/Acme/widgets/pull/7",
      author_login: "octocat", amount: "5", attached_by_login: "maintainer-1", comment_id: 9001,
    });
    expect(claim.body).not.toHaveProperty("milestone_id");
    expect(filled.method).toBe("PATCH");
    expect(filled.body).toEqual({ counterparty_id: COUNTERPARTY, milestone_id: MILESTONE });

    expect(mocks.appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "human",
        domain: "contractor",
        action: "github_bounty_attached",
        detail: expect.objectContaining({ by: MEMBER, via: "github", installationId: INSTALLATION, login: "maintainer-1", amount: 5, milestoneId: MILESTONE, counterpartyId: COUNTERPARTY }),
      })
    );
    const [reply] = replies();
    expect(reply).toContain("**Bounty: 5.00 USDC on Arc testnet**");
    expect(reply).toContain("@octocat");
    expect(reply).toContain("/payto");
  });

  it("pays a contributor it already knows as the same counterparty, and says the address on file is used (B7)", async () => {
    const { run, replies } = world({
      bounties: [{ id: "earlier", author_login: "Octocat", counterparty_id: COUNTERPARTY, comment_id: 1 }],
      counterpartyAddress: ADDRESS,
    });
    await run(comment("/bounty 2.5 USDC"));
    expect(mocks.createCounterparty).not.toHaveBeenCalled();
    expect(mocks.addMilestone).toHaveBeenCalledWith(ACTOR, expect.objectContaining({ milestone: expect.objectContaining({ contractorId: COUNTERPARTY, amount: "2.5" }) }));
    expect(replies()[0]).toContain("the address Northstar");
    expect(replies()[0]).not.toContain("/payto");
  });

  it("refuses someone who cannot write to the repository, and adds nothing (B4)", async () => {
    const { run, replies, bountyWrites } = world({ permission: "read" });
    expect(await run(comment("/bounty 5", { author: "drive-by" }))).toEqual({ kind: "replied", result: "refused" });
    expect(replies()[0]).toContain("Only someone who can write to this repository");
    expect(bountyWrites()).toHaveLength(0);
    expect(mocks.addMilestone).not.toHaveBeenCalled();
  });

  it("says nothing where no workspace connected the installation, and asks GitHub nothing (B3)", async () => {
    const { run, github } = world({ installations: [] });
    expect(await run(comment("/bounty 5"))).toEqual({ kind: "ignored" });
    expect(github).toHaveLength(0);
  });

  it("refuses where two workspaces connected the installation (B3)", async () => {
    const { run, replies } = world({ installations: [{ org_id: ORG, connected_by: MEMBER }, { org_id: OTHER_ORG, connected_by: MEMBER }] });
    expect(await run(comment("/bounty 5"))).toEqual({ kind: "replied", result: "refused" });
    expect(replies()[0]).toContain("more than one Vestiarion workspace");
  });

  it.each([
    ["a bot's pull request", { pull: { author: "dependabot[bot]", authorIsBot: true } }, "opened by a bot"],
    ["a pull request closed without merging", { pull: { open: false, merged: false } }, "closed without being merged"],
  ])("refuses %s (B7, B8)", async (_label, fields, words) => {
    const { run, replies } = world();
    await run(comment("/bounty 5", fields));
    expect(replies()[0]).toContain(words);
    expect(mocks.addMilestone).not.toHaveBeenCalled();
  });

  it("attaches to a merged pull request, and says it is paid at the agent's next run (B8)", async () => {
    const { run, replies } = world();
    await run(comment("/bounty 5", { pull: { open: false, merged: true } }));
    expect(mocks.addMilestone).toHaveBeenCalled();
    expect(replies()[0]).toContain("already merged");
  });

  it("names the bounty on file when the pull request has one, and adds nothing (B6)", async () => {
    const { run, replies } = world({ claim: "pull_key", bounties: [{ id: "on-file", amount: "5", comment_id: 1 }] });
    expect(await run(comment("/bounty 9"))).toEqual({ kind: "replied", result: "refused" });
    expect(replies()[0]).toContain("already has a bounty of 5.00 USDC");
    expect(mocks.addMilestone).not.toHaveBeenCalled();
  });

  it("does nothing twice for a comment GitHub delivers again (B6)", async () => {
    const { run, replies } = world({ bounties: [{ id: BOUNTY, comment_id: 9001, counterparty_id: COUNTERPARTY }] });
    expect(await run(comment("/bounty 5"))).toEqual({ kind: "duplicate" });
    expect(replies()).toHaveLength(0);
    expect(mocks.addMilestone).not.toHaveBeenCalled();
  });

  it("asks for GitHub to be connected again when the member who connected it can no longer add work (B5)", async () => {
    mocks.memberActor.mockResolvedValue(null);
    const { run, replies, bountyWrites } = world();
    await run(comment("/bounty 5"));
    expect(replies()[0]).toContain("connects GitHub again");
    expect(bountyWrites()).toHaveLength(0);
  });

  it("removes its claim and says so when the milestone cannot be added", async () => {
    mocks.addMilestone.mockResolvedValue({ ok: false, code: "failed", message: "The milestone could not be added." });
    const { run, replies, bountyWrites } = world();
    await run(comment("/bounty 5"));
    expect(bountyWrites().map((sent) => sent.method)).toEqual(["POST", "DELETE"]);
    expect(replies()[0]).toContain("Nothing was attached");
  });

  it("shows the right form for a bounty it cannot read, to someone who can write (B1)", async () => {
    const { run, replies } = world();
    await run(comment("/bounty 0"));
    expect(replies()[0]).toContain("/bounty 25");
    await run(comment("/bounty lots"));
    expect(replies()[1]).toContain("/bounty 25");
  });

  it("ignores a bot's own comment", async () => {
    const { run, github } = world();
    expect(await run(comment("/bounty 5", { commentAuthorIsBot: true }))).toEqual({ kind: "ignored" });
    expect(github).toHaveLength(0);
  });
});

describe("handlePullRequestComment: /payto", () => {
  const onFile = [{ id: BOUNTY, author_login: "octocat", counterparty_id: COUNTERPARTY, amount: "5", comment_id: 1 }];

  it("takes the author's address as a change waiting for a member, emails the members, and replies (B9)", async () => {
    const { run, replies } = world({ bounties: onFile });
    expect(await run(comment(`/payto ${ADDRESS}`, { author: "OctoCat" }))).toEqual({ kind: "replied", result: "address" });
    expect(mocks.changeCounterpartyAddress).toHaveBeenCalledWith({
      github: { installationId: INSTALLATION, login: "OctoCat", commentUrl: "https://github.com/Acme/widgets/pull/7#issuecomment-9001" },
      counterpartyId: COUNTERPARTY,
      raw: ADDRESS,
    });
    expect(mocks.notifyPayeeAddress).toHaveBeenCalledWith({ orgId: ORG, orgName: "Northstar *Labs* @team", payeeName: "octocat (GitHub)", address: ADDRESS });
    expect(replies()[0]).toContain("0xabab");
    expect(replies()[0]).toContain("confirms new addresses before paying them");
  });

  it("refuses an address from anyone but the author (B9)", async () => {
    const { run, replies } = world({ bounties: onFile });
    await run(comment(`/payto ${ADDRESS}`, { author: "maintainer-1" }));
    expect(mocks.changeCounterpartyAddress).not.toHaveBeenCalled();
    expect(replies()[0]).toContain("Only @octocat");
  });

  it("says there is no bounty on a pull request without one (B9)", async () => {
    const { run, replies } = world({ bounties: [] });
    await run(comment(`/payto ${ADDRESS}`, { author: "octocat" }));
    expect(replies()[0]).toContain("no bounty on this pull request");
  });

  it("says when the address is already on file (B9)", async () => {
    const { CounterpartyAddressError } = await import("@/lib/counterparty-address");
    mocks.changeCounterpartyAddress.mockRejectedValue(new CounterpartyAddressError("unchanged"));
    const { run, replies } = world({ bounties: onFile });
    await run(comment(`/payto ${ADDRESS}`, { author: "octocat" }));
    expect(replies()[0]).toContain("already on file");
    expect(mocks.notifyPayeeAddress).not.toHaveBeenCalled();
  });

  it("shows the right form for an address it cannot read, to the author", async () => {
    const { run, replies } = world({ bounties: onFile });
    await run(comment("/payto my-wallet", { author: "octocat" }));
    expect(replies()[0]).toContain("0x followed by 40 hex characters");
  });
});

describe("bountyReply (B10)", () => {
  it("escapes the workspace's name, so it cannot link, mention or point at an issue", () => {
    const text = bountyReply({ kind: "attached", amount: "5", orgName: "Evil [link](https://x.test) @all #1", author: "octocat", merged: false, addressOnFile: false, origin: ORIGIN });
    expect(text).not.toContain("[link](https://x.test)");
    expect(text).toContain("\\@\u2060all");
    expect(text).toContain("\\#\u20601");
    expect(text).toContain("@octocat");
  });
});
