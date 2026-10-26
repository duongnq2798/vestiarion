import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportReadiness, WorkspaceReport } from "@/components/vx/WorkspaceReport";
import { autonomyLadder, type AutonomyLadder, type LadderVerdict } from "@/lib/autonomy-ladder";
import { buildReport, type ReadinessStep, type ReportFacts } from "@/lib/workspace-report";

/**
 * The autonomy ladder's first step on the report (docs/superpowers/specs/2026-10-26-autonomy-ladder-design.md AL1, AL4,
 * AL5, AL7): under Before a live slice, after its steps, how often the owner agreed with the agent by decision and by
 * vendor, the definition said in words, a count behind every figure and no percentage under five verdicts; only in
 * shadow mode, and worked out on the page from the report's own facts (AL6).
 */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const COBALT = { id: "cp-cobalt", name: "Cobalt Cloud", sample: false };
const LUMEN = { id: "cp-lumen", name: "Lumen Print Co.", sample: false };

function verdicts(count: number, agreed: number, action: string, vendor: LadderVerdict["vendor"]): LadderVerdict[] {
  return Array.from({ length: count }, (_, index) => ({ action, verdict: index < agreed ? "agree" : "disagree", vendor }));
}

/** Pay: 5 of 6 agreed, on Cobalt Cloud; Hold: 1 of 2, on Lumen Print Co. */
const LADDER: AutonomyLadder = autonomyLadder([...verdicts(6, 5, "ap_pay", COBALT), ...verdicts(2, 1, "ap_hold", LUMEN)]);

const STEPS: ReadinessStep[] = [
  { key: "verdicts", done: true, given: 8, target: 5 },
  { key: "waiting", done: true, waiting: 0 },
  { key: "addresses", done: false, mirrorPayees: 1 },
  { key: "mainnet", done: null },
];

/** The text of the table row that starts with `label`. */
function row(html: string, label: string): string {
  const rows = [...html.matchAll(/<div role="row"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => text(match[1]).trim());
  return rows.find((line) => line.startsWith(label)) ?? "";
}

describe("the report's agreement by decision and by vendor", () => {
  it("shows both tables after the steps, with a count behind every figure (AL4, AL7)", () => {
    const html = renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} />);
    const words = text(html);
    expect(words).toContain("How often you agreed, by decision and by vendor");
    expect(words).toContain("By decision");
    expect(words).toContain("By vendor");
    expect(words).toContain("Most verdicts first");
    expect(row(html, "Pay")).toMatch(/^Pay · 6 verdicts 6 83% · 5 of 6$/);
    expect(row(html, "Hold")).toMatch(/^Hold · 2 verdicts 2 Too few to tell yet$/);
    expect(row(html, "Cobalt Cloud")).toContain("83% · 5 of 6");
    expect(row(html, "Lumen Print Co.")).toContain("Too few to tell yet");
    // No percentage, and no agreed count to work one out from, under five verdicts.
    expect(row(html, "Hold")).not.toMatch(/%| of /);
    // After the steps, which keep their words, numbering and count.
    expect(words.indexOf("How often you agreed")).toBeGreaterThan(words.indexOf("Open a workspace on Arc mainnet for the slice"));
    expect(words).toContain("Give verdicts on at least 5 decisions");
    expect(words).toContain("2 of 3 done");
  });

  it("says what agreement means here, and which figure it is not (AL1, AL3, AL4)", () => {
    const words = text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} />));
    expect(words).toContain("From your verdicts in shadow mode: each Agree or Disagree you gave on one of the agent's decisions about a real bill, sample data left out.");
    expect(words).toContain("A bill the agent decided twice can carry two verdicts.");
    expect(words).toContain("This is not Agent vs what really happened, below, which compares the agent with what your business paid.");
    expect(words).toContain("Under 5 verdicts, a row says too few to tell yet.");
    expect(words).toContain("It only measures: nothing here changes what the agent may do.");
  });

  it("says so before any verdict on a real bill", () => {
    const words = text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={autonomyLadder([])} />));
    expect(words).toContain("No verdict on a real bill yet. Give one on a decision in Bills & receivables, and it is counted here.");
    expect(words).not.toContain("By vendor");
  });

  it("stacks each row on a phone, and lines the columns up from the small breakpoint (AL7)", () => {
    const html = renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} />);
    expect(html).toContain('role="table" aria-label="By decision"');
    expect(html).toContain('role="table" aria-label="By vendor"');
    // The column headers show from sm up; on a phone each row says its count beside its name instead.
    expect(html).toMatch(/<div role="row" class="hidden [^"]*sm:grid/);
    expect(html).toMatch(/<span class="[^"]*sm:hidden"> · 6 verdicts<\/span>/);
    expect(html).not.toMatch(/min-w-\[/);
  });

  it("shows nothing of it without the ladder, and nothing outside shadow mode (AL7)", () => {
    expect(text(renderToStaticMarkup(<ReportReadiness steps={STEPS} />))).not.toContain("How often you agreed");
    const facts: ReportFacts = {
      network: "arc-testnet",
      sandbox: false,
      now: "2026-10-11T12:00:00.000Z",
      openedAt: "2026-10-01T00:00:00.000Z",
      shadow: null,
      bills: [
        {
          id: "inv-1",
          createdAt: "2026-10-02T10:00:00.000Z",
          dueDate: null,
          amount: 30,
          currency: "USDC",
          status: "held",
          reviewedBy: null,
          paidAmount: null,
          discount: null,
          bill: null,
          payee: { id: "cp-cobalt", name: "Cobalt Cloud", mirror: false, sample: false },
        },
      ],
      decisions: [],
      personActions: [],
      verdicts: [],
      payments: [],
    };
    const html = renderToStaticMarkup(<WorkspaceReport slug="northstar" report={buildReport(facts)} ladder={LADDER} />);
    expect(text(html)).not.toContain("How often you agreed");
  });
});

describe("the report page", () => {
  // A server component the suite does not render: its wiring is read from its source, as
  // tests/shared-report-view.test.tsx reads the share controls'.
  const page = readFileSync(path.join(process.cwd(), "src/app/o/[slug]/report/page.tsx"), "utf8").replace(/\s+/g, " ");

  it("works the ladder out from the report's own facts, only while the readiness steps show (AL6)", () => {
    expect(page).toContain("const ladder = report.readiness ? autonomyLadder(ladderVerdicts(facts)) : null;");
    expect(page).not.toMatch(/from\("decision_verdicts"\)/);
  });

  it("hands it to the report's steps and each vendor's row in the live slice (AL7, AL8)", () => {
    expect(page).toContain("ladder={ladder}");
    expect(page).toContain("agreement={ladder?.byVendor}");
  });
});
