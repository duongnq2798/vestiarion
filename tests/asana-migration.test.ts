import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0115 (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A3, A8, A10): Asana on the connector
 * core's tables, a milestone's acceptance criteria, the tasks linked to milestones (`asana_task_links`), their webhooks
 * (`asana_webhooks`, a platform table), and the two moves that touch a milestone: accepting a completed task, and holding
 * an acceptance the task no longer bears out.
 */

let db: PGlite;
let person: string;
let other: string;

const sha = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const FINGERPRINT = "a".repeat(64);
const CRITERIA = "A 5-second logo animation, MP4 and GIF, on the brand palette.";

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0105_") || file.startsWith("0115_"));
  person = await createUser(db, "owner-asana@example.com");
  other = await createUser(db, "admin-asana@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function connection(orgId: string, provider = "asana", externalOrgId = String(crypto.randomInt(1, 2 ** 40))): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from)
       values ($1, $2, $3, 'Duong', 'connected', $4, 'asana-2026-10-14', now(), '2026-07-14') returning id`,
      [orgId, provider, externalOrgId, person]
    )
  ).rows[0].id;
}

async function milestone(orgId: string, fields: { status?: string; criteria?: string | null } = {}): Promise<string> {
  const contractor = (
    await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Fernhill Studio', 'contractor') returning id", [orgId])
  ).rows[0].id;
  return (
    await db.query<{ id: string }>(
      "insert into public.milestones (org_id, contractor_id, title, amount, status, acceptance_criteria) values ($1, $2, 'Logo animation', 450, $3, $4) returning id",
      [orgId, contractor, fields.status ?? "pending", fields.criteria === undefined ? CRITERIA : fields.criteria]
    )
  ).rows[0].id;
}

/** The workspace's one Asana connection, made on first use. */
const connections = new Map<string, string>();
async function asanaConnection(orgId: string): Promise<string> {
  const known = connections.get(orgId);
  if (known) return known;
  const made = await connection(orgId);
  connections.set(orgId, made);
  return made;
}

async function link(orgId: string, milestoneId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const row = { task_gid: String(crypto.randomInt(1, 2 ** 40)), completed: true, completed_at: "2026-10-14T09:00:00Z", deliverable_fingerprint: FINGERPRINT, state: "ready", ...fields };
  return (
    await db.query<{ id: string }>(
      `insert into public.asana_task_links (org_id, milestone_id, connection_id, workspace_gid, project_gid, task_gid, task_name, task_url, state,
         completed, completed_at, deliverables, deliverable_fingerprint)
       values ($1, $2, $3, '1204081671801519', '1219477646404725', $4, 'Logo animation', 'https://app.asana.com/0/1219477646404725/1219477646404728', $5,
         $6, $7, '[{"kind":"link","label":"figma.com","href":"https://www.figma.com/file/abc"}]'::jsonb, $8) returning id`,
      [orgId, milestoneId, await asanaConnection(orgId), row.task_gid, row.state, row.completed, row.completed_at, row.deliverable_fingerprint]
    )
  ).rows[0].id;
}

const accept = (orgId: string, linkId: string, fields: { fingerprint?: string; criteria?: string } = {}) =>
  asTenant(db, orgId, async (tx) =>
    (
      await tx.query<Record<string, unknown>>("select * from public.accept_asana_task($1, $2, $3, $4, $5, $6)", [
        orgId,
        linkId,
        person,
        fields.fingerprint ?? FINGERPRINT,
        sha(fields.criteria ?? CRITERIA),
        "Accepted against its criteria",
      ])
    ).rows[0]
  );

const hold = (orgId: string, linkId: string, reason = "reopened") =>
  asTenant(db, orgId, async (tx) => (await tx.query<{ hold_asana_acceptance: string }>("select public.hold_asana_acceptance($1, $2, $3)", [orgId, linkId, reason])).rows[0].hold_asana_acceptance);

const milestoneRow = async (id: string) =>
  (
    await db.query<{ status: string; verified: boolean; verification_method: string; verification_status: string; amount: string; contractor_id: string; verification_detail: Record<string, unknown> }>(
      "select status, verified, verification_method, verification_status, amount, contractor_id, verification_detail from public.milestones where id = $1",
      [id]
    )
  ).rows[0];

describe("the core's tables take Asana", () => {
  it("accepts asana as a provider of a connection and of its tokens, and keeps the earlier ones", async () => {
    const orgId = await createOrg(db, "asana-checks");
    const connectionId = await connection(orgId);
    await db.query(
      `insert into public.accounting_tokens (id, org_id, provider, connection_id, authorized_by, access_token_enc, refresh_token_enc, access_expires_at)
       values (gen_random_uuid(), $1, 'asana', $2, $3, '{}'::jsonb, '{}'::jsonb, now())`,
      [orgId, connectionId, person]
    );
    const xero = await createOrg(db, "asana-checks-xero");
    expect(await connection(xero, "xero", "tenant-1")).toBeTruthy();
    expect(await connection(await createOrg(db, "asana-checks-hub"), "hubspot", "991")).toBeTruthy();
    await expect(connection(await createOrg(db, "asana-checks-monday"), "monday", "1")).rejects.toThrow(/accounting_connections_provider_check/);
  });

  it("never narrows a check a later migration widened further", async () => {
    await db.query("alter table public.accounting_connections drop constraint accounting_connections_provider_check");
    await db.query(
      "alter table public.accounting_connections add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive'))"
    );
    await applyMigrations(db, (file) => file.startsWith("0115_"));
    expect(await connection(await createOrg(db, "asana-wider"), "pipedrive", "77")).toBeTruthy();
  });

  it("keeps Pipedrive's 0116 in every check it widened when 0115 runs again after it, and 0116 keeps asana", async () => {
    await applyMigrations(db, (file) => file.startsWith("0116_"));
    await applyMigrations(db, (file) => file.startsWith("0115_"));
    const checks = await db.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('accounting_connections_provider_check', 'accounting_tokens_provider_check', 'external_links_provider_check')`
    );
    expect(checks.rows.map((row) => row.conname).sort()).toEqual(["accounting_connections_provider_check", "accounting_tokens_provider_check", "external_links_provider_check"]);
    for (const row of checks.rows) {
      for (const provider of ["xero", "quickbooks", "hubspot", "pipedrive", "asana"]) expect(row.def, `${row.conname} ${provider}`).toContain(`'${provider}'`);
    }
  });

  it("lets a milestone be verified by an Asana acceptance, and keeps the other methods", async () => {
    const orgId = await createOrg(db, "asana-method");
    const id = await milestone(orgId);
    await db.query("update public.milestones set verification_method = 'asana' where id = $1", [id]);
    for (const method of ["unverified", "github", "manual", "seed"]) await db.query("update public.milestones set verification_method = $2 where id = $1", [id, method]);
    await expect(db.query("update public.milestones set verification_method = 'trello' where id = $1", [id])).rejects.toThrow(/milestones_verification_method_check/);
    // One named check, however many times the migration ran.
    const checks = await db.query<{ conname: string }>(
      "select conname from pg_constraint where conrelid = 'public.milestones'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%verification_method%'"
    );
    expect(checks.rows.map((row) => row.conname)).toEqual(["milestones_verification_method_check"]);
  });

  it("keeps acceptance criteria of 3 to 2000 characters, or none", async () => {
    const orgId = await createOrg(db, "asana-criteria");
    expect(await milestone(orgId, { criteria: null })).toBeTruthy();
    await expect(milestone(orgId, { criteria: "  " })).rejects.toThrow(/milestones_acceptance_criteria_check/);
    await expect(milestone(orgId, { criteria: "x".repeat(2001) })).rejects.toThrow(/milestones_acceptance_criteria_check/);
  });
});

