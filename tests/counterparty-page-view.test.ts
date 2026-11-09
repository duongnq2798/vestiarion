import { describe, expect, it } from "vitest";
import {
  addressExplorer,
  addressFacts,
  CLOSED_SHOWN,
  copyOffWords,
  counterpartyTotals,
  invoiceGroups,
  milestoneAt,
  milestoneGroups,
  NO_EXPLORER,
  NOT_READ,
  OPEN_SHOWN,
  PAYMENTS_ALL,
  PAYMENTS_SHOWN,
  payeeLinkStates,
  payeeLinkTileWords,
  paymentRows,
  tiles,
  totalsByCurrency,
  USED_LINK_DAYS_MS,
  visibleRequest,
  type PayeeLinkRecord,
} from "@/lib/counterparties/page-view";
import type { DocumentReceivedView } from "@/lib/document-requests/rules";
import { milestoneDate } from "@/lib/milestone-date";
import { INVOICE_DAYS_MS } from "@/lib/platform/payee-links";
import type { InvoiceRow, MilestoneRow } from "@/lib/queries";

/**
 * What a counterparty's page shows, from what it read (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL5,
 * CL6, CL7, CL8, CL9, CL13): the address and whether it may be copied, each payee link's state, the groups, Payments and
 * the totals per currency, and the tiles.
 */

const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const ADDRESS = "0x8F3a6b1C2d4E5f60718293a4B5c6D7e8F9012345";
const at = (...codes: number[]) => String.fromCodePoint(...codes);

const payee = (over: { address?: string | null; address_changed_at?: string | null; address_confirmed_at?: string | null } = {}) => ({
  address: ADDRESS,
  address_changed_at: null,
  address_confirmed_at: null,
  ...over,
});
const CLEAN = { lookalikes: [], earlierLookalike: null, frozen: false };

