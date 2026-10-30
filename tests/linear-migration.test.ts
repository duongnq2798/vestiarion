import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliverablesOf as asanaDeliverablesOf } from "@/lib/asana/deliverables";
import { DELIVERABLES_BYTES, deliverablesOf, storedBytes } from "@/lib/linear/deliverables";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser, migrationFiles, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0147 (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN3, LN8, LN10): Linear on the connector
 * core's tables beside every provider they took, a milestone verified by a Linear acceptance beside every method it
 * took, the issues linked to milestones (`linear_issue_links`), the two moves that touch a milestone (accepting a
 * completed issue, and holding an acceptance the issue no longer bears out), and the readiness probe. Re-runnable, and
 * never narrowing a check a later migration widened.
 */

const FILE = "0147_linear_acceptance.sql";
const sql = () => readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const PROVIDERS_BEFORE = ["xero", "quickbooks", "hubspot", "asana", "pipedrive", "zohobooks", "zohocrm", "googlesheets"];
const METHODS_BEFORE = ["unverified", "github", "manual", "seed", "asana"];

let db: PGlite;
let person: string;
let other: string;

const sha = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const FINGERPRINT = "a".repeat(64);
const CRITERIA = "The billing export screen, with tests, merged behind its flag.";
const ISSUE_URL = "https://linear.app/fernhill/issue/ENG-123/billing-export";

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file: the earlier widenings, then this one, again.
  await applyMigrations(db, (file) => ["0101_", "0105_", "0115_", "0116_", "0122_", "0123_", "0145_", "0147_"].some((prefix) => file.startsWith(prefix)));
  person = await createUser(db, "owner-linear@example.com");
  other = await createUser(db, "admin-linear@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const definition = async (name: string) =>
  (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [name])).rows[0]?.def ?? "";