describe("asana_task_links", () => {
  it("links a task to one milestone at a time, and a milestone to one task", async () => {
    const orgId = await createOrg(db, "asana-links-unique");
    const first = await milestone(orgId);
    const second = await milestone(orgId);
    const linkId = await link(orgId, first, { task_gid: "1219477646404728" });
    await expect(link(orgId, second, { task_gid: "1219477646404728" })).rejects.toThrow(/asana_task_links_task_key/);
    await expect(link(orgId, first, { task_gid: "1219477646404730" })).rejects.toThrow(/asana_task_links_milestone_key/);
    await db.query("update public.asana_task_links set unlinked_at = now() where id = $1", [linkId]);
    expect(await link(orgId, second, { task_gid: "1219477646404728" })).toBeTruthy();
  });

  it("holds only with a reason, and accepts only with the version accepted", async () => {
    const orgId = await createOrg(db, "asana-links-checks");
    await expect(link(orgId, await milestone(orgId), { state: "held" })).rejects.toThrow(/asana_task_links_held_check/);
    await expect(link(orgId, await milestone(orgId), { state: "accepted" })).rejects.toThrow(/asana_task_links_accepted_check/);
    await expect(link(orgId, await milestone(orgId), { completed: false })).rejects.toThrow(/asana_task_links_completed_check/);
    await expect(link(orgId, await milestone(orgId), { task_gid: "12ab" })).rejects.toThrow(/asana_task_links_task_gid_check/);
  });

  it("never links another workspace's milestone", async () => {
    const a = await createOrg(db, "asana-links-fk-a");
    const b = await createOrg(db, "asana-links-fk-b");
    const theirs = await milestone(b);
    await expect(link(a, theirs)).rejects.toThrow(/asana_task_links_milestone_fkey/);
  });

  it("is read and written by its own workspace only, and never deleted by the tenant role", async () => {
    const a = await createOrg(db, "asana-links-tenant-a");
    const b = await createOrg(db, "asana-links-tenant-b");
    await link(a, await milestone(a));
    const theirs = await link(b, await milestone(b));
    const seen = await asTenant(db, a, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.asana_task_links")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([a]);
    const updated = await asTenant(db, a, (tx) => tx.query("update public.asana_task_links set task_name = 'x' where id = $1", [theirs]));
    expect(updated.affectedRows ?? 0).toBe(0);
    await expect(asTenant(db, a, (tx) => tx.query("delete from public.asana_task_links where org_id = $1", [a]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select * from public.asana_task_links"))).rejects.toThrow(/permission denied/);
  });
});

describe("asana_webhooks", () => {
  it("is the service role's alone", async () => {
    const orgId = await createOrg(db, "asana-hooks");
    const linkId = await link(orgId, await milestone(orgId));
    const id = crypto.randomUUID();
    await db.query(
      "insert into public.asana_webhooks (id, org_id, connection_id, link_id, resource_gid) select $1, org_id, connection_id, id, task_gid from public.asana_task_links where id = $2",
      [id, linkId]
    );
    const rows = await asServiceRole(db, async (tx) => (await tx.query<{ id: string }>("select id from public.asana_webhooks where id = $1", [id])).rows);
    expect(rows).toEqual([{ id }]);
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.asana_webhooks"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.asana_webhooks"))).rejects.toThrow(/permission denied/);
    // An active webhook keeps its secret.
    await expect(db.query("update public.asana_webhooks set state = 'active' where id = $1", [id])).rejects.toThrow(/asana_webhooks_secret_check/);
  });
});

describe("accept_asana_task", () => {
  it("verifies a pending milestone by a person's acceptance of its completed task, and changes no amount or payee", async () => {
    const orgId = await createOrg(db, "asana-accept");
    const id = await milestone(orgId);
    const before = await milestoneRow(id);
    const linkId = await link(orgId, id);
    const accepted = await accept(orgId, linkId);
    expect(accepted).toMatchObject({ state: "accepted", accepted_by: person, accepted_fingerprint: FINGERPRINT, accepted_criteria_sha256: sha(CRITERIA) });
    const after = await milestoneRow(id);
    expect(after).toMatchObject({ status: "verified", verified: true, verification_method: "asana", verification_status: "verified" });
    expect(after.verification_detail).toMatchObject({ taskGid: expect.any(String), fingerprint: FINGERPRINT, criteriaSha256: sha(CRITERIA), acceptedBy: person });
    expect({ amount: after.amount, contractor: after.contractor_id }).toEqual({ amount: before.amount, contractor: before.contractor_id });
    await expect(accept(orgId, linkId)).rejects.toThrow(/already_accepted/);
  });

  it("refuses a task not completed, a version not the one shown, criteria missing or changed, and a milestone not open", async () => {
    const orgId = await createOrg(db, "asana-accept-refusals");
    await expect(accept(orgId, await link(orgId, await milestone(orgId), { completed: false, completed_at: null, state: "waiting" }))).rejects.toThrow(/not_completed/);
    await expect(accept(orgId, await link(orgId, await milestone(orgId)), { fingerprint: "b".repeat(64) })).rejects.toThrow(/stale/);
    await expect(accept(orgId, await link(orgId, await milestone(orgId, { criteria: null })))).rejects.toThrow(/no_criteria/);
    await expect(accept(orgId, await link(orgId, await milestone(orgId)), { criteria: "Something else" })).rejects.toThrow(/criteria_changed/);
    for (const status of ["verified", "held", "paid", "closed"]) {
      const id = await milestone(orgId, { status });
      await expect(accept(orgId, await link(orgId, id)), status).rejects.toThrow(new RegExp(`milestone_not_open: the milestone is ${status} now`));
      expect((await milestoneRow(id)).verification_method).toBe("unverified");
    }
  });

  it("never accepts another workspace's link", async () => {
    const a = await createOrg(db, "asana-accept-tenant-a");
    const b = await createOrg(db, "asana-accept-tenant-b");
    const theirs = await link(b, await milestone(b));
    await expect(accept(a, theirs)).rejects.toThrow(/link_not_found/);
  });
});

describe("hold_asana_acceptance", () => {
  async function accepted(slug: string): Promise<{ orgId: string; milestoneId: string; linkId: string }> {
    const orgId = await createOrg(db, slug);
    const milestoneId = await milestone(orgId);
    const linkId = await link(orgId, milestoneId);
    await accept(orgId, linkId);
    return { orgId, milestoneId, linkId };
  }

  const linkRow = async (id: string) =>
    (await db.query<{ state: string; held_reason: string | null; after_payment: boolean }>("select state, held_reason, after_payment from public.asana_task_links where id = $1", [id])).rows[0];

  it("takes the verification back from an accepted milestone the agent has not paid, and holds the link for review", async () => {
    const { orgId, milestoneId, linkId } = await accepted("asana-hold");
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "pending", verified: false, verification_status: "unverified" });
    expect(await linkRow(linkId)).toEqual({ state: "held", held_reason: "reopened", after_payment: false });
    // Once held, nothing more: only an accepted link is held.
    expect(await hold(orgId, linkId, "deliverable_changed")).toBe("not_accepted");
  });

  it("takes it back from a milestone the agent held too, with no transfer for it", async () => {
    const { orgId, milestoneId, linkId } = await accepted("asana-hold-held");
    await db.query("update public.milestones set status = 'held' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "deliverable_changed")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "pending", verified: false });
  });

  it("leaves a milestone whose payment is under way or paid, and holds the link as changed after payment", async () => {
    const { orgId, milestoneId, linkId } = await accepted("asana-hold-paying");
    await db.query(
      "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, status) values ($1, 'milestone', $2, $3, 'circle', 450, '0x1', 'pending')",
      [orgId, milestoneId, `asana-${milestoneId}`]
    );
    expect(await hold(orgId, linkId, "reopened")).toBe("held_after_payment");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "verified", verified: true });
    expect(await linkRow(linkId)).toEqual({ state: "held", held_reason: "reopened", after_payment: true });
  });

  it("takes it back after a transfer that failed, which moved nothing", async () => {
    const { orgId, milestoneId, linkId } = await accepted("asana-hold-failed");
    await db.query(
      "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, status) values ($1, 'milestone', $2, $3, 'circle', 450, '0x1', 'failed')",
      [orgId, milestoneId, `asana-failed-${milestoneId}`]
    );
    await db.query("update public.milestones set status = 'held' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "pending", verified: false });
  });

  it("waits while a person is deciding the milestone, and acts once the claim is old", async () => {
    const { orgId, milestoneId, linkId } = await accepted("asana-hold-claimed");
    await db.query("update public.milestones set status = 'held', decision_claimed_by = $2, decision_claimed_at = now() where id = $1", [milestoneId, other]);
    expect(await hold(orgId, linkId, "reopened")).toBe("deferred");
    expect((await linkRow(linkId)).state).toBe("accepted");
    await db.query("update public.milestones set decision_claimed_at = now() - interval '11 minutes' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
  });

  it("refuses an unknown reason, and never holds another workspace's link", async () => {
    const { orgId, linkId } = await accepted("asana-hold-tenant");
    const stranger = await createOrg(db, "asana-hold-stranger");
    await expect(hold(orgId, linkId, "because")).rejects.toThrow(/bad_reason/);
    expect(await hold(stranger, linkId, "reopened")).toBe("not_accepted");
    expect((await linkRow(linkId)).state).toBe("accepted");
  });
});
