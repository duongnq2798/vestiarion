import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentBudgetPanel, ON_ARC_COPY, type AgentBudgetView, type OnChainLimitView } from "@/components/AgentBudgetPanel";

/**
 * The console's spending limit panel with its "On Arc" part (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md
 * §4, R14), as the markup it renders on the server: what it offers in a sandbox, in a live workspace with and without a
 * figure, while it is being set up, and once it is enforced, with the contract's own count.
 */

vi.mock("@/app/actions/agent", () => ({
  setAgentBudgetAction: vi.fn(),
  enforceSpendingLimitAction: vi.fn(),
  turnOffSpendingLimitAction: vi.fn(),
}));

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const VIEW: AgentBudgetView = { dailyUsdc: 5, weeklyUsdc: 20, spentToday: 1.2, spentThisWeek: 3, remaining: 3.8 };
const NONE: AgentBudgetView = { dailyUsdc: null, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0, remaining: null };
const CONTRACT = "0x11a1700000000000000000000000000000001111";
const AGENT = "0xA9e7000000000000000000000000000000000A9e";
const ENFORCED: OnChainLimitView = {
  state: "enforced",
  contract: CONTRACT,
  agent: AGENT,
  reading: { dailyUsdc: 5, weeklyUsdc: 20, spentToday: 1.2, spentThisWeek: 3 },
};

const render = (props: { view?: AgentBudgetView; canEdit?: boolean; live?: boolean; onChain?: OnChainLimitView | null }) =>
  renderToStaticMarkup(
    <AgentBudgetPanel orgSlug="testnet-2" view={props.view ?? VIEW} canEdit={props.canEdit ?? true} live={props.live ?? true} onChain={props.onChain ?? null} />
  );

describe("the spending limit panel, on Arc", () => {
  it("offers to enforce the limit on Arc in a live workspace with a figure, to someone who may change it", () => {
    const markup = render({});
    expect(text(markup)).toContain(ON_ARC_COPY.explain);
    expect(text(markup)).toContain("Enforce on Arc");
    expect(markup).toContain('name="orgSlug" value="testnet-2"');
  });

  it("asks for a figure first, and offers nothing to someone who may not change it", () => {
    expect(text(render({ view: NONE }))).toContain(ON_ARC_COPY.needsFigure);
    expect(text(render({ view: NONE }))).not.toContain("Enforce on Arc");
    expect(text(render({ canEdit: false }))).not.toContain("Enforce on Arc");
  });

  it("says a sandbox cannot, and offers nothing there", () => {
    const markup = text(render({ live: false }));
    expect(markup).toContain(ON_ARC_COPY.sandbox);
    expect(markup).not.toContain("Enforce on Arc");
  });

  it("offers to finish a setup that was interrupted", () => {
    expect(text(render({ onChain: { state: "unfinished", contract: null, agent: null, reading: null } }))).toContain("Finish enforcing on Arc");
  });

  it("shows the contract, the agent's wallet and the contract's own count once enforced, with a way to turn it off", () => {
    const markup = render({ onChain: ENFORCED });
    expect(text(markup)).toContain(ON_ARC_COPY.enforced);
    expect(markup).toContain(`href="https://testnet.arcscan.app/address/${CONTRACT}"`);
    expect(markup).toContain(`href="https://testnet.arcscan.app/address/${AGENT}"`);
    expect(text(markup)).toContain("Paid through it today 1.20 of");
    expect(text(markup)).toContain("Turn off on Arc");
    expect(text(markup)).not.toContain("Enforce on Arc");
  });

  it("says when the contract's figures could not be read, rather than showing the code's", () => {
    const markup = text(render({ onChain: { ...ENFORCED, reading: null } }));
    expect(markup).toContain(ON_ARC_COPY.unreadable);
    expect(markup).not.toContain("Paid through it today");
  });

  it("offers to enforce it again once turned off", () => {
    expect(text(render({ onChain: { ...ENFORCED, state: "off" } }))).toContain("Enforce on Arc");
  });
});
