import { beforeEach, describe, expect, it, vi } from "vitest";

const { syncMock, budgetMock, appendMock } = vi.hoisted(() => ({ syncMock: vi.fn(), budgetMock: vi.fn(), appendMock: vi.fn() }));
vi.mock("@/lib/earned-vendors-store", () => ({ syncEarnedVendors: syncMock }));
vi.mock("@/lib/agent/outflow-budget", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/outflow-budget")>()), readOutflowBudget: budgetMock }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: appendMock }));

import { earnedGate, earnedGateFor, NO_EARNED } from "@/lib/agent/earned-gate";
import type { OrgDb } from "@/lib/dal";
import { EARNED_WAITING_MAX, type EarnedStatus, type RecordedStatus } from "@/lib/earned-vendors";

/**
 * The gate that lets the agent pay an earned vendor on its own in shadow mode
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL21, AL22, AL24-AL26): built at the AP stage's start, it
 * signs the statuses as step 2's sync does, then grants a payment only to a vendor earned now and recorded earned, with
 * the owner's switch on, a spending limit set, off Arc mainnet, and fewer than 3 of its own payments waiting for a
 * verdict. Anything it cannot read grants none, and it never throws: every payment then waits for a verdict, as before.
 * A decision in the stage that breaks a vendor's status takes it away at once, and signs the loss, best effort.
 */

const DB = {} as OrgDb;
const SHADOW = { startedAt: "2026-10-01T00:00:00.000Z" };
const NORTHWIND = "c0c0c0c0-0000-4000-8000-00000000b001";
const LUMEN = "c0c0c0c0-0000-4000-8000-00000000b002";
const TASMAN = "c0c0c0c0-0000-4000-8000-00000000b003";

function earned(vendorId: string, name: string, waiting = 0): EarnedStatus {
  return {
    vendorId, name, given: 6, state: "earned", agreed: 6, counted: [], from: "2026-10-20T09:00:00.000Z", to: "2026-10-27T09:00:00.000Z", since: null,
    waiting, paused: waiting >= EARNED_WAITING_MAX,
  };
}

/** What the sync answers: the rule, the switch, the statuses and each vendor's newest signed status. */
function synced(input: { payments?: boolean; streak?: number | null; statuses?: EarnedStatus[]; recorded?: Record<string, RecordedStatus["state"]> }) {
  return {
    streak: input.streak === undefined ? 5 : input.streak,
    payments: input.payments ?? true,
    statuses: input.statuses ?? [earned(NORTHWIND, "Northwind Packaging")],
    recorded: new Map(Object.entries(input.recorded ?? { [NORTHWIND]: "earned" }).map(([id, state], index) => [id, { state, seq: 7000 + index, at: "2026-10-27T10:00:00.000Z" }])),
    signed: [],
  };
}

const gate = (network = "arc-testnet") => earnedGateFor(DB, { network, shadow: SHADOW });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  syncMock.mockResolvedValue(synced({}));
  budgetMock.mockResolvedValue({ dailyUsdc: 2000, weeklyUsdc: null });
  appendMock.mockImplementation(async (entry: { action: string }) => ({ seq: 9001, ts: "2026-10-28T09:00:01.000Z", action: entry.action }));
});

describe("earnedGateFor (AL22, AL24)", () => {
  it("signs the statuses as the stage starts, then grants a vendor earned now and recorded earned, naming its entry", async () => {
    const built = await gate();
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(DB, { trigger: "cycle", shadow: SHADOW });
    expect(built.paysAlone(NORTHWIND)).toEqual({ recordSeq: 7000, streak: 5, agreed: 6 });
    expect(built.paysAlone(LUMEN)).toBeNull();
  });

  it("grants none to a vendor earned now and not recorded earned, recorded earned and no longer earned, or never earned", async () => {
    syncMock.mockResolvedValue(
      synced({
        statuses: [earned(NORTHWIND, "Northwind Packaging"), { vendorId: LUMEN, name: "Lumen Print Co.", given: 6, state: "counting", agreed: 2, needed: 5, since: null }, earned(TASMAN, "Tasman Freight")],
        recorded: { [NORTHWIND]: "lost", [LUMEN]: "earned" },
      })
    );
    const built = await gate();
    expect(built.paysAlone(NORTHWIND)).toBeNull();
    expect(built.paysAlone(LUMEN)).toBeNull();
    expect(built.paysAlone(TASMAN)).toBeNull();
  });

  it("grants none with the owner's switch off, or with no rule, while the sync still signs the statuses", async () => {
    syncMock.mockResolvedValue(synced({ payments: false }));
    expect((await gate()).paysAlone(NORTHWIND)).toBeNull();
    syncMock.mockResolvedValue(synced({ streak: null, payments: true }));
    expect((await gate()).paysAlone(NORTHWIND)).toBeNull();
    expect(syncMock).toHaveBeenCalledTimes(2);
    // With the switch off, the spending limit is not even read.
    expect(budgetMock).not.toHaveBeenCalled();
  });

  it("grants none on Arc mainnet, or without a spending limit for the agent", async () => {
    expect((await gate("arc-mainnet")).paysAlone(NORTHWIND)).toBeNull();
    budgetMock.mockResolvedValueOnce(null);
    expect((await gate()).paysAlone(NORTHWIND)).toBeNull();
    budgetMock.mockResolvedValueOnce({ dailyUsdc: null, weeklyUsdc: null });
    expect((await gate()).paysAlone(NORTHWIND)).toBeNull();
    budgetMock.mockResolvedValueOnce({ dailyUsdc: null, weeklyUsdc: 5000 });
    expect((await gate()).paysAlone(NORTHWIND)).toEqual({ recordSeq: 7000, streak: 5, agreed: 6 });
  });

  it("grants none, never throwing, when the sync or the spending limit cannot be read, and logs it", async () => {
    syncMock.mockRejectedValueOnce(new Error("ledger_entries not read: database unavailable"));
    await expect(gate()).resolves.toBe(NO_EARNED);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("earned vendors"), expect.stringContaining("database unavailable"));
    budgetMock.mockRejectedValueOnce(new Error("agent_budgets not read"));
    await expect(gate()).resolves.toBe(NO_EARNED);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("earned vendors"), expect.stringContaining("agent_budgets not read"));
  });
});