describe("the payment address (CL5)", () => {
  it("CL5: tells the five states apart", () => {
    expect(addressFacts(payee({ address: null }), CLEAN).state).toBe("none");
    expect(addressFacts(payee(), CLEAN).state).toBe("set_when_added");
    expect(addressFacts(payee({ address_changed_at: iso(-2 * DAY), address_confirmed_at: iso(-DAY) }), CLEAN).state).toBe("confirmed");
    expect(addressFacts(payee({ address_changed_at: iso(-DAY), address_confirmed_at: iso(-2 * DAY) }), CLEAN).state).toBe("unconfirmed");
    expect(addressFacts(payee({ address_changed_at: iso(-DAY) }), CLEAN).state).toBe("unconfirmed");
    expect(addressFacts(payee({ address_changed_at: iso(-DAY) }), { ...CLEAN, frozen: true }).state).toBe("frozen");
    // Confirmed with no change recorded, as the payee lock asks of an address set when the payee was added.
    expect(addressFacts(payee({ address_confirmed_at: iso(-DAY) }), CLEAN).state).toBe("confirmed");
  });

  it("CL5: offers Copy address only for an address set when added or confirmed since", () => {
    expect(addressFacts(payee(), CLEAN)).toEqual({ state: "set_when_added", copyable: true, copyOff: null });
    expect(addressFacts(payee({ address_changed_at: iso(-2 * DAY), address_confirmed_at: iso(-DAY) }), CLEAN)).toEqual({ state: "confirmed", copyable: true, copyOff: null });
    expect(addressFacts(payee({ address_changed_at: iso(-DAY) }), CLEAN)).toEqual({ state: "unconfirmed", copyable: false, copyOff: { reason: "unconfirmed" } });
    expect(addressFacts(payee(), { ...CLEAN, frozen: true })).toEqual({ state: "frozen", copyable: false, copyOff: { reason: "frozen" } });
    // No address: nothing to copy, and nothing to say about it.
    expect(addressFacts(payee({ address: null }), CLEAN)).toEqual({ state: "none", copyable: false, copyOff: null });
  });

  it("CL5: turns copy off for an address like another counterparty's, or like an earlier one of this payee's", () => {
    const alike = { lookalikes: [{ kind: "alike" as const, id: "cp-2", name: "Northwind" }], earlierLookalike: null, frozen: false };
    expect(addressFacts(payee(), alike)).toEqual({ state: "set_when_added", copyable: false, copyOff: { reason: "lookalike", name: "Northwind" } });
    const same = { ...alike, lookalikes: [{ kind: "same" as const, id: "cp-3", name: "Globex" }] };
    expect(addressFacts(payee(), same).copyable).toBe(false);
    const earlier = { ...CLEAN, earlierLookalike: "0x8f3a6b0000000000000000000000000000002345" };
    expect(addressFacts(payee({ address_changed_at: iso(-2 * DAY), address_confirmed_at: iso(-DAY) }), earlier)).toEqual({
      state: "confirmed",
      copyable: false,
      copyOff: { reason: "earlier_lookalike" },
    });
  });

  it("CL5: says the reason no other step lifts first: a lookalike, then a freeze, then the confirmation", () => {
    const unconfirmed = payee({ address_changed_at: iso(-DAY) });
    const alike = [{ kind: "alike" as const, id: "cp-2", name: "Northwind" }];
    expect(addressFacts(unconfirmed, { lookalikes: alike, earlierLookalike: "0x1", frozen: true }).copyOff).toEqual({ reason: "lookalike", name: "Northwind" });
    expect(addressFacts(unconfirmed, { lookalikes: [], earlierLookalike: "0x1", frozen: true }).copyOff).toEqual({ reason: "earlier_lookalike" });
    expect(addressFacts(unconfirmed, { lookalikes: [], earlierLookalike: null, frozen: true }).copyOff).toEqual({ reason: "frozen" });
  });

  it("CL5, CL12: names a lookalike with nothing hidden in its name", () => {
    const sneaky = [{ kind: "alike" as const, id: "cp-2", name: `North${at(0x202e)}wind${at(0x200b)}\nTraders` }];
    expect(addressFacts(payee(), { lookalikes: sneaky, earlierLookalike: null, frozen: false }).copyOff).toEqual({ reason: "lookalike", name: "Northwind Traders" });
  });

  it("CL5: says why copy is off in the page's words, the lookalike's name apart", () => {
    expect(copyOffWords({ reason: "unconfirmed" })).toEqual({ before: "Copy comes back once someone confirms this address.", name: null, after: "" });
    expect(copyOffWords({ reason: "frozen" })).toEqual({ before: "Frozen: copy comes back once an owner or admin unfreezes it.", name: null, after: "" });
    const lookalike = copyOffWords({ reason: "lookalike", name: "Northwind" });
    expect(`${lookalike.before}${lookalike.name}${lookalike.after}`).toBe("Copy is off: this address looks like Northwind's. Check every character on the explorer.");
    expect(copyOffWords({ reason: "earlier_lookalike" }).before).toBe("Copy is off: this address looks like one this payee had before. Check every character on the explorer.");
  });

  it("CL5: links the address on its chain's explorer, and says so for a chain the workspace does not pay on", () => {
    expect(addressExplorer("arc-testnet", { address: ADDRESS, chain: "ARC-TESTNET" })).toEqual({ href: `https://explorer.testnet.arc.io/address/${ADDRESS}` });
    expect(addressExplorer("arc-testnet", { address: ADDRESS, chain: "BASE-SEPOLIA" })).toEqual({ href: `https://sepolia.basescan.org/address/${ADDRESS}` });
    // No chain is a row from before 0044, paid on the network's own chain.
    expect(addressExplorer("arc-mainnet", { address: ADDRESS, chain: null })).toEqual({ href: `https://explorer.arc.io/address/${ADDRESS}` });
    expect(addressExplorer("arc-mainnet", { address: ADDRESS, chain: "BASE-SEPOLIA" })).toEqual({ href: null, note: NO_EXPLORER });
    expect(NO_EXPLORER).toBe("Not a chain this workspace pays on, so there is no explorer link.");
    expect(addressExplorer("arc-testnet", { address: "acme.eth", chain: "ARC-TESTNET" })).toEqual({ href: null, note: null });
    expect(addressExplorer("arc-testnet", { address: null, chain: "ARC-TESTNET" })).toEqual({ href: null, note: null });
  });
});

