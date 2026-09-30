import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { accountDeletionPlan, AccountDeletionError, deleteAccount } from "@/lib/platform/delete-account";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/platform/delete-account.ts` (spec §6, A2, A3) over a real
 * supabase-js client whose network is a small stateful fake: memberships, the
 * org rows, their accounts, `delete_org` (proven against Postgres in
 * `tests/delete-org-migration.test.ts`), and the auth admin API that deletes
 * the user. The cascades that follow the user's deletion are proven against
 * Postgres in `tests/delete-account-migration.test.ts`.
 */

const ME = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
const THIRD = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3";
const FOUNDING = "00000000-0000-4000-8000-000000000001";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

interface Org {
  id: string;
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  agent_paused_at: string | null;
  wallet_host: "own" | "hosted" | null;
}

interface Membership {
  org_id: string;
  user_id: string;
  role: "owner" | "admin" | "approver" | "viewer";
}

interface World {
  orgs: Org[];
  memberships: Membership[];
  wallets?: Record<string, number>;
  /** What `delete_org` raises for an org, as PostgREST reports it. */
  refuse?: Record<string, string>;
  /** The auth admin API answers with this error. */
  authError?: { status: number; message: string };
}

let counter = 0;
function org(slug: string, extra: Partial<Org> = {}): Org {
  counter += 1;
  return {
    id: extra.id ?? `6a1f0c2e-8c1b-4f7a-9e6d-${String(counter).padStart(12, "0")}`,
    slug, name: slug.replace(/-/g, " "), mode: "sandbox", agent_paused_at: null, wallet_host: null, ...extra,
  };
}

const eqOf = (request: RecordedRequest, column: string) => request.params.get(column)?.replace(/^eq\./, "") ?? null;
const inOf = (request: RecordedRequest, column: string) =>
  (request.params.get(column) ?? "").replace(/^in\.\(|\)$/g, "").split(",").map((id) => id.replace(/"/g, "")).filter(Boolean);

function one(request: RecordedRequest, rows: unknown[]): FakeReply {
  const asObject = request.headers.get("accept")?.includes("vnd.pgrst.object");
  if (asObject && rows.length === 0) return { status: 406, body: { code: "PGRST116", message: "no rows", details: null, hint: null } };
  return { body: asObject ? rows[0] : rows };
}

function world(state: World) {
  const deleted: string[] = [];
  const fake = fakeSupabase((request): FakeReply => {
    if (request.path === "/rest/v1/memberships" && request.method === "GET") {
      const user = eqOf(request, "user_id");
      if (user) {
        return {
          body: state.memberships
            .filter((row) => row.user_id === user)
            .map((row) => {
              const o = state.orgs.find((candidate) => candidate.id === row.org_id) as Org;
              return { org_id: row.org_id, role: row.role, orgs: { slug: o.slug, name: o.name } };
            }),
        };
      }
      const ids = inOf(request, "org_id");
      return { body: state.memberships.filter((row) => ids.includes(row.org_id)).map(({ org_id, user_id, role }) => ({ org_id, user_id, role })) };
    }
    if (request.path === "/rest/v1/orgs" && request.method === "GET") {
      const id = eqOf(request, "id");
      const row = state.orgs.find((candidate) => candidate.id === id);
      return one(request, row ? [{ ...row, ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null }] : []);
    }
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      const id = eqOf(request, "org_id") ?? "";
      return { body: Array.from({ length: state.wallets?.[id] ?? 0 }, (_, i) => ({ circle_wallet_id: `w${i}` })) };
    }
    if (request.path === "/rest/v1/rpc/delete_org") {
      const body = request.body as { p_org_id: string; p_by: string };
      const refusal = state.refuse?.[body.p_org_id];
      if (refusal) return { status: 400, body: { code: "P0001", message: refusal, details: null, hint: null } };
      deleted.push(body.p_org_id);
      state.orgs = state.orgs.filter((candidate) => candidate.id !== body.p_org_id);
      state.memberships = state.memberships.filter((row) => row.org_id !== body.p_org_id);
      return { body: null };
    }
    if (request.path.startsWith("/auth/v1/admin/users/") && request.method === "DELETE") {
      if (state.authError) return { status: state.authError.status, body: { code: state.authError.status, msg: state.authError.message } };
      return { body: { id: request.path.split("/").pop() } };
    }
    return { body: [] };
  });
  const run = <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  const authDeletes = () => fake.requests.filter((request) => request.path.startsWith("/auth/v1/admin/users/") && request.method === "DELETE");
  const deleteOrgCalls = () => fake.requests.filter((request) => request.path === "/rest/v1/rpc/delete_org").map((request) => request.body);
  return { run, deleted, authDeletes, deleteOrgCalls, requests: fake.requests };
}

describe("accountDeletionPlan (A2)", () => {
  it("puts a workspace where I am the only member in soleWorkspaces, with what its dialog needs", async () => {
    const solo = org("solo-co", { mode: "live", agent_paused_at: "2026-09-30T09:00:00Z", wallet_host: "hosted" });
    const { run } = world({ orgs: [solo], memberships: [{ org_id: solo.id, user_id: ME, role: "owner" }], wallets: { [solo.id]: 2 } });

    const plan = await run(() => accountDeletionPlan(ME));

    expect(plan).toEqual({
      blocked: [],
      soleWorkspaces: [{ slug: "solo-co", name: "solo co", live: true, paused: true, walletCount: 2, hosted: true }],
    });
  });

  it("blocks a workspace where I am the last owner and others are members", async () => {
    const team = org("team-co");
    const { run } = world({
      orgs: [team],
      memberships: [
        { org_id: team.id, user_id: ME, role: "owner" },
        { org_id: team.id, user_id: OTHER, role: "admin" },
      ],
    });

    expect(await run(() => accountDeletionPlan(ME))).toEqual({
      blocked: [{ slug: "team-co", name: "team co", reason: "has_other_members" }],
      soleWorkspaces: [],
    });
  });

  it("leaves a workspace with another owner alone: only my membership goes", async () => {
    const shared = org("shared-co");
    const { run } = world({
      orgs: [shared],
      memberships: [
        { org_id: shared.id, user_id: ME, role: "owner" },
        { org_id: shared.id, user_id: OTHER, role: "owner" },
      ],
    });

    expect(await run(() => accountDeletionPlan(ME))).toEqual({ blocked: [], soleWorkspaces: [] });
  });

  it("leaves a workspace where I am not an owner alone, even where nobody else is an owner", async () => {
    const theirs = org("theirs-co");
    const { run } = world({
      orgs: [theirs],
      memberships: [
        { org_id: theirs.id, user_id: ME, role: "viewer" },
        { org_id: theirs.id, user_id: OTHER, role: "owner" },
      ],
    });

    expect(await run(() => accountDeletionPlan(ME))).toEqual({ blocked: [], soleWorkspaces: [] });
  });

  it("blocks the founding workspace whenever I am its last owner, with or without other members", async () => {
    const founding = org("founding", { id: FOUNDING, mode: "live" });
    const alone = world({ orgs: [founding], memberships: [{ org_id: FOUNDING, user_id: ME, role: "owner" }] });
    expect(await alone.run(() => accountDeletionPlan(ME))).toEqual({
      blocked: [{ slug: "founding", name: "founding", reason: "founding" }],
      soleWorkspaces: [],
    });

    const withTeam = world({
      orgs: [{ ...founding }],
      memberships: [
        { org_id: FOUNDING, user_id: ME, role: "owner" },
        { org_id: FOUNDING, user_id: OTHER, role: "viewer" },
      ],
    });
    expect((await withTeam.run(() => accountDeletionPlan(ME))).blocked).toEqual([{ slug: "founding", name: "founding", reason: "founding" }]);
  });

  it("does not block the founding workspace when it has another owner", async () => {
    const founding = org("founding", { id: FOUNDING, mode: "live" });
    const { run } = world({
      orgs: [founding],
      memberships: [
        { org_id: FOUNDING, user_id: ME, role: "owner" },
        { org_id: FOUNDING, user_id: OTHER, role: "owner" },
      ],
    });
    expect(await run(() => accountDeletionPlan(ME))).toEqual({ blocked: [], soleWorkspaces: [] });
  });

  it("sorts each list by name, across a mix of every case", async () => {
    const b = org("b-solo");
    const a = org("a-solo");
    const team = org("team-co");
    const shared = org("shared-co");
    const { run } = world({
      orgs: [b, a, team, shared],
      memberships: [
        { org_id: b.id, user_id: ME, role: "owner" },
        { org_id: a.id, user_id: ME, role: "owner" },
        { org_id: team.id, user_id: ME, role: "owner" },
        { org_id: team.id, user_id: THIRD, role: "viewer" },
        { org_id: shared.id, user_id: ME, role: "owner" },
        { org_id: shared.id, user_id: OTHER, role: "owner" },
      ],
    });

    const plan = await run(() => accountDeletionPlan(ME));

    expect(plan.soleWorkspaces.map((workspace) => workspace.slug)).toEqual(["a-solo", "b-solo"]);
    expect(plan.blocked.map((workspace) => workspace.slug)).toEqual(["team-co"]);
  });

  it("is empty for someone with no workspace", async () => {
    const { run } = world({ orgs: [], memberships: [] });
    expect(await run(() => accountDeletionPlan(ME))).toEqual({ blocked: [], soleWorkspaces: [] });
  });
});

describe("deleteAccount (A3)", () => {
  it.each([["", ""], ["different words", "delete account"], ["capitals", "Delete my account"], ["spaces", " delete my account "]])(
    "refuses a confirmation with %s, touching nothing",
    async (_label, confirmText) => {
      const solo = org("confirm-co");
      const { run, authDeletes, deleteOrgCalls } = world({ orgs: [solo], memberships: [{ org_id: solo.id, user_id: ME, role: "owner" }] });

      const attempt = run(() => deleteAccount({ userId: ME, confirmText }));

      await expect(attempt).rejects.toThrow(AccountDeletionError);
      await expect(attempt).rejects.toThrow("Type delete my account exactly to confirm.");
      expect(deleteOrgCalls()).toEqual([]);
      expect(authDeletes()).toEqual([]);
    }
  );

  it("refuses while any workspace is blocked, touching nothing", async () => {
    const solo = org("blocked-solo-co");
    const team = org("blocked-team-co");
    const { run, authDeletes, deleteOrgCalls } = world({
      orgs: [solo, team],
      memberships: [
        { org_id: solo.id, user_id: ME, role: "owner" },
        { org_id: team.id, user_id: ME, role: "owner" },
        { org_id: team.id, user_id: OTHER, role: "approver" },
      ],
    });

    await expect(run(() => deleteAccount({ userId: ME, confirmText: "delete my account" }))).rejects.toThrow(
      "Make someone else an owner of each workspace listed, or delete it, first."
    );
    expect(deleteOrgCalls()).toEqual([]);
    expect(authDeletes()).toEqual([]);
  });

  it("refuses when I am the founding workspace's last owner", async () => {
    const founding = org("founding", { id: FOUNDING, mode: "live" });
    const { run, authDeletes } = world({ orgs: [founding], memberships: [{ org_id: FOUNDING, user_id: ME, role: "owner" }] });

    await expect(run(() => deleteAccount({ userId: ME, confirmText: "delete my account" }))).rejects.toThrow(AccountDeletionError);
    expect(authDeletes()).toEqual([]);
  });

  it("deletes every sole workspace, as me, then the auth user", async () => {
    const one1 = org("first-co");
    const two = org("second-co");
    const shared = org("kept-co");
    const { run, authDeletes, deleteOrgCalls } = world({
      orgs: [one1, two, shared],
      memberships: [
        { org_id: one1.id, user_id: ME, role: "owner" },
        { org_id: two.id, user_id: ME, role: "owner" },
        { org_id: shared.id, user_id: ME, role: "owner" },
        { org_id: shared.id, user_id: OTHER, role: "owner" },
      ],
    });

    await run(() => deleteAccount({ userId: ME, confirmText: "delete my account" }));

    expect(deleteOrgCalls()).toEqual([
      { p_org_id: one1.id, p_by: ME },
      { p_org_id: two.id, p_by: ME },
    ]);
    expect(authDeletes().map((request) => request.path)).toEqual([`/auth/v1/admin/users/${ME}`]);
    // A hard delete: the row goes, so 0023's cascades run.
    expect(authDeletes()[0].body).toMatchObject({ should_soft_delete: false });
  });

  it("deletes the auth user of someone with no workspace", async () => {
    const { run, authDeletes } = world({ orgs: [], memberships: [] });
    await run(() => deleteAccount({ userId: ME, confirmText: "delete my account" }));
    expect(authDeletes()).toHaveLength(1);
  });

  it.each([
    ["pause_first: x", "Pause the agent first, so no cycle runs while the workspace is deleted."],
    ["cycle_running: x", "A cycle started in the last 15 minutes has not finished; try again shortly."],
    ["payment_in_progress: x", "A payment is being made; try again in a few minutes."],
  ])("stops at the first refusal (%s), names the workspace, and keeps the account", async (raised, message) => {
    const first = org("a-first-co");
    const refused = org("b-refused-co");
    const never = org("c-never-co");
    const { run, authDeletes, deleteOrgCalls } = world({
      orgs: [first, refused, never],
      memberships: [
        { org_id: first.id, user_id: ME, role: "owner" },
        { org_id: refused.id, user_id: ME, role: "owner" },
        { org_id: never.id, user_id: ME, role: "owner" },
      ],
      refuse: { [refused.id]: raised },
    });

    const error = await run(() => deleteAccount({ userId: ME, confirmText: "delete my account" })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AccountDeletionError);
    // The workspace already deleted is named, so the person knows it is gone.
    expect((error as Error).message).toBe(`Deleted: a-first-co. b-refused-co: ${message} Your account was not deleted.`);
    expect(deleteOrgCalls().map((call) => (call as { p_org_id: string }).p_org_id)).toEqual([first.id, refused.id]);
    expect(authDeletes()).toEqual([]);
  });

  it("refuses up front, before deleting anything, when a sole workspace is live with its agent running", async () => {
    const quiet = org("a-quiet-co");
    const running = org("b-running-co", { mode: "live" });
    const { run, authDeletes, deleteOrgCalls } = world({
      orgs: [quiet, running],
      memberships: [
        { org_id: quiet.id, user_id: ME, role: "owner" },
        { org_id: running.id, user_id: ME, role: "owner" },
      ],
    });

    await expect(run(() => deleteAccount({ userId: ME, confirmText: "delete my account" }))).rejects.toThrow(
      "b-running-co: Pause the agent first, so no cycle runs while the workspace is deleted. Your account was not deleted."
    );
    expect(deleteOrgCalls()).toEqual([]);
    expect(authDeletes()).toEqual([]);
  });

  it("passes an unknown database error through as a plain Error, keeping the account", async () => {
    const solo = org("broken-co");
    const { run, authDeletes } = world({
      orgs: [solo],
      memberships: [{ org_id: solo.id, user_id: ME, role: "owner" }],
      refuse: { [solo.id]: "deadlock detected" },
    });

    const error = await run(() => deleteAccount({ userId: ME, confirmText: "delete my account" })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AccountDeletionError);
    expect(authDeletes()).toEqual([]);
  });

  it("names no deleted workspace when the first one refuses", async () => {
    const refused = org("only-refused-co");
    const { run } = world({
      orgs: [refused],
      memberships: [{ org_id: refused.id, user_id: ME, role: "owner" }],
      refuse: { [refused.id]: "cycle_running: x" },
    });

    await expect(run(() => deleteAccount({ userId: ME, confirmText: "delete my account" }))).rejects.toThrow(
      /^only-refused-co: A cycle started in the last 15 minutes has not finished; try again shortly\. Your account was not deleted\.$/
    );
  });

  it("says the workspaces were deleted but the account was not, when the auth admin API refuses after deleting some", async () => {
    const solo = org("gone-co");
    const { run, deleted } = world({
      orgs: [solo],
      memberships: [{ org_id: solo.id, user_id: ME, role: "owner" }],
      authError: { status: 500, message: "Database error deleting user" },
    });

    const error = await run(() => deleteAccount({ userId: ME, confirmText: "delete my account" })).catch((caught: unknown) => caught);

    expect(deleted).toEqual([solo.id]);
    expect(error).toBeInstanceOf(AccountDeletionError);
    expect((error as AccountDeletionError).code).toBe("auth_failed");
    expect((error as Error).message).toBe("Your workspaces were deleted, but your account was not; try again.");
  });

  it("throws a plain Error when the auth admin API refuses and no workspace was deleted", async () => {
    const { run } = world({ orgs: [], memberships: [], authError: { status: 500, message: "Database error deleting user" } });

    const error = await run(() => deleteAccount({ userId: ME, confirmText: "delete my account" })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AccountDeletionError);
  });
});
