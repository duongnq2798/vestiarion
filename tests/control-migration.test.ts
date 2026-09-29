import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows,
} from "./support/pglite";

/**
 * Migration 0025 (control design D4–D7, spec §7): the approval inbox and the
 * agent's pause switch. `claim_invoice_decision` is the compare-and-set that
 * moves a waiting payable to `processing` for one person, guarded by RLS
 * (invoker rights) so a tenant only ever sees its own organization's
 * invoices. `pause_agent`/`resume_agent` are told who is acting and check
 * that person's role themselves, the 0021 pattern. `begin_cycle_run` (0022)
 * now refuses to open a run while paused.
 */

let db: PGlite;
let owner: string, admin: string, approver: string, viewer: string, outsider: string;
let orgId: string, counterpartyId: string;
let otherOrgId: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  owner = await createUser(db, "owner@example.com");
  admin = await createUser(db, "admin@example.com");
  approver = await createUser(db, "approver@example.com");
  viewer = await createUser(db, "viewer@example.com");
  outsider = await createUser(db, "outsider@example.com");

  orgId = await createOrg(db, "control-co");
  for (const [user, role] of [[owner, "owner"], [admin, "admin"], [approver, "approver"], [viewer, "viewer"]] as const) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, user, role]);
  }
  const seeded = await seedOrgRows(db, orgId, "control");
  counterpartyId = seeded.counterpartyId;

  otherOrgId = await createOrg(db, "other-co");
  await seedOrgRows(db, otherOrgId, "other");
}, 60_000);

afterAll(async () => {
  await db.close();
});

