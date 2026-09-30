import { describe, expect, it } from "vitest";
import { gettingStarted, ownInvoiceCount, type GettingStartedInput } from "@/lib/getting-started";

/**
 * The console's Get started checklist, computed from rows the console
 * already reads (getting-started design §1, G1, G2): no stored state, so it
 * ticks itself off and disappears once the workspace is live.
 */

const ADDRESS = "0x1948aB0000000000000000000000000000c345a0";

function input(overrides: Partial<GettingStartedInput> = {}): GettingStartedInput {
  return {
    mode: "sandbox",
    accounts: [
      { kind: "operating", circle_wallet_id: null, balance: 0 },
      { kind: "reserve", circle_wallet_id: null, balance: 0 },
    ],
    counterparties: [],
    invoiceCount: 0,
    ...overrides,
  };
}

const done = (result: ReturnType<typeof gettingStarted>) => Object.fromEntries(result.steps.map((step) => [step.id, step.done]));

describe("gettingStarted", () => {
  it("lists the five steps in order, none done, the wallet next, for a new workspace", () => {
    const result = gettingStarted(input());
    expect(result.show).toBe(true);
    expect(result.steps.map((step) => step.title)).toEqual([
      "Add a wallet",
      "Fund it with USDC",
      "Add a counterparty with an Arc address",
      "Add an invoice",
      "Go live",
    ]);
    expect(Object.values(done(result))).toEqual([false, false, false, false, false]);
    expect(result.next).toBe("wallet");
  });

  it("ticks the wallet once the operating account has a Circle wallet, and moves on to funding", () => {
    const result = gettingStarted(input({ accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 0 }] }));
    expect(done(result).wallet).toBe(true);
    expect(done(result).fund).toBe(false);
    expect(result.next).toBe("fund");
  });

  it("never counts a reserve wallet as the wallet", () => {
    const result = gettingStarted(input({ accounts: [{ kind: "reserve", circle_wallet_id: "w-2", balance: 5 }] }));
    expect(done(result).wallet).toBe(false);
  });

  it("asks to check the balance in Settings while the stored balance of a new wallet is 0", () => {
    const fund = gettingStarted(input({ accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 0 }] })).steps[1];
    expect(fund.body).toContain("Check the balance in Settings");
  });

  it("ticks funding when the operating wallet holds USDC", () => {
    const result = gettingStarted(input({ accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 40 }] }));
    expect(done(result).fund).toBe(true);
  });

  it("does not tick funding for a balance with no wallet: a sandbox's sample balance is not USDC on Arc", () => {
    const result = gettingStarted(input({ accounts: [{ kind: "operating", circle_wallet_id: null, balance: 1000 }] }));
    expect(done(result).fund).toBe(false);
  });

  it("ticks the counterparty step only for one with an address", () => {
    expect(done(gettingStarted(input({ counterparties: [{ address: null }] }))).counterparty).toBe(false);
    expect(done(gettingStarted(input({ counterparties: [{ address: "" }] }))).counterparty).toBe(false);
    expect(done(gettingStarted(input({ counterparties: [{ address: null }, { address: ADDRESS }] }))).counterparty).toBe(true);
  });

  it("ticks the invoice step once any invoice exists", () => {
    expect(done(gettingStarted(input({ invoiceCount: 1 }))).invoice).toBe(true);
  });

  it("points at the first step not done, even when a later one is", () => {
    const result = gettingStarted(input({ counterparties: [{ address: ADDRESS }], invoiceCount: 2 }));
    expect(result.next).toBe("wallet");
  });

  it("points at Go live when everything before it is done", () => {
    const result = gettingStarted(
      input({ accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 40 }], counterparties: [{ address: ADDRESS }], invoiceCount: 1 })
    );
    expect(result.next).toBe("live");
    expect(result.show).toBe(true);
  });

  it("hides once the workspace is live", () => {
    const result = gettingStarted(input({ mode: "live" }));
    expect(result.show).toBe(false);
    expect(done(result).live).toBe(true);
    expect(done(result).fund).toBe(true);
  });

  it("links each step to the page where it is done", () => {
    expect(Object.fromEntries(gettingStarted(input()).steps.map((step) => [step.id, step.path]))).toEqual({
      wallet: "/settings#go-live-title",
      fund: "/settings#go-live-title",
      counterparty: "/counterparties",
      invoice: "/invoices",
      live: "/settings#go-live-title",
    });
  });

  it("marks the steps only an owner can take", () => {
    expect(gettingStarted(input()).steps.filter((step) => step.ownerOnly).map((step) => step.id)).toEqual(["wallet", "live"]);
  });
});

describe("sample rows (sample-data design §1)", () => {
  it("does not tick the counterparty step for a sample counterparty, even one given an address", () => {
    expect(done(gettingStarted(input({ counterparties: [{ address: ADDRESS, sample: true }] }))).counterparty).toBe(false);
    expect(done(gettingStarted(input({ counterparties: [{ address: ADDRESS, sample: true }, { address: ADDRESS, sample: false }] }))).counterparty).toBe(true);
  });

  it("counts only the invoices of counterparties a person added", () => {
    const counterparties = [
      { id: "own", sample: false },
      { id: "sample-1", sample: true },
    ];
    expect(ownInvoiceCount([{ counterparty_id: "sample-1" }, { counterparty_id: "sample-1" }], counterparties)).toBe(0);
    expect(ownInvoiceCount([{ counterparty_id: "sample-1" }, { counterparty_id: "own" }], counterparties)).toBe(1);
    // A counterparty the page does not know (deleted meanwhile) is not a sample one.
    expect(ownInvoiceCount([{ counterparty_id: "gone" }], counterparties)).toBe(1);
  });
});
