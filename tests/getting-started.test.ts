import { describe, expect, it } from "vitest";
import { gettingStarted, ownBillCount, ownDecidedCount, ownPayableCount, PAY_ON_ARC, type GettingStartedInput } from "@/lib/getting-started";

/**
 * The console's Get started checklist, computed from rows the console
 * already reads (getting-started design §1, G1, G2; first-payment design §2):
 * no stored state, so it ticks itself off, and it disappears once the
 * workspace has made its first payment on Arc testnet.
 */

const ADDRESS = "0x1948aB0000000000000000000000000000c345a0";
const FUNDED = [{ kind: "operating", circle_wallet_id: "w-1", balance: 40 }];
/** A sandbox that has its wallet, not yet funded: it keeps the order to a first payment. */
const WALLET = [{ kind: "operating", circle_wallet_id: "w-1", balance: 0 }];
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
  it("lists the six steps to a first payment in order, none done, the wallet next, for a new workspace on Arc mainnet", () => {
    const result = gettingStarted(input({ network: "arc-mainnet" }));
    expect(result.show).toBe(true);
    expect(result.steps.map((each) => each.title)).toEqual([
      "Add a wallet",
      "Fund it with USDC",
      "Go live",
      "Add a payee with an Arc address",
      "Add a payable",
      "First payment on Arc mainnet",
    ]);
    expect(Object.values(done(result))).toEqual([false, false, false, false, false, false]);
    expect(result.next).toBe("wallet");
  });

  it("keeps that order on Arc testnet once the workspace has a wallet, or is live", () => {
    const order = ["wallet", "fund", "live", "payee", "payable", "payment"];
    expect(gettingStarted(input({ accounts: WALLET })).steps.map((each) => each.id)).toEqual(order);
    expect(gettingStarted(input({ mode: "live" })).steps.map((each) => each.id)).toEqual(order);
    expect(gettingStarted(input({ accounts: WALLET })).steps.every((each) => each.section === undefined)).toBe(true);
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
    const payee = (counterparties: GettingStartedInput["counterparties"]) => done(gettingStarted(input({ accounts: WALLET, counterparties }))).payee;
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
    const result = gettingStarted(input({ network: "arc-mainnet", counterparties: [PAYEE], payableCount: 2 }));
    expect(result.next).toBe("wallet");
  });

  it("links each step to the page where it is done", () => {
    expect(Object.fromEntries(gettingStarted(input({ accounts: WALLET })).steps.map((each) => [each.id, each.path]))).toEqual({
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

describe("gettingStarted in shadow mode", () => {
  const shadow = (over: Partial<NonNullable<GettingStartedInput["shadow"]>> = {}) => ({ currency: "USDC", verdictsGiven: 0, billCount: 0, ...over });
  const LIVE_FUNDED = { mode: "live" as const, accounts: FUNDED };
  const MIRRORED = { name: "Dien luc", role: "vendor", address: ADDRESS, address_changed_at: null, address_confirmed_at: null };

  it("lists the steps of running beside how the business pays today, titled for shadow mode, with its guide", () => {
    const result = gettingStarted(input({ accounts: WALLET, shadow: shadow() }));
    expect(result.title).toBe("Get started in shadow mode");
    expect(result.guide).toBe("shadow-mode");
    expect(result.steps.map((each) => each.title)).toEqual([
      "Add a wallet",
      "Fund it with USDC",
      "Go live",
      "Add your suppliers",
      "Add your real bills",
      "Give your first verdict",
    ]);
    expect(result.show).toBe(true);
    expect(result.next).toBe("fund");
  });

  it("ticks a supplier with a mirror address, a bill once any was added, paid or not, and the first verdict, then hides", () => {
    expect(done(gettingStarted(input({ ...LIVE_FUNDED, counterparties: [MIRRORED], shadow: shadow() })))).toMatchObject({ suppliers: true, bills: false, verdict: false });
    const billed = gettingStarted(input({ ...LIVE_FUNDED, counterparties: [MIRRORED], payableCount: 0, shadow: shadow({ billCount: 1 }) }));
    expect(done(billed)).toMatchObject({ bills: true, verdict: false });
    expect(billed.next).toBe("verdict");
    expect(gettingStarted(input({ ...LIVE_FUNDED, counterparties: [MIRRORED], shadow: shadow({ billCount: 1, verdictsGiven: 1 }) })).show).toBe(false);
  });

  it("says how a supplier with no Arc address gets a mirror address, and one with no purchase orders is paid without them", () => {
    const body = step(gettingStarted(input({ accounts: WALLET, shadow: shadow() })), "suppliers").body;
    expect(body).toContain("Give it a mirror address");
    expect(body).toContain("Pay without purchase orders");
    expect(step(gettingStarted(input({ accounts: WALLET, shadow: shadow() })), "suppliers").path).toBe("/counterparties");
  });

  it("says bills are entered in USDC, or in the business's own currency at the day's rate", () => {
    expect(step(gettingStarted(input({ shadow: shadow() })), "bills").body).toContain("in USDC, as on any invoice");
    expect(step(gettingStarted(input({ shadow: shadow({ currency: "EUR" }) })), "bills").body).toContain("in EUR, as written on it");
  });

  it("sends the person to Approvals to give the verdict once a decision waits for one", () => {
    const waiting = step(gettingStarted(input({ ...LIVE_FUNDED, counterparties: [MIRRORED], waitingCount: 1, shadow: shadow({ billCount: 1 }) })), "verdict");
    expect(waiting.path).toBe("/approvals");
    expect(waiting.body).toContain("Agree and pay");
    expect(waiting.body).toContain("Disagree");
  });

  it("is the first-payment checklist outside shadow mode", () => {
    const result = gettingStarted(input({ accounts: WALLET, shadow: null }));
    expect(result.title).toBeUndefined();
    expect(result.guide).toBe("go-live");
  });

  it("in a sandbox with no wallet, asks for suppliers, bills and the first verdict first, then the setup to pay on Arc", () => {
    const result = gettingStarted(input({ shadow: shadow() }));
    expect(result.title).toBe("Get started in shadow mode");
    expect(result.steps.map((each) => each.id)).toEqual(["suppliers", "bills", "verdict", "wallet", "fund", "live"]);
    expect(result.steps.map((each) => each.section)).toEqual([undefined, undefined, undefined, PAY_ON_ARC, PAY_ON_ARC, PAY_ON_ARC]);
    expect(result.next).toBe("suppliers");
    expect(result.guide).toBe("shadow-mode");
  });

  it("in a sandbox with no wallet, ticks a supplier with no address, asks whether it sends purchase orders, and says agreeing is simulated", () => {
    const supplier = { name: "Dien luc", role: "vendor", address: null };
    const result = gettingStarted(input({ counterparties: [supplier], shadow: shadow({ billCount: 1 }) }));
    expect(done(result)).toMatchObject({ suppliers: true, bills: true, verdict: false, wallet: false });
    expect(result.next).toBe("verdict");
    expect(step(gettingStarted(input({ shadow: shadow() })), "suppliers").body).toContain("whether it sends you purchase orders");
    expect(step(result, "suppliers").body).not.toContain("mirror address");
    expect(step(result, "verdict").body).toContain("Agree and pay pays it, simulated in this sandbox");
    expect(step(result, "verdict").body).not.toContain("USDC on Arc testnet");
    // The verdict given, the setup to pay on Arc is what is left.
    expect(gettingStarted(input({ counterparties: [supplier], shadow: shadow({ billCount: 1, verdictsGiven: 1 }) })).next).toBe("wallet");
  });
});

describe("gettingStarted in a sandbox with no wallet: the first bill before the wallet", () => {
  const SUPPLIER = { name: "Northstar Studio", role: "vendor", address: null };

  it("asks for a supplier, a bill and the agent's decision first, then the wallet, USDC, going live and the first payment, to pay on Arc", () => {
    const result = gettingStarted(input());
    expect(result.steps.map((each) => each.title)).toEqual([
      "Add a supplier",
      "Add a bill",
      "See the agent's decision",
      "Add a wallet",
      "Fund it with USDC",
      "Go live",
      "First payment on Arc testnet",
    ]);
    expect(result.steps.map((each) => each.section)).toEqual([undefined, undefined, undefined, PAY_ON_ARC, PAY_ON_ARC, PAY_ON_ARC, PAY_ON_ARC]);
    expect(result.next).toBe("payee");
    expect(result.guide).toBe("first-payment");
    expect(result.show).toBe(true);
  });

  it("asks for no Arc address: a sandbox simulates the payee's", () => {
    const supplier = step(gettingStarted(input()), "payee");
    expect(supplier.title).not.toContain("Arc address");
    expect(supplier.body).toContain("Its Arc address can wait");
    expect(supplier.path).toBe("/counterparties");
    expect(done(gettingStarted(input({ counterparties: [SUPPLIER] }))).payee).toBe(true);
    expect(done(gettingStarted(input({ counterparties: [{ ...SUPPLIER, role: "client" }] }))).payee).toBe(false);
    expect(done(gettingStarted(input({ counterparties: [{ ...SUPPLIER, sample: true }] }))).payee).toBe(false);
  });

  it("ticks the bill once one was added, paid or not, and the decision once the agent made one", () => {
    const billed = gettingStarted(input({ counterparties: [SUPPLIER], payableCount: 0, billCount: 1, decidedCount: 0 }));
    expect(done(billed)).toMatchObject({ payee: true, payable: true, decision: false });
    expect(billed.next).toBe("decision");
    expect(step(billed, "decision").path).toBe("/invoices");
    const decided = gettingStarted(input({ counterparties: [SUPPLIER], billCount: 1, decidedCount: 1 }));
    expect(done(decided).decision).toBe(true);
    expect(decided.next).toBe("wallet");
    expect(decided.guide).toBe("go-live");
    // A bill held for a person was decided too.
    expect(done(gettingStarted(input({ counterparties: [SUPPLIER], billCount: 1, waitingCount: 1 }))).decision).toBe(true);
  });

  it("keeps the order to a first payment on Arc mainnet, which never simulates", () => {
    expect(gettingStarted(input({ network: "arc-mainnet" })).steps[0].id).toBe("wallet");
  });
});

describe("ownDecidedCount", () => {
  it("counts the payables of counterparties a person added that left pending, paid or not, and no receivable or sample bill", () => {
    const counterparties = [{ id: "c1" }, { id: "c2", sample: true }];
    const invoices = [
      { counterparty_id: "c1", direction: "payable", status: "pending" },
      { counterparty_id: "c1", direction: "payable", status: "paid" },
      { counterparty_id: "c1", direction: "payable", status: "awaiting_info" },
      { counterparty_id: "c1", direction: "receivable", status: "matched" },
      { counterparty_id: "c2", direction: "payable", status: "held" },
    ];
    expect(ownDecidedCount(invoices, counterparties)).toBe(2);
  });
});

describe("ownBillCount", () => {
  it("counts every payable of a counterparty a person added, paid or not, and no receivable or sample bill", () => {
    const counterparties = [{ id: "c1" }, { id: "c2", sample: true }];
    const invoices = [
      { counterparty_id: "c1", direction: "payable", status: "paid" },
      { counterparty_id: "c1", direction: "payable", status: "held" },
      { counterparty_id: "c1", direction: "receivable", status: "pending" },
      { counterparty_id: "c2", direction: "payable", status: "pending" },
    ];
    expect(ownBillCount(invoices, counterparties)).toBe(2);
  });
});
