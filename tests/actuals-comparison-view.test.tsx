import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActualsComparison, daysApart, entryHref } from "@/components/vx/ActualsComparison";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { compareActuals, type ActualRecord } from "@/lib/actual-payments-compare";
import { txUrl } from "@/lib/payee-chains";
import type { ReportFacts } from "@/lib/workspace-report";

/**
 * The report's "Agent vs what really happened" (docs/superpowers/specs/2026-10-10-actual-payments-design.md A5, A7, A8):
 * each bill's two sides, the flags, "Not recorded" where nothing is recorded, every figure linked to its source, the
 * controls only for someone who may record, and a plain message before migration 0090 runs.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/actual-payments", () => ({ recordActualPaymentAction: vi.fn(), previewActualsCsvAction: vi.fn(), importActualsCsvAction: vi.fn() }));

const TX = `0x${"d".repeat(64)}`;
const OWNER = "a1b2c3d4-0000-4000-8000-0000000000b1";

const facts = (over: Partial<ReportFacts> = {}): ReportFacts => ({
  network: "arc-testnet",
  sandbox: false,
  openedAt: "2026-10-01T00:00:00.000Z",
  shadow: { currency: "EUR", startedAt: "2026-10-01T00:00:00.000Z" },
  bills: [
    {
      id: "inv-paid",
      createdAt: "2026-10-02T09:00:00.000Z",
      dueDate: "2026-10-10T00:00:00.000Z",
      amount: 115.25,
      currency: "USDC",
      status: "paid",
      reviewedBy: null,
      paidAmount: 115.25,
      discount: null,
      bill: { amount: 100, currency: "EUR" },
      payee: { id: "cp-1", name: "Hetzner", mirror: true, sample: false },
    },
    {
      id: "inv-held",
      createdAt: "2026-10-02T09:00:00.000Z",
      dueDate: "2026-10-12T00:00:00.000Z",
      amount: 40,
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
    { seq: 21, ts: "2026-10-02T10:00:00.000Z", action: "ap_pay", invoiceId: "inv-paid", guardrailBlocked: false, guardrailRule: null, heldBecause: "shadow_verdict", resultingStatus: "held", shadow: true, reasoning: "Pay." },
    { seq: 22, ts: "2026-10-03T10:00:00.000Z", action: "ap_hold", invoiceId: "inv-held", guardrailBlocked: false, guardrailRule: null, heldBecause: null, resultingStatus: "held", shadow: true, reasoning: "The amount is twice the usual." },
  ],
  personActions: [],
  verdicts: [{ entrySeq: 21, verdict: "agree" }],
  payments: [{ invoiceId: "inv-paid", amount: 115.25, token: "USDC", txHash: TX, at: "2026-10-03T12:00:00.000Z", simulated: false }],
  ...over,
});

const record: ActualRecord = {
  id: "rec-1",
  invoiceId: "inv-paid",
  outcome: "paid",
  paidOn: "2026-10-05",
  amount: 100,
  currency: "EUR",
  method: "bank_transfer",
  reference: "SEPA-77",
  note: null,
  reason: null,
  replaces: null,
  source: "form",
  recordedBy: OWNER,
  recordedAt: "2026-10-06T08:00:00.000Z",
};

const comparison = (input: ReportFacts = facts(), records: ActualRecord[] = [record]) =>
  compareActuals(input, { records, entries: new Map([["rec-1", 41]]), verdictEntries: new Map([[21, 33]]) });

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").trim();
const render = (over: Partial<Parameters<typeof ActualsComparison>[0]> = {}) =>
  html(<ActualsComparison slug="northstar" comparison={comparison()} canRecord={false} members={{ [OWNER]: "owner@northstar.example" }} templateCsv={null} showAll={false} {...over} />);

describe("ActualsComparison", () => {
  it("lays each bill's agent side next to what the business recorded, and says Not recorded where nothing is", () => {
    const words = text(render());
    expect(words).toContain("Agent vs what really happened");
    expect(words).toContain("The agent, on Arc testnet");
    expect(words).toContain("Your business");
    expect(words).toContain("Paid on Arc testnet on Oct 3, 2026");
    expect(words).toContain("Paid on Oct 5, 2026: 100.00 EUR by bank transfer · Ref SEPA-77");
    expect(words).toContain("Recorded by owner@northstar.example on Oct 6, 2026");
    expect(words).toContain("The agent decided 3 days before your business paid.");
    expect(words).toContain("Your verdict: agreed");
    expect(words).toContain("Held it on Oct 3, 2026. The agent's call: The amount is twice the usual.");
    expect(words).toContain("Not recorded");
    expect(words).toContain("A payment on Arc testnet is the agent's, never your bank's.");
  });

  it("links each figure to its source: the decision, the verdict and the record to their entries, the payment to its transaction", () => {
    const markup = render();
    expect(markup).toContain(`href="${entryHref("northstar", 21)}"`);
    expect(entryHref("northstar", 21)).toBe("/o/northstar/audit?before=22#seq-21");
    expect(markup).toContain(`href="${entryHref("northstar", 33)}"`);
    expect(markup).toContain(`href="${entryHref("northstar", 41)}"`);
    expect(markup).toContain(txUrl("arc-testnet", TX));
  });

  it("totals the comparison: bills compared, not recorded yet, agreement and the median days", () => {
    const words = text(render());
    expect(words).toContain("Bills compared 1 1 not recorded yet");
    expect(words).toContain("Agent and business agreed 1 of 1");
    expect(words).toContain("Days apart 3 days earlier");
    expect(daysApart(-1)).toBe("1 day later");
    expect(daysApart(0)).toBe("Same day");
    expect(daysApart(null)).toBe("—");
  });

  it("marks what is worth a look", () => {
    const words = text(render({ comparison: comparison(facts(), [record, { ...record, id: "rec-2", invoiceId: "inv-held", amount: 40, currency: "USDC" }]) }));
    expect(words).toContain("Held by the agent, paid by your business");
    expect(words).toContain("Worth a look 1");
  });

  it("offers recording and the CSV only to someone who may record", () => {
    const viewer = text(render());
    expect(viewer).not.toContain("Record what you paid");
    expect(viewer).toContain("An owner or admin of this workspace records what your business paid.");
    const owner = render({ canRecord: true, templateCsv: "invoice,payee\ninv-held,Contabo" });
    expect(text(owner)).toContain("Record what you paid");
    expect(text(owner)).toContain("Correct");
    expect(text(owner)).toContain("Import what your business paid from a CSV");
    expect(text(owner)).toContain("Download the bills not recorded yet");
    expect(owner).toContain('download="bills-not-recorded.csv"');
  });

  it("says simulated in a sandbox, with no transaction", () => {
    const sandbox = facts({ sandbox: true, payments: [{ invoiceId: "inv-paid", amount: 115.25, token: "USDC", txHash: null, at: "2026-10-03T12:00:00.000Z", simulated: true }] });
    const markup = render({ comparison: comparison(sandbox) });
    expect(text(markup)).toContain("Sandbox: the agent's payments here are simulated.");
    expect(text(markup)).toContain("Simulated payment on Oct 3, 2026");
    expect(markup).not.toContain("/tx/");
  });

  it("says plainly that recording is not set up before migration 0090 runs", () => {
    const words = text(render({ comparison: null, canRecord: true }));
    expect(words).toContain("Recording what your business paid is not set up on this deployment yet.");
    expect(words).not.toContain("Record what you paid");
  });
});
