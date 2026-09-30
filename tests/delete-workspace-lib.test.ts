import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { deleteWorkspace, DeleteWorkspaceError, deletionContext } from "@/lib/platform/delete-workspace";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/platform/delete-workspace.ts` over a real supabase-js client whose
 * network is a small fake PostgREST: the org row, its accounts, and the
 * `delete_org` RPC (proven against Postgres in
 * `tests/delete-org-migration.test.ts`), which here answers what it is told.
 */

const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-0000000000d1";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d7";
const FOUNDING = "00000000-0000-4000-8000-000000000001";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  agent_paused_at: string | null;
  wallet_host: "own" | "hosted" | null;
  ledger_signing_key_enc: null;
  circle_api_key_enc: null;
  circle_entity_secret_enc: null;
}

interface Setup {
  org?: Partial<OrgRow> | null;
  accounts?: Array<{ circle_wallet_id: string | null }>;
  /** What `delete_org` raises, as PostgREST reports it; nothing means it succeeds. */
  raise?: string;
}

function one(request: RecordedRequest, rows: unknown[]): FakeReply {
  const asObject = request.headers.get("accept")?.includes("vnd.pgrst.object");
  if (asObject && rows.length === 0) return { status: 406, body: { code: "PGRST116", message: "no rows", details: null, hint: null } };
  return { body: asObject ? rows[0] : rows };
}

function database(setup: Setup = {}) {
  const org: OrgRow | null = setup.org === null ? null : {
    id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", agent_paused_at: null, wallet_host: null,
    ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null,
    ...setup.org,
  };
  const fake = fakeSupabase((request): FakeReply => {
    if (request.path === "/rest/v1/orgs" && request.method === "GET") return one(request, org ? [org] : []);
    if (request.path === "/rest/v1/accounts" && request.method === "GET") return one(request, setup.accounts ?? []);
    if (request.path === "/rest/v1/rpc/delete_org") {
      if (setup.raise) return { status: 400, body: { code: "P0001", message: setup.raise, details: null, hint: null } };
      return { body: null };
    }
    return { body: [] };
  });
  const run = <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  const rpcCalls = () => fake.requests.filter((request) => request.path === "/rest/v1/rpc/delete_org");
  return { fake, run, rpcCalls };
}

describe("deleteWorkspace", () => {
  it("calls delete_org with the org and the person deleting it, once the slug matches", async () => {
    const { run, rpcCalls } = database();

    await run(() => deleteWorkspace({ orgId: ORG, actorId: ACTOR, confirmSlug: "northstar" }));

    expect(rpcCalls().map((request) => request.body)).toEqual([{ p_org_id: ORG, p_by: ACTOR }]);
  });

  it.each([
    ["a different slug", "southstar"],
    ["the name instead of the slug", "Northstar"],
    ["surrounding spaces", " northstar "],
    ["nothing", ""],
  ])("refuses %s without calling delete_org", async (_label, confirmSlug) => {
    const { run, rpcCalls } = database();

    const attempt = run(() => deleteWorkspace({ orgId: ORG, actorId: ACTOR, confirmSlug }));

    await expect(attempt).rejects.toThrow(DeleteWorkspaceError);
    await expect(attempt).rejects.toThrow("Type the workspace's name exactly to confirm.");
    expect(rpcCalls()).toHaveLength(0);
  });

  it("says the workspace no longer exists when its row is gone", async () => {
    const { run, rpcCalls } = database({ org: null });

    await expect(run(() => deleteWorkspace({ orgId: ORG, actorId: ACTOR, confirmSlug: "northstar" }))).rejects.toThrow(
      "This workspace no longer exists."
    );
    expect(rpcCalls()).toHaveLength(0);
  });

  it.each([
    ["founding_org: the founding workspace cannot be deleted", "founding_org", "The founding workspace cannot be deleted."],
    ["pause_first: northstar is live and its agent is running; pause it first", "pause_first", "Pause the agent first, so no cycle runs while the workspace is deleted."],
    ["cycle_running: a cycle of northstar is in progress", "cycle_running", "A cycle is running; try again in a minute."],
    ["org_not_found: no organization with id x", "org_not_found", "This workspace no longer exists."],
  ])("maps %s to its fixed message", async (raised, code, message) => {
    const { run } = database({ raise: raised });

    const error = await run(() => deleteWorkspace({ orgId: ORG, actorId: ACTOR, confirmSlug: "northstar" })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeleteWorkspaceError);
    expect((error as DeleteWorkspaceError).code).toBe(code);
    expect((error as DeleteWorkspaceError).message).toBe(message);
  });

  it("passes any other database error through as a plain Error, for the action to log by name", async () => {
    const { run } = database({ raise: "deadlock detected" });

    const error = await run(() => deleteWorkspace({ orgId: ORG, actorId: ACTOR, confirmSlug: "northstar" })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DeleteWorkspaceError);
  });
});

describe("deletionContext", () => {
  it("describes a sandbox with no wallets", async () => {
    const { run } = database();
    const context = await run(() => withOrg(ORG, () => deletionContext(ORG)));
    expect(context).toEqual({ slug: "northstar", isFounding: false, live: false, paused: false, walletCount: 0, hosted: false });
  });

  it("counts only accounts that have a wallet, and says a hosted workspace is hosted", async () => {
    const { run } = database({
      org: { wallet_host: "hosted" },
      accounts: [{ circle_wallet_id: "w1" }, { circle_wallet_id: null }, { circle_wallet_id: "w2" }],
    });
    const context = await run(() => withOrg(ORG, () => deletionContext(ORG)));
    expect(context).toMatchObject({ walletCount: 2, hosted: true });
  });

  it("describes a live workspace, paused or not", async () => {
    const running = database({ org: { mode: "live" } });
    expect(await running.run(() => withOrg(ORG, () => deletionContext(ORG)))).toMatchObject({ live: true, paused: false });

    const paused = database({ org: { mode: "live", agent_paused_at: "2026-09-30T09:00:00Z" } });
    expect(await paused.run(() => withOrg(ORG, () => deletionContext(ORG)))).toMatchObject({ live: true, paused: true });
  });

  it("marks the founding workspace", async () => {
    const { run } = database({ org: { id: FOUNDING, slug: "founding", mode: "live" } });
    const context = await run(() => withOrg(FOUNDING, () => deletionContext(FOUNDING)));
    expect(context).toMatchObject({ slug: "founding", isFounding: true });
  });

  it("carries counts and booleans only: no address, id or name", async () => {
    const { run } = database({ accounts: [{ circle_wallet_id: "w1" }] });
    const context = await run(() => withOrg(ORG, () => deletionContext(ORG)));
    expect(Object.keys(context).sort()).toEqual(["hosted", "isFounding", "live", "paused", "slug", "walletCount"]);
    expect(JSON.stringify(context)).not.toContain("w1");
  });
});
