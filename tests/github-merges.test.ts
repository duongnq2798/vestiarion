import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { handlePullRequestMerged, readMergedPullRequest, type MergedPullRequest } from "@/lib/github/merges";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

/**
 * A merged pull request starts a cycle (docs/superpowers/specs/2026-10-04-github-bounties-design.md B13): every
 * workspace that connected the installation and has a milestone waiting on that pull request decides it within a
 * minute, instead of at the next scheduled cycle.
 */

const { cycleMock } = vi.hoisted(() => ({ cycleMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/cycle-soon")>()),
  runCycleSoon: cycleMock,
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d02";
const MEMBER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d3";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const MERGED: MergedPullRequest = { installationId: 42, owner: "Acme", repo: "widgets", number: 7, url: "https://github.com/Acme/widgets/pull/7" };

function world(input: { installations?: Array<{ org_id: string; connected_by: string | null }>; milestones?: Record<string, Array<{ verification_source: string | null }>> } = {}) {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") {
      const id = sent.params.get("id")?.replace("eq.", "") ?? ORG;
      return { body: orgs.orgRow(id, { mode: id === ORG ? "live" : "sandbox" }) };
    }
    if (sent.path === "/rest/v1/github_installations") return { body: input.installations ?? [{ org_id: ORG, connected_by: MEMBER }] };
    if (sent.path === "/rest/v1/milestones") {
      const scope = sent.headers.get("authorization") ?? "";
      const orgId = scope.includes(".") ? JSON.parse(Buffer.from(scope.split(".")[1], "base64url").toString()).org_id : ORG;
      return { body: (input.milestones ?? { [ORG]: [{ verification_source: "https://github.com/acme/widgets/pull/7" }] })[orgId] ?? [] };
    }
    return { body: [] };
  });
  return { fake, run: () => runWith({ config, db: fake.client, fetch: fake.fetch }, () => handlePullRequestMerged(MERGED)) };
}

beforeEach(() => {
  cycleMock.mockReset();
});

describe("readMergedPullRequest (B13)", () => {
  const payload = {
    action: "closed",
    installation: { id: 42 },
    repository: { name: "widgets", owner: { login: "Acme" } },
    pull_request: { number: 7, html_url: "https://github.com/Acme/widgets/pull/7", merged: true },
  };

  it("reads a pull request that was just merged", () => {
    expect(readMergedPullRequest(payload)).toEqual(MERGED);
  });

  it("is null for a pull request closed without merging, opened, or without what it needs", () => {
    expect(readMergedPullRequest({ ...payload, pull_request: { ...payload.pull_request, merged: false } })).toBeNull();
    expect(readMergedPullRequest({ ...payload, action: "opened" })).toBeNull();
    expect(readMergedPullRequest({ ...payload, installation: undefined })).toBeNull();
    expect(readMergedPullRequest(null)).toBeNull();
  });
});

describe("handlePullRequestMerged (B13)", () => {
  it("starts a cycle for a workspace with a milestone waiting on the pull request, as the member who connected GitHub", async () => {
    const { run } = world();
    expect(await run()).toEqual([ORG]);
    expect(cycleMock).toHaveBeenCalledWith({ orgId: ORG, userId: MEMBER, sandbox: false, kind: "pull_request_merged" });
  });

  // As the GitHub check reads it (parseGitHubPullRequestUrl): a link it cannot verify starts no cycle either.
  it("matches the pull request in any case, with a trailing slash or a query, as the GitHub check reads it", async () => {
    const { run } = world({ milestones: { [ORG]: [{ verification_source: "https://github.com/ACME/Widgets/pull/7/?notification_referrer_id=1" }] } });
    expect(await run()).toEqual([ORG]);
    const files = world({ milestones: { [ORG]: [{ verification_source: "https://github.com/acme/widgets/pull/7/files" }] } });
    expect(await files.run()).toEqual([]);
  });

  it("starts nothing where no milestone waits on this pull request, or none on GitHub at all", async () => {
    const { run } = world({
      milestones: { [ORG]: [{ verification_source: "https://github.com/acme/widgets/pull/70" }, { verification_source: "https://example.com/acme/widgets/pull/7" }, { verification_source: null }] },
    });
    expect(await run()).toEqual([]);
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("starts nothing where no workspace connected the installation, or its member is gone", async () => {
    expect(await world({ installations: [] }).run()).toEqual([]);
    expect(await world({ installations: [{ org_id: ORG, connected_by: null }] }).run()).toEqual([]);
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("starts one cycle per workspace that waits on it, a sandbox's as a sandbox's", async () => {
    const { run } = world({
      installations: [{ org_id: ORG, connected_by: MEMBER }, { org_id: OTHER_ORG, connected_by: MEMBER }],
      milestones: {
        [ORG]: [{ verification_source: "https://github.com/acme/widgets/pull/7" }],
        [OTHER_ORG]: [{ verification_source: "https://github.com/Acme/widgets/pull/7" }],
      },
    });
    expect((await run()).sort()).toEqual([ORG, OTHER_ORG].sort());
    expect(cycleMock).toHaveBeenCalledWith({ orgId: OTHER_ORG, userId: MEMBER, sandbox: true, kind: "pull_request_merged" });
  });
});
