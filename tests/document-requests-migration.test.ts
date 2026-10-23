import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, seedOrgRows } from "./support/pglite";

/**
 * Migration 0142 (docs/superpowers/specs/2026-10-23-document-requests-design.md ER1-ER7): the setting and its check; one
 * drafted or open request per bill, read by its workspace alone; an email tried at most three times; the vendor's
 * preview and answer by token, once, while the request is open and the bill still waits for information; expiry; revoke;
 * the private bucket; and nothing that touches a bill.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hash = () => crypto.randomBytes(32).toString("hex");
const PO = JSON.stringify(["purchase_order"]);

/** A workspace with one bill waiting for information. */
async function waitingBill(tag: string): Promise<{ orgId: string; invoiceId: string; counterpartyId: string }> {
  const orgId = await createOrg(db, tag);
  const { counterpartyId, invoiceId } = await seedOrgRows(db, orgId, tag);
  // seedOrgRows makes its own request for its fixture; these tests make their own.
  await db.query("delete from public.document_requests where org_id = $1", [orgId]);
  await db.query("update public.invoices set status = 'awaiting_info', memo = 'INV-77' where id = $1", [invoiceId]);
  return { orgId, invoiceId, counterpartyId };
}

const create = (orgId: string, invoiceId: string, missing = PO) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<{ id: string | null; status: string | null }>("select * from public.create_document_request($1, $2, $3::jsonb, 'northstar.example')", [orgId, invoiceId, missing])).rows[0]
  );

const claim = (orgId: string, id: string, attempts: number, token: string) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<{ ok: boolean }>("select public.claim_document_request_send($1, $2, $3, $4, $5::jsonb, 'northstar.example') as ok", [orgId, id, attempts, token, PO])).rows[0].ok
  );

const markSent = (orgId: string, id: string, token: string, expires = "now() + interval '14 days'") =>
  asServiceRole(db, async (tx) => (await tx.query<{ ok: boolean }>(`select public.mark_document_request_sent($1, $2, $3, ${expires}) as ok`, [orgId, id, token])).rows[0].ok);

const release = (orgId: string, id: string, token: string) =>
  asServiceRole(db, async (tx) => (await tx.query<{ status: string | null }>("select public.release_document_request_send($1, $2, $3) as status", [orgId, id, token])).rows[0].status);

const preview = (token: string) =>
  asServiceRole(db, async (tx) => (await tx.query<{ org_name: string; counterparty_name: string; invoice_reference: string; missing: string[] }>("select * from public.document_request_preview($1)", [token])).rows);

const pathOf = (orgId: string, id: string, sha: string) => `${orgId}/document-requests/${id}/${sha}`;

const answer = (token: string, file: { path: string; sha: string }, po: string | null = "PO-4410", note: string | null = "Signed copy attached.") =>
  asServiceRole(db, async (tx) =>
    (
      await tx.query<{ outcome: string; request_id: string | null; org_slug: string | null; counterparty_name: string | null }>(
        "select * from public.answer_document_request($1, $2, $3, 'application/pdf', 2048, $4, $5)",
        [token, file.path, file.sha, po, note]
      )
    ).rows[0]
  );

const row = async (id: string) =>
  (
    await db.query<{ status: string; token_hash: string | null; send_attempts: number; sent_at: string | null; expires_at: string | null; po_reference: string | null; note: string | null; file_path: string | null }>(
      "select status, token_hash, send_attempts, sent_at, expires_at, po_reference, note, file_path from public.document_requests where id = $1",
      [id]
    )
  ).rows[0];

/** A request emailed, so its link answers. */
async function openRequest(tag: string): Promise<{ orgId: string; invoiceId: string; id: string; token: string }> {
  const bill = await waitingBill(tag);
  const made = await create(bill.orgId, bill.invoiceId);
  const token = hash();
  expect(await claim(bill.orgId, made.id as string, 0, token)).toBe(true);
  expect(await markSent(bill.orgId, made.id as string, token)).toBe(true);
  return { ...bill, id: made.id as string, token };
}

