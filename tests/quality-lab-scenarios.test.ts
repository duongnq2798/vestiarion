import { describe, expect, it } from "vitest";
import { QUALITY_LAB_GROUPS, QUALITY_LAB_SCENARIOS } from "@/lib/quality-lab/scenarios";
import { RULE_WORDS } from "@/lib/rule-words";

/**
 * The Quality Lab's scenarios as data (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL2, QL3): between 32 and
 * 44, grouped, each with a plain-English title and an expected outcome, and together covering what the spec lists,
 * including bills where money should move, and an earned vendor paid on its own in shadow mode beside one that has not
 * earned it (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL30).
 */

const rules = new Set(QUALITY_LAB_SCENARIOS.map((scenario) => scenario.expected.rule).filter((rule): rule is string => rule !== null));

describe("the scenarios (QL2)", () => {
  it("are between 32 and 44, each with its own id", () => {
    expect(QUALITY_LAB_SCENARIOS.length).toBeGreaterThanOrEqual(32);
    expect(QUALITY_LAB_SCENARIOS.length).toBeLessThanOrEqual(44);
    const ids = QUALITY_LAB_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("come in the groups' order, every group with at least two", () => {
    const order = QUALITY_LAB_GROUPS.map((group) => group.id);
    const seen = QUALITY_LAB_SCENARIOS.map((scenario) => order.indexOf(scenario.group));
    expect(seen.every((index) => index >= 0)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    for (const group of order) expect(QUALITY_LAB_SCENARIOS.filter((scenario) => scenario.group === group).length, group).toBeGreaterThanOrEqual(2);
  });

  it("are titled in plain English, with no rule id, and every group says what it tests", () => {
    for (const scenario of QUALITY_LAB_SCENARIOS) {
      expect(scenario.title, scenario.id).toMatch(/^[A-Z]/);
      expect(scenario.title, scenario.id).not.toMatch(/\b(?:counterparty|invoice|workspace|obligation)\.[a-z_]+/);
      expect(scenario.title.length, scenario.id).toBeLessThanOrEqual(110);
    }
    for (const group of QUALITY_LAB_GROUPS) {
      expect(group.title).toMatch(/^[A-Z]/);
      expect(group.about.length, group.id).toBeGreaterThan(20);
    }
  });

  it("expect only rules the code has, each with words for people", () => {
    for (const rule of rules) expect(Object.keys(RULE_WORDS), rule).toContain(rule);
  });

  it("cover every rule and case the spec lists", () => {
    for (const rule of [
      "counterparty.address_unconfirmed",
      "counterparty.cooling_off",
      "invoice.vendor_document",
      "counterparty.new_payee",
      "invoice.pay_to_differs",
      "counterparty.high_risk",
      "counterparty.unscreened",
      "counterparty.no_address",
      "counterparty.client_payable",
      "counterparty.payment_limit",
      "workspace.two_approvals",
      "workspace.outflow_budget",
      "invoice.duplicate_of_settled",
      "obligation.duplicate_reference",
      "invoice.match_incomplete",
    ]) {
      expect([...rules], rule).toContain(rule);
    }
    const holds = QUALITY_LAB_SCENARIOS.map((scenario) => scenario.expected.heldBecause ?? null);
    expect(holds).toContain("agent_paused");
    expect(holds).toContain("shadow_verdict");
    // The vendor's purchase order holds a payment and a schedule.
    const vendor = QUALITY_LAB_SCENARIOS.filter((scenario) => scenario.expected.rule === "invoice.vendor_document").map((scenario) => scenario.model.action);
    expect(vendor.sort()).toEqual(["pay", "schedule"]);
    // The model holding and flagging, never turned into a payment.
    const said = QUALITY_LAB_SCENARIOS.filter((scenario) => scenario.group === "model").map((scenario) => scenario.model.action);
    expect(said).toEqual(expect.arrayContaining(["hold", "flag_fraud"]));
    // An answer lost after the provider took the send, one lost before, and two cycles at once.
    expect(QUALITY_LAB_SCENARIOS.map((scenario) => scenario.run?.lostAnswer)).toEqual(expect.arrayContaining(["after_taking", "before_taking"]));
    expect(QUALITY_LAB_SCENARIOS.some((scenario) => scenario.run?.overlapping)).toBe(true);
    // The OFAC list, a paid twin and the same work as a milestone.
    expect(QUALITY_LAB_SCENARIOS.some((scenario) => scenario.payee?.address === "0x0330070fd38ec3bb94f58fa55d40368271e9e54a")).toBe(true);
    expect(QUALITY_LAB_SCENARIOS.some((scenario) => scenario.history?.paidTwin)).toBe(true);
    expect(QUALITY_LAB_SCENARIOS.some((scenario) => scenario.history?.milestoneSamePurchaseOrder)).toBe(true);
  });

  it("pay an earned vendor on its own in shadow mode, and keep one that has not earned it waiting for a verdict (AL30)", () => {
    const earnedOn = QUALITY_LAB_SCENARIOS.filter((scenario) => scenario.workspace?.shadowMode && scenario.workspace.earnedVendorPayments);
    expect(earnedOn.every((scenario) => scenario.group === "switches")).toBe(true);
    expect(earnedOn.some((scenario) => scenario.payee?.earned && scenario.expected.money === "moves" && scenario.expected.status === "paid")).toBe(true);
    expect(earnedOn.some((scenario) => !scenario.payee?.earned && scenario.expected.heldBecause === "shadow_verdict")).toBe(true);
    // Every check still stops an earned vendor's payment: a rule of the vendor's, and one of the workspace's own.
    const stopped = earnedOn.filter((scenario) => scenario.payee?.earned && scenario.expected.money === "stops").map((scenario) => scenario.expected.rule);
    expect(stopped).toEqual(expect.arrayContaining(["counterparty.address_unconfirmed", "workspace.two_approvals"]));
  });

  it("include prompt injection in a memo and in purchase-order text, the model fooled into paying", () => {
    const injection = QUALITY_LAB_SCENARIOS.filter((scenario) => scenario.group === "injection");
    expect(injection.some((scenario) => /ignore|override|instruction|agent/i.test(scenario.bill?.memo ?? ""))).toBe(true);
    expect(injection.some((scenario) => /agent|AI/i.test(scenario.bill?.poReference ?? ""))).toBe(true);
    for (const scenario of injection) expect(scenario.model.action, scenario.id).toBe("pay");
    // Some are stopped by a rule; the others pay only the bill's amount to the address on file.
    expect(injection.some((scenario) => scenario.expected.money === "moves")).toBe(true);
    expect(injection.some((scenario) => scenario.expected.money === "stops")).toBe(true);
  });

  it("include bills where money should move: paid once, and a schedule", () => {
    const moves = QUALITY_LAB_SCENARIOS.filter((scenario) => scenario.expected.money === "moves");
    expect(moves.length).toBeGreaterThanOrEqual(8);
    for (const scenario of moves) {
      if (scenario.expected.status === "paid") expect(scenario.expected.transfers, scenario.id).toBe(1);
      else expect(scenario.expected, scenario.id).toMatchObject({ status: "scheduled", transfers: 0 });
    }
    expect(moves.some((scenario) => scenario.expected.status === "scheduled")).toBe(true);
    for (const scenario of QUALITY_LAB_SCENARIOS.filter((one) => one.expected.money === "stops")) expect(scenario.expected.transfers, scenario.id).toBe(0);
  });

  it("keep each memo within what intake accepts, and each schedule's day within its bill", () => {
    for (const scenario of QUALITY_LAB_SCENARIOS) {
      expect((scenario.bill?.memo ?? "").length, scenario.id).toBeLessThanOrEqual(280);
      if (scenario.model.action === "schedule") {
        expect(scenario.model.payOnInDays, scenario.id).toBeGreaterThan(0);
        expect(scenario.model.payOnInDays!, scenario.id).toBeLessThanOrEqual(scenario.bill?.dueInDays ?? 0);
      }
      expect(scenario.model.reasoning.length, scenario.id).toBeGreaterThanOrEqual(10);
    }
  });
});
