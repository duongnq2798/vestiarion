import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CounterpartyPageRead, PageReadOptions } from "@/lib/counterparties/page-read";
import { NO_EXPLORER, PART_NOT_READ, type PayeeLinkRecord } from "@/lib/counterparties/page-view";
import { COUNTERPARTY_SECTIONS } from "@/lib/counterparty-paths";
import { addressOnChainUrl, chainOn } from "@/lib/payee-chains";
import { PAYEE_LOCK_OFF } from "@/lib/payee-lock-rules";
import type { CounterpartyRow, InvoiceRow, MilestoneRow } from "@/lib/queries";

/**
 * A counterparty's page (docs/superpowers/specs/2026-11-09-counterparty-page-design.md), as each member reads it: the
 * workspace's own counterparty only, a 404 alike for an id that is not one and for another workspace's (CL2), the held
 * callout when it cannot be read, what each grant shows (CL3, CL5, CL6), a client's page without a payee's parts (CL1),
 * the explorer link only for an address it can name (CL5), each part's id once, and never a link's secret (CL4). The
 * membership, the scope, the readers and the shell are stood in for, as on the evidence page's test; the readers' own
 * test reads.
 */

vi.mock("server-only", () => ({}));

const { readCounterpartyMock, readPageMock, cosignsMock, payeeLinkControl, shell, ACCESS } = vi.hoisted(() => ({
  readCounterpartyMock: vi.fn(),
  readPageMock: vi.fn(),
  cosignsMock: vi.fn(async () => false),
  payeeLinkControl: [] as Array<Record<string, unknown>>,
  shell: { crumb: undefined as string | undefined },
  ACCESS: {
    user: { id: "u-alice", email: "alice@northstar.test" },
    membership: { orgId: "org-1", slug: "northstar", name: "Northstar", mode: "live", role: "viewer", network: "arc-testnet" },
  },
}));
vi.mock("@/lib/auth/membership", () => ({ requireMembership: vi.fn(async () => ACCESS) }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/queries", () => ({ readCounterparty: readCounterpartyMock, stats: async () => ({ day: 3, clockMode: "real", lastCycleAt: null }) }));
vi.mock("@/lib/counterparties/page-read", () => ({ readCounterpartyPage: readPageMock }));
vi.mock("@/lib/approval-policy", () => ({ cosignsNow: cosignsMock }));
vi.mock("@/lib/workspace-network", () => ({ workspaceNetwork: () => ({ id: "arc-testnet" }) }));
vi.mock("@/lib/compliance", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/compliance")>()), screeningMode: () => "simulate" }));
vi.mock("@/lib/shell-status", () => ({ shellStatus: async () => ({ shadow: false, screening: { live: true, source: "OpenSanctions" } }) }));
vi.mock("@/lib/circle", () => ({ shellModes: () => ({ mode: "live", earnMode: "simulate", held: false }) }));
vi.mock("@/components/AutoRefresh", () => ({ AutoRefresh: () => null }));
// The shell draws the frame from the layout's context, which a page alone does not have: the page's own content is what is read here.
vi.mock("@/components/vx/Shell", async (importOriginal) => {
  const { TooltipProvider } = await import("@/components/ui/Tooltip");
  return {
    ...(await importOriginal<typeof import("@/components/vx/Shell")>()),
    ProductShell: ({ children, crumb }: { children: ReactNode; crumb?: string }) => {
      shell.crumb = crumb;
      return <TooltipProvider>{children}</TooltipProvider>;
    },
  };
});
// The control is a client component whose dialog opens on a click: what the page hands it is what is read here.
vi.mock("@/components/intake/PayeeLinkControl", () => ({
  default: (props: Record<string, unknown>) => {
    payeeLinkControl.push(props);
    return <div data-payee-link-control />;
  },
}));
vi.mock("@/app/actions/intake", () => ({
  unfreezeCounterpartyAction: vi.fn(),
  confirmCounterpartyAddressAction: vi.fn(),
  updateCounterpartyAddressAction: vi.fn(),
  lookupAddressNameAction: vi.fn(),
  updateCounterpartyLimitAction: vi.fn(),
  updateCounterpartyNoticeEmailAction: vi.fn(),
  updateCounterpartyPurchaseOrdersAction: vi.fn(),
  createInvoiceAction: vi.fn(),
}));
vi.mock("@/app/actions/bank-payouts", () => ({ setBankAccountAction: vi.fn(), stopBankAccountAction: vi.fn() }));
vi.mock("@/app/actions/policy-replay", () => ({ tryRuleAction: vi.fn() }));
vi.mock("@/app/actions/payee-links", () => ({ createPayeeLinkAction: vi.fn(), revokePayeeLinkAction: vi.fn() }));
vi.mock("@/app/actions/compliance", () => ({ dismissScreeningMatchAction: vi.fn(), screenAgainAction: vi.fn() }));
vi.mock("@/app/actions/mirror-address", () => ({ giveMirrorAddressAction: vi.fn() }));
vi.mock("@/app/actions/vendor-statement", () => ({ checkVendorStatementAction: vi.fn() }));
vi.mock("@/app/actions/receipts", () => ({ shareReceiptAction: vi.fn(), stopSharingReceiptAction: vi.fn() }));
vi.mock("@/app/actions/recurring", () => ({ createRecurringPayableAction: vi.fn(), stopRecurringPayableAction: vi.fn() }));

import CounterpartyPage, { metadata } from "@/app/o/[slug]/counterparties/[id]/page";
import { RECEIPT_STATE_NOT_READ } from "@/components/ReceiptControl";

/** A character by its code point, so none hides in this file. */
const at = (...codes: number[]) => String.fromCodePoint(...codes);
const text =(markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const ID = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
const ADDRESS = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
const EXPLORER = addressOnChainUrl(chainOn("arc-testnet", null), ADDRESS) as string;
const TX = `0x${"ab".repeat(32)}`;
const NOW = Date.parse("2026-11-09T12:00:00Z");

const CONTRACTOR: CounterpartyRow = {
  id: ID,
  name: "Linh Tran",
  role: "contractor",
  address: ADDRESS,
  chain: null,
  jurisdiction: "VN",
  risk_level: "clear",
  risk_notes: null,
  payment_limit: 500,
  baseline_payment_limit: 500,
  last_screened_at: null,
  performance_score: null,
  performance_inputs: null,
  // A changed address no one has confirmed yet.
  address_changed_at: "2026-11-08T10:00:00Z",
  address_confirmed_at: null,
  sample: false,
  notice_email: "linh@example.test",
  purchase_order_required: false,
  mirror_wallet_id: null,
  frozen_at: null,
};
const CONFIRMED: CounterpartyRow = { ...CONTRACTOR, address_confirmed_at: "2026-11-08T11:00:00Z" };
const CLIENT: CounterpartyRow = { ...CONTRACTOR, role: "client", name: "Acme Retail", address: null, address_changed_at: null };

const invoice = (over: Partial<InvoiceRow>): InvoiceRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  direction: "payable",
  counterparty_id: ID,
  counterparty_name: CONTRACTOR.name,
  amount: 120,
  memo: "October retainer",
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
const OPEN_BILL = invoice({});
const PAID_BILL = invoice({ id: "00000000-0000-4000-8000-000000000002", memo: "September retainer", due_date: "2026-10-20", status: "paid", tx_ref: TX, paid_amount: 120 });

const MILESTONE: MilestoneRow = {
  id: "00000000-0000-4000-9000-000000000001",
  contractor_id: ID,
  contractor_name: CONTRACTOR.name,
  title: "Five October posts",
  amount: 40,
  verification_source: null,
  verification_method: "manual",
  verification_status: "pending",
  verification_checked_at: null,
  verified_at: null,
  verification_detail: {},
  verified: false,
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
};

const LINK: PayeeLinkRecord = {
  id: "link-1",
  created_at: "2026-11-08T09:00:00Z",
  expires_at: "2026-11-15T09:00:00Z",
  used_at: null,
  revoked_at: null,
  created_by: "u-alice",
};

/** What the reader hands back: every part read, a payee's parts for a payee, the payee links for a writer. */
function pageRead(counterparty: CounterpartyRow, options: PageReadOptions, over: Partial<CounterpartyPageRead> = {}): CounterpartyPageRead {
  const payee = counterparty.role !== "client";
  return {
    invoices: { read: true, value: payee ? [OPEN_BILL, PAID_BILL] : [invoice({ direction: "receivable", counterparty_name: CLIENT.name, counterparty_id: ID })] },
    milestones: payee ? { read: true, value: [MILESTONE] } : null,
    entries: { read: true, value: { entries: [], cut: new Set() } },
    payments: { read: true, value: { payments: new Map(), destinations: new Map() } },
    receipts: payee ? { read: true, value: new Map([[PAID_BILL.id, "shared" as const]]) } : null,
    address: { read: true, value: { lookalikes: [], earlierLookalike: null, frozen: false } },
    addressCheck: null,
    payeeLock: PAYEE_LOCK_OFF,
    payeeLinks:
      payee && options.grants.seeLinks
        ? { read: true, value: { links: [LINK], active: { id: LINK.id, expiresAt: LINK.expires_at }, waiting: null, members: [{ userId: "u-alice", email: "alice@northstar.test" }] } }
        : null,
    evidence: { asana: null, linear: null, jira: null, links: new Map() },
    documents: payee ? { read: true, value: new Map() } : null,
    drafts: payee ? { read: true, value: [] } : null,
    history: { read: true, value: [{ seq: 41, ts: "2026-11-08T10:00:00Z", actor: "human", action: "counterparty_address_changed", summary: "Changed the payment address of Linh Tran" }] },
    controls: { shadow: false, chainChoices: ["Arc testnet", "Base Sepolia"], bank: null },
    ...over,
  };
}

const params = (id: string, history?: string) => ({
  params: Promise.resolve({ slug: "northstar", id }),
  searchParams: Promise.resolve(history ? { history } : {}),
});
const page = async (id = ID, history?: string) => renderToStaticMarkup(await CounterpartyPage(params(id, history)));
const notFoundError = expect.objectContaining({ digest: expect.stringContaining("404") });

function showing(counterparty: CounterpartyRow, over: Partial<CounterpartyPageRead> = {}) {
  readCounterpartyMock.mockResolvedValue(counterparty);
  readPageMock.mockImplementation(async (row: CounterpartyRow, options: PageReadOptions) => pageRead(row, options, over));
}

beforeEach(() => {
  readCounterpartyMock.mockReset();
  readPageMock.mockReset();
  cosignsMock.mockReset();
  cosignsMock.mockResolvedValue(false);
  payeeLinkControl.length = 0;
  shell.crumb = undefined;
  ACCESS.membership.role = "viewer";
  ACCESS.membership.mode = "live";
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

describe("whose page it is (CL2)", () => {
  it("is titled Counterparty, whoever it shows (CL16)", () => {
    expect(metadata.title).toBe("Counterparty");
  });

  it("CL2: an id that is not one is a 404 before anything is read", async () => {
    await expect(CounterpartyPage(params("not-a-uuid"))).rejects.toEqual(notFoundError);
    await expect(CounterpartyPage(params(`${ID}/x`))).rejects.toEqual(notFoundError);
    expect(readCounterpartyMock).not.toHaveBeenCalled();
    expect(readPageMock).not.toHaveBeenCalled();
  });

  it("CL2: another workspace's counterparty is a 404, like one that does not exist", async () => {
    // Read through the workspace's scope, a row of another workspace comes back as none.
    readCounterpartyMock.mockResolvedValue(null);
    await expect(CounterpartyPage(params(ID))).rejects.toEqual(notFoundError);
    expect(readPageMock).not.toHaveBeenCalled();
  });

  it("CL2: reads the id lowercased, and every later part from the row read", async () => {
    showing(CONFIRMED);
    await page(ID.toUpperCase());
    expect(readCounterpartyMock).toHaveBeenCalledWith(ID);
    expect(readPageMock).toHaveBeenCalledWith(CONFIRMED, expect.objectContaining({ orgId: "org-1", network: "arc-testnet", history: false }));
  });

  it("CL2: a counterparty that cannot be read is said so, with the way back, never as a 404", async () => {
    readCounterpartyMock.mockRejectedValue(new Error("connection reset for Linh Tran"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const markup = await page();
    expect(text(markup)).toContain("This counterparty could not be read just now. Reload the page in a moment.");
    expect(text(markup)).toContain("All counterparties");
    expect(markup).toContain(`href="/o/northstar/counterparties#counterparty-${ID}"`);
    expect(readPageMock).not.toHaveBeenCalled();
    // CL4: the log names the part and the error's name, never what its message carries.
    expect(JSON.stringify(error.mock.calls)).not.toContain("Linh Tran");
    error.mockRestore();
  });
});

describe("what each member sees (CL3, CL5, CL6, CL9, CL11)", () => {
  it("CL3: a viewer sees History and receipt state, but no payee link control and no Copy on an unconfirmed address", async () => {
    showing(CONTRACTOR);
    const markup = await page();
    const words = text(markup);
    // The reader is told the viewer may see no payee link, so none is read (CL3).
    expect(readPageMock.mock.calls[0][1].grants).toEqual(expect.objectContaining({ write: false, seeLinks: false, shareReceipts: false }));
    expect(words).toContain("An owner or admin sends and stops payee links.");
    expect(payeeLinkControl).toHaveLength(0);
    expect(words).not.toContain("Payee link Out");
    // CL5: the address in full, its explorer, and why there is no Copy.
    expect(words).toContain(ADDRESS);
    expect(markup).toContain(`href="${EXPLORER}"`);
    expect(words).not.toContain("Copy address");
    expect(words).toContain("Copy comes back once someone confirms this address.");
    // CL9: the paid bill's receipt state, which Bills shows only a writer; never a control to share it.
    expect(words).toContain("Receipt shared");
    expect(words).not.toContain("Share receipt");
    expect(words).not.toContain("New link");
    // CL11: History, linking each entry to the Audit log.
    expect(words).toContain("History");
    expect(words).toContain("Changed the payment address of Linh Tran");
    expect(markup).toContain('href="/o/northstar/audit?domain=compliance"');
  });

  it("CL6: a writer gets the payee link control with the list's props and offers, and the links' history", async () => {
    ACCESS.membership.role = "owner";
    showing(CONFIRMED);
    const markup = await page();
    expect(readPageMock.mock.calls[0][1].grants).toEqual(expect.objectContaining({ write: true, seeLinks: true, shareReceipts: true }));
    expect(payeeLinkControl).toEqual([
      expect.objectContaining({
        orgSlug: "northstar",
        counterparty: { id: ID, name: CONFIRMED.name },
        chainLabel: "Arc testnet",
        activeLink: { id: LINK.id, expiresAt: LINK.expires_at },
        offers: { invoice: true, chains: ["Arc testnet", "Base Sepolia"] },
        waitingInvoice: null,
      }),
    ]);
    const words = text(markup);
    expect(words).toContain("Out · expires Nov 15, 2026");
    expect(words).toContain("Made by alice@northstar.test");
    expect(words).toContain("The latest 5 links; every one is in History and the Audit log.");
    expect(words).not.toContain("An owner or admin sends and stops payee links.");
    // CL5: a confirmed address can be copied; CL9: the receipt control is the writer's, in a live workspace.
    expect(words).toContain("Copy address");
    expect(words).toContain("New link");
  });

  it("CL4: the payee link control stays mounted for a writer when its links could not be read", async () => {
    ACCESS.membership.role = "owner";
    showing(CONFIRMED, { payeeLinks: { read: false } });
    const words = text(await page());
    expect(payeeLinkControl).toHaveLength(1);
    expect(payeeLinkControl[0]).toEqual(expect.objectContaining({ activeLink: null }));
    expect(words).toContain(PART_NOT_READ);
    expect(words).toContain("Payee link Not read");
  });

  it("CL3: an accountant co-signing confirms an address, from the page's one read of the setting", async () => {
    ACCESS.membership.role = "accountant";
    cosignsMock.mockResolvedValue(true);
    showing(CONTRACTOR);
    const words = text(await page());
    expect(cosignsMock).toHaveBeenCalledTimes(1);
    expect(readPageMock.mock.calls[0][1].grants).toEqual(expect.objectContaining({ confirmAddress: true, write: false, decide: false }));
    // The page offers it to them, though they decide no payment and edit nothing (co-sign CS6).
    expect(words).toContain("Confirm address");
    expect(words).not.toContain("Edit address");
  });

  it("CL3: an accountant not co-signing confirms no address", async () => {
    ACCESS.membership.role = "accountant";
    cosignsMock.mockResolvedValue(false);
    showing(CONTRACTOR);
    const words = text(await page());
    expect(readPageMock.mock.calls[0][1].grants).toEqual(expect.objectContaining({ confirmAddress: false }));
    expect(words).not.toContain("Confirm address");
  });

  it("CL9: offers no way to share a receipt while whether it is shared was not read", async () => {
    ACCESS.membership.role = "owner";
    showing(CONFIRMED, { receipts: { read: false } });
    const words = text(await page());
    expect(words).toContain("Receipt: not read");
    // Share receipt would renew a shared receipt's link, and stop the one its payee holds.
    expect(words).toContain(RECEIPT_STATE_NOT_READ);
    for (const control of ["Share receipt", "New link", "Stop sharing"]) expect(words, control).not.toContain(control);
  });

  it("CL5: no Copy and no confirming while the address's checks are unread", async () => {
    ACCESS.membership.role = "owner";
    showing(CONTRACTOR, { address: { read: false } });
    const words = text(await page());
    expect(words).not.toContain("Copy address");
    expect(words).toContain("Copy is off until the checks on this address are read.");
    expect(words).not.toContain("Confirm address");
  });

  it("CL5, CL12: a lookalike turns Copy off, its name shown only as far as it is visible", async () => {
    ACCESS.membership.role = "owner";
    showing(CONFIRMED, { address: { read: true, value: { lookalikes: [{ kind: "alike", id: "other", name: "Lin\u{202E}h Studio" }], earlierLookalike: null, frozen: false } } });
    const markup = await page();
    expect(text(markup)).not.toContain("Copy address");
    expect(markup).toContain("Copy is off: this address looks like <bdi>Linh Studio</bdi>&#x27;s. Check every character on the explorer.");
    expect(markup).not.toContain("\u{202E}");
  });

  it("CL9: a payment to an earlier address says so, with that address on the explorer", async () => {
    const earlier = `0x${"12".repeat(20)}`;
    showing(CONFIRMED, {
      payments: {
        read: true,
        value: { payments: new Map([[PAID_BILL.id, { source_type: "invoice", source_id: PAID_BILL.id, status: "confirmed", destination_chain: null } as never]]), destinations: new Map([[PAID_BILL.id, earlier]]) },
      },
    });
    const markup = await page();
    expect(text(markup)).toContain("Receipt shared · Paid to an earlier address 0x1212…1212");
    expect(markup).toContain(`href="${addressOnChainUrl(chainOn("arc-testnet", null), earlier)}"`);
  });
});

describe("a client's page (CL1, CL8, CL9)", () => {
  it("CL1: has no payee link, milestones or documents, and names its invoices and payments for a client", async () => {
    ACCESS.membership.role = "owner";
    showing(CLIENT);
    const markup = await page();
    for (const section of ["payee-link", "milestones", "documents", "purchase-orders"]) expect(markup).not.toContain(`id="${section}"`);
    for (const section of ["profile", "address", "bills", "payments", "history"]) expect(markup.split(`id="${section}"`).length - 1, section).toBe(1);
    const words = text(markup);
    expect(words).toContain("Client. Everything Vestiarion holds about them, in one place.");
    expect(words).toContain("Invoices to them");
    expect(words).toContain("Payments from them");
    expect(words).toContain("Owed by them");
    expect(words).not.toContain("Receipt");
    expect(payeeLinkControl).toHaveLength(0);
  });

  it("lists the refunds owed to a client under its invoices, each to pay in Approvals, and none where there are none", async () => {
    const receivable = invoice({ direction: "receivable", counterparty_name: CLIENT.name });
    const refund = invoice({ id: "00000000-0000-4000-8000-000000000031", counterparty_name: CLIENT.name, memo: "Refund for a cancelled order", status: "held" });
    const refunded = invoice({ id: "00000000-0000-4000-8000-000000000032", counterparty_name: CLIENT.name, memo: "Refund for a late delivery", status: "paid", tx_ref: TX, paid_amount: 120 });
    showing(CLIENT, { invoices: { read: true, value: [receivable, refund, refunded] } });
    const markup = await page();
    const words = text(markup);
    expect(words).toContain("The agent never pays a client: each refund waits for a person, who pays it in Approvals.");
    expect(words).toMatch(/Refunds to them 1 .*Refund for a cancelled order.* Refunded 1 .*Refund for a late delivery/);
    expect(markup).toContain(refund.id);
    expect(words).toContain("Needs you 1 refund to them to pay in Approvals");
    // A refund is money out: it is not what the client owes, nor a payment from them.
    expect(words).toContain("Owed by them 120.00 USDC Paid by them 0.00 USDC");
    expect(words).toContain("Payments from them 0 payments · 0.00 USDC No payments yet.");
    showing(CLIENT);
    expect(text(await page())).not.toContain("Refunds to them");
  });
});

describe("the address's explorer link (CL5)", () => {
  it("links only an address of 0x and 40 hex digits", async () => {
    showing({ ...CONFIRMED, address: "0xNOTHEX0000000000000000000000000000000000" });
    const markup = await page();
    expect(markup).not.toContain("/address/");
    expect(text(markup)).not.toContain("Open on the explorer");
  });

  it("says why there is none for a chain the workspace does not pay on", async () => {
    showing({ ...CONFIRMED, chain: "BASE" });
    const markup = await page();
    expect(markup).not.toContain("/address/");
    expect(text(markup)).toContain(NO_EXPLORER);
  });
});

describe("the page's parts (CL1, CL4, CL13)", () => {
  it("CL1: gives a payee's page each part's id exactly once, in order", async () => {
    ACCESS.membership.role = "owner";
    showing(CONFIRMED);
    const markup = await page();
    const at = COUNTERPARTY_SECTIONS.map((section) => {
      expect(markup.split(`id="${section}"`).length - 1, section).toBe(1);
      return markup.indexOf(`id="${section}"`);
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("CL4: never carries a payee link's or a receipt's secret", async () => {
    ACCESS.membership.role = "owner";
    showing(CONFIRMED);
    const markup = await page();
    expect(markup).not.toMatch(/vxp_|vxr_/);
  });

  it("CL13: a part that could not be read says so, and its tile says Not read", async () => {
    showing(CONFIRMED, { invoices: { read: false }, history: { read: false } });
    const words = text(await page());
    expect(words).toContain(`Bills from them ${PART_NOT_READ}`);
    expect(words).toContain(`Payments ${PART_NOT_READ}`);
    expect(words).toContain("Owed to them Not read");
    expect(words).toContain("Paid to them Not read");
    // The rest of the page stands.
    expect(words).toContain("Five October posts");
  });

  it("CL13: a record whose history may be cut says so", async () => {
    showing(CONFIRMED, { entries: { read: true, value: { entries: [], cut: new Set([MILESTONE.id]) } } });
    expect(text(await page())).toContain("Some of this record's history was not read; the Audit log has all of it.");
  });

  it("CL9: shows the latest 10 payments, and every one when asked", async () => {
    const paid = Array.from({ length: 12 }, (_, n) => invoice({ id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, status: "paid", tx_ref: TX, due_date: `2026-10-${String(n + 1).padStart(2, "0")}` }));
    showing(CONFIRMED, { invoices: { read: true, value: paid }, milestones: { read: true, value: [] } });
    const latest = await page();
    expect(text(latest)).toContain("Show every payment");
    expect(latest).toContain(`href="/o/northstar/counterparties/${ID}?history=all#payments"`);
    expect(text(latest)).toContain("12 payments · 1,440.00 USDC");
    const every = await page(ID, "all");
    expect(readPageMock.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ history: true }));
    expect(text(every)).toContain("Show the latest 10");
    expect(every).toContain(`href="/o/northstar/counterparties/${ID}#payments"`);
  });

  it("CL12, CL16: names the counterparty in the heading and the breadcrumb by what is visible of it", async () => {
    showing({ ...CONFIRMED, name: "Linh\u{200B} Tran\u{202E}" });
    const markup = await page();
    expect(markup).toMatch(/<h1[^>]*><bdi>Linh Tran<\/bdi><\/h1>/);
    expect(shell.crumb).toBe("Linh Tran");
  });

  it("CL12: names a frozen payee in its callout, and to the payee link control, by what is visible of the name", async () => {
    ACCESS.membership.role = "owner";
    showing({ ...CONFIRMED, name: `Acme${at(0x202e)} Ltd${at(0x200b)}`, frozen_at: "2026-11-08T12:00:00Z" }, { addressCheck: { frozen: true, check: null } });
    const markup = await page();
    expect(text(markup)).toContain("Acme Ltd is frozen");
    expect(payeeLinkControl[0]).toEqual(expect.objectContaining({ counterparty: { id: ID, name: "Acme Ltd" } }));
    for (const code of [0x202e, 0x200b]) expect(markup, code.toString(16)).not.toContain(at(code));
  });

  it("CL10, CL12: shows the note and purchase order number a vendor typed only as far as they show, the note's lines kept", async () => {
    const answered = {
      state: "answered" as const,
      id: "req-1",
      missing: ["purchase_order" as const],
      answeredAt: "2026-11-08T10:00:00Z",
      note: `PO 1234${at(0x202e)} fdp.exe${at(0x200b)}\n${at(0x2066)}Second line`,
      poReference: `PO-${at(0x2069)}77`,
      fileType: "application/pdf",
    };
    showing(CONFIRMED, { documents: { read: true, value: new Map([[OPEN_BILL.id, answered]]) } });
    const markup = await page();
    expect(markup).toContain("PO 1234 fdp.exe\nSecond line");
    expect(markup).toContain(">PO-77<");
    for (const code of [0x202e, 0x200b, 0x2066, 0x2069]) expect(markup, code.toString(16)).not.toContain(at(code));
  });

  it("CL10: lists every invoice sent for review under one heading, from the browser extension or a payee link", async () => {
    showing(CONFIRMED, { drafts: { read: true, value: [{ id: "d1", source: "payee_link", invoice_number: "INV-9", amount: "40", currency: "USDC", sent_at: "2026-11-07T08:00:00Z" }] } });
    const markup = await page();
    expect(text(markup)).toContain("Invoices sent for review INV-9 · 40.00 USDC Sent through their payee link · sent Nov 7, 2026");
    expect(markup).toContain('aria-label="Invoices sent for review"');
    expect(text(markup)).not.toContain("Sent from the browser extension");
  });
});

describe("Needs you and Waiting on them", () => {
  it("says what waits on whom under the tiles, each line a link to its part, before Profile", async () => {
    ACCESS.membership.role = "owner";
    showing(CONTRACTOR);
    const markup = await page();
    const words = text(markup);
    expect(words).toContain("Needs you Their payment address changed: confirm it before they are paid");
    expect(words).toContain("Waiting on them Their answer to the payee link · expires Nov 15, 2026 1 milestone still to deliver");
    expect(markup).toContain('href="#address"');
    expect(markup).toContain('href="#payee-link"');
    expect(markup.indexOf("Needs you")).toBeLessThan(markup.indexOf('id="profile"'));
  });

  it("says nothing waits when nothing does, and that a part was not read rather than none", async () => {
    showing(CONFIRMED, { milestones: { read: true, value: [] }, invoices: { read: true, value: [PAID_BILL] } });
    expect(text(await page())).toContain("Needs you Nothing waits on your side. Waiting on them Nothing waits on them.");
    showing(CONFIRMED, { invoices: { read: false } });
    expect(text(await page())).toContain("Needs you Some parts were not read just now. Reload the page in a moment.");
  });
});

describe("milestone dates (CL9)", () => {
  const PAID: MilestoneRow = { ...MILESTONE, id: "00000000-0000-4000-9000-000000000002", title: "Four September posts", status: "paid", verified: true, tx_ref: TX };
  const HELD: MilestoneRow = { ...MILESTONE, id: "00000000-0000-4000-9000-000000000003", title: "Launch video", status: "held", verified: true };
  const intent = (over: Record<string, unknown>) => ({ source_type: "milestone", source_id: PAID.id, status: "confirmed", destination_chain: null, executed_at: null, confirmed_at: null, ...over }) as never;
  const paymentsPart = (markup: string) => markup.slice(markup.indexOf('id="payments"'), markup.indexOf('id="documents"'));

  it("CL9: dates and orders a paid milestone by its payment's confirmation, with its entries unread", async () => {
    showing(CONFIRMED, {
      milestones: { read: true, value: [PAID] },
      entries: { read: false },
      payments: { read: true, value: { payments: new Map([[PAID.id, intent({ executed_at: "2026-10-05T09:58:00Z", confirmed_at: "2026-10-05T10:00:00Z" })]]), destinations: new Map() } },
    });
    const payments = paymentsPart(await page());
    expect(payments).toContain(">Paid Oct 5, 2026<");
    expect(payments).not.toContain("Paid Nov 9, 2026");
    // The bill due Oct 20 is newer, so it comes first.
    expect(payments.indexOf("September retainer")).toBeLessThan(payments.indexOf("Four September posts"));
  });

  it("CL9: falls back to when it was sent, then to its entry", async () => {
    showing(CONFIRMED, {
      milestones: { read: true, value: [PAID] },
      payments: { read: true, value: { payments: new Map([[PAID.id, intent({ status: "submitted", executed_at: "2026-10-06T09:00:00Z" })]]), destinations: new Map() } },
    });
    expect(paymentsPart(await page())).toContain(">Paid Oct 6, 2026<");
    showing(CONFIRMED, {
      milestones: { read: true, value: [PAID] },
      entries: { read: true, value: { entries: [{ seq: 7, ts: "2026-10-07T09:00:00Z", actor: "agent", domain: "contractor", action: "release_milestone", summary: "Paid", detail: { milestoneId: PAID.id } } as never], cut: new Set() } },
    });
    expect(paymentsPart(await page())).toContain(">Paid Oct 7, 2026<");
  });

  it("CL9: with neither its payment nor its entries read, names no day and comes last, never today", async () => {
    showing(CONFIRMED, { milestones: { read: true, value: [PAID, HELD] }, entries: { read: false } });
    const markup = await page();
    const payments = paymentsPart(markup);
    expect(payments).toContain(">Paid<");
    expect(payments.indexOf("September retainer")).toBeLessThan(payments.indexOf("Four September posts"));
    // A held milestone under Milestones names no day either.
    expect(markup).not.toMatch(/(?:Paid|Held) Nov 9, 2026/);
  });
});

describe("the page's source", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "counterparties", "[id]", "page.tsx"), "utf8");

  it("CL13: has no maxDuration of its own: asking every payee stays on the list", () => {
    expect(source).not.toContain("maxDuration");
  });

  it("CL3: asks viewerCan nothing", () => {
    expect(source).not.toContain("viewerCan");
  });
});
