import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ShadowModePanel from "@/components/ShadowModePanel";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * The "Shadow mode" section of Settings (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1), as server-rendered
 * markup. Its confirmation opens in a portal, which a static render leaves closed, so the dialog's own words are checked
 * against the component's source.
 */

vi.mock("@/app/actions/shadow-mode", () => ({ setShadowModeAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
const ON = { currency: "VND", startedAt: "2026-10-07T12:00:00Z", startedBy: "owner-1" };
const panel = (mode: typeof ON | null, options: { canChange?: boolean; network?: "arc-testnet" | "arc-mainnet" } = {}) =>
  html(<ShadowModePanel orgSlug="northstar" mode={mode} network={options.network ?? "arc-testnet"} canChange={options.canChange ?? true} />);

describe("ShadowModePanel", () => {
  it("is a section titled Shadow mode", () => {
    const markup = panel(null);
    expect(markup).toMatch(/<section[^>]*aria-labelledby="shadow-mode-title"/);
    expect(markup).toMatch(/<h2 id="shadow-mode-title"[^>]*>Shadow mode<\/h2>/);
  });

  it("says what it does, and offers to turn it on in the business's currency", () => {
    const markup = panel(null);
    const words = text(markup);
    expect(words).toContain("Off: the agent pays on its own, within its limits.");
    expect(words).toContain(
      "Keep paying your bills as you do today. The agent decides on the same bills, and you agree or disagree with each decision. Each payment you agree to is made in USDC on Arc testnet, at the bill's amount in USDC."
    );
    expect(words).toContain("Your currency");
    expect(words).toContain("USDC, or the currency your bills are written in. A bill in another currency is paid in USDC at the day's rate.");
    // USDC is chosen until the owner picks another.
    expect(markup).toContain('name="currency" value="USDC"');
    expect(words).toContain("Turn on shadow mode");
  });

  it("says since when it is on and in which currency, and offers to turn it off", () => {
    const words = text(panel(ON));
    expect(words).toContain("On since Oct 7, 2026, 12:00 UTC, for bills in VND: the agent pays nothing until a person agrees.");
    expect(words).toContain("Turn off shadow mode");
    expect(words).not.toContain("Turn on shadow mode");
  });

  it("asks before turning it off, and says what stays held", () => {
    const source = readFileSync(path.join(process.cwd(), "src/components/ShadowModePanel.tsx"), "utf8");
    expect(source).toContain('title="Turn off shadow mode?"');
    expect(source).toContain(
      "The agent will pay on its own again, within its limits. A payment waiting for a person to agree stays held until a person decides it."
    );
  });

  it("shows the state to someone who cannot change it, with no button", () => {
    const words = text(panel(ON, { canChange: false }));
    expect(words).toContain("On since Oct 7, 2026, 12:00 UTC");
    expect(words).toContain("An owner of this workspace can turn it on or off.");
    expect(words).not.toContain("Turn off shadow mode");
  });

  it("is not offered on Arc mainnet, where the agent pays the real bills", () => {
    const words = text(panel(null, { network: "arc-mainnet" }));
    expect(words).toContain("Shadow mode runs on Arc testnet. On Arc mainnet the agent pays your real bills.");
    expect(words).not.toContain("Turn on shadow mode");
  });
});