async function connection(orgId: string, provider = "linear", externalOrgId: string = crypto.randomUUID()): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from)
       values ($1, $2, $3, 'Fernhill', 'connected', $4, $5, now(), '2026-08-02') returning id`,
      [orgId, provider, externalOrgId, person, `${provider}-2026-10-31`]
    )
  ).rows[0].id;
}

async function milestone(orgId: string, fields: { status?: string; criteria?: string | null } = {}): Promise<string> {
  const contractor = (
    await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Fernhill Studio', 'contractor') returning id", [orgId])
  ).rows[0].id;
  return (
    await db.query<{ id: string }>(
      "insert into public.milestones (org_id, contractor_id, title, amount, status, acceptance_criteria) values ($1, $2, 'Billing export', 450, $3, $4) returning id",
      [orgId, contractor, fields.status ?? "pending", fields.criteria === undefined ? CRITERIA : fields.criteria]
    )
  ).rows[0].id;
}

/** The workspace's one Linear connection, made on first use. */
const connections = new Map<string, string>();
async function linearConnection(orgId: string): Promise<string> {
  const known = connections.get(orgId);
  if (known) return known;
  const made = await connection(orgId);
  connections.set(orgId, made);
  return made;
}

async function link(orgId: string, milestoneId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const row = {
    issue_id: crypto.randomUUID(),
    identifier: `ENG-${crypto.randomInt(1, 999_999)}`,
    completed: true,
    completed_at: "2026-10-31T09:00:00Z",
    archived: false,
    deliverable_fingerprint: FINGERPRINT,
    state: "ready",
    ...fields,
  };
  return (
    await db.query<{ id: string }>(
      `insert into public.linear_issue_links (org_id, milestone_id, connection_id, issue_id, identifier, team_key, issue_title, issue_url, state,
         completed, completed_at, archived, deliverables, deliverable_fingerprint)
       values ($1, $2, $3, $4, $5, 'ENG', 'Billing export', $6, $7, $8, $9, $10,
         '[{"kind":"attachment","id":"att-1","label":"github.com/fernhill/app/pull/42","href":"https://github.com/fernhill/app/pull/42"}]'::jsonb, $11) returning id`,
      [orgId, milestoneId, await linearConnection(orgId), row.issue_id, row.identifier, ISSUE_URL, row.state, row.completed, row.completed_at, row.archived, row.deliverable_fingerprint]
    )
  ).rows[0].id;
}

const accept = (orgId: string, linkId: string, fields: { fingerprint?: string; criteria?: string } = {}) =>
  asTenant(db, orgId, async (tx) =>
    (
      await tx.query<Record<string, unknown>>("select * from public.accept_linear_issue($1, $2, $3, $4, $5, $6)", [
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
  asTenant(db, orgId, async (tx) => (await tx.query<{ hold_linear_acceptance: string }>("select public.hold_linear_acceptance($1, $2, $3)", [orgId, linkId, reason])).rows[0].hold_linear_acceptance);

const milestoneRow = async (id: string) =>
  (
    await db.query<{ status: string; verified: boolean; verification_method: string; verification_status: string; amount: string; contractor_id: string; verification_detail: Record<string, unknown> }>(
      "select status, verified, verification_method, verification_status, amount, contractor_id, verification_detail from public.milestones where id = $1",
      [id]
    )
  ).rows[0];

describe("the core's tables take Linear (Linear acceptance LN3)", () => {
  it("accepts linear beside every provider taken before, after 0101, 0105, 0115, 0116, 0122, 0123, 0145 and 0147 ran again", async () => {
    const orgId = await createOrg(db, "linear-checks");
    const id = await connection(orgId);
    await db.query(
      `insert into public.accounting_tokens (id, org_id, provider, connection_id, authorized_by, access_token_enc, refresh_token_enc, access_expires_at)
       values (gen_random_uuid(), $1, 'linear', $2, $3, '{"v":1}', '{"v":1}', now())`,
      [orgId, id, person]
    );
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check"]) {
      const def = await definition(name);
      for (const provider of [...PROVIDERS_BEFORE, "linear"]) expect(def, `${name} ${provider}`).toContain(`'${provider}'`);
    }
    await expect(connection(await createOrg(db, "linear-checks-jira"), "jira")).rejects.toThrow(/accounting_connections_provider_check/);
  });

  it("lets two workspaces connect the same Linear organization, and keeps one live Linear connection per workspace (LN2)", async () => {
    const shared = crypto.randomUUID();
    expect(await connection(await createOrg(db, "linear-shared-1"), "linear", shared)).toBeTruthy();
    expect(await connection(await createOrg(db, "linear-shared-2"), "linear", shared)).toBeTruthy();
    const orgId = await createOrg(db, "linear-one-active");
    await connection(orgId);
    await expect(connection(orgId)).rejects.toThrow(/accounting_connections_one_active/);
  });

  it("leaves external_links as it was: nothing links a bill to Linear", async () => {
    expect(await definition("external_links_provider_check")).not.toContain("linear");
  });

  it("lets a milestone be verified by a Linear acceptance, keeps every earlier method, and keeps one named check", async () => {
    const orgId = await createOrg(db, "linear-method");
    const id = await milestone(orgId);
    await db.query("update public.milestones set verification_method = 'linear' where id = $1", [id]);
    for (const method of METHODS_BEFORE) await db.query("update public.milestones set verification_method = $2 where id = $1", [id, method]);
    await expect(db.query("update public.milestones set verification_method = 'jira' where id = $1", [id])).rejects.toThrow(/milestones_verification_method_check/);
    const checks = await db.query<{ conname: string }>(
      "select conname from pg_constraint where conrelid = 'public.milestones'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%verification_method%'"
    );
    expect(checks.rows.map((row) => row.conname)).toEqual(["milestones_verification_method_check"]);
  });

  it("never narrows a later widening when it runs again, and 0115 and 0145 run after it keep linear", async () => {
    for (const [table, name] of [
      ["accounting_connections", "accounting_connections_provider_check"],
      ["accounting_tokens", "accounting_tokens_provider_check"],
    ] as const) {
      await db.query(`alter table public.${table} drop constraint ${name}`);
      await db.query(`alter table public.${table} add constraint ${name} check (provider in (${[...PROVIDERS_BEFORE, "linear", "sage"].map((id) => `'${id}'`).join(", ")}))`);
    }
    await db.query("alter table public.milestones drop constraint milestones_verification_method_check");
    await db.query(
      `alter table public.milestones add constraint milestones_verification_method_check check (verification_method in (${[...METHODS_BEFORE, "linear", "jira"].map((id) => `'${id}'`).join(", ")}))`
    );
    await db.exec(sql());
    for (const file of ["0115_asana_acceptance.sql", "0145_google_sheets_connector.sql", "0123_zoho_crm_connections.sql", "0101_accounting_connectors.sql"]) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    }
    expect(await definition("accounting_connections_provider_check")).toContain("'sage'");
    expect(await definition("accounting_tokens_provider_check")).toContain("'sage'");
    expect(await definition("milestones_verification_method_check")).toContain("'jira'");
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check"]) expect(await definition(name)).toContain("'linear'");
    expect(await definition("milestones_verification_method_check")).toContain("'linear'");
  });

  it("says in its header that a later widening keeps linear, and how to undo it by hand", () => {
    expect(sql()).toMatch(/later widening must keep linear/i);
    expect(sql()).toMatch(/-- Down \(by hand/);
    expect(sql().trim().split("\n").filter((line) => !line.startsWith("--")).join("\n").trim().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it("redefines no function an earlier migration made, and adds no webhook table (LN11)", () => {
    const functions = [...sql().matchAll(/create or replace function public\.(\w+)/g)].map((match) => match[1]);
    expect(functions).toEqual(["accept_linear_issue", "hold_linear_acceptance", "linear_connector_ready"]);
    const earlier = migrationFiles()
      .filter((file) => file < FILE)
      .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    for (const name of functions) expect(earlier).not.toContain(name);
    const tables = [...sql().matchAll(/create table if not exists public\.(\w+)/g)].map((match) => match[1]);
    expect(tables).toEqual(["linear_issue_links"]);
  });
});

describe("linear_issue_links (LN3, LN4)", () => {
  it("links an issue to one milestone at a time, and a milestone to one issue", async () => {
    const orgId = await createOrg(db, "linear-links-unique");
    const first = await milestone(orgId);
    const second = await milestone(orgId);
    const issue = crypto.randomUUID();
    const linkId = await link(orgId, first, { issue_id: issue });
    await expect(link(orgId, second, { issue_id: issue })).rejects.toThrow(/linear_issue_links_issue_key/);
    await expect(link(orgId, first)).rejects.toThrow(/linear_issue_links_milestone_key/);
    await db.query("update public.linear_issue_links set unlinked_at = now() where id = $1", [linkId]);
    expect(await link(orgId, second, { issue_id: issue })).toBeTruthy();
  });

  it("holds only with a reason, accepts only with the version accepted, and takes only Linear's ids and links", async () => {
    const orgId = await createOrg(db, "linear-links-checks");
    await expect(link(orgId, await milestone(orgId), { state: "held" })).rejects.toThrow(/linear_issue_links_held_check/);
    await expect(link(orgId, await milestone(orgId), { state: "accepted" })).rejects.toThrow(/linear_issue_links_accepted_check/);
    await expect(link(orgId, await milestone(orgId), { completed: false })).rejects.toThrow(/linear_issue_links_completed_check/);
    await expect(link(orgId, await milestone(orgId), { issue_id: "ENG-123" })).rejects.toThrow(/linear_issue_links_issue_id_check/);
    await expect(link(orgId, await milestone(orgId), { identifier: "eng-123" })).rejects.toThrow(/linear_issue_links_identifier_check/);
    const id = await link(orgId, await milestone(orgId));
    await expect(db.query("update public.linear_issue_links set issue_url = 'https://evil.example/issue/ENG-1' where id = $1", [id])).rejects.toThrow(/linear_issue_links_issue_url_check/);
    await expect(db.query("update public.linear_issue_links set state = 'held', held_reason = 'because' where id = $1", [id])).rejects.toThrow(/linear_issue_links_held_reason_check/);
    await expect(db.query("update public.linear_issue_links set comments_read = 101 where id = $1", [id])).rejects.toThrow(/linear_issue_links_comments_read_check/);
    await expect(db.query("update public.linear_issue_links set attachments_read = 51 where id = $1", [id])).rejects.toThrow(/linear_issue_links_attachments_read_check/);
    for (const reason of ["reopened", "canceled", "deliverable_changed", "archived", "issue_unreachable", "no_criteria", "unlinked"]) {
      await db.query("update public.linear_issue_links set state = 'held', held_reason = $2 where id = $1", [id, reason]);
    }
  });

  it("keeps the deliverables a read finds within the size its check takes, however long their links (Linear acceptance LN6)", async () => {
    const orgId = await createOrg(db, "linear-links-size");
    const id = await link(orgId, await milestone(orgId));
    // Fifty links in one comment, each 470 characters as written, and eight whose letters grow sixfold once encoded.
    const long = Array.from({ length: 50 }, (_, n) => `https://files.example/${String(n).padStart(2, "0")}/${"a".repeat(440)}`);
    const wide = Array.from({ length: 8 }, (_, n) => `https://files.example/${n}/${"é".repeat(400)}`);
    for (const body of [long.join("\n"), wide.join("\n")]) {
      const all = deliverablesOf({ description: "", attachments: [], comments: [{ id: "c1", body, createdAt: null }], identifier: "ENG-1" }).deliverables;
      // Postgres refuses the whole list, as Asana's reading, which bounds the count alone, finds it.
      const unbounded = asanaDeliverablesOf({ notes: "", attachments: [], comments: [{ gid: "c1", text: body, createdAt: null }], taskUrl: null }).deliverables;
      expect(unbounded.length).toBeGreaterThan(all.length);
      await expect(db.query("update public.linear_issue_links set deliverables = $2::jsonb where id = $1", [id, JSON.stringify(unbounded)])).rejects.toThrow(/linear_issue_links_deliverables_check/);
      // The bounded one is taken, and Postgres's own count of its bytes is the one the code makes.
      await db.query("update public.linear_issue_links set deliverables = $2::jsonb where id = $1", [id, JSON.stringify(all)]);
      const stored = (await db.query<{ bytes: number }>("select octet_length(deliverables::text) as bytes from public.linear_issue_links where id = $1", [id])).rows[0].bytes;
      expect(stored).toBe(storedBytes(all));
      expect(stored).toBeLessThanOrEqual(DELIVERABLES_BYTES);
    }
  });

  it("never links another workspace's milestone", async () => {
    const a = await createOrg(db, "linear-links-fk-a");
    const b = await createOrg(db, "linear-links-fk-b");
    await expect(link(a, await milestone(b))).rejects.toThrow(/linear_issue_links_milestone_fkey/);
  });

  it("is read and written by its own workspace only, and never deleted by the tenant role", async () => {
    const a = await createOrg(db, "linear-links-tenant-a");
    const b = await createOrg(db, "linear-links-tenant-b");
    await link(a, await milestone(a));
    const theirs = await link(b, await milestone(b));
    const seen = await asTenant(db, a, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.linear_issue_links")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([a]);
    const updated = await asTenant(db, a, (tx) => tx.query("update public.linear_issue_links set issue_title = 'x' where id = $1", [theirs]));
    expect(updated.affectedRows ?? 0).toBe(0);
    await expect(asTenant(db, a, (tx) => tx.query("delete from public.linear_issue_links where org_id = $1", [a]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select * from public.linear_issue_links"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.linear_issue_links"))).rejects.toThrow(/permission denied/);
  });
});

