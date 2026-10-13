import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { addDeal, addDealCost, changeDeal, linkDealCost, releaseDealLine, removeDealCost, setDealAutoRelease } from "@/lib/commands/deals";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import type { CostDraft } from "@/lib/deals/costs";
import { DealCostError } from "@/lib/deals/costs-write";
import type { ChangeDraft, DealDraft } from "@/lib/deals/input";
import { DealError } from "@/lib/deals/write";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * A deal's commands (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D13): the people who add receivables
 * (`records.write`, owners and admins) confirm, change and release deals and set the switch, from the console only; the
 * gate runs before anything is read, and a deal's refusal reads in its own words.
 */

const { mocks, costMocks } = vi.hoisted(() => ({
  mocks: { confirmDeal: vi.fn(), changeDeal: vi.fn(), releaseDealLine: vi.fn(), switchDealAutoRelease: vi.fn() },
  costMocks: { addDealCost: vi.fn(), removeDealCost: vi.fn(), linkDealCost: vi.fn() },
}));
vi.mock("@/lib/deals/write", async (original) => ({ ...(await original<typeof import("@/lib/deals/write")>()), ...mocks }));
vi.mock("@/lib/deals/costs-write", async (original) => ({ ...(await original<typeof import("@/lib/deals/costs-write")>()), ...costMocks }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";
const DEAL = "dddddddd-0000-4000-8000-000000000001";
const LINE = "11111111-0000-4000-8000-000000000001";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });

const draft = { title: "Website rebuild" } as DealDraft;
const change = { dealId: DEAL, kind: "revised" } as ChangeDraft;

const costDraft = { dealId: DEAL, label: "Contractor: design" } as CostDraft;
const COST = "22222222-0000-4000-8000-000000000001";

beforeEach(() => {
  for (const mock of [...Object.values(mocks), ...Object.values(costMocks)]) mock.mockReset();
});

