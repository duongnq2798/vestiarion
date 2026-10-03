import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { enforceApGuardrails, type ApGuardrailInput } from "@/lib/agent/guardrails";
import { agentResumes, ruleInBrief, ruleNextStep } from "@/lib/next-step";

/**
 * A payable to a client (docs/superpowers/specs/2026-10-03-client-payables-design.md): a client pays the business, so
 * the agent never pays one on its own (R1), and the invoice form takes a client's invoice as a receivable unless a
 * person chooses otherwise, saying what that means (R2).
 */

vi.mock("@/app/actions/intake", () => ({ createInvoiceAction: vi.fn() }));
import InvoiceIntake, { directionNote } from "@/components/intake/InvoiceIntake";

const base: ApGuardrailInput = { action: "pay", reasoning: "Pay it.", amount: 0.5, riskLevel: "clear", paymentLimit: 10, counterpartyRole: "client" };

describe("the AP guardrails and a payable to a client (R1)", () => {
  it("holds a payment, and a schedule, to a client for a person", () => {
    for (const action of ["pay", "schedule"] as const) {
      const result = enforceApGuardrails({ ...base, action });
      expect(result, action).toMatchObject({ blocked: true, status: "held", rule: "counterparty.client_payable" });
      expect(result.reasoning).toContain("the counterparty is a client, which pays this business");
    }
  });

  it("lets a duplicate and a screening verdict speak first, and comes before the limit and the address", () => {
    expect(enforceApGuardrails({ ...base, riskLevel: "high" }).rule).toBe("counterparty.high_risk");
    expect(enforceApGuardrails({ ...base, riskLevel: "unscreened" }).rule).toBe("counterparty.unscreened");
    expect(enforceApGuardrails({ ...base, amount: 50 }).rule).toBe("counterparty.client_payable");
  });

  it("does not touch a vendor or a contractor, nor a decision to hold", () => {
    expect(enforceApGuardrails({ ...base, counterpartyRole: "vendor" }).blocked).toBe(false);
    expect(enforceApGuardrails({ ...base, counterpartyRole: "contractor" }).blocked).toBe(false);
    expect(enforceApGuardrails({ ...base, counterpartyRole: undefined }).blocked).toBe(false);
    expect(enforceApGuardrails({ ...base, action: "hold" }).blocked).toBe(false);
  });

  it("reads the counterparty's role, and hands it to the guardrails", () => {
    const orchestrator = readFileSync(path.join(process.cwd(), "src/lib/agent/orchestrator.ts"), "utf8");
    expect(orchestrator).toContain(".select(\"*, counterparties(id, name, role, risk_level,");
    expect(orchestrator).toContain("counterpartyRole: counterparty.role ?? null,");
  });
});

describe("what a person is told", () => {
  const client = { id: "cp-ho", name: "Ho Client" };

  it("says the client pays you, and how a refund or a mistake goes, with no agent resuming it", () => {
    expect(ruleNextStep("counterparty.client_payable", client)).toEqual({
      sentence: "Ho Client is a client: it pays you. If this is a refund, pay it in Approvals; if it is money Ho Client owes you, reject it and add it as a receivable.",
      fix: null,
    });
    expect(ruleInBrief("counterparty.client_payable")).toBe("the counterparty is a client, which pays you");
    expect(agentResumes("counterparty.client_payable")).toBeNull();
  });
});

describe("the invoice form (R2)", () => {
  const COUNTERPARTIES = [
    { id: "cp-north", name: "Northstar Studio", role: "vendor" },
    { id: "cp-ho", name: "Ho Client", role: "client" },
  ];

  it("says what the direction means, and warns of a payable to a client", () => {
    expect(directionNote("payable", undefined)).toBeUndefined();
    expect(directionNote("payable", COUNTERPARTIES[0])).toBe("Money you owe Northstar Studio.");
    expect(directionNote("receivable", COUNTERPARTIES[1])).toBe("Money Ho Client owes you.");
    expect(directionNote("payable", COUNTERPARTIES[1])).toBe("Ho Client is a client: it pays you. The agent never pays a client on its own; a payable to one waits for a person.");
  });

  it("starts a client's invoice as a receivable", () => {
    const client = renderToStaticMarkup(<InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} initial={{ counterpartyId: "cp-ho" }} />);
    expect(client).toContain("Money Ho Client owes you.");
    const vendor = renderToStaticMarkup(<InvoiceIntake orgSlug="acme" counterparties={COUNTERPARTIES} initial={{ counterpartyId: "cp-north" }} />);
    expect(vendor).toContain("Money you owe Northstar Studio.");
  });
});
