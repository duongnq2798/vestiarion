import { describe, expect, it } from "vitest";
import { parsePeriod, payeeLockEvidence, payeeLockEvidenceFileName, type CheckedEntry } from "@/lib/payee-lock-evidence";

/**
 * The payee lock's evidence pack (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md EP2 to EP5): one row
 * per address change, with who entered it, the confirmation and its record, the holds, the first payment and the
 * checks, each citing the entries the file carries in full. The entries follow the Oct 20 runs on Arc testnet.
 */

const OWNER = "63a43a55-78f9-4b85-907a-eea1483a06af";
const APPROVER = "9b1c2d3e-0000-4000-8000-00000000a002";
const NORTHWIND = "28e7be97-df37-4b15-9d43-be8a330f6ece";
const WARDROBE = "33d27523-47ff-4750-9a2b-0797cbd6a855";
const INVOICE = "0a12c729-a618-43fc-bded-e04ef1bf9037";
const NEW = "0xa8a4ced0cda82b24d11e0386f066eb8c27fd4887";
const OLD = "0xC4c24E3A6bd02ed99Ffce7595A9227349A7F05E4";
const TX = "0x49787501b6738cc2653bfb93a51293d4f036ff85a41115dc7f5b5f07db720551";

function entry(seq: number, ts: string, action: string, detail: Record<string, unknown>, actor = "agent"): CheckedEntry {
  return {
    seq,
    id: `e-${seq}`,
    ts,
    actor: actor as CheckedEntry["actor"],
    domain: action.startsWith("counterparty") ? "compliance" : action === "payee_lock_changed" ? "system" : "ap",
    action,
    summary: action,
    detail,
    body_hash: `b${seq}`,
    signature: `s${seq}`,
    prev_hash: `p${seq}`,
    hash: `h${seq}`,
    signing_key_id: "k1",
    check: { ok: true },
  } as CheckedEntry;
}