describe("accept_linear_issue (LN8)", () => {
  it("verifies a pending milestone by a person's acceptance of its completed issue, and changes no amount or payee", async () => {
    const orgId = await createOrg(db, "linear-accept");
    const id = await milestone(orgId);
    const before = await milestoneRow(id);
    const linkId = await link(orgId, id);
    const accepted = await accept(orgId, linkId);
    expect(accepted).toMatchObject({ state: "accepted", accepted_by: person, accepted_fingerprint: FINGERPRINT, accepted_criteria_sha256: sha(CRITERIA) });
    const after = await milestoneRow(id);
    expect(after).toMatchObject({ status: "verified", verified: true, verification_method: "linear", verification_status: "verified" });
    expect(after.verification_detail).toMatchObject({ linearIssue: ISSUE_URL, issueId: expect.any(String), identifier: expect.stringMatching(/^ENG-/), fingerprint: FINGERPRINT, criteriaSha256: sha(CRITERIA), acceptedBy: person });
    expect({ amount: after.amount, contractor: after.contractor_id }).toEqual({ amount: before.amount, contractor: before.contractor_id });
    await expect(accept(orgId, linkId)).rejects.toThrow(/already_accepted/);
  });

  it("refuses an issue not completed or archived, a version not the one shown, criteria missing or changed, and a milestone not open", async () => {
    const orgId = await createOrg(db, "linear-accept-refusals");
    await expect(accept(orgId, await link(orgId, await milestone(orgId), { completed: false, completed_at: null, state: "waiting" }))).rejects.toThrow(/not_completed/);
    await expect(accept(orgId, await link(orgId, await milestone(orgId), { archived: true }))).rejects.toThrow(/archived/);
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
    const a = await createOrg(db, "linear-accept-tenant-a");
    const b = await createOrg(db, "linear-accept-tenant-b");
    await expect(accept(a, await link(b, await milestone(b)))).rejects.toThrow(/link_not_found/);
  });
});

