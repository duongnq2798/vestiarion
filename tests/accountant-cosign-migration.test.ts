import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0138 (docs/superpowers/specs/2026-10-22-accountant-cosign-design.md CS1, CS4, CS5): co-signing off by
 * default; an accountant counted by approvers_among and cosigners_besides only while it is on, in their own workspace
 * only; and the database's claim taking an owner's approval of a bill they entered when an accountant co-signed it.
 */

let db: PGlite;
let org: string, other: string;
let owner: string, accountant: string, viewer: string;
let invoice: string;

const one = async (sql: string, params: unknown[]) => ((await db.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;
const setting = (orgId: string, on: boolean) =>
  db.query("insert into public.approval_policies (org_id, accountant_cosigns) values ($1, $2) on conflict (org_id) do update set accountant_cosigns = $2", [orgId, on]);
const among = (orgId: string, users: string[]) =>
  asTenant(db, orgId, (tx) => tx.query<{ approvers_among: string[] }>("select public.approvers_among($1, $2::uuid[])", [org, users])).then(
    (result) => [...result.rows[0].approvers_among].sort()
  );
const cosigners = (orgId: string, excluded: string[] = []) =>
  asTenant(db, orgId, (tx) => tx.query<{ cosigners_besides: number }>("select public.cosigners_besides($1, $2::uuid[])", [org, excluded])).then(
    (result) => result.rows[0].cosigners_besides
  );
const claim = (actor: string) =>
  asTenant(db, org, (tx) => tx.query<{ status: string }>("select status from public.claim_invoice_decision($1, $2, $3, 'approve')", [org, invoice, actor]));

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  org = await createOrg(db, "cosign-co");
  other = await createOrg(db, "cosign-other");
  owner = await createUser(db, "cosign-owner@example.com");
  accountant = await createUser(db, "cosign-accountant@example.com");
  viewer = await createUser(db, "cosign-viewer@example.com");
  for (const [user, role] of [[owner, "owner"], [accountant, "accountant"], [viewer, "viewer"]] as const) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [org, user, role]);
  }
  const vendor = await one("insert into public.counterparties (org_id, name, role) values ($1, 'Northstar Studio', 'vendor') returning id", [org]);
  invoice = await one(
    "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, created_by) values ($1, 'payable', $2, 900, now(), 'held', $3) returning id",
    [org, vendor, owner]
  );
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("approval_policies' accountant_cosigns", () => {
  it("is off for a workspace that never set it, and then counts no accountant", async () => {
    await db.query("insert into public.approval_policies (org_id) values ($1) on conflict (org_id) do nothing", [org]);
    const rows = await db.query<{ accountant_cosigns: boolean }>("select accountant_cosigns from public.approval_policies where org_id = $1", [org]);
    expect(rows.rows[0].accountant_cosigns).toBe(false);
    expect(await among(org, [owner, accountant, viewer])).toEqual([owner]);
    expect(await cosigners(org)).toBe(0);
  });

  it("counts the workspace's accountants while it is on, never a viewer, and leaves out those named", async () => {
    await setting(org, true);
    expect(await among(org, [owner, accountant, viewer])).toEqual([owner, accountant].sort());
    expect(await cosigners(org)).toBe(1);
    expect(await cosigners(org, [accountant])).toBe(0);
    await setting(org, false);
    expect(await among(org, [accountant])).toEqual([]);
  });

  it("answers for the caller's own workspace only", async () => {
    await setting(org, true);
    expect(await among(other, [owner, accountant])).toEqual([]);
    expect(await cosigners(other)).toBe(0);
  });

  it("lets an owner's approval of a bill they entered be claimed only while an accountant's co-sign of it counts", async () => {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'approver')", [org, await createUser(db, "cosign-approver@example.com")]);
    await db.query(
      "insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency) values ($1, 'invoice', $2, $3, 900, 'USDC')",
      [org, invoice, accountant]
    );
    await setting(org, false);
    await expect(claim(owner)).rejects.toThrow(/self_approval/);
    await setting(org, true);
    expect((await claim(owner)).rows[0].status).toBe("processing");
  });

  it("runs again without error or change", async () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/0138_accountant_cosign.sql"), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    const rows = await db.query<{ accountant_cosigns: boolean }>("select accountant_cosigns from public.approval_policies where org_id = $1", [org]);
    expect(rows.rows[0].accountant_cosigns).toBe(true);
  });
});
