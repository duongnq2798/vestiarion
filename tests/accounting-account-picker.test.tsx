import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountingAccountsResult } from "@/app/actions/accounting";
import type { ExternalAccount } from "@/lib/connectors/provider";

vi.mock("@/app/actions/accounting", () => ({
  syncAccountingNowAction: vi.fn(),
  disconnectAccountingAction: vi.fn(),
  loadAccountingAccountsAction: vi.fn(),
  chooseAccountingAccountAction: vi.fn(),
  addAccountingBillsAction: vi.fn(),
  dismissAccountingBillsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/** The accounts the tool answered with, put in place of the forms' initial state when a test sets them. */
const loaded = vi.hoisted(() => ({ state: null as AccountingAccountsResult | null }));
vi.mock("@/components/ui/useActionForm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/useActionForm")>();
  return {
    ...actual,
    useActionForm: ((...args: Parameters<typeof actual.useActionForm>) => {
      const real = actual.useActionForm(...args);
      return loaded.state ? { ...real, state: loaded.state } : real;
    }) as typeof actual.useActionForm,
  };
});

import { AccountingAccountPicker } from "@/components/AccountingAccountPicker";
import { accountsToOffer } from "@/lib/connectors/booking";

/**
 * Where payments made on Arc will be booked (docs/superpowers/specs/2026-10-12-xero-connector-design.md X14, I14): the
 * bank accounts first and alone by default; the other accounts the tool lets take payments only behind a toggle with
 * a caution, since a supplier payment booked from an owner's equity or drawings account is almost always wrong.
 */

const account = (code: string, name: string, bank: boolean, type = bank ? "BANK" : "EQUITY"): ExternalAccount => ({
  externalId: `acc-${code}`,
  code,
  name,
  type,
  currency: null,
  bank,
});

// What Xero's Demo Company (Global) offered live, in Xero's order.
const DEMO_CHART: ExternalAccount[] = [
  account("090", "Business Bank Account", true),
  account("091", "Business Savings Account", true),
  account("855", "Clearing Account", false, "CURRLIAB"),
  account("880", "Owner A Drawings", false),
  account("881", "Owner A Funds Introduced", false),
  account("970", "Owner A Share Capital", false),
];

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const render = (provider: "xero" | "quickbooks", accounts: ExternalAccount[]) => {
  loaded.state = { ok: true, message: "", accounts };
  return renderToStaticMarkup(<AccountingAccountPicker provider={provider} orgSlug="acme" current={null} sample={null} />);
};

afterEach(() => {
  loaded.state = null;
});

describe("accountsToOffer", () => {
  it("offers the bank accounts alone by default, and counts the others it keeps back", () => {
    const offer = accountsToOffer(DEMO_CHART, false);
    expect(offer.offered.map((candidate) => candidate.code)).toEqual(["090", "091"]);
    expect(offer.others).toBe(4);
  });

  it("adds the other accounts that take payments after the bank accounts when asked for", () => {
    const shuffled = [DEMO_CHART[3], DEMO_CHART[0], DEMO_CHART[2], DEMO_CHART[1]];
    expect(accountsToOffer(shuffled, true).offered.map((candidate) => candidate.code)).toEqual(["090", "091", "880", "855"]);
  });
});

describe("AccountingAccountPicker", () => {
  it("lists Xero's bank accounts, and keeps equity, drawings and clearing accounts behind a toggle", () => {
    const markup = render("xero", DEMO_CHART);
    const words = text(markup);
    expect(words).toContain("Book payments made on Arc to");
    expect(words).toContain("Business Bank Account (090)");
    expect(words).toContain("Business Savings Account (091)");
    for (const hidden of ["Clearing Account (855)", "Owner A Drawings (880)", "Owner A Funds Introduced (881)", "Owner A Share Capital (970)"]) {
      expect(words).not.toContain(hidden);
    }
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[^]*?Show other accounts that take payments/);
    // The caution goes with the other accounts, so it is not there while they are hidden.
    expect(words).not.toContain("almost always wrong");
  });

  it("offers no toggle when every account is a bank account, as QuickBooks' are", () => {
    const markup = render("quickbooks", [account("1090", "Arc USDC wallet", true, "Bank"), account("1000", "Checking", true, "Bank")]);
    expect(text(markup)).toContain("Arc USDC wallet (1090)");
    expect(text(markup)).not.toContain("Show other accounts");
  });

  it("says so when the tool has no bank account, and still offers the others behind the toggle", () => {
    const markup = render("xero", DEMO_CHART.slice(2));
    const words = text(markup);
    expect(words).toContain("Xero has no active bank account to book payments to.");
    expect(words).not.toContain("Owner A Drawings (880)");
    expect(words).toContain("Show other accounts that take payments");
  });
});
