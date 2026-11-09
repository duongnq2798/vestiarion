import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deliverable } from "@/lib/asana/deliverables";
import { DELIVERABLES_BYTES, storedBytes } from "@/lib/linear/deliverables";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, migrationFiles, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0149 (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR5, JR11, JR13, JR14, JR19): Jira on the
 * connector core's tables beside every provider they took, a milestone verified by a Jira acceptance beside every method
 * it took, the issues linked to milestones (`jira_issue_links`, keyed by site and numeric issue id, with no Atlassian
 * person data), the sites and their webhooks (`jira_sites`, a platform table found by webhook id), the two moves that
 * touch a milestone (accepting a done issue, and holding an acceptance the issue no longer bears out), and the readiness
 * probe. Re-runnable, and never narrowing a check a later migration widened.
 */

const FILE = "0149_jira_acceptance.sql";
const sql = () => readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const PROVIDERS_BEFORE = ["xero", "quickbooks", "hubspot", "asana", "pipedrive", "zohobooks", "zohocrm", "googlesheets", "linear", "googledrive"];
const METHODS_BEFORE = ["unverified", "github", "manual", "seed", "asana", "linear"];

let db: PGlite;
let person: string;
let other: string;

const sha = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const FINGERPRINT = "a".repeat(64);
const CRITERIA = "Webhook deliveries retried with backoff, with tests, merged behind its flag.";
const SITE = "https://northstar.atlassian.net";

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file: the earlier widenings, then this one, again.
  await applyMigrations(db, (file) =>
    ["0101_", "0105_", "0115_", "0116_", "0122_", "0123_", "0145_", "0147_", "0148_", "0149_"].some((prefix) => file.startsWith(prefix))
  );
  person = await createUser(db, "owner-jira@example.com");
  other = await createUser(db, "admin-jira@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const definition = async (name: string) =>
  (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [name])).rows[0]?.def ?? "";

