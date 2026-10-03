import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0068 (docs/superpowers/specs/2026-10-03-email-invoices-design.md E2, E11): a workspace's address for
 * invoices by email, a platform table only the service role touches; and the emails that arrived there, a workspace's
 * own rows that its members read and decide, one per email Resend received.
 */

let db: PGlite;
let orgA: string;
let orgB: string;
let user: string;

async function inbox(orgId: string, code: string) {
  await db.query("insert into public.invoice_inboxes (org_id, code, created_by) values ($1, $2, $3)", [orgId, code, user]);
}

async function email(orgId: string, resendId: string, status = "received") {
  await db.query(
    "insert into public.inbox_emails (org_id, resend_email_id, from_address, subject, status) values ($1, $2, 'billing@vendor.example', 'Invoice 1003', $3)",
    [orgId, resendId, status]
  );
}

const count = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0].n;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  user = await createUser(db, "linh@example.com");
  orgA = await createOrg(db, "email-a");
  orgB = await createOrg(db, "email-b");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("invoice_inboxes (0068, E2)", () => {
  it("gives a workspace one address, and an address one workspace", async () => {
    await inbox(orgA, "abcdefghij23");
    await expect(inbox(orgA, "abcdefghij24")).rejects.toThrow(/invoice_inboxes_org_id_key/);
    await expect(inbox(orgB, "abcdefghij23")).rejects.toThrow(/invoice_inboxes_code_key/);
  });

  it("takes only a 12-character base32 code", async () => {
    for (const code of ["short", "ABCDEFGHIJ23", "abcdefghij01", "abcdefghij234"]) {
      await expect(inbox(orgB, code)).rejects.toThrow(/invoice_inboxes_code_check/);
    }
  });

  it("lets neither the browser roles nor a tenant read it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.invoice_inboxes"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query("select * from public.invoice_inboxes"))).rejects.toThrow(/permission denied/);
  });
});

describe("inbox_emails (0068, E3, E7, E11)", () => {
  it("keeps one row per email Resend received, per workspace", async () => {
    await email(orgA, "re-1");
    await expect(email(orgA, "re-1")).rejects.toThrow(/inbox_emails_resend_email_key/);
    await email(orgB, "re-1");
  });

  it("takes only the statuses the inbox knows", async () => {
    await expect(email(orgA, "re-2", "spam")).rejects.toThrow(/inbox_emails_status_check/);
    for (const status of ["received", "ready", "needs_details", "unreadable", "added", "dismissed"]) await email(orgA, `re-status-${status}`, status);
  });

  it("lets a workspace's own members read and decide its emails, and nobody else's", async () => {
    const own = await asTenant(db, orgA, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.inbox_emails")).rows);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((row) => row.org_id === orgA)).toBe(true);
    const updated = await asTenant(db, orgA, async (tx) => (await tx.query("update public.inbox_emails set status = 'dismissed' where org_id = $1 and resend_email_id = 're-1'", [orgB])).affectedRows);
    expect(updated).toBe(0);
    await expect(
      asTenant(db, orgA, (tx) => tx.query("insert into public.inbox_emails (org_id, resend_email_id) values ($1, 're-x')", [orgB]))
    ).rejects.toThrow(/row-level security/);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.inbox_emails"))).rejects.toThrow(/permission denied/);
    }
  });

  it("goes with its workspace, as the address does", async () => {
    const temp = await createOrg(db, "email-temp");
    await inbox(temp, "zzzzzzzzzz77");
    await email(temp, "re-temp");
    await db.query("delete from public.orgs where id = $1", [temp]);
    expect(await count("select count(*)::int as n from public.inbox_emails where org_id = $1", [temp])).toBe(0);
    expect(await count("select count(*)::int as n from public.invoice_inboxes where org_id = $1", [temp])).toBe(0);
  });

  it("runs again without error or loss, as db:migrate runs every file", async () => {
    const before = await count("select count(*)::int as n from public.inbox_emails");
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0068_email_invoices.sql"), "utf8"));
    expect(await count("select count(*)::int as n from public.inbox_emails")).toBe(before);
  });
});
