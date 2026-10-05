import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { pullRequestCommentBody, sendPullRequestComments } from "@/lib/github/payment-comments";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * A comment on the pull request a milestone was paid for (docs/superpowers/specs/2026-10-04-github-app-design.md G4):
 * once its payment is confirmed with a transaction, within three days and after the workspace connected GitHub, only
 * in a repository whose installation the workspace connected, once (claimed first, released if posting fails), with
 * the amount, the network, the paying workspace and the transaction, and never the payee.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: { repoInstallation: vi.fn(), token: vi.fn(), comment: vi.fn(), ledger: vi.fn(), installations: vi.fn() },
}));
vi.mock("@/lib/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/app")>()),
  repositoryInstallationId: mocks.repoInstallation,
  installationToken: mocks.token,
  createPullRequestComment: mocks.comment,
}));
vi.mock("@/lib/github/installs", () => ({ githubInstallations: mocks.installations }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a71";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b1";
const INTENT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001c1";
const TX = `0x${"9c".repeat(32)}`;
const NOW = Date.parse("2026-10-04T10:00:00Z");
const SETTINGS = { appId: "1234567", slug: "vestiarion-payments", clientId: "Iv23li", clientSecret: "s", privateKey: "unused: the calls are faked" };
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const PR = "https://github.com/acme/app/pull/42";

interface World {
  intents?: Array<Record<string, unknown>>;
  milestones?: Array<Record<string, unknown>>;
  claimed?: boolean;
  orgName?: string;
}

function world(options: World = {}) {
  const intents = options.intents ?? [
    { id: INTENT, source_id: MILESTONE, amount: "0.100000", token: "USDC", tx_hash: TX, chain: "ARC-TESTNET", confirmed_at: "2026-10-04T09:30:00Z", payout_route: null },
  ];
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: { name: options.orgName ?? "testnet-2" } };
    if (sent.path === "/rest/v1/payment_intents" && sent.method === "GET") return { body: intents };
    if (sent.path === "/rest/v1/payment_intents" && sent.method === "PATCH") {
      const body = sent.body as Record<string, unknown>;
      if ("pr_comment_at" in body && body.pr_comment_at !== null) return { body: options.claimed === false ? [] : [{ id: INTENT }] };
      return { body: [{ id: INTENT }] };
    }
    if (sent.path === "/rest/v1/milestones") {
      return { body: options.milestones ?? [{ id: MILESTONE, title: "TypeScript SDK for the API", verification_source: PR }] };
    }
    return { body: [] };
  });
  const run = () => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => sendPullRequestComments({ settings: SETTINGS, now: NOW, origin: "https://www.vestiarion.xyz" }));
  const patches = () => fake.requests.filter((sent) => sent.path === "/rest/v1/payment_intents" && sent.method === "PATCH").map((sent) => sent.body as Record<string, unknown>);
  return { fake, run, patches };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.installations.mockResolvedValue([
    { installationId: 42, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", connectedAt: "2026-10-04T08:00:00Z" },
  ]);
  mocks.repoInstallation.mockResolvedValue(42);
  mocks.token.mockResolvedValue("ghs_installation");
  mocks.comment.mockResolvedValue({ id: 7, url: `${PR}#issuecomment-7` });
});