/** A payable invoice in `orgId`, inserted directly (the service role's stand-in). */
async function invoice(status: string, opts: { createdBy?: string | null } = {}): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, created_by)
     values ($1, 'payable', $2, 1, now(), $3, $4) returning id`,
    [orgId, counterpartyId, status, opts.createdBy ?? null]
  );
  return result.rows[0].id;
}

const claim = (org: string, actor: string, invoiceId: string, decision: string) =>
  asTenant(db, org, async (tx) =>
    (await tx.query<Record<string, unknown>>(
      "select * from public.claim_invoice_decision($1, $2, $3, $4)", [org, invoiceId, actor, decision]
    )).rows[0]);

const rowOf = async (invoiceId: string) =>
  (await db.query<{ status: string; reviewed_by: string | null; reviewed_at: Date | null }>(
    "select status, reviewed_by, reviewed_at from public.invoices where id = $1", [invoiceId]
  )).rows[0];

describe("claim_invoice_decision", () => {
  it("moves a held payable to processing, stamped and returned", async () => {
    const id = await invoice("held");
    const row = await claim(orgId, approver, id, "approve");
    expect(row).toMatchObject({ id, status: "processing", reviewed_by: approver });
    expect(row.reviewed_at).toBeTruthy();
    expect(await rowOf(id)).toMatchObject({ status: "processing", reviewed_by: approver });
  });

  it("refuses a second claim while it is still fresh", async () => {
    const id = await invoice("flagged");
    await claim(orgId, approver, id, "approve");
    await expect(claim(orgId, admin, id, "approve")).rejects.toThrow(/already_decided: the invoice is processing now/);
  });

  it("refuses approval by the invoice's own creator, leaving the row unchanged", async () => {
    const id = await invoice("held", { createdBy: approver });
    await expect(claim(orgId, approver, id, "approve")).rejects.toThrow(/self_approval/);
    expect(await rowOf(id)).toMatchObject({ status: "held", reviewed_by: null });
  });

  it("lets the creator reject their own invoice", async () => {
    const id = await invoice("held", { createdBy: approver });
    const row = await claim(orgId, approver, id, "reject");
    expect(row).toMatchObject({ id, status: "processing", reviewed_by: approver });
  });

  it("lets a processing row be reclaimed once stale, but not while fresh", async () => {
    const stale = await invoice("processing");
    await db.query("update public.invoices set reviewed_at = now() - interval '11 minutes' where id = $1", [stale]);
    const row = await claim(orgId, admin, stale, "approve");
    expect(row).toMatchObject({ id: stale, status: "processing", reviewed_by: admin });

    const fresh = await invoice("processing");
    await db.query("update public.invoices set reviewed_at = now() - interval '5 minutes' where id = $1", [fresh]);
    await expect(claim(orgId, admin, fresh, "approve")).rejects.toThrow(/already_decided: the invoice is processing now/);
  });

  it("refuses a paid invoice", async () => {
    const id = await invoice("paid");
    await expect(claim(orgId, approver, id, "approve")).rejects.toThrow(/already_decided: the invoice is paid now/);
  });

  it("refuses an unknown id", async () => {
    await expect(claim(orgId, approver, "00000000-0000-4000-8000-000000009999", "approve"))
      .rejects.toThrow(/invoice_not_found/);
  });

  it("refuses an unknown decision", async () => {
    const id = await invoice("held");
    await expect(claim(orgId, approver, id, "pay")).rejects.toThrow(/invalid_decision/);
  });

  it("hides another organization's invoice behind RLS, leaving the row unchanged", async () => {
    const id = await invoice("held");
    // p_org_id is the invoice's real organization (what a well-formed call
    // would pass); only the tenant token names the other organization. If
    // this raised invoice_not_found because of the function's own
    // `org_id = p_org_id` predicate, that predicate alone would already
    // explain it — routing the token through otherOrgId is what proves RLS,
    // not the predicate, is what hides the row.
    await expect(
      asTenant(db, otherOrgId, (tx) =>
        tx.query("select * from public.claim_invoice_decision($1, $2, $3, $4)", [orgId, id, outsider, "approve"]))
    ).rejects.toThrow(/invoice_not_found/);
    expect(await rowOf(id)).toMatchObject({ status: "held", reviewed_by: null });
  });

  it("raises self_approval, not already_decided, when the creator reclaims their own stale processing invoice", async () => {
    const id = await invoice("processing", { createdBy: approver });
    await db.query("update public.invoices set reviewed_at = now() - interval '11 minutes' where id = $1", [id]);
    await expect(claim(orgId, approver, id, "approve")).rejects.toThrow(/self_approval/);
  });

  it("treats a null reviewed_at as stale, so a processing row with none can be reclaimed", async () => {
    const id = await invoice("processing");
    const row = await claim(orgId, admin, id, "approve");
    expect(row).toMatchObject({ id, status: "processing", reviewed_by: admin });
  });
});

describe("pause_agent and resume_agent", () => {
  let pauseOrgCounter = 0;

  /** A fresh organization with the same four roles, so each scenario starts unpaused and unaffected by any other. */
  async function newPausableOrg(): Promise<string> {
    const org = await createOrg(db, `pause-${++pauseOrgCounter}-co`);
    for (const [user, role] of [[owner, "owner"], [admin, "admin"], [approver, "approver"], [viewer, "viewer"]] as const) {
      await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [org, user, role]);
    }
    return org;
  }

  const pause = (org: string, actor: string, reason: string | null) =>
    asServiceRole(db, async (tx) =>
      (await tx.query<Record<string, unknown>>("select * from public.pause_agent($1, $2, $3)", [org, actor, reason])).rows[0]);
  const resume = (org: string, actor: string) =>
    asServiceRole(db, async (tx) =>
      (await tx.query<{ resume_agent: Date }>("select public.resume_agent($1, $2)", [org, actor])).rows[0].resume_agent);

  it("refuses a viewer and a non-member", async () => {
    const org = await newPausableOrg();
    await expect(pause(org, viewer, null)).rejects.toThrow(/pause_not_permitted: a viewer cannot pause the agent/);
    await expect(pause(org, outsider, null)).rejects.toThrow(/not_a_member/);
  });

  it("lets an approver pause, setting the paused-at, paused-by and trimmed reason", async () => {
    const org = await newPausableOrg();
    const row = await pause(org, approver, "  investigating a mismatch  ");
    expect(row).toMatchObject({ agent_paused_by: approver, agent_pause_reason: "investigating a mismatch" });
    expect(row.agent_paused_at).toBeTruthy();
  });

  it("refuses a second pause", async () => {
    const org = await newPausableOrg();
    await pause(org, approver, null);
    await expect(pause(org, admin, null)).rejects.toThrow(/already_paused/);
  });

  it("refuses a 281-character reason by the column check, and accepts 280", async () => {
    const org = await newPausableOrg();
    await expect(pause(org, approver, "x".repeat(281))).rejects.toThrow(/orgs_agent_pause_reason_length/);
    await expect(pause(org, approver, "x".repeat(280))).resolves.toMatchObject({ agent_pause_reason: "x".repeat(280) });
  });

  it("refuses resume by an approver", async () => {
    const org = await newPausableOrg();
    await pause(org, approver, null);
    await expect(resume(org, approver)).rejects.toThrow(/resume_not_permitted: a approver cannot resume the agent/);
  });

  it("lets the owner resume, clearing all three columns and returning the paused-since time", async () => {
    const org = await newPausableOrg();
    await pause(org, approver, null);
    const since = await resume(org, owner);
    expect(since).toBeTruthy();
    const row = (await db.query<{ agent_paused_at: Date | null; agent_paused_by: string | null; agent_pause_reason: string | null }>(
      "select agent_paused_at, agent_paused_by, agent_pause_reason from public.orgs where id = $1", [org]
    )).rows[0];
    expect(row).toEqual({ agent_paused_at: null, agent_paused_by: null, agent_pause_reason: null });
  });

  it("refuses a second resume", async () => {
    const org = await newPausableOrg();
    await pause(org, approver, null);
    await resume(org, owner);
    await expect(resume(org, owner)).rejects.toThrow(/not_paused/);
  });
});

describe("agent_paused", () => {
  it("is true while paused and false after, for the tenant and the service role", async () => {
    const org = await createOrg(db, "flag-co");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [org, owner]);

    const paused = () => asTenant(db, org, (tx) => tx.query<{ agent_paused: boolean }>("select public.agent_paused($1) as agent_paused", [org]));
    const pausedAsService = () => asServiceRole(db, (tx) => tx.query<{ agent_paused: boolean }>("select public.agent_paused($1) as agent_paused", [org]));

    expect((await paused()).rows[0].agent_paused).toBe(false);
    expect((await pausedAsService()).rows[0].agent_paused).toBe(false);

    await asServiceRole(db, (tx) => tx.query("select public.pause_agent($1, $2, $3)", [org, owner, null]));
    expect((await paused()).rows[0].agent_paused).toBe(true);
    expect((await pausedAsService()).rows[0].agent_paused).toBe(true);

    await asServiceRole(db, (tx) => tx.query("select public.resume_agent($1, $2)", [org, owner]));
    expect((await paused()).rows[0].agent_paused).toBe(false);
    expect((await pausedAsService()).rows[0].agent_paused).toBe(false);
  });

  it("does not reveal another organization's paused state to a tenant", async () => {
    const orgA = await createOrg(db, "isolated-a-co");
    const orgB = await createOrg(db, "isolated-b-co");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgA, owner]);
    await asServiceRole(db, (tx) => tx.query("select public.pause_agent($1, $2, $3)", [orgA, owner, null]));

    const asOtherTenant = await asTenant(db, orgB, (tx) =>
      tx.query<{ agent_paused: boolean }>("select public.agent_paused($1) as agent_paused", [orgA]));
    expect(asOtherTenant.rows[0].agent_paused).toBe(false);
  });
});

describe("begin_cycle_run while paused", () => {
  it("raises agent_paused while the organization is paused, and opens a run after resume", async () => {
    const org = await createOrg(db, "cycle-co");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [org, owner]);
    const begin = () =>
      asTenant(db, org, (tx) =>
        tx.query<{ id: string }>("select public.begin_cycle_run($1, null, now(), 'real', 'simulate', 'simulate') as id", [org]));

    await asServiceRole(db, (tx) => tx.query("select public.pause_agent($1, $2, $3)", [org, owner, null]));
    await expect(begin()).rejects.toThrow(/agent_paused: the agent is paused/);

    await asServiceRole(db, (tx) => tx.query("select public.resume_agent($1, $2)", [org, owner]));
    await expect(begin()).resolves.toBeTruthy();
  });
});

describe("who may call these functions", () => {
  it.each(["anon", "authenticated"] as const)("%s cannot execute claim_invoice_decision", async (role) => {
    await expect(asRole(db, role, (tx) =>
      tx.query("select * from public.claim_invoice_decision($1, $2, $3, $4)", [orgId, orgId, owner, "approve"])
    )).rejects.toThrow(/permission denied/);
  });

  it.each(["anon", "authenticated"] as const)("%s cannot execute agent_paused", async (role) => {
    await expect(asRole(db, role, (tx) => tx.query("select public.agent_paused($1)", [orgId]))).rejects.toThrow(/permission denied/);
  });

  it.each(["anon", "authenticated"] as const)("%s cannot execute pause_agent or resume_agent", async (role) => {
    await expect(asRole(db, role, (tx) => tx.query("select public.pause_agent($1, $2, $3)", [orgId, owner, null])))
      .rejects.toThrow(/permission denied/);
    await expect(asRole(db, role, (tx) => tx.query("select public.resume_agent($1, $2)", [orgId, owner])))
      .rejects.toThrow(/permission denied/);
  });

  it("the tenant role cannot execute pause_agent or resume_agent", async () => {
    await expect(asTenant(db, orgId, (tx) => tx.query("select public.pause_agent($1, $2, $3)", [orgId, owner, null])))
      .rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("select public.resume_agent($1, $2)", [orgId, owner])))
      .rejects.toThrow(/permission denied/);
  });
});

describe("replaying 0025", () => {
  it("replays every migration twice without error", async () => {
    const fresh = await createDatabase();
    try {
      await applyMigrations(fresh);
      await applyMigrations(fresh);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
