import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0076 (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1, T4–T6): a workspace's figure above which
 * a payment needs two approvals, the approvals people gave, a count of the people a rule leaves to approve, and the
 * invoice claim that lets whoever entered a payable give its second approval.
 */

let db: PGlite;
let owner: string, approver: string, admin: string, viewer: string, outsider: string;
let org: string, other: string;
let counterpartyId: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "two-owner@example.com");
  approver = await createUser(db, "two-approver@example.com");
  admin = await createUser(db, "two-admin@example.com");
  viewer = await createUser(db, "two-viewer@example.com");
  outsider = await createUser(db, "two-outsider@example.com");
  org = await createOrg(db, "two-approvals-co");
  other = await createOrg(db, "two-approvals-other");
  await member(org, owner, "owner");
  await member(org, approver, "approver");
  await member(org, admin, "admin");
  await member(org, viewer, "viewer");
  await member(other, outsider, "owner");
  counterpartyId = (await seedOrgRows(db, org, "two")).counterpartyId;
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function member(orgId: string, userId: string, role: string) {
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, userId, role]);
}

const setFigure = (orgId: string, above: number | null) =>
  db.query(
    `insert into public.approval_policies (org_id, two_approvals_above) values ($1, $2)
     on conflict (org_id) do update set two_approvals_above = excluded.two_approvals_above`,
    [orgId, above]
  );

const approve = (orgId: string, sourceId: string, by: string, amount = 120) =>
  db.query(
    `insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency, address)
     values ($1, 'invoice', $2, $3, $4, 'USDC', '0xabc') returning id`,
    [orgId, sourceId, by, amount]
  );