describe("at most 3 waiting (AL26)", () => {
  it("grants none to a vendor with 3 of its own payments waiting for a verdict, and counts each paid this stage", async () => {
    syncMock.mockResolvedValue(synced({ statuses: [earned(NORTHWIND, "Northwind Packaging", 3)] }));
    expect((await gate()).paysAlone(NORTHWIND)).toBeNull();

    syncMock.mockResolvedValue(synced({ statuses: [earned(NORTHWIND, "Northwind Packaging", 1)] }));
    const built = await gate();
    expect(built.paysAlone(NORTHWIND)).not.toBeNull();
    built.paid(NORTHWIND);
    expect(built.paysAlone(NORTHWIND)).not.toBeNull();
    built.paid(NORTHWIND);
    // Three now wait: the next waits for a verdict, and no entry is signed for the pause.
    expect(built.paysAlone(NORTHWIND)).toBeNull();
    expect(appendMock).not.toHaveBeenCalled();
  });
});

describe("lost in the stage (AL25)", () => {
  it("takes the status away for the rest of the stage, and signs vendor_earned_lost naming the decision", async () => {
    const built = await gate();
    await built.lose(NORTHWIND, { kind: "code_stop", decisionSeq: 8123, rule: "invoice.pay_to_differs" });
    expect(built.paysAlone(NORTHWIND)).toBeNull();
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith({
      actor: "system",
      domain: "compliance",
      action: "vendor_earned_lost",
      summary: "Northwind Packaging is no longer an earned vendor: a check in code stopped one of its bills",
      detail: { counterpartyId: NORTHWIND, streak: 5, because: "code_stop", decisionSeq: 8123, rule: "invoice.pay_to_differs", trigger: "cycle" },
    });
    // Once is enough: a second break in the stage signs nothing more.
    await built.lose(NORTHWIND, { kind: "flagged", decisionSeq: 8124, rule: null });
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it("signs the loss of a vendor recorded earned that 3 waiting payments paused", async () => {
    syncMock.mockResolvedValue(synced({ statuses: [earned(NORTHWIND, "Northwind Packaging", 3)] }));
    const built = await gate();
    await built.lose(NORTHWIND, { kind: "flagged", decisionSeq: 8125, rule: "invoice.duplicate_of_settled" });
    expect(appendMock).toHaveBeenCalledWith(expect.objectContaining({ action: "vendor_earned_lost", detail: expect.objectContaining({ because: "flagged", decisionSeq: 8125 }) }));
  });

  it("still takes it away when the loss cannot be signed, logging it for the next sync to sign", async () => {
    appendMock.mockRejectedValueOnce(new Error("ledger signing key not readable"));
    const built = await gate();
    await expect(built.lose(NORTHWIND, { kind: "code_stop", decisionSeq: 8126, rule: "counterparty.payment_limit" })).resolves.toBeUndefined();
    expect(built.paysAlone(NORTHWIND)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("earned vendors"), expect.stringContaining("ledger signing key not readable"));
  });

  it("does nothing for a vendor it never granted, and nothing at all with no gate", async () => {
    const built = await gate();
    await built.lose(LUMEN, { kind: "code_stop", decisionSeq: 8127, rule: "counterparty.payment_limit" });
    await NO_EARNED.lose(NORTHWIND, { kind: "flagged", decisionSeq: 8128, rule: null });
    NO_EARNED.paid(NORTHWIND);
    expect(NO_EARNED.paysAlone(NORTHWIND)).toBeNull();
    expect(appendMock).not.toHaveBeenCalled();
  });
});

describe("earnedGate, from fixed grants", () => {
  it("grants what it was given, as earnedGateFor grants from the sync", () => {
    const built = earnedGate([{ vendorId: NORTHWIND, name: "Northwind Packaging", grant: { recordSeq: 42, streak: 8, agreed: 9 }, waiting: 0 }]);
    expect(built.paysAlone(NORTHWIND)).toEqual({ recordSeq: 42, streak: 8, agreed: 9 });
    expect(built.paysAlone(LUMEN)).toBeNull();
  });
});