describe("sendPullRequestComments", () => {
  it("comments once on the pull request a confirmed milestone payment was for, as the installation, and records it", async () => {
    const { fake, run, patches } = world();
    const lines = await run();

    expect(mocks.repoInstallation).toHaveBeenCalledWith(SETTINGS, "acme", "app", expect.anything());
    expect(mocks.token).toHaveBeenCalledWith(SETTINGS, 42, expect.anything());
    const [token, ref, body] = mocks.comment.mock.calls[0];
    expect(token).toBe("ghs_installation");
    expect(ref).toEqual({ owner: "acme", repo: "app", number: 42, url: PR });
    expect(body).toBe(pullRequestCommentBody({ amount: "0.10", token: "USDC", orgName: "testnet-2", txHash: TX, origin: "https://www.vestiarion.xyz", network: "arc-testnet" }));
    // Claimed first, and its link kept once posted.
    expect(patches()[0]).toEqual({ pr_comment_at: new Date(NOW).toISOString() });
    expect(patches()[1]).toEqual({ pr_comment_url: `${PR}#issuecomment-7` });
    const claim = fake.requests.find((sent) => sent.method === "PATCH")!;
    expect(claim.params.get("pr_comment_at")).toBe("is.null");
    expect(mocks.ledger).toHaveBeenCalledWith(ORG, {
      actor: "system",
      domain: "contractor",
      action: "pull_request_commented",
      summary: "Said on acme/app#42 that 0.10 USDC was paid",
      detail: { milestoneId: MILESTONE, pullRequest: PR, commentUrl: `${PR}#issuecomment-7`, amount: 0.1, token: "USDC", txHash: TX },
    });
    expect(lines).toEqual([{ domain: "contractor", message: "Commented on acme/app#42: 0.10 USDC paid" }]);
  });

  it("reads only confirmed live milestone payments, not yet commented, since the later of three days ago and the first connection", async () => {
    const { fake, run } = world();
    await run();
    const read = fake.requests.find((sent) => sent.path === "/rest/v1/payment_intents" && sent.method === "GET")!;
    expect(read.params.get("source_type")).toBe("eq.milestone");
    expect(read.params.get("status")).toBe("eq.confirmed");
    expect(read.params.get("provider_mode")).toBe("eq.live");
    expect(read.params.get("pr_comment_at")).toBe("is.null");
    // Connected at 08:00 today, later than three days ago: nothing paid before the connection is commented.
    expect(read.params.get("confirmed_at")).toBe("gte.2026-10-04T08:00:00.000Z");
  });

  it("posts nothing when another run already claimed the payment (Review focus 3)", async () => {
    const { run } = world({ claimed: false });
    expect(await run()).toEqual([]);
    expect(mocks.comment).not.toHaveBeenCalled();
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("never comments on a repository whose installation the workspace did not connect (Review focus 2)", async () => {
    mocks.repoInstallation.mockResolvedValue(99);
    const { run, patches } = world();
    expect(await run()).toEqual([]);
    expect(patches()).toEqual([]);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.comment).not.toHaveBeenCalled();

    mocks.repoInstallation.mockResolvedValue(null);
    expect(await world().run()).toEqual([]);
    expect(mocks.comment).not.toHaveBeenCalled();
  });

  it("releases the claim when posting fails, so the next cycle tries again, and records nothing (Review focus 4)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.comment.mockRejectedValue(new Error("GitHub answered HTTP 403 to a pull request comment"));
    const { run, patches } = world();
    const lines = await run();
    expect(patches()).toEqual([{ pr_comment_at: new Date(NOW).toISOString() }, { pr_comment_at: null }]);
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(lines).toEqual([
      { domain: "contractor", message: "Comment on acme/app#42 not posted (GitHub answered HTTP 403 to a pull request comment); tried again at the next cycle" },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("ghs_installation");
    log.mockRestore();
  });

  it("skips a milestone whose evidence is not a pull request, a payment without a transaction, and one paid on another chain", async () => {
    const other = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b2";
    const { run } = world({
      intents: [
        { id: INTENT, source_id: MILESTONE, amount: "1", token: "USDC", tx_hash: "sim-receipt-1", chain: "ARC-TESTNET", confirmed_at: "2026-10-04T09:30:00Z", payout_route: null },
        { id: "i2", source_id: other, amount: "1", token: "USDC", tx_hash: TX, chain: "ARC-TESTNET", confirmed_at: "2026-10-04T09:31:00Z", payout_route: null },
        { id: "i3", source_id: MILESTONE, amount: "1", token: "USDC", tx_hash: TX, chain: "BASE-SEPOLIA", confirmed_at: "2026-10-04T09:32:00Z", payout_route: "cctp" },
      ],
      milestones: [
        { id: MILESTONE, title: "A", verification_source: PR },
        { id: other, title: "B", verification_source: "https://www.canva.com/design/x" },
      ],
    });
    expect(await run()).toEqual([]);
    expect(mocks.comment).not.toHaveBeenCalled();
  });

  it("does nothing without the app, or before the workspace connects GitHub, and reads no payment then (G9)", async () => {
    const off = world();
    expect(await runWith(orgTestContext({ config, client: off.fake.client, orgId: ORG }), () => sendPullRequestComments({ settings: null, now: NOW }))).toEqual([]);
    expect(off.fake.requests).toEqual([]);

    mocks.installations.mockResolvedValue([]);
    const unconnected = world();
    expect(await unconnected.run()).toEqual([]);
    expect(unconnected.fake.requests.some((sent) => sent.path === "/rest/v1/payment_intents")).toBe(false);
  });
});

describe("pullRequestCommentBody", () => {
  it("says the amount, the network, who paid and the transaction, and never the payee", () => {
    const body = pullRequestCommentBody({ amount: "0.10", token: "USDC", orgName: "testnet-2", txHash: TX, origin: "https://www.vestiarion.xyz", network: "arc-testnet" });
    expect(body).toContain("0.10 USDC on Arc testnet");
    expect(body).toContain("testnet\\-2");
    expect(body).toContain(`https://explorer.testnet.arc.io/tx/${TX}`);
    expect(body).toContain("https://www.vestiarion.xyz");
  });

  it("keeps a workspace's name from becoming a link, a mention or HTML", () => {
    const body = pullRequestCommentBody({ amount: "1.00", token: "USDC", orgName: "[x](https://evil.example) @team <b>", txHash: TX, origin: "https://www.vestiarion.xyz", network: "arc-testnet" });
    expect(body).toContain("\\[x\\]\\(https\\:\\/\\/evil\\.example\\) \\@\u2060team \\<b\\>");
    expect(body).not.toContain("[x](https://evil.example)");
  });

  it("keeps a workspace's name from mentioning anyone or pointing at an issue: GitHub finds both in the rendered text", () => {
    const body = pullRequestCommentBody({ amount: "1.00", token: "USDC", orgName: "Team #42 @acme", txHash: TX, origin: "https://www.vestiarion.xyz", network: "arc-testnet" });
    expect(body).toContain("\\#\u206042");
    expect(body).toContain("\\@\u2060acme");
    expect(body).not.toMatch(/@acme|#42/);
  });
});