/** Pinecrest Studio on Oct 20: two members, a 4-hour wait, paid after both checks. */
const pinecrest: CheckedEntry[] = [
  entry(4832, "2026-10-20T11:12:40Z", "payee_lock_changed", { by: OWNER, from: { on: false, coolingHours: 0 }, to: { on: true, coolingHours: 4 } }, "human"),
  entry(4839, "2026-10-20T11:14:02Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: OLD, to: NEW, chain: "ARC-TESTNET" }, "human"),
  entry(4843, "2026-10-20T11:15:17Z", "ap_pay", { invoiceId: INVOICE, counterpartyId: NORTHWIND, guardrailRule: "counterparty.address_unconfirmed", execution: { txRef: null, resultingStatus: "held" } }),
  entry(4863, "2026-10-20T12:10:52Z", "counterparty_address_confirmed", {
    by: APPROVER,
    counterpartyId: NORTHWIND,
    address: NEW,
    chain: "ARC-TESTNET",
    verification: { method: "call", contact: "Northwind accounts line from our vendor file", contactOnFileBefore: true, note: "Second member confirms." },
    payeeLock: { coolingHours: 4 },
  }, "human"),
  entry(4866, "2026-10-20T12:11:00Z", "ap_pay", { invoiceId: INVOICE, counterpartyId: NORTHWIND, guardrailRule: "counterparty.cooling_off", execution: { txRef: null, resultingStatus: "held" } }),
  entry(4917, "2026-10-20T15:15:57Z", "invoice_reopened", { invoiceId: INVOICE, counterpartyId: NORTHWIND }),
  entry(4919, "2026-10-20T15:16:07Z", "ap_pay", { invoiceId: INVOICE, counterpartyId: NORTHWIND, guardrailRule: null, amountPaid: 3, currency: "USDC", execution: { txRef: TX, resultingStatus: "paid" } }),
];

const base = {
  workspace: { slug: "pinecrest-studio", name: "Pinecrest Studio" },
  network: "arc-testnet" as const,
  period: { from: null, to: null },
  lock: { on: true, coolingHours: 4 },
  counterparties: new Map([[NORTHWIND, "Northwind Referrals"], [WARDROBE, "Wardrobe Holdings Ltd"]]),
  members: new Map([[OWNER, "owner@pinecrest.test"], [APPROVER, "approver@pinecrest.test"]]),
  keys: [{ id: "k1", status: "active" as const, publicKeyPem: "-----BEGIN PUBLIC KEY-----" }],
  now: new Date("2026-10-21T08:00:00Z"),
};

describe("payeeLockEvidence", () => {
  it("shows a change confirmed by a second person with a record, held for the wait, then paid by the agent", () => {
    const doc = payeeLockEvidence({ ...base, entries: pinecrest });
    expect(doc.format).toBe("vestiarion-payee-lock-evidence/1");
    expect(doc.network).toEqual({ id: "arc-testnet", label: "Arc testnet" });
    expect(doc.changes).toHaveLength(1);
    const [row] = doc.changes;
    expect(row.counterparty).toEqual({ id: NORTHWIND, name: "Northwind Referrals" });
    expect(row.change).toEqual({ at: "2026-10-20T11:14:02Z", from: OLD, to: NEW, chain: "ARC-TESTNET", enteredBy: { kind: "member", email: "owner@pinecrest.test" }, entry: 4839 });
    expect(row.confirmation).toMatchObject({
      at: "2026-10-20T12:10:52Z",
      by: { kind: "member", email: "approver@pinecrest.test" },
      record: { method: "call", methodLabel: "Called them on a number we had before", contact: "Northwind accounts line from our vendor file", contactOnFileBefore: true, note: "Second member confirms." },
      secondPerson: true,
      soloConfirmation: false,
      waitHours: 4,
      payableFrom: "2026-10-20T15:14:02.000Z",
      entry: 4863,
    });
    expect(row.holds).toEqual([
      { at: "2026-10-20T11:15:17Z", rule: "counterparty.address_unconfirmed", subject: { kind: "invoice", id: INVOICE }, entry: 4843 },
      { at: "2026-10-20T12:11:00Z", rule: "counterparty.cooling_off", subject: { kind: "invoice", id: INVOICE }, entry: 4866 },
    ]);
    expect(row.firstPayment).toEqual({
      at: "2026-10-20T15:16:07Z",
      amount: 3,
      currency: "USDC",
      txRef: TX,
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
      decidedBy: "agent",
      subject: { kind: "invoice", id: INVOICE },
      entry: 4919,
    });
    expect(row.checks).toEqual({ recordKept: true, contactOnFileBefore: true, secondPerson: true, paidAfterConfirmation: true, paidAfterWait: true });
    expect(doc.lock).toEqual({
      now: { on: true, coolingHours: 4 },
      changes: [{ at: "2026-10-20T11:12:40Z", by: { kind: "member", email: "owner@pinecrest.test" }, from: { on: false, coolingHours: 0 }, to: { on: true, coolingHours: 4 }, entry: 4832 }],
    });
    expect(doc.summary).toEqual({
      changes: 1,
      confirmed: 1,
      confirmedWithRecord: 1,
      confirmedBySecondPerson: 1,
      heldWhileUnconfirmed: 1,
      heldForTheWait: 1,
      heldAsNewPayee: 0,
      paid: 1,
      paidOnlyAfterConfirmation: 1,
    });
  });

  it("carries every cited entry in full, each once, and none it does not cite", () => {
    const doc = payeeLockEvidence({ ...base, entries: pinecrest });
    expect(doc.entries.map((cited) => cited.seq)).toEqual([4832, 4839, 4843, 4863, 4866, 4919]);
    expect(doc.entries[1]).toEqual(expect.objectContaining({ body_hash: "b4839", signature: "s4839", prev_hash: "p4839", hash: "h4839", signing_key_id: "k1", check: { ok: true } }));
    expect(doc.keys).toEqual(base.keys);
    expect(doc.checkAnEntry.length).toBe(3);
  });

  it("shows a solo confirmation, the new-payee hold, and a person's approval as the payment", () => {
    const solo = [
      entry(4851, "2026-10-20T11:32:13Z", "counterparty_address_changed", { by: OWNER, counterpartyId: WARDROBE, from: "0x0ba4", to: "0x532a", chain: "ARC-TESTNET" }, "human"),
      entry(4857, "2026-10-20T11:34:35Z", "counterparty_address_confirmed", {
        by: OWNER,
        counterpartyId: WARDROBE,
        address: "0x532A",
        verification: { method: "call", contact: "accounts desk", contactOnFileBefore: true },
        payeeLock: { coolingHours: 4 },
        soloConfirmation: true,
      }, "human"),
      entry(4924, "2026-10-20T15:33:53Z", "ap_pay", { invoiceId: "inv-w", counterpartyId: WARDROBE, guardrailRule: "counterparty.new_payee", execution: { txRef: null, resultingStatus: "held" } }),
      entry(4927, "2026-10-20T15:35:10Z", "approval_paid", { by: OWNER, invoiceId: "inv-w", counterpartyId: WARDROBE, amount: "1.50", amountPaid: 1.5, currency: "USDC", txRef: "0x7948", status: "paid" }, "human"),
    ];
    const [row] = payeeLockEvidence({ ...base, entries: solo }).changes;
    expect(row.confirmation).toMatchObject({ secondPerson: false, soloConfirmation: true });
    expect(row.holds.map((hold) => hold.rule)).toEqual(["counterparty.new_payee"]);
    // Not a 32-byte hash, so no explorer link is made up for it.
    expect(row.firstPayment).toMatchObject({ amount: 1.5, decidedBy: "person", txRef: "0x7948", txUrl: null });
    expect(row.checks).toEqual({ recordKept: true, contactOnFileBefore: true, secondPerson: false, paidAfterConfirmation: true, paidAfterWait: true });
  });

  it("leaves an unconfirmed change without a confirmation, a payment or checks that do not apply", () => {
    const [row] = payeeLockEvidence({ ...base, entries: pinecrest.slice(0, 3) }).changes;
    expect(row.confirmation).toBeNull();
    expect(row.firstPayment).toBeNull();
    expect(row.checks).toEqual({ recordKept: null, contactOnFileBefore: null, secondPerson: null, paidAfterConfirmation: null, paidAfterWait: null });
    expect(row.holds).toHaveLength(1);
  });

  it("gives a confirmation to the change it confirmed, not to one that came before it", () => {
    const replaced = [
      entry(10, "2026-10-01T10:00:00Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: OLD, to: "0x1111" }, "human"),
      entry(11, "2026-10-01T11:00:00Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: "0x1111", to: NEW }, "human"),
      entry(12, "2026-10-01T12:00:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: NEW, verification: { method: "in_person", contactOnFileBefore: false } }, "human"),
    ];
    const rows = payeeLockEvidence({ ...base, entries: replaced }).changes;
    expect(rows.map((row) => row.change.to)).toEqual(["0x1111", NEW]);
    expect(rows[0].confirmation).toBeNull();
    expect(rows[1].confirmation).toMatchObject({ entry: 12, record: { method: "in_person", methodLabel: "In person", contactOnFileBefore: false } });
  });

  it("ignores a confirmation of another address, and a clear", () => {
    const entries = [
      entry(20, "2026-10-02T10:00:00Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: OLD, to: NEW }, "human"),
      entry(21, "2026-10-02T10:05:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: OLD }, "human"),
      entry(22, "2026-10-02T11:00:00Z", "counterparty_address_changed", { by: OWNER, counterpartyId: WARDROBE, from: "0x532a", to: null }, "human"),
    ];
    const rows = payeeLockEvidence({ ...base, entries }).changes;
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmation).toBeNull();
  });

  it("names who entered an address: a payee link, GitHub, the API, or a former member", () => {
    const entries = [
      entry(30, "2026-10-03T10:00:00Z", "counterparty_address_changed", { by: null, via: "payee_link", linkId: "link-1", counterpartyId: NORTHWIND, from: null, to: NEW }, "human"),
      entry(31, "2026-10-03T11:00:00Z", "counterparty_address_changed", { by: null, via: "github", login: "octocat", counterpartyId: WARDROBE, from: null, to: "0x532a" }, "human"),
      entry(32, "2026-10-03T12:00:00Z", "counterparty_address_changed", { by: OWNER, via: "api", counterpartyId: "cp-api", from: null, to: "0x9999" }, "human"),
      entry(33, "2026-10-03T13:00:00Z", "counterparty_address_changed", { by: "deadbeef-1234-4000-8000-000000000000", counterpartyId: "cp-gone", from: null, to: "0x8888" }, "human"),
    ];
    expect(payeeLockEvidence({ ...base, entries }).changes.map((row) => row.change.enteredBy)).toEqual([
      { kind: "payee_link", linkId: "link-1" },
      { kind: "github", login: "octocat" },
      { kind: "api" },
      { kind: "former_member", id: "deadbeef" },
    ]);
  });

  it("names the counterparties a confirmation's lookalike warning points to", () => {
    const entries = [
      entry(40, "2026-10-04T10:00:00Z", "counterparty_address_changed", { by: OWNER, counterpartyId: NORTHWIND, from: OLD, to: NEW }, "human"),
      entry(41, "2026-10-04T10:05:00Z", "counterparty_address_confirmed", { by: APPROVER, counterpartyId: NORTHWIND, address: NEW, lookalikeOf: [WARDROBE], looksLikeEarlier: OLD }, "human"),
    ];
    const [row] = payeeLockEvidence({ ...base, entries }).changes;
    expect(row.confirmation).toMatchObject({ lookalikeOf: [{ id: WARDROBE, name: "Wardrobe Holdings Ltd" }], looksLikeEarlier: OLD, record: null });
    expect(row.checks.recordKept).toBe(false);
  });

  it("keeps only the changes and lock changes inside the period", () => {
    const doc = payeeLockEvidence({ ...base, entries: pinecrest, period: { from: "2026-10-21", to: null } });
    expect(doc.changes).toEqual([]);
    expect(doc.lock.changes).toEqual([]);
    expect(payeeLockEvidence({ ...base, entries: pinecrest, period: { from: "2026-10-20", to: "2026-10-20" } }).changes).toHaveLength(1);
  });
});

describe("parsePeriod and the file name (EP1)", () => {
  it("takes whole UTC days, either end open, and refuses malformed or reversed ones", () => {
    expect(parsePeriod(null, null)).toEqual({ from: null, to: null });
    expect(parsePeriod("2026-10-01", "2026-10-31")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(parsePeriod("", "2026-10-31")).toEqual({ from: null, to: "2026-10-31" });
    expect(parsePeriod("2026-10-31", "2026-10-01")).toBeNull();
    expect(parsePeriod("2026-02-30", null)).toBeNull();
    expect(parsePeriod("10/01/2026", null)).toBeNull();
  });

  it("names the file for the workspace and the period", () => {
    expect(payeeLockEvidenceFileName("pinecrest-studio", { from: "2026-10-01", to: "2026-10-31" })).toBe("vestiarion-payee-lock-evidence-pinecrest-studio-2026-10-01-2026-10-31.json");
    expect(payeeLockEvidenceFileName("a/b\"c", { from: null, to: null })).toBe("vestiarion-payee-lock-evidence-abc-all-now.json");
  });
});
