import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** The create form offers Arc mainnet only when the page says so (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M2). */

vi.mock("@/app/onboarding/actions", () => ({ createWorkspaceAction: vi.fn() }));

import CreateWorkspaceForm from "@/components/CreateWorkspaceForm";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("CreateWorkspaceForm", () => {
  it("offers a choice of network, Arc testnet first and chosen, when Arc mainnet is open to this person", () => {
    const markup = renderToStaticMarkup(<CreateWorkspaceForm mainnetOffered />);
    expect(text(markup)).toContain("Network");
    const choices = (markup.match(/<button[^>]*role="radio"[^>]*>/g) ?? []).map((tag) => ({ value: /value="([^"]+)"/.exec(tag)?.[1], checked: tag.includes('aria-checked="true"') }));
    expect(choices).toEqual([
      { value: "arc-testnet", checked: true },
      { value: "arc-mainnet", checked: false },
    ]);
    // What each is for first, then its network; the test one recommended, the production one marked as real funds
    // (workspaces page W4), without asking for the setup going live needs.
    expect(text(markup)).toMatch(/Test workspace Recommended Arc testnet\. It starts as a sandbox: the money in it is simulated\. Try everything before going live\./);
    expect(text(markup)).toMatch(/Production workspace Real funds Arc mainnet\. Real USDC: nothing moves until an owner finishes setup and takes it live\./);
    expect(text(markup)).not.toContain("Circle account");
    expect(text(markup)).toContain("Creating a workspace moves no money.");
  });

  it("offers no network otherwise, as before", () => {
    const markup = renderToStaticMarkup(<CreateWorkspaceForm />);
    expect(markup).not.toContain('role="radio"');
    expect(text(markup)).not.toContain("Network");
    expect(text(markup)).toContain("It starts as a sandbox: the money in it is simulated.");
    expect(text(markup)).toContain("Creating a workspace moves no money.");
  });
});
