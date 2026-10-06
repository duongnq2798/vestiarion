import { describe, expect, it } from "vitest";
import { gettingStarted, ownPayableCount, type GettingStartedInput } from "@/lib/getting-started";

/**
 * The console's Get started checklist, computed from rows the console
 * already reads (getting-started design §1, G1, G2; first-payment design §2):
 * no stored state, so it ticks itself off, and it disappears once the
 * workspace has made its first payment on Arc testnet.
 */

const ADDRESS = "0x1948aB0000000000000000000000000000c345a0";
const FUNDED = [{ kind: "operating", circle_wallet_id: "w-1", balance: 40 }];
const PAYEE = { name: "Northstar Studio", role: "vendor", address: ADDRESS };

function input(overrides: Partial<GettingStartedInput> = {}): GettingStartedInput {
  return {
    mode: "sandbox",
    accounts: [
      { kind: "operating", circle_wallet_id: null, balance: 0 },
      { kind: "reserve", circle_wallet_id: null, balance: 0 },
    ],
    counterparties: [],
    payableCount: 0,
    onchainPayments: 0,
    waitingCount: 0,
    network: "arc-testnet",
    ...overrides,
  };
}

const done = (result: ReturnType<typeof gettingStarted>) => Object.fromEntries(result.steps.map((step) => [step.id, step.done]));
const step = (result: ReturnType<typeof gettingStarted>, id: string) => result.steps.find((candidate) => candidate.id === id)!;

