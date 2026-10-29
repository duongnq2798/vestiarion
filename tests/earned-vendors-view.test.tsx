import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { autonomyLadder } from "@/lib/autonomy-ladder";
import { earnedVendors, type EarnedFacts, type EarnedVendorsView } from "@/lib/earned-vendors";
import { buildReport, type ReadinessStep, type ReportFacts } from "@/lib/workspace-report";

/**
 * Earned vendors where people read them (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL18-AL20): the
 * report's block under How often you agreed, only in shadow mode, earned only once it is also signed, with the verdicts
 * behind it; and the live slice picker's mark, which ticks nothing. The ladder's own rows are unchanged; once a rule is
 * set, its sentence points to Earned vendors, which says what earning changes (step 3, AL28).
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/live-slice", () => ({ startLiveSliceAction: vi.fn() }));

const { ReportReadiness, WorkspaceReport } = await import("@/components/vx/WorkspaceReport");
const { LiveSliceStart } = await import("@/components/vx/LiveSliceStart");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const STEPS: ReadinessStep[] = [
  { key: "verdicts", done: true, given: 8, target: 5 },
  { key: "waiting", done: true, waiting: 0 },
  { key: "addresses", done: true, mirrorPayees: 0 },
  { key: "mainnet", done: null },
];

const at = (day: number) => new Date(Date.parse("2026-10-19T09:00:00.000Z") + day * 86_400_000).toISOString();

/** Cobalt: five agreed payments of 400 USDC, Oct 20-24. Lumen: one agreed, then a Disagree on Oct 26. Taller: no limit. */
function facts(): EarnedFacts {
  const payee = (id: string, name: string, paymentLimit: number | null = 500) => ({ id, name, sample: false, role: "vendor", paymentLimit });
  const bills: Array<EarnedFacts["bills"][number]> = [];
  const decisions: Array<EarnedFacts["decisions"][number]> = [];
  const verdicts: Array<EarnedFacts["verdicts"][number]> = [];
  const add = (seq: number, day: number, who: ReturnType<typeof payee>, verdict: "agree" | "disagree", action = "ap_pay") => {
    bills.push({ id: `inv-${seq}`, amount: 400, currency: "USDC", payee: who });
    decisions.push({ seq, ts: at(day), action, invoiceId: `inv-${seq}`, guardrailBlocked: false, guardrailRule: null, resultingStatus: "held" });
    verdicts.push({ entrySeq: seq, verdict, decidedAt: at(day) });
  };
  const cobalt = payee("cp-cobalt", "Cobalt Cloud");
  [1, 2, 3, 4, 5].forEach((day, index) => add(10 + index, day, cobalt, "agree", index === 4 ? "ap_schedule" : "ap_pay"));
  add(20, 6, payee("cp-lumen", "Lumen Print Co."), "agree");
  add(21, 7, payee("cp-lumen", "Lumen Print Co."), "disagree", "ap_hold");
  add(22, 7, payee("cp-taller", "Taller Norte", null), "agree");
  return { bills, decisions, verdicts };
}

const view = (recorded: string[] = ["cp-cobalt"]): EarnedVendorsView => ({ streak: 5, statuses: earnedVendors(facts(), 5), recorded: new Set(recorded) });
const LADDER = autonomyLadder([]);

