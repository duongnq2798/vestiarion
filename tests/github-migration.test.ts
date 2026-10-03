import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0071 (docs/superpowers/specs/2026-10-04-github-app-design.md G3, G4, G6): the installations a workspace
 * connected, closed to every role but the service role, and the comment a paid pull request got.
 */

let db: PGlite;
let orgA: string;
let orgB: string;
let user: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  orgA = await createOrg(db, "github-a");
  orgB = await createOrg(db, "github-b");
  user = await createUser(db, "github-owner@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const insert = (orgId: string, fields: Partial<Record<string, unknown>> = {}) => {
  const row = { installation_id: 42, account_login: "acme", account_type: "Organization", repository_selection: "selected", connected_by: user, ...fields };
  return asServiceRole(db, (tx) =>
    tx.query(
      "insert into public.github_installations (org_id, installation_id, account_login, account_type, repository_selection, connected_by) values ($1, $2, $3, $4, $5, $6)",
      [orgId, row.installation_id, row.account_login, row.account_type, row.repository_selection, row.connected_by]
    )
  );
};

describe("github_installations", () => {
  it("keeps one row per workspace and installation, and lets two workspaces connect the same installation (G3)", async () => {
    await insert(orgA);
    await expect(insert(orgA)).rejects.toThrow(/github_installations_org_installation_key/);
    await insert(orgB);
    const rows = await asServiceRole(db, (tx) => tx.query<{ n: number }>("select count(*)::int as n from public.github_installations where installation_id = 42"));
    expect(rows.rows[0].n).toBe(2);
  });

  it.each([
    ["an installation id that is not positive", { installation_id: 0 }, /installation_id_check/],
    ["a login GitHub would not give", { installation_id: 43, account_login: "-acme" }, /account_login_check/],
    ["an account type GitHub does not have", { installation_id: 44, account_type: "Team" }, /account_type_check/],
    ["a selection GitHub does not have", { installation_id: 45, repository_selection: "some" }, /repository_selection_check/],
  ])("refuses %s", async (_label, fields, error) => {
    await expect(insert(orgA, fields)).rejects.toThrow(error);
  });

  it("is closed to the browser roles and to the tenant: only the service role reads it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.github_installations"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query("select * from public.github_installations"))).rejects.toThrow(/permission denied/);
  });

  it("goes with its workspace", async () => {
    const orgC = await createOrg(db, "github-c");
    await insert(orgC, { installation_id: 46 });
    await asServiceRole(db, (tx) => tx.query("delete from public.orgs where id = $1", [orgC]));
    const left = await asServiceRole(db, (tx) => tx.query("select 1 from public.github_installations where installation_id = 46"));
    expect(left.rows).toHaveLength(0);
  });
});

describe("payment_intents' pull request comment", () => {
  it("has the claim and the link, and keeps only a GitHub link", async () => {
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'payment_intents' and column_name like 'pr_comment%' order by column_name"
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(["pr_comment_at", "pr_comment_url"]);
    const check = await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'payment_intents_pr_comment_url_check'"
    );
    expect(check.rows[0].def).toContain("https://github");
  });
});

describe("the migration file", () => {
  it("runs again over itself", async () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, "0071_github.sql"), "utf8");
    await expect(db.exec(sql)).resolves.toBeDefined();
  });
});
