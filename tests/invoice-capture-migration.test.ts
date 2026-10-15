import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0121 (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C1, C9-C17): the drafts the Chrome
 * extension captures, a workspace's own rows that its members read and decide and never delete; the extension's
 * connections and one-time codes, platform tables only the service role touches, ending with the membership; and the
 * daily sweep that keeps the captured text no longer than it is needed.
 */

let db: PGlite;
let orgA: string;
let orgB: string;
let owner: string;

const hex = () => crypto.randomBytes(32).toString("hex");
const challenge = () => crypto.randomBytes(32).toString("base64url");
const CLIENT = "abcdefghijklmnopabcdefghijklmnop";

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0121_"));
  owner = await createUser(db, "capture-owner@example.com");
  orgA = await createOrg(db, "capture-a");
  orgB = await createOrg(db, "capture-b");
  for (const orgId of [orgA, orgB]) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, owner]);
  }
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function draft(
  orgId: string,
  values: Partial<Record<"state" | "source" | "amount" | "currency" | "key" | "raw_text" | "captured_at" | "document_kind", string>> = {}
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.invoice_drafts (org_id, state, source, document_kind, supplier_name, amount, currency, raw_text, connection_id,
       idempotency_key, request_sha256, captured_by, captured_at)
     values ($1, $2, $3, $4, 'Northwind Hosting', $5, $6, $7, $8, $9, $10, $11, coalesce($12::timestamptz, now())) returning id`,
    [
      orgId,
      values.state ?? "draft",
      values.source ?? "selection",
      values.document_kind ?? "text",
      values.amount ?? "200.00",
      values.currency ?? "USDC",
      values.raw_text ?? "Invoice INV-2207\nTotal due 200.00 USDC",
      "11111111-1111-4111-8111-111111111111",
      values.key ?? crypto.randomUUID(),
      hex(),
      owner,
      values.captured_at ?? null,
    ]
  );
  return result.rows[0].id;
}

async function grant(orgId: string, userId: string, values: Partial<{ scopes: string[]; audience: string; client: string }> = {}) {
  const result = await db.query<{ id: string }>(
    `insert into public.extension_grants (org_id, user_id, client_id, audience, scopes, code_hash, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 hour', $8, now() + interval '30 days') returning id`,
    [orgId, userId, values.client ?? CLIENT, values.audience ?? "vestiarion-chrome", values.scopes ?? ["invoice_draft:create", "invoice_draft:read"], hex(), hex(), hex()]
  );
  return result.rows[0].id;
}

async function code(orgId: string, userId: string, values: Partial<{ challenge: string; scopes: string[] }> = {}) {
  await db.query(
    `insert into public.extension_auth_codes (code_hash, org_id, user_id, client_id, redirect_uri, code_challenge, scopes, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')`,
    [hex(), orgId, userId, CLIENT, `https://${CLIENT}.chromiumapp.org/`, values.challenge ?? challenge(), values.scopes ?? ["invoice_draft:create", "invoice_draft:read"]]
  );
}