describe("hold_linear_acceptance (LN10)", () => {
  async function accepted(slug: string): Promise<{ orgId: string; milestoneId: string; linkId: string }> {
    const orgId = await createOrg(db, slug);
    const milestoneId = await milestone(orgId);
    const linkId = await link(orgId, milestoneId);
    await accept(orgId, linkId);
    return { orgId, milestoneId, linkId };
  }

  const linkRow = async (id: string) =>
    (await db.query<{ state: string; held_reason: string | null; after_payment: boolean }>("select state, held_reason, after_payment from public.linear_issue_links where id = $1", [id])).rows[0];

  it("takes the verification back from an accepted milestone the agent has not paid, and holds the link for review", async () => {
    const { orgId, milestoneId, linkId } = await accepted("linear-hold");
    expect(await hold(orgId, linkId, "canceled")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "pending", verified: false, verification_status: "unverified" });
    expect((await milestoneRow(milestoneId)).verification_detail).toMatchObject({ heldReason: "canceled" });
    expect(await linkRow(linkId)).toEqual({ state: "held", held_reason: "canceled", after_payment: false });
    // Once held, nothing more: only an accepted link is held.
    expect(await hold(orgId, linkId, "deliverable_changed")).toBe("not_accepted");
  });

  it("takes every reason the reads give, and refuses any other", async () => {
    for (const reason of ["reopened", "canceled", "deliverable_changed", "archived", "issue_unreachable", "unlinked"]) {
      const { orgId, linkId } = await accepted(`linear-hold-${reason.replace(/_/g, "-")}`);
      expect(await hold(orgId, linkId, reason), reason).toBe("held");
    }
    const { orgId, linkId } = await accepted("linear-hold-bad");
    await expect(hold(orgId, linkId, "no_criteria")).rejects.toThrow(/bad_reason/);
  });

  it("leaves a milestone whose payment is under way or paid, and holds the link as changed after payment", async () => {
    const { orgId, milestoneId, linkId } = await accepted("linear-hold-paying");
    await db.query(
      "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, status) values ($1, 'milestone', $2, $3, 'circle', 450, '0x1', 'pending')",
      [orgId, milestoneId, `linear-${milestoneId}`]
    );
    expect(await hold(orgId, linkId, "reopened")).toBe("held_after_payment");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "verified", verified: true });
    expect(await linkRow(linkId)).toEqual({ state: "held", held_reason: "reopened", after_payment: true });
  });

  it("takes it back after a transfer that failed, which moved nothing", async () => {
    const { orgId, milestoneId, linkId } = await accepted("linear-hold-failed");
    await db.query(
      "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, status) values ($1, 'milestone', $2, $3, 'circle', 450, '0x1', 'failed')",
      [orgId, milestoneId, `linear-failed-${milestoneId}`]
    );
    await db.query("update public.milestones set status = 'held' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "pending", verified: false });
  });

  it("waits while a person is deciding the milestone, and acts once the claim is old", async () => {
    const { orgId, milestoneId, linkId } = await accepted("linear-hold-claimed");
    await db.query("update public.milestones set status = 'held', decision_claimed_by = $2, decision_claimed_at = now() where id = $1", [milestoneId, other]);
    expect(await hold(orgId, linkId, "reopened")).toBe("deferred");
    expect((await linkRow(linkId)).state).toBe("accepted");
    await db.query("update public.milestones set decision_claimed_at = now() - interval '11 minutes' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
  });

  it("leaves a milestone verified another way alone, and holds only the link", async () => {
    const { orgId, milestoneId, linkId } = await accepted("linear-hold-other-method");
    await db.query("update public.milestones set verification_method = 'manual' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "verified", verified: true, verification_method: "manual" });
  });

  it("never holds another workspace's link", async () => {
    const { orgId, linkId } = await accepted("linear-hold-tenant");
    const stranger = await createOrg(db, "linear-hold-stranger");
    expect(await hold(stranger, linkId, "reopened")).toBe("not_accepted");
    expect((await linkRow(linkId)).state).toBe("accepted");
    expect(orgId).toBeTruthy();
  });
});

describe("linear_connector_ready(p_org_id) (LN3)", () => {
  it("answers true to the tenant role, and to no one signed in", async () => {
    const orgId = await createOrg(db, "linear-ready");
    const ready = await asTenant(db, orgId, async (tx) => (await tx.query<{ ready: boolean }>("select public.linear_connector_ready(p_org_id => $1::uuid) as ready", [orgId])).rows[0].ready);
    expect(ready).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.linear_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.linear_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
    for (const fn of ["accept_linear_issue(p_org_id => $1::uuid, p_link_id => $1::uuid, p_by => $1::uuid, p_fingerprint => 'x', p_criteria_sha256 => 'x', p_note => 'x')", "hold_linear_acceptance(p_org_id => $1::uuid, p_link_id => $1::uuid, p_reason => 'reopened')"]) {
      await expect(asRole(db, "authenticated", (tx) => tx.query(`select public.${fn}`, [orgId]))).rejects.toThrow(/permission denied/);
    }
  });
});
