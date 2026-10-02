import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0061 (docs/superpowers/specs/2026-10-03-sole-approver-design.md): `sole_approver` answers whether a
 * person is the only member of a workspace who may approve payments, and `claim_invoice_decision` lets that
 * person approve a payable they entered. Anyone with a second approver beside them keeps 0025's separation.
 */

let db: PGlite;
let soloOwner: string, viewer: string;
let teamOwner: string, teamApprover: string;
let soloOrg: string, teamOrg: string;
let soloCounterparty: string, teamCounterparty: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  soloOwner = await createUser(db, "solo-owner@example.com");
  viewer = await createUser(db, "viewer@example.com");
  teamOwner = await createUser(db, "team-owner@example.com");
  teamApprover = await createUser(db, "team-approver@example.com");

  // One person who can approve, and a viewer who cannot.
  soloOrg = await createOrg(db, "solo-co");
  await member(soloOrg, soloOwner, "owner");
  await member(soloOrg, viewer, "viewer");
  soloCounterparty = (await seedOrgRows(db, soloOrg, "solo")).counterpartyId;

  // Two people who can approve.
  teamOrg = await createOrg(db, "team-co");
  await member(teamOrg, teamOwner, "owner");
  await member(teamOrg, teamApprover, "approver");
  teamCounterparty = (await seedOrgRows(db, teamOrg, "team")).counterpartyId;
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function member(orgId: string, userId: string, role: string) {
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, userId, role]);
}

const sole = (tokenOrg: string | null, orgId: string, userId: string) =>
  asTenant(db, tokenOrg, async (tx) =>
    (await tx.query<{ sole: boolean }>("select public.sole_approver($1, $2) as sole", [orgId, userId])).rows[0].sole);

async function heldInvoice(orgId: string, counterpartyId: string, createdBy: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, created_by)
     values ($1, 'payable', $2, 1, now(), 'held', $3) returning id`,
    [orgId, counterpartyId, createdBy]
  );
  return result.rows[0].id;
}

const claim = (orgId: string, actor: string, invoiceId: string, decision: string) =>
  asTenant(db, orgId, async (tx) =>
    (await tx.query<Record<string, unknown>>("select * from public.claim_invoice_decision($1, $2, $3, $4)", [orgId, invoiceId, actor, decision])).rows[0]);

const statusOf = async (invoiceId: string) =>
  (await db.query<{ status: string; reviewed_by: string | null }>("select status, reviewed_by from public.invoices where id = $1", [invoiceId])).rows[0];

describe("sole_approver", () => {
  it("is true for the only member who may approve, a viewer beside them notwithstanding", async () => {
    expect(await sole(soloOrg, soloOrg, soloOwner)).toBe(true);
  });

  it("is false for a viewer, and for someone who is not a member", async () => {
    expect(await sole(soloOrg, soloOrg, viewer)).toBe(false);
    expect(await sole(soloOrg, soloOrg, teamOwner)).toBe(false);
  });

  it("is false for each of two people who may approve", async () => {
    expect(await sole(teamOrg, teamOrg, teamOwner)).toBe(false);
    expect(await sole(teamOrg, teamOrg, teamApprover)).toBe(false);
  });

  it("answers only about the organization the token names", async () => {
    expect(await sole(teamOrg, soloOrg, soloOwner)).toBe(false);
  });

  it("turns false once a second approver joins, and true again once they leave", async () => {
    const second = await createUser(db, "second@example.com");
    await member(soloOrg, second, "admin");
    expect(await sole(soloOrg, soloOrg, soloOwner)).toBe(false);
    await db.query("delete from public.memberships where org_id = $1 and user_id = $2", [soloOrg, second]);
    expect(await sole(soloOrg, soloOrg, soloOwner)).toBe(true);
  });

  it("is a definer function with an empty search path, executable by the tenant and service roles only", async () => {
    const fn = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      "select prosecdef, proconfig from pg_catalog.pg_proc where oid = 'public.sole_approver(uuid, uuid)'::regprocedure"
    );
    expect(fn.rows[0].prosecdef).toBe(true);
    expect(fn.rows[0].proconfig).toContain('search_path=""');

    const privileges = await db.query<{ anon: boolean; authed: boolean; tenant: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'public.sole_approver(uuid,uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.sole_approver(uuid,uuid)', 'execute') as authed,
              has_function_privilege('vestiarion_tenant', 'public.sole_approver(uuid,uuid)', 'execute') as tenant,
              has_function_privilege('service_role', 'public.sole_approver(uuid,uuid)', 'execute') as service`
    );
    expect(privileges.rows[0]).toEqual({ anon: false, authed: false, tenant: true, service: true });
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.sole_approver($1, $2)", [soloOrg, soloOwner]))).rejects.toThrow(
      /permission denied/
    );
  });
});

describe("claim_invoice_decision with a sole approver", () => {
  it("lets the sole approver approve a payable they entered", async () => {
    const id = await heldInvoice(soloOrg, soloCounterparty, soloOwner);
    const row = await claim(soloOrg, soloOwner, id, "approve");
    expect(row).toMatchObject({ id, status: "processing", reviewed_by: soloOwner });
  });

  it("still refuses the creator's approval where a second person may approve", async () => {
    const id = await heldInvoice(teamOrg, teamCounterparty, teamOwner);
    await expect(claim(teamOrg, teamOwner, id, "approve")).rejects.toThrow(/self_approval/);
    expect(await statusOf(id)).toEqual({ status: "held", reviewed_by: null });
    // The other approver still may.
    expect(await claim(teamOrg, teamApprover, id, "approve")).toMatchObject({ status: "processing", reviewed_by: teamApprover });
  });

  it("still lets the creator reject or return, and refuses a second claim while fresh", async () => {
    const id = await heldInvoice(teamOrg, teamCounterparty, teamOwner);
    expect(await claim(teamOrg, teamOwner, id, "return")).toMatchObject({ status: "processing" });
    await expect(claim(teamOrg, teamApprover, id, "approve")).rejects.toThrow(/already_decided/);
  });

  it("keeps one overload", async () => {
    const overloads = await db.query<{ n: number }>("select count(*)::int as n from pg_catalog.pg_proc where proname = 'claim_invoice_decision'");
    expect(overloads.rows[0].n).toBe(1);
  });

  it("replays without error and keeps the exception", async () => {
    await applyMigrations(db);
    const id = await heldInvoice(soloOrg, soloCounterparty, soloOwner);
    expect(await claim(soloOrg, soloOwner, id, "approve")).toMatchObject({ status: "processing", reviewed_by: soloOwner });
  });
});