async function heldInvoice(createdBy: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, created_by)
     values ($1, 'payable', $2, 120, now(), 'held', $3) returning id`,
    [org, counterpartyId, createdBy]
  );
  return result.rows[0].id;
}

const claim = (actor: string, invoiceId: string) =>
  asTenant(db, org, async (tx) =>
    (await tx.query<{ status: string }>("select status from public.claim_invoice_decision($1, $2, $3, 'approve')", [org, invoiceId, actor])).rows[0]);

const besides = (tokenOrg: string | null, orgId: string, excluded: string[]) =>
  asTenant(db, tokenOrg, async (tx) =>
    (await tx.query<{ n: number }>("select public.approvers_besides($1, $2::uuid[]) as n", [orgId, excluded])).rows[0].n);

describe("approval_policies (0076)", () => {
  it("holds one figure per workspace, positive or off", async () => {
    const orgId = await createOrg(db, "two-figure");
    await setFigure(orgId, 100);
    await setFigure(orgId, null);
    await setFigure(orgId, 250.5);
    const rows = (await db.query<{ two_approvals_above: string }>("select two_approvals_above from public.approval_policies where org_id = $1", [orgId])).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].two_approvals_above)).toBe(250.5);
    await expect(setFigure(orgId, 0)).rejects.toThrow(/approval_policies_two_approvals_above_check/);
  });

  it("goes with its workspace, and is seen only by its own", async () => {
    const mine = await createOrg(db, "two-figure-a");
    const theirs = await createOrg(db, "two-figure-b");
    await setFigure(mine, 10);
    await setFigure(theirs, 20);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ two_approvals_above: string }>("select two_approvals_above from public.approval_policies")).rows);
    expect(seen.map((row) => Number(row.two_approvals_above))).toEqual([10]);
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.approval_policies"))).rejects.toThrow(/permission denied/);
    await db.query("delete from public.orgs where id = $1", [theirs]);
    expect((await db.query("select 1 from public.approval_policies where org_id = $1", [theirs])).rows).toHaveLength(0);
  });
});

describe("payment_approvals (0076)", () => {
  it("keeps one open approval per person and payment, and any number used", async () => {
    const invoiceId = await heldInvoice(owner);
    const first = (await approve(org, invoiceId, approver)).rows[0] as { id: string };
    await expect(approve(org, invoiceId, approver)).rejects.toThrow(/payment_approvals_open/);
    await db.query("update public.payment_approvals set used_at = now() where id = $1", [first.id]);
    await approve(org, invoiceId, approver);
    const rows = (await db.query("select 1 from public.payment_approvals where source_id = $1", [invoiceId])).rows;
    expect(rows).toHaveLength(2);
  });

  it("names an invoice or a milestone, nothing else", async () => {
    await expect(
      db.query(
        `insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency)
         values ($1, 'treasury', gen_random_uuid(), $2, 1, 'USDC')`,
        [org, approver]
      )
    ).rejects.toThrow(/payment_approvals_source_type_check/);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const invoiceId = await heldInvoice(owner);
    await approve(org, invoiceId, admin);
    const seenByOther = await asTenant(db, other, async (tx) => (await tx.query("select 1 from public.payment_approvals")).rows);
    expect(seenByOther).toHaveLength(0);
    const seenByMine = await asTenant(db, org, async (tx) => (await tx.query("select 1 from public.payment_approvals where source_id = $1", [invoiceId])).rows);
    expect(seenByMine).toHaveLength(1);
    await expect(
      asTenant(db, other, (tx) =>
        tx.query(
          `insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency)
           values ($1, 'invoice', $2, $3, 1, 'USDC')`,
          [org, invoiceId, outsider]
        )
      )
    ).rejects.toThrow(/row-level security/);
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.payment_approvals"))).rejects.toThrow(/permission denied/);
  });
});

describe("approvers_besides (0076)", () => {
  it("counts the members who may approve payments, leaving out those named", async () => {
    expect(await besides(org, org, [])).toBe(3);
    expect(await besides(org, org, [owner])).toBe(2);
    expect(await besides(org, org, [owner, approver])).toBe(1);
    // A viewer, or someone outside the workspace, changes nothing.
    expect(await besides(org, org, [viewer, outsider])).toBe(3);
  });

  it("answers 0 for another workspace than the token's, and is not for anon", async () => {
    expect(await besides(other, org, [])).toBe(0);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.approvers_besides($1, '{}'::uuid[])", [org]))).rejects.toThrow(/permission denied/);
  });
});

const among = (tokenOrg: string | null, orgId: string, users: string[]) =>
  asTenant(db, tokenOrg, async (tx) =>
    ((await tx.query<{ ids: string[] | null }>("select public.approvers_among($1, $2::uuid[]) as ids", [orgId, users])).rows[0].ids ?? []).sort());

describe("approvers_among (0076)", () => {
  it("keeps of the people named those who may approve payments in the workspace now", async () => {
    expect(await among(org, org, [owner, viewer, outsider])).toEqual([owner].sort());
    expect(await among(org, org, [approver, admin])).toEqual([approver, admin].sort());
    expect(await among(org, org, [])).toEqual([]);
  });

  it("answers no one for another workspace than the token's, and is not for anon", async () => {
    expect(await among(other, org, [owner])).toEqual([]);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.approvers_among($1, '{}'::uuid[])", [org]))).rejects.toThrow(/permission denied/);
  });
});

describe("claim_invoice_decision with two approvals (0076)", () => {
  it("still refuses whoever entered it, when no one else approved it", async () => {
    const invoiceId = await heldInvoice(admin);
    await expect(claim(admin, invoiceId)).rejects.toThrow(/self_approval/);
  });

  it("lets whoever entered it give the second approval, once another person's open approval is on file", async () => {
    const invoiceId = await heldInvoice(admin);
    await approve(org, invoiceId, approver);
    expect((await claim(admin, invoiceId)).status).toBe("processing");
  });

  it("does not count their own approval, or one already used", async () => {
    const own = await heldInvoice(admin);
    await approve(org, own, admin);
    await expect(claim(admin, own)).rejects.toThrow(/self_approval/);

    const used = await heldInvoice(admin);
    const row = (await approve(org, used, approver)).rows[0] as { id: string };
    await db.query("update public.payment_approvals set used_at = now() where id = $1", [row.id]);
    await expect(claim(admin, used)).rejects.toThrow(/self_approval/);
  });

  it("lets anyone else approve as before", async () => {
    const invoiceId = await heldInvoice(admin);
    expect((await claim(approver, invoiceId)).status).toBe("processing");
  });
});
