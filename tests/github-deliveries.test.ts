import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as webhookRoute } from "@/app/api/github/webhook/route";
import { handleGitHubDelivery } from "@/lib/github/deliveries";
import type { GitHubAppSettings } from "@/lib/github/settings";

/**
 * The app's webhook (docs/superpowers/specs/2026-10-04-github-bounties-design.md B2): off without its secret, closed to
 * anything GitHub did not sign, quiet for every event but a new pull request comment with a command, and answered at
 * once with the work done after the response.
 */

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/github/bounties", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/bounties")>()),
  handlePullRequestComment: handleMock,
}));

const SECRET = "a-webhook-secret-for-tests";
const settings = { appId: "1", slug: "vestiarion-payments", clientId: "c", clientSecret: "s", privateKey: "k" } as GitHubAppSettings;

const payload = (body: string) => ({
  action: "created",
  installation: { id: 42 },
  repository: { name: "widgets", owner: { login: "Acme" } },
  issue: {
    number: 7,
    title: "Fix the widget",
    state: "open",
    html_url: "https://github.com/Acme/widgets/pull/7",
    user: { login: "octocat", type: "User" },
    pull_request: { merged_at: null },
  },
  comment: { id: 9001, html_url: "https://github.com/Acme/widgets/pull/7#issuecomment-9001", body, user: { login: "maintainer-1", type: "User" } },
});

function delivery(body: unknown, options: { event?: string; secret?: string; signature?: string | null } = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = options.signature === undefined ? `sha256=${crypto.createHmac("sha256", options.secret ?? SECRET).update(raw).digest("hex")}` : options.signature;
  const headers = new Headers({ "content-type": "application/json", "x-github-event": options.event ?? "issue_comment" });
  if (signature !== null) headers.set("x-hub-signature-256", signature);
  return new Request("https://www.vestiarion.xyz/api/github/webhook", { method: "POST", headers, body: raw });
}

function deps() {
  const deferred: Array<() => Promise<void>> = [];
  return { deferred, value: { settings, secret: SECRET, origin: "https://www.vestiarion.xyz", defer: (work: () => Promise<void>) => void deferred.push(work) } };
}

beforeEach(() => {
  handleMock.mockReset();
  handleMock.mockResolvedValue({ kind: "replied", result: "attached" });
});

describe("handleGitHubDelivery (B2)", () => {
  it("answers a signed comment with a command at once, and handles it after the response", async () => {
    const { deferred, value } = deps();
    const response = await handleGitHubDelivery(delivery(payload("/bounty 5")), value);
    expect(response.status).toBe(202);
    expect(handleMock).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await deferred[0]();
    expect(handleMock).toHaveBeenCalledWith(expect.objectContaining({ installationId: 42, pull: expect.objectContaining({ number: 7 }) }), {
      settings,
      origin: "https://www.vestiarion.xyz",
    });
  });

  it("refuses a delivery without GitHub's signature, or with another secret's, and reads nothing", async () => {
    for (const request of [delivery(payload("/bounty 5"), { signature: null }), delivery(payload("/bounty 5"), { secret: "another-secret" })]) {
      const { deferred, value } = deps();
      const response = await handleGitHubDelivery(request, value);
      expect(response.status).toBe(401);
      expect(deferred).toHaveLength(0);
    }
  });

  it("is quiet for GitHub's ping, any other event, a comment with no command, and a comment on an issue", async () => {
    const issue = { ...payload("/bounty 5"), issue: { ...payload("/bounty 5").issue, pull_request: undefined } };
    for (const request of [
      delivery({ zen: "Keep it logically awesome." }, { event: "ping" }),
      delivery(payload("/bounty 5"), { event: "pull_request" }),
      delivery(payload("Looks good to me")),
      delivery(issue),
    ]) {
      const { deferred, value } = deps();
      const response = await handleGitHubDelivery(request, value);
      expect(response.status).toBe(204);
      expect(deferred).toHaveLength(0);
    }
  });

  it("refuses a signed body that is not JSON", async () => {
    const { value } = deps();
    expect((await handleGitHubDelivery(delivery("not json"), value)).status).toBe(400);
  });

  it("keeps a failure in its deferred work to the log", async () => {
    handleMock.mockRejectedValue(new Error("database unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deferred, value } = deps();
    await handleGitHubDelivery(delivery(payload("/payto 0x19801dAA8a1d6B3a3E3d3E4bA6e9cC4f2aA0b5c1")), value);
    await expect(deferred[0]()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("POST /api/github/webhook", () => {
  it("is not there unless the app and its webhook secret are configured", async () => {
    const saved = process.env.GITHUB_APP_WEBHOOK_SECRET;
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    try {
      const response = await webhookRoute(delivery(payload("/bounty 5")));
      expect(response.status).toBe(404);
    } finally {
      if (saved !== undefined) process.env.GITHUB_APP_WEBHOOK_SECRET = saved;
    }
  });
});
