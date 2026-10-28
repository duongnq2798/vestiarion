import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0146 (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11, AL21): a workspace's earned vendor
 * rule on its approval_policies row, none by default and from 5 to 50 when set, and the step 3 switch beside it, off by
 * default and never on without a rule; the workspace's own, and re-runnable.
 */

const FILE = path.join(process.cwd(), "supabase/migrations/0146_earned_vendors.sql");

let db: PGlite;
let org: string, other: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  org = await createOrg(db, "earned-vendors-co");
  other = await createOrg(db, "earned-vendors-other");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const read = async (orgId: string) =>
  (
    await db.query<{ earned_vendor_streak: number | null; earned_vendor_payments: boolean }>(
      "select earned_vendor_streak, earned_vendor_payments from public.approval_policies where org_id = $1",
      [orgId]
    )
  ).rows[0];

describe("approval_policies' earned vendor rule", () => {
  it("is no rule, with the switch off, for a workspace that never set it", async () => {
    await db.query("insert into public.approval_policies (org_id) values ($1) on conflict (org_id) do nothing", [org]);
    expect(await read(org)).toEqual({ earned_vendor_streak: null, earned_vendor_payments: false });
  });

  it("takes a rule from 5 to 50 and refuses any other, by its check's name", async () => {
    await db.query("update public.approval_policies set earned_vendor_streak = 5 where org_id = $1", [org]);
    await db.query("update public.approval_policies set earned_vendor_streak = 50 where org_id = $1", [org]);
    for (const bad of [4, 51, 0]) {
      await expect(db.query("update public.approval_policies set earned_vendor_streak = $2 where org_id = $1", [org, bad])).rejects.toThrow(
        /approval_policies_earned_vendor_streak_check/
      );
    }
    expect((await read(org)).earned_vendor_streak).toBe(50);
  });

  it("never has the switch on without a rule", async () => {
    await db.query("update public.approval_policies set earned_vendor_streak = 8, earned_vendor_payments = true where org_id = $1", [org]);
    await expect(db.query("update public.approval_policies set earned_vendor_streak = null where org_id = $1", [org])).rejects.toThrow(
      /approval_policies_earned_vendor_payments_check/
    );
    await expect(
      db.query("insert into public.approval_policies (org_id, earned_vendor_payments) values ($1, true) on conflict (org_id) do update set earned_vendor_payments = true", [other])
    ).rejects.toThrow(/approval_policies_earned_vendor_payments_check/);
    // Turning the rule off turns the switch off in the same write, as the app does.
    await db.query("update public.approval_policies set earned_vendor_streak = null, earned_vendor_payments = false where org_id = $1", [org]);
    expect(await read(org)).toEqual({ earned_vendor_streak: null, earned_vendor_payments: false });
  });

  it("is the workspace's own: the tenant role sees and changes only its own row", async () => {
    await db.query("insert into public.approval_policies (org_id, earned_vendor_streak) values ($1, 10) on conflict (org_id) do update set earned_vendor_streak = 10", [other]);
    const seen = await asTenant(db, org, (tx) => tx.query<{ org_id: string }>("select org_id from public.approval_policies"));
    expect(seen.rows.map((row) => row.org_id)).toEqual([org]);
    await asTenant(db, org, (tx) => tx.query("update public.approval_policies set earned_vendor_streak = 12"));
    expect((await read(org)).earned_vendor_streak).toBe(12);
    expect((await read(other)).earned_vendor_streak).toBe(10);
  });

  it("runs again without error or change", async () => {
    const sql = readFileSync(FILE, "utf8");
    await db.exec(sql);
    await db.exec(sql);
    expect((await read(org)).earned_vendor_streak).toBe(12);
    const checks = await db.query<{ conname: string }>(
      "select conname from pg_constraint where conrelid = 'public.approval_policies'::regclass and contype = 'c' and conname like 'approval_policies_earned_vendor%' order by conname"
    );
    expect(checks.rows.map((row) => row.conname)).toEqual(["approval_policies_earned_vendor_payments_check", "approval_policies_earned_vendor_streak_check"]);
  });
});

describe("0146's source", () => {
  const sql = () => readFileSync(FILE, "utf8");

  it("ends with a schema-reload notify, before its commented down section, so the first Settings save is not refused", () => {
    const withoutDown = sql().replace(/\n-- Down[\s\S]*$/, "").trimEnd();
    expect(withoutDown.endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(sql()).toMatch(/-- Down \(by hand, never by migrate\.ts\):/);
  });

  it("adds no table, function or index", () => {
    expect(sql()).not.toMatch(/create (?:or replace )?(?:table|function|view|index|unique index)/i);
  });
});
