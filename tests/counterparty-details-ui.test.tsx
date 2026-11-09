import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

import { CounterpartyDetails, CounterpartyProfile, type DetailGrants } from "@/components/CounterpartyDetails";
import { CounterpartyRow as CounterpartyRowView } from "@/components/CounterpartyRow";
import { CounterpartyHistory } from "@/components/counterparty/CounterpartyHistory";
import { PayeeLinkHistory } from "@/components/counterparty/PayeeLinkHistory";
import { SentDrafts } from "@/components/counterparty/SentDrafts";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { UntrustedText } from "@/components/vx/UntrustedText";
import { orgHref } from "@/lib/auth/org-paths";
import { payeeLinkStates } from "@/lib/counterparties/page-view";
import { counterpartyPath } from "@/lib/counterparty-paths";
import type { CounterpartyEntry } from "@/lib/ledger";
import type { CounterpartyRow } from "@/lib/queries";

/**
 * The parts a counterparty's page shares with the Counterparties list, and the ones only the page draws
 * (docs/superpowers/specs/2026-11-09-counterparty-page-design.md): the address in full with its explorer link and Copy
 * address (CL5), the row's link to the page (CL1), the row's details for each grant, the payee link history (CL6), History
 * (CL11), the drafts sent for review (CL10) and text from outside (CL12).
 */

const render = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const ID = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
const ADDRESS = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
const EXPLORER = `https://testnet.arcscan.app/address/${ADDRESS}`;

const VENDOR: CounterpartyRow = {
  id: ID,
  name: "Centronex",
  role: "vendor",
  address: ADDRESS,
  chain: null,
  jurisdiction: "US",
  risk_level: "clear",
  risk_notes: null,
  payment_limit: 50,
  baseline_payment_limit: 50,
  last_screened_at: null,
  performance_score: null,
  performance_inputs: null,
  address_changed_at: null,
  address_confirmed_at: null,
  sample: false,
  notice_email: "billing@centronex.example",
  purchase_order_required: true,
  mirror_wallet_id: null,
  frozen_at: null,
};

const OWNER: DetailGrants = { write: true, decide: true, confirmAddress: true, reconcile: true, manageBank: false };
const VIEWER: DetailGrants = { write: false, decide: false, confirmAddress: false, reconcile: false, manageBank: false };
const FOUND = { payeeLockOn: false, lookalikes: [], earlierLookalike: null, check: null };
const LINK = { active: null, waiting: null, chains: [] };

function details(props: Partial<Parameters<typeof CounterpartyDetails>[0]> = {}) {
  return render(
    <CounterpartyDetails
      orgSlug="acme"
      network="arc-testnet"
      counterparty={VENDOR}
      grants={OWNER}
      liveScreening={false}
      found={FOUND}
      shadow={false}
      bank={null}
      payeeLink={LINK}
      {...props}
    />
  );
}

function address(props: Partial<Parameters<typeof CounterpartyAddress>[0]> = {}) {
  return render(<CounterpartyAddress orgSlug="acme" counterparty={{ id: ID, name: "Centronex", address: ADDRESS, chain: "ARC-TESTNET" }} unconfirmedSince={null} canWrite={false} canConfirm={false} {...props} />);
}

describe("the payment address on a counterparty's page", () => {
  it("CL5: shows every character of the address, wrapping, with its explorer link opening in a new tab", () => {
    const markup = address({ full: true, explorerHref: EXPLORER });
    expect(markup).toMatch(new RegExp(`<span class="break-all[^"]*">${ADDRESS}</span>`));
    expect(markup).not.toContain("truncate");
    expect(markup).toMatch(new RegExp(`<a[^>]*href="${EXPLORER}"[^>]*target="_blank"[^>]*rel="noreferrer"|<a[^>]*target="_blank"[^>]*rel="noreferrer"[^>]*href="${EXPLORER}"`));
    expect(text(markup)).toContain("Open on the explorer (opens in a new tab)");
  });

  it("CL5: offers Copy address only for an address it may copy, and otherwise says why in one line", () => {
    expect(text(address({ full: true, copyable: true }))).toContain("Copy address");
    const off = address({ full: true, copyable: false, copyNote: "Copy comes back once someone confirms this address." });
    expect(text(off)).toContain("Copy comes back once someone confirms this address.");
    expect(text(off)).not.toContain("Copy address");
  });

  it("CL5: offers neither for a counterparty with no address", () => {
    const markup = render(
      <CounterpartyAddress orgSlug="acme" counterparty={{ id: ID, name: "Centronex", address: null }} unconfirmedSince={null} canWrite={false} canConfirm={false} full explorerHref={EXPLORER} copyable copyNote="Copy is off" />
    );
    expect(text(markup)).toContain("No payment address");
    expect(markup).not.toContain(EXPLORER);
    expect(text(markup)).not.toContain("Copy");
  });

  it("is drawn as the list draws it without them: one line, no explorer link, no Copy", () => {
    const markup = address();
    expect(markup).toContain(`title="${ADDRESS}"`);
    expect(markup).toContain("truncate");
    expect(text(markup)).not.toContain("Open on the explorer");
    expect(text(markup)).not.toContain("Copy address");
  });
});

