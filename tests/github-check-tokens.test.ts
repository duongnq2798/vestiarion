import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { refreshGitHubMilestones } from "@/lib/milestone-verification";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The GitHub check reads a pull request with the connected installation's token when there is one
 * (docs/superpowers/specs/2026-10-04-github-app-design.md G5), so a private repository's merged pull request verifies
 * its milestone; any other pull request is read with the deployment's own token, as before, and so is every one when
 * the app is not configured (G9).
 */

const { mocks } = vi.hoisted(() => ({
  mocks: { settings: vi.fn(), installations: vi.fn(), repoInstallation: vi.fn(), token: vi.fn(), verify: vi.fn(), ledger: vi.fn() },
}));
vi.mock("@/lib/github/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/settings")>()),
  githubAppSettingsFromEnv: mocks.settings,
}));
vi.mock("@/lib/github/installs", () => ({ githubInstallations: mocks.installations }));
vi.mock("@/lib/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/app")>()),
  repositoryInstallationId: mocks.repoInstallation,
  installationToken: mocks.token,
}));
vi.mock("@/lib/github-verification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github-verification")>()),
  verifyGitHubPullRequest: mocks.verify,
}));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: mocks.ledger }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a91";
const SETTINGS = { appId: "1234567", slug: "vestiarion-payments", clientId: "Iv23li", clientSecret: "s", privateKey: "unused: the calls are faked" };
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

function world(sources: string[]) {
  const rows = sources.map((source, i) => ({
    id: `0b6c1c9e-4a4f-4a7e-9b1e-0000000002${String(i).padStart(2, "0")}`,
    title: `Work ${i}`,
    verification_source: source,
    verification_method: "unverified",
    verification_status: "unverified",
    verified: false,
    status: "pending",
  }));
  const fake = fakeSupabase((sent: RecordedRequest) => (sent.path === "/rest/v1/milestones" && sent.method === "GET" ? { body: rows } : { body: [] }));
  return () => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => refreshGitHubMilestones());
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.settings.mockReturnValue(SETTINGS);
  mocks.installations.mockResolvedValue([
    { installationId: 42, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", connectedAt: "2026-10-04T08:00:00Z" },
  ]);
  mocks.repoInstallation.mockImplementation(async (_settings: unknown, owner: string) => (owner === "acme" ? 42 : 99));
  mocks.token.mockResolvedValue("ghs_installation");
  mocks.verify.mockImplementation(async (ref: { url: string }) => ({ status: "not_merged", ref, mergedAt: null, state: "open" }));
});

const tokenUsedFor = (url: string) => mocks.verify.mock.calls.find(([ref]) => ref.url === url)?.[1]?.token;

describe("refreshGitHubMilestones' token", () => {
  it("reads a pull request in a connected installation with that installation's token, once per installation", async () => {
    await world(["https://github.com/acme/private-app/pull/1", "https://github.com/acme/private-app/pull/2"])();
    expect(tokenUsedFor("https://github.com/acme/private-app/pull/1")).toBe("ghs_installation");
    expect(tokenUsedFor("https://github.com/acme/private-app/pull/2")).toBe("ghs_installation");
    expect(mocks.token).toHaveBeenCalledTimes(1);
    expect(mocks.repoInstallation).toHaveBeenCalledTimes(1);
  });

  it("reads any other pull request with the deployment's own token, as before", async () => {
    await world(["https://github.com/someone-else/lib/pull/9"])();
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(tokenUsedFor("https://github.com/someone-else/lib/pull/9")).toBeUndefined();
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("falls back to the deployment's token when GitHub cannot say which installation a repository has", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.repoInstallation.mockRejectedValue(new Error("GitHub answered HTTP 502 to a repository installation lookup"));
    await world(["https://github.com/acme/private-app/pull/1"])();
    expect(tokenUsedFor("https://github.com/acme/private-app/pull/1")).toBeUndefined();
    log.mockRestore();
  });

  it("reads no installation at all when the app is not configured, or the workspace connected none (G9)", async () => {
    mocks.settings.mockReturnValue(null);
    await world(["https://github.com/acme/private-app/pull/1"])();
    expect(mocks.installations).not.toHaveBeenCalled();
    expect(tokenUsedFor("https://github.com/acme/private-app/pull/1")).toBeUndefined();

    mocks.settings.mockReturnValue(SETTINGS);
    mocks.installations.mockResolvedValue([]);
    mocks.verify.mockClear();
    await world(["https://github.com/acme/private-app/pull/1"])();
    expect(mocks.repoInstallation).not.toHaveBeenCalled();
    expect(tokenUsedFor("https://github.com/acme/private-app/pull/1")).toBeUndefined();
  });
});