describe("who may act on deals", () => {
  it("is who adds receivables, from the console only", () => {
    for (const command of ["deal.create", "deal.change", "deal.release", "deal.auto_release", "deal.add_cost", "deal.remove_cost", "deal.link_cost"] as const) {
      expect(COMMAND_PERMISSIONS[command]).toBe("records.write");
      expect(COMMAND_PERMISSIONS[command]).toBe(COMMAND_PERMISSIONS["invoice.add"]);
      for (const surface of ["telegram", "slack", "api", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain(command);
    }
  });

  it("refuses an approver and a viewer before anything is read", async () => {
    for (const role of ["approver", "viewer"] as const) {
      expect(await run(() => addDeal(actor({ role }), { draft }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await run(() => changeDeal(actor({ role }), { change }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await run(() => releaseDealLine(actor({ role }), { dealId: DEAL, lineId: LINE }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await run(() => setDealAutoRelease(actor({ role }), { dealId: DEAL, on: true }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await run(() => addDealCost(actor({ role }), { draft: costDraft }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await run(() => removeDealCost(actor({ role }), { dealId: DEAL, costId: COST }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await run(() => linkDealCost(actor({ role }), { dealId: DEAL, costId: COST, target: { kind: "payable", id: LINE } }))).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await run(() => addDeal(actor({ surface: { kind: "api", apiKeyId: "key-1" } }), { draft }))).toMatchObject({ ok: false, code: "surface" });
    for (const mock of [...Object.values(mocks), ...Object.values(costMocks)]) expect(mock).not.toHaveBeenCalled();
  });
});

describe("addDeal", () => {
  it("confirms the deal as the actor, and says so", async () => {
    mocks.confirmDeal.mockResolvedValue({ dealId: DEAL, created: true, title: "Website rebuild", customerName: "Acme Studio" });
    const result = await run(() => addDeal(actor({ role: "admin" }), { draft }));
    expect(mocks.confirmDeal).toHaveBeenCalledWith({ actorId: USER, draft });
    expect(result).toEqual({
      ok: true,
      message: "Deal confirmed with Acme Studio: Website rebuild. Release each line when it is time to invoice it.",
      dealId: DEAL,
      created: true,
    });
  });

  it("says a repeated confirm made no second deal", async () => {
    mocks.confirmDeal.mockResolvedValue({ dealId: DEAL, created: false, title: "Website rebuild", customerName: "Acme Studio" });
    expect(await run(() => addDeal(actor(), { draft }))).toMatchObject({ ok: true, created: false, message: "This deal was confirmed already: Website rebuild." });
  });

  it("refuses in the deal's words, and says nothing of a failure no one can act on", async () => {
    mocks.confirmDeal.mockRejectedValue(new DealError("not_ready"));
    expect(await run(() => addDeal(actor(), { draft }))).toEqual({ ok: false, code: "not_ready", message: "Deals are not set up on this deployment yet." });
    mocks.confirmDeal.mockRejectedValue(new Error("connection reset"));
    expect(await run(() => addDeal(actor(), { draft }))).toEqual({ ok: false, code: "failed", message: "That did not work. Try again in a moment." });
  });
});

describe("changeDeal", () => {
  it("says what a change, a cancel and a reopen did", async () => {
    mocks.changeDeal.mockResolvedValueOnce({ version: 2, created: true, title: "Website rebuild", kind: "revised" });
    expect(await run(() => changeDeal(actor(), { change }))).toMatchObject({ ok: true, version: 2, message: "Version 2 of Website rebuild is saved. The receivables made stay as they are." });
    mocks.changeDeal.mockResolvedValueOnce({ version: 3, created: true, title: "Website rebuild", kind: "cancelled" });
    expect(await run(() => changeDeal(actor(), { change }))).toMatchObject({ message: "Website rebuild is cancelled. The lines not invoiced yet are stopped; the receivables made stay as they are." });
    mocks.changeDeal.mockResolvedValueOnce({ version: 4, created: true, title: "Website rebuild", kind: "reopened" });
    expect(await run(() => changeDeal(actor(), { change }))).toMatchObject({ message: "Website rebuild is reopened as version 4." });
  });

  it("marks a change made since as changed, so the page shows the deal as it is now", async () => {
    mocks.changeDeal.mockRejectedValue(new DealError("changed"));
    expect(await run(() => changeDeal(actor(), { change }))).toMatchObject({ ok: false, code: "changed", changed: true });
  });

  it("refreshes the page for a form sent again with other details, so the next try carries a new key", async () => {
    mocks.changeDeal.mockRejectedValue(new DealError("key_reused"));
    expect(await run(() => changeDeal(actor(), { change }))).toMatchObject({
      ok: false,
      code: "key_reused",
      changed: true,
      message: "This form was sent already, with other details. Reload the page and try again.",
    });
  });
});

describe("releaseDealLine", () => {
  it("releases as the person, and says what receivable it made", async () => {
    mocks.releaseDealLine.mockResolvedValue({ invoiceId: "inv-1", made: true, title: "Website rebuild", line: "Deposit (30%)", customerName: "Acme Studio", amount: "3,000.00 USDC" });
    const result = await run(() => releaseDealLine(actor(), { dealId: DEAL, lineId: LINE }));
    expect(mocks.releaseDealLine).toHaveBeenCalledWith({ actorId: USER, dealId: DEAL, lineId: LINE, via: "person" });
    expect(result).toEqual({ ok: true, invoiceId: "inv-1", message: "Deposit (30%) of Website rebuild is now a receivable from Acme Studio: 3,000.00 USDC." });
  });

  it("refuses a credit in its own words", async () => {
    mocks.releaseDealLine.mockRejectedValue(new DealError("credit"));
    expect(await run(() => releaseDealLine(actor(), { dealId: DEAL, lineId: LINE }))).toEqual({ ok: false, code: "credit", message: "A credit is owed to the customer: it is never invoiced." });
  });
});

describe("setDealAutoRelease", () => {
  it("turns the agent's release on and off", async () => {
    mocks.switchDealAutoRelease.mockResolvedValue({ title: "Website rebuild", changed: true });
    expect(await run(() => setDealAutoRelease(actor(), { dealId: DEAL, on: true }))).toEqual({ ok: true, message: "The agent now releases each line of Website rebuild on its invoice day." });
    expect(await run(() => setDealAutoRelease(actor(), { dealId: DEAL, on: false }))).toEqual({ ok: true, message: "The lines of Website rebuild are now released by a person only." });
  });
});

describe("a deal's costs", () => {
  it("adds a cost as the person, and says a repeated form added none", async () => {
    costMocks.addDealCost.mockResolvedValueOnce({ cost: { id: COST, label: "Contractor: design" }, created: true, title: "Website rebuild", amount: "1,240.00 USDC" });
    const result = await run(() => addDealCost(actor(), { draft: costDraft }));
    expect(costMocks.addDealCost).toHaveBeenCalledWith({ actorId: USER, draft: costDraft });
    expect(result).toEqual({ ok: true, costId: COST, message: "Contractor: design, 1,240.00 USDC, is planned for Website rebuild." });
    costMocks.addDealCost.mockResolvedValueOnce({ cost: { id: COST, label: "Contractor: design" }, created: false, title: "Website rebuild", amount: "1,240.00 USDC" });
    expect(await run(() => addDealCost(actor(), { draft: costDraft }))).toMatchObject({ ok: true, message: "This cost was added already: Contractor: design." });
  });

  it("removes and links a cost, and says what it now counts as", async () => {
    costMocks.removeDealCost.mockResolvedValue({ removed: true, title: "Website rebuild", label: "Contractor: design" });
    expect(await run(() => removeDealCost(actor(), { dealId: DEAL, costId: COST }))).toEqual({ ok: true, message: "Contractor: design is removed from Website rebuild." });
    costMocks.linkDealCost.mockResolvedValue({ title: "Website rebuild", label: "Contractor: design", to: "the bill from Northwind Hosting, 1,500.00 USDC" });
    expect(await run(() => linkDealCost(actor(), { dealId: DEAL, costId: COST, target: { kind: "payable", id: LINE } }))).toEqual({
      ok: true,
      message: "Contractor: design is linked to the bill from Northwind Hosting, 1,500.00 USDC: it counts in the plan's place.",
    });
  });

  it("refuses in the cost's words, refreshing the page when what it showed is out of date", async () => {
    costMocks.linkDealCost.mockRejectedValue(new DealCostError("link_taken"));
    expect(await run(() => linkDealCost(actor(), { dealId: DEAL, costId: COST, target: { kind: "payable", id: LINE } }))).toEqual({
      ok: false,
      code: "link_taken",
      changed: true,
      message: "That bill or milestone backs another cost already: its money is counted there.",
    });
    costMocks.addDealCost.mockRejectedValue(new DealCostError("not_ready"));
    expect(await run(() => addDealCost(actor(), { draft: costDraft }))).toEqual({ ok: false, code: "not_ready", message: "Costs are not set up on this deployment yet." });
  });
});
