import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DeleteWorkspacePanel, { DeleteWorkspaceConsequences, DeleteWorkspaceForm } from "@/components/DeleteWorkspacePanel";
import { Dialog } from "@/components/ui/Dialog";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { DeletionContext } from "@/lib/platform/delete-workspace";

/**
 * The "Delete workspace" danger zone at the bottom of Settings (spec §1, W1,
 * W2), as the markup it renders on the server (the `go-live-panel.test.tsx`
 * shape). The dialog itself opens in a portal, which a static render leaves
 * closed, so its text and its form are rendered here on their own.
 */

vi.mock("@/app/actions/workspace", () => ({ deleteWorkspaceAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();

function context(overrides: Partial<DeletionContext> = {}): DeletionContext {
  return { slug: "northstar", isFounding: false, live: false, paused: false, walletCount: 0, hosted: false, ...overrides };
}

const panel = (overrides: Partial<DeletionContext> = {}, canAdminister = true) =>
  html(<DeleteWorkspacePanel orgSlug="northstar" context={context(overrides)} canAdminister={canAdminister} />);

const WALLETS = "Its wallets stay in the Circle account that holds them, with any USDC in them; Vestiarion can no longer reach them.";
const PAUSE = "Pause the agent first, so no cycle runs while the workspace is deleted.";

describe("DeleteWorkspacePanel", () => {
  it("is a section titled Delete workspace, with a destructive button, for an owner", () => {
    const markup = panel();
    expect(markup).toMatch(/<section[^>]*aria-labelledby="delete-workspace-title"/);
    expect(markup).toMatch(/<h2 id="delete-workspace-title"[^>]*>Delete workspace<\/h2>/);
    expect(markup).toMatch(/<button[^>]*class="[^"]*text-refused[^"]*"[^>]*>[\s\S]*?Delete workspace/);
  });

  it("renders nothing for anyone but an owner", () => {
    expect(panel({}, false)).toBe("");
  });

  it("renders nothing for the founding workspace, even for its owner", () => {
    expect(panel({ isFounding: true, slug: "founding", live: true, paused: true })).toBe("");
  });

  it("asks a live workspace whose agent is running to pause it first", () => {
    expect(text(panel({ live: true, paused: false }))).toContain(PAUSE);
  });

  it("says nothing about pausing for a paused live workspace, or a sandbox", () => {
    expect(text(panel({ live: true, paused: true }))).not.toContain(PAUSE);
    expect(text(panel({ live: false, paused: false }))).not.toContain(PAUSE);
  });

  it("uses no colour literals", () => {
    const markup = panel({ live: true, walletCount: 2 });
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/);
  });
});

describe("DeleteWorkspaceConsequences", () => {
  it("lists everything the workspace loses", () => {
    const words = text(html(<DeleteWorkspaceConsequences slug="northstar" walletCount={0} hosted={false} />));
    for (const item of ["invoices", "counterparties", "milestones", "treasury records", "the ledger", "API keys", "webhooks", "members and invitations"]) {
      expect(words).toContain(item);
    }
    expect(words).toContain("cannot be undone");
  });

  it("says where the wallets stay when the workspace has any", () => {
    const words = text(html(<DeleteWorkspaceConsequences slug="northstar" walletCount={2} hosted={false} />));
    expect(words).toContain(WALLETS);
  });

  it("leaves the wallet sentence out when there are none", () => {
    const words = text(html(<DeleteWorkspaceConsequences slug="northstar" walletCount={0} hosted={false} />));
    expect(words).not.toContain("wallets stay");
  });

  it("names Vestiarion's testnet account for a hosted workspace", () => {
    const words = text(html(<DeleteWorkspaceConsequences slug="northstar" walletCount={1} hosted />));
    expect(words).toContain("Vestiarion's testnet account");
    expect(words).toContain("with any USDC in them");
    expect(words).not.toContain(WALLETS);
  });
});

describe("DeleteWorkspaceForm", () => {
  // The form sits inside the dialog, whose Cancel needs the dialog around it.
  const form = (overrides: Partial<DeletionContext> = {}) =>
    html(<Dialog><DeleteWorkspaceForm orgSlug="northstar" context={context(overrides)} /></Dialog>);

  it("labels the confirmation input, and names it confirmSlug", () => {
    const markup = form();
    const id = /<input[^>]*name="confirmSlug"[^>]*id="([^"]+)"|<input[^>]*id="([^"]+)"[^>]*name="confirmSlug"/.exec(markup);
    expect(id).not.toBeNull();
    const inputId = id?.[1] ?? id?.[2];
    expect(markup).toContain(`for="${inputId}"`);
    expect(text(markup)).toContain("Type the workspace's name (slug) to confirm");
    expect(markup).toMatch(/<input[^>]*autoComplete="off"/);
  });

  it("carries the workspace's slug for authorize", () => {
    expect(form()).toMatch(/<input type="hidden" name="orgSlug" value="northstar"\/>/);
  });

  it("starts with the delete button disabled, until the slug is typed", () => {
    const markup = form();
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>[\s\S]*?Delete this workspace/);
  });

  it("shows the pause note inside the dialog too, when the workspace is live and running", () => {
    expect(text(form({ live: true }))).toContain(PAUSE);
    expect(text(form({ live: true, paused: true }))).not.toContain(PAUSE);
  });
});
