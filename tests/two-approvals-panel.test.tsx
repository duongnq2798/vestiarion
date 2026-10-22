import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import TwoApprovalsPanel from "@/components/TwoApprovalsPanel";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * The "Two approvals" section of Settings (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1, T8), as
 * server-rendered markup (the tests/ledger-key-panel.test.tsx shape). Its confirmation opens in a portal, which a static
 * render leaves closed, so the dialog's own words are checked against the component's source.
 */

// Try it on past decisions, inside the setting's form (policy replay §2): a server action, as the form's own.
vi.mock("@/app/actions/policy-replay", () => ({ tryRuleAction: vi.fn() }));
vi.mock("@/app/actions/approval-policy", () => ({ setTwoApprovalsAction: vi.fn(), setAccountantCosignAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
const panel = (above: number | null, options: { approvers?: number; canChange?: boolean; keepsFigure?: boolean } = {}) =>
  html(
    <TwoApprovalsPanel
      orgSlug="northstar"
      status={{ above, approvers: options.approvers ?? 3 }}
      canChange={options.canChange ?? true}
      keepsFigure={options.keepsFigure ?? false}
    />
  );

describe("Accountants co-sign (accountant co-sign CS1, CS8)", () => {
  const cosign = (on: boolean, options: { canChange?: boolean; cosigners?: number; ready?: boolean } = {}) =>
    text(
      html(
        <TwoApprovalsPanel
          orgSlug="northstar"
          status={{ above: 500, approvers: 1 + (options.cosigners ?? 0), cosigners: options.cosigners ?? 0, cosign: { on, ready: options.ready ?? true } }}
          canChange={options.canChange ?? true}
          keepsFigure={false}
        />
      )
    );

  it("says what co-signing lets an accountant do and never do, and offers the owner to turn it on", () => {
    const words = cosign(false);
    expect(words).toContain("Accountants co-sign: off.");
    expect(words).toContain(
      "With it on, an accountant gives one of the two approvals of a bill above the figure, and confirms changed addresses on Counterparties. A co-sign sends nothing: an owner's, admin's or approver's Approve and pay pays it. Contractors' milestones are not co-signed."
    );
    expect(words).toContain("Let accountants co-sign");
  });

  it("counts the co-signing accountants among who can approve, and offers to turn it off", () => {
    const words = cosign(true, { cosigners: 1 });
    expect(words).toContain("Accountants co-sign: on.");
    expect(words).toContain("2 people can approve payments here, 1 of them an accountant who co-signs bills.");
    expect(words).toContain("Turn off co-signing");
  });

  it("leaves the switch to an owner, and the section out before migration 0138", () => {
    expect(cosign(false, { canChange: false })).not.toContain("Let accountants co-sign");
    expect(cosign(false, { ready: false })).not.toContain("Accountants co-sign");
  });
});

describe("TwoApprovalsPanel", () => {
  it("is a section titled Two approvals", () => {
    const markup = panel(null);
    expect(markup).toMatch(/<section[^>]*aria-labelledby="two-approvals-title"/);
    expect(markup).toMatch(/<h2 id="two-approvals-title"[^>]*>Two approvals<\/h2>/);
  });

  it("says it is off, and what turning it on does", () => {
    const words = text(panel(null));
    expect(words).toContain("Off: one approval pays any payment.");
    expect(words).toContain(
      "Above the figure, the agent never pays on its own and no one person pays alone: a first approval is recorded, and a second person's approval pays it."
    );
    expect(words).toContain("3 people can approve payments here.");
    expect(words).toContain(
      "As many of the two as can come from people who neither entered the payment nor gave a new payee's address must; those two give the rest only when no one else can."
    );
  });

  it("says the figure when it is on, and offers an owner to change it or turn it off", () => {
    const markup = panel(250);
    expect(text(markup)).toContain("Payments above 250 USDC need two approvals.");
    expect(markup).toMatch(/<input[^>]*name="above"[^>]*value="250"/);
    expect(text(markup)).toContain("Save");
    expect(text(markup)).toContain("Turn off");
  });

  it("offers no Turn off on Arc mainnet, says the figure stays, and still lets an owner raise it (mainnet copy C11)", () => {
    const markup = text(panel(100, { keepsFigure: true }));
    expect(markup).not.toContain("Turn off");
    expect(markup).toContain("A workspace on Arc mainnet keeps two approvals above a figure. Raise it to let one person pay more.");
    expect(markup).toContain("Save");
  });

  it("offers an owner no Turn off while it is off", () => {
    expect(text(panel(null))).not.toContain("Turn off");
  });

  it("says one person can approve, in the singular", () => {
    expect(text(panel(null, { approvers: 1 }))).toContain("1 person can approve payments here.");
  });

  it("shows anyone else what it is, and who can change it, with no form", () => {
    const markup = panel(250, { canChange: false });
    expect(markup).not.toMatch(/<input[^>]*name="above"/);
    expect(text(markup)).toContain("An owner of this workspace can change it.");
  });

  it("asks before turning it off, saying what that frees", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "components", "TwoApprovalsPanel.tsx"), "utf8");
    expect(source).toContain('title="Turn off two approvals?"');
    expect(source).toContain("One approval will pay any payment again, and the agent will pay on its own within its other limits.");
  });
});
