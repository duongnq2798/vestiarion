import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0120 (docs/superpowers/specs/2026-10-14-capability-and-reasons-design.md R9-R14): the reasons people give,
 * optionally, when they go against the agent. One row per reason, naming where in the product it came from, the
 * surface, the subject, the build that asked and who gave it; read and written only by its own workspace and never
 * changed or deleted there; and the team's cross-workspace list for the founder dashboard, for the service role only.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0120_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const reason = (
  orgId: string,
  userId: string | null,
  values: Partial<{ feature: string; decision: string; surface: string; subject: string; reason: string; app_version: string }> = {}
) =>
  db.query(
    `insert into public.decision_reasons (org_id, feature, decision, surface, subject, subject_id, reason, app_version, given_by)
     values ($1, $2, $3, $4, $5, gen_random_uuid(), $6, $7, $8)`,
    [
      orgId,
      values.feature ?? "approvals",
      values.decision ?? "reject",
      values.surface ?? "console",
      values.subject ?? "invoice",
      values.reason ?? "The supplier sent it twice.",
      values.app_version ?? "abc1234def56",
      userId,
    ]
  );

describe("decision_reasons (0120)", () => {
  it("keeps a reason with where it came from, the surface, the build and when", async () => {
    const orgId = await createOrg(db, "reasons-one");
    const userId = await createUser(db, "reasons-one@example.com");
    await reason(orgId, userId, { feature: "shadow_mode", decision: "disagree", reason: "The amount is wrong." });
    const rows = (
      await db.query<{ feature: string; decision: string; surface: string; app_version: string; given_at: Date }>(
        "select feature, decision, surface, app_version, given_at from public.decision_reasons where org_id = $1",
        [orgId]
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: "shadow_mode", decision: "disagree", surface: "console", app_version: "abc1234def56" });
    expect(rows[0].given_at).toBeInstanceOf(Date);
  });

  it("takes only the features, decisions, surfaces and subjects the app knows, and a reason of 1 to 280 characters", async () => {
    const orgId = await createOrg(db, "reasons-known");
    const userId = await createUser(db, "reasons-known@example.com");
    for (const surface of ["console", "slack", "telegram", "api", "github"]) await reason(orgId, userId, { surface });
    for (const decision of ["disagree", "reject", "return", "pay_held"]) await reason(orgId, userId, { decision });
    await reason(orgId, userId, { subject: "milestone" });
    await expect(reason(orgId, userId, { feature: "settings" })).rejects.toThrow(/decision_reasons_feature_check/);
    await expect(reason(orgId, userId, { decision: "dismiss" })).rejects.toThrow(/decision_reasons_decision_check/);
    await expect(reason(orgId, userId, { decision: "approve" })).rejects.toThrow(/decision_reasons_decision_check/);
    await expect(reason(orgId, userId, { surface: "email" })).rejects.toThrow(/decision_reasons_surface_check/);
    await expect(reason(orgId, userId, { subject: "deal" })).rejects.toThrow(/decision_reasons_subject_check/);
    await expect(reason(orgId, userId, { reason: "" })).rejects.toThrow(/decision_reasons_reason_check/);
    await expect(reason(orgId, userId, { reason: "x".repeat(281) })).rejects.toThrow(/decision_reasons_reason_check/);
    await expect(reason(orgId, userId, { app_version: "" })).rejects.toThrow(/decision_reasons_app_version_check/);
  });

  it("goes with its workspace, and stays, unnamed, when the person's account goes", async () => {
    const orgId = await createOrg(db, "reasons-cascade");
    const kept = await createOrg(db, "reasons-cascade-kept");
    const userId = await createUser(db, "reasons-cascade@example.com");
    await reason(orgId, userId);
    await reason(kept, userId);
    await db.query("delete from public.orgs where id = $1", [orgId]);
    expect((await db.query("select 1 from public.decision_reasons where org_id = $1", [orgId])).rows).toHaveLength(0);
    await db.query("delete from auth.users where id = $1", [userId]);
    const left = (await db.query<{ given_by: string | null }>("select given_by from public.decision_reasons where org_id = $1", [kept])).rows;
    expect(left).toEqual([{ given_by: null }]);
  });

  it("is seen and written only by its own workspace, and never changed or deleted there", async () => {
    const mine = await createOrg(db, "reasons-tenant-a");
    const theirs = await createOrg(db, "reasons-tenant-b");
    const userId = await createUser(db, "reasons-tenant@example.com");
    await reason(mine, userId, { reason: "mine" });
    await reason(theirs, userId, { reason: "theirs" });

    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ reason: string }>("select reason from public.decision_reasons")).rows);
    expect(seen).toEqual([{ reason: "mine" }]);
    const inserted = await asTenant(db, mine, async (tx) =>
      (
        await tx.query<{ reason: string }>(
          `insert into public.decision_reasons (org_id, feature, decision, surface, subject, reason, app_version, given_by)
           values ($1, 'approvals', 'return', 'slack', 'invoice', 'Waiting on the PO.', 'v0.1.0', $2) returning reason`,
          [mine, userId]
        )
      ).rows
    );
    expect(inserted).toEqual([{ reason: "Waiting on the PO." }]);

    await expect(
      asTenant(db, mine, (tx) =>
        tx.query(
          `insert into public.decision_reasons (org_id, feature, decision, surface, subject, reason, app_version)
           values ($1, 'approvals', 'reject', 'console', 'invoice', 'x', 'v0.1.0')`,
          [theirs]
        )
      )
    ).rejects.toThrow();
    await expect(asTenant(db, mine, (tx) => tx.query("update public.decision_reasons set reason = 'changed'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine, (tx) => tx.query("delete from public.decision_reasons"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, null, async (tx) => (await tx.query("select 1 from public.decision_reasons")).rows)).resolves.toEqual([]);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select 1 from public.decision_reasons"))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("growth_decision_reasons (0120)", () => {
  type Listed = { slug: string; side: string; feature: string; decision: string; surface: string; reason: string; appVersion: string; givenAt: string };
  const list = async (since: string | null) =>
    (await asServiceRole(db, (tx) => tx.query<{ r: Listed[] }>("select public.growth_decision_reasons($1::timestamptz) as r", [since]))).rows[0].r;

  it("lists the latest reasons across workspaces, newest first, with no person", async () => {
    const first = await createOrg(db, "reasons-growth-a");
    const second = await createOrg(db, "reasons-growth-b");
    const userId = await createUser(db, "reasons-growth@example.com");
    await db.query(
      `insert into public.decision_reasons (org_id, feature, decision, surface, subject, reason, app_version, given_by, given_at)
       values ($1, 'approvals', 'pay_held', 'console', 'invoice', 'Known supplier.', 'v0.1.0', $3, now() - interval '2 hours'),
              ($2, 'shadow_mode', 'disagree', 'console', 'invoice', 'Wrong amount.', 'abc1234def56', $3, now() - interval '1 hour')`,
      [first, second, userId]
    );
    const listed = (await list(null)).filter((row) => row.slug.startsWith("reasons-growth-"));
    expect(listed.map((row) => [row.slug, row.feature, row.decision, row.reason, row.appVersion])).toEqual([
      ["reasons-growth-b", "shadow_mode", "disagree", "Wrong amount.", "abc1234def56"],
      ["reasons-growth-a", "approvals", "pay_held", "Known supplier.", "v0.1.0"],
    ]);
    expect(listed.every((row) => row.side === "ours" || row.side === "customers")).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(userId);
    const recent = (await list(new Date(Date.now() - 90 * 60_000).toISOString())).filter((row) => row.slug.startsWith("reasons-growth-"));
    expect(recent.map((row) => row.slug)).toEqual(["reasons-growth-b"]);
  });

  it("runs for the service role only, as a definer with an empty search path", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.growth_decision_reasons(null)"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, null, (tx) => tx.query("select public.growth_decision_reasons(null)"))).rejects.toThrow(/permission denied/);
    const definer = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      "select prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname = 'growth_decision_reasons'"
    );
    expect(definer.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
  });
});
