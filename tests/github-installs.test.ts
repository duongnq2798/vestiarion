import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { githubInstallations, removeInstallation, saveInstallation } from "@/lib/github/installs";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The installations a workspace connected (docs/superpowers/specs/2026-10-04-github-app-design.md G2, G3, G6): saved
 * once per workspace and installation, listed for Settings and the cycle, removed from Vestiarion, and every change in
 * the ledger with ids and the account's login only.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f3";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const INSTALLATION = { id: 42, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected" as const };

function world(reply: (sent: RecordedRequest) => FakeReply = () => ({ body: [] })) {
  const fake = fakeSupabase(reply);
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run };
}

beforeEach(() => ledgerMock.mockReset());

/**
 * As PostgREST answers a write: the rows only when the request selected some, and otherwise a 201 with no body, which
 * supabase-js reads as `data: null`.
 */
const postgrest = (sent: RecordedRequest): FakeReply =>
  sent.params.get("select") ? { status: 201, body: [{ installation_id: 42 }] } : { status: 201, body: null };

describe("saveInstallation", () => {
  it("keeps one row per workspace and installation, as the person who connected it, and records it", async () => {
    const { fake, run } = world(postgrest);
    await run(() => saveInstallation({ orgId: ORG, connectedBy: USER, installation: INSTALLATION }));

    const upsert = fake.requests.find((sent) => sent.path === "/rest/v1/github_installations")!;
    expect(upsert.method).toBe("POST");
    expect(upsert.params.get("on_conflict")).toBe("org_id,installation_id");
    expect(upsert.headers.get("prefer")).toContain("resolution=merge-duplicates");
    expect(upsert.body).toMatchObject({
      org_id: ORG,
      installation_id: 42,
      account_login: "acme",
      account_type: "Organization",
      repository_selection: "selected",
      connected_by: USER,
    });
    expect(ledgerMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "github_connected",
      summary: "Connected GitHub: acme's installation of the app, for selected repositories",
      detail: { by: USER, installationId: 42, account: "acme", accountType: "Organization", repositorySelection: "selected" },
    });
  });
});

describe("githubInstallations", () => {
  it("lists the workspace's own, oldest first", async () => {
    const { fake, run } = world((sent) =>
      sent.path === "/rest/v1/github_installations"
        ? { body: [{ installation_id: 42, account_login: "acme", account_type: "Organization", repository_selection: "all", connected_at: "2026-10-04T08:00:00Z" }] }
        : { body: [] }
    );
    expect(await run(() => githubInstallations(ORG))).toEqual([
      { installationId: 42, accountLogin: "acme", accountType: "Organization", repositorySelection: "all", connectedAt: "2026-10-04T08:00:00Z" },
    ]);
    const read = fake.requests[0];
    expect(read.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(read.params.get("order")).toBe("connected_at.asc");
  });
});

describe("removeInstallation", () => {
  it("removes the workspace's link and records it", async () => {
    const { fake, run } = world((sent) => (sent.method === "DELETE" ? { body: [{ installation_id: 42, account_login: "acme" }] } : { body: [] }));
    expect(await run(() => removeInstallation({ orgId: ORG, actorId: USER, installationId: 42 }))).toBe(true);

    const removed = fake.requests.find((sent) => sent.method === "DELETE")!;
    expect(removed.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(removed.params.get("installation_id")).toBe("eq.42");
    expect(ledgerMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "github_disconnected",
      summary: "Disconnected GitHub: acme's installation of the app",
      detail: { by: USER, installationId: 42, account: "acme" },
    });
  });

  it("records nothing when the workspace had no such link", async () => {
    const { run } = world(() => ({ body: [] }));
    expect(await run(() => removeInstallation({ orgId: ORG, actorId: USER, installationId: 99 }))).toBe(false);
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});