describe("the setting (ER1)", () => {
  it("is off by default, and takes only off, shadow and on", async () => {
    const orgId = await createOrg(db, "dr-setting");
    await db.query("insert into public.approval_policies (org_id) values ($1)", [orgId]);
    expect((await db.query<{ document_requests: string }>("select document_requests from public.approval_policies where org_id = $1", [orgId])).rows[0].document_requests).toBe("off");
    await db.query("update public.approval_policies set document_requests = 'shadow' where org_id = $1", [orgId]);
    await db.query("update public.approval_policies set document_requests = 'on' where org_id = $1", [orgId]);
    await expect(db.query("update public.approval_policies set document_requests = 'always' where org_id = $1", [orgId])).rejects.toThrow(/approval_policies_document_requests_check/);
  });

  it("is written by the workspace's own tenant role, as the payee lock is", async () => {
    const orgId = await createOrg(db, "dr-setting-tenant");
    await asTenant(db, orgId, (tx) => tx.query("insert into public.approval_policies (org_id, document_requests) values ($1, 'shadow')", [orgId]));
    expect((await db.query<{ document_requests: string }>("select document_requests from public.approval_policies where org_id = $1", [orgId])).rows[0].document_requests).toBe("shadow");
  });
});

describe("making a request (ER2-ER4)", () => {
  it("drafts one for a bill waiting for information, and only one at a time", async () => {
    const { orgId, invoiceId, counterpartyId } = await waitingBill("dr-create");
    const made = await create(orgId, invoiceId);
    expect(made).toMatchObject({ status: "drafted" });
    expect((await db.query("select counterparty_id, token_hash, send_attempts from public.document_requests where id = $1", [made.id])).rows[0]).toEqual({
      counterparty_id: counterpartyId,
      token_hash: null,
      send_attempts: 0,
    });
    expect((await create(orgId, invoiceId)).id).toBeNull();
  });

  it("makes nothing for a bill that no longer waits for information, and refuses another workspace's bill", async () => {
    const { orgId, invoiceId } = await waitingBill("dr-late");
    await db.query("update public.invoices set status = 'paid' where id = $1", [invoiceId]);
    expect((await create(orgId, invoiceId)).id).toBeNull();
    const other = await createOrg(db, "dr-late-other");
    await expect(create(other, invoiceId)).rejects.toThrow(/document_request_not_possible/);
  });

  it("names only a purchase order or a goods receipt as missing", async () => {
    const { orgId, invoiceId } = await waitingBill("dr-missing");
    await expect(create(orgId, invoiceId, JSON.stringify([]))).rejects.toThrow(/document_requests_missing_check/);
    await expect(create(orgId, invoiceId, JSON.stringify(["contract"]))).rejects.toThrow(/document_requests_missing_check/);
    expect((await create(orgId, invoiceId, JSON.stringify(["purchase_order", "goods_receipt"]))).status).toBe("drafted");
  });
});

describe("emailing it (ER4)", () => {
  it("claims each attempt once, so two runs never send it twice, and opens the link once the email went", async () => {
    const { orgId, invoiceId } = await waitingBill("dr-claim");
    const made = await create(orgId, invoiceId);
    const token = hash();
    expect(await claim(orgId, made.id as string, 0, token)).toBe(true);
    expect(await claim(orgId, made.id as string, 0, hash())).toBe(false);
    // Claimed, not sent: the link answers nothing yet.
    expect(await preview(token)).toEqual([]);
    expect(await markSent(orgId, made.id as string, hash())).toBe(false);
    expect(await markSent(orgId, made.id as string, token)).toBe(true);
    expect(await row(made.id as string)).toMatchObject({ status: "open", token_hash: token, send_attempts: 1 });
    expect((await row(made.id as string)).sent_at).not.toBeNull();
  });

  it("refuses a link that would answer for more than 15 days", async () => {
    const { orgId, invoiceId } = await waitingBill("dr-long");
    const made = await create(orgId, invoiceId);
    const token = hash();
    await claim(orgId, made.id as string, 0, token);
    await expect(markSent(orgId, made.id as string, token, "now() + interval '30 days'")).rejects.toThrow(/document_request_invalid/);
  });

  it("drafts it again after a failed email, and expires it after the third", async () => {
    const { orgId, invoiceId } = await waitingBill("dr-retry");
    const made = await create(orgId, invoiceId);
    const id = made.id as string;
    for (const attempt of [0, 1]) {
      const token = hash();
      expect(await claim(orgId, id, attempt, token)).toBe(true);
      expect(await release(orgId, id, token)).toBe("drafted");
      expect(await row(id)).toMatchObject({ status: "drafted", token_hash: null, send_attempts: attempt + 1 });
    }
    const last = hash();
    expect(await claim(orgId, id, 2, last)).toBe(true);
    expect(await release(orgId, id, last)).toBe("expired");
    expect(await row(id)).toMatchObject({ status: "expired", token_hash: null, send_attempts: 3 });
    expect(await claim(orgId, id, 3, hash())).toBe(false);
    // The bill may be asked again later: the slot is free.
    expect((await create(orgId, invoiceId)).status).toBe("drafted");
  });

  it("claims nothing for a bill that no longer waits for information", async () => {
    const { orgId, invoiceId } = await waitingBill("dr-claim-moved");
    const made = await create(orgId, invoiceId);
    await db.query("update public.invoices set status = 'pending' where id = $1", [invoiceId]);
    expect(await claim(orgId, made.id as string, 0, hash())).toBe(false);
  });
});