async function connection(orgId: string, provider = "jira", externalOrgId: string = crypto.randomUUID()): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, status, connected_by, consent_version, consented_at, window_from)
       values ($1, $2, $3, 'Northstar', 'connected', $4, $5, now(), '2026-08-11') returning id`,
      [orgId, provider, externalOrgId, person, `${provider}-2026-11-09`]
    )
  ).rows[0].id;
}

async function milestone(orgId: string, fields: { status?: string; criteria?: string | null } = {}): Promise<string> {
  const contractor = (
    await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Northstar Studio', 'contractor') returning id", [orgId])
  ).rows[0].id;
  return (
    await db.query<{ id: string }>(
      "insert into public.milestones (org_id, contractor_id, title, amount, status, acceptance_criteria) values ($1, $2, 'Webhook retries', 450, $3, $4) returning id",
      [orgId, contractor, fields.status ?? "pending", fields.criteria === undefined ? CRITERIA : fields.criteria]
    )
  ).rows[0].id;
}

/** The workspace's one Jira connection and the site it reads, made on first use. */
const connections = new Map<string, { id: string; cloudId: string }>();
async function jiraConnection(orgId: string, cloudId: string = crypto.randomUUID()): Promise<{ id: string; cloudId: string }> {
  const known = connections.get(orgId);
  if (known) return known;
  const made = { id: await connection(orgId, "jira", cloudId), cloudId };
  connections.set(orgId, made);
  return made;
}

const issueNumber = () => String(crypto.randomInt(10_000, 999_999_999));

async function link(orgId: string, milestoneId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const site = await jiraConnection(orgId);
  const key = `ENG-${crypto.randomInt(1, 999_999)}`;
  const row = {
    connection_id: site.id,
    cloud_id: site.cloudId,
    issue_id: issueNumber(),
    identifier: key,
    issue_url: `${SITE}/browse/${key}`,
    status_category: "done",
    status_name: "Done",
    resolution_name: "Done",
    completed: true,
    completed_at: "2026-11-09T09:00:00Z",
    deliverable_fingerprint: FINGERPRINT,
    state: "ready",
    held_reason: null,
    ...fields,
  };
  return (
    await db.query<{ id: string }>(
      `insert into public.jira_issue_links (org_id, milestone_id, connection_id, cloud_id, issue_id, identifier, project_id, project_key, issue_title, issue_url,
         state, held_reason, status_category, status_name, resolution_name, completed, completed_at, deliverables, deliverable_fingerprint)
       values ($1, $2, $3, $4, $5, $6, '10000', 'ENG', 'Webhook retries with backoff', $7, $8, $9, $10, $11, $12, $13, $14,
         '[{"kind":"attachment","id":"remotelink:10001","label":"github.com/northstar/app/pull/42","href":"https://github.com/northstar/app/pull/42","version":"https://github.com/northstar/app/pull/42"}]'::jsonb, $15) returning id`,
      [
        orgId, milestoneId, row.connection_id, row.cloud_id, row.issue_id, row.identifier, row.issue_url,
        row.state, row.held_reason, row.status_category, row.status_name, row.resolution_name, row.completed, row.completed_at, row.deliverable_fingerprint,
      ]
    )
  ).rows[0].id;
}

const accept = (orgId: string, linkId: string, fields: { fingerprint?: string; criteria?: string } = {}) =>
  asTenant(db, orgId, async (tx) =>
    (
      await tx.query<Record<string, unknown>>("select * from public.accept_jira_issue($1, $2, $3, $4, $5, $6)", [
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
  asTenant(db, orgId, async (tx) => (await tx.query<{ hold_jira_acceptance: string }>("select public.hold_jira_acceptance($1, $2, $3)", [orgId, linkId, reason])).rows[0].hold_jira_acceptance);

const milestoneRow = async (id: string) =>
  (
    await db.query<{ status: string; verified: boolean; verification_method: string; verification_status: string; amount: string; contractor_id: string; verification_detail: Record<string, unknown> }>(
      "select status, verified, verification_method, verification_status, amount, contractor_id, verification_detail from public.milestones where id = $1",
      [id]
    )
  ).rows[0];

async function site(orgId: string, connectionId: string, fields: Record<string, unknown> = {}): Promise<void> {
  const row = { cloud_id: crypto.randomUUID(), site_url: SITE, webhook_ids: [], retired_webhook_ids: [], webhook_jql: null, ...fields };
  await db.query(
    "insert into public.jira_sites (connection_id, org_id, cloud_id, site_url, webhook_ids, retired_webhook_ids, webhook_jql) values ($1, $2, $3, $4, $5::bigint[], $6::bigint[], $7)",
    [connectionId, orgId, row.cloud_id, row.site_url, row.webhook_ids, row.retired_webhook_ids, row.webhook_jql]
  );
}

describe("the core's tables take Jira (Jira acceptance JR5)", () => {
  it("accepts jira beside every provider taken before, after 0101, 0105, 0115, 0116, 0122, 0123, 0145, 0147, 0148 and 0149 ran again", async () => {
    const orgId = await createOrg(db, "jira-checks");
    const id = await connection(orgId);
    await db.query(
      `insert into public.accounting_tokens (id, org_id, provider, connection_id, authorized_by, access_token_enc, refresh_token_enc, access_expires_at)
       values (gen_random_uuid(), $1, 'jira', $2, $3, '{"v":1}', '{"v":1}', now())`,
      [orgId, id, person]
    );
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check"]) {
      const def = await definition(name);
      const listed = [...def.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
      expect(listed, name).toEqual([...PROVIDERS_BEFORE, "jira"]);
    }
    await expect(connection(await createOrg(db, "jira-checks-sage"), "sage")).rejects.toThrow(/accounting_connections_provider_check/);
  });

  it("lets two workspaces connect the same Jira site, and keeps one live Jira connection per workspace (JR2)", async () => {
    const shared = crypto.randomUUID();
    expect(await connection(await createOrg(db, "jira-shared-1"), "jira", shared)).toBeTruthy();
    expect(await connection(await createOrg(db, "jira-shared-2"), "jira", shared)).toBeTruthy();
    const orgId = await createOrg(db, "jira-one-active");
    await connection(orgId);
    await expect(connection(orgId)).rejects.toThrow(/accounting_connections_one_active/);
  });

  it("leaves external_links as it was: nothing is ever booked to Jira (JR1)", async () => {
    expect(await definition("external_links_provider_check")).not.toContain("jira");
  });

  it("lets a milestone be verified by a Jira acceptance, keeps every earlier method, and keeps one named check", async () => {
    const orgId = await createOrg(db, "jira-method");
    const id = await milestone(orgId);
    await db.query("update public.milestones set verification_method = 'jira' where id = $1", [id]);
    for (const method of METHODS_BEFORE) await db.query("update public.milestones set verification_method = $2 where id = $1", [id, method]);
    await expect(db.query("update public.milestones set verification_method = 'sage' where id = $1", [id])).rejects.toThrow(/milestones_verification_method_check/);
    const checks = await db.query<{ conname: string; def: string }>(
      "select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.milestones'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%verification_method%'"
    );
    expect(checks.rows.map((row) => row.conname)).toEqual(["milestones_verification_method_check"]);
    expect([...checks.rows[0].def.matchAll(/'([a-z]+)'/g)].map((match) => match[1])).toEqual([...METHODS_BEFORE, "jira"]);
  });

  it("never narrows a later widening when 0149, 0148 or 0147 runs again, and the earlier widenings run after it keep jira", async () => {
    for (const [table, name] of [
      ["accounting_connections", "accounting_connections_provider_check"],
      ["accounting_tokens", "accounting_tokens_provider_check"],
    ] as const) {
      await db.query(`alter table public.${table} drop constraint ${name}`);
      await db.query(`alter table public.${table} add constraint ${name} check (provider in (${[...PROVIDERS_BEFORE, "jira", "sage"].map((id) => `'${id}'`).join(", ")}))`);
    }
    await db.query("alter table public.milestones drop constraint milestones_verification_method_check");
    await db.query(
      `alter table public.milestones add constraint milestones_verification_method_check check (verification_method in (${[...METHODS_BEFORE, "jira", "sage"].map((id) => `'${id}'`).join(", ")}))`
    );
    for (const file of [
      FILE,
      "0148_google_drive_intake.sql",
      "0147_linear_acceptance.sql",
      "0115_asana_acceptance.sql",
      "0145_google_sheets_connector.sql",
      "0123_zoho_crm_connections.sql",
      "0101_accounting_connectors.sql",
    ]) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    }
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check", "milestones_verification_method_check"]) {
      expect(await definition(name), name).toContain("'sage'");
      expect(await definition(name), name).toContain("'jira'");
    }
    for (const name of ["accounting_connections_provider_check", "accounting_tokens_provider_check"]) {
      for (const provider of ["linear", "googledrive"]) expect(await definition(name), `${name} ${provider}`).toContain(`'${provider}'`);
    }
    expect(await definition("milestones_verification_method_check")).toContain("'linear'");
  });

  it("says in its header that a later widening keeps jira, when to merge it, what the app reads as not set up, and how to undo it by hand", () => {
    const text = sql();
    expect(text).toMatch(/A later widening must keep jira beside its own value/);
    expect(text).toMatch(/additive, and idempotent/i);
    for (const check of ["accounting_connections_provider_check", "accounting_tokens_provider_check", "milestones_verification_method_check"]) {
      expect(text.split("\n").filter((line) => line.startsWith("-- Merge it after") || line.startsWith("-- or ")).join(" "), check).toContain(check);
    }
    const notSetUp = text.split("\n").filter((line) => line.startsWith("--")).join(" ");
    for (const code of ["PGRST205", "PGRST202", "PGRST204", "42P01", "42703", "42883"]) expect(notSetUp, code).toContain(code);
    expect(text).toMatch(/-- Down \(by hand/);
    expect(text.trim().split("\n").filter((line) => !line.startsWith("--")).join("\n").trim().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it("redefines no function an earlier migration made, and adds the link table and the site table only", () => {
    const functions = [...sql().matchAll(/create or replace function public\.(\w+)/g)].map((match) => match[1]);
    expect(functions).toEqual(["accept_jira_issue", "hold_jira_acceptance", "jira_connector_ready"]);
    const earlier = migrationFiles()
      .filter((file) => file < FILE)
      .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    for (const name of [...functions, "jira_issue_links", "jira_sites"]) expect(earlier).not.toContain(name);
    const tables = [...sql().matchAll(/create table if not exists public\.(\w+)/g)].map((match) => match[1]);
    expect(tables).toEqual(["jira_issue_links", "jira_sites"]);
    // The sweeper's accounting_connections_due (0101) is never redefined here: a run from a branch without it would revert it.
    const statements = sql()
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/accounting_connections_due/);
  });

  it("makes the three functions, invoker rights with an empty search path, and the two tables", async () => {
    const fns = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; args: string }>(
      `select proname, prosecdef, proconfig, pg_get_function_identity_arguments(oid) as args from pg_proc
        where pronamespace = 'public'::regnamespace and proname = any($1) order by proname`,
      [["accept_jira_issue", "hold_jira_acceptance", "jira_connector_ready"]]
    );
    expect(fns.rows.map((row) => [row.proname, row.args])).toEqual([
      ["accept_jira_issue", "p_org_id uuid, p_link_id uuid, p_by uuid, p_fingerprint text, p_criteria_sha256 text, p_note text"],
      ["hold_jira_acceptance", "p_org_id uuid, p_link_id uuid, p_reason text"],
      ["jira_connector_ready", "p_org_id uuid"],
    ]);
    for (const fn of fns.rows) {
      expect(fn.prosecdef, fn.proname).toBe(false);
      expect(fn.proconfig, fn.proname).toEqual(['search_path=""']);
    }
    const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1) and relkind = 'r' order by relname",
      [["jira_issue_links", "jira_sites"]]
    );
    expect(tables.rows).toEqual([
      { relname: "jira_issue_links", relrowsecurity: true },
      { relname: "jira_sites", relrowsecurity: true },
    ]);
  });
});

describe("jira_issue_links (JR5, JR6, JR19)", () => {
  it("links an issue of a site to one milestone at a time, and a milestone to one issue", async () => {
    const orgId = await createOrg(db, "jira-links-unique");
    const first = await milestone(orgId);
    const second = await milestone(orgId);
    const issue = issueNumber();
    const linkId = await link(orgId, first, { issue_id: issue });
    await expect(link(orgId, second, { issue_id: issue })).rejects.toThrow(/jira_issue_links_issue_key/);
    await expect(link(orgId, first)).rejects.toThrow(/jira_issue_links_milestone_key/);
    await db.query("update public.jira_issue_links set unlinked_at = now() where id = $1", [linkId]);
    expect(await link(orgId, second, { issue_id: issue })).toBeTruthy();
  });

  it("takes the same issue id on another site: ids are unique on their site only (JR16)", async () => {
    const orgId = await createOrg(db, "jira-links-two-sites");
    const issue = issueNumber();
    const old = await jiraConnection(orgId);
    await link(orgId, await milestone(orgId), { issue_id: issue });
    // The old site disconnected and another connected: the old link stays, and the new site's issue of the same id links.
    await db.query("update public.accounting_connections set status = 'revoked', revoked_at = now() where id = $1", [old.id]);
    const cloudId = crypto.randomUUID();
    const next = await connection(orgId, "jira", cloudId);
    expect(await link(orgId, await milestone(orgId), { issue_id: issue, connection_id: next, cloud_id: cloudId })).toBeTruthy();
    await expect(link(orgId, await milestone(orgId), { issue_id: issue, connection_id: next, cloud_id: cloudId })).rejects.toThrow(/jira_issue_links_issue_key/);
    // Two workspaces may link the same issue of a site they both connected.
    const neighbour = await createOrg(db, "jira-links-two-sites-neighbour");
    await jiraConnection(neighbour, cloudId);
    expect(await link(neighbour, await milestone(neighbour), { issue_id: issue, cloud_id: cloudId })).toBeTruthy();
  });

  it("holds only with a reason, accepts only with the version accepted, and takes only Jira's ids, keys and links", async () => {
    const orgId = await createOrg(db, "jira-links-checks");
    await expect(link(orgId, await milestone(orgId), { state: "held" })).rejects.toThrow(/jira_issue_links_held_check/);
    await expect(link(orgId, await milestone(orgId), { state: "accepted" })).rejects.toThrow(/jira_issue_links_accepted_check/);
    await expect(link(orgId, await milestone(orgId), { completed: false })).rejects.toThrow(/jira_issue_links_completed_check/);
    await expect(link(orgId, await milestone(orgId), { cloud_id: "northstar" })).rejects.toThrow(/jira_issue_links_cloud_id_check/);
    for (const issueId of ["ENG-142", crypto.randomUUID(), "1".repeat(19), ""]) {
      await expect(link(orgId, await milestone(orgId), { issue_id: issueId }), issueId).rejects.toThrow(/jira_issue_links_issue_id_check/);
    }
    for (const identifier of ["eng-142", "ENG142", "1ENG-142", `E${"N".repeat(50)}-1`, `ENG-${"1".repeat(19)}`]) {
      await expect(link(orgId, await milestone(orgId), { identifier }), identifier).rejects.toThrow(/jira_issue_links_identifier_check/);
    }
    for (const statusCategory of ["Done", "in progress", "x".repeat(41)]) {
      await expect(link(orgId, await milestone(orgId), { status_category: statusCategory }), statusCategory).rejects.toThrow(/jira_issue_links_status_category_check/);
    }
    await expect(link(orgId, await milestone(orgId), { status_name: "" })).rejects.toThrow(/jira_issue_links_status_name_check/);
    await expect(link(orgId, await milestone(orgId), { resolution_name: "r".repeat(201) })).rejects.toThrow(/jira_issue_links_resolution_name_check/);
    const id = await link(orgId, await milestone(orgId), { resolution_name: null });
    for (const url of [
      "http://northstar.atlassian.net/browse/ENG-142",
      "https://northstar.atlassian.net/issues/ENG-142",
      "https://northstar.atlassian.net/browse/ENG-142?focusedCommentId=1",
      "https://north star.atlassian.net/browse/ENG-142",
      `https://${"n".repeat(254)}/browse/ENG-142`,
    ]) {
      await expect(db.query("update public.jira_issue_links set issue_url = $2 where id = $1", [id, url]), url).rejects.toThrow(/jira_issue_links_issue_url_check/);
    }
    await expect(db.query("update public.jira_issue_links set issue_title = $2 where id = $1", [id, "t".repeat(256)])).rejects.toThrow(/jira_issue_links_issue_title_check/);
    await db.query("update public.jira_issue_links set issue_title = $2 where id = $1", [id, "t".repeat(255)]);
    await expect(db.query("update public.jira_issue_links set project_id = 'ENG' where id = $1", [id])).rejects.toThrow(/jira_issue_links_project_id_check/);
    await expect(db.query("update public.jira_issue_links set project_key = 'eng' where id = $1", [id])).rejects.toThrow(/jira_issue_links_project_key_check/);
    await db.query("update public.jira_issue_links set project_id = null, project_key = null where id = $1", [id]);
    await expect(db.query("update public.jira_issue_links set state = 'held', held_reason = 'archived' where id = $1", [id])).rejects.toThrow(/jira_issue_links_held_reason_check/);
    for (const column of ["attachments_read", "remote_links_read", "comments_read"]) {
      await expect(db.query(`update public.jira_issue_links set ${column} = 51 where id = $1`, [id]), column).rejects.toThrow(new RegExp(`jira_issue_links_${column}_check`));
      await expect(db.query(`update public.jira_issue_links set ${column} = -1 where id = $1`, [id]), column).rejects.toThrow(new RegExp(`jira_issue_links_${column}_check`));
      await db.query(`update public.jira_issue_links set ${column} = 50 where id = $1`, [id]);
    }
    for (const reason of ["reopened", "canceled", "deliverable_changed", "issue_unreachable", "no_criteria", "unlinked"]) {
      await db.query("update public.jira_issue_links set state = 'held', held_reason = $2 where id = $1", [id, reason]);
    }
  });

  it("keeps no Atlassian person and no archived flag: no completed_by, assignee, team or archived column (JR19)", async () => {
    const columns = (
      await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'jira_issue_links' order by ordinal_position"
      )
    ).rows.map((row) => row.column_name);
    expect(columns).toEqual([
      "id", "org_id", "milestone_id", "connection_id", "cloud_id", "issue_id", "identifier", "project_id", "project_key", "issue_title", "issue_url",
      "state", "held_reason", "after_payment", "held_at", "status_category", "status_name", "resolution_name", "completed", "completed_at",
      "deliverables", "deliverable_fingerprint", "attachments_read", "remote_links_read", "comments_read", "more_unread", "issue_updated_at",
      "last_read_at", "read_error", "accepted_by", "accepted_at", "accepted_fingerprint", "accepted_completed_at", "accepted_criteria_sha256",
      "accepted_deliverables", "linked_by", "linked_at", "unlinked_by", "unlinked_at", "updated_at",
    ]);
    for (const column of columns) expect(column).not.toMatch(/completed_by|assignee|team|archived|account|email|reporter|creator/);
  });

  it("keeps deliverables within the size its check takes, as the code counts it (JR8)", async () => {
    const orgId = await createOrg(db, "jira-links-size");
    const id = await link(orgId, await milestone(orgId));
    const item = (n: number): Deliverable => ({ kind: "comment_link", id: `https://files.example/${n}/${"a".repeat(440)}`, label: `files.example/${n}`, href: `https://files.example/${n}/${"a".repeat(440)}` });
    const within: Deliverable[] = [];
    while (storedBytes([...within, item(within.length)]) <= DELIVERABLES_BYTES) within.push(item(within.length));
    await db.query("update public.jira_issue_links set deliverables = $2::jsonb where id = $1", [id, JSON.stringify(within)]);
    const stored = (await db.query<{ bytes: number }>("select octet_length(deliverables::text) as bytes from public.jira_issue_links where id = $1", [id])).rows[0].bytes;
    expect(stored).toBe(storedBytes(within));
    const over = [...within];
    while (storedBytes(over) <= 32_000) over.push(item(over.length));
    await expect(db.query("update public.jira_issue_links set deliverables = $2::jsonb where id = $1", [id, JSON.stringify(over)])).rejects.toThrow(/jira_issue_links_deliverables_check/);
    await expect(db.query("update public.jira_issue_links set accepted_deliverables = $2::jsonb where id = $1", [id, JSON.stringify(over)])).rejects.toThrow(/jira_issue_links_accepted_deliverables_check/);
    await expect(db.query("update public.jira_issue_links set deliverables = '{}'::jsonb where id = $1", [id])).rejects.toThrow(/jira_issue_links_deliverables_check/);
  });

  it("never links another workspace's milestone or connection", async () => {
    const a = await createOrg(db, "jira-links-fk-a");
    const b = await createOrg(db, "jira-links-fk-b");
    await expect(link(a, await milestone(b))).rejects.toThrow(/jira_issue_links_milestone_fkey/);
    const theirs = await jiraConnection(b);
    await expect(link(a, await milestone(a), { connection_id: theirs.id })).rejects.toThrow(/jira_issue_links_connection_fkey/);
  });

  it("goes with its milestone and its connection", async () => {
    const orgId = await createOrg(db, "jira-links-cascade");
    const milestoneId = await milestone(orgId);
    const gone = await link(orgId, milestoneId);
    await db.query("delete from public.milestones where id = $1", [milestoneId]);
    expect((await db.query("select 1 from public.jira_issue_links where id = $1", [gone])).rows).toEqual([]);
    const kept = await link(orgId, await milestone(orgId));
    await db.query("delete from public.accounting_connections where id = $1", [(await jiraConnection(orgId)).id]);
    expect((await db.query("select 1 from public.jira_issue_links where id = $1", [kept])).rows).toEqual([]);
  });

  it("is read and written by its own workspace only, and never deleted by the tenant role", async () => {
    const a = await createOrg(db, "jira-links-tenant-a");
    const b = await createOrg(db, "jira-links-tenant-b");
    await link(a, await milestone(a));
    const theirs = await link(b, await milestone(b));
    const seen = await asTenant(db, a, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.jira_issue_links")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([a]);
    const updated = await asTenant(db, a, (tx) => tx.query("update public.jira_issue_links set issue_title = 'x' where id = $1", [theirs]));
    expect(updated.affectedRows ?? 0).toBe(0);
    await expect(asTenant(db, a, (tx) => tx.query("delete from public.jira_issue_links where org_id = $1", [a]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select * from public.jira_issue_links"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.jira_issue_links"))).rejects.toThrow(/permission denied/);
    const policies = await db.query<{ policyname: string; permissive: string }>(
      "select policyname, permissive from pg_policies where schemaname = 'public' and tablename = 'jira_issue_links' order by policyname"
    );
    expect(policies.rows).toEqual([
      { policyname: "tenant_isolation", permissive: "PERMISSIVE" },
      { policyname: "tenant_isolation_guard", permissive: "RESTRICTIVE" },
    ]);
  });
});

