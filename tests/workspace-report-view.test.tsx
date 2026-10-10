import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { minutesInWords, WorkspaceReport } from "@/components/vx/WorkspaceReport";
import { txUrl } from "@/lib/payee-chains";
import { buildReport, type ReportFacts } from "@/lib/workspace-report";

/**
 * The workspace report's view (docs/superpowers/specs/2026-10-09-workspace-report-design.md): every figure says what it
 * is, a mirror is marked, each payment links to its transaction on its own network's explorer, and the live-slice
 * suggestions show only in shadow mode.
 */

const TX = `0x${"c".repeat(64)}`;

function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return {
    network: "arc-testnet",
    sandbox: false,
    openedAt: "2026-10-01T00:00:00.000Z",
    shadow: null,
    bills: [
      {
        id: "inv-1",
        createdAt: "2026-10-02T10:00:00.000Z",
        dueDate: "2026-10-10T00:00:00.000Z",
        amount: 196,
        currency: "USDC",
        status: "paid",
        reviewedBy: null,
        paidAmount: 192.08,
        discount: { pct: 2, deadline: "2026-10-05T00:00:00.000Z" },
        bill: { amount: 200, currency: "USD" },
        payee: { id: "cp-1", name: "Hetzner", mirror: false, sample: false },
      },
      {
        id: "inv-2",
        createdAt: "2026-10-02T10:00:00.000Z",
        dueDate: "2026-10-10T00:00:00.000Z",
        amount: 30,
        currency: "USDC",
        status: "held",
        reviewedBy: null,
        paidAmount: null,
        discount: null,
        bill: null,
        payee: { id: "cp-2", name: "Contabo", mirror: false, sample: false },
      },
    ],
    decisions: [
      { seq: 1, ts: "2026-10-02T10:01:00.000Z", action: "ap_pay", invoiceId: "inv-1", guardrailBlocked: false, guardrailRule: null, heldBecause: null, resultingStatus: "paid", shadow: false, reasoning: "Pay." },
      { seq: 2, ts: "2026-10-02T10:02:00.000Z", action: "ap_hold", invoiceId: "inv-2", guardrailBlocked: true, guardrailRule: "invoice.match_incomplete", heldBecause: null, resultingStatus: "held", shadow: false, reasoning: null },
    ],
    personActions: [],
    verdicts: [],
    payments: [{ invoiceId: "inv-1", amount: 192.08, token: "USDC", txHash: TX, at: "2026-10-02T10:03:00.000Z", simulated: false }],
    ...over,
  };
}

const render = (input: ReportFacts) => renderToStaticMarkup(<WorkspaceReport slug="northstar" report={buildReport(input)} />);

describe("WorkspaceReport", () => {
  it("names the network and its money, the figures, and links a payment to its transaction", () => {
    const html = render(facts());
    expect(html).toContain("Payments on Arc testnet, in test USDC.");
    expect(html).toContain("Bills handled");
    expect(html).toContain("Code refused it: its three-way match is incomplete.");
    expect(html).toContain(txUrl("arc-testnet", TX));
    expect(html).toContain("Bill: 200.00 USD");
    expect(html).toContain("/o/northstar/audit");
    expect(html).not.toContain("Before a live slice");
    expect(html).not.toContain("Mirror");
  });

  it("says real USDC on Arc mainnet", () => {
    expect(render(facts({ network: "arc-mainnet" }))).toContain("Payments on Arc mainnet, in real USDC.");
  });

  it("marks mirrors and lists the live-slice suggestions in shadow mode", () => {
    const html = render(facts({ shadow: { currency: "USD", startedAt: "2026-10-01T00:00:00.000Z" } }));
    expect(html).toContain("Shadow mode since");
    expect(html).toContain("In shadow mode, every payment waits for your verdict");
    expect(html).toContain("Mirror");
    expect(html).toContain("Before a live slice");
    expect(html).toContain("Open a workspace on Arc mainnet for the slice");
    expect(html).toContain('href="/docs/guides/shadow-mode#before-a-live-slice"');
  });

  it("measures the discount captured from the transfer, beside the one on offer from the terms", () => {
    const html = render(facts());
    expect(html).toContain("3.92 USDC");
    expect(html).toContain("On offer: 3.92 USDC on 1 bill, from their terms");
  });

  it("says a sandbox's payments are simulated, marks each one, and links none", () => {
    const html = render(facts({ sandbox: true, payments: [{ invoiceId: "inv-1", amount: 192.08, token: "USDC", txHash: "sim_key", at: "2026-10-02T10:03:00.000Z", simulated: true }] }));
    expect(html).toContain("Sandbox: payments here are simulated.");
    expect(html).toContain("Paid (simulated)");
    expect(html).toContain("Simulated");
    expect(html).not.toContain("/tx/");
  });

  it("says when the figures count the sample data", () => {
    const sample = facts({
      sandbox: true,
      payments: [],
      bills: facts().bills.map((bill) => ({ ...bill, payee: { ...bill.payee, sample: true } })),
    });
    const html = render(sample);
    expect(html).toContain("This workspace has no real bill yet, so the report counts its sample data.");
  });

  it("points a workspace with no real bill to Bills & receivables", () => {
    const html = render(facts({ bills: [], decisions: [], payments: [] }));
    expect(html).toContain("No real bills yet");
    expect(html).toContain("/o/northstar/invoices");
    expect(html).toContain("Open Bills &amp; receivables");
  });
});

describe("minutesInWords", () => {
  it.each([
    [0.4, "under a minute"],
    [1.2, "1 min"],
    [89, "89 min"],
    [150, "2.5 h"],
  ])("says %s minutes as %s", (minutes, words) => {
    expect(minutesInWords(minutes)).toBe(words);
  });
});