describe("the vendor's page (ER5)", () => {
  it("previews an open request by its token, and nothing for an unknown one", async () => {
    const { token } = await openRequest("dr-preview");
    expect(await preview(token)).toEqual([expect.objectContaining({ org_name: "dr-preview", counterparty_name: "cp-dr-preview", invoice_reference: "INV-77", missing: ["purchase_order"] })]);
    expect(await preview(hash())).toEqual([]);
  });

  it("takes one answer, keeps what the vendor typed, and changes nothing on the bill", async () => {
    const { orgId, invoiceId, id, token } = await openRequest("dr-answer");
    const before = (await db.query("select status, amount, po_reference, goods_received, counterparty_id from public.invoices where id = $1", [invoiceId])).rows[0];
    const sha = hash();
    expect(await answer(token, { path: pathOf(orgId, id, sha), sha })).toMatchObject({ outcome: "answered", request_id: id, org_slug: "dr-answer", counterparty_name: "cp-dr-answer" });
    expect(await row(id)).toMatchObject({ status: "answered", po_reference: "PO-4410", note: "Signed copy attached.", file_path: pathOf(orgId, id, sha) });
    expect((await answer(token, { path: pathOf(orgId, id, sha), sha })).outcome).toBe("not_valid");
    expect(await preview(token)).toEqual([]);
    expect((await db.query("select status, amount, po_reference, goods_received, counterparty_id from public.invoices where id = $1", [invoiceId])).rows[0]).toEqual(before);
  });

  it("refuses a file outside the request's own folder, and a purchase order or note that is too long", async () => {
    const { orgId, id, token } = await openRequest("dr-fields");
    const sha = hash();
    const other = await createOrg(db, "dr-fields-other");
    await expect(answer(token, { path: pathOf(other, id, sha), sha })).rejects.toThrow(/document_request_invalid: the file/);
    await expect(answer(token, { path: pathOf(orgId, id, sha), sha: hash() })).rejects.toThrow(/document_request_invalid: the file/);
    await expect(answer(token, { path: pathOf(orgId, id, sha), sha }, "P".repeat(101))).rejects.toThrow(/document_request_invalid: the purchase order/);
    await expect(answer(token, { path: pathOf(orgId, id, sha), sha }, null, "n".repeat(501))).rejects.toThrow(/document_request_invalid: the note/);
    await expect(answer(token, { path: pathOf(orgId, id, sha), sha }, null, `bell${String.fromCharCode(7)}`)).rejects.toThrow(/document_request_invalid: the note/);
    // A line break in the note is fine, and blanks are kept as none.
    expect((await answer(token, { path: pathOf(orgId, id, sha), sha }, "  ", "First line.\nSecond line.")).outcome).toBe("answered");
    expect(await row(id)).toMatchObject({ po_reference: null, note: "First line.\nSecond line." });
  });

  it("answers nothing for an expired link, or once the bill no longer waits for information", async () => {
    const expired = await openRequest("dr-expired");
    await db.query("update public.document_requests set expires_at = now() - interval '1 minute' where id = $1", [expired.id]);
    const sha = hash();
    expect(await preview(expired.token)).toEqual([]);
    expect((await answer(expired.token, { path: pathOf(expired.orgId, expired.id, sha), sha })).outcome).toBe("not_valid");

    const moved = await openRequest("dr-moved");
    await db.query("update public.invoices set status = 'paid' where id = $1", [moved.invoiceId]);
    expect(await preview(moved.token)).toEqual([]);
    expect((await answer(moved.token, { path: pathOf(moved.orgId, moved.id, sha), sha })).outcome).toBe("not_valid");
  });
});