describe("jira_sites (JR5, JR14, JR15)", () => {
  it("holds a site's cloud id, address, webhook ids and words within their checks", async () => {
    const orgId = await createOrg(db, "jira-sites-checks");
    const connectionId = await connection(orgId);
    const refused = async (fields: Record<string, unknown>, check: RegExp) => {
      await expect(site(orgId, connectionId, fields), JSON.stringify(fields).slice(0, 80)).rejects.toThrow(check);
    };
    await refused({ cloud_id: "northstar" }, /jira_sites_cloud_id_check/);
    for (const url of [
      "http://northstar.atlassian.net",
      "https://northstar.atlassian.net/",
      "https://northstar.atlassian.net/jira",
      "https://Northstar.atlassian.net",
      "https://northstar",
      "https://-northstar.atlassian.net",
      "https://northstar.atlassian.net:443",
      `https://${"n".repeat(250)}.net`,
    ]) {
      await refused({ site_url: url }, /jira_sites_site_url_check/);
    }
    await refused({ webhook_ids: [1, 2, 3, 4, 5, 6] }, /jira_sites_webhook_ids_check/);
    await refused({ retired_webhook_ids: [1, 2, 3, 4, 5, 6] }, /jira_sites_retired_webhook_ids_check/);
    await refused({ webhook_jql: "" }, /jira_sites_webhook_jql_check/);
    await refused({ webhook_jql: "p".repeat(4001) }, /jira_sites_webhook_jql_check/);
    await site(orgId, connectionId, { site_url: "https://northstar-eng.atlassian.net", webhook_ids: [1, 2, 3, 4, 5], retired_webhook_ids: [6, 7, 8, 9, 10], webhook_jql: "project in (10000, 10001)" });
    await expect(site(orgId, connectionId)).rejects.toThrow(/jira_sites_pkey/);
    await expect(db.query("update public.jira_sites set webhook_error = $2 where connection_id = $1", [connectionId, "e".repeat(301)])).rejects.toThrow(/jira_sites_webhook_error_check/);
    await expect(db.query("update public.jira_sites set webhook_error = '' where connection_id = $1", [connectionId])).rejects.toThrow(/jira_sites_webhook_error_check/);
    await db.query("update public.jira_sites set webhook_error = $2 where connection_id = $1", [connectionId, "e".repeat(300)]);
  });

  it("never names another workspace's connection", async () => {
    const a = await createOrg(db, "jira-sites-fk-a");
    const b = await createOrg(db, "jira-sites-fk-b");
    await expect(site(a, await connection(b))).rejects.toThrow(/jira_sites_connection_fkey/);
  });

  it("finds the rows whose current or retired webhook ids a delivery names, by overlap", async () => {
    const a = await createOrg(db, "jira-sites-overlap-a");
    const b = await createOrg(db, "jira-sites-overlap-b");
    const c = await createOrg(db, "jira-sites-overlap-c");
    const [ca, cb, cc] = [await connection(a), await connection(b), await connection(c)];
    await site(a, ca, { webhook_ids: [900_001] });
    await site(b, cb, { webhook_ids: [900_003], retired_webhook_ids: [900_001] });
    await site(c, cc, { webhook_ids: [900_004] });
    const matched = (
      await asServiceRole(db, (tx) =>
        tx.query<{ connection_id: string }>(
          "select connection_id from public.jira_sites where webhook_ids && $1::bigint[] or retired_webhook_ids && $1::bigint[]",
          [[900_001, 900_002]]
        )
      )
    ).rows.map((row) => row.connection_id);
    expect(matched.sort()).toEqual([ca, cb].sort());
    const indexes = (await db.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and tablename = 'jira_sites' order by indexname")).rows.map(
      (row) => row.indexdef
    );
    expect(indexes.some((def) => /using gin \(retired_webhook_ids\)/i.test(def))).toBe(true);
    expect(indexes.some((def) => /using gin \(webhook_ids\)/i.test(def))).toBe(true);
  });

  it("goes with its connection, and with its workspace", async () => {
    const orgId = await createOrg(db, "jira-sites-cascade");
    const first = await connection(orgId);
    await site(orgId, first);
    await db.query("delete from public.accounting_connections where id = $1", [first]);
    expect((await db.query("select 1 from public.jira_sites where connection_id = $1", [first])).rows).toEqual([]);
    const gone = await createOrg(db, "jira-sites-cascade-org");
    await site(gone, await connection(gone));
    await db.query("delete from public.orgs where id = $1", [gone]);
    expect((await db.query("select 1 from public.jira_sites where org_id = $1", [gone])).rows).toEqual([]);
  });

  it("has RLS on, no policy, and no grant to the browser roles or the tenant role: the service role alone reads it", async () => {
    const orgId = await createOrg(db, "jira-sites-grants");
    await site(orgId, await connection(orgId));
    expect((await db.query("select 1 from pg_policies where schemaname = 'public' and tablename = 'jira_sites'")).rows).toHaveLength(0);
    for (const role of ["anon", "authenticated", "vestiarion_tenant"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const granted = (await db.query<{ ok: boolean }>("select has_table_privilege($1, 'public.jira_sites', $2) as ok", [role, privilege])).rows[0].ok;
        expect(granted, `${role} ${privilege}`).toBe(false);
      }
    }
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.jira_sites"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.jira_sites"))).rejects.toThrow(/permission denied/);
    const rows = await asServiceRole(db, async (tx) => (await tx.query("select org_id from public.jira_sites where org_id = $1", [orgId])).rows);
    expect(rows).toHaveLength(1);
  });
});

