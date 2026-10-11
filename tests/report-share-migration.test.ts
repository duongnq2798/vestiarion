import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0095 (docs/superpowers/specs/2026-10-10-shared-report-design.md S2, S5, S9, S12): a shared report's link,
 * kept only as the SHA-256 of its secret with what it shows, and revoked by setting `revoked_at` once; the owner's answers
 * about how bills were handled before, append-only; and the service role's lookup of a live link, which names the
 * workspace only when the share shows its name.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0095_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hashOf = (n: number) => n.toString(16).padStart(64, "0");

async function share(orgId: string, hash: string, fields: Partial<{ show_names: boolean; show_amounts: boolean; show_workspace_name: boolean; created_by: string | null }> = {}): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.report_shares (org_id, token_hash, show_names, show_amounts, show_workspace_name, created_by)
       values ($1, $2, coalesce($3, false), coalesce($4, true), coalesce($5, true), $6) returning id`,
      [orgId, hash, fields.show_names ?? null, fields.show_amounts ?? null, fields.show_workspace_name ?? null, fields.created_by ?? null]
    )
  ).rows[0].id;
}

const lookUp = (hash: string) =>
  asServiceRole(db, async (tx) => (await tx.query<{ found: Record<string, unknown> | null }>("select public.report_share_by_token($1) as found", [hash])).rows[0].found);

describe("report_shares (0095)", () => {
  it("keeps a link's hash and what it shows, names hidden and amounts and the workspace's name shown by default", async () => {
    const orgId = await createOrg(db, "share-defaults");
    await db.query("insert into public.report_shares (org_id, token_hash) values ($1, $2)", [orgId, hashOf(1)]);
    const row = (
      await db.query<{ show_names: boolean; show_amounts: boolean; show_workspace_name: boolean; created_at: Date; revoked_at: Date | null }>(
        "select show_names, show_amounts, show_workspace_name, created_at, revoked_at from public.report_shares where token_hash = $1",
        [hashOf(1)]
      )
    ).rows[0];
    expect(row).toMatchObject({ show_names: false, show_amounts: true, show_workspace_name: true, revoked_at: null });
    expect(row.created_at).not.toBeNull();
  });

  it("takes only a 64-character hex hash, once", async () => {
    const orgId = await createOrg(db, "share-hash");
    await share(orgId, hashOf(2));
    await expect(share(orgId, hashOf(2))).rejects.toThrow(/report_shares_token_hash_key/);
    await expect(share(orgId, "vxs_not-a-hash")).rejects.toThrow(/report_shares_token_hash_check/);
    await expect(share(orgId, "AB".repeat(32))).rejects.toThrow(/report_shares_token_hash_check/);
    await expect(share(orgId, "ab".repeat(31))).rejects.toThrow(/report_shares_token_hash_check/);
  });

  it("lets the tenant revoke its own link once, and change nothing else of it", async () => {
    const orgId = await createOrg(db, "share-revoke");
    const person = await createUser(db, "owner-share@example.com");
    const id = await share(orgId, hashOf(4));
    await asTenant(db, orgId, (tx) => tx.query("update public.report_shares set revoked_at = now(), revoked_by = $2 where id = $1", [id, person]));
    const revoked = (await db.query<{ revoked_at: Date | null; revoked_by: string }>("select revoked_at, revoked_by from public.report_shares where id = $1", [id])).rows[0];
    expect(revoked.revoked_at).not.toBeNull();
    expect(revoked.revoked_by).toBe(person);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.report_shares set revoked_at = null where id = $1", [id]))).rejects.toThrow(/report_share_revoked/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.report_shares set revoked_at = now() - interval '1 day' where id = $1", [id]))).rejects.toThrow(/report_share_revoked/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.report_shares set show_names = true where id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.report_shares set token_hash = $2 where id = $1", [id, hashOf(5)]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.report_shares where id = $1", [id]))).rejects.toThrow(/permission denied/);
  });

  it("is seen, made and revoked only by its own workspace", async () => {
    const mine = await createOrg(db, "share-tenant-a");
    const theirs = await createOrg(db, "share-tenant-b");
    await share(mine, hashOf(6));
    const theirLink = await share(theirs, hashOf(7));
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ token_hash: string }>("select token_hash from public.report_shares")).rows);
    expect(seen).toEqual([{ token_hash: hashOf(6) }]);
    await expect(asTenant(db, mine, (tx) => tx.query("insert into public.report_shares (org_id, token_hash) values ($1, $2)", [theirs, hashOf(8)]))).rejects.toThrow(/row-level security/);
    const made = await asTenant(db, mine, async (tx) => (await tx.query<{ id: string }>("insert into public.report_shares (org_id, token_hash, show_names) values ($1, $2, true) returning id", [mine, hashOf(9)])).rows);
    expect(made).toHaveLength(1);
    const revoked = await asTenant(db, mine, (tx) => tx.query("update public.report_shares set revoked_at = now() where id = $1", [theirLink]));
    expect(revoked.affectedRows ?? 0).toBe(0);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select 1 from public.report_shares"))).rejects.toThrow(/permission denied/);
    }
  });

  it("goes with its workspace", async () => {
    const orgId = await createOrg(db, "share-cascade");
    await share(orgId, hashOf(10));
    await db.query("delete from public.orgs where id = $1", [orgId]);
    expect((await db.query("select 1 from public.report_shares where token_hash = $1", [hashOf(10)])).rows).toHaveLength(0);
  });
});

describe("report_share_by_token (0095)", () => {
  it("returns a live link's share, workspace, mode, network and options, and the name only when shown", async () => {
    const orgId = await createOrg(db, "share-lookup");
    await db.query("update public.orgs set name = 'Harbor Books' where id = $1", [orgId]);
    const named = await share(orgId, hashOf(11), { show_names: true, show_amounts: false });
    const found = await lookUp(hashOf(11));
    expect(found).toMatchObject({
      shareId: named,
      orgId,
      name: "Harbor Books",
      mode: "sandbox",
      network: "arc-testnet",
      showNames: true,
      showAmounts: false,
      showWorkspaceName: true,
    });
    expect(typeof found?.createdAt).toBe("string");

    await share(orgId, hashOf(12), { show_workspace_name: false });
    expect(await lookUp(hashOf(12))).toMatchObject({ orgId, name: null, showWorkspaceName: false });
  });

  it("answers null for a revoked link, an unknown one, and one whose workspace is gone", async () => {
    const orgId = await createOrg(db, "share-dead");
    const id = await share(orgId, hashOf(13));
    await db.query("update public.report_shares set revoked_at = now() where id = $1", [id]);
    expect(await lookUp(hashOf(13))).toBeNull();
    expect(await lookUp(hashOf(14))).toBeNull();
    const gone = await createOrg(db, "share-gone");
    await share(gone, hashOf(15));
    await db.query("delete from public.orgs where id = $1", [gone]);
    expect(await lookUp(hashOf(15))).toBeNull();
  });

  it("is the service role's alone", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.report_share_by_token($1)", [hashOf(11)]))).rejects.toThrow(/permission denied/);
    }
    const orgId = await createOrg(db, "share-tenant-call");
    await expect(asTenant(db, orgId, (tx) => tx.query("select public.report_share_by_token($1)", [hashOf(11)]))).rejects.toThrow(/permission denied/);
  });
});

describe("report_baselines (0095)", () => {
  async function answer(orgId: string, minutes: number, people: number, by: string | null = null): Promise<string> {
    return (
      await db.query<{ id: string }>(
        "insert into public.report_baselines (org_id, minutes_per_bill, people_per_bill, answered_by) values ($1, $2, $3, $4) returning id",
        [orgId, minutes, people, by]
      )
    ).rows[0].id;
  }

  it("keeps each answer with who gave it and when, and every later answer beside it", async () => {
    const orgId = await createOrg(db, "baseline-history");
    const owner = await createUser(db, "owner-baseline@example.com");
    await answer(orgId, 25, 2, owner);
    await answer(orgId, 30, 3, owner);
    const rows = (await db.query<{ minutes_per_bill: number; people_per_bill: number; answered_by: string; answered_at: Date }>(
      "select minutes_per_bill, people_per_bill, answered_by, answered_at from public.report_baselines where org_id = $1 order by answered_at, minutes_per_bill",
      [orgId]
    )).rows;
    expect(rows.map((row) => [row.minutes_per_bill, row.people_per_bill, row.answered_by])).toEqual([
      [25, 2, owner],
      [30, 3, owner],
    ]);
    expect(rows[0].answered_at).not.toBeNull();
  });

  it("takes whole minutes from 1 to 6,000 and from 1 to 100 people", async () => {
    const orgId = await createOrg(db, "baseline-checks");
    await answer(orgId, 1, 1);
    await answer(orgId, 6000, 100);
    await expect(answer(orgId, 0, 1)).rejects.toThrow(/report_baselines_minutes_check/);
    await expect(answer(orgId, 6001, 1)).rejects.toThrow(/report_baselines_minutes_check/);
    await expect(answer(orgId, 10, 0)).rejects.toThrow(/report_baselines_people_check/);
    await expect(answer(orgId, 10, 101)).rejects.toThrow(/report_baselines_people_check/);
  });

  it("is seen and added to only by its own workspace, and never changed in place", async () => {
    const mine = await createOrg(db, "baseline-tenant-a");
    const theirs = await createOrg(db, "baseline-tenant-b");
    await answer(mine, 20, 2);
    await answer(theirs, 45, 4);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ minutes_per_bill: number }>("select minutes_per_bill from public.report_baselines")).rows);
    expect(seen).toEqual([{ minutes_per_bill: 20 }]);
    await expect(
      asTenant(db, mine, (tx) => tx.query("insert into public.report_baselines (org_id, minutes_per_bill, people_per_bill) values ($1, 5, 1)", [theirs]))
    ).rejects.toThrow(/row-level security/);
    const added = await asTenant(db, mine, async (tx) =>
      (await tx.query<{ id: string }>("insert into public.report_baselines (org_id, minutes_per_bill, people_per_bill) values ($1, 15, 1) returning id", [mine])).rows
    );
    expect(added).toHaveLength(1);
    await expect(asTenant(db, mine, (tx) => tx.query("update public.report_baselines set minutes_per_bill = 1"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine, (tx) => tx.query("delete from public.report_baselines"))).rejects.toThrow(/permission denied/);
  });
});
