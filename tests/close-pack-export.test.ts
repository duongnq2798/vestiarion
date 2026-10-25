import { describe, expect, it } from "vitest";
import { buildClosePack } from "@/lib/close-pack/build";
import { CLOSE_PACK_COLUMNS, closePackCsv, closePackDocument, closePackFileName, closePackJson, closePackTable } from "@/lib/close-pack/export";
import { closePackMonth } from "@/lib/close-pack/month";
import { CLOSE_PACK_FORMAT } from "@/lib/close-pack/types";
import { CHECK_KIND_MEANINGS, CHECK_KIND_WORDS } from "@/lib/close-pack/words";
import { SIGNED_ENTRY_PROVES } from "@/lib/evidence-chain";
import { CHECK_AN_ENTRY } from "@/lib/evidence-export";
import { closePackInput, DOC_SHA, ENTRIES, entry, INTENTS, INV_A, INV_B, INVOICES, invoice, KEYS, NOW, OCTOBER, samplePack, tx } from "./support/close-pack-fixtures";

/**
 * The close pack's files (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP12, CP17, CP18): the signed
 * JSON in the evidence export's shape, the table the CSV and a Google Sheet share, the CSV with a byte-order mark and CRLF
 * lines and every cell guarded, and the file names.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const BOM = String.fromCharCode(0xfeff);

describe("the signed JSON document (close pack CP12)", () => {
  it("carries the format, when it was read, the workspace, the network's label and the month", () => {
    const doc = closePackDocument(samplePack(), { origin: ORIGIN });
    expect(doc.format).toBe(CLOSE_PACK_FORMAT);
    expect(doc.format).toBe("vestiarion-close-pack/1");
    expect(doc.exportedAt).toBe(NOW.toISOString());
    expect(doc.workspace).toEqual({ slug: "pinecrest-studio", name: "Pinecrest Studio" });
    expect(doc.network).toEqual({ id: "arc-testnet", label: "Arc testnet" });
    expect(doc.month).toEqual({ ...OCTOBER, ended: true });
    expect(doc.ledgerHead).toEqual({ seq: 99, hash: "h99" });
    expect(doc.cut).toBe(false);
    expect(doc.unread).toEqual([]);
    const soFar = closePackDocument(samplePack({ now: new Date("2026-10-25T00:00:00Z"), month: closePackMonth("2026-10", new Date("2026-10-25T00:00:00Z"))! }), { origin: ORIGIN });
    expect(soFar.month.ended).toBe(false);
  });

  it("names all eight kinds, what a signed entry proves, how to check one, and the keys", () => {
    const doc = closePackDocument(samplePack(), { origin: ORIGIN });
    expect(Object.keys(doc.labels).sort()).toEqual(["checked", "contradicted", "inferred", "missing", "not_applicable", "stated", "unreachable", "verified"]);
    expect(doc.labels.not_applicable).toEqual({ words: "Does not apply", meaning: CHECK_KIND_MEANINGS.not_applicable });
    expect(doc.labels.verified).toEqual({ words: CHECK_KIND_WORDS.verified, meaning: CHECK_KIND_MEANINGS.verified });
    expect(doc.signedEntryProves).toBe(SIGNED_ENTRY_PROVES);
    // A plain array, not the readonly tuple: its JSON is the same (evidence API EA10).
    expect(Array.isArray(doc.checkAnEntry)).toBe(true);
    expect(doc.checkAnEntry).toEqual([...CHECK_AN_ENTRY]);
    expect(doc.checkAnEntry).not.toBe(CHECK_AN_ENTRY);
    expect(doc.keys).toEqual(KEYS);
  });

  it("carries each cited entry in snake_case with its check", () => {
    const doc = closePackDocument(samplePack(), { origin: ORIGIN });
    expect(doc.entries.map((one) => one.seq)).toEqual([2, 3, 4, 10, 12, 20, 21, 22, 23, 30, 31, 80]);
    expect(Object.keys(doc.entries[0])).toEqual(["seq", "id", "ts", "actor", "domain", "action", "summary", "detail", "body_hash", "signature", "prev_hash", "hash", "signing_key_id", "check"]);
    expect(doc.entries[0].check).toEqual({ ok: true });
  });

  it("makes each evidence path an absolute address on the origin", () => {
    const doc = closePackDocument(samplePack(), { origin: `${ORIGIN}/` });
    expect(doc.rows[0].evidenceUrl).toBe(`${ORIGIN}/o/pinecrest-studio/evidence/invoice/${INV_A}`);
    expect(doc.rows[0].evidencePath).toBe(`/o/pinecrest-studio/evidence/invoice/${INV_A}`);
    expect(doc.notSettled[0].evidenceUrl).toMatch(/^https:\/\/www\.vestiarion\.xyz\/o\/pinecrest-studio\/evidence\/invoice\//);
    expect(doc.escrow).toHaveLength(1);
    expect(doc.totals.onChain).toEqual([{ token: "USDC", payments: 3, amount: "1650.000000", routeFeesUsdc: "0.120000" }]);
  });

  it("is JSON.stringify of the document, two spaces, and survives a round trip unchanged", () => {
    const pack = samplePack();
    const json = closePackJson(pack, { origin: ORIGIN });
    expect(json).toBe(JSON.stringify(closePackDocument(pack, { origin: ORIGIN }), null, 2));
    expect(JSON.parse(json)).toEqual(closePackDocument(pack, { origin: ORIGIN }));
    expect(json).not.toContain("undefined");
  });

  it("names members by id only when the pack was read that way", () => {
    const json = closePackJson(samplePack({ people: "id" }), { origin: ORIGIN });
    expect(json).not.toContain("@");
  });
});

describe("the table (close pack CP12, CP18)", () => {
  it("has exactly the close pack's columns, in order", () => {
    expect(CLOSE_PACK_COLUMNS).toEqual([
      "paid_at",
      "payment_id",
      "record",
      "record_id",
      "payee",
      "payee_id",
      "paid_to",
      "chain",
      "invoice_number",
      "milestone",
      "bill_amount",
      "bill_currency",
      "amount_paid",
      "token",
      "discount",
      "due_date",
      "po_reference",
      "document_sha256",
      "vendor_document_sha256",
      "simulated",
      "shadow",
      "decided",
      "approvals",
      "authorized_by",
      "address_given_by",
      "address_confirmed_by",
      "second_person",
      "guardrails",
      "guardrail_notes",
      "screening",
      "wallet_list",
      "payee_lock",
      "pay_to",
      "milestone_verification",
      "route",
      "tx_hash",
      "tx_url",
      "burn_tx_hash",
      "network_fee_usd",
      "network_fee_source",
      "route_fee_usdc",
      "earlier_attempts",
      "books",
      "booked_in",
      "entry_seq",
      "entry_hash",
      "signature",
      "signing_key_id",
      "entry_verified",
      "evidence_url",
      "entries",
    ]);
    expect(CLOSE_PACK_COLUMNS).toHaveLength(51);
  });

  it("has one row per settled payment, in order, as plain text", () => {
    const table = closePackTable(samplePack(), { origin: ORIGIN });
    expect(table.columns).toBe(CLOSE_PACK_COLUMNS);
    expect(table.rows).toHaveLength(3);
    const cells = (index: number) => Object.fromEntries(CLOSE_PACK_COLUMNS.map((column, at) => [column, table.rows[index][at]]));
    expect(table.rows.map((row) => row[1])).toEqual(["pay-a", "pay-b", "pay-c"]);
    expect(table.rows.every((row) => row.length === 51 && row.every((cell) => typeof cell === "string"))).toBe(true);
    expect(cells(0)).toEqual({
      paid_at: "2026-10-02T14:00:05Z",
      payment_id: "pay-a",
      record: "invoice",
      record_id: INV_A,
      payee: "Northwind Supplies",
      payee_id: "0b6c1c9e-0000-4000-8000-0000000c0001",
      paid_to: "0x1111111111111111111111111111111111111111",
      chain: "Arc testnet",
      invoice_number: "INV-2041",
      milestone: "",
      bill_amount: "100.000000",
      bill_currency: "USDC",
      amount_paid: "100.000000",
      token: "USDC",
      discount: "",
      due_date: "2026-10-15",
      po_reference: "PO-77",
      document_sha256: DOC_SHA,
      vendor_document_sha256: "",
      simulated: "no",
      shadow: "no",
      decided: "Claude decided to pay it.",
      approvals: "No person approved it: code checked it and the agent paid it.",
      authorized_by: "code",
      address_given_by: "owner@pinecrest.test",
      address_confirmed_by: "approver@pinecrest.test",
      second_person: "yes",
      guardrails: "Checked by code: Code checked it before it was sent.",
      guardrail_notes: "✓ Purchase order PO-77 on file and the goods received; ✓ Counterparty screened clear; ✓ 100.00 USDC within its 500.00 USDC limit",
      screening: "Verified outside: Northwind Supplies was screened clear by OpenSanctions.",
      wallet_list: "Checked by code: Its payout address was not on OFAC's SDN list when it was paid: every screening and payment checks it.",
      payee_lock: "Checked by code: The payee lock was on when the address was confirmed, with a 24-hour wait. It was sent 30 hours after the address was given.",
      pay_to: "Does not apply: The bill's document named no address of its own.",
      milestone_verification: "Does not apply: A bill has no milestone to verify.",
      route: "direct",
      tx_hash: tx("a"),
      tx_url: `https://explorer.testnet.arc.io/tx/${tx("a")}`,
      burn_tx_hash: "",
      network_fee_usd: "0.004000",
      network_fee_source: "chain_reported",
      route_fee_usdc: "",
      earlier_attempts: "0",
      books: "Marked paid with this transaction.",
      booked_in: "",
      entry_seq: "12",
      entry_hash: "h12",
      signature: "s12",
      signing_key_id: "1a2b3c4d5e6f7a8b",
      entry_verified: "yes",
      evidence_url: `${ORIGIN}/o/pinecrest-studio/evidence/invoice/${INV_A}`,
      entries: "2 3 10 12",
    });
    expect(cells(1).approvals).toBe("Co-signed by accountant@firm.test (accountant) on 2026-10-11 10:00 UTC; Approved and paid by approver@pinecrest.test (approver) on 2026-10-12 11:00 UTC");
    expect(cells(1).screening).toBe("Inferred: Harbor Print was clear as the agent's decision recorded; no screening check is on file.");
    expect(cells(1).second_person).toBe("");
    expect(cells(1).entries).toBe("4 20 21 22 23");
    expect(cells(2)).toMatchObject({ route: "cctp", chain: "Base Sepolia", tx_hash: tx("2"), burn_tx_hash: tx("1"), route_fee_usdc: "0.120000", tx_url: `https://sepolia.basescan.org/tx/${tx("2")}` });
  });

  it("says when an entry did not verify, or was not checked", () => {
    const failed = closePackTable(samplePack({ checks: new Map([[12, { ok: false, reason: "The signature does not verify with the workspace's key." }]]) }), { origin: ORIGIN });
    expect(failed.rows[0][CLOSE_PACK_COLUMNS.indexOf("entry_verified")]).toBe("no");
    expect(failed.rows[1][CLOSE_PACK_COLUMNS.indexOf("entry_verified")]).toBe("not checked");
  });
});

describe("the CSV (close pack CP12, CP17)", () => {
  it("starts with a byte-order mark, then the header, with CRLF lines", () => {
    const csv = closePackCsv(samplePack(), { origin: ORIGIN });
    expect(csv.startsWith(`${BOM}paid_at,payment_id,record,`)).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(CLOSE_PACK_COLUMNS.join(","));
    expect(lines).toHaveLength(5);
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("guards every cell so nothing runs as a formula, and keeps commas and quotes safe", () => {
    const entries = ENTRIES.map((one) => (one.seq === 10 ? entry(10, one.ts, "create_invoice", { ...one.detail, invoiceNumber: "+1" }) : one));
    const invoices = INVOICES.map((one) => (one.id === INV_A ? invoice(INV_A, { po_reference: "@SUM(A1)", memo: "@SUM(A1)" }) : one.id === INV_B ? { ...one, po_reference: "-2+3" } : one));
    const pack = samplePack({
      entries,
      invoices,
      counterparties: new Map([
        ["0b6c1c9e-0000-4000-8000-0000000c0001", { name: '=HYPERLINK("x")', address: "0x1111111111111111111111111111111111111111", sample: false }],
        ["0b6c1c9e-0000-4000-8000-0000000c0002", { name: "Harbor, Print", address: "0x2222222222222222222222222222222222222222", sample: false }],
      ]),
    });
    const csv = closePackCsv(pack, { origin: ORIGIN });
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"'+1"`);
    expect(csv).toContain(`"'@SUM(A1)"`);
    expect(csv).toContain(`"'-2+3"`);
    expect(csv).toContain(`"Harbor, Print"`);
    expect(csv).not.toMatch(/,=HYPERLINK|,\+1,|,@SUM/);
    // The table stays plain: a Google Sheet writes it RAW (CP18).
    expect(closePackTable(pack, { origin: ORIGIN }).rows[0][4]).toBe('=HYPERLINK("x")');
  });

  it("is its header alone for a month with nothing settled", () => {
    const empty = buildClosePack(closePackInput({ intents: [], entries: [] }));
    expect(closePackCsv(empty, { origin: ORIGIN })).toBe(`${BOM}${CLOSE_PACK_COLUMNS.join(",")}\r\n`);
    expect(closePackTable(empty, { origin: ORIGIN }).rows).toEqual([]);
    expect(closePackDocument(empty, { origin: ORIGIN }).rows).toEqual([]);
  });

  it("reads the same rows as the table", () => {
    const pack = samplePack();
    const csv = closePackCsv(pack, { origin: ORIGIN });
    expect(csv).toContain(`pay-b,invoice,${INV_B}`);
    expect(INTENTS).toHaveLength(4);
  });
});

describe("file names (close pack CP12)", () => {
  it("names the workspace and the month, and says so far for a month not ended", () => {
    expect(closePackFileName("pinecrest-studio", OCTOBER, true, "csv")).toBe("vestiarion-close-pack-pinecrest-studio-2026-10.csv");
    expect(closePackFileName("pinecrest-studio", OCTOBER, true, "json")).toBe("vestiarion-close-pack-pinecrest-studio-2026-10.json");
    expect(closePackFileName("pinecrest-studio", OCTOBER, false, "csv")).toBe("vestiarion-close-pack-pinecrest-studio-2026-10-so-far.csv");
  });

  it("drops characters a file name should not carry", () => {
    expect(closePackFileName('pine"crest/../studio', OCTOBER, true, "json")).toBe("vestiarion-close-pack-pinecreststudio-2026-10.json");
    expect(closePackFileName("", OCTOBER, true, "json")).toBe("vestiarion-close-pack-workspace-2026-10.json");
  });
});