describe("accept_jira_issue (JR11)", () => {
  it("verifies a pending milestone by a person's acceptance of its done issue, and changes no amount or payee", async () => {
    const orgId = await createOrg(db, "jira-accept");
    const id = await milestone(orgId);
    const before = await milestoneRow(id);
    const linkId = await link(orgId, id);
    const accepted = await accept(orgId, linkId);
    expect(accepted).toMatchObject({ state: "accepted", accepted_by: person, accepted_fingerprint: FINGERPRINT, accepted_criteria_sha256: sha(CRITERIA) });
    expect(accepted.accepted_deliverables).toEqual([
      { kind: "attachment", id: "remotelink:10001", label: "github.com/northstar/app/pull/42", href: "https://github.com/northstar/app/pull/42", version: "https://github.com/northstar/app/pull/42" },
    ]);
    const after = await milestoneRow(id);
    expect(after).toMatchObject({ status: "verified", verified: true, verification_method: "jira", verification_status: "verified" });
    expect(after.verification_detail).toEqual({
      note: "Accepted against its criteria",
      jiraIssue: expect.stringMatching(/^https:\/\/northstar\.atlassian\.net\/browse\/ENG-\d+$/),
      issueId: expect.stringMatching(/^\d+$/),
      identifier: expect.stringMatching(/^ENG-\d+$/),
      cloudId: (await jiraConnection(orgId)).cloudId,
      completedAt: expect.stringMatching(/^2026-11-09T09:00:00/),
      fingerprint: FINGERPRINT,
      criteriaSha256: sha(CRITERIA),
      acceptedBy: person,
    });
    expect({ amount: after.amount, contractor: after.contractor_id }).toEqual({ amount: before.amount, contractor: before.contractor_id });
    await expect(accept(orgId, linkId)).rejects.toThrow(/already_accepted/);
  });

  it("refuses an issue not done (canceled included), a version not the one shown, criteria missing or changed, a payment sent, and a milestone not open", async () => {
    const orgId = await createOrg(db, "jira-accept-refusals");
    await expect(accept(orgId, await link(orgId, await milestone(orgId), { completed: false, completed_at: null, state: "waiting", status_category: "indeterminate" }))).rejects.toThrow(
      /not_completed/
    );
    // Won't Do sits in Jira's Done category, and is read as canceled, never done (JR9).
    await expect(
      accept(orgId, await link(orgId, await milestone(orgId), { completed: false, completed_at: null, state: "held", held_reason: "canceled", resolution_name: "Won't Do" }))
    ).rejects.toThrow(/not_completed/);
    await expect(accept(orgId, await link(orgId, await milestone(orgId)), { fingerprint: "b".repeat(64) })).rejects.toThrow(/stale/);
    await expect(accept(orgId, await link(orgId, await milestone(orgId), { deliverable_fingerprint: null }))).rejects.toThrow(/stale/);
    await expect(accept(orgId, await link(orgId, await milestone(orgId, { criteria: null })))).rejects.toThrow(/no_criteria/);
    await expect(accept(orgId, await link(orgId, await milestone(orgId)), { criteria: "Something else" })).rejects.toThrow(/criteria_changed/);
    const paid = await link(orgId, await milestone(orgId));
    await db.query("update public.jira_issue_links set state = 'held', held_reason = 'reopened', after_payment = true where id = $1", [paid]);
    await expect(accept(orgId, paid)).rejects.toThrow(/after_payment/);
    for (const status of ["verified", "held", "paid", "closed"]) {
      const id = await milestone(orgId, { status });
      await expect(accept(orgId, await link(orgId, id)), status).rejects.toThrow(new RegExp(`milestone_not_open: the milestone is ${status} now`));
      expect((await milestoneRow(id)).verification_method).toBe("unverified");
    }
  });

  it("never accepts an unlinked link, or another workspace's", async () => {
    const a = await createOrg(db, "jira-accept-tenant-a");
    const b = await createOrg(db, "jira-accept-tenant-b");
    await expect(accept(a, await link(b, await milestone(b)))).rejects.toThrow(/link_not_found/);
    const unlinked = await link(a, await milestone(a));
    await db.query("update public.jira_issue_links set unlinked_at = now() where id = $1", [unlinked]);
    await expect(accept(a, unlinked)).rejects.toThrow(/link_not_found/);
  });
});

