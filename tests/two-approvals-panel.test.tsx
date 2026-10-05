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

vi.mock("@/app/actions/approval-policy", () => ({ setTwoApprovalsAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
const panel = (above: number | null, options: { approvers?: number; canChange?: boolean } = {}) =>
  html(<TwoApprovalsPanel orgSlug="northstar" status={{ above, approvers: options.approvers ?? 3 }} canChange={options.canChange ?? true} />);

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
  });

  it("says the figure when it is on, and offers an owner to change it or turn it off", () => {
    const markup = panel(250);
    expect(text(markup)).toContain("Payments above 250 USDC need two approvals.");
    expect(markup).toMatch(/<input[^>]*name="above"[^>]*value="250"/);
    expect(text(markup)).toContain("Save");
    expect(text(markup)).toContain("Turn off");
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