const link = (id: string, over: Partial<PayeeLinkRecord> = {}): PayeeLinkRecord => ({
  id,
  created_at: iso(-DAY),
  expires_at: iso(6 * DAY),
  used_at: null,
  revoked_at: null,
  created_by: "user-owner",
  ...over,
});
const MEMBERS = [{ userId: "user-owner", email: "owner@acme.example" }];
const states = (links: PayeeLinkRecord[], now = NOW) => payeeLinkStates(links, { now, members: MEMBERS });

describe("payee links (CL6)", () => {
  it("CL6: a link unused, unexpired and unrevoked is out", () => {
    expect(states([link("a")])).toEqual([
      { id: "a", state: { kind: "out", expiresAt: iso(6 * DAY) }, label: "Out · expires Nov 15, 2026", invoice: null, madeBy: "Made by owner@acme.example" },
    ]);
  });

  it("CL6: one revoked at the instant a newer link was made was replaced by it, however the two times are written", () => {
    const lines = states([
      link("old", { created_at: "2026-11-01T09:00:00.123456+00:00", expires_at: "2026-11-08T09:00:00.123456+00:00", revoked_at: "2026-11-05T10:00:00.654321+00:00" }),
      link("new", { created_at: "2026-11-05T10:00:00.654321Z", expires_at: "2026-11-12T10:00:00.654321Z" }),
    ]);
    expect(lines.map((line) => [line.id, line.state.kind, line.label])).toEqual([
      ["new", "out", "Out · expires Nov 12, 2026"],
      ["old", "replaced", "Replaced by a newer link · Nov 5, 2026"],
    ]);
  });

  it("CL6: one revoked at any other time, even a microsecond off, was revoked", () => {
    const lines = states([
      link("old", { created_at: "2026-11-01T09:00:00.123456+00:00", expires_at: "2026-11-08T09:00:00+00:00", revoked_at: "2026-11-05T10:00:00.654320+00:00" }),
      link("new", { created_at: "2026-11-05T10:00:00.654321+00:00" }),
    ]);
    expect(lines[1].state).toEqual({ kind: "revoked", at: "2026-11-05T10:00:00.654320+00:00" });
    expect(lines[1].label).toBe("Revoked · Nov 5, 2026");
    // Revoked with no newer link, as Revoke does.
    expect(states([link("only", { revoked_at: iso(-DAY / 2) })])[0].state).toEqual({ kind: "revoked", at: iso(-DAY / 2) });
  });

  it("CL6: one past its expiry and never used expired unused, even when a newer link revoked it later", () => {
    expect(states([link("a", { expires_at: iso(-DAY) })])[0]).toMatchObject({ state: { kind: "expired", at: iso(-DAY) }, label: "Expired unused · Nov 8, 2026" });
    const lines = states([
      link("old", { created_at: iso(-10 * DAY), expires_at: iso(-3 * DAY), revoked_at: iso(-DAY) }),
      link("new", { created_at: iso(-DAY) }),
    ]);
    expect(lines[1].state).toEqual({ kind: "expired", at: iso(-3 * DAY) });
  });

  it("CL6: one used is used, with no invoice when it asked for none", () => {
    expect(states([link("a", { used_at: iso(-2 * DAY) })])[0]).toMatchObject({ state: { kind: "used", at: iso(-2 * DAY), invoice: null }, label: "Used · Nov 7, 2026", invoice: null });
    // Before 0133 there is no invoice column at all.
    expect(states([link("a", { used_at: iso(-40 * DAY) })])[0].invoice).toBeNull();
  });

  it("CL6: a used link that asked for an invoice says it was sent, waits for it within 30 days, or was closed", () => {
    const asks = { asks_invoice: true, invoice_at: null, invoice_closed_at: null };
    expect(states([link("a", { ...asks, used_at: iso(-2 * DAY), invoice_at: iso(-DAY) })])[0].invoice).toBe("Invoice sent · Nov 8, 2026");
    const waiting = states([link("a", { ...asks, used_at: iso(-2 * DAY) })])[0];
    expect(waiting.state).toEqual({ kind: "used", at: iso(-2 * DAY), invoice: { kind: "waiting", until: iso(28 * DAY) } });
    expect(waiting.invoice).toBe("Waiting for their invoice · until Dec 7, 2026");
    // A member closed it, with Revoke or by making a newer link.
    expect(states([link("a", { ...asks, used_at: iso(-2 * DAY), invoice_closed_at: iso(-DAY) })])[0].invoice).toBe("Invoice closed");
  });

  it("CL6: a used link takes its invoice for 30 days, and after them it is closed", () => {
    const asks = { asks_invoice: true, invoice_at: null, invoice_closed_at: null };
    expect(states([link("a", { ...asks, used_at: iso(-30 * DAY + 1) })])[0].state).toMatchObject({ invoice: { kind: "waiting" } });
    expect(states([link("a", { ...asks, used_at: iso(-30 * DAY) })])[0].invoice).toBe("Invoice closed");
    expect(states([link("a", { ...asks, used_at: iso(-31 * DAY) })])[0].invoice).toBe("Invoice closed");
    // A sent invoice stays sent.
    expect(states([link("a", { ...asks, used_at: iso(-60 * DAY), invoice_at: iso(-59 * DAY) })])[0].invoice).toBe("Invoice sent · Sep 11, 2026");
  });

  it("CL6: counts the 30 days as the payee link functions do", () => {
    expect(USED_LINK_DAYS_MS).toBe(INVOICE_DAYS_MS);
  });

  it("CL6: names who made each link, or a former member", () => {
    const lines = states([link("a", { created_by: "user-owner" }), link("b", { created_by: "user-gone", created_at: iso(-2 * DAY) }), link("c", { created_by: null, created_at: iso(-3 * DAY) })]);
    expect(lines.map((line) => line.madeBy)).toEqual(["Made by owner@acme.example", "Made by a former member", "Made by a former member"]);
  });

  it("CL6: lists the newest link first", () => {
    const lines = states([link("oldest", { created_at: iso(-9 * DAY), expires_at: iso(-2 * DAY) }), link("newest", { created_at: iso(-DAY) }), link("middle", { created_at: iso(-5 * DAY), expires_at: iso(-DAY) })]);
    expect(lines.map((line) => line.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("CL6: says the tile's state: out, waiting for an invoice, or none", () => {
    expect(payeeLinkTileWords({ active: { expiresAt: iso(6 * DAY) }, waiting: { until: iso(20 * DAY) } })).toBe("Out · expires Nov 15, 2026");
    expect(payeeLinkTileWords({ active: null, waiting: { until: iso(20 * DAY) } })).toBe("Waiting for their invoice · until Nov 29, 2026");
    expect(payeeLinkTileWords({ active: null, waiting: null })).toBe("None out");
  });
});

const invoice = (id: string, over: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id,
  direction: "payable",
  counterparty_id: "cp-1",
  counterparty_name: "Acme",
  amount: 100,
  memo: null,
  po_reference: null,
  goods_received: false,
  due_date: "2026-11-20",
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: null,
  currency: "USDC",
  ...over,
});
const milestone = (id: string, over: Partial<MilestoneRow> = {}): MilestoneRow => ({
  id,
  contractor_id: "cp-1",
  contractor_name: "Acme",
  title: `Milestone ${id}`,
  amount: 50,
  verification_source: null,
  verification_method: "manual",
  verification_status: "unverified",
  verification_checked_at: null,
  verified_at: null,
  verification_detail: {},
  verified: false,
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
  ...over,
});
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe("milestones, bills and invoices (CL7, CL8)", () => {
  it("CL7: groups a payee's milestones: open, closed without paying, and paid for Payments", () => {
    const groups = milestoneGroups([
      milestone("pending"),
      milestone("paid", { status: "paid" }),
      milestone("closed-old", { status: "closed", closed_at: iso(-5 * DAY) }),
      milestone("verified", { status: "verified" }),
      milestone("closed-new", { status: "closed", closed_at: iso(-DAY) }),
      milestone("held", { status: "held" }),
    ]);
    expect(ids(groups.open)).toEqual(["pending", "verified", "held"]);
    expect(ids(groups.closed)).toEqual(["closed-new", "closed-old"]);
    expect(ids(groups.paid)).toEqual(["paid"]);
  });

  it("CL8: groups a payee's bills: open by due date, being paid too, then the latest rejected", () => {
    const groups = invoiceGroups(
      [
        invoice("late", { due_date: "2026-12-01" }),
        invoice("paid", { status: "paid" }),
        invoice("processing", { status: "processing", due_date: "2026-11-10" }),
        invoice("rejected-old", { status: "rejected", created_at: iso(-9 * DAY) }),
        invoice("held", { status: "held", due_date: "2026-11-15" }),
        invoice("rejected-new", { status: "rejected", created_at: iso(-DAY) }),
        invoice("scheduled", { status: "scheduled", scheduled_for: "2026-11-18", due_date: "2026-11-25" }),
        invoice("theirs", { direction: "receivable", due_date: "2026-11-01" }),
      ],
      "vendor"
    );
    expect(ids(groups.open.rows)).toEqual(["processing", "held", "scheduled", "late"]);
    expect(groups.open.count).toBe(4);
    expect(ids(groups.closed.rows)).toEqual(["rejected-new", "rejected-old"]);
    expect(ids(groups.paid)).toEqual(["paid"]);
  });

  it("CL8: shows the first 200 open bills and the latest 10 rejected, and counts them all", () => {
    const open = Array.from({ length: OPEN_SHOWN + 5 }, (_, index) => invoice(`open-${index}`, { due_date: `2027-01-${String((index % 28) + 1).padStart(2, "0")}` }));
    const rejected = Array.from({ length: CLOSED_SHOWN + 3 }, (_, index) => invoice(`rejected-${index}`, { status: "rejected", created_at: iso(-index * DAY) }));
    const groups = invoiceGroups([...open, ...rejected], "contractor");
    expect(groups.open.rows).toHaveLength(OPEN_SHOWN);
    expect(groups.open.count).toBe(OPEN_SHOWN + 5);
    expect(groups.closed.rows).toHaveLength(CLOSED_SHOWN);
    expect(groups.closed.count).toBe(CLOSED_SHOWN + 3);
    expect(groups.closed.rows[0].id).toBe("rejected-0");
  });

  it("CL8: groups a client's invoices: open, and the latest received", () => {
    const groups = invoiceGroups(
      [
        invoice("open", { direction: "receivable" }),
        invoice("received-old", { direction: "receivable", status: "received", settled_at: iso(-9 * DAY) }),
        invoice("paid-new", { direction: "receivable", status: "paid", settled_at: iso(-DAY) }),
        invoice("refund", { direction: "payable" }),
      ],
      "client"
    );
    expect(ids(groups.open.rows)).toEqual(["open"]);
    expect(ids(groups.closed.rows)).toEqual(["paid-new", "received-old"]);
    expect(ids(groups.paid)).toEqual(["paid-new", "received-old"]);
  });
});

describe("Payments and totals (CL9)", () => {
  it("CL9: merges paid milestones and paid bills, newest first by the date each row shows", () => {
    const rows = paymentRows(
      {
        milestones: [
          { milestone: milestone("m-old", { status: "paid" }), paidAt: "2026-10-02T09:00:00Z" },
          { milestone: milestone("m-new", { status: "paid" }), paidAt: "2026-11-08T09:00:00Z" },
        ],
        invoices: [invoice("b-mid", { status: "paid", due_date: "2026-10-20" }), invoice("b-new", { status: "paid", due_date: "2026-11-09" })],
      },
      false
    );
    expect(rows.shown.map((row) => (row.kind === "milestone" ? row.milestone.id : row.invoice.id))).toEqual(["b-new", "m-new", "b-mid", "m-old"]);
    expect(rows.count).toBe(4);
  });

  it("CL9: puts a milestone whose time of payment was not read last", () => {
    const rows = paymentRows(
      {
        milestones: [
          { milestone: milestone("m-unread", { status: "paid" }), paidAt: null },
          { milestone: milestone("m-old", { status: "paid" }), paidAt: "2026-10-02T09:00:00Z" },
        ],
        invoices: [invoice("b-old", { status: "paid", due_date: "2026-09-20" })],
      },
      false
    );
    expect(rows.shown.map((row) => (row.kind === "milestone" ? row.milestone.id : row.invoice.id))).toEqual(["m-old", "b-old", "m-unread"]);
    expect(rows.shown.at(-1)?.at).toBeNull();
  });

  it("CL9: dates a paid milestone by its payment's confirmation, then when it was sent, then the entry its decision rests on", () => {
    const paid = milestone("m", { status: "paid" });
    const entry = "2026-11-02T09:00:00Z";
    expect(milestoneAt(paid, { confirmed_at: "2026-11-01T10:00:00Z", executed_at: "2026-11-01T09:58:00Z" }, entry)).toBe("2026-11-01T10:00:00Z");
    expect(milestoneAt(paid, { confirmed_at: null, executed_at: "2026-11-01T09:58:00Z" }, entry)).toBe("2026-11-01T09:58:00Z");
    expect(milestoneAt(paid, { confirmed_at: null, executed_at: null }, entry)).toBe(entry);
    expect(milestoneAt(paid, undefined, entry)).toBe(entry);
    // Neither read: no time at all, never the time of the request.
    expect(milestoneAt(paid, undefined, null)).toBeNull();
    // A milestone not paid is dated by its entry alone, whatever its payment says.
    expect(milestoneAt(milestone("h", { status: "held" }), { confirmed_at: "2026-11-01T10:00:00Z", executed_at: null }, entry)).toBe(entry);
    expect(milestoneAt(milestone("h", { status: "held" }), undefined, null)).toBeNull();
  });

  it("CL9: shows the latest 10, or up to 500 when every payment is asked for", () => {
    const invoices = Array.from({ length: PAYMENTS_ALL + 20 }, (_, index) => invoice(`b-${index}`, { status: "paid", due_date: new Date(NOW - index * DAY).toISOString().slice(0, 10) }));
    const latest = paymentRows({ milestones: [], invoices }, false);
    expect(latest.shown).toHaveLength(PAYMENTS_SHOWN);
    expect(latest.count).toBe(PAYMENTS_ALL + 20);
    expect(latest.shown[0]).toMatchObject({ kind: "invoice", invoice: { id: "b-0" } });
    expect(paymentRows({ milestones: [], invoices }, true).shown).toHaveLength(PAYMENTS_ALL);
  });

  it("CL9: totals each currency apart, USDC first, and never adds USDC and EURC together", () => {
    expect(totalsByCurrency([{ amount: 40, currency: "EURC" }, { amount: 100, currency: "USDC" }, { amount: 20 }])).toEqual([
      { currency: "USDC", amount: 120 },
      { currency: "EURC", amount: 40 },
    ]);
    expect(totalsByCurrency([{ amount: 40, currency: "EURC" }])).toEqual([{ currency: "EURC", amount: 40 }]);
    expect(totalsByCurrency([])).toEqual([]);
    // Summed in millionths: no float error.
    expect(totalsByCurrency([{ amount: 0.1, currency: "USDC" }, { amount: 0.2, currency: "USDC" }, { amount: 0.000001, currency: "USDC" }])).toEqual([{ currency: "USDC", amount: 0.300001 }]);
  });

  it("CL9, CL13: totals what is owed to a payee and what was paid, from every row read", () => {
    const bills = [
      invoice("open", { amount: 100 }),
      invoice("open-eurc", { amount: 30, currency: "EURC" }),
      invoice("paying", { amount: 5, status: "processing" }),
      invoice("paid", { amount: 80, paid_amount: 78.4, status: "paid" }),
      invoice("paid-eurc", { amount: 10, currency: "EURC", status: "paid" }),
      invoice("rejected", { amount: 999, status: "rejected" }),
      ...Array.from({ length: OPEN_SHOWN }, (_, index) => invoice(`more-${index}`, { amount: 1 })),
    ];
    const work = [milestone("open", { amount: 50 }), milestone("held", { amount: 25, status: "held" }), milestone("paid", { amount: 60, status: "paid" }), milestone("closed", { amount: 999, status: "closed" })];
    expect(counterpartyTotals("contractor", bills, work)).toEqual({
      owed: [
        { currency: "USDC", amount: 100 + 5 + OPEN_SHOWN + 50 + 25 },
        { currency: "EURC", amount: 30 },
      ],
      paid: [
        { currency: "USDC", amount: 138.4 },
        { currency: "EURC", amount: 10 },
      ],
    });
  });

  it("CL9: totals what a client owes and paid, from its invoices alone", () => {
    const rows = [
      invoice("open", { direction: "receivable", amount: 200 }),
      invoice("received", { direction: "receivable", amount: 150, status: "received" }),
      invoice("refund", { direction: "payable", amount: 999 }),
    ];
    expect(counterpartyTotals("client", rows, [milestone("stray", { amount: 999 })])).toEqual({ owed: [{ currency: "USDC", amount: 200 }], paid: [{ currency: "USDC", amount: 150 }] });
  });

  it("CL9: dates a milestone's row as Contractors does", () => {
    expect(milestoneDate(undefined, iso(0))).toBeNull();
    expect(milestoneDate(milestone("m", { status: "paid" }), "2026-11-08T09:00:00Z")).toEqual({ label: "Paid Nov 8, 2026" });
    expect(milestoneDate(milestone("m", { status: "closed", closed_at: "2026-11-07T09:00:00Z" }), "2026-11-08T09:00:00Z")).toEqual({ label: "Closed Nov 7, 2026" });
    expect(milestoneDate(milestone("m", { status: "closed" }), "2026-11-08T09:00:00Z")).toEqual({ label: "Closed Nov 8, 2026" });
    expect(milestoneDate(milestone("m", { status: "held" }), "2026-11-08T09:00:00Z")).toEqual({ label: "Held Nov 8, 2026", tone: "held" });
    expect(milestoneDate(milestone("m", { status: "verified", verified_at: "2026-11-06T09:00:00Z" }), "2026-11-08T09:00:00Z")).toEqual({ label: "Verified Nov 6, 2026" });
    expect(milestoneDate(milestone("m", { status: "verified" }), "2026-11-08T09:00:00Z")).toEqual({ label: "Verified" });
    expect(milestoneDate(milestone("m"), "2026-11-08T09:00:00Z")).toEqual({ label: "Awaiting verification" });
  });

  it("CL9: names a milestone's state without a day when its time was not read", () => {
    expect(milestoneDate(milestone("m", { status: "paid" }), null)).toEqual({ label: "Paid" });
    expect(milestoneDate(milestone("m", { status: "held" }), null)).toEqual({ label: "Held", tone: "held" });
    expect(milestoneDate(milestone("m", { status: "closed" }), null)).toEqual({ label: "Closed" });
    expect(milestoneDate(milestone("m", { status: "closed", closed_at: "2026-11-07T09:00:00Z" }), null)).toEqual({ label: "Closed Nov 7, 2026" });
  });
});

describe("documents (CL10, CL12)", () => {
  const sent = (over: Partial<DocumentReceivedView> = {}): DocumentReceivedView => ({
    state: "answered",
    id: "req-1",
    missing: ["purchase_order"],
    answeredAt: "2026-11-08T10:00:00Z",
    note: `Paid${at(0x202e)} to 0xabc${at(0x200b)}\n\n${at(0x2066)}${at(0x2069)}\nThanks`,
    poReference: `PO-${at(0xfeff)}77`,
    fileType: "application/pdf",
    ...over,
  });

  it("CL12: keeps only what shows of the vendor's note and purchase order number, and the note's lines", () => {
    expect(visibleRequest(sent())).toEqual(sent({ note: "Paid to 0xabc\nThanks", poReference: "PO-77" }));
  });

  it("CL12: cleans what a vendor sent with an earlier request, under a newer one", () => {
    const asked = { state: "asked" as const, id: "req-2", missing: ["purchase_order" as const], sentAt: "2026-11-08T11:00:00Z", expiresAt: "2026-11-22T11:00:00Z", received: sent() };
    expect(visibleRequest(asked)).toEqual({ ...asked, received: sent({ note: "Paid to 0xabc\nThanks", poReference: "PO-77" }) });
    const expired = { state: "expired" as const, missing: ["purchase_order" as const], sentAt: "2026-10-01T11:00:00Z", expiresAt: "2026-10-15T11:00:00Z" };
    expect(visibleRequest(expired)).toBe(expired);
  });

  it("CL12: makes a note or a number with nothing visible in it none, and leaves one never typed as it was", () => {
    expect(visibleRequest(sent({ note: `${at(0x202e)}\n${at(0x200b)}`, poReference: at(0x2800) }))).toEqual(sent({ note: null, poReference: null }));
    const plain = { state: "answered" as const, missing: ["purchase_order" as const], answeredAt: "2026-11-08T10:00:00Z" };
    expect(visibleRequest(plain)).toEqual(plain);
  });
});

describe("the tiles (CL9, CL13)", () => {
  const read = <T>(value: T) => ({ read: true as const, value });
  const failed = { read: false as const };

  it("CL9: gives a payee's tiles: owed, paid, the address and, for a writer, the payee link", () => {
    const shown = tiles({
      role: "vendor",
      invoices: read([invoice("open", { amount: 100 }), invoice("eurc", { amount: 40, currency: "EURC" })]),
      milestones: read([milestone("paid", { amount: 60, status: "paid" })]),
      address: read("unconfirmed" as const),
      payeeLink: read({ active: { expiresAt: iso(6 * DAY) }, waiting: null }),
    });
    expect(shown).toEqual([
      { label: "Owed to them", value: { kind: "money", totals: [{ currency: "USDC", amount: 100 }, { currency: "EURC", amount: 40 }] }, held: false },
      { label: "Paid to them", value: { kind: "money", totals: [{ currency: "USDC", amount: 60 }] }, held: false },
      { label: "Address", value: { kind: "words", words: "To confirm" }, held: true },
      { label: "Payee link", value: { kind: "words", words: "Out · expires Nov 15, 2026" }, held: false },
    ]);
  });

  it("CL13: says Not read for a tile whose part failed, never 0 or none", () => {
    const shown = tiles({ role: "contractor", invoices: read([]), milestones: failed, address: failed, payeeLink: failed });
    expect(shown.map((tile) => [tile.label, tile.value])).toEqual([
      ["Owed to them", { kind: "words", words: NOT_READ }],
      ["Paid to them", { kind: "words", words: NOT_READ }],
      ["Address", { kind: "words", words: NOT_READ }],
      ["Payee link", { kind: "words", words: NOT_READ }],
    ]);
    expect(NOT_READ).toBe("Not read");
    expect(tiles({ role: "contractor", invoices: failed, milestones: read([]), address: read("none" as const), payeeLink: null })[0].value).toEqual({ kind: "words", words: NOT_READ });
  });

  it("CL3, CL9: gives no payee link tile to a member who does not send links, nor on a client's page", () => {
    expect(tiles({ role: "vendor", invoices: read([]), milestones: read([]), address: read("confirmed" as const), payeeLink: null }).map((tile) => tile.label)).toEqual(["Owed to them", "Paid to them", "Address"]);
    const client = tiles({ role: "client", invoices: read([]), milestones: failed, address: read("none" as const), payeeLink: read({ active: null, waiting: null }) });
    expect(client.map((tile) => tile.label)).toEqual(["Owed by them", "Paid by them", "Address"]);
    // A client's milestones are not read, so they never make its totals Not read; no address is no one's to wait on.
    expect(client[0].value).toEqual({ kind: "money", totals: [] });
    expect(client[2]).toEqual({ label: "Address", value: { kind: "words", words: "None" }, held: false });
  });

  it("CL5: says each address state in the tile's words", () => {
    const words = (["none", "set_when_added", "confirmed", "unconfirmed", "frozen"] as const).map((state) => {
      const tile = tiles({ role: "vendor", invoices: read([]), milestones: read([]), address: read(state), payeeLink: null })[2];
      return [tile.value, tile.held];
    });
    expect(words).toEqual([
      [{ kind: "words", words: "None" }, true],
      [{ kind: "words", words: "Set when added" }, false],
      [{ kind: "words", words: "Confirmed" }, false],
      [{ kind: "words", words: "To confirm" }, true],
      [{ kind: "words", words: "Frozen" }, true],
    ]);
  });
});