describe("the report's Earned vendors (AL18)", () => {
  it("says the rule, then each vendor's status, earned only once signed, after How often you agreed", () => {
    const html = renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} earned={view()} />);
    const words = text(html);
    expect(words).toContain(
      "Under your rule: 5 agreed verdicts in a row on a vendor's payments. A disagreement, a bill flagged for review, or a check in code stopping one of its bills starts the count again. Earning changes nothing the agent may do unless an owner lets it pay earned vendors on its own, in Settings."
    );
    expect(words).toContain("Cobalt Cloud Earned: 5 agreed in a row, Oct 20, 2026 to Oct 24, 2026");
    expect(words).toContain("Lumen Print Co. 0 of 5 agreed in a row since you disagreed on Oct 26, 2026");
    expect(words).toContain("Taller Norte Cannot earn it: no payment limit. Set one on Counterparties.");
    expect(words).toContain("Each change is signed in the ledger as vendor_earned or vendor_earned_lost.");
    expect(html).toContain('id="report-earned"');
    expect(words.indexOf("Earned vendors")).toBeGreaterThan(words.indexOf("How often you agreed, by decision and by vendor"));
    // The ladder only measures; under a rule it points to what earning changes (AL28).
    expect(words).toContain("It only measures. What earning changes is under Earned vendors.");
  });

  it("lists the verdicts behind an earned vendor: each decision's day, kind, amount and Agreed", () => {
    const words = text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} earned={view()} />));
    expect(words).toContain("The verdicts behind it");
    expect(words).toContain("Oct 24, 2026 · Schedule · 400.00 USDC · Agreed");
    expect(words).toContain("Oct 20, 2026 · Pay · 400.00 USDC · Agreed");
    expect(words.indexOf("Oct 24, 2026 · Schedule")).toBeLessThan(words.indexOf("Oct 20, 2026 · Pay"));
  });

  it("says a vendor earned now and not signed yet is recorded at the next verdict or decision, with no verdicts listed as its evidence", () => {
    const words = text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} earned={view([])} />));
    expect(words).toContain("Cobalt Cloud Earned under your rule. It is recorded at your next verdict, or when the agent next decides a bill.");
    expect(words).not.toContain("The verdicts behind it");
  });

  it("says where the rule is set when there is none", () => {
    const words = text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} earned={{ streak: null, statuses: [], recorded: new Set() }} />));
    expect(words).toContain("Earned vendors");
    expect(words).toContain("No rule is set. An owner sets one in Settings, under Earned vendors.");
    expect(words).not.toContain("Under your rule");
  });

  it("shows nothing of it without the view, and nothing outside shadow mode", () => {
    expect(text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} />))).not.toContain("Earned vendors");
    const outside: ReportFacts = {
      network: "arc-testnet",
      sandbox: false,
      now: "2026-10-28T12:00:00.000Z",
      openedAt: "2026-10-01T00:00:00.000Z",
      shadow: null,
      bills: [
        { id: "inv-1", createdAt: "2026-10-02T10:00:00.000Z", dueDate: null, amount: 30, currency: "USDC", status: "held", reviewedBy: null, paidAmount: null, discount: null, bill: null, payee: { id: "cp-cobalt", name: "Cobalt Cloud", mirror: false, sample: false } },
      ],
      decisions: [],
      personActions: [],
      verdicts: [],
      payments: [],
    };
    expect(text(renderToStaticMarkup(<WorkspaceReport slug="northstar" report={buildReport(outside)} ladder={LADDER} earned={view()} />))).not.toContain("Earned vendors");
  });
});

describe("the live slice picker's mark (AL19)", () => {
  const vendors = [
    { id: "cp-cobalt", name: "Cobalt Cloud", address: "own" as const, paymentLimit: 200 },
    { id: "cp-lumen", name: "Lumen Print Co.", address: "mirror" as const, paymentLimit: 50 },
  ];

  it("marks a vendor earned under the owner's rule, says what the mark means, and ticks nothing", () => {
    const html = renderToStaticMarkup(<LiveSliceStart orgSlug="acme-shadow" vendors={vendors} canStart agreement={[]} earned={new Set(["cp-cobalt"])} />);
    const words = text(html);
    expect(words).toContain("Earned under your rule marks a vendor that met the rule an owner set in Settings.");
    expect(words).toContain("Cobalt Cloud Limit 200 USDC Its own address, confirmed again there No verdicts yet Earned under your rule");
    expect(words).not.toMatch(/Lumen Print Co\.[^]*Earned under your rule/);
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toMatch(/aria-checked="true"|data-state="checked"|\schecked[\s=>]/);
  });

  it("says nothing of it where no rule is set", () => {
    const words = text(renderToStaticMarkup(<LiveSliceStart orgSlug="acme-shadow" vendors={vendors} canStart agreement={[]} />));
    expect(words).not.toContain("Earned under your rule");
  });
});

describe("the report page", () => {
  // A server component the suite does not render: its wiring is read from its source, as the ladder's test reads it.
  const page = readFileSync(path.join(process.cwd(), "src/app/o/[slug]/report/page.tsx"), "utf8").replace(/\s+/g, " ");

  it("works the statuses out from the report's own facts, reading the rule and the record best effort, only in shadow mode (AL14, AL18)", () => {
    expect(page).toContain("const earned = report.readiness ? await readEarnedView(db(), facts).catch(");
    expect(page).toContain("earned={earned}");
    expect(page).not.toMatch(/from\("decision_verdicts"\)/);
  });

  it("hands the picker only vendors earned and signed, and nothing where no rule is set (AL19)", () => {
    expect(page).toContain("earned={earned && earned.streak !== null ? shownEarned(earned) : undefined}");
  });
});
