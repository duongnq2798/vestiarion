import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentBudgetPanel, budgetDialogDescription, ON_ARC_COPY, type AgentBudgetView, type OnChainLimitView } from "@/components/AgentBudgetPanel";

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

const render = (props: { view?: AgentBudgetView; canEdit?: boolean; live?: boolean; onChain?: OnChainLimitView | null; network?: "arc-testnet" | "arc-mainnet"; walletTreasury?: boolean }) =>
  renderToStaticMarkup(
    <AgentBudgetPanel
      network={props.network ?? "arc-testnet"}
      orgSlug="testnet-2"
      view={props.view ?? VIEW}
      canEdit={props.canEdit ?? true}
      live={props.live ?? true}
      onChain={props.onChain ?? null}
      walletTreasury={props.walletTreasury}
    />
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
    expect(markup).toContain(`href="https://explorer.testnet.arc.io/address/${CONTRACT}"`);
    expect(markup).toContain(`href="https://explorer.testnet.arc.io/address/${AGENT}"`);
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

describe("the spending limit's dialog on each network (mainnet copy C11)", () => {
  it("lets Arc testnet leave a figure blank, and says Arc mainnet keeps one", () => {
    const rule = "What the agent may pay on its own, in USDC, counted from 00:00 UTC. A payment past either figure is held for a person in Approvals; one a person approves does not count.";
    expect(budgetDialogDescription("arc-testnet")).toBe(`${rule} Leave a figure blank for no limit.`);
    expect(budgetDialogDescription("arc-mainnet")).toBe(`${rule} A workspace on Arc mainnet keeps a daily or 7-day limit.`);
  });
});

describe("the spending limit's On Arc section, only where its contract runs (final review I1, mainnet copy C3)", () => {
  it("offers no contract on Arc mainnet, live or not, and keeps the limit in code", () => {
    for (const live of [true, false]) {
      const markup = text(render({ network: "arc-mainnet", live }));
      expect(markup).not.toContain("Enforce on Arc");
      expect(markup).not.toContain(ON_ARC_COPY.explain);
      expect(markup).not.toContain(ON_ARC_COPY.sandbox);
      expect(markup).toContain("Agent spending limit");
    }
  });

  it("offers it on Arc testnet, as before", () => {
    expect(text(render({ network: "arc-testnet", live: false }))).toContain(ON_ARC_COPY.sandbox);
    expect(text(render({ network: "arc-testnet" }))).toContain(ON_ARC_COPY.explain);
  });
});

describe("the spending limit's On Arc section for a workspace paying from its owner's own wallet (wallet treasury W14)", () => {
  it("shows the wallet's contract and its own count on Arc mainnet, and offers nothing a person here could change", () => {
    const markup = text(render({ network: "arc-mainnet", onChain: ENFORCED, walletTreasury: true }));
    expect(markup).toContain(ON_ARC_COPY.wallet);
    expect(markup).toContain("Paid through it today");
    expect(markup).not.toContain("Turn off on Arc");
    expect(markup).not.toContain("Enforce on Arc");
  });

  it("offers no figures to change once the wallet deployed its contract: only that wallet can change them", () => {
    expect(text(render({ network: "arc-mainnet", onChain: ENFORCED, walletTreasury: true }))).not.toContain("Change limit");
    // Where they change instead (treasury wallet controls C1).
    const markup = render({ network: "arc-mainnet", onChain: ENFORCED, walletTreasury: true });
    expect(markup).toContain('href="/o/testnet-2/settings"');
    expect(text(markup)).toContain("Change them, or stop it, in Settings");
    // Before the contract exists, the figures it will be deployed with can still be set here.
    expect(text(render({ network: "arc-mainnet", onChain: null, walletTreasury: true }))).toContain("Change limit");
  });
});
