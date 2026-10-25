import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0144 (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK7, DK8, DK11, DK12): the
 * check columns on a vendor's request, a member's attached PDF, the one function that writes a bill's purchase order
 * from a document that matched, and the marker `po_written` that holds such a bill for a person. Applied twice, over a
 * request a vendor answered before it ran, which is then checked once like any other.
 */

let db: PGlite;

const hash = () => crypto.randomBytes(32).toString("hex");
const pathOf = (orgId: string, id: string, sha: string) => `${orgId}/document-requests/${id}/${sha}`;
const BOTH = JSON.stringify(["purchase_order", "goods_receipt"]);
const ADDRESS = "0x1111111111111111111111111111111111111111";

/** A workspace with one bill of 5.00 USDC waiting for its purchase order and goods receipt, as Cobalt Cloud's is. */
async function waitingBill(tag: string, invoice: { direction?: string; status?: string } = {}): Promise<{ orgId: string; invoiceId: string; counterpartyId: string }> {
  const orgId = await createOrg(db, tag);
  const counterpartyId = (
    await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, address) values ($1, 'Cobalt Cloud', 'vendor', $2) returning id", [orgId, ADDRESS])
  ).rows[0].id;
  const invoiceId = (
    await db.query<{ id: string }>(
      `insert into public.invoices (org_id, direction, counterparty_id, amount, currency, due_date, status, memo, goods_received)
       values ($1, $2, $3, 5, 'USDC', now() + interval '12 days', $4, 'CC-2026-1030', false) returning id`,
      [orgId, invoice.direction ?? "payable", counterpartyId, invoice.status ?? "awaiting_info"]
    )
  ).rows[0].id;
  return { orgId, invoiceId, counterpartyId };
}