describe("hold_jira_acceptance (JR13)", () => {
  async function accepted(slug: string): Promise<{ orgId: string; milestoneId: string; linkId: string }> {
    const orgId = await createOrg(db, slug);
    const milestoneId = await milestone(orgId);
    const linkId = await link(orgId, milestoneId);
    await accept(orgId, linkId);
    return { orgId, milestoneId, linkId };
  }

  const linkRow = async (id: string) =>
    (await db.query<{ state: string; held_reason: string | null; after_payment: boolean }>("select state, held_reason, after_payment from public.jira_issue_links where id = $1", [id])).rows[0];

  it("takes the verification back from an accepted milestone the agent has not paid, and holds the link for review", async () => {
    const { orgId, milestoneId, linkId } = await accepted("jira-hold");
    expect(await hold(orgId, linkId, "canceled")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "pending", verified: false, verification_status: "unverified" });
    expect((await milestoneRow(milestoneId)).verification_detail).toMatchObject({ heldReason: "canceled", heldAt: expect.any(String) });
    expect(await linkRow(linkId)).toEqual({ state: "held", held_reason: "canceled", after_payment: false });
    // Once held, nothing more: only an accepted link is held.
    expect(await hold(orgId, linkId, "deliverable_changed")).toBe("not_accepted");
  });

  it("takes every reason the reads give, and refuses any other, archived included", async () => {
    for (const reason of ["reopened", "canceled", "deliverable_changed", "issue_unreachable", "unlinked"]) {
      const { orgId, linkId } = await accepted(`jira-hold-${reason.replace(/_/g, "-")}`);
      expect(await hold(orgId, linkId, reason), reason).toBe("held");
    }
    const { orgId, linkId } = await accepted("jira-hold-bad");
    for (const reason of ["no_criteria", "archived", "done"]) await expect(hold(orgId, linkId, reason), reason).rejects.toThrow(/bad_reason/);
    expect((await linkRow(linkId)).state).toBe("accepted");
  });

  it("leaves a milestone whose payment is under way or paid, and holds the link as changed after payment", async () => {
    const { orgId, milestoneId, linkId } = await accepted("jira-hold-paying");
    await db.query(
      "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, status) values ($1, 'milestone', $2, $3, 'circle', 450, '0x1', 'pending')",
      [orgId, milestoneId, `jira-${milestoneId}`]
    );
    expect(await hold(orgId, linkId, "reopened")).toBe("held_after_payment");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "verified", verified: true, verification_method: "jira" });
    expect(await linkRow(linkId)).toEqual({ state: "held", held_reason: "reopened", after_payment: true });
  });

  it("leaves a paid milestone with no payment row as it is too", async () => {
    const { orgId, milestoneId, linkId } = await accepted("jira-hold-paid");
    await db.query("update public.milestones set status = 'paid' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "issue_unreachable")).toBe("held_after_payment");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "paid", verified: true });
  });

  it("takes it back after a transfer that failed, which moved nothing", async () => {
    const { orgId, milestoneId, linkId } = await accepted("jira-hold-failed");
    await db.query(
      "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, status) values ($1, 'milestone', $2, $3, 'circle', 450, '0x1', 'failed')",
      [orgId, milestoneId, `jira-failed-${milestoneId}`]
    );
    await db.query("update public.milestones set status = 'held' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "pending", verified: false });
  });

  it("waits while a person is deciding the milestone, and acts once the claim is old", async () => {
    const { orgId, milestoneId, linkId } = await accepted("jira-hold-claimed");
    await db.query("update public.milestones set status = 'held', decision_claimed_by = $2, decision_claimed_at = now() where id = $1", [milestoneId, other]);
    expect(await hold(orgId, linkId, "reopened")).toBe("deferred");
    expect((await linkRow(linkId)).state).toBe("accepted");
    await db.query("update public.milestones set decision_claimed_at = now() - interval '11 minutes' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "pending", verified: false });
  });

  it("leaves a milestone verified by Linear or by hand alone, and holds only the link", async () => {
    for (const method of ["linear", "manual"]) {
      const { orgId, milestoneId, linkId } = await accepted(`jira-hold-other-method-${method}`);
      await db.query("update public.milestones set verification_method = $2 where id = $1", [milestoneId, method]);
      expect(await hold(orgId, linkId, "reopened"), method).toBe("held");
      expect(await milestoneRow(milestoneId), method).toMatchObject({ status: "verified", verified: true, verification_method: method, verification_status: "verified" });
      expect((await linkRow(linkId)).state, method).toBe("held");
    }
  });

  it("leaves a closed milestone alone", async () => {
    const { orgId, milestoneId, linkId } = await accepted("jira-hold-closed");
    await db.query("update public.milestones set status = 'closed' where id = $1", [milestoneId]);
    expect(await hold(orgId, linkId, "reopened")).toBe("held");
    expect(await milestoneRow(milestoneId)).toMatchObject({ status: "closed", verified: true });
  });

  it("never holds another workspace's link", async () => {
    const { linkId } = await accepted("jira-hold-tenant");
    const stranger = await createOrg(db, "jira-hold-stranger");
    expect(await hold(stranger, linkId, "reopened")).toBe("not_accepted");
    expect((await linkRow(linkId)).state).toBe("accepted");
  });
});

describe("jira_connector_ready(p_org_id) (JR5)", () => {
  it("answers true to the tenant role, and to no one signed in", async () => {
    const orgId = await createOrg(db, "jira-ready");
    const ready = await asTenant(db, orgId, async (tx) => (await tx.query<{ ready: boolean }>("select public.jira_connector_ready(p_org_id => $1::uuid) as ready", [orgId])).rows[0].ready);
    expect(ready).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.jira_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.jira_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(/permission denied/);
    for (const fn of [
      "accept_jira_issue(p_org_id => $1::uuid, p_link_id => $1::uuid, p_by => $1::uuid, p_fingerprint => 'x', p_criteria_sha256 => 'x', p_note => 'x')",
      "hold_jira_acceptance(p_org_id => $1::uuid, p_link_id => $1::uuid, p_reason => 'reopened')",
    ]) {
      await expect(asRole(db, "authenticated", (tx) => tx.query(`select public.${fn}`, [orgId]))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, "anon", (tx) => tx.query(`select public.${fn}`, [orgId]))).rejects.toThrow(/permission denied/);
    }
  });
});