describe("a row of the Counterparties list", () => {
  const row = (pageHref?: string) => render(<CounterpartyRowView counterparty={VENDOR} network="arc-testnet" pageHref={pageHref}><p>Inside</p></CounterpartyRowView>);

  it("CL1: opens with Open their page, at the top of the opened row, and keeps the id old links open it at", () => {
    const markup = row(orgHref("acme", counterpartyPath(ID)));
    expect(markup).toContain(`id="counterparty-${ID}"`);
    const opened = markup.slice(markup.indexOf("</summary>"));
    expect(opened).toMatch(new RegExp(`<a[^>]*href="/o/acme/counterparties/${ID}"[^>]*>Open their page`));
    expect(opened).toContain('aria-label="Open Centronex&#x27;s page"');
    expect(opened.indexOf("Open their page")).toBeLessThan(opened.indexOf("Inside"));
  });

  it("has no such link where none is given", () => {
    expect(row()).not.toContain("Open their page");
  });
});

describe("a counterparty's details", () => {
  it("give an owner or admin every control, the payee link's among them", () => {
    const shown = text(details());
    for (const words of ["Configured limit", "Edit limit", "Allowed now", "Billing email", "Purchase orders", "Edit address", "Check their statement", "Ask for address"]) {
      expect(shown).toContain(words);
    }
  });

  it("CL3: give a viewer what is held and no control, and no payee link", () => {
    const shown = text(details({ grants: VIEWER, payeeLink: null }));
    expect(shown).toContain("Configured limit");
    expect(shown).toContain(ADDRESS);
    for (const words of ["Edit limit", "Edit address", "Check their statement", "Ask for address"]) expect(shown).not.toContain(words);
  });

  it("CL1: give a client no purchase orders and no payee link", () => {
    const shown = text(details({ counterparty: { ...VENDOR, role: "client", address: null } }));
    expect(shown).toContain("Billing email");
    expect(shown).not.toContain("Purchase orders");
    expect(shown).not.toContain("Ask for address");
  });

  it("put the mirror address beside the address it stands in for, before the statement check and the payee link", () => {
    const shown = text(details({ counterparty: { ...VENDOR, address: null }, shadow: true }));
    const order = ["No payment address", "Give it a mirror address", "Check their statement", "Ask for address"].map((words) => shown.indexOf(words));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("give the list's rows no section ids, since it holds many", () => {
    expect(details()).not.toMatch(/id="(screening|limit|billing-email|purchase-orders)"/);
  });
});

describe("the profile on a counterparty's page", () => {
  const profile = (counterparty: CounterpartyRow) =>
    render(<CounterpartyProfile orgSlug="acme" network="arc-testnet" counterparty={counterparty} grants={OWNER} liveScreening={false} anchored />);

  it("CL1, CL15: carries each line's id once, which a fix-it link opens at", () => {
    const markup = profile(VENDOR);
    for (const id of ["screening", "limit", "billing-email", "purchase-orders"]) expect(markup.split(`id="${id}"`).length - 1).toBe(1);
  });

  it("CL1: has no purchase orders line for a client", () => {
    expect(profile({ ...VENDOR, role: "client" })).not.toContain('id="purchase-orders"');
  });
});

describe("UntrustedText", () => {
  it("CL12: shows only what is visible, cut at its length, set apart in bdi", () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    expect(renderToStaticMarkup(<UntrustedText text={`Acme${rlo} Ltd${zwsp}`} max={80} />)).toBe("<bdi>Acme Ltd</bdi>");
    expect(renderToStaticMarkup(<UntrustedText text="Northwind Traders" max={6} />)).toBe("<bdi>North…</bdi>");
  });

  it("CL12: shows nothing for text with nothing visible, or what stands in for it", () => {
    const blank = String.fromCodePoint(0x2800);
    expect(renderToStaticMarkup(<UntrustedText text={blank} />)).toBe("");
    expect(renderToStaticMarkup(<UntrustedText text={null} empty="No name" />)).toBe("<bdi>No name</bdi>");
  });
});

describe("PayeeLinkHistory", () => {
  const NOW = Date.parse("2026-11-09T12:00:00Z");
  const lines = payeeLinkStates(
    [
      { id: "l2", created_at: "2026-11-08T10:00:00.123456+00:00", expires_at: "2026-11-15T10:00:00Z", used_at: null, revoked_at: null, created_by: "u1" },
      { id: "l1", created_at: "2026-11-02T10:00:00Z", expires_at: "2026-11-09T10:00:00Z", used_at: null, revoked_at: "2026-11-08T10:00:00.123456Z", created_by: "gone" },
    ],
    { now: NOW, members: [{ userId: "u1", email: "owner@acme.example" }] }
  );

  it("CL6: lists each link's state and who made it, with what the list leaves out", () => {
    const shown = text(renderToStaticMarkup(<PayeeLinkHistory lines={lines} />));
    expect(shown).toContain("Out · expires Nov 15, 2026");
    expect(shown).toContain("Made by owner@acme.example");
    expect(shown).toContain("Replaced by a newer link · Nov 8, 2026");
    expect(shown).toContain("Made by a former member");
    expect(shown).toContain("The latest 5 links; every one is in History and the Audit log.");
    expect(shown).toContain("A used link's status page stays open to the payee for 30 days.");
  });

  it("CL4: never shows a link's address, which is shown once when it is made", () => {
    expect(renderToStaticMarkup(<PayeeLinkHistory lines={lines} />)).not.toMatch(/vxp_|href=/);
  });

  it("shows nothing for a payee who was never sent one", () => {
    expect(renderToStaticMarkup(<PayeeLinkHistory lines={[]} />)).toBe("");
  });
});

describe("CounterpartyHistory", () => {
  const entries: CounterpartyEntry[] = [
    { seq: 42, ts: "2026-11-08T09:15:00Z", actor: "human", action: "counterparty_limit_changed", summary: "Changed Centronex's payment limit to 50 USDC" },
    { seq: 7, ts: "2026-11-01T10:00:00Z", actor: "system", action: "counterparty_added", summary: "Added Centronex" },
  ];

  it("CL11: is folded, holds the page's one history id, and links each line to its entry in the Audit log", () => {
    const markup = renderToStaticMarkup(<CounterpartyHistory orgSlug="acme" entries={entries} />);
    expect(markup).toMatch(/<details id="history"(?![^>]*\sopen)/);
    expect(markup.split('id="history"').length - 1).toBe(1);
    expect(markup).toContain('href="/o/acme/audit?before=43#seq-42"');
    expect(markup).toContain('href="/o/acme/audit?before=8#seq-7"');
    expect(markup).toMatch(/<a[^>]*href="\/o\/acme\/audit\?domain=compliance"[^>]*>All of it in the Audit log<\/a>/);
    expect(markup).toContain("<bdi>Changed Centronex&#x27;s payment limit to 50 USDC</bdi>");
    expect(text(markup)).toContain("Nov 8, 2026, 09:15 UTC · human");
  });

  it("CL1, CL13: says when there is nothing yet, and when it could not be read", () => {
    expect(text(renderToStaticMarkup(<CounterpartyHistory orgSlug="acme" entries={[]} />))).toContain("No changes recorded yet.");
    expect(text(renderToStaticMarkup(<CounterpartyHistory orgSlug="acme" entries={null} />))).toContain("Not read just now. Reload the page in a moment.");
  });
});

describe("SentDrafts", () => {
  const drafts = [
    { id: "d1", source: "file" as const, invoice_number: `INV-${String.fromCodePoint(0x202e)}204`, amount: "120.5", currency: "USDC", sent_at: "2026-11-07T08:00:00Z" },
    { id: "d2", source: "payee_link" as const, invoice_number: null, amount: null, currency: null, sent_at: null },
  ];

  it("CL10: lists the drafts sent for review, each opening the captured drafts on Bills & receivables", () => {
    const markup = renderToStaticMarkup(<SentDrafts orgSlug="acme" drafts={drafts} />);
    // Named for both ways a draft comes: the browser extension, and a payee's own link.
    expect(markup).toContain('aria-label="Invoices sent for review"');
    expect(markup).not.toContain("Sent from the browser extension");
    expect(markup.split('href="/o/acme/invoices?review=captured"').length - 1).toBe(2);
    expect(markup).toContain("<bdi>INV-204</bdi>");
    const shown = text(markup);
    expect(shown).toContain("120.50 USDC");
    expect(shown).toContain("A file, with the browser extension · sent Nov 7, 2026");
    expect(shown).toContain("No invoice number read");
    expect(shown).toContain("Sent through their payee link");
    expect(shown).toContain("Open in Bills & receivables");
  });

  it("shows nothing when there are none", () => {
    expect(renderToStaticMarkup(<SentDrafts orgSlug="acme" drafts={[]} />)).toBe("");
  });
});
