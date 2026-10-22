import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0139 (docs/superpowers/specs/2026-10-22-screening-health-design.md SH3, SH4): the index a workspace's
 * newest live check is read from on every page, one for the team's read by time, and `screening_health()`, live
 * screening across workspaces for the team's /admin/screening: the last complete and the last failed live check, and
 * how many of each in 24 hours and 7 days. Live checks only, workspace slugs only, for the service role only.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0139_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

type Health = {
  lastComplete: { at: string; slug: string; source: string } | null;
  lastFailed: { at: string; slug: string; source: string; note: string | null } | null;
  day: { complete: number; failed: number };
  week: { complete: number; failed: number };
};

const health = async () => (await asServiceRole(db, (tx) => tx.query<{ h: Health }>("select public.screening_health() as h"))).rows[0].h;

async function counterparty(orgId: string, name: string): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, 'vendor') returning id", [orgId, name])).rows[0].id;
}

async function check(
  orgId: string,
  counterpartyId: string,
  values: { status: "complete" | "failed"; mode: "live" | "simulate"; hoursAgo: number; notes?: string; source?: string }
): Promise<void> {
  await db.query(
    `insert into public.compliance_checks (org_id, counterparty_id, risk_level, source, notes, screening_mode, status, created_at)
     values ($1, $2, 'clear', $3, $4, $5, $6, now() - make_interval(hours => $7))`,
    [orgId, counterpartyId, values.source ?? "opensanctions:yente", values.notes ?? null, values.mode, values.status, values.hoursAgo]
  );
}

describe("screening_health (0139)", () => {
  it("says none and zero before any live check, whatever the simulated ones", async () => {
    const sandbox = await createOrg(db, "health-sandbox");
    const cp = await counterparty(sandbox, "Bundled Co");
    await check(sandbox, cp, { status: "complete", mode: "simulate", hoursAgo: 1, source: "simulated-sanctions-list" });
    await check(sandbox, cp, { status: "failed", mode: "simulate", hoursAgo: 1, source: "simulated-sanctions-list", notes: "no service" });
    expect(await health()).toEqual({ lastComplete: null, lastFailed: null, day: { complete: 0, failed: 0 }, week: { complete: 0, failed: 0 } });
  });

  it("gives the last complete and last failed live checks across workspaces, and counts live ones in 24 hours and 7 days", async () => {
    const first = await createOrg(db, "health-first");
    const second = await createOrg(db, "health-second");
    const a = await counterparty(first, "Northwind Hosting");
    const b = await counterparty(second, "Lumen Print Co.");
    await check(first, a, { status: "complete", mode: "live", hoursAgo: 3 });
    await check(second, b, { status: "complete", mode: "live", hoursAgo: 2 });
    await check(second, b, { status: "complete", mode: "live", hoursAgo: 30 });
    await check(first, a, { status: "failed", mode: "live", hoursAgo: 5, notes: "OpenSanctions screening failed with HTTP 429" });
    await check(first, a, { status: "failed", mode: "live", hoursAgo: 1, notes: `OpenSanctions screening failed with HTTP 401 ${"x".repeat(200)}` });
    await check(second, b, { status: "failed", mode: "live", hoursAgo: 24 * 9, notes: "too old to count" });
    // A simulated check, newer than every live one, changes nothing.
    await check(second, b, { status: "complete", mode: "simulate", hoursAgo: 0, source: "simulated-sanctions-list" });

    const read = await health();
    expect(read.lastComplete).toMatchObject({ slug: "health-second", source: "opensanctions:yente" });
    expect(new Date(read.lastComplete!.at).getTime()).toBeGreaterThan(Date.now() - 2.5 * 3_600_000);
    expect(read.lastFailed).toMatchObject({ slug: "health-first", source: "opensanctions:yente" });
    expect(read.lastFailed!.note).toHaveLength(120);
    expect(read.lastFailed!.note!.startsWith("OpenSanctions screening failed with HTTP 401 ")).toBe(true);
    expect(read.day).toEqual({ complete: 2, failed: 2 });
    expect(read.week).toEqual({ complete: 3, failed: 2 });
    // No counterparty and no person: only the slug, the source, the note and the time.
    expect(JSON.stringify(read)).not.toMatch(/Northwind|Lumen/);
  });

  it("runs for the service role only, as a definer with an empty search path", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.screening_health()"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, null, (tx) => tx.query("select public.screening_health()"))).rejects.toThrow(/permission denied/);
    const definer = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      "select prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname = 'screening_health'"
    );
    expect(definer.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
  });
});

describe("the live-check indexes (0139)", () => {
  it("index live checks by workspace newest first, and by time, leaving simulated ones out", async () => {
    const indexes = (
      await db.query<{ indexname: string; indexdef: string }>(
        "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'compliance_checks' and indexname like 'compliance_checks_live_%' order by indexname"
      )
    ).rows;
    expect(indexes.map((index) => index.indexname)).toEqual(["compliance_checks_live_newest", "compliance_checks_live_recent"]);
    expect(indexes[0].indexdef).toMatch(/\(org_id, created_at DESC\) WHERE \(screening_mode = 'live'::text\)/);
    expect(indexes[1].indexdef).toMatch(/\(created_at DESC\) WHERE \(screening_mode = 'live'::text\)/);
  });

  it("leave a workspace reading only its own live checks", async () => {
    const mine = await createOrg(db, "health-tenant-mine");
    const theirs = await createOrg(db, "health-tenant-theirs");
    await check(mine, await counterparty(mine, "Mine Co"), { status: "complete", mode: "live", hoursAgo: 4 });
    await check(theirs, await counterparty(theirs, "Theirs Co"), { status: "failed", mode: "live", hoursAgo: 0 });
    const newest = await asTenant(db, mine, async (tx) =>
      (await tx.query<{ status: string }>("select status from public.compliance_checks where screening_mode = 'live' order by created_at desc limit 1")).rows
    );
    expect(newest).toEqual([{ status: "complete" }]);
  });
});
