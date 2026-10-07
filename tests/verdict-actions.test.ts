import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeMock, giveVerdictMock, commands } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  giveVerdictMock: vi.fn(),
  commands: {
    approvePayable: vi.fn(),
    rejectPayable: vi.fn(),
    returnPayable: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/commands/actor", () => ({ consoleActor: () => ({ userId: "u1", surface: { kind: "console" } }) }));
vi.mock("@/lib/commands/payables", () => commands);
vi.mock("@/lib/verdicts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/verdicts")>()), giveVerdict: giveVerdictMock }));

import { giveVerdictAction } from "@/app/actions/verdicts";
import { VerdictError } from "@/lib/verdicts";

/**
 * A verdict from the console (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S3, S4): by someone who may decide
 * payments, read before anything is done, and what follows it through the same payable commands as Approvals.
 */

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue({ ok: true, user: { id: "u1" }, orgId: "org-1" });
  giveVerdictMock.mockReset();
  for (const command of Object.values(commands)) command.mockReset();
});

describe("giveVerdictAction", () => {
  it("is for someone who may decide payments", async () => {
    authorizeMock.mockResolvedValue({ ok: false, message: "You cannot do that here." });
    expect(await giveVerdictAction("northstar", { entrySeq: 41, verdict: "agree" })).toEqual({ ok: false, message: "You cannot do that here." });
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "approval.decide");
    expect(giveVerdictMock).not.toHaveBeenCalled();
  });

  it("refuses what it cannot read before anything is done", async () => {
    for (const input of [{ entrySeq: "41", verdict: "agree" }, { entrySeq: 41, verdict: "maybe" }, { entrySeq: 41, verdict: "agree", then: "send" }, null]) {
      expect(await giveVerdictAction("northstar", input)).toEqual({ ok: false, message: "That verdict could not be read." });
    }
    expect(giveVerdictMock).not.toHaveBeenCalled();
  });

  it("says the verdict, and what the payment it agreed to came to, through Approve and pay's own command", async () => {
    commands.approvePayable.mockResolvedValue({ ok: true, message: "Paid." });
    giveVerdictMock.mockImplementation(async (_input, actions) => ({ given: { verdict: "agree", reason: null }, already: false, after: await actions.approve("inv-1") }));
    const result = await giveVerdictAction("northstar", { entrySeq: 41, verdict: "agree", then: "pay" });
    expect(result).toEqual({ ok: true, message: "You agreed with the agent. Paid.", given: { verdict: "agree", reason: null } });
    expect(giveVerdictMock).toHaveBeenCalledWith({ actorId: "u1", entrySeq: 41, verdict: "agree", then: "pay" }, expect.any(Object));
    expect(commands.approvePayable).toHaveBeenCalledWith({ userId: "u1", surface: { kind: "console" } }, { invoiceId: "inv-1" });
  });

  it("keeps the verdict and says why the payment did not go", async () => {
    commands.approvePayable.mockResolvedValue({ ok: false, message: "The transfer failed: insufficient funds. The invoice is held." });
    giveVerdictMock.mockImplementation(async (_input, actions) => ({ given: { verdict: "agree", reason: null }, already: false, after: await actions.approve("inv-1") }));
    expect(await giveVerdictAction("northstar", { entrySeq: 41, verdict: "agree", then: "pay" })).toEqual({
      ok: false,
      message: "You agreed with the agent. The transfer failed: insufficient funds. The invoice is held.",
      given: { verdict: "agree", reason: null },
    });
  });

  it("returns or rejects through their own commands, with the reason", async () => {
    commands.rejectPayable.mockResolvedValue({ ok: true, message: "Rejected." });
    giveVerdictMock.mockImplementation(async (_input, actions) => ({ given: { verdict: "disagree", reason: "Wrong bill" }, already: false, after: await actions.reject("inv-1", "Wrong bill") }));
    expect((await giveVerdictAction("northstar", { entrySeq: 41, verdict: "disagree", reason: "Wrong bill", then: "reject" })).message).toBe("You disagreed with the agent. Rejected.");
    expect(commands.rejectPayable).toHaveBeenCalledWith(expect.anything(), { invoiceId: "inv-1", reason: "Wrong bill" });

    commands.returnPayable.mockResolvedValue({ ok: true, message: "Returned to the agent." });
    giveVerdictMock.mockImplementation(async (_input, actions) => ({ given: { verdict: "disagree", reason: "Later" }, already: false, after: await actions.returnToAgent("inv-1") }));
    expect((await giveVerdictAction("northstar", { entrySeq: 41, verdict: "disagree", reason: "Later", then: "return" })).message).toBe("You disagreed with the agent. Returned to the agent.");
  });

  it("says a verdict given before, and a refusal in its own words", async () => {
    giveVerdictMock.mockResolvedValue({ given: { verdict: "disagree", reason: "Later" }, already: true });
    expect(await giveVerdictAction("northstar", { entrySeq: 41, verdict: "agree" })).toEqual({
      ok: true,
      message: "A verdict was given on this decision already: disagreed.",
      given: { verdict: "disagree", reason: "Later" },
    });
    giveVerdictMock.mockRejectedValue(new VerdictError("reason_required"));
    expect(await giveVerdictAction("northstar", { entrySeq: 41, verdict: "disagree" })).toEqual({ ok: false, message: "Say why you disagree, in a few words." });
    giveVerdictMock.mockRejectedValue(new Error("connection reset"));
    expect(await giveVerdictAction("northstar", { entrySeq: 41, verdict: "agree" })).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
  });
});