describe("gettingStarted", () => {
  it("lists the six steps to a first payment in order, none done, the wallet next, for a new workspace", () => {
    const result = gettingStarted(input());
    expect(result.show).toBe(true);
    expect(result.steps.map((each) => each.title)).toEqual([
      "Add a wallet",
      "Fund it with USDC",
      "Go live",
      "Add a payee with an Arc address",
      "Add a payable",
      "First payment on Arc testnet",
    ]);
    expect(Object.values(done(result))).toEqual([false, false, false, false, false, false]);
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

  it("sends the person to Settings to fund a new wallet, where the balance is read from the chain", () => {
    const fund = step(gettingStarted(input({ accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 0 }] })), "fund");
    expect(fund.body).toContain("faucet");
    expect(fund.body).toContain("Settings");
    expect(fund.path).toBe("/settings#go-live-title");
  });

  it("ticks funding when the operating wallet holds USDC, and moves on to going live", () => {
    const result = gettingStarted(input({ accounts: FUNDED }));
    expect(done(result).fund).toBe(true);
    expect(result.next).toBe("live");
  });

  it("does not tick funding for a balance with no wallet: a sandbox's sample balance is not USDC on Arc", () => {
    const result = gettingStarted(input({ accounts: [{ kind: "operating", circle_wallet_id: null, balance: 1000 }] }));
    expect(done(result).fund).toBe(false);
  });

  it("asks for the payee once the workspace is live and funded", () => {
    const result = gettingStarted(input({ mode: "live", accounts: FUNDED }));
    expect(done(result)).toMatchObject({ wallet: true, fund: true, live: true, payee: false });
    expect(result.next).toBe("payee");
    expect(step(result, "payee").body).toContain("Ask for address");
  });

  it("ticks the payee step only for a vendor or contractor with an address", () => {
    const payee = (counterparties: GettingStartedInput["counterparties"]) => done(gettingStarted(input({ counterparties }))).payee;
    expect(payee([{ ...PAYEE, address: null }])).toBe(false);
    expect(payee([{ ...PAYEE, address: "" }])).toBe(false);
    expect(payee([{ ...PAYEE, role: "client" }])).toBe(false);
    expect(payee([PAYEE])).toBe(true);
    expect(payee([{ ...PAYEE, role: "contractor" }])).toBe(true);
  });

  it("does not tick the payee step for an address still waiting for confirmation, and says whose to confirm", () => {
    const waiting = { ...PAYEE, address_changed_at: "2026-10-01T09:00:00Z", address_confirmed_at: null };
    const result = gettingStarted(input({ mode: "live", accounts: FUNDED, counterparties: [waiting] }));
    expect(done(result).payee).toBe(false);
    expect(step(result, "payee").body).toContain("Confirm the new address of Northstar Studio");

    const confirmed = { ...waiting, address_confirmed_at: "2026-10-01T09:05:00Z" };
    expect(done(gettingStarted(input({ counterparties: [confirmed] }))).payee).toBe(true);
  });

  it("ticks the payable step once a payable exists, and says what the agent needs to pay it", () => {
    const result = gettingStarted(input({ mode: "live", accounts: FUNDED, counterparties: [PAYEE] }));
    expect(result.next).toBe("payable");
    expect(step(result, "payable").body).toContain("PO reference");
    expect(done(gettingStarted(input({ payableCount: 1 }))).payable).toBe(true);
  });

  it("waits for the first payment on AP / AR, or on Approvals while the agent holds something for a person", () => {
    const ready = input({ mode: "live", accounts: FUNDED, counterparties: [PAYEE], payableCount: 1 });
    const deciding = gettingStarted(ready);
    expect(deciding.next).toBe("payment");
    expect(step(deciding, "payment").path).toBe("/invoices");

    const held = gettingStarted({ ...ready, waitingCount: 1 });
    expect(step(held, "payment").path).toBe("/approvals");
    expect(step(held, "payment").body).toContain("Approvals");
  });

  it("on Arc mainnet, offers no hosted wallet and no faucet, and names the network and its gas (mainnet copy C2)", () => {
    const result = gettingStarted(input({ network: "arc-mainnet" }));
    const words = result.steps.map((s) => `${s.title} ${s.body}`).join(" ");
    expect(words).not.toMatch(/faucet|hosted|Arc testnet/i);
    expect(step(result, "wallet").body).toContain("Arc mainnet");
    expect(step(result, "fund").body).toContain("Send USDC on Arc mainnet");
    expect(step(result, "fund").body).toContain("0.10 USDC");
    expect(step(result, "payee").body).toContain("their address on Arc mainnet");
    expect(step(result, "payment").title).toBe("First payment on Arc mainnet");
    const live = gettingStarted(input({ network: "arc-mainnet", mode: "live", accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 0 }] }));
    expect(step(live, "fund").body).not.toMatch(/faucet|testnet/i);
    expect(step(live, "fund").body).toContain("Send USDC on Arc mainnet");
  });

  it("stays for a live workspace until its first payment on Arc testnet, then hides", () => {
    expect(gettingStarted(input({ mode: "live" })).show).toBe(true);
    const paid = gettingStarted(input({ mode: "live", onchainPayments: 1 }));
    expect(paid.show).toBe(false);
    expect(done(paid).payment).toBe(true);
  });

  it("points at the first step not done, even when a later one is", () => {
    const result = gettingStarted(input({ counterparties: [PAYEE], payableCount: 2 }));
    expect(result.next).toBe("wallet");
  });

  it("links each step to the page where it is done", () => {
    expect(Object.fromEntries(gettingStarted(input()).steps.map((each) => [each.id, each.path]))).toEqual({
      wallet: "/settings#go-live-title",
      fund: "/settings#go-live-title",
      live: "/settings#go-live-title",
      payee: "/counterparties",
      payable: "/invoices",
      payment: "/invoices",
    });
  });

  it("marks the steps only an owner can take", () => {
    expect(gettingStarted(input()).steps.filter((each) => each.ownerOnly).map((each) => each.id)).toEqual(["wallet", "live"]);
  });

  it("opens the Go live guide while a Settings step is left, and the first-payment guide after", () => {
    expect(gettingStarted(input({ accounts: FUNDED })).guide).toBe("go-live");
    expect(gettingStarted(input({ mode: "live", accounts: FUNDED })).guide).toBe("first-payment");
  });

  it("asks for USDC again when a live workspace's operating wallet holds none, and opens the Go live guide", () => {
    const result = gettingStarted(input({ mode: "live", accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 0 }] }));
    expect(done(result)).toMatchObject({ wallet: true, fund: false, live: true });
    expect(result.next).toBe("fund");
    expect(step(result, "fund").body).toContain("holds no USDC");
    expect(result.guide).toBe("go-live");
  });

  it("stays in a sandbox that has paid on Arc testnet, until it goes live", () => {
    const result = gettingStarted(input({ accounts: FUNDED, counterparties: [PAYEE], payableCount: 1, onchainPayments: 1 }));
    expect(result.show).toBe(true);
    expect(done(result).payment).toBe(true);
    expect(result.next).toBe("live");
    expect(step(result, "live").body).toContain("every 6 hours");
  });
});

