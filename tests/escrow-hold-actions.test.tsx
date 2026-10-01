import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lockMilestoneAction } from "@/app/actions/escrow";
import { MilestoneEscrow } from "@/components/MilestoneEscrow";

/**
 * Locking a milestone from its card (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E3, E6): the
 * action's checks and words, and what the card shows of a hold. The library is stood in for;
 * tests/escrow-holds.test.ts covers it.
 */

const { authorizeMock, lib } = vi.hoisted(() => ({ authorizeMock: vi.fn(), lib: { lockMilestone: vi.fn() } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/circle/escrow-holds", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/circle/escrow-holds")>()), ...lib }));

import { EscrowHoldError } from "@/lib/circle/escrow-holds";

const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001aa";
const REQUEST = "0b6c1c9e-4a4f-4a7e-9b1e-00000000f00d";
const FUND = `0x${"2".repeat(64)}`;
const access = (mode: "live" | "sandbox") => ({ ok: true, user: { id: "user-1", email: null }, membership: { orgId: "org-1", slug: "testnet-2", name: "Testnet 2", mode, role: "owner" } });
const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ orgSlug: "testnet-2", milestoneId: MILESTONE, refundAfter: "2026-10-31", requestId: REQUEST, ...fields })) data.set(key, value);
  return data;
};
const empty = { ok: false, message: "" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

beforeEach(() => {
  authorizeMock.mockReset();
  lib.lockMilestone.mockReset();
});

describe("lockMilestoneAction", () => {
  it("locks a milestone under the form's request id and refund date", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    lib.lockMilestone.mockResolvedValue({ fundTxHash: FUND });
    expect(await lockMilestoneAction(empty, form())).toEqual({ ok: true, message: "Locked in escrow until 2026-10-31." });
    expect(authorizeMock).toHaveBeenCalledWith("testnet-2", "treasury.manage");
    expect(lib.lockMilestone).toHaveBeenCalledWith({ actorId: "user-1", milestoneId: MILESTONE, refundAfter: "2026-10-31", requestId: REQUEST });
  });

  it("refuses a sandbox, a bad milestone or date, and a form without its request id", async () => {
    authorizeMock.mockResolvedValue(access("sandbox"));
    expect((await lockMilestoneAction(empty, form())).message).toBe("Escrow is a contract on Arc testnet, for a live workspace. Take this workspace live first.");
    authorizeMock.mockResolvedValue(access("live"));
    expect((await lockMilestoneAction(empty, form({ milestoneId: "nope" }))).message).toBe("That milestone is not in this workspace.");
    expect((await lockMilestoneAction(empty, form({ refundAfter: "soon" }))).message).toBe("Choose a refund date after today, and within a year.");
    expect((await lockMilestoneAction(empty, form({ requestId: "" }))).message).toBe("Reload the page and try again.");
    expect(lib.lockMilestone).not.toHaveBeenCalled();
  });

  it("says why it could not lock, and asks for a new request id after a step Circle failed", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    lib.lockMilestone.mockRejectedValueOnce(new EscrowHoldError("Circle did not complete the fund (FAILED). Nothing is locked; try again.", true));
    expect(await lockMilestoneAction(empty, form())).toEqual({ ok: false, message: "Circle did not complete the fund (FAILED). Nothing is locked; try again.", renew: true });
    lib.lockMilestone.mockRejectedValueOnce(new EscrowHoldError("This milestone is already locked in escrow."));
    expect(await lockMilestoneAction(empty, form())).toEqual({ ok: false, message: "This milestone is already locked in escrow." });
  });
});

describe("the milestone's escrow on its card", () => {
  const base = { orgSlug: "testnet-2", milestoneId: MILESTONE, requestId: REQUEST, defaultRefundDate: "2026-10-31", escrowReady: true, canManage: true, paid: false };

  it("offers to lock an unlocked milestone, with a refund date, to an owner or admin", () => {
    const markup = renderToStaticMarkup(<MilestoneEscrow {...base} hold={null} />);
    expect(text(markup)).toContain("Lock in escrow");
    expect(markup).toMatch(/<input[^>]*type="date"[^>]*name="refundAfter"[^>]*value="2026-10-31"|<input[^>]*name="refundAfter"[^>]*type="date"/);
    expect(markup).toContain(`value="${REQUEST}"`);
  });

  it("offers nothing when escrow is not set up, to someone who may not manage treasury, or for a paid milestone", () => {
    expect(renderToStaticMarkup(<MilestoneEscrow {...base} escrowReady={false} hold={null} />)).toBe("");
    expect(renderToStaticMarkup(<MilestoneEscrow {...base} canManage={false} hold={null} />)).toBe("");
    expect(renderToStaticMarkup(<MilestoneEscrow {...base} paid hold={null} />)).toBe("");
  });

  it("says a hold is locked until its date, released or refunded, with its transaction", () => {
    const funded = text(renderToStaticMarkup(<MilestoneEscrow {...base} hold={{ state: "funded", refundAfter: "2026-10-31T00:00:00Z", amount: 2, fundTxHash: FUND, releaseTxHash: null, refundTxHash: null }} />));
    expect(funded).toContain("2 USDC locked in escrow until 31 Oct 2026");
    const released = renderToStaticMarkup(<MilestoneEscrow {...base} paid hold={{ state: "released", refundAfter: "2026-10-31T00:00:00Z", amount: 2, fundTxHash: FUND, releaseTxHash: `0x${"3".repeat(64)}`, refundTxHash: null }} />);
    expect(text(released)).toContain("Released from escrow");
    expect(released).toContain(`href="https://testnet.arcscan.app/tx/0x${"3".repeat(64)}"`);
    expect(text(renderToStaticMarkup(<MilestoneEscrow {...base} hold={{ state: "refunded", refundAfter: "2026-10-31T00:00:00Z", amount: 2, fundTxHash: FUND, releaseTxHash: null, refundTxHash: `0x${"4".repeat(64)}` }} />))).toContain(
      "Refunded from escrow"
    );
  });
});
