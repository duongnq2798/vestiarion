import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { designRuleReplay } from "@/app/design/replay-fixture";
import { RuleTrialFields, RuleTrialResult } from "@/components/RuleTrial";
import { RULE_TRIAL_COPY } from "@/lib/rule-trial-copy";
import TwoApprovalsPanel from "@/components/TwoApprovalsPanel";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * Try it on past decisions (docs/superpowers/specs/2026-10-10-policy-replay-design.md §2, P8, P10), as server-rendered
 * markup: the result for the sample's decisions, the fields Apply posts back, and the control inside a setting's form.
 * Pressing the button is checked in the browser, on /design.
 */

vi.mock("@/app/actions/policy-replay", () => ({ tryRuleAction: vi.fn() }));
vi.mock("@/app/actions/approval-policy", () => ({ setTwoApprovalsAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("RuleTrialResult", () => {
  const view = designRuleReplay("1500");

  it("shows the change as before and after, and the window", () => {
    const words = text(html(<RuleTrialResult orgSlug="northstar" view={view} />));
    expect(words).toContain("Harbor Office Supply's payment limit");
    expect(words).toContain("In force now: 500.00 USDC");
    expect(words).toContain("Trying: 1,500.00 USDC");
    expect(words).toContain("7 decisions replayed, Sep 10 to Oct 10 (UTC)");
  });

  it("counts each outcome under its name", () => {
    const words = text(html(<RuleTrialResult orgSlug="northstar" view={view} />));
    expect(words).toContain(`${RULE_TRIAL_COPY.unchanged} 6`);
    expect(words).toContain(`${RULE_TRIAL_COPY.nowHeld} 0`);
    expect(words).toContain(`${RULE_TRIAL_COPY.nowPaid} 1`);
    expect(words).toContain(`${RULE_TRIAL_COPY.nowTwoPeople} 0`);
    expect(words).toContain(`${RULE_TRIAL_COPY.cantTell} 0`);
  });

  it("lists each decision that changes with its bill, counterparty, amount, date, rule and ledger entry", () => {
    const markup = html(<RuleTrialResult orgSlug="northstar" view={view} />);
    const words = text(markup);
    expect(words).toContain("Standing desks · Harbor Office Supply");
    expect(words).toContain("1,200.00");
    expect(words).toContain("Oct 3");
    expect(words).toContain("Now: Held: above the payment limit. With this figure: The agent pays it");
    expect(markup).toContain('href="/o/northstar/audit?before=45#seq-44"');
    expect(words).toContain("#0044");
    expect(words).toContain(RULE_TRIAL_COPY.note);
  });

  it("names what a lower figure would hold", () => {
    const lower = designRuleReplay("300");
    expect(lower.counts).toMatchObject({ nowHeld: 1, unchanged: 6 });
    expect(text(html(<RuleTrialResult orgSlug="northstar" view={lower} />))).toContain("Now: The agent pays it. With this figure: Held: above the payment limit");
  });

  it("says when nothing would change, and when there was nothing to replay", () => {
    const quiet = { ...view, counts: { ...view.counts, unchanged: view.counts.decisions, nowPaid: 0 }, rows: [] };
    expect(text(html(<RuleTrialResult orgSlug="northstar" view={quiet} />))).toContain(RULE_TRIAL_COPY.nothing);
    const empty = { ...view, counts: { decisions: 0, unchanged: 0, nowHeld: 0, nowPaid: 0, nowTwoPeople: 0, cantTell: 0 }, rows: [] };
    expect(text(html(<RuleTrialResult orgSlug="northstar" view={empty} />))).toContain(RULE_TRIAL_COPY.none);
  });

  it("says how many more changed than it lists", () => {
    expect(text(html(<RuleTrialResult orgSlug="northstar" view={{ ...view, more: 12 }} />))).toContain("And 12 more, counted above.");
  });
});

describe("RuleTrialFields", () => {
  it("posts back the window and the figure in force when the replay ran, and nothing without a result", () => {
    const markup = html(<RuleTrialFields view={designRuleReplay("1500")} />);
    expect(markup).toContain('<input type="hidden" name="replayDays" value="30"/>');
    expect(markup).toContain('<input type="hidden" name="expectedLimit" value="500"/>');
    expect(html(<RuleTrialFields view={null} />)).toBe("");
  });
});

describe("inside a setting's form", () => {
  it("offers the window and the button beside the two-approvals figure, to an owner", () => {
    const markup = html(<TwoApprovalsPanel orgSlug="northstar" status={{ above: 250, approvers: 3 }} canChange keepsFigure={false} />);
    const words = text(markup);
    expect(words).toContain(RULE_TRIAL_COPY.window);
    expect(words).toContain("Last 30 days");
    expect(words).toContain("Last 90 days");
    expect(words).toContain(RULE_TRIAL_COPY.button);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*aria-pressed="true"[^>]*>Last 30 days<\/button>/);
  });

  it("is not offered to a member who cannot change the setting", () => {
    const words = text(html(<TwoApprovalsPanel orgSlug="northstar" status={{ above: 250, approvers: 3 }} canChange={false} keepsFigure={false} />));
    expect(words).not.toContain(RULE_TRIAL_COPY.button);
  });

  it.each(["src/components/intake/CounterpartyLimitEdit.tsx", "src/components/AgentBudgetPanel.tsx", "src/components/TwoApprovalsPanel.tsx"])(
    "%s offers it inside the form, and applies through the form's own action",
    (file) => {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).toMatch(/useRuleTrial\("(counterparty_limit|spending_limit|two_approvals)"\)/);
      expect(source).toContain("<RuleTrial orgSlug={orgSlug} trial={trial} />");
      expect(source).toContain("RULE_TRIAL_COPY.apply");
      expect(source).toContain("onChange={clear}");
    }
  );
});