describe("sample rows (sample-data design §1)", () => {
  it("does not tick the payee step for a sample counterparty, even one given an address", () => {
    expect(done(gettingStarted(input({ counterparties: [{ ...PAYEE, sample: true }] }))).payee).toBe(false);
    expect(done(gettingStarted(input({ counterparties: [{ ...PAYEE, sample: true }, { ...PAYEE, sample: false }] }))).payee).toBe(true);
  });

  it("counts only the payables of counterparties a person added", () => {
    const counterparties = [
      { id: "own", sample: false },
      { id: "sample-1", sample: true },
    ];
    expect(
      ownPayableCount(
        [
          { counterparty_id: "sample-1", direction: "payable" },
          { counterparty_id: "sample-1", direction: "payable" },
        ],
        counterparties
      )
    ).toBe(0);
    expect(
      ownPayableCount(
        [
          { counterparty_id: "sample-1", direction: "payable" },
          { counterparty_id: "own", direction: "payable" },
          { counterparty_id: "own", direction: "receivable" },
        ],
        counterparties
      )
    ).toBe(1);
    // A counterparty the page does not know (deleted meanwhile) is not a sample one.
    expect(ownPayableCount([{ counterparty_id: "gone", direction: "payable" }], counterparties)).toBe(1);
  });

  it("counts only payables that can still be paid: one paid in a sandbox, or rejected, cannot be the first payment", () => {
    const counterparties = [{ id: "own", sample: false }];
    const invoices = [
      { counterparty_id: "own", direction: "payable", status: "paid" },
      { counterparty_id: "own", direction: "payable", status: "rejected" },
    ];
    expect(ownPayableCount(invoices, counterparties)).toBe(0);
    for (const status of ["pending", "held", "flagged", "awaiting_info", "processing"]) {
      expect(ownPayableCount([...invoices, { counterparty_id: "own", direction: "payable", status }], counterparties)).toBe(1);
    }
  });
});

describe("getting started with the owner's own wallet (wallet treasury W1, W12)", () => {
  const owned = { kind: "operating", circle_wallet_id: null, balance: 0, address: "0xb0b0" };

  it("offers the owner's own wallet where the deployment has it", () => {
    const wallet = gettingStarted(input({ network: "arc-mainnet", walletTreasuryAvailable: true })).steps.find((step) => step.id === "wallet");
    expect(wallet?.body).toBe("Use a wallet you hold, such as MetaMask, as the workspace's treasury on Arc mainnet, or connect your own Circle account.");
  });

  it("counts the owner's wallet as the workspace's, and asks for USDC in it", () => {
    const steps = gettingStarted(input({ network: "arc-mainnet", walletHost: "external", accounts: [owned] })).steps;
    expect(steps.find((step) => step.id === "wallet")?.done).toBe(true);
    const fund = steps.find((step) => step.id === "fund");
    expect(fund?.done).toBe(false);
    expect(fund?.body).toBe("Add USDC on Arc mainnet to your own wallet, the workspace's treasury. Settings reads what the agent can move from the chain.");
    const funded = gettingStarted(input({ network: "arc-mainnet", walletHost: "external", accounts: [{ ...owned, balance: 5 }] })).steps;
    expect(funded.find((step) => step.id === "fund")?.done).toBe(true);
  });
});