/** A vendor's answered request, inserted as 0142's answer_document_request leaves one. */
async function answeredByVendor(bill: { orgId: string; invoiceId: string; counterpartyId: string }, sha = hash()): Promise<{ id: string; sha: string }> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.document_requests (id, org_id, invoice_id, counterparty_id, missing, status, email_domain, send_attempts, sent_at, expires_at,
       token_hash, answered_at, po_reference, file_path, file_sha256, file_type, file_size)
     values ($1, $2, $3, $4, $5::jsonb, 'answered', 'cobalt.example', 1, now() - interval '1 hour', now() + interval '14 days',
       $6, now(), 'PO-PC-2026-1030', $7, $8, 'application/pdf', 2048)`,
    [id, bill.orgId, bill.invoiceId, bill.counterpartyId, BOTH, hash(), pathOf(bill.orgId, id, sha), sha]
  );
  return { id, sha };
}

let before: { orgId: string; invoiceId: string; counterpartyId: string; id: string; sha: string };

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db, (file) => file < "0144_");
  // A request a vendor answered while 0144 had not run (Cobalt Cloud's in pinecrest-studio, ledger 6506).
  const bill = await waitingBill("dk-before");
  before = { ...bill, ...(await answeredByVendor(bill)) };
  await applyMigrations(db, (file) => file >= "0144_");
  // migrate.ts runs every file each time: 0144 runs again over what it made.
  await applyMigrations(db, (file) => file.startsWith("0144_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const attach = (input: { orgId: string; id?: string; invoiceId: string; by: string; sha?: string; path?: string; size?: number; missing?: string }) => {
  const id = input.id ?? crypto.randomUUID();
  const sha = input.sha ?? hash();
  return asServiceRole(db, async (tx) => ({
    id,
    sha,
    outcome: (
      await tx.query<{ outcome: string }>("select public.attach_document($1, $2, $3, $4, $5::jsonb, $6, $7, $8) as outcome", [
        input.orgId,
        id,
        input.invoiceId,
        input.by,
        input.missing ?? BOTH,
        input.path ?? pathOf(input.orgId, id, sha),
        sha,
        input.size ?? 4096,
      ])
    ).rows[0].outcome,
  }));
};

const check = (input: { orgId: string; id: string; sha: string; outcome?: string; reason?: string | null; shadow?: boolean; po?: string | null; write?: boolean }) =>
  asServiceRole(db, async (tx) =>
    (
      await tx.query<{ outcome: string }>("select public.check_document_request($1, $2, $3, $4, $5, $6, $7, $8) as outcome", [
        input.orgId,
        input.id,
        input.sha,
        input.outcome ?? "matched",
        input.reason === undefined ? null : input.reason,
        input.shadow ?? false,
        input.po === undefined ? null : input.po,
        input.write ?? false,
      ])
    ).rows[0].outcome
  );

const request = async (id: string) =>
  (
    await db.query<{
      source: string;
      attached_by: string | null;
      status: string;
      token_hash: string | null;
      email_domain: string | null;
      file_type: string | null;
      file_size: number | null;
      checked_at: string | null;
      check_outcome: string | null;
      check_reason: string | null;
      check_shadow: boolean;
      document_po: string | null;
      po_written: boolean;
      answered_at: string | null;
      counterparty_id: string;
    }>(
      `select source, attached_by, status, token_hash, email_domain, file_type, file_size, checked_at, check_outcome, check_reason, check_shadow,
              document_po, po_written, answered_at, counterparty_id
         from public.document_requests where id = $1`,
      [id]
    )
  ).rows[0];

const billOf = async (invoiceId: string) =>
  (
    await db.query<{ status: string; amount: string; currency: string; po_reference: string | null; goods_received: boolean; address: string | null }>(
      `select i.status, i.amount::text, i.currency, i.po_reference, i.goods_received, c.address
         from public.invoices i join public.counterparties c on c.id = i.counterparty_id where i.id = $1`,
      [invoiceId]
    )
  ).rows[0];

describe("a request a vendor answered before 0144 (DK12)", () => {
  it("reads as a vendor's, unchecked, with no purchase order written and no shadow", async () => {
    expect(await request(before.id)).toMatchObject({
      source: "vendor",
      attached_by: null,
      status: "answered",
      checked_at: null,
      check_outcome: null,
      check_shadow: false,
      document_po: null,
      po_written: false,
    });
  });

  it("is checked once, like any new answer, and adds its purchase order", async () => {
    expect(await check({ orgId: before.orgId, id: before.id, sha: before.sha, po: "PO-PC-2026-1030", write: true })).toBe("written");
    expect(await request(before.id)).toMatchObject({ check_outcome: "matched", document_po: "PO-PC-2026-1030", po_written: true, check_shadow: false });
    expect((await request(before.id)).checked_at).not.toBeNull();
    expect(await billOf(before.invoiceId)).toMatchObject({ status: "awaiting_info", po_reference: "PO-PC-2026-1030", goods_received: false });
    expect(await check({ orgId: before.orgId, id: before.id, sha: before.sha, po: "PO-PC-2026-1030", write: true })).toBe("already_checked");
  });

  it("keeps its check when 0144 runs again", async () => {
    await applyMigrations(db, (file) => file.startsWith("0144_"));
    expect(await request(before.id)).toMatchObject({ check_outcome: "matched", po_written: true });
  });
});

describe("attach_document (DK11)", () => {
  it("inserts an answered member row with no token and no email domain, its vendor from the bill", async () => {
    const bill = await waitingBill("dk-attach");
    const member = await createUser(db, "admin@dk-attach.example");
    const made = await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, size: 4_000_000 });
    expect(made.outcome).toBe("attached");
    const row = await request(made.id);
    expect(row).toMatchObject({
      source: "member",
      attached_by: member,
      status: "answered",
      token_hash: null,
      email_domain: null,
      file_type: "application/pdf",
      file_size: 4_000_000,
      checked_at: null,
      counterparty_id: bill.counterpartyId,
    });
    expect(row.answered_at).not.toBeNull();
  });

  it("answers not_waiting for a bill that no longer waits for information, for a receivable, and for another workspace's bill", async () => {
    const member = await createUser(db, "admin@dk-late.example");
    const paid = await waitingBill("dk-late", { status: "paid" });
    expect((await attach({ orgId: paid.orgId, invoiceId: paid.invoiceId, by: member })).outcome).toBe("not_waiting");
    const receivable = await waitingBill("dk-receivable", { direction: "receivable" });
    expect((await attach({ orgId: receivable.orgId, invoiceId: receivable.invoiceId, by: member })).outcome).toBe("not_waiting");
    const theirs = await waitingBill("dk-theirs");
    const mine = await createOrg(db, "dk-mine");
    expect((await attach({ orgId: mine, invoiceId: theirs.invoiceId, by: member })).outcome).toBe("not_waiting");
  });

  it("answers same_file for a file already on the bill, unchecked or checked outside shadow", async () => {
    const bill = await waitingBill("dk-same");
    const member = await createUser(db, "admin@dk-same.example");
    const vendor = await answeredByVendor(bill);
    // The vendor's file, not checked yet.
    expect((await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, sha: vendor.sha })).outcome).toBe("same_file");
    // Checked outside shadow, it is still the same file.
    expect(await check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "mismatched", reason: "The document does not state a total." })).toBe("checked");
    expect((await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, sha: vendor.sha })).outcome).toBe("same_file");
    // And a match: its check compared the document.
    const matchedBill = await waitingBill("dk-same-matched");
    const matched = await answeredByVendor(matchedBill);
    expect(await check({ orgId: matchedBill.orgId, id: matched.id, sha: matched.sha, outcome: "matched", po: "PO-PC-2026-1030" })).toBe("checked");
    expect((await attach({ orgId: matchedBill.orgId, invoiceId: matchedBill.invoiceId, by: member, sha: matched.sha })).outcome).toBe("same_file");
  });

  it("takes the same file again when its earlier check never read it: skipped or unreadable (DK12)", async () => {
    const member = await createUser(db, "admin@dk-never-read.example");
    for (const [tag, outcome, reason] of [
      ["dk-again-skipped", "skipped", "It was not checked: the bill changed before the purchase order could be added."],
      ["dk-again-not-waiting", "skipped", "It was not checked: the bill no longer waited for a document."],
      ["dk-again-unreadable", "unreadable", "The file is no longer in storage."],
    ] as const) {
      const bill = await waitingBill(tag);
      const vendor = await answeredByVendor(bill);
      expect(await check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome, reason }), tag).toBe("checked");
      expect((await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, sha: vendor.sha })).outcome, tag).toBe("attached");
    }
  });

  it("takes the same file again when its earlier check was in shadow (DK10)", async () => {
    const bill = await waitingBill("dk-shadow-again");
    const member = await createUser(db, "admin@dk-shadow-again.example");
    const first = await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member });
    expect(first.outcome).toBe("attached");
    expect(await check({ orgId: bill.orgId, id: first.id, sha: first.sha, shadow: true, po: "PO-PC-2026-1030" })).toBe("checked");
    expect((await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, sha: first.sha })).outcome).toBe("attached");
  });

  it("answers busy while a member's earlier attachment waits to be checked", async () => {
    const bill = await waitingBill("dk-busy");
    const member = await createUser(db, "admin@dk-busy.example");
    const first = await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member });
    expect(first.outcome).toBe("attached");
    const second = await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member });
    expect(second.outcome).toBe("busy");
    expect(await request(second.id)).toBeUndefined();
    // Once the first is checked, another may be attached.
    await check({ orgId: bill.orgId, id: first.id, sha: first.sha, outcome: "unreadable", reason: "It is a PDF with no text to read, such as a scan." });
    expect((await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member })).outcome).toBe("attached");
  });

  it("refuses a path outside the request's own folder, a SHA-256 that is not one, and a size of 0 or over 4,000,000 bytes", async () => {
    const bill = await waitingBill("dk-invalid");
    const member = await createUser(db, "admin@dk-invalid.example");
    const other = await createOrg(db, "dk-invalid-other");
    const id = crypto.randomUUID();
    const sha = hash();
    await expect(attach({ orgId: bill.orgId, id, invoiceId: bill.invoiceId, by: member, sha, path: pathOf(other, id, sha) })).rejects.toThrow(/document_check_invalid: the file/);
    await expect(attach({ orgId: bill.orgId, id, invoiceId: bill.invoiceId, by: member, sha, path: pathOf(bill.orgId, crypto.randomUUID(), sha) })).rejects.toThrow(
      /document_check_invalid: the file/
    );
    await expect(attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, sha: "A".repeat(64) })).rejects.toThrow(/document_check_invalid: the file/);
    await expect(attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, sha: "abc" })).rejects.toThrow(/document_check_invalid: the file/);
    await expect(attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, size: 0 })).rejects.toThrow(/document_check_invalid: the file/);
    await expect(attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, size: 4_000_001 })).rejects.toThrow(/document_check_invalid: the file/);
    // What the bill lacks is the table's own check.
    await expect(attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, missing: JSON.stringify(["contract"]) })).rejects.toThrow(/document_requests_missing_check/);
  });
});

describe("check_document_request (DK7, DK9, DK12)", () => {
  it("checks a request once, then answers already_checked, and not_found for another workspace's or an unknown one", async () => {
    const bill = await waitingBill("dk-once");
    const vendor = await answeredByVendor(bill);
    const other = await createOrg(db, "dk-once-other");
    expect(await check({ orgId: other, id: vendor.id, sha: vendor.sha, outcome: "mismatched", reason: "The document does not state a total." })).toBe("not_found");
    expect(await check({ orgId: bill.orgId, id: crypto.randomUUID(), sha: vendor.sha, outcome: "mismatched", reason: "x" })).toBe("not_found");
    expect(await check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "mismatched", reason: "The document says 5.50 USDC; the bill says 5.00 USDC." })).toBe("checked");
    expect(await request(vendor.id)).toMatchObject({ check_outcome: "mismatched", check_reason: "The document says 5.50 USDC; the bill says 5.00 USDC.", po_written: false });
    expect(await check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "matched", po: "PO-PC-2026-1030", write: true })).toBe("already_checked");
    expect((await billOf(bill.invoiceId)).po_reference).toBeNull();
  });

  it("refuses a SHA-256 that is not the request's own file", async () => {
    const bill = await waitingBill("dk-sha");
    const vendor = await answeredByVendor(bill);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: hash(), outcome: "matched" })).rejects.toThrow(/document_check_invalid: the file/);
    expect((await request(vendor.id)).checked_at).toBeNull();
  });

  it("writes the purchase order and the marker, and nothing else on the bill or its vendor", async () => {
    const bill = await waitingBill("dk-write");
    const vendor = await answeredByVendor(bill);
    const was = await billOf(bill.invoiceId);
    expect(await check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, po: "PO-PC-2026-1030", write: true })).toBe("written");
    expect(await billOf(bill.invoiceId)).toEqual({ ...was, po_reference: "PO-PC-2026-1030" });
    expect(await request(vendor.id)).toMatchObject({ check_outcome: "matched", check_reason: null, document_po: "PO-PC-2026-1030", po_written: true });
  });

  it("answers bill_moved and leaves the request unchecked when the bill is held, has a purchase order, or has a payment", async () => {
    const held = await waitingBill("dk-moved-held");
    const heldRequest = await answeredByVendor(held);
    await db.query("update public.invoices set status = 'held' where id = $1", [held.invoiceId]);
    const withPo = await waitingBill("dk-moved-po");
    const withPoRequest = await answeredByVendor(withPo);
    await db.query("update public.invoices set po_reference = 'PO-9' where id = $1", [withPo.invoiceId]);
    const paying = await waitingBill("dk-moved-paying");
    const payingRequest = await answeredByVendor(paying);
    await db.query(
      `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
       values ($1, 'invoice', $2, $3, 'simulate', 5, 'sim:x')`,
      [paying.orgId, paying.invoiceId, `k-${paying.invoiceId}`]
    );
    for (const [bill, row] of [
      [held, heldRequest],
      [withPo, withPoRequest],
      [paying, payingRequest],
    ] as const) {
      expect(await check({ orgId: bill.orgId, id: row.id, sha: row.sha, po: "PO-PC-2026-1030", write: true }), bill.orgId).toBe("bill_moved");
      expect((await request(row.id)).checked_at, bill.orgId).toBeNull();
      // The stage then records it as skipped (DK7).
      expect(
        await check({ orgId: bill.orgId, id: row.id, sha: row.sha, outcome: "skipped", reason: "It was not checked: the bill changed before the purchase order could be added.", po: "PO-PC-2026-1030" }),
        bill.orgId
      ).toBe("checked");
    }
    expect((await billOf(withPo.invoiceId)).po_reference).toBe("PO-9");
    expect((await billOf(held.invoiceId)).po_reference).toBeNull();
    expect(await request(heldRequest.id)).toMatchObject({ check_outcome: "skipped", po_written: false, document_po: "PO-PC-2026-1030" });
  });

  it("refuses a write for a document that did not match, one checked in shadow, or with no purchase order", async () => {
    const bill = await waitingBill("dk-refuse");
    const vendor = await answeredByVendor(bill);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "mismatched", reason: "x", po: "PO-1", write: true })).rejects.toThrow(/document_check_invalid/);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, shadow: true, po: "PO-1", write: true })).rejects.toThrow(/document_check_invalid/);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, po: null, write: true })).rejects.toThrow(/document_check_invalid/);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, po: "   ", write: true })).rejects.toThrow(/document_check_invalid/);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "approved" })).rejects.toThrow(/document_check_invalid: the outcome/);
    expect((await billOf(bill.invoiceId)).po_reference).toBeNull();
    expect((await request(vendor.id)).checked_at).toBeNull();
  });

  it("refuses a reason or a purchase order with a control character, a line or paragraph separator, or a link", async () => {
    const bill = await waitingBill("dk-chars");
    const vendor = await answeredByVendor(bill);
    for (const code of [0x07, 0x0a, 0x85, 0x2028, 0x2029]) {
      const char = String.fromCharCode(code);
      await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "mismatched", reason: `The document${char}says.` }), code.toString(16)).rejects.toThrow(
        /document_check_invalid: the reason/
      );
      await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, po: `PO-1${char}2` }), code.toString(16)).rejects.toThrow(/document_check_invalid: the purchase order/);
    }
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "mismatched", reason: "r".repeat(301) })).rejects.toThrow(/document_check_invalid: the reason/);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, po: "PO-1 https://evil.example/pay" })).rejects.toThrow(/document_check_invalid: the purchase order/);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, po: "see WWW.evil.example" })).rejects.toThrow(/document_check_invalid: the purchase order/);
    await expect(check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, po: "P".repeat(101) })).rejects.toThrow(/document_check_invalid: the purchase order/);
    expect((await request(vendor.id)).checked_at).toBeNull();
  });
});

describe("start_document_parse and finish_document_parse (DK3)", () => {
  const start = (orgId: string, id: string) =>
    asServiceRole(db, async (tx) => (await tx.query<{ before: number | null }>("select public.start_document_parse($1, $2) as before", [orgId, id])).rows[0].before);
  const finish = (orgId: string, id: string) => asServiceRole(db, (tx) => tx.query("select public.finish_document_parse($1, $2)", [orgId, id]));
  const attempts = async (id: string) =>
    (await db.query<{ parse_attempts: number }>("select parse_attempts from public.document_requests where id = $1", [id])).rows[0].parse_attempts;

  it("counts each read begun and answers how many began before it and never finished; a finished read clears the count", async () => {
    const bill = await waitingBill("dk-parse");
    const vendor = await answeredByVendor(bill);
    expect(await attempts(vendor.id)).toBe(0);
    expect(await start(bill.orgId, vendor.id)).toBe(0);
    expect(await start(bill.orgId, vendor.id)).toBe(1);
    expect(await start(bill.orgId, vendor.id)).toBe(2);
    expect(await attempts(vendor.id)).toBe(3);
    await finish(bill.orgId, vendor.id);
    expect(await attempts(vendor.id)).toBe(0);
    expect(await start(bill.orgId, vendor.id)).toBe(0);
  });

  it("answers null, and counts nothing, for a request checked already, another workspace's or an unknown one", async () => {
    const bill = await waitingBill("dk-parse-done");
    const vendor = await answeredByVendor(bill);
    expect(await check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "unreadable", reason: "This PDF could not be read." })).toBe("checked");
    expect(await start(bill.orgId, vendor.id)).toBeNull();
    expect(await attempts(vendor.id)).toBe(0);
    const other = await createOrg(db, "dk-parse-other");
    const theirs = await waitingBill("dk-parse-theirs");
    const theirRequest = await answeredByVendor(theirs);
    expect(await start(other, theirRequest.id)).toBeNull();
    expect(await start(bill.orgId, crypto.randomUUID())).toBeNull();
    await finish(other, theirRequest.id);
    expect(await attempts(theirRequest.id)).toBe(0);
  });

  it("starts every request at 0, the ones a vendor answered before 0144 included", async () => {
    expect(await attempts(before.id)).toBe(0);
  });

  it("counts the unfinished reads of the same file on the workspace's other requests, so attaching it again does not start over", async () => {
    const bill = await waitingBill("dk-parse-again");
    const member = await createUser(db, "admin@dk-parse-again.example");
    const vendor = await answeredByVendor(bill);
    expect(await start(bill.orgId, vendor.id)).toBe(0);
    expect(await start(bill.orgId, vendor.id)).toBe(1);
    // Begun twice and never finished: the cycle records it unreadable, with no third parse.
    expect(await check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "unreadable", reason: "This PDF could not be read." })).toBe("checked");
    const again = await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member, sha: vendor.sha });
    expect(again.outcome).toBe("attached");
    expect(await start(bill.orgId, again.id)).toBe(2);
    // Another file starts from nothing.
    const other = await answeredByVendor(bill);
    expect(await start(bill.orgId, other.id)).toBe(0);
  });

  it("clears the file's count on every request of the workspace once one read of it finishes", async () => {
    const bill = await waitingBill("dk-parse-clear");
    const first = await answeredByVendor(bill);
    expect(await start(bill.orgId, first.id)).toBe(0);
    const second = await answeredByVendor(bill, first.sha);
    expect(await start(bill.orgId, second.id)).toBe(1);
    await finish(bill.orgId, second.id);
    expect(await attempts(first.id)).toBe(0);
    expect(await attempts(second.id)).toBe(0);
    expect(await start(bill.orgId, first.id)).toBe(0);
  });

  it("counts nothing of another workspace's copy of the same file, and clears nothing of it", async () => {
    const theirs = await waitingBill("dk-parse-their-copy");
    const theirRequest = await answeredByVendor(theirs);
    expect(await start(theirs.orgId, theirRequest.id)).toBe(0);
    expect(await start(theirs.orgId, theirRequest.id)).toBe(1);
    const mine = await waitingBill("dk-parse-my-copy");
    const myRequest = await answeredByVendor(mine, theirRequest.sha);
    expect(await start(mine.orgId, myRequest.id)).toBe(0);
    await finish(mine.orgId, myRequest.id);
    expect(await attempts(theirRequest.id)).toBe(2);
  });
});

describe("the table's own checks", () => {
  it("lets only an answered PDF be a member's, and needs a vendor's request to have its email domain", async () => {
    const bill = await waitingBill("dk-table");
    const member = await createUser(db, "admin@dk-table.example");
    const made = await attach({ orgId: bill.orgId, invoiceId: bill.invoiceId, by: member });
    await expect(db.query("update public.document_requests set file_type = 'image/png' where id = $1", [made.id])).rejects.toThrow(/document_requests_source_fields_check/);
    await expect(db.query("update public.document_requests set email_domain = 'cobalt.example' where id = $1", [made.id])).rejects.toThrow(/document_requests_source_fields_check/);
    await expect(db.query("update public.document_requests set token_hash = $2 where id = $1", [made.id, hash()])).rejects.toThrow(/document_requests_source_fields_check/);
    await expect(
      db.query(
        `insert into public.document_requests (org_id, invoice_id, counterparty_id, missing, status, source, email_domain)
         values ($1, $2, $3, $4::jsonb, 'drafted', 'member', null)`,
        [bill.orgId, bill.invoiceId, bill.counterpartyId, BOTH]
      )
    ).rejects.toThrow(/document_requests_source_fields_check/);
    await expect(
      db.query("insert into public.document_requests (org_id, invoice_id, counterparty_id, missing, email_domain) values ($1, $2, $3, $4::jsonb, null)", [
        bill.orgId,
        bill.invoiceId,
        bill.counterpartyId,
        BOTH,
      ])
    ).rejects.toThrow(/document_requests_source_fields_check/);
    await expect(db.query("update public.document_requests set source = 'agent' where id = $1", [made.id])).rejects.toThrow(/document_requests_source_check/);
  });

  it("keeps a check whole: its date and outcome together, only on an answered request, and the marker only on a match written outside shadow", async () => {
    const bill = await waitingBill("dk-checked");
    const vendor = await answeredByVendor(bill);
    await expect(db.query("update public.document_requests set checked_at = now() where id = $1", [vendor.id])).rejects.toThrow(/document_requests_checked_check/);
    await expect(db.query("update public.document_requests set check_outcome = 'matched' where id = $1", [vendor.id])).rejects.toThrow(/document_requests_checked_check/);
    await expect(db.query("update public.document_requests set check_outcome = 'approved', checked_at = now() where id = $1", [vendor.id])).rejects.toThrow(
      /document_requests_check_outcome_check/
    );
    await expect(
      db.query("update public.document_requests set checked_at = now(), check_outcome = 'mismatched', po_written = true, document_po = 'PO-1' where id = $1", [vendor.id])
    ).rejects.toThrow(/document_requests_checked_check/);
    await expect(
      db.query("update public.document_requests set checked_at = now(), check_outcome = 'matched', po_written = true, document_po = 'PO-1', check_shadow = true where id = $1", [
        vendor.id,
      ])
    ).rejects.toThrow(/document_requests_checked_check/);
    await expect(db.query("update public.document_requests set checked_at = now(), check_outcome = 'matched', po_written = true where id = $1", [vendor.id])).rejects.toThrow(
      /document_requests_checked_check/
    );
    await expect(db.query("update public.document_requests set document_po = $2 where id = $1", [vendor.id, "PO 1 www.evil.example"])).rejects.toThrow(
      /document_requests_document_po_check/
    );
    await expect(db.query("update public.document_requests set check_reason = $2 where id = $1", [vendor.id, `a${String.fromCharCode(0x2028)}b`])).rejects.toThrow(
      /document_requests_check_reason_check/
    );
    // A checked request stays answered.
    await check({ orgId: bill.orgId, id: vendor.id, sha: vendor.sha, outcome: "mismatched", reason: "The document does not state a total." });
    await expect(
      db.query(
        `update public.document_requests
            set status = 'expired', expires_at = now(), answered_at = null, file_path = null, file_sha256 = null, file_type = null, file_size = null,
                po_reference = null, note = null
          where id = $1`,
        [vendor.id]
      )
    ).rejects.toThrow(/document_requests_checked_check/);
  });
});

describe("who reads and calls it", () => {
  it("lets no browser role and no tenant call either function, and a workspace read its own check columns only", async () => {
    const mine = await waitingBill("dk-rls");
    const mineRequest = await answeredByVendor(mine);
    await check({ orgId: mine.orgId, id: mineRequest.id, sha: mineRequest.sha, outcome: "mismatched", reason: "The document does not state a total." });
    const theirs = await waitingBill("dk-rls-other");
    await answeredByVendor(theirs);
    const member = await createUser(db, "admin@dk-rls.example");

    const seen = await asTenant(db, mine.orgId, async (tx) =>
      (await tx.query<{ org_id: string; source: string; check_outcome: string | null; po_written: boolean }>("select org_id, source, check_outcome, po_written from public.document_requests")).rows
    );
    expect(seen).toEqual([{ org_id: mine.orgId, source: "vendor", check_outcome: "mismatched", po_written: false }]);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("update public.document_requests set po_written = false"))).rejects.toThrow(/permission denied/);

    const calls = [
      ["select public.attach_document($1, $2, $3, $4, $5::jsonb, 'x', 'y', 1)", [mine.orgId, crypto.randomUUID(), mine.invoiceId, member, BOTH]],
      ["select public.check_document_request($1, $2, $3, 'matched', null, false, 'PO-1', true)", [mine.orgId, mineRequest.id, mineRequest.sha]],
      ["select public.start_document_parse($1, $2)", [mine.orgId, mineRequest.id]],
      ["select public.finish_document_parse($1, $2)", [mine.orgId, mineRequest.id]],
    ] as const;
    for (const [sql, params] of calls) {
      await expect(asTenant(db, mine.orgId, (tx) => tx.query(sql, [...params]))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, "anon", (tx) => tx.query(sql, [...params]))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, "authenticated", (tx) => tx.query(sql, [...params]))).rejects.toThrow(/permission denied/);
    }
    expect((await billOf(mine.invoiceId)).po_reference).toBeNull();
  });
});
