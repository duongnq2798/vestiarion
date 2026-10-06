import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeleteAccountBody } from "@/components/DeleteAccountDialog";
import { Dialog } from "@/components/ui/Dialog";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { AccountDeletionPlan } from "@/lib/platform/delete-account";

/**
 * The "Delete account" dialog (spec §6, A1–A3) as the markup it renders on
 * the server. The dialog itself opens in a portal, and the account menu's
 * items only render once the menu is open, so the dialog's body is rendered
 * on its own, and the menu is checked in its source.
 */

vi.mock("@/app/account/actions", () => ({ deleteAccountAction: vi.fn(), accountDeletionPlanAction: vi.fn() }));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/app/actions/workspace", () => ({ deleteWorkspaceAction: vi.fn() }));
vi.mock("@/app/actions/agent", () => ({ pauseAgentAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const EMPTY: AccountDeletionPlan = { blocked: [], soleWorkspaces: [] };

const body = (plan: AccountDeletionPlan, pending = false, message = "") =>
  html(
    <Dialog>
      <DeleteAccountBody plan={plan} pending={pending} message={message} formProps={{}} />
    </Dialog>
  );

const submit = (markup: string) => /<button[^>]*type="submit"[^>]*>/.exec(markup)?.[0] ?? "";

describe("DeleteAccountBody", () => {
  it("lists each blocked workspace with its reason and a link to where it is resolved, and cannot be confirmed", () => {
    const markup = body({
      blocked: [
        { slug: "team-co", name: "Team Co", reason: "has_other_members" },
        { slug: "founding", name: "Vestiarion workspace", reason: "founding" },
      ],
      soleWorkspaces: [],
    });
    const words = text(markup);
    expect(words).toContain("Team Co");
    expect(words).toContain("You are its last owner, and it has other members. Make someone else an owner, or delete the workspace, first.");
    expect(words).toContain("Vestiarion workspace");
    expect(words).toContain("You are the last owner of the founding workspace, which cannot be deleted. Make someone else an owner first.");
    // Someone else is made an owner on the Members page; the founding workspace's Settings say why it stays.
    expect(markup).toContain('href="/o/team-co/members"');
    expect(markup).not.toContain('href="/o/team-co/settings"');
    expect(markup).toContain('href="/o/founding/settings"');
    expect(words).toContain("Open its Members page");
    expect(words).toContain("Open its Settings");
    // Nothing to type and nothing to press.
    expect(markup).not.toContain('name="confirmText"');
    expect(markup).not.toMatch(/type="submit"/);
  });

  it("lists the sole workspaces deleted with the account, with their wallet sentence and pause note", () => {
    const markup = body({
      blocked: [],
      soleWorkspaces: [
        { slug: "solo-co", name: "Solo Co", live: false, paused: false, walletCount: 2, hosted: false },
        { slug: "hosted-co", name: "Hosted Co", live: true, paused: false, walletCount: 1, hosted: true },
      ],
    });
    const words = text(markup);
    expect(words).toContain("Deleted with your account");
    expect(words).toContain("Solo Co");
    expect(words).toContain("Hosted Co");
    expect(words).toContain("Its wallets stay in the Circle account that holds them, with any USDC in them; Vestiarion can no longer reach them.");
    expect(words).toContain("Vestiarion's testnet account");
    expect(words).toContain("Pause the agent first, so no cycle runs while the workspace is deleted.");
    expect(markup).toContain('href="/o/hosted-co/console"');
    // The note sits inside this dialog's form, so it points to the console and holds no pause form of its own.
    expect(markup.match(/<form/g)).toHaveLength(1);
    expect(words).not.toContain("Pause it here");
    // A live workspace whose agent runs keeps the button disabled, whatever is typed.
    expect(submit(markup)).toContain('disabled=""');
  });

  it("says what remains, for everyone", () => {
    for (const plan of [EMPTY, { blocked: [], soleWorkspaces: [{ slug: "s", name: "S", live: false, paused: false, walletCount: 0, hosted: false }] }]) {
      const words = text(body(plan));
      expect(words).toContain("Records you added in workspaces you share stay, without your name attached.");
      expect(words).toContain("Your memberships and the invitations you sent are removed. API keys you created stop working.");
      expect(words).toContain("A workspace's signed ledger is append-only, so entries you caused keep your account's id (never your email).");
    }
  });

  it("says no workspace is deleted when there is none to delete", () => {
    expect(text(body(EMPTY))).toContain("No workspace is deleted with your account.");
  });

  it("asks for the confirmation phrase, with the delete button disabled until it is typed", () => {
    const markup = body(EMPTY);
    const input = /<input[^>]*name="confirmText"[^>]*>/.exec(markup)?.[0] ?? "";
    const inputId = /id="([^"]+)"/.exec(input)?.[1];
    expect(inputId).toBeTruthy();
    const label = (markup.split(`<label for="${inputId}"`)[1] ?? "").split("</label>")[0].replace(/^[^>]*>/, "");
    expect(text(label)).toBe("Type delete my account to confirm");
    expect(input).toContain('autoComplete="off"');
    expect(submit(markup)).toContain('disabled=""');
    expect(text(markup)).toContain("Delete my account");
  });

  it("while pending, disables Cancel and marks the delete button busy", () => {
    const markup = body(EMPTY, true);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    expect(submit(markup)).toContain('aria-busy="true"');
  });

  it("shows the action's refusal", () => {
    const message = "solo-co: A payment is being made; try again in a few minutes. Your account was not deleted.";
    expect(text(body(EMPTY, false, message))).toContain(message);
  });
});

describe("where Delete account lives (A1)", () => {
  it("is the account menu's last item, below Sign out, for every signed-in person", () => {
    const file = source("src/components/vx/AccountMenu.tsx");
    const menu = file.slice(file.indexOf("<DropdownMenuContent"));
    expect(menu).toContain("<DeleteAccountDialog");
    expect(menu.lastIndexOf("<DropdownMenuItem")).toBeLessThan(menu.indexOf("Delete account"));
    expect(menu.indexOf("Sign out")).toBeGreaterThan(-1);
    expect(menu.indexOf("Delete account")).toBeGreaterThan(menu.indexOf("Sign out"));
    // Unconditional: no role, flag or prop decides whether it is offered.
    const item = menu.slice(0, menu.indexOf("Delete account"));
    expect(item.slice(item.lastIndexOf("<DropdownMenuItem"))).not.toMatch(/&&|\?\s*</);
    // The only danger row: Sign out is an ordinary way out, not a red one.
    expect(menu.match(/tone="danger"/g)).toHaveLength(1);
  });

  it("is reached from the workspace sidebar and from the /onboarding header", () => {
    expect(source("src/components/vx/AppNav.tsx")).toContain('<AccountMenu email={email} placement="sidebar">');
    const onboarding = source("src/app/onboarding/page.tsx");
    expect(onboarding).toContain('<AccountMenu email={user.email} placement="header" />');
    expect(onboarding).not.toContain("Delete account");
  });

  it("the dialog is an alertdialog guarded against dismissal while pending", () => {
    const dialog = source("src/components/DeleteAccountDialog.tsx");
    expect(dialog).toContain('role="alertdialog"');
    expect(dialog).toContain("{...dismissGuards(pending)}");
  });
});
