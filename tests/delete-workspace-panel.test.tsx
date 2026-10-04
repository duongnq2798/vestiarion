import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DeleteWorkspacePanel, { DeleteWorkspaceConsequences, DeleteWorkspaceForm, dismissGuards, PAUSE_REASON } from "@/components/DeleteWorkspacePanel";
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
vi.mock("@/app/actions/agent", () => ({ pauseAgentAction: vi.fn() }));

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

  it("pauses the agent from the note itself, giving why (Settings structure design S6)", () => {
    const markup = panel({ live: true, paused: false });
    expect(text(markup)).toContain("Pause the agent");
    expect(markup).toContain(`name="reason" value="${PAUSE_REASON}"`);
    expect(panel({ live: true, paused: true })).not.toContain('name="reason"');
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
  // The action's state is the dialog's, so the form is given it: here, as the dialog would pass it.
  const form = (overrides: Partial<DeletionContext> = {}, pending = false, message = "") =>
    html(
      <Dialog>
        <DeleteWorkspaceForm orgSlug="northstar" context={context(overrides)} pending={pending} message={message} formProps={{}} />
      </Dialog>
    );

  it("labels the confirmation input, and names it confirmSlug", () => {
    const markup = form();
    const id = /<input[^>]*name="confirmSlug"[^>]*id="([^"]+)"|<input[^>]*id="([^"]+)"[^>]*name="confirmSlug"/.exec(markup);
    expect(id).not.toBeNull();
    const inputId = id?.[1] ?? id?.[2];
    expect(markup).toContain(`for="${inputId}"`);
    // The label shows the slug to type.
    const label = (markup.split(`<label for="${inputId}"`)[1] ?? "").split("</label>")[0].replace(/^[^>]*>/, "");
    expect(text(label)).toBe("Type northstar to confirm");
    expect(markup).toMatch(/<input[^>]*autoComplete="off"/);
  });

  it("carries the workspace's slug for authorize", () => {
    expect(form()).toMatch(/<input type="hidden" name="orgSlug" value="northstar"\/>/);
  });

  it("starts with the delete button disabled, until the slug is typed", () => {
    const markup = form();
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>[\s\S]*?Delete this workspace/);
  });

  it("shows the slug with break-all in the label and in the dialog's text, so a long one wraps at 360 px", () => {
    const long = "a-very-long-workspace-slug-that-wraps-x";
    const spans = (markup: string) => [...markup.matchAll(/<(?:span|code)[^>]*class="([^"]*font-mono[^"]*)"[^>]*>a-very-long/g)].map((match) => match[1]);
    const inForm = spans(form({ slug: long }));
    const inText = spans(html(<DeleteWorkspaceConsequences slug={long} walletCount={0} hosted={false} />));
    expect(inForm).toHaveLength(1);
    expect(inText).toHaveLength(1);
    for (const classes of [...inForm, ...inText]) expect(classes.split(/\s+/)).toContain("break-all");
  });

  it("while pending, disables Cancel and marks the delete button busy", () => {
    const markup = form({}, true);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*aria-busy="true"/);
  });

  it("keeps Cancel enabled when not pending", () => {
    expect(form()).toMatch(/<button type="button"(?![^>]*disabled="")[^>]*>Cancel<\/button>/);
  });

  it("shows the action's refusal", () => {
    expect(text(form({}, false, "A payment is being made; try again in a few minutes."))).toContain("A payment is being made; try again in a few minutes.");
  });

  it("shows the pause note inside the dialog too, when the workspace is live and running", () => {
    expect(text(form({ live: true }))).toContain(PAUSE);
    expect(text(form({ live: true, paused: true }))).not.toContain(PAUSE);
  });

  it("keeps the note's pause form beside the delete form, never inside it", () => {
    const markup = form({ live: true });
    expect(markup.match(/<form/g)).toHaveLength(2);
    // The pause form closes before the delete form opens: no form holds another.
    expect(markup.indexOf("</form>")).toBeLessThan(markup.lastIndexOf("<form"));
  });
});

describe("dismissGuards", () => {
  const event = () => ({ preventDefault: vi.fn() });

  it("never lets a click outside close the dialog, pending or not", () => {
    for (const pending of [false, true]) {
      const outside = event();
      dismissGuards(pending).onInteractOutside(outside);
      expect(outside.preventDefault).toHaveBeenCalled();
    }
  });

  it("lets Escape close the dialog only while nothing is pending", () => {
    const idle = event();
    dismissGuards(false).onEscapeKeyDown(idle);
    expect(idle.preventDefault).not.toHaveBeenCalled();

    const busy = event();
    dismissGuards(true).onEscapeKeyDown(busy);
    expect(busy.preventDefault).toHaveBeenCalled();
  });
});