describe("invoice_drafts (0121, C1)", () => {
  it("keeps a draft's fields, where it came from, who captured it and its state", async () => {
    const id = await draft(orgA);
    const row = (
      await db.query<{ state: string; source: string; amount: string; captured_by: string; invoice_id: string | null }>(
        "select state, source, amount, captured_by, invoice_id from public.invoice_drafts where id = $1",
        [id]
      )
    ).rows[0];
    expect(row).toEqual({ state: "draft", source: "selection", amount: "200.00", captured_by: owner, invoice_id: null });
  });

  it("takes only the states, sources, kinds, amounts and currencies the app knows", async () => {
    for (const state of ["draft", "sent", "confirmed", "discarded"]) await draft(orgA, { state });
    await expect(draft(orgA, { state: "paid" })).rejects.toThrow(/invoice_drafts_state_check/);
    await expect(draft(orgA, { source: "page" })).rejects.toThrow(/invoice_drafts_source_check/);
    await expect(draft(orgA, { document_kind: "zip" })).rejects.toThrow(/invoice_drafts_document_kind_check/);
    for (const amount of ["0.1234567", "-1", "1,200.00", "01"]) {
      await expect(draft(orgA, { amount })).rejects.toThrow(/invoice_drafts_amount_check/);
    }
    await expect(draft(orgA, { currency: "usdc" })).rejects.toThrow(/invoice_drafts_currency_check/);
    await expect(draft(orgA, { raw_text: "x".repeat(20_001) })).rejects.toThrow(/invoice_drafts_raw_text_check/);
  });

  it("makes one draft of one capture: the same key from the same connection is refused", async () => {
    await draft(orgA, { key: "capture-once" });
    await expect(draft(orgA, { key: "capture-once" })).rejects.toThrow(/invoice_drafts_idempotency_key/);
    // Another workspace's key is its own.
    await draft(orgB, { key: "capture-once" });
  });

  it("never points at another workspace's counterparty or invoice", async () => {
    const theirs = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Theirs', 'vendor') returning id", [orgB])).rows[0].id;
    const theirInvoice = (
      await db.query<{ id: string }>(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id",
        [orgB, theirs]
      )
    ).rows[0].id;
    const id = await draft(orgA);
    await expect(db.query("update public.invoice_drafts set counterparty_id = $2 where id = $1", [id, theirs])).rejects.toThrow(/foreign key/);
    await expect(db.query("update public.invoice_drafts set invoice_id = $2 where id = $1", [id, theirInvoice])).rejects.toThrow(/foreign key/);
  });

  it("keeps a confirmed draft when its invoice or counterparty goes, without the link", async () => {
    const counterparty = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Mine', 'vendor') returning id", [orgA])).rows[0].id;
    const invoice = (
      await db.query<{ id: string }>(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id",
        [orgA, counterparty]
      )
    ).rows[0].id;
    const id = await draft(orgA, { state: "confirmed" });
    await db.query("update public.invoice_drafts set counterparty_id = $2, invoice_id = $3 where id = $1", [id, counterparty, invoice]);
    await db.query("delete from public.invoices where id = $1", [invoice]);
    await db.query("delete from public.counterparties where id = $1", [counterparty]);
    const row = (await db.query<{ org_id: string; invoice_id: string | null; counterparty_id: string | null }>(
      "select org_id, invoice_id, counterparty_id from public.invoice_drafts where id = $1", [id])).rows[0];
    expect(row).toEqual({ org_id: orgA, invoice_id: null, counterparty_id: null });
  });

  it("is seen, added and changed only by its own workspace, and never deleted there", async () => {
    const mine = await draft(orgA, { key: "tenant-mine" });
    const theirs = await draft(orgB, { key: "tenant-theirs" });
    const seen = await asTenant(db, orgA, async (tx) => (await tx.query<{ id: string }>("select id from public.invoice_drafts where id = any($1)", [[mine, theirs]])).rows);
    expect(seen).toEqual([{ id: mine }]);
    const changed = await asTenant(db, orgA, (tx) => tx.query("update public.invoice_drafts set state = 'sent' where id = any($1)", [[mine, theirs]]));
    expect(changed.affectedRows).toBe(1);
    await expect(asTenant(db, orgA, (tx) => tx.query("delete from public.invoice_drafts where id = $1", [mine]))).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(db, orgA, (tx) =>
        tx.query(
          `insert into public.invoice_drafts (org_id, source, connection_id, idempotency_key, request_sha256) values ($1, 'selection', gen_random_uuid(), 'x', $2)`,
          [orgB, hex()]
        )
      )
    ).rejects.toThrow(/row-level security/);
    await expect(asTenant(db, null, async (tx) => (await tx.query("select 1 from public.invoice_drafts")).rows)).resolves.toEqual([]);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select 1 from public.invoice_drafts"))).rejects.toThrow(/permission denied/);
    }
  });

  it("goes with its workspace", async () => {
    const orgId = await createOrg(db, "capture-gone");
    await draft(orgId);
    await db.query("delete from public.orgs where id = $1", [orgId]);
    expect((await db.query("select 1 from public.invoice_drafts where org_id = $1", [orgId])).rows).toHaveLength(0);
  });
});