describe("closing requests", () => {
  it("expires open requests past their date or whose bill moved on, and drafted ones with their three attempts spent", async () => {
    const dated = await openRequest("dr-close");
    await db.query("update public.document_requests set expires_at = now() - interval '1 hour' where id = $1", [dated.id]);
    const moved = await asServiceRole(db, async (tx) => {
      const bill = (await tx.query<{ id: string }>("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status) select org_id, 'payable', counterparty_id, 5, now(), 'awaiting_info' from public.invoices where id = $1 returning id", [dated.invoiceId])).rows[0];
      return bill.id;
    });
    const second = await create(dated.orgId, moved);
    const token = hash();
    await claim(dated.orgId, second.id as string, 0, token);
    await markSent(dated.orgId, second.id as string, token);
    await db.query("update public.invoices set status = 'scheduled', scheduled_for = now() + interval '3 days' where id = $1", [moved]);

    const closed = await asServiceRole(db, async (tx) => (await tx.query<{ n: number }>("select public.close_document_requests($1) as n", [dated.orgId])).rows[0].n);
    expect(closed).toBe(2);
    expect((await row(dated.id)).status).toBe("expired");
    expect((await row(second.id as string)).status).toBe("expired");
    expect(Date.parse((await row(second.id as string)).expires_at as string)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("revoking (ER6)", () => {
  it("stops an open request in its own workspace only, and only once", async () => {
    const { orgId, id, token } = await openRequest("dr-revoke");
    const other = await createOrg(db, "dr-revoke-other");
    const revoke = (org: string) => asServiceRole(db, async (tx) => (await tx.query<{ id: string | null; status: string | null }>("select * from public.revoke_document_request($1, $2)", [org, id])).rows[0]);
    expect((await revoke(other)).id).toBeNull();
    expect(await revoke(orgId)).toMatchObject({ id, status: "revoked" });
    expect((await revoke(orgId)).id).toBeNull();
    expect(await preview(token)).toEqual([]);
  });
});

describe("who reads and writes (RLS)", () => {
  it("lets a workspace read its own requests, write none, and call no function", async () => {
    const mine = await openRequest("dr-rls");
    const theirs = await openRequest("dr-rls-other");
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.document_requests")).rows);
    expect(seen.map((one) => one.org_id)).toEqual([mine.orgId]);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("update public.document_requests set status = 'answered'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("insert into public.document_requests (org_id, invoice_id, counterparty_id, missing, email_domain) values ($1, $2, $2, '[\"purchase_order\"]', 'x.example')", [mine.orgId, mine.invoiceId]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select * from public.document_request_preview($1)", [theirs.token]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select * from public.create_document_request($1, $2, '[\"purchase_order\"]', 'x.example')", [mine.orgId, mine.invoiceId]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select * from public.revoke_document_request($1, $2)", [mine.orgId, mine.id]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.answer_document_request($1, 'x', 'y', 'application/pdf', 1, null, null)", [theirs.token]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select count(*) from public.document_requests"))).rejects.toThrow(/permission denied/);
  });
});

describe("the private bucket (ER5)", () => {
  it("is made where Supabase Storage is, private, with its limits, and kept private on every run", async () => {
    await db.exec(`
      create schema if not exists storage;
      create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    `);
    await applyMigrations(db, (file) => file.startsWith("0142_"));
    const bucket = async () =>
      (await db.query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>("select public, file_size_limit::int, allowed_mime_types from storage.buckets where id = 'documents'")).rows[0];
    expect(await bucket()).toEqual({ public: false, file_size_limit: 10485760, allowed_mime_types: ["application/pdf", "image/png", "image/jpeg"] });
    await db.query("update storage.buckets set public = true where id = 'documents'");
    await applyMigrations(db, (file) => file.startsWith("0142_"));
    expect((await bucket()).public).toBe(false);
  });
});

describe("re-running (migrate.ts runs every file each time)", () => {
  it("applies twice without error, and keeps what it holds", async () => {
    const { id } = await openRequest("dr-rerun");
    await applyMigrations(db, (file) => file.startsWith("0142_"));
    expect((await row(id)).status).toBe("open");
  });
});