describe("extension_grants and extension_auth_codes (0121, C12-C17)", () => {
  it("are closed to the browser roles and to every tenant", async () => {
    for (const table of ["extension_grants", "extension_auth_codes"]) {
      for (const role of ["anon", "authenticated"] as const) {
        await expect(asRole(db, role, (tx) => tx.query(`select 1 from public.${table}`))).rejects.toThrow(/permission denied/);
      }
      await expect(asTenant(db, orgA, (tx) => tx.query(`select 1 from public.${table}`))).rejects.toThrow(/permission denied/);
    }
  });

  it("grant only the Chrome audience and the two draft scopes, to an extension id", async () => {
    await grant(orgA, owner);
    await grant(orgA, owner, { scopes: ["invoice_draft:read"] });
    await expect(grant(orgA, owner, { scopes: ["invoice_draft:create", "invoices:write"] })).rejects.toThrow(/extension_grants_scopes_check/);
    await expect(grant(orgA, owner, { scopes: [] })).rejects.toThrow(/extension_grants_scopes_check/);
    await expect(grant(orgA, owner, { audience: "vestiarion-api" })).rejects.toThrow(/extension_grants_audience_check/);
    await expect(grant(orgA, owner, { client: "not-an-extension-id" })).rejects.toThrow(/extension_grants_client_id_check/);
    await code(orgA, owner);
    await expect(code(orgA, owner, { challenge: "short" })).rejects.toThrow(/extension_auth_codes_code_challenge_check/);
    await expect(code(orgA, owner, { scopes: ["payments:write"] })).rejects.toThrow(/extension_auth_codes_scopes_check/);
  });

  it("belong to a member: a person outside the workspace gets none, and ending the membership deletes them", async () => {
    const stranger = await createUser(db, "capture-stranger@example.com");
    await expect(grant(orgA, stranger)).rejects.toThrow(/extension_grants_membership_fkey/);
    await expect(code(orgA, stranger)).rejects.toThrow(/extension_auth_codes_membership_fkey/);

    const member = await createUser(db, "capture-member@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')", [orgA, member]);
    await grant(orgA, member);
    await code(orgA, member);
    await db.query("delete from public.memberships where org_id = $1 and user_id = $2", [orgA, member]);
    expect((await db.query("select 1 from public.extension_grants where user_id = $1", [member])).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.extension_auth_codes where user_id = $1", [member])).rows).toHaveLength(0);
  });

  it("keep each token hash once, and each code makes one connection", async () => {
    const id = await grant(orgA, owner);
    const { access_token_hash: hash } = (await db.query<{ access_token_hash: string }>("select access_token_hash from public.extension_grants where id = $1", [id])).rows[0];
    await expect(
      db.query(
        `insert into public.extension_grants (org_id, user_id, client_id, scopes, code_hash, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at)
         values ($1, $2, $3, '{invoice_draft:read}', $4, $5, now(), $6, now())`,
        [orgA, owner, CLIENT, hex(), hash, hex()]
      )
    ).rejects.toThrow(/extension_grants_access_token_hash_key/);
    const { code_hash: code } = (await db.query<{ code_hash: string }>("select code_hash from public.extension_grants where id = $1", [id])).rows[0];
    await expect(
      db.query(
        `insert into public.extension_grants (org_id, user_id, client_id, scopes, code_hash, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at)
         values ($1, $2, $3, '{invoice_draft:read}', $4, $5, now(), $6, now())`,
        [orgA, owner, CLIENT, code, hex(), hex()]
      )
    ).rejects.toThrow(/extension_grants_code_hash_key/);
    await expect(db.query("update public.extension_grants set revoked_reason = 'expired' where id = $1", [id])).rejects.toThrow(/extension_grants_revoked_reason_check/);
    await db.query("update public.extension_grants set revoked_reason = 'reused_refresh', retired_refresh_hash = $2 where id = $1", [id, hex()]);
  });
});

describe("invoice_capture_sweep (0121, C9, C10)", () => {
  const sweep = async (now: string) =>
    (await asServiceRole(db, (tx) => tx.query<{ r: Record<string, number> }>("select public.invoice_capture_sweep($1::timestamptz) as r", [now]))).rows[0].r;

  it("clears the captured text after 30 days, deletes drafts never sent after 7, and keeps the rest", async () => {
    const orgId = await createOrg(db, "capture-sweep");
    const old = "2026-09-01T00:00:00Z";
    const week = "2026-09-25T00:00:00Z";
    const sentOld = await draft(orgId, { state: "sent", captured_at: old });
    const unsentWeek = await draft(orgId, { state: "draft", captured_at: week });
    const sentWeek = await draft(orgId, { state: "sent", captured_at: week });
    const fresh = await draft(orgId, { state: "draft", captured_at: "2026-10-14T00:00:00Z" });

    const result = await sweep("2026-10-15T00:00:00Z");
    expect(result.textCleared).toBeGreaterThanOrEqual(1);
    expect(result.draftsDeleted).toBeGreaterThanOrEqual(1);

    const rows = (await db.query<{ id: string; raw_text: string | null }>("select id, raw_text from public.invoice_drafts where org_id = $1", [orgId])).rows;
    const byId = new Map(rows.map((row) => [row.id, row.raw_text]));
    expect(byId.get(sentOld)).toBeNull();
    expect(byId.has(unsentWeek)).toBe(false);
    expect(byId.get(sentWeek)).not.toBeNull();
    expect(byId.get(fresh)).not.toBeNull();
  });

  it("deletes codes a day after they expired, and connections revoked or expired 30 days ago", async () => {
    await db.query(
      `insert into public.extension_auth_codes (code_hash, org_id, user_id, client_id, redirect_uri, code_challenge, scopes, expires_at)
       values ($1, $2, $3, $4, 'https://x.chromiumapp.org/', $5, '{invoice_draft:read}', '2026-10-01T00:00:00Z')`,
      [hex(), orgB, owner, CLIENT, challenge()]
    );
    const revoked = await grant(orgB, owner);
    await db.query("update public.extension_grants set revoked_at = '2026-09-01T00:00:00Z' where id = $1", [revoked]);
    const live = await grant(orgB, owner);
    const result = await sweep("2026-10-15T00:00:00Z");
    expect(result.codesDeleted).toBeGreaterThanOrEqual(1);
    expect(result.connectionsDeleted).toBeGreaterThanOrEqual(1);
    const left = (await db.query<{ id: string }>("select id from public.extension_grants where id = any($1)", [[revoked, live]])).rows;
    expect(left).toEqual([{ id: live }]);
  });

  it("is the service role's alone", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.invoice_capture_sweep()"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query("select public.invoice_capture_sweep()"))).rejects.toThrow(/permission denied/);
  });
});
